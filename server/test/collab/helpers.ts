/**
 * Test harness for the collab module: temp data dir + real SQLite db, a minimal FileService,
 * an http server on an ephemeral port whose upgrade handler routes like main.ts (the user is
 * chosen with the `u` query parameter), and real y-websocket 3.1.0 clients in Node.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import type { FileEntry, Role, UserPublic } from '@folio/shared/api'
import { DOC_TEXT_KEY, MSG_BARRIER, MSG_EVENT, type ProjectEvent } from '@folio/shared/protocol'
import { loadConfig, type Config } from '../../src/config.ts'
import { openDb, toPublic, type Db } from '../../src/db/index.ts'
import type { FileService, Services } from '../../src/services.ts'
import {
  createCollabService, createMetaService, type CollabLogger, type CollabOptions, type CollabServiceImpl,
  type MetaOptions, type MetaServiceImpl,
} from '../../src/collab/index.ts'

export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

export async function waitFor(cond: () => boolean | Promise<boolean>, timeoutMs = 5000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await cond()) return
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await sleep(10)
  }
}

export interface LogRecord { level: string; obj: object; msg?: string }

/** Logger that records everything (tests can assert on warnings) and prints errors. */
export function testLogger(records: LogRecord[] = []): CollabLogger & { records: LogRecord[] } {
  const rec = (level: string) => (obj: object, msg?: string) => {
    records.push({ level, obj, msg })
    if (level === 'error' && process.env.FOLIO_TEST_VERBOSE) console.error(msg, obj)
  }
  return { records, debug: rec('debug'), info: rec('info'), warn: rec('warn'), error: rec('error') }
}

export interface TestUsers { alice: UserPublic; bob: UserPublic; victor: UserPublic; mallory: UserPublic }

export interface Env {
  dir: string
  config: Config
  db: Db
  s: Services
  users: TestUsers
  projectId: string
  noteActivity: { projectId: string; userId: string | null }[]
  events: { projectId: string; event: ProjectEvent }[]
  log: ReturnType<typeof testLogger>
  collab: CollabServiceImpl | null
  meta: MetaServiceImpl | null
  port: number
  server: http.Server
  clients: Set<{ destroy(): void }>
  createTextFile(p: string, content: string, projectId?: string): FileEntry
  createBinaryFile(p: string, bytes: Buffer): FileEntry
  abs(p: string, projectId?: string): string
  readDisk(p: string): Promise<string>
  sidecar(fileId: string, epoch?: number): string
  startCollab(opts?: Partial<CollabOptions>): CollabServiceImpl
  startMeta(opts?: Partial<MetaOptions>): MetaServiceImpl
  cleanup(): Promise<void>
}

