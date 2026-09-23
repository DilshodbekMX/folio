/**
 * Fake collab/meta/compile/history/synctex services for the foundation tests, and a helper that
 * builds a Services container on a temp DATA_DIR with the real db and FileService.
 * The fake collab reads text from disk (getText) and writes it to disk (setText).
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'
import type { CompileResponse, FileEntry, HistoryReason, Label, Role, UserPublic } from '@folio/shared/api'
import { normalizeText } from '@folio/shared/filetypes'
import type { ProjectEvent } from '@folio/shared/protocol'
import { loadConfig } from '../../src/config.ts'
import { openDb } from '../../src/db/index.ts'
import type { CollabService, CompileService, HistoryService, MetaService, Services, SynctexService } from '../../src/services.ts'
import { createFileService } from '../../src/files/service.ts'
import { writeFileAtomic } from '../../src/files/storage.ts'

export interface UpgradeCall {
  kind: 'doc' | 'meta'
  ctx: { user: UserPublic | null; role: Role | null; projectId: string; fileId?: string; epoch?: number; sessionTokenHash?: string | null }
}

export interface FakeCollab extends CollabService {
  setTextCalls: { projectId: string; fileId: string; text: string }[]
  discarded: { projectId: string; fileId: string; code: number }[]
  discardedProjects: string[]
  disconnected: { projectId: string; userId: string; code: number }[]
  /** disconnectSessions calls (token hashes, code) */
  sessionCloses: { tokenHashes: string[]; code: number }[]
  /** what openSessions() reports (tests set it) */
  liveSessions: string[]
  flushed: string[]
  upgrades: UpgradeCall[]
}

