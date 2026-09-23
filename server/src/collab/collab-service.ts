/**
 * CollabService: y-websocket 3.1.0 compatible doc rooms (`/ws/doc/:projectId/:fileId?epoch=N`)
 * with sidecar persistence, debounced atomic saves, read-only viewers, barrier, keepalive and
 * ping/terminate. See doc-room.ts for load/save and room.ts for the message plumbing.
 */
import fsp from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import type { Role, UserPublic } from '@folio/shared/api'
import { normalizeText } from '@folio/shared/filetypes'
import { KEEPALIVE_MS, MAX_DOC_LENGTH, MAX_WS_PAYLOAD, WS_CLOSE } from '@folio/shared/protocol'
import { HttpError, badRequest, conflict, notFound, tooLarge } from '../http/errors.ts'
import type { CollabService, Services } from '../services.ts'
import { DocRoom, RoomLoadError, SERVER_ORIGIN, type DocRoomHost } from './doc-room.ts'
import { defaultLogger, errInfo, type CollabLogger } from './log.ts'
import { Conn } from './room.ts'
import { isSafeId, listSidecars, projectStateDir, readIfExists } from './storage.ts'
import { applyTextDiff } from './text-diff.ts'

export interface CollabOptions {
  /** empty-awareness keepalive interval (y-websocket drops connections after 30 s of silence) */
  keepaliveMs: number
  /** ws ping interval; sockets that miss one pong are terminated */
  pingMs: number
  saveDebounceMs: number
  saveMaxWaitMs: number
  saveRetryMs: number
  /** unload a room this long after its last connection left */
  unloadMs: number
  /** onDocChanged / 'doc:changed' at most once per this interval per file */
  docChangedMs: number
  /**
   * history.noteActivity at most once per this interval per file and user. Trailing edge: an
   * edit inside the interval schedules one more report at its end, so no edit goes unreported.
   */
  activityThrottleMs: number
  /** how often open rooms re-check their file's db record (moves/deletes done behind their back) */
  pathCheckMs: number
  logger: CollabLogger
}

export const DEFAULT_COLLAB_OPTIONS: Omit<CollabOptions, 'logger'> = {
  keepaliveMs: KEEPALIVE_MS,
  pingMs: 30_000,
  saveDebounceMs: 2_000,
  saveMaxWaitMs: 10_000,
  saveRetryMs: 5_000,
  unloadMs: 30_000,
  docChangedMs: 1_000,
  activityThrottleMs: 1_000,
  pathCheckMs: 10_000,
}

export interface DocUpgradeContext {
  user: UserPublic | null
  role: Role | null
  projectId: string
  fileId: string
  epoch: number
  sessionTokenHash?: string | null
}

export interface CollabRoomInfo {
  projectId: string
  fileId: string
  epoch: number
  state: 'loading' | 'ready' | 'failed'
  connections: number
  unsaved: boolean
}

/** CollabService plus introspection used by tests and diagnostics. */
export interface CollabServiceImpl extends CollabService {
  stats(): { rooms: CollabRoomInfo[] }
}

type DocChangedListener = (e: { projectId: string; fileId: string; userId: string | null }) => void

const CLOSE_REASONS: Record<number, string> = {
  [WS_CLOSE.UNAUTHORIZED]: 'session ended',
  [WS_CLOSE.GONE]: 'file deleted',
  [WS_CLOSE.STALE_EPOCH]: 'document replaced',
  [WS_CLOSE.FORBIDDEN]: 'access changed',
  [WS_CLOSE.SERVICE_RESTART]: 'server restarting',
}

function loadErrorToHttp(err: unknown): HttpError {
  if (err instanceof RoomLoadError) {
    if (err.code === WS_CLOSE.NOT_FOUND || err.code === WS_CLOSE.GONE) return notFound(err.message)
    if (err.code === WS_CLOSE.TOO_LARGE) return tooLarge(err.message)
    if (err.code === WS_CLOSE.STALE_EPOCH) return conflict(err.message)
  }
  return new HttpError(500, 'internal', 'Could not open the document')
}

