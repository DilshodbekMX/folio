/**
 * Folio server entry point (SPEC §4.1): config → data dirs → db → service container →
 * Express app + WebSocket upgrade routing on one http.Server → graceful shutdown.
 *
 * After listening: startup banner (URL, data dir, compiler), a background Docker/TeX image check,
 * the history recovery snapshot (work trees that differ from HEAD after a crash) and the
 * maintenance timers (maintenance.ts: session/socket sweeps, build retention, idle compile dirs,
 * temp files).
 *
 * Before listening: the users of history windows left pending by the previous process are read
 * (history.loadPendingAuthors), so a collaborator reconnecting at once cannot overwrite them.
 *
 * Shutdown (SIGINT/SIGTERM): stop accepting connections → collab.flushProject for every project
 * with activity since boot (live documents on disk first: fast, and nothing the server
 * acknowledged is lost even if the process is killed during the slower git work) →
 * history.snapshot('shutdown') for each of them → history.shutdown (flushes pending idle
 * snapshots through collab) → collab.shutdown → meta.shutdown → compile.shutdown (kills running
 * compile containers; orphans from a crash are reaped by the compile service on construction) →
 * db.close. Every step has its own time limit, so one stuck project cannot skip the others.
 * The same signal delivered twice within 3 s (`npm run dev`: the terminal and tsx watch /
 * concurrently both deliver Ctrl+C) is ignored; a later second signal, or 30 s, force the exit
 * (closing the database first, which checkpoints its WAL).
 */
// must stay the first import: loads .env before config/log read process.env
import { ENV_FILE, envFileLoaded } from './env.ts'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'
import { compileUserProblem, loadConfig, type Config } from './config.ts'
import { openDb } from './db/index.ts'
import type { HistoryService, Services } from './services.ts'
import { createFileService } from './files/service.ts'
import { createCollabService, createMetaService } from './collab/index.ts'
import { createCompileService } from './compile/index.ts'
import { createSynctexService } from './synctex/index.ts'
import { createHistoryService } from './history/index.ts'
import { createApp } from './http/app.ts'
import { createUpgradeHandler } from './http/upgrade.ts'
import { log, moduleLog } from './log.ts'
import { startMaintenance } from './maintenance.ts'

const SHUTDOWN_TIMEOUT_MS = 30_000
/** a repeat of the signal within this window is the same Ctrl+C delivered twice, not "hurry up" */
const DUPLICATE_SIGNAL_MS = 3_000
/** time limit of one shutdown step (a project's snapshot, a service's shutdown) */
const STEP_TIMEOUT_MS = 10_000
/** stale upload / import / atomic-write temp files are removed at boot */
const TMP_MAX_AGE_MS = 60 * 60 * 1000

function ensureDataDirs(config: Config): void {
  if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
  for (const dir of Object.values(config.dirs)) fs.mkdirSync(dir, { recursive: true })
}

async function cleanTmp(tmpDir: string): Promise<void> {
  const now = Date.now()
  for (const name of await fsp.readdir(tmpDir).catch(() => [] as string[])) {
    const p = path.join(tmpDir, name)
    try {
      const st = await fsp.lstat(p)
      if (now - st.mtimeMs > TMP_MAX_AGE_MS) await fsp.rm(p, { recursive: true, force: true })
    } catch {
      /* raced with another cleaner */
    }
  }
}

/**
 * Wrap the history service so every `noteActivity` (file operations and collaborative edits)
 * also records the project as dirty for the shutdown snapshot.
 */
function trackActivity(history: HistoryService, dirty: Set<string>): HistoryService {
  const noteActivity: HistoryService['noteActivity'] = (projectId, userId) => {
    dirty.add(projectId)
    history.noteActivity(projectId, userId)
  }
  return new Proxy(history, {
    get(target, prop) {
      if (prop === 'noteActivity') return noteActivity
      const v = Reflect.get(target, prop, target)
      return typeof v === 'function' ? v.bind(target) : v
    },
  })
}

