/**
 * Test harness for the history module: temp data dir, real SQLite (:memory:), real git, and
 * small fakes for the services history talks to (collab, files, meta).
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { FileEntry, UserPublic } from '@folio/shared/api'
import { classifyFile, normalizeText } from '@folio/shared/filetypes'
import { dirname, isWithin } from '@folio/shared/paths'
import type { ProjectEvent } from '@folio/shared/protocol'
import { loadConfig, type Config } from '../../src/config.ts'
import { openDb, toPublic, type Db } from '../../src/db/index.ts'
import { conflict, notFound } from '../../src/http/errors.ts'
import { createHistoryService, type FolioHistoryService, type HistoryServiceOptions } from '../../src/history/index.ts'
import type { CollabService, FileService, MetaService, Services } from '../../src/services.ts'

export interface SetTextCall { projectId: string; fileId: string; path: string; text: string; origin?: { userId: string | null; reason: string } }
export interface FileCall { op: 'writeFile' | 'remove'; path: string; bytes?: Buffer; replace?: boolean }

export interface FakeCollab extends CollabService {
  setTextCalls: SetTextCall[]
  flushCount: number
  /** user ids returned (and cleared) by the next takeEditors(pid) */
  editors: Map<string, string[]>
  failFlush: boolean
  /** editCount(pid) — setText bumps it; tests bump it for edits "collab applied" (see put) */
  edits: Map<string, number>
}

export interface FakeMeta extends MetaService {
  events: { projectId: string; event: ProjectEvent }[]
}

export interface FakeFiles extends FileService {
  calls: FileCall[]
}

export interface Harness {
  root: string
  config: Config
  db: Db
  s: Services
  history: FolioHistoryService
  collab: FakeCollab
  files: FakeFiles
  meta: FakeMeta
  owner: UserPublic
  alice: UserPublic
  bob: UserPublic
  pid: string
  projectDir: string
  gitDir: string
  /** create or overwrite a file the way an edit would end up on disk (db row kept in sync) */
  put(p: string, content: string | Buffer): Promise<FileEntry>
  /** delete a file or folder (db + disk) */
  del(p: string): Promise<void>
  /** raw git against the project's git dir (for assertions) */
  git(args: string[], input?: string): string
  gitBuf(args: string[]): Buffer
  cleanup(): Promise<void>
}

export function gitEnv(home: string): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: home,
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
  }
}

