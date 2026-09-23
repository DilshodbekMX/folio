/**
 * MetaService: one server-authoritative Y.Doc per project (`/ws/project/:projectId`) holding
 *   META_FILES_KEY   Y.Map fileId → FileEntry
 *   META_PROJECT_KEY Y.Map 'name' | 'settings' | 'updatedAt'
 * built from the db and kept current by syncFiles/syncProject as minimal diffs (the doc is never
 * recreated, so connected clients converge). Client document updates are dropped; awareness
 * carries MetaPresence; ProjectEvents are pushed as MSG_EVENT frames.
 *
 * The doc is persisted to `ystate/<pid>/_project-meta.ybin` synchronously before each change is
 * broadcast, so after a restart the rebuilt doc is a descendant of every client's copy (a client
 * merging state from a discarded server doc would resurrect deleted entries). A client whose
 * state is nevertheless ahead of the server's is closed with STALE_EPOCH to start over.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import * as decoding from 'lib0/decoding'
import { WebSocketServer, type WebSocket } from 'ws'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import type { FileEntry, Role, UserPublic } from '@folio/shared/api'
import {
  KEEPALIVE_MS, MAX_WS_PAYLOAD, META_FILES_KEY, META_PROJECT_KEY, WS_CLOSE, type ProjectEvent,
} from '@folio/shared/protocol'
import type { MetaService, Services } from '../services.ts'
import { defaultLogger, errInfo, type CollabLogger } from './log.ts'
import { BaseRoom, Conn } from './room.ts'
import { META_SIDECAR_NAME, isSafeId, projectStateDir, writeFileAtomicSync } from './storage.ts'
import { ProtocolError, encodeEventMessage, encodeSyncStep1, encodeSyncStep2, encodeSyncUpdate } from './wire.ts'

export interface MetaOptions {
  keepaliveMs: number
  pingMs: number
  /** unload a project's meta room this long after its last connection left */
  unloadMs: number
  logger: CollabLogger
}

export const DEFAULT_META_OPTIONS: Omit<MetaOptions, 'logger'> = {
  keepaliveMs: KEEPALIVE_MS,
  pingMs: 30_000,
  unloadMs: 30_000,
}

export interface MetaUpgradeContext {
  user: UserPublic | null
  role: Role | null
  projectId: string
  sessionTokenHash?: string | null
}

/** MetaService plus introspection used by tests and diagnostics. */
export interface MetaServiceImpl extends MetaService {
  stats(): { rooms: { projectId: string; connections: number }[] }
}

const SERVER_ORIGIN = 'server'
const MAX_OPEN_FILE_ID = 64