export function createFakeCollab(s: Services): FakeCollab {
  const listeners = new Set<(e: { projectId: string; fileId: string; userId: string | null }) => void>()
  const fake: FakeCollab = {
    setTextCalls: [],
    discarded: [],
    discardedProjects: [],
    disconnected: [],
    sessionCloses: [],
    liveSessions: [],
    flushed: [],
    upgrades: [],
    handleUpgrade(_req: IncomingMessage, socket: Duplex, _head: Buffer, ctx) {
      fake.upgrades.push({ kind: 'doc', ctx })
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    },
    async getText(projectId, fileId) {
      const f = s.files.get(projectId, fileId)
      if (!f) throw new Error(`no file ${fileId}`)
      return normalizeText(await fsp.readFile(s.files.absPath(projectId, f.path), 'utf8'))
    },
    async setText(projectId, fileId, text) {
      fake.setTextCalls.push({ projectId, fileId, text })
      const f = s.files.get(projectId, fileId)
      if (!f) throw new Error(`no file ${fileId}`)
      const data = Buffer.from(normalizeText(text), 'utf8')
      await writeFileAtomic(s.files.projectDir(projectId), s.files.absPath(projectId, f.path), data, s.config.dirs.tmp)
      s.db.files.update(fileId, { size: data.length })
    },
    async flushProject(projectId) {
      fake.flushed.push(projectId)
    },
    async discardFile(projectId, fileId, code) {
      fake.discarded.push({ projectId, fileId, code })
    },
    async discardProject(projectId) {
      fake.discardedProjects.push(projectId)
    },
    disconnectUser(projectId, userId, code) {
      fake.disconnected.push({ projectId, userId, code })
    },
    disconnectSessions(tokenHashes, code) {
      fake.sessionCloses.push({ tokenHashes: [...tokenHashes], code })
      const closing = new Set(tokenHashes)
      const before = fake.liveSessions.length
      fake.liveSessions = fake.liveSessions.filter(h => !closing.has(h))
      return before - fake.liveSessions.length
    },
    openSessions() {
      return [...fake.liveSessions]
    },
    onDocChanged(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    takeEditors() {
      return []
    },
    editCount() {
      return 0
    },
    async shutdown() {},
  }
  return fake
}

export interface FakeMeta extends MetaService {
  events: { projectId: string; event: ProjectEvent }[]
  syncedFiles: string[]
  syncedProjects: string[]
  disconnected: { projectId: string; userId: string; code: number }[]
  sessionCloses: { tokenHashes: string[]; code: number }[]
  liveSessions: string[]
  closed: { projectId: string; code: number }[]
  upgrades: UpgradeCall[]
  eventsOf(projectId: string, type?: ProjectEvent['type']): ProjectEvent[]
}

export function createFakeMeta(): FakeMeta {
  const fake: FakeMeta = {
    events: [],
    syncedFiles: [],
    syncedProjects: [],
    disconnected: [],
    sessionCloses: [],
    liveSessions: [],
    closed: [],
    upgrades: [],
    handleUpgrade(_req, socket, _head, ctx) {
      fake.upgrades.push({ kind: 'meta', ctx })
      socket.end('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    },
    broadcast(projectId, event) {
      fake.events.push({ projectId, event })
    },
    syncFiles(projectId) {
      fake.syncedFiles.push(projectId)
    },
    syncProject(projectId) {
      fake.syncedProjects.push(projectId)
    },
    disconnectUser(projectId, userId, code) {
      fake.disconnected.push({ projectId, userId, code })
    },
    disconnectSessions(tokenHashes, code) {
      fake.sessionCloses.push({ tokenHashes: [...tokenHashes], code })
      const closing = new Set(tokenHashes)
      const before = fake.liveSessions.length
      fake.liveSessions = fake.liveSessions.filter(h => !closing.has(h))
      return before - fake.liveSessions.length
    },
    openSessions() {
      return [...fake.liveSessions]
    },
    closeProject(projectId, code) {
      fake.closed.push({ projectId, code })
    },
    async shutdown() {},
    eventsOf(projectId, type) {
      return fake.events.filter(e => e.projectId === projectId && (!type || e.event.type === type)).map(e => e.event)
    },
  }
  return fake
}

export interface FakeCompile extends CompileService { deleted: string[] }

export function createFakeCompile(): FakeCompile {
  const fake: FakeCompile = {
    deleted: [],
    async compile(): Promise<CompileResponse> {
      throw new Error('fake compile: not implemented')
    },
    async stop() {},
    async clearCache() {},
    async lastBuild() {
      return null
    },
    resolveBuildFile() {
      return null
    },
    async wordCount() {
      throw new Error('fake compile: not implemented')
    },
    async renderPreview() {
      throw new Error('fake compile: not implemented')
    },
    async deleteProject(projectId) {
      fake.deleted.push(projectId)
    },
    async info() {
      return { runner: 'fake', image: 'texlive/texlive:latest-full', texLive: 'TeX Live 2026', dockerOk: true }
    },
    async shutdown() {},
  }
  return fake
}

export interface FakeHistory extends HistoryService {
  inits: string[]
  activity: { projectId: string; userId: string | null }[]
  copies: { from: string; to: string }[]
  deletedProjects: string[]
  snapshots: { projectId: string; reason: HistoryReason }[]
  /** snapshotBeforeDelete calls, in order */
  beforeDelete: { projectId: string; paths: string[]; replace: boolean }[]
  /** make snapshotBeforeDelete fail (the delete must then be refused) */
  failBeforeDelete: Error | null
  failCopy: boolean
}

export function createFakeHistory(): FakeHistory {
  const unsupported = async (): Promise<never> => {
    throw new Error('fake history: not implemented')
  }
  const fake: FakeHistory = {
    inits: [],
    activity: [],
    copies: [],
    deletedProjects: [],
    snapshots: [],
    beforeDelete: [],
    failBeforeDelete: null,
    failCopy: false,
    async init(projectId) {
      fake.inits.push(projectId)
    },
    noteActivity(projectId, userId) {
      fake.activity.push({ projectId, userId })
    },
    async snapshot(projectId, reason) {
      fake.snapshots.push({ projectId, reason })
      return null
    },
    async snapshotBeforeDelete(projectId, paths, opts) {
      fake.beforeDelete.push({ projectId, paths: [...paths], replace: opts?.replace === true })
      if (fake.failBeforeDelete) throw fake.failBeforeDelete
      return null
    },
    list: unsupported,
    files: unsupported,
    fileAt: unsupported,
    diff: unsupported,
    restore: unsupported,
    createLabel: unsupported as () => Promise<Label>,
    async deleteLabel() {},
    archive: unsupported,
    async deleteProject(projectId) {
      fake.deletedProjects.push(projectId)
    },
    async copyProject(from, to) {
      if (fake.failCopy) throw new Error('copy not supported')
      fake.copies.push({ from, to })
    },
    async shutdown() {},
  }
  return fake
}

export function createFakeSynctex(): SynctexService {
  return {
    async codeToPdf() {
      return { pdf: [] }
    },
    async pdfToCode() {
      return { code: [] }
    },
  }
}

export interface TestContext {
  services: Services
  collab: FakeCollab
  meta: FakeMeta
  compile: FakeCompile
  history: FakeHistory
  dataDir: string
  cleanup(): Promise<void>
}

/** Services on a fresh temp DATA_DIR (real db + FileService, fake everything else). */
export async function createTestServices(env: Record<string, string> = {}): Promise<TestContext> {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-foundation-'))
  const config = loadConfig({ DATA_DIR: dataDir, NODE_ENV: 'test', COMPILE_RUNNER: 'fake', ...env })
  for (const d of Object.values(config.dirs)) fs.mkdirSync(d, { recursive: true })
  const db = openDb(config.dbFile)
  const services = { config, db } as Services
  services.files = createFileService(services)
  const collab = createFakeCollab(services)
  const meta = createFakeMeta()
  const compile = createFakeCompile()
  const history = createFakeHistory()
  services.collab = collab
  services.meta = meta
  services.compile = compile
  services.history = history
  services.synctex = createFakeSynctex()
  return {
    services, collab, meta, compile, history, dataDir,
    async cleanup() {
      try {
        db.close()
      } catch {
        /* already closed */
      }
      await fsp.rm(dataDir, { recursive: true, force: true })
    },
  }
}

/** Entry lookup helper for assertions. */
export function byPath(files: FileEntry[], p: string): FileEntry | undefined {
  return files.find(f => f.path === p)
}