/** Build the environment. `withMeta: false` injects a fake meta service that records broadcasts. */
export async function makeEnv(opts: { withMeta?: boolean } = {}): Promise<Env> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-collab-test-'))
  const config = loadConfig({ DATA_DIR: dir, NODE_ENV: 'test' } as NodeJS.ProcessEnv)
  for (const d of Object.values(config.dirs)) await fsp.mkdir(d, { recursive: true })
  const db = openDb(path.join(dir, 'db.sqlite'))

  const mk = (email: string, name: string) => toPublic(db.users.create({ email, name, passwordHash: 'x' }))
  const users: TestUsers = {
    alice: mk('alice@example.com', 'Alice'),
    bob: mk('bob@example.com', 'Bob'),
    victor: mk('victor@example.com', 'Victor'),
    mallory: mk('mallory@example.com', 'Mallory'),
  }
  const project = db.projects.create({ name: 'Paper', ownerId: users.alice.id })
  db.members.upsert(project.id, users.bob.id, 'editor')
  db.members.upsert(project.id, users.victor.id, 'viewer')

  const projectDir = (pid: string) => path.join(config.dirs.projects, pid)
  const absPath = (pid: string, p: string) => {
    const root = projectDir(pid)
    const abs = path.resolve(root, p)
    if (!abs.startsWith(root + path.sep)) throw new Error(`path escapes project: ${p}`)
    return abs
  }
  const toEntry = (r: FileEntry): FileEntry => ({ id: r.id, path: r.path, kind: r.kind, size: r.size, epoch: r.epoch, updatedAt: r.updatedAt })
  const files = {
    projectDir,
    absPath,
    list: (pid: string) => db.files.list(pid).map(toEntry),
    get: (pid: string, id: string) => {
      const r = db.files.get(id)
      return r && r.projectId === pid ? toEntry(r) : null
    },
    getByPath: (pid: string, p: string) => {
      const r = db.files.getByPath(pid, p)
      return r ? toEntry(r) : null
    },
  } as unknown as FileService

  const noteActivity: Env['noteActivity'] = []
  const events: Env['events'] = []
  const log = testLogger()
  const s = {
    config, db, files,
    history: { noteActivity: (projectId: string, userId: string | null) => { noteActivity.push({ projectId, userId }) } },
  } as unknown as Services
  if (opts.withMeta === false) {
    s.meta = {
      broadcast: (projectId: string, event: ProjectEvent) => { events.push({ projectId, event }) },
      syncFiles: () => {},
      syncProject: () => {},
    } as unknown as Services['meta']
  }

  const server = http.createServer((_req, res) => {
    res.statusCode = 404
    res.end()
  })
  const env: Env = {
    dir, config, db, s, users, projectId: project.id, noteActivity, events, log,
    collab: null, meta: null, port: 0, server, clients: new Set(),
    createTextFile(p, content, projectId = project.id) {
      const abs = absPath(projectId, p)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
      return toEntry(db.files.create({ projectId, path: p, kind: 'text', size: Buffer.byteLength(content) }))
    },
    createBinaryFile(p, bytes) {
      const abs = absPath(project.id, p)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, bytes)
      return toEntry(db.files.create({ projectId: project.id, path: p, kind: 'binary', size: bytes.length }))
    },
    abs: (p, projectId = project.id) => absPath(projectId, p),
    readDisk: p => fsp.readFile(absPath(project.id, p), 'utf8'),
    sidecar: (fileId, epoch = 0) => path.join(config.dirs.ystate, project.id, `${fileId}.${epoch}.ybin`),
    startCollab(o = {}) {
      const c = createCollabService(s, { logger: log, ...o })
      s.collab = c
      env.collab = c
      return c
    },
    startMeta(o = {}) {
      const m = createMetaService(s, { logger: log, ...o })
      s.meta = m
      env.meta = m
      return m
    },
    async cleanup() {
      for (const c of [...env.clients]) c.destroy()
      env.clients.clear()
      await env.collab?.shutdown().catch(() => {})
      await env.meta?.shutdown().catch(() => {})
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      db.close()
      await fsp.rm(dir, { recursive: true, force: true })
    },
  }

  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
    const uid = url.searchParams.get('u')
    const rec = uid ? db.users.get(uid) : null
    const user = rec ? toPublic(rec) : null
    if (parts[0] === 'ws' && parts[1] === 'doc' && parts.length === 4) {
      if (!env.collab) return void socket.destroy() // "server down"
      const role: Role | null = user ? db.members.roleOf(parts[2], user.id) : null
      const epochRaw = url.searchParams.get('epoch')
      const epoch = epochRaw !== null && /^\d{1,9}$/.test(epochRaw) ? Number(epochRaw) : -1
      env.collab.handleUpgrade(req, socket, head, { user, role, projectId: parts[2], fileId: parts[3], epoch, sessionTokenHash: url.searchParams.get('sid') })
      return
    }
    if (parts[0] === 'ws' && parts[1] === 'project' && parts.length === 3) {
      if (!env.meta) return void socket.destroy()
      const role: Role | null = user ? db.members.roleOf(parts[2], user.id) : null
      env.meta.handleUpgrade(req, socket, head, { user, role, projectId: parts[2], sessionTokenHash: url.searchParams.get('sid') })
      return
    }
    socket.destroy()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  env.port = (server.address() as AddressInfo).port
  return env
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export interface DocClient {
  doc: Y.Doc
  text: Y.Text
  provider: WebsocketProvider
  /** close codes received from the server (y-websocket 'closed' events, 4400–4499) */
  closes: number[]
  /** every 'status' event */
  statuses: string[]
  events: ProjectEvent[]
  synced(): Promise<void>
  /** MSG_BARRIER round trip on the current socket */
  barrier(timeoutMs?: number): Promise<void>
  destroy(): void
}