export async function setup(opts: HistoryServiceOptions = {}): Promise<Harness> {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'folio-history-test-'))
  const config = loadConfig({ DATA_DIR: path.join(root, 'data'), NODE_ENV: 'test' })
  for (const d of Object.values(config.dirs)) await fs.promises.mkdir(d, { recursive: true })
  const db = openDb(':memory:')

  const mk = (email: string, name: string) => toPublic(db.users.create({ email, name, passwordHash: 'x' }))
  const owner = mk('owner@example.org', 'Olivia Owner')
  const alice = mk('alice@example.org', 'Alice Ångström')
  const bob = mk('bob@example.org', 'Bob <Builder>')
  const project = db.projects.create({ name: 'Test project', ownerId: owner.id })
  const pid = project.id
  const projectDir = path.join(config.dirs.projects, pid)
  await fs.promises.mkdir(projectDir, { recursive: true })

  const s = { config, db } as Services
  const absPath = (projectId: string, p: string) => path.join(config.dirs.projects, projectId, p)

  const collab: FakeCollab = {
    setTextCalls: [],
    flushCount: 0,
    editors: new Map(),
    failFlush: false,
    edits: new Map(),
    handleUpgrade() { throw new Error('not implemented in tests') },
    async getText(projectId, fileId) {
      const f = db.files.get(fileId)
      if (!f) throw notFound('file')
      return fs.promises.readFile(absPath(projectId, f.path), 'utf8')
    },
    async setText(projectId, fileId, text, origin) {
      const f = db.files.get(fileId)
      if (!f) throw notFound('file')
      const norm = normalizeText(text)
      collab.setTextCalls.push({ projectId, fileId, path: f.path, text: norm, origin })
      collab.edits.set(projectId, (collab.edits.get(projectId) ?? 0) + 1)
      await fs.promises.writeFile(absPath(projectId, f.path), norm)
      db.files.update(fileId, { size: Buffer.byteLength(norm) })
      s.history.noteActivity(projectId, origin?.userId ?? null)
    },
    async flushProject() {
      collab.flushCount++
      if (collab.failFlush) throw new Error('collab is shut down')
    },
    async discardFile() {},
    async discardProject() {},
    disconnectUser() {},
    disconnectSessions() { return 0 },
    openSessions() { return [] },
    onDocChanged() { return () => {} },
    takeEditors(projectId) {
      const e = collab.editors.get(projectId) ?? []
      collab.editors.delete(projectId)
      return e
    },
    editCount(projectId) {
      return collab.edits.get(projectId) ?? 0
    },
    async shutdown() {},
  }

  const meta: FakeMeta = {
    events: [],
    handleUpgrade() { throw new Error('not implemented in tests') },
    broadcast(projectId, event) { meta.events.push({ projectId, event }) },
    syncFiles() {},
    syncProject() {},
    disconnectUser() {},
    disconnectSessions() { return 0 },
    openSessions() { return [] },
    closeProject() {},
    async shutdown() {},
  }

  async function ensureParents(projectId: string, p: string): Promise<void> {
    const parts = dirname(p).split('/').filter(Boolean)
    let cur = ''
    for (const part of parts) {
      cur = cur ? `${cur}/${part}` : part
      const row = db.files.getByPath(projectId, cur)
      if (row && row.kind !== 'folder') throw conflict(`${cur} is a file`)
      if (!row) db.files.create({ projectId, path: cur, kind: 'folder' })
      await fs.promises.mkdir(absPath(projectId, cur), { recursive: true })
    }
  }

  const files: FakeFiles = {
    calls: [],
    projectDir: projectId => path.join(config.dirs.projects, projectId),
    absPath,
    list: projectId => db.files.list(projectId),
    get: (_projectId, fileId) => db.files.get(fileId),
    getByPath: (projectId, p) => db.files.getByPath(projectId, p),
    async create(projectId, user, p, kind, content) {
      if (db.files.getByPath(projectId, p)) throw conflict('exists')
      await ensureParents(projectId, p)
      if (kind === 'folder') {
        await fs.promises.mkdir(absPath(projectId, p), { recursive: true })
        return db.files.create({ projectId, path: p, kind })
      }
      const text = normalizeText(content ?? '')
      await fs.promises.writeFile(absPath(projectId, p), text)
      const row = db.files.create({ projectId, path: p, kind, size: Buffer.byteLength(text) })
      s.history.noteActivity(projectId, user?.id ?? null)
      return row
    },
    async writeFile(projectId, user, p, bytes, opts) {
      files.calls.push({ op: 'writeFile', path: p, bytes: Buffer.from(bytes), replace: opts?.replace })
      const existing = db.files.getByPath(projectId, p)
      if (existing && !opts?.replace) throw conflict('exists')
      if (existing?.kind === 'folder') throw conflict('folder')
      await ensureParents(projectId, p)
      const kind = classifyFile(p, bytes)
      if (existing && existing.kind === 'text' && kind === 'text') {
        await collab.setText(projectId, existing.id, bytes.toString('utf8'), { userId: user?.id ?? null, reason: 'upload' })
        return db.files.get(existing.id)!
      }
      const data = kind === 'text' ? Buffer.from(normalizeText(bytes.toString('utf8'))) : bytes
      await fs.promises.writeFile(absPath(projectId, p), data)
      let row
      if (existing) {
        row = db.files.update(existing.id, { kind, size: data.length })!
        if (existing.kind !== kind) row = db.files.bumpEpoch(existing.id)!
      } else {
        row = db.files.create({ projectId, path: p, kind, size: data.length })
      }
      s.history.noteActivity(projectId, user?.id ?? null)
      return row
    },
    async move(projectId, user, fileId, newPath) {
      const f = db.files.get(fileId)
      if (!f) throw notFound('file')
      await ensureParents(projectId, newPath)
      await fs.promises.rename(absPath(projectId, f.path), absPath(projectId, newPath))
      const moved: FileEntry[] = []
      for (const row of db.files.list(projectId)) {
        if (!isWithin(row.path, f.path)) continue
        moved.push(db.files.update(row.id, { path: newPath + row.path.slice(f.path.length) })!)
      }
      s.history.noteActivity(projectId, user?.id ?? null)
      return moved
    },
    async remove(projectId, user, fileId) {
      const f = db.files.get(fileId)
      if (!f) throw notFound('file')
      files.calls.push({ op: 'remove', path: f.path })
      await fs.promises.rm(absPath(projectId, f.path), { recursive: true, force: true })
      const ids: string[] = []
      for (const row of db.files.list(projectId)) {
        if (!isWithin(row.path, f.path)) continue
        db.files.delete(row.id)
        ids.push(row.id)
      }
      s.history.noteActivity(projectId, user?.id ?? null)
      return ids
    },
    async read(projectId, fileId) {
      const f = db.files.get(fileId)
      if (!f) throw notFound('file')
      if (f.kind === 'text') return Buffer.from(await collab.getText(projectId, fileId))
      return fs.promises.readFile(absPath(projectId, f.path))
    },
  }

  s.files = files
  s.collab = collab
  s.meta = meta
  s.compile = {} as Services['compile']
  s.synctex = {} as Services['synctex']
  const history = createHistoryService(s, opts)
  s.history = history

  const gitDir = path.join(config.dirs.history, `${pid}.git`)
  const home = path.join(root, 'home')
  await fs.promises.mkdir(home, { recursive: true })

  const h: Harness = {
    root, config, db, s, history, collab, files, meta, owner, alice, bob, pid, projectDir, gitDir,
    async put(p, content) {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content)
      const existing = db.files.getByPath(pid, p)
      if (existing && existing.kind === 'text' && classifyFile(p, bytes) === 'text') {
        // an edit that collab has already flushed to disk (collab counted it: editCount)
        collab.edits.set(pid, (collab.edits.get(pid) ?? 0) + 1)
        await fs.promises.writeFile(absPath(pid, p), bytes)
        return db.files.update(existing.id, { size: bytes.length })!
      }
      const row = await files.writeFile(pid, null, p, bytes, { replace: true })
      files.calls.length = 0
      return row
    },
    async del(p) {
      const f = db.files.getByPath(pid, p)
      if (!f) throw new Error(`no such file ${p}`)
      await files.remove(pid, null, f.id)
      files.calls.length = 0
    },
    git(args, input) {
      return execFileSync('git', [`--git-dir=${gitDir}`, ...args], { env: gitEnv(home), input, encoding: 'utf8' })
    },
    gitBuf(args) {
      return execFileSync('git', [`--git-dir=${gitDir}`, ...args], { env: gitEnv(home) })
    },
    async cleanup() {
      await history.shutdown().catch(() => {})
      db.close()
      await fs.promises.rm(root, { recursive: true, force: true })
    },
  }
  return h
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Poll until `fn` returns a truthy value (or throw after `timeoutMs`). */
export async function waitFor<T>(fn: () => T | Promise<T>, timeoutMs = 5000, stepMs = 20): Promise<NonNullable<T>> {
  const until = Date.now() + timeoutMs
  for (;;) {
    const v = await fn()
    if (v) return v as NonNullable<T>
    if (Date.now() > until) throw new Error('waitFor: timed out')
    await sleep(stepMs)
  }
}

/** Collect a readable stream into a Buffer. */
export async function collect(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const c of stream as AsyncIterable<Buffer | string>) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c))
  return Buffer.concat(chunks)
}

/**
 * Unzip a buffer with yauzl: path → bytes (directories skipped). Names are decoded here
 * (decodeStrings: false) because yauzl's own validation rejects legal names such as
 * "a:b.tex" as Windows drive paths; we still refuse absolute and '..' names.
 */
export async function unzip(buf: Buffer): Promise<Map<string, Buffer>> {
  const yauzl = await import('yauzl')
  const zip = await yauzl.fromBufferPromise(buf, { lazyEntries: true, decodeStrings: false, validateEntrySizes: true })
  const out = new Map<string, Buffer>()
  try {
    for await (const entry of zip.eachEntry()) {
      const raw = entry.fileName as unknown as Buffer
      const name = new TextDecoder('utf-8', { fatal: true }).decode(raw)
      if (name.startsWith('/') || name.split('/').includes('..')) throw new Error(`unsafe zip entry ${name}`)
      if (name.endsWith('/')) continue
      const rs = await zip.openReadStreamPromise(entry)
      out.set(name, await collect(rs))
    }
  } finally {
    zip.close()
  }
  return out
}