function toEntry(f: FileEntry): FileEntry {
  return { id: f.id, path: f.path, kind: f.kind, size: f.size, epoch: f.epoch, updatedAt: f.updatedAt }
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

class MetaRoom extends BaseRoom {
  readonly files: Y.Map<FileEntry>
  readonly project: Y.Map<unknown>
  unloadTimer: NodeJS.Timeout | null = null

  constructor(private readonly svc: { s: Services; log: CollabLogger; onEmpty(room: MetaRoom): void }, readonly projectId: string) {
    super(svc.log, `meta:${projectId}`)
    this.files = this.doc.getMap<FileEntry>(META_FILES_KEY)
    this.project = this.doc.getMap<unknown>(META_PROJECT_KEY)
    this.loadPersisted()
    this.syncFiles()
    this.syncProject()
    this.persist()
    this.doc.on('update', (update: Uint8Array) => {
      if (this.destroyed) return
      this.persist()
      this.broadcast(encodeSyncUpdate(update))
    })
  }

  private get sidecarFile(): string {
    return path.join(projectStateDir(this.svc.s.config.dirs.ystate, this.projectId), META_SIDECAR_NAME)
  }

  private loadPersisted(): void {
    let bytes: Buffer
    try {
      bytes = fs.readFileSync(this.sidecarFile)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn({ room: this.label, ...errInfo(err) }, 'could not read meta state')
      return
    }
    try {
      Y.applyUpdate(this.doc, bytes, SERVER_ORIGIN)
    } catch (err) {
      // unreadable: start a new doc (clients holding the old one are told to start over)
      this.log.error({ room: this.label, ...errInfo(err) }, 'corrupt meta state; rebuilding from the db')
      try { fs.rmSync(this.sidecarFile, { force: true }) } catch { /* ignore */ }
    }
  }

  persist(): void {
    if (this.destroyed) return
    try {
      writeFileAtomicSync(this.sidecarFile, Y.encodeStateAsUpdate(this.doc))
    } catch (err) {
      this.log.error({ room: this.label, ...errInfo(err) }, 'could not persist meta state')
    }
  }

  /** Diff the files map against the db (entries added/changed/removed; unchanged ones untouched). */
  syncFiles(): void {
    const rows = this.svc.s.db.files.list(this.projectId).map(toEntry)
    this.doc.transact(() => {
      const ids = new Set(rows.map(r => r.id))
      for (const id of [...this.files.keys()]) if (!ids.has(id)) this.files.delete(id)
      for (const row of rows) {
        const cur = this.files.get(row.id)
        if (!cur || !sameJson(toEntry(cur), row)) this.files.set(row.id, row)
      }
    }, SERVER_ORIGIN)
  }

  syncProject(): void {
    const p = this.svc.s.db.projects.get(this.projectId)
    if (!p) return
    this.doc.transact(() => {
      if (this.project.get('name') !== p.name) this.project.set('name', p.name)
      if (!sameJson(this.project.get('settings'), p.settings)) this.project.set('settings', { ...p.settings })
      if (this.project.get('updatedAt') !== p.updatedAt) this.project.set('updatedAt', p.updatedAt)
    }, SERVER_ORIGIN)
  }

  protected isReady(): boolean {
    return true
  }

  protected initialMessages(): Uint8Array[] {
    return [encodeSyncStep1(this.doc)]
  }

  protected onEmpty(): void {
    this.svc.onEmpty(this)
  }

  protected sanitizeState(conn: Conn, state: Record<string, unknown>): Record<string, unknown> | null {
    const open = state.openFileId
    return {
      user: conn.presence,
      openFileId: typeof open === 'string' && open.length > 0 && open.length <= MAX_OPEN_FILE_ID ? open : null,
    }
  }

  protected onSyncMessage(conn: Conn, dec: decoding.Decoder): void {
    const sub = decoding.readVarUint(dec)
    switch (sub) {
      case syncProtocol.messageYjsSyncStep1: {
        const sv = decoding.readVarUint8Array(dec)
        if (this.isAheadOfServer(sv)) {
          this.log.warn({ room: this.label, user: conn.user.id }, 'client meta state is ahead of the server; forcing a fresh copy')
          this.closeConn(conn, WS_CLOSE.STALE_EPOCH, 'stale project state')
          return
        }
        this.send(conn, encodeSyncStep2(this.doc, sv))
        return
      }
      case syncProtocol.messageYjsSyncStep2:
      case syncProtocol.messageYjsUpdate:
        decoding.readVarUint8Array(dec)
        return // server-authoritative: client content is never applied
      default:
        throw new ProtocolError(`unknown sync message type ${sub}`)
    }
  }

  /** true when the client has items the server does not (it synced with a lost server doc). */
  private isAheadOfServer(sv: Uint8Array): boolean {
    let client: Map<number, number>
    try {
      client = Y.decodeStateVector(sv)
    } catch {
      throw new ProtocolError('invalid state vector')
    }
    if (client.size === 0) return false
    const server = Y.decodeStateVector(Y.encodeStateVector(this.doc))
    for (const [id, clock] of client) if (clock > (server.get(id) ?? 0)) return true
    return false
  }

  event(json: string): void {
    this.broadcast(encodeEventMessage(json))
  }
}

export function createMetaService(s: Services, options: Partial<MetaOptions> = {}): MetaServiceImpl {
  const opts: MetaOptions = { ...DEFAULT_META_OPTIONS, logger: options.logger ?? defaultLogger('meta', s.config.env), ...options }
  const log = opts.logger
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD, clientTracking: false, perMessageDeflate: false })
  const rooms = new Map<string, MetaRoom>()
  let shuttingDown = false

  const keepaliveTimer = opts.keepaliveMs > 0
    ? setInterval(() => { for (const room of rooms.values()) room.keepalive() }, opts.keepaliveMs)
    : null
  keepaliveTimer?.unref()
  const pingTimer = opts.pingMs > 0
    ? setInterval(() => { for (const room of rooms.values()) room.heartbeat() }, opts.pingMs)
    : null
  pingTimer?.unref()

  const roomHost = {
    s,
    log,
    onEmpty(room: MetaRoom) {
      if (shuttingDown) return
      cancelUnload(room)
      room.unloadTimer = setTimeout(() => {
        room.unloadTimer = null
        if (room.conns.size > 0 || rooms.get(room.projectId) !== room) return
        rooms.delete(room.projectId)
        room.persist()
        room.destroy()
      }, opts.unloadMs)
      room.unloadTimer.unref()
    },
  }

  function cancelUnload(room: MetaRoom): void {
    if (room.unloadTimer) {
      clearTimeout(room.unloadTimer)
      room.unloadTimer = null
    }
  }

  function acquire(projectId: string): MetaRoom {
    let room = rooms.get(projectId)
    if (!room) {
      room = new MetaRoom(roomHost, projectId)
      rooms.set(projectId, room)
    }
    cancelUnload(room)
    return room
  }

  function drop(room: MetaRoom, code: number, reason: string): void {
    cancelUnload(room)
    if (rooms.get(room.projectId) === room) rooms.delete(room.projectId)
    room.closeAll(code, reason)
    room.destroy()
  }

  function onConnection(ws: WebSocket, ctx: MetaUpgradeContext): void {
    const reject = (code: number, reason: string) => ws.close(code, reason)
    if (shuttingDown) return reject(WS_CLOSE.SERVICE_RESTART, 'server restarting')
    if (!ctx.user) return reject(WS_CLOSE.UNAUTHORIZED, 'not logged in')
    if (!isSafeId(ctx.projectId) || !s.db.projects.get(ctx.projectId)) return reject(WS_CLOSE.NOT_FOUND, 'unknown project')
    if (!ctx.role) return reject(WS_CLOSE.FORBIDDEN, 'no access to this project')
    const room = acquire(ctx.projectId)
    room.addConn(new Conn(ws, ctx.user, ctx.role, true, ctx.sessionTokenHash ?? null))
  }

  return {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: MetaUpgradeContext): void {
      if (shuttingDown) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, ws => {
        try {
          onConnection(ws, ctx)
        } catch (err) {
          log.error({ projectId: ctx.projectId, ...errInfo(err) }, 'meta connection setup failed')
          ws.close(WS_CLOSE.INTERNAL, 'internal error')
        }
      })
    },

    broadcast(projectId: string, event: ProjectEvent): void {
      const room = rooms.get(projectId)
      if (!room || room.conns.size === 0) return
      room.event(JSON.stringify(event))
    },

    syncFiles(projectId: string): void {
      const room = rooms.get(projectId)
      if (!room) return // rebuilt from the db on the next connection
      try {
        room.syncFiles()
      } catch (err) {
        log.error({ projectId, ...errInfo(err) }, 'meta syncFiles failed')
      }
    },

    syncProject(projectId: string): void {
      const room = rooms.get(projectId)
      if (!room) return
      try {
        room.syncProject()
      } catch (err) {
        log.error({ projectId, ...errInfo(err) }, 'meta syncProject failed')
      }
    },

    disconnectUser(projectId: string, userId: string, code: number): void {
      const room = rooms.get(projectId)
      if (!room) return
      for (const conn of [...room.conns]) if (conn.user.id === userId) room.closeConn(conn, code, 'access changed')
    },

    disconnectSessions(tokenHashes: readonly string[], code: number): number {
      if (tokenHashes.length === 0) return 0
      const wanted = new Set(tokenHashes)
      let n = 0
      for (const room of [...rooms.values()]) {
        for (const conn of [...room.conns]) {
          if (conn.session !== null && wanted.has(conn.session)) {
            room.closeConn(conn, code, code === WS_CLOSE.UNAUTHORIZED ? 'session ended' : 'disconnected')
            n++
          }
        }
      }
      return n
    },

    openSessions(): string[] {
      const out = new Set<string>()
      for (const room of rooms.values()) for (const conn of room.conns) if (conn.session) out.add(conn.session)
      return [...out]
    },

    closeProject(projectId: string, code: number): void {
      const room = rooms.get(projectId)
      if (room) drop(room, code, code === WS_CLOSE.GONE ? 'project deleted' : 'project closed')
      if (code === WS_CLOSE.GONE && isSafeId(projectId)) {
        const dir = projectStateDir(s.config.dirs.ystate, projectId)
        try {
          fs.rmSync(path.join(dir, META_SIDECAR_NAME), { force: true })
          fs.rmdirSync(dir) // only succeeds when nothing else is left in it
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code !== 'ENOENT' && code !== 'ENOTEMPTY') log.warn({ projectId, ...errInfo(err) }, 'could not delete meta state')
        }
      }
    },

    async shutdown(): Promise<void> {
      if (shuttingDown) return
      shuttingDown = true
      if (keepaliveTimer) clearInterval(keepaliveTimer)
      if (pingTimer) clearInterval(pingTimer)
      for (const room of [...rooms.values()]) {
        room.persist()
        drop(room, WS_CLOSE.SERVICE_RESTART, 'server restarting')
      }
      await new Promise<void>(resolve => wss.close(() => resolve()))
    },

    stats() {
      return { rooms: [...rooms.values()].map(r => ({ projectId: r.projectId, connections: r.conns.size })) }
    },
  }
}