function attach(env: Env, doc: Y.Doc, provider: WebsocketProvider): DocClient {
  const closes: number[] = []
  const statuses: string[] = []
  const events: ProjectEvent[] = []
  const pending = new Map<string, () => void>()
  provider.on('closed', (e: { code: number }) => closes.push(e.code))
  provider.on('status', (e: { status: string }) => statuses.push(e.status))
  provider.messageHandlers[MSG_BARRIER] = (_enc, dec) => {
    const nonce = decoding.readVarString(dec)
    pending.get(nonce)?.()
    pending.delete(nonce)
  }
  provider.messageHandlers[MSG_EVENT] = (_enc, dec) => {
    events.push(JSON.parse(decoding.readVarString(dec)) as ProjectEvent)
  }
  let seq = 0
  const client: DocClient = {
    doc, text: doc.getText(DOC_TEXT_KEY), provider, closes, statuses, events,
    synced: () => waitFor(() => provider.synced, 5000, 'provider sync'),
    barrier(timeoutMs = 5000) {
      const ws = provider.ws
      if (!ws || !provider.wsconnected) return Promise.reject(new Error('not connected'))
      const nonce = `n${++seq}-${Math.random().toString(36).slice(2)}`
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_BARRIER)
      encoding.writeVarString(enc, nonce)
      return new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(nonce)
          reject(new Error('barrier timeout'))
        }, timeoutMs)
        pending.set(nonce, () => {
          clearTimeout(timer)
          resolve()
        })
        ws.send(encoding.toUint8Array(enc))
      })
    },
    destroy() {
      provider.destroy()
      doc.destroy()
      env.clients.delete(client)
    },
  }
  env.clients.add(client)
  return client
}

export function docClient(env: Env, file: { id: string; epoch?: number }, user: UserPublic, o: { epoch?: number; doc?: Y.Doc; connect?: boolean; session?: string } = {}): DocClient {
  const doc = o.doc ?? new Y.Doc()
  const provider = new WebsocketProvider(`ws://127.0.0.1:${env.port}/ws/doc/${env.projectId}`, file.id, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
    maxBackoffTime: 300,
    connect: o.connect ?? true,
    params: { epoch: String(o.epoch ?? file.epoch ?? 0), u: user.id, ...(o.session ? { sid: o.session } : {}) },
  })
  return attach(env, doc, provider)
}

export function metaClient(env: Env, user: UserPublic, o: { projectId?: string; session?: string } = {}): DocClient {
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(`ws://127.0.0.1:${env.port}/ws/project`, o.projectId ?? env.projectId, doc, {
    WebSocketPolyfill: WebSocket as unknown as typeof globalThis.WebSocket,
    disableBc: true,
    maxBackoffTime: 300,
    params: { u: user.id, ...(o.session ? { sid: o.session } : {}) },
  })
  return attach(env, doc, provider)
}

/** Raw ws connection (no y-websocket) for protocol-level tests. */
export function rawSocket(env: Env, pathAndQuery: string, opts: WebSocket.ClientOptions = {}): { ws: WebSocket; messages: Uint8Array[]; closed: Promise<number>; opened: Promise<void> } {
  const ws = new WebSocket(`ws://127.0.0.1:${env.port}${pathAndQuery}`, opts)
  ws.binaryType = 'nodebuffer'
  const messages: Uint8Array[] = []
  ws.on('message', (data: Buffer) => messages.push(new Uint8Array(data)))
  const closed = new Promise<number>(resolve => ws.on('close', code => resolve(code)))
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve())
    ws.once('error', reject)
  })
  env.clients.add({ destroy: () => ws.terminate() })
  return { ws, messages, closed, opened }
}

export function countOccurrences(haystack: string, needle: string): number {
  let n = 0
  for (let i = haystack.indexOf(needle); i !== -1; i = haystack.indexOf(needle, i + needle.length)) n++
  return n
}
