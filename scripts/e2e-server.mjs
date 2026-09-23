#!/usr/bin/env node
/**
 * Start a throw-away Folio server for the Playwright suite (playwright.config.ts → webServer).
 *
 *   1. web app: build web/dist when it is missing or older than web/ + shared/ sources
 *      (E2E_WEB_DIST=<dir> builds/serves another directory; E2E_BUILD=never|always|auto)
 *   2. fresh DATA_DIR in the OS temp dir (E2E_DATA_DIR=<dir> to keep one; removed on exit otherwise)
 *   3. accounts through the CLI before the server starts: alice (admin), bob, carol — password
 *      "folio-pass-123"; the real paper ../antiddos_v2.tex is seeded as "AntiDDoS Shield v2"
 *      (XeLaTeX + xr supplement) when present (E2E_PAPER=0 skips it)
 *   4. server on E2E_PORT / PORT (default 3199), COMPILE_RUNNER from env (default docker),
 *      NODE_ENV=production (the server serves the built web app, like `npm start`); it never reads
 *      the developer's .env (FOLIO_ENV_FILE=none) and PUBLIC_ORIGIN is removed from its environment
 *   5. through the API: an "Example" project; bob = editor and carol = viewer on every project
 *      E2E_EMPTY=1 skips steps 3 and 5: an instance without accounts (first-run /setup)
 *   6. prints `FOLIO_E2E_READY <state.json>`; Playwright's webServer.wait exposes the path as
 *      process.env.FOLIO_E2E_STATE (read by e2e/global-setup.ts and e2e/helpers.ts)
 *
 * SIGTERM/SIGINT stop the server gracefully (it reaps its compile containers) and clean up.
 * Also usable by hand: `node scripts/e2e-server.mjs` then point a browser at the printed URL.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const PASSWORD = 'folio-pass-123'
const USERS = [
  { key: 'alice', email: 'alice@example.com', name: 'Alice Admin', admin: true },
  { key: 'bob', email: 'bob@example.com', name: 'Bob Editor', admin: false },
  { key: 'carol', email: 'carol@example.com', name: 'Carol Viewer', admin: false },
]
const port = Number(process.env.E2E_PORT ?? process.env.PORT ?? 3199)
const runner = process.env.COMPILE_RUNNER ?? 'docker'
const webDist = path.resolve(ROOT, process.env.E2E_WEB_DIST ?? 'web/dist')
const buildMode = process.env.E2E_BUILD ?? 'auto'
const keepData = !!process.env.E2E_DATA_DIR
const dataDir = process.env.E2E_DATA_DIR ? path.resolve(process.env.E2E_DATA_DIR) : fs.mkdtempSync(path.join(os.tmpdir(), 'folio-e2e-'))
const paperDir = path.resolve(ROOT, '..')
const empty = process.env.E2E_EMPTY === '1'
const withPaper = !empty && process.env.E2E_PAPER !== '0' && fs.existsSync(path.join(paperDir, 'antiddos_v2.tex'))
const tsx = path.join(ROOT, 'node_modules/.bin/tsx')
const base = `http://127.0.0.1:${port}`

const say = msg => process.stdout.write(`[e2e-server] ${msg}\n`)

// ---------------------------------------------------------------------------
// 1. web app
// ---------------------------------------------------------------------------

function newestMtime(p) {
  let st
  try {
    st = fs.statSync(p)
  } catch {
    return 0
  }
  if (!st.isDirectory()) return st.mtimeMs
  let newest = 0
  for (const name of fs.readdirSync(p)) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue
    newest = Math.max(newest, newestMtime(path.join(p, name)))
  }
  return newest
}

function ensureWebBuild() {
  const index = path.join(webDist, 'index.html')
  const built = fs.existsSync(index) ? fs.statSync(index).mtimeMs : 0
  const sources = Math.max(
    newestMtime(path.join(ROOT, 'web/src')), newestMtime(path.join(ROOT, 'web/public')),
    newestMtime(path.join(ROOT, 'web/index.html')), newestMtime(path.join(ROOT, 'web/vite.config.ts')),
    newestMtime(path.join(ROOT, 'shared/src')),
  )
  const stale = !built || sources > built
  if (buildMode === 'never' || (buildMode === 'auto' && !stale)) {
    if (!built) throw new Error(`${index} does not exist; run \`npm run build\` or drop E2E_BUILD=never`)
    say(`web app: using ${webDist}${stale ? ' (older than the sources; E2E_BUILD=never)' : ''}`)
    return
  }
  say(`web app: building into ${webDist} (${built ? 'sources changed' : 'not built yet'})…`)
  // build next to the target and swap it in only on success: a failed build keeps the previous one
  const tmpOut = `${webDist}.building-${process.pid}`
  fs.rmSync(tmpOut, { recursive: true, force: true })
  const r = spawnSync(path.join(ROOT, 'node_modules/.bin/vite'), ['build', '--config', 'web/vite.config.ts', '--outDir', tmpOut, '--emptyOutDir', '--logLevel', 'warn'], {
    cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'], env: process.env,
  })
  if (r.status !== 0 || !fs.existsSync(path.join(tmpOut, 'index.html'))) {
    fs.rmSync(tmpOut, { recursive: true, force: true })
    if (built && buildMode === 'auto') {
      say('WARNING: the web build failed; testing the previous build instead')
      return
    }
    throw new Error('the web build failed')
  }
  const old = `${webDist}.old-${process.pid}`
  if (fs.existsSync(webDist)) fs.renameSync(webDist, old)
  fs.mkdirSync(path.dirname(webDist), { recursive: true })
  fs.renameSync(tmpOut, webDist)
  fs.rmSync(old, { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// 2–3. data dir, accounts, paper
// ---------------------------------------------------------------------------

// FOLIO_ENV_FILE=none: the server and the CLI tools ignore the developer's .env — a variable
// deleted below would otherwise be filled in again from that file (PUBLIC_ORIGIN, ALLOW_SIGNUP…)
const env = {
  ...process.env,
  FOLIO_ENV_FILE: 'none',
  DATA_DIR: dataDir,
  PORT: String(port),
  HOST: '127.0.0.1',
  COMPILE_RUNNER: runner,
  NODE_ENV: 'production',
  WEB_DIST: webDist,
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
}
delete env.PUBLIC_ORIGIN

function cli(script, args) {
  const run = () => spawnSync(tsx, [path.join(ROOT, 'server/src/cli', script), ...args], { cwd: ROOT, env, encoding: 'utf8' })
  let r = run()
  // a CLI that crashed (killed by a signal, or tsx relaying its child's signal as 128+n) before
  // printing anything is retried once — seen: sporadic SIGSEGVs of node on a flaky host; a CLI
  // that ran and failed is not retried
  const crashed = x => (x.signal !== null || (x.status !== null && x.status > 128)) && !x.stdout
  if (crashed(r)) {
    say(`${script} crashed (${r.signal ?? `exit ${r.status}`}); retrying once`)
    r = run()
  }
  if (r.status !== 0) throw new Error(`${script} failed (${r.signal ?? `exit ${r.status}`}):\n${r.stdout}\n${r.stderr}`)
  return r.stdout
}

let server = null
let stopping = false

function cleanup() {
  if (!keepData) {
    try {
      fs.rmSync(dataDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}

function stop(signal) {
  if (stopping) return
  stopping = true
  if (!server || server.exitCode !== null) {
    cleanup()
    process.exit(0)
  }
  say(`stopping the server (${signal})…`)
  server.once('exit', () => {
    cleanup()
    process.exit(0)
  })
  server.kill('SIGTERM')
  setTimeout(() => server.kill('SIGKILL'), 40_000).unref()
}
process.on('SIGTERM', () => stop('SIGTERM'))
process.on('SIGINT', () => stop('SIGINT'))
process.on('SIGHUP', () => stop('SIGHUP'))

async function waitFor(url, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (server?.exitCode !== null && server?.exitCode !== undefined) throw new Error(`the server exited (code ${server.exitCode}); see ${path.join(dataDir, 'server.log')}`)
    try {
      const r = await fetch(url)
      if (r.ok) return
    } catch {
      /* not up yet */
    }
    await new Promise(r => setTimeout(r, 200))
  }
  throw new Error(`timed out waiting for ${url}`)
}

