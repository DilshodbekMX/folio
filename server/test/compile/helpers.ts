/**
 * Test harness for the compile module: a fake Services container over a temp data dir.
 *   - db: in-memory SQLite (the real schema), one owner + one project
 *   - files: minimal FileService over data/projects/<pid> (paths → db rows, disk writes)
 *   - collab.getText: reads the file from disk (normalised), like an unloaded room
 *   - meta.broadcast: records events
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FileEntry, ProjectSettings, UserPublic } from '@folio/shared/api'
import { classifyFile, normalizeText } from '@folio/shared/filetypes'
import { dirname, safePath } from '@folio/shared/paths'
import type { ProjectEvent } from '@folio/shared/protocol'
import { loadConfig, type Config } from '../../src/config.ts'
import { openDb, toPublic, type Db, type FileRecord } from '../../src/db/index.ts'
import type { CollabService, FileService, MetaService, Services } from '../../src/services.ts'
import { createCompileService, type CompileServiceOptions, type FolioCompileService } from '../../src/compile/index.ts'

export const DOCKER = process.env.FOLIO_DOCKER_TESTS === '1'
export const PAPER_DIR = fileURLToPath(new URL('../../../../', import.meta.url)).replace(/\/$/, '')
export const TEST_PREFIX = 'folio-server-compile-'

function entry(r: FileRecord): FileEntry {
  return { id: r.id, path: r.path, kind: r.kind, size: r.size, epoch: r.epoch, updatedAt: r.updatedAt }
}

export interface TestEnv {
  root: string
  config: Config
  db: Db
  s: Services
  compile: FolioCompileService
  owner: UserPublic
  editor: UserPublic
  viewer: UserPublic
  outsider: UserPublic
  pid: string
  events: { projectId: string; event: ProjectEvent }[]
  /** create/replace a project file (parents become folder entries) */
  write(p: string, content: string | Buffer): FileEntry
  remove(p: string): void
  fileId(p: string): string
  setSettings(patch: Partial<ProjectSettings>): void
  newProject(name?: string): string
  /** re-create the compile service over the same data dir (simulated restart) */
  restart(opts?: CompileServiceOptions): FolioCompileService
  close(): Promise<void>
}

export interface EnvOptions extends CompileServiceOptions {
  runnerKind?: 'fake' | 'docker' | 'local'
  env?: Record<string, string>
  settings?: Partial<ProjectSettings>
}