function listen(server: http.Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') reject(new Error(`Port ${port} on ${host} is already in use — is Folio already running? Set PORT to use another port.`))
      else if (err.code === 'EACCES') reject(new Error(`Not allowed to listen on ${host}:${port} — choose a PORT above 1024.`))
      else reject(err)
    }
    server.once('error', onError)
    server.listen(port, host, () => {
      server.off('error', onError)
      resolve()
    })
  })
}

/** URL a person should open: the Vite dev server under `npm run dev`, else this server. */
function browserUrl(config: Config, origin: string): { url: string; note: string | null } {
  if (process.env.npm_lifecycle_event === 'dev:server' || process.env.FOLIO_DEV_WEB) {
    const web = process.env.FOLIO_DEV_WEB ?? `http://127.0.0.1:${process.env.VITE_PORT || 5173}`
    return { url: web, note: `the Vite dev server (hot reload); the API runs on ${origin}` }
  }
  if (!fs.existsSync(path.join(config.webDist, 'index.html'))) {
    return { url: origin, note: `the web app is not built yet: run \`npm run build\` (or use \`npm run dev\`)` }
  }
  return { url: origin, note: null }
}

function printBanner(config: Config, origin: string): void {
  const { url, note } = browserUrl(config, origin)
  const runner = config.compile.runner === 'docker' ? `docker · ${config.compile.image}` : config.compile.runner === 'local' ? 'local latexmk (not sandboxed)' : 'fake (tests only)'
  const fields = {
    url, api: origin, dataDir: config.dataDir, runner: config.compile.runner, env: config.env, version: config.version,
    envFile: envFileLoaded ? ENV_FILE : null,
  }
  if (config.env === 'production' && !process.stdout.isTTY) {
    // JSON log lines only (log collectors); the box below is for people
    log.info(fields, `Folio ${config.version} ready at ${url}`)
    return
  }
  log.debug(fields, 'listening')
  const lines = [
    `Folio ${config.version} is running`,
    '',
    `  Open        ${url}`,
    ...(note ? [`              (${note})`] : []),
    `  Data        ${config.dataDir}`,
    ...(envFileLoaded ? [`  Settings    ${ENV_FILE}`] : []),
    `  Compiler    ${runner}`,
    `  Mode        ${config.env}`,
  ]
  const width = Math.max(...lines.map(l => l.length)) + 4
  const bar = '─'.repeat(width)
  process.stdout.write(`\n┌${bar}┐\n${lines.map(l => `│  ${l.padEnd(width - 2)}│`).join('\n')}\n└${bar}┘\n\n`)
}

/** Warn early (not at the first compile) when Docker or the TeX image is unusable. */
async function checkCompiler(services: Services): Promise<void> {
  if (services.config.compile.runner !== 'docker') return
  try {
    const info = await services.compile.info()
    if (info.dockerOk) log.info({ texLive: info.texLive, image: info.image }, `compiler ready: ${info.texLive ?? 'TeX Live'} in ${info.image}`)
    else log.warn({ image: info.image }, `Docker or the image ${info.image} is not available — compiles will fail until it is fixed (run \`npm run doctor\`)`)
  } catch (err) {
    log.warn({ err }, 'could not check the compiler')
  }
}

/**
 * One shutdown step, bounded in time: a step that never settles (a stuck project) is abandoned
 * after `timeoutMs` and the shutdown goes on. The timer also keeps the process alive while it
 * waits (the forced-exit timer does not).
 */
async function step(name: string, fn: () => unknown, timeoutMs = STEP_TIMEOUT_MS): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  try {
    await Promise.race([
      Promise.resolve().then(fn),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`did not finish within ${timeoutMs / 1000} s`)), timeoutMs)
      }),
    ])
  } catch (err) {
    log.error({ err }, `shutdown: ${name} failed`)
  } finally {
    clearTimeout(timer)
  }
}