async function login(email) {
  const r = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Folio-Csrf': '1', Origin: base },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!r.ok) throw new Error(`login ${email}: ${r.status} ${await r.text()}`)
  const cookie = r.headers.get('set-cookie').split(';')[0]
  return async (method, p, body) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { cookie, 'X-Folio-Csrf': '1', Origin: base, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    })
    const text = await res.text()
    if (!res.ok) throw new Error(`${method} ${p}: ${res.status} ${text}`)
    return text ? JSON.parse(text) : null
  }
}

async function main() {
  ensureWebBuild()
  fs.mkdirSync(dataDir, { recursive: true })
  const fresh = !fs.existsSync(path.join(dataDir, 'db.sqlite'))
  if (fresh && !empty) {
    for (const u of USERS) cli('create-user.ts', ['--email', u.email, '--name', u.name, '--password', PASSWORD, ...(u.admin ? ['--admin'] : [])])
    if (withPaper) {
      cli('seed.ts', ['--src', paperDir, '--owner', USERS[0].email, '--name', 'AntiDDoS Shield v2', '--main', 'antiddos_v2.tex',
        '--compiler', 'xelatex', '--external', 'antiddos_v2_supplementary.tex'])
    }
  }

  const log = fs.openSync(path.join(dataDir, 'server.log'), 'a')
  server = spawn(tsx, [path.join(ROOT, 'server/src/main.ts')], { cwd: ROOT, env, stdio: ['ignore', log, log] })
  server.on('exit', code => {
    if (!stopping) {
      say(`the server exited unexpectedly (code ${code}); log: ${path.join(dataDir, 'server.log')}`)
      cleanup()
      process.exit(1)
    }
  })
  await waitFor(`${base}/healthz`, 60_000)

  const alice = empty ? null : await login(USERS[0].email)
  let projects = alice ? await alice('GET', '/api/projects') : []
  if (fresh && alice) {
    await alice('POST', '/api/projects', { name: 'Example', template: 'example' })
    projects = await alice('GET', '/api/projects')
    for (const p of projects) {
      await alice('POST', `/api/projects/${p.id}/members`, { email: USERS[1].email, role: 'editor' })
      await alice('POST', `/api/projects/${p.id}/members`, { email: USERS[2].email, role: 'viewer' })
    }
  }
  const byName = name => projects.find(p => p.name === name)?.id ?? null
  const state = {
    base,
    dataDir,
    webDist,
    runner,
    password: PASSWORD,
    users: empty ? {} : Object.fromEntries(USERS.map(u => [u.key, { email: u.email, name: u.name, admin: u.admin }])),
    projects: { paper: byName('AntiDDoS Shield v2'), example: byName('Example') },
    serverLog: path.join(dataDir, 'server.log'),
  }
  const statePath = path.join(dataDir, 'e2e-state.json')
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2))
  say(`${base} ready (runner ${runner}, data ${dataDir}${withPaper ? ', paper seeded' : ''})`)
  // Playwright's webServer.wait picks this line up (FOLIO_E2E_STATE)
  process.stdout.write(`FOLIO_E2E_READY ${statePath}\n`)
}

main().catch(err => {
  process.stderr.write(`[e2e-server] ${err.stack ?? err}\n`)
  if (server && server.exitCode === null) {
    stopping = true
    server.once('exit', () => {
      cleanup()
      process.exit(1)
    })
    server.kill('SIGTERM')
  } else {
    cleanup()
    process.exit(1)
  }
})