export async function makeEnv(o: EnvOptions = {}): Promise<TestEnv> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-compile-test-'))
  const config = loadConfig({
    NODE_ENV: 'test',
    DATA_DIR: path.join(root, 'data'),
    COMPILE_RUNNER: o.runnerKind ?? 'fake',
    ...(o.env ?? {}),
  })
  for (const d of Object.values(config.dirs)) fs.mkdirSync(d, { recursive: true })
  const db = openDb(':memory:')
  const mk = (name: string) => toPublic(db.users.create({ email: `${name}@example.test`, name, passwordHash: 'x' }))
  const owner = mk('owner')
  const editor = mk('editor')
  const viewer = mk('viewer')
  const outsider = mk('outsider')
  const events: TestEnv['events'] = []

  const projectDir = (pid: string) => path.join(config.dirs.projects, pid)
  const absPath = (pid: string, p: string) => path.join(projectDir(pid), safePath(p))

  const files: FileService = {
    projectDir,
    absPath,
    list: pid => db.files.list(pid).map(entry),
    get: (pid, id) => {
      const r = db.files.get(id)
      return r && r.projectId === pid ? entry(r) : null
    },
    getByPath: (pid, p) => {
      const r = db.files.getByPath(pid, p)
      return r ? entry(r) : null
    },
    async create(pid, _user, p, kind, content) {
      return kind === 'folder' ? writeFolder(pid, p) : writeFile(pid, p, content ?? '')
    },
    async writeFile(pid, _user, p, bytes) {
      return writeFile(pid, p, bytes)
    },
    async move() { throw new Error('not implemented in the test harness') },
    async remove(pid, _user, id) {
      const r = db.files.get(id)
      if (!r) return []
      removeFile(pid, r.path)
      return [id]
    },
    async read(pid, id) {
      const r = db.files.get(id)
      if (!r) throw new Error('missing')
      return fsp.readFile(absPath(pid, r.path))
    },
  }

  const collab: CollabService = {
    handleUpgrade() {},
    async getText(pid, fileId) {
      const r = db.files.get(fileId)
      if (!r || r.projectId !== pid) throw new Error('no such file')
      return normalizeText(await fsp.readFile(absPath(pid, r.path), 'utf8'))
    },
    async setText() {},
    async flushProject() {},
    async discardFile() {},
    async discardProject() {},
    disconnectUser() {},
    disconnectSessions() { return 0 },
    openSessions() { return [] },
    onDocChanged() { return () => {} },
    takeEditors() { return [] },
    editCount() { return 0 },
    async shutdown() {},
  }

  const meta: MetaService = {
    handleUpgrade() {},
    broadcast(projectId, event) { events.push({ projectId, event }) },
    syncFiles() {},
    syncProject() {},
    disconnectUser() {},
    disconnectSessions() { return 0 },
    openSessions() { return [] },
    closeProject() {},
    async shutdown() {},
  }

  const s = { config, db, files, collab, meta } as Services

  function writeFolder(pid: string, p: string): FileEntry {
    const rel = safePath(p)
    const existing = db.files.getByPath(pid, rel)
    if (existing) return entry(existing)
    const parent = dirname(rel)
    if (parent) writeFolder(pid, parent)
    fs.mkdirSync(absPath(pid, rel), { recursive: true })
    return entry(db.files.create({ projectId: pid, path: rel, kind: 'folder' }))
  }

  function writeFile(pid: string, p: string, content: string | Buffer): FileEntry {
    const rel = safePath(p)
    const parent = dirname(rel)
    if (parent) writeFolder(pid, parent)
    const raw = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
    const kind = classifyFile(rel, raw)
    const bytes = kind === 'text' ? Buffer.from(normalizeText(raw.toString('utf8')), 'utf8') : raw
    fs.writeFileSync(absPath(pid, rel), bytes)
    const existing = db.files.getByPath(pid, rel)
    if (existing) return entry(db.files.update(existing.id, { kind, size: bytes.length })!)
    return entry(db.files.create({ projectId: pid, path: rel, kind, size: bytes.length }))
  }

  function removeFile(pid: string, p: string): void {
    const r = db.files.getByPath(pid, p)
    if (!r) return
    fs.rmSync(absPath(pid, p), { recursive: true, force: true })
    db.files.delete(r.id)
  }

  function newProject(name = 'Test project'): string {
    const pid = db.projects.create({ name, ownerId: owner.id, settings: o.settings }).id
    db.members.upsert(pid, editor.id, 'editor')
    db.members.upsert(pid, viewer.id, 'viewer')
    fs.mkdirSync(projectDir(pid), { recursive: true })
    return pid
  }

  const pid = newProject()
  const serviceOpts: CompileServiceOptions = { namePrefix: TEST_PREFIX, ...o }
  s.compile = createCompileService(s, serviceOpts)

  const env: TestEnv = {
    root,
    config,
    db,
    s,
    get compile() { return s.compile as FolioCompileService },
    owner,
    editor,
    viewer,
    outsider,
    pid,
    events,
    write: (p, content) => writeFile(env.pid, p, content),
    remove: p => removeFile(env.pid, p),
    fileId: p => {
      const r = db.files.getByPath(env.pid, p)
      if (!r) throw new Error(`no file ${p}`)
      return r.id
    },
    setSettings: patch => { db.projects.updateSettings(env.pid, patch) },
    newProject,
    restart(opts) {
      s.compile = createCompileService(s, { ...serviceOpts, ...(opts ?? {}) })
      return s.compile as FolioCompileService
    },
    async close() {
      await s.compile.shutdown().catch(() => {})
      db.close()
      await fsp.rm(root, { recursive: true, force: true })
    },
  }
  return env
}

/** Copy a directory tree of the user's paper into the env's project (skipping generated files). */
export function importTree(env: TestEnv, srcDir: string, rel: string, skip: (name: string) => boolean = () => false): void {
  const src = path.join(srcDir, rel)
  const st = fs.lstatSync(src)
  if (st.isSymbolicLink()) return
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(src)) {
      if (skip(name)) continue
      importTree(env, srcDir, rel ? `${rel}/${name}` : name, skip)
    }
    return
  }
  env.write(rel, fs.readFileSync(src))
}

/** Names of running/stopped containers whose name starts with the test prefix. */
export async function leftoverContainers(): Promise<string[]> {
  const { execFileSync } = await import('node:child_process')
  const out = execFileSync('docker', ['ps', '-a', '--filter', `name=${TEST_PREFIX}`, '--format', '{{.Names}}'], { encoding: 'utf8' })
  return out.split('\n').map(x => x.trim()).filter(Boolean)
}

export function waitFor(cond: () => boolean, timeoutMs = 10_000, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (cond()) return resolve()
      if (Date.now() > deadline) return reject(new Error('waitFor timed out'))
      setTimeout(tick, stepMs)
    }
    tick()
  })
}

export const HELLO_TEX = String.raw`\documentclass{article}
\begin{document}
\section{Hello}
Hello, world! Folio compiles $x^2$.
\end{document}
`
