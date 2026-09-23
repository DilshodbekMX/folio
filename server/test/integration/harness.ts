/**
 * The whole server in-process, wired exactly like main.ts (real db, files, collab, meta, compile,
 * synctex, history, http app and upgrade router) on a temp DATA_DIR. Compiles use the fake runner
 * (fixture PDF) unless COMPILE_RUNNER is overridden; the SyncTeX CLI fallback is disabled.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { AddressInfo } from 'node:net'
import { loadConfig } from '../../src/config.ts'
import { openDb, type UserRecord } from '../../src/db/index.ts'
import type { Services } from '../../src/services.ts'
import { createFileService } from '../../src/files/service.ts'
import { createCollabService, createMetaService, type CollabOptions } from '../../src/collab/index.ts'
import { createCompileService } from '../../src/compile/index.ts'
import { createSynctexService } from '../../src/synctex/index.ts'
import { createHistoryService, type HistoryServiceOptions } from '../../src/history/index.ts'
import { createApp } from '../../src/http/app.ts'
import { createUpgradeHandler } from '../../src/http/upgrade.ts'
import { hashPassword } from '../../src/auth/passwords.ts'

export const quietLogger = { debug() {}, info() {}, warn() {}, error() {} }

export interface FullServer {
  base: string
  services: Services
  dataDir: string
  server: http.Server
  makeUser(email: string, name?: string, isAdmin?: boolean): Promise<UserRecord>
  close(): Promise<void>
}

let pwHash: Promise<string> | null = null
export const FULL_PASSWORD = 'integration-pass-1'

export interface FullServerOptions {
  /** timings of the collaboration service (defaults: production values) */
  collab?: Partial<Omit<CollabOptions, 'logger'>>
  /** timings of the history service (defaults: production values) */
  history?: HistoryServiceOptions
}

export async function startFullServer(env: Record<string, string> = {}, opts: FullServerOptions = {}): Promise<FullServer> {
  const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-full-'))
  const config = loadConfig({ DATA_DIR: dataDir, NODE_ENV: 'test', COMPILE_RUNNER: 'fake', ...env })
  for (const d of Object.values(config.dirs)) fs.mkdirSync(d, { recursive: true })
  const db = openDb(config.dbFile)
  const services = { config, db } as Services
  services.files = createFileService(services)
  services.collab = createCollabService(services, { ...opts.collab, logger: quietLogger })
  services.meta = createMetaService(services, { logger: quietLogger })
  services.compile = createCompileService(services, { namePrefix: 'folio-it-', reapOnStart: false })
  services.synctex = createSynctexService(services, { runCli: null })
  services.history = createHistoryService(services, opts.history)
  const server = http.createServer(createApp(services))
  server.on('upgrade', createUpgradeHandler(services))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    services,
    dataDir,
    server,
    async makeUser(email, name = email.split('@')[0], isAdmin = false) {
      pwHash ??= hashPassword(FULL_PASSWORD)
      return db.users.create({ email, name, passwordHash: await pwHash, isAdmin })
    },
    async close() {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await services.history.shutdown().catch(() => {})
      await services.collab.shutdown().catch(() => {})
      await services.meta.shutdown().catch(() => {})
      await services.compile.shutdown().catch(() => {})
      db.close()
      await fsp.rm(dataDir, { recursive: true, force: true })
    },
  }
}
