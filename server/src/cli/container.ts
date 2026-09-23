/**
 * Services container for the CLI tools: the real db, FileService and (optionally)
 * HistoryService, with offline stand-ins for the realtime and compile services. The CLI runs
 * while the server is stopped: text files are read/written on disk directly (the collab
 * service reconciles its sidecar state with the disk on the next load).
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { normalizeText } from '@folio/shared/filetypes'
import { loadConfig, type Config } from '../config.ts'
import { openDb } from '../db/index.ts'
import type { CollabService, CompileService, HistoryService, MetaService, Services, SynctexService } from '../services.ts'
import { createFileService } from '../files/service.ts'
import { readFileNoFollow, writeFileAtomic } from '../files/storage.ts'
import { createHistoryService } from '../history/index.ts'

function isSafeId(id: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(id)
}

function offlineCollab(s: Services): CollabService {
  const stateDir = (pid: string) => path.join(s.config.dirs.ystate, pid)
  const edits = new Map<string, number>()
  return {
    handleUpgrade(_req, socket) {
      socket.destroy()
    },
    async getText(projectId, fileId) {
      const f = s.files.get(projectId, fileId)
      if (!f) throw new Error(`file ${fileId} not found`)
      return normalizeText((await readFileNoFollow(s.files.absPath(projectId, f.path))).toString('utf8'))
    },
    async setText(projectId, fileId, text, origin) {
      const f = s.files.get(projectId, fileId)
      if (!f) throw new Error(`file ${fileId} not found`)
      const data = Buffer.from(normalizeText(text), 'utf8')
      edits.set(projectId, (edits.get(projectId) ?? 0) + 1)
      await writeFileAtomic(s.files.projectDir(projectId), s.files.absPath(projectId, f.path), data, s.config.dirs.tmp)
      s.db.files.update(fileId, { size: data.length })
      s.db.projects.touchUpdated(projectId, origin?.userId ?? null)
    },
    async flushProject() {},
    async discardFile(projectId, fileId) {
      if (!isSafeId(projectId) || !isSafeId(fileId)) return
      const dir = stateDir(projectId)
      for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
        if (name.startsWith(`${fileId}.`)) await fsp.rm(path.join(dir, name), { force: true })
      }
    },
    async discardProject(projectId) {
      if (isSafeId(projectId)) await fsp.rm(stateDir(projectId), { recursive: true, force: true })
    },
    disconnectUser() {},
    disconnectSessions() { return 0 },
    openSessions() { return [] },
    onDocChanged() {
      return () => {}
    },
    takeEditors() {
      return []
    },
    editCount(projectId) {
      return edits.get(projectId) ?? 0
    },
    async shutdown() {},
  }
}

function offlineMeta(): MetaService {
  return {
    handleUpgrade(_req, socket) {
      socket.destroy()
    },
    broadcast() {},
    syncFiles() {},
    syncProject() {},
    disconnectUser() {},
    disconnectSessions() { return 0 },
    openSessions() { return [] },
    closeProject() {},
    async shutdown() {},
  }
}

function unavailable(what: string): never {
  throw new Error(`${what} is not available in the command-line tools (start the server)`)
}

function offlineCompile(config: Config): CompileService {
  return {
    compile: async () => unavailable('Compiling'),
    stop: async () => {},
    clearCache: async () => {},
    lastBuild: async () => null,
    resolveBuildFile: () => null,
    wordCount: async () => unavailable('Word count'),
    renderPreview: async () => unavailable('Preview rendering'),
    async deleteProject(projectId) {
      if (!isSafeId(projectId)) return
      await fsp.rm(path.join(config.dirs.compiles, projectId), { recursive: true, force: true })
      await fsp.rm(path.join(config.dirs.builds, projectId), { recursive: true, force: true })
      await fsp.rm(path.join(config.dirs.previews, projectId), { recursive: true, force: true })
    },
    info: async () => ({ runner: config.compile.runner, image: config.compile.image, texLive: null, dockerOk: false }),
    shutdown: async () => {},
  }
}

function offlineSynctex(): SynctexService {
  return {
    codeToPdf: async () => unavailable('SyncTeX'),
    pdfToCode: async () => unavailable('SyncTeX'),
  }
}

function noopHistory(): HistoryService {
  return {
    init: async () => {},
    noteActivity: () => {},
    snapshot: async () => null,
    snapshotBeforeDelete: async () => null,
    list: async () => unavailable('History'),
    files: async () => unavailable('History'),
    fileAt: async () => unavailable('History'),
    diff: async () => unavailable('History'),
    restore: async () => unavailable('History'),
    createLabel: async () => unavailable('History'),
    deleteLabel: async () => unavailable('History'),
    archive: async () => unavailable('History'),
    deleteProject: async () => {},
    copyProject: async () => {},
    shutdown: async () => {},
  }
}

export interface CliServices {
  services: Services
  close(): Promise<void>
}

/** Open the data directory and build the CLI container. `history: true` uses the real git history. */
export function openCliServices(opts: { history?: boolean; env?: NodeJS.ProcessEnv } = {}): CliServices {
  const config = loadConfig(opts.env)
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  for (const dir of Object.values(config.dirs)) fs.mkdirSync(dir, { recursive: true })
  const db = openDb(config.dbFile)
  const services = { config, db } as Services
  services.files = createFileService(services)
  services.collab = offlineCollab(services)
  services.meta = offlineMeta()
  services.compile = offlineCompile(config)
  services.synctex = offlineSynctex()
  services.history = opts.history ? createHistoryService(services) : noopHistory()
  return {
    services,
    async close() {
      try {
        await services.history.shutdown()
      } finally {
        db.close()
      }
    },
  }
}

/** true when something accepts TCP connections on the configured server port. */
export function serverSeemsRunning(config: Config, timeoutMs = 500): Promise<boolean> {
  return new Promise(resolve => {
    const host = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host
    const socket = net.connect({ host, port: config.port })
    const done = (v: boolean) => {
      socket.destroy()
      resolve(v)
    }
    socket.setTimeout(timeoutMs, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

