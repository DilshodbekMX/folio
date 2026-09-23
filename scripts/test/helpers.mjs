/**
 * Helpers for the script checks (npm run test:scripts): free ports, a clean child environment,
 * real Folio servers on temporary data directories and a small REST client.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))
export const PASSWORD = 'folio-pass-123'

/** a directory removed by `removeTempDirs()` (call it in afterAll) */
const tempDirs = []
export function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `folio-scripts-${prefix}-`))
  tempDirs.push(dir)
  return dir
}
export function removeTempDirs() {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
}

/** a minimal built web app, so servers start without `npm run build` */
export function dummyWebDist() {
  const dir = tempDir('dist')
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>Folio (test)</title>')
  return dir
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
  })
}

/**
 * The environment of the test process without what would change the scripts' behaviour: Vitest's
 * own variables (server/src/env.ts never reads an env file under VITEST / NODE_ENV=test, which
 * would make every isolation check pass vacuously) and Folio settings of the developer's shell.
 */
export function cleanEnv(extra = {}) {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (/^(VITEST|NODE_ENV$|TEST$|FOLIO_|PORT$|HOST$|VITE_PORT$|PUBLIC_ORIGIN$|DATA_DIR$|ALLOW_SIGNUP$|COMPILE_|WEB_DIST$|E2E_|npm_)/.test(key)) delete env[key]
  }
  return { ...env, ...extra }
}

/** write an env file (KEY=value lines) and return its path */
export function envFile(vars) {
  const file = path.join(tempDir('env'), 'folio.env')
  fs.writeFileSync(file, Object.entries(vars).map(([k, v]) => `${k}=${v}`).join('\n') + '\n')
  return file
}

export async function waitFor(check, ms, what) {
  const end = Date.now() + ms
  for (;;) {
    try {
      if (await check()) return
    } catch {
      /* not yet */
    }
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 150))
  }
}

export const healthy = base => waitFor(async () => (await fetch(`${base}/healthz`)).ok, 60_000, `${base}/healthz`)

/**
 * Start a Folio server the way the README's service unit does (`node --import tsx
 * server/src/main.ts`), on `dataDir`, with the fake compile runner and no env file.
 */
export async function startServer({ dataDir, port, webDist, env = {} }) {
  const logFile = path.join(path.dirname(dataDir), `server-${path.basename(dataDir)}-${Date.now()}.log`)
  const out = fs.openSync(logFile, 'a')
  const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/main.ts'], {
    cwd: ROOT,
    env: cleanEnv({
      FOLIO_ENV_FILE: 'none', NODE_ENV: 'production', DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1',
      COMPILE_RUNNER: 'fake', WEB_DIST: webDist, LOG_LEVEL: 'warn', ...env,
    }),
    stdio: ['ignore', out, out],
  })
  fs.closeSync(out)
  const base = `http://127.0.0.1:${port}`
  let exited = null
  child.once('exit', (code, signal) => { exited = { code, signal } })
  await waitFor(async () => {
    if (exited) throw new Error(`server exited early (${JSON.stringify(exited)}):\n${fs.readFileSync(logFile, 'utf8')}`)
    return (await fetch(`${base}/healthz`)).ok
  }, 60_000, `${base}/healthz`).catch(err => {
    child.kill('SIGKILL')
    throw new Error(`${err.message}\n${fs.readFileSync(logFile, 'utf8')}`)
  })
  const stopped = new Promise(resolve => {
    if (exited) resolve(exited)
    else child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  return {
    base,
    child,
    logFile,
    log: () => fs.readFileSync(logFile, 'utf8'),
    /** SIGTERM and wait: the graceful shutdown */
    stop: () => { child.kill('SIGTERM'); return stopped },
    /** SIGKILL and wait: a crash (no shutdown, the database is not closed) */
    kill: () => { child.kill('SIGKILL'); return stopped },
  }
}

/** a REST session: `api(method, path, body?)` → parsed JSON; sends the CSRF header and Origin */
export async function session(base, { email, password = PASSWORD, name, setup = false }) {
  const headers = { 'content-type': 'application/json', 'X-Folio-Csrf': '1', Origin: base }
  const r = await fetch(`${base}/api/auth/${setup ? 'setup' : 'login'}`, {
    method: 'POST', headers, body: JSON.stringify(setup ? { email, password, name } : { email, password }),
  })
  if (!r.ok) throw new Error(`${setup ? 'setup' : 'login'} ${email}: ${r.status} ${await r.text()}`)
  const setCookie = r.headers.get('set-cookie')
  const cookie = setCookie.split(';')[0]
  const api = async (method, p, body) => {
    const res = await fetch(`${base}${p}`, { method, headers: { ...headers, cookie }, body: body ? JSON.stringify(body) : undefined })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
  return { api, setCookie }
}

/**
 * run a shell command line (as printed in the README) with `sh -c` in `cwd`; throws on failure.
 * HOME is `cwd`, so a `~/…` path in a command can never touch the real home directory.
 */
export function sh(command, cwd) {
  const r = spawnSync('sh', ['-c', command], { cwd, encoding: 'utf8', env: { ...process.env, HOME: cwd } })
  if (r.status !== 0) throw new Error(`\`${command}\` failed (${r.status}):\n${r.stdout}\n${r.stderr}`)
  return r.stdout
}

export const hasCommand = name => spawnSync('sh', ['-c', `command -v ${name}`], { stdio: 'ignore' }).status === 0