export async function main(): Promise<void> {
  const config = loadConfig()
  const userProblem = compileUserProblem(config)
  if (userProblem?.fatal) throw new Error(userProblem.message)
  if (userProblem) log.warn(userProblem.message)
  ensureDataDirs(config)
  await cleanTmp(config.dirs.tmp)
  const db = openDb(config.dbFile)
  db.sessions.purgeExpired()

  const services = { config, db } as Services
  const dirty = new Set<string>()
  services.files = createFileService(services)
  services.collab = createCollabService(services, { logger: moduleLog('collab') })
  services.meta = createMetaService(services, { logger: moduleLog('meta') })
  services.compile = createCompileService(services)
  services.synctex = createSynctexService(services)
  const history = createHistoryService(services)
  services.history = trackActivity(history, dirty)
  services.collab.onDocChanged(e => dirty.add(e.projectId))
  // before anyone can connect: the authors of windows the previous process left pending
  await history.loadPendingAuthors()

  const app = createApp(services)
  const server = http.createServer(app)
  server.on('upgrade', createUpgradeHandler(services))
  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    else socket.destroy()
  })
  await listen(server, config.port, config.host)
  const displayHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host
  const origin = config.publicOrigin ?? `http://${displayHost.includes(':') ? `[${displayHost}]` : displayHost}:${config.port}`
  printBanner(config, origin)
  if (db.users.count() === 0) log.info(`No accounts yet: open ${browserUrl(config, origin).url}/setup to create the administrator`)
  void checkCompiler(services)
  // edits saved to disk but never snapshotted before a crash / kill: commit them now
  void history.recoverAfterRestart().then(n => {
    if (n > 0) log.info({ projects: n }, 'history: committed edits left from before the restart')
  }, err => log.warn({ err }, 'history recovery failed'))

  const maintenance = startMaintenance(services)

  let shuttingDown = false
  let firstSignalAt = 0
  /** exit now; closing the database first checkpoints its WAL into db.sqlite */
  const forceExit = (message: string) => {
    log.error(message)
    try {
      db.close()
    } catch {
      // already closed, or busy: SQLite recovers the WAL on the next start
    }
    process.exit(1)
  }
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      // Ctrl+C under `npm run dev` arrives twice within milliseconds (terminal + tsx watch)
      if (Date.now() - firstSignalAt < DUPLICATE_SIGNAL_MS) {
        log.debug({ signal }, 'repeated signal ignored: already shutting down')
        return
      }
      forceExit(`second ${signal}: exiting immediately`)
      return
    }
    shuttingDown = true
    firstSignalAt = Date.now()
    log.info({ signal }, 'shutting down')
    const force = setTimeout(() => forceExit('shutdown timed out; forcing exit'), SHUTDOWN_TIMEOUT_MS)
    force.unref()
    maintenance.stop()

    server.close()
    server.closeIdleConnections()
    const projects = [...dirty].filter(pid => db.projects.get(pid))
    // live documents to disk first (text + CRDT state): quick, and what the server acknowledged
    // survives even if the process is killed during the git snapshots below
    await step('collab.flushProject', () => Promise.all(projects.map(pid => services.collab.flushProject(pid).catch(err => {
      log.warn({ err, projectId: pid }, 'shutdown: could not save the open documents of a project')
    }))))
    for (const projectId of projects) {
      await step(`history.snapshot(${projectId})`, () => services.history.snapshot(projectId, 'shutdown'))
    }
    // history before collab: its pending idle snapshots flush live docs through collab
    await step('history.shutdown', () => services.history.shutdown())
    await step('collab.shutdown', () => services.collab.shutdown())
    await step('meta.shutdown', () => services.meta.shutdown())
    await step('compile.shutdown', () => services.compile.shutdown(), 20_000)
    server.closeAllConnections()
    await step('db.close', () => db.close())
    clearTimeout(force)
    log.info('bye')
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

process.on('unhandledRejection', err => {
  log.error({ err }, 'unhandled promise rejection')
})

main().catch(err => {
  log.fatal({ err }, 'failed to start')
  process.exit(1)
})