export function createCollabService(s: Services, options: Partial<CollabOptions> = {}): CollabServiceImpl {
  const opts: CollabOptions = { ...DEFAULT_COLLAB_OPTIONS, logger: options.logger ?? defaultLogger('collab', s.config.env), ...options }
  const log = opts.logger
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD, clientTracking: false, perMessageDeflate: false })
  const rooms = new Map<string, DocRoom>()
  const editors = new Map<string, Set<string>>()
  /** per project: document changes applied in this process (see editCount) */
  const editCounts = new Map<string, number>()
  const listeners = new Set<DocChangedListener>()
  let shuttingDown = false

  const keepaliveTimer = opts.keepaliveMs > 0
    ? setInterval(() => { for (const room of rooms.values()) room.keepalive() }, opts.keepaliveMs)
    : null
  keepaliveTimer?.unref()
  const pingTimer = opts.pingMs > 0
    ? setInterval(() => { for (const room of rooms.values()) room.heartbeat() }, opts.pingMs)
    : null
  pingTimer?.unref()
  const pathTimer = opts.pathCheckMs > 0
    ? setInterval(() => { for (const room of [...rooms.values()]) room.verifyPath() }, opts.pathCheckMs)
    : null
  pathTimer?.unref()

  const roomKey = (projectId: string, fileId: string) => `${projectId}/${fileId}`

  // -------------------------------------------------------------------------
  // Edit notifications
  // -------------------------------------------------------------------------

  function emitDocChanged(room: DocRoom): void {
    room.docChangedTimer = null
    const e = { projectId: room.projectId, fileId: room.fileId, userId: room.docChangedUser }
    room.docChangedUser = null
    for (const fn of listeners) {
      try {
        fn(e)
      } catch (err) {
        log.error({ ...errInfo(err) }, 'onDocChanged listener failed')
      }
    }
    try {
      s.meta?.broadcast(e.projectId, { type: 'doc:changed', fileId: e.fileId, userId: e.userId })
    } catch (err) {
      log.warn({ ...errInfo(err) }, 'meta broadcast of doc:changed failed')
    }
  }

  /** Report activity to history now (resets the throttle window of `key`). */
  function reportActivity(room: DocRoom, key: string): void {
    room.activityNotedAt.set(key, Date.now())
    try {
      s.history?.noteActivity(room.projectId, key === '' ? null : key)
    } catch (err) {
      log.warn({ ...errInfo(err) }, 'history.noteActivity failed')
    }
  }

  /**
   * Throttled history.noteActivity, lossless: the first edit of a window is reported at once,
   * an edit inside the window schedules one report at its end. History relies on this — an
   * edit made right after a snapshot must open a new snapshot window (idle snapshot, pre-delete
   * check) even when nobody types afterwards.
   */
  function noteActivity(room: DocRoom, userId: string | null): void {
    const key = userId ?? ''
    const last = room.activityNotedAt.get(key)
    const wait = last === undefined ? 0 : last + opts.activityThrottleMs - Date.now()
    const trailing = room.activityTimers.get(key)
    if (wait <= 0) {
      // (a trailing report that is late because the event loop was busy is superseded)
      if (trailing) {
        clearTimeout(trailing)
        room.activityTimers.delete(key)
      }
      reportActivity(room, key)
      return
    }
    if (trailing) return
    const timer = setTimeout(() => {
      room.activityTimers.delete(key)
      reportActivity(room, key)
    }, wait)
    timer.unref()
    room.activityTimers.set(key, timer)
  }

  /** Report the room's scheduled trailing activity now (the room is being dropped or unloaded). */
  function flushActivity(room: DocRoom): void {
    const keys = [...room.activityTimers.keys()]
    for (const t of room.activityTimers.values()) clearTimeout(t)
    room.activityTimers.clear()
    for (const key of keys) reportActivity(room, key)
  }

  const host: DocRoomHost = {
    s,
    log,
    timings: { saveDebounceMs: opts.saveDebounceMs, saveMaxWaitMs: opts.saveMaxWaitMs, saveRetryMs: opts.saveRetryMs },

    noteEdit(room, userId) {
      editCounts.set(room.projectId, (editCounts.get(room.projectId) ?? 0) + 1)
      if (userId) {
        room.lastEditor = userId
        let set = editors.get(room.projectId)
        if (!set) editors.set(room.projectId, (set = new Set()))
        set.add(userId)
      }
      noteActivity(room, userId)
      // throttle: first change arms the timer; the emission carries the latest editor
      room.docChangedUser = userId ?? room.docChangedUser
      if (!room.docChangedTimer) {
        room.docChangedTimer = setTimeout(() => emitDocChanged(room), opts.docChangedMs)
        room.docChangedTimer.unref()
      }
    },

    roomEmpty(room) {
      if (shuttingDown || room.discarded) return
      room.flush().catch(() => { /* logged by the room; retried */ })
      scheduleUnload(room)
    },

    roomInvalid(room, code, reason) {
      log.warn({ room: room.label, code, reason }, 'dropping room whose file changed underneath it')
      // not awaited: this is called from inside the room's save chain
      void dropRoom(room, code, reason, true)
    },
  }

  // -------------------------------------------------------------------------
  // Room lifecycle
  // -------------------------------------------------------------------------

  function acquireRoom(projectId: string, fileId: string, epoch: number): DocRoom {
    const key = roomKey(projectId, fileId)
    let room = rooms.get(key)
    if (room && room.epoch !== epoch) {
      // the db epoch moved on without discardFile: the old state must not be served any more
      void dropRoom(room, WS_CLOSE.STALE_EPOCH, 'document replaced', true)
      room = undefined
    }
    if (!room) {
      const created = new DocRoom(host, projectId, fileId, epoch)
      rooms.set(key, created)
      created.ready.catch(err => {
        if (created.discarded) return
        const level = err instanceof RoomLoadError ? 'warn' : 'error'
        log[level]({ room: created.label, ...errInfo(err) }, 'could not open document')
        if (rooms.get(key) === created) rooms.delete(key)
        created.fail(err)
      })
      room = created
    }
    cancelUnload(room)
    return room
  }

  function cancelUnload(room: DocRoom): void {
    room.unloadGen++
    if (room.unloadTimer) {
      clearTimeout(room.unloadTimer)
      room.unloadTimer = null
    }
  }

  function scheduleUnload(room: DocRoom): void {
    cancelUnload(room)
    const gen = room.unloadGen
    room.unloadTimer = setTimeout(() => void unload(room, gen), opts.unloadMs)
    room.unloadTimer.unref()
  }

  async function unload(room: DocRoom, gen: number): Promise<void> {
    room.unloadTimer = null
    const current = () => room.unloadGen === gen && room.conns.size === 0 && rooms.get(room.key) === room && !room.discarded
    if (!current()) return
    try {
      await room.ready
      room.verifyPath()
      await room.flush()
    } catch {
      // load failures drop the room themselves; failed saves keep it in memory and retry later
      if (current()) scheduleUnload(room)
      return
    }
    if (!current()) return
    rooms.delete(room.key)
    flushActivity(room)
    room.dispose()
    log.debug({ room: room.label }, 'room unloaded')
  }

  /** Remove a room without saving, close its sockets and optionally delete the file's sidecars. */
  async function dropRoom(room: DocRoom, code: number, reason: string, deleteSidecars: boolean): Promise<void> {
    if (rooms.get(room.key) === room) rooms.delete(room.key)
    if (!room.discarded) room.discard(code, reason)
    flushActivity(room)
    await room.settled()
    if (deleteSidecars) await deleteFileSidecars(room.projectId, room.fileId)
  }

  /** Delete every sidecar of a file except the one of a room that is live for it right now. */
  async function deleteFileSidecars(projectId: string, fileId: string): Promise<void> {
    const live = rooms.get(roomKey(projectId, fileId))
    const keep = live && !live.discarded ? live.epoch : null
    let sidecars: { epoch: number; path: string }[]
    try {
      sidecars = await listSidecars(s.config.dirs.ystate, projectId, fileId)
    } catch (err) {
      log.warn({ projectId, fileId, ...errInfo(err) }, 'could not list sidecars')
      return
    }
    await Promise.all(sidecars.filter(sc => sc.epoch !== keep).map(sc => fsp.rm(sc.path, { force: true }).catch(err => {
      log.warn({ file: sc.path, ...errInfo(err) }, 'could not delete sidecar')
    })))
  }

  function projectRooms(projectId: string): DocRoom[] {
    return [...rooms.values()].filter(r => r.projectId === projectId)
  }

  /** db record of a text file of the project, or an HttpError */
  function textRecord(projectId: string, fileId: string) {
    if (!isSafeId(projectId) || !isSafeId(fileId)) throw notFound('File not found')
    const rec = s.db.files.get(fileId)
    if (!rec || rec.projectId !== projectId) throw notFound('File not found')
    if (rec.kind !== 'text') throw badRequest('Not a text file')
    return rec
  }

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  function onConnection(ws: WebSocket, ctx: DocUpgradeContext): void {
    const reject = (code: number, reason: string) => ws.close(code, reason)
    if (shuttingDown) return reject(WS_CLOSE.SERVICE_RESTART, 'server restarting')
    if (!ctx.user) return reject(WS_CLOSE.UNAUTHORIZED, 'not logged in')
    // unknown project → 4404; a project the user cannot open → 4403 (web-core re-checks access)
    if (!isSafeId(ctx.projectId) || !s.db.projects.get(ctx.projectId)) return reject(WS_CLOSE.NOT_FOUND, 'unknown project')
    if (!ctx.role) return reject(WS_CLOSE.FORBIDDEN, 'no access to this project')
    // the user may open the project but the document is gone (deleted, or never of this project)
    // → 4410 so the client drops the session instead of treating it as an access problem
    const rec = isSafeId(ctx.fileId) ? s.db.files.get(ctx.fileId) : null
    if (!rec || rec.projectId !== ctx.projectId) return reject(WS_CLOSE.GONE, 'file does not exist')
    if (rec.kind !== 'text') return reject(WS_CLOSE.STALE_EPOCH, 'file is not a text document')
    if (!Number.isSafeInteger(ctx.epoch) || ctx.epoch !== rec.epoch) return reject(WS_CLOSE.STALE_EPOCH, 'stale epoch')
    const room = acquireRoom(ctx.projectId, ctx.fileId, rec.epoch)
    room.addConn(new Conn(ws, ctx.user, ctx.role, ctx.role === 'viewer', ctx.sessionTokenHash ?? null))
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  const service: CollabServiceImpl = {
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: DocUpgradeContext): void {
      if (shuttingDown) {
        socket.destroy()
        return
      }
      wss.handleUpgrade(req, socket, head, ws => {
        try {
          onConnection(ws, ctx)
        } catch (err) {
          log.error({ projectId: ctx.projectId, fileId: ctx.fileId, ...errInfo(err) }, 'doc connection setup failed')
          ws.close(WS_CLOSE.INTERNAL, 'internal error')
        }
      })
    },

    async getText(projectId, fileId) {
      const rec = textRecord(projectId, fileId)
      const room = rooms.get(roomKey(projectId, fileId))
      if (room && room.epoch === rec.epoch && !room.discarded) {
        try {
          await room.ready
          if (!room.discarded) return room.text.toString()
        } catch {
          // fall back to the disk copy
        }
      }
      const bytes = await readIfExists(s.files.absPath(projectId, rec.path))
      return bytes ? normalizeText(bytes.toString('utf8')) : ''
    },

    async setText(projectId, fileId, text, origin) {
      if (shuttingDown) throw new HttpError(503, 'unavailable', 'Server is restarting')
      const rec = textRecord(projectId, fileId)
      const next = normalizeText(text)
      if (next.length > MAX_DOC_LENGTH) throw tooLarge('Document is too large')
      const room = acquireRoom(projectId, fileId, rec.epoch)
      try {
        await room.ready
      } catch (err) {
        throw loadErrorToHttp(err)
      }
      if (room.discarded) throw conflict('The document changed while it was being written')
      room.serverOrigin = { userId: origin?.userId ?? null, reason: origin?.reason ?? 'server' }
      try {
        room.doc.transact(() => applyTextDiff(room.text, next), SERVER_ORIGIN)
      } finally {
        room.serverOrigin = null
      }
      await room.flush()
      if (room.conns.size === 0 && !room.discarded) scheduleUnload(room)
    },

    async flushProject(projectId) {
      const results = await Promise.allSettled(projectRooms(projectId).map(async room => {
        try {
          await room.ready
        } catch {
          return // never loaded: nothing to write
        }
        room.verifyPath()
        await room.flush()
      }))
      const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (failed) throw failed.reason
    },

    async discardFile(projectId, fileId, code) {
      if (!isSafeId(projectId) || !isSafeId(fileId)) return
      const room = rooms.get(roomKey(projectId, fileId))
      if (room) await dropRoom(room, code, CLOSE_REASONS[code] ?? 'document closed', false)
      await deleteFileSidecars(projectId, fileId)
    },

    async discardProject(projectId) {
      if (!isSafeId(projectId)) return
      await Promise.all(projectRooms(projectId).map(room => dropRoom(room, WS_CLOSE.GONE, 'project deleted', false)))
      editors.delete(projectId)
      editCounts.delete(projectId)
      await fsp.rm(projectStateDir(s.config.dirs.ystate, projectId), { recursive: true, force: true })
    },

    disconnectUser(projectId, userId, code) {
      for (const room of projectRooms(projectId)) {
        for (const conn of [...room.conns]) {
          if (conn.user.id === userId) room.closeConn(conn, code, CLOSE_REASONS[code] ?? 'disconnected')
        }
      }
    },

    disconnectSessions(tokenHashes, code) {
      if (tokenHashes.length === 0) return 0
      const wanted = new Set(tokenHashes)
      let n = 0
      for (const room of [...rooms.values()]) {
        for (const conn of [...room.conns]) {
          if (conn.session !== null && wanted.has(conn.session)) {
            room.closeConn(conn, code, CLOSE_REASONS[code] ?? 'disconnected')
            n++
          }
        }
      }
      return n
    },

    openSessions() {
      const out = new Set<string>()
      for (const room of rooms.values()) for (const conn of room.conns) if (conn.session) out.add(conn.session)
      return [...out]
    },

    onDocChanged(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },

    takeEditors(projectId) {
      const set = editors.get(projectId)
      editors.delete(projectId)
      return set ? [...set] : []
    },

    editCount(projectId) {
      return editCounts.get(projectId) ?? 0
    },

    async shutdown() {
      if (shuttingDown) return
      shuttingDown = true
      if (keepaliveTimer) clearInterval(keepaliveTimer)
      if (pingTimer) clearInterval(pingTimer)
      if (pathTimer) clearInterval(pathTimer)
      const all = [...rooms.values()]
      // stop accepting edits first, then write everything
      for (const room of all) room.closeAll(WS_CLOSE.SERVICE_RESTART, 'server restarting')
      const results = await Promise.allSettled(all.map(async room => {
        try {
          await room.ready
        } catch {
          return
        }
        room.verifyPath()
        await room.flush()
      }))
      for (const r of results) if (r.status === 'rejected') log.error({ ...errInfo(r.reason) }, 'flush on shutdown failed')
      for (const room of all) {
        flushActivity(room)
        room.dispose()
      }
      rooms.clear()
      listeners.clear()
      await new Promise<void>(resolve => wss.close(() => resolve()))
    },

    stats() {
      return {
        rooms: [...rooms.values()].map(r => ({
          projectId: r.projectId, fileId: r.fileId, epoch: r.epoch, state: r.state,
          connections: r.conns.size, unsaved: r.hasUnsavedChanges,
        })),
      }
    },
  }
  return service
}
