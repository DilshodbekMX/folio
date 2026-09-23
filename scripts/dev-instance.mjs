#!/usr/bin/env node
/**
 * Start an isolated Folio instance for development/testing (own data dir, own ports).
 *
 *   node scripts/dev-instance.mjs --name alice --dir /tmp/folio-i/alice --port 3310 [--vite-port 5310]
 *                                 [--runner docker|fake] [--no-paper] [--fresh]
 *   node scripts/dev-instance.mjs --stop --dir /tmp/folio-i/alice
 *
 * First start creates users (password "folio-pass-123"):
 *   alice@example.com (admin, owner), bob@example.com (editor on seeded projects),
 *   carol@example.com (viewer on seeded projects)
 * and projects: "AntiDDoS Shield v2" (the real paper in ../, XeLaTeX + xr external doc) and "Example".
 * Writes <dir>/instance.json with URLs, user credentials and project ids.
 * The instance never reads the developer's .env (FOLIO_ENV_FILE=none), nor PUBLIC_ORIGIN from the shell.
 */
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const PASSWORD = 'folio-pass-123'
const USERS = [
  { email: 'alice@example.com', name: 'Alice Admin', admin: true },
  { email: 'bob@example.com', name: 'Bob Editor', admin: false },
  { email: 'carol@example.com', name: 'Carol Viewer', admin: false },
]

function parse(argv) {
  const o = { runner: 'docker', paper: true, fresh: false, stop: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--name') o.name = next()
    else if (a === '--dir') o.dir = next()
    else if (a === '--port') o.port = Number(next())
    else if (a === '--vite-port') o.vitePort = Number(next())
    else if (a === '--runner') o.runner = next()
    else if (a === '--no-paper') o.paper = false
    else if (a === '--fresh') o.fresh = true
    else if (a === '--stop') o.stop = true
    else throw new Error(`unknown argument ${a}`)
  }
  if (!o.dir) throw new Error('--dir is required')
  o.dir = path.resolve(o.dir)
  return o
}

const opts = parse(process.argv.slice(2))
const pidFile = path.join(opts.dir, 'pids.json')

function killAll() {
  if (!fs.existsSync(pidFile)) return
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'))
  for (const pid of Object.values(pids)) {
    try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch { /* gone */ } }
  }
  fs.rmSync(pidFile, { force: true })
}

if (opts.stop) {
  killAll()
  console.log(`stopped instance in ${opts.dir}`)
  process.exit(0)
}
if (!opts.port) throw new Error('--port is required')

killAll()
if (opts.fresh) fs.rmSync(path.join(opts.dir, 'data'), { recursive: true, force: true })
const dataDir = path.join(opts.dir, 'data')
fs.mkdirSync(dataDir, { recursive: true })
const firstRun = !fs.existsSync(path.join(dataDir, 'db.sqlite'))
// FOLIO_ENV_FILE=none: the server, the CLI tools and Vite ignore the developer's .env (its
// PUBLIC_ORIGIN, ALLOW_SIGNUP, PORT, limits…); the instance gets exactly the settings below
const env = {
  ...process.env, FOLIO_ENV_FILE: 'none', DATA_DIR: dataDir, PORT: String(opts.port), HOST: '127.0.0.1', COMPILE_RUNNER: opts.runner, NODE_ENV: 'development',
}
delete env.PUBLIC_ORIGIN
// the server's start-up banner then points at the Vite UI instead of the API port
if (opts.vitePort) env.FOLIO_DEV_WEB = `http://127.0.0.1:${opts.vitePort}`
const tsx = path.join(ROOT, 'node_modules/.bin/tsx')

function cli(script, args) {
  const r = spawnSync(tsx, [path.join(ROOT, 'server/src/cli', script), ...args], { cwd: ROOT, env, encoding: 'utf8' })
  if (r.status !== 0) throw new Error(`${script} failed:\n${r.stdout}\n${r.stderr}`)
  return r.stdout
}

let paperNote = null
if (firstRun) {
  for (const u of USERS) cli('create-user.ts', ['--email', u.email, '--name', u.name, '--password', PASSWORD, ...(u.admin ? ['--admin'] : [])])
  if (opts.paper) {
    paperNote = cli('seed.ts', ['--src', path.resolve(ROOT, '..'), '--owner', USERS[0].email, '--name', 'AntiDDoS Shield v2',
      '--main', 'antiddos_v2.tex', '--compiler', 'xelatex', '--external', 'antiddos_v2_supplementary.tex'])
  }
}

function start(label, cmd, args, extraEnv) {
  const out = fs.openSync(path.join(opts.dir, `${label}.log`), 'a')
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...env, ...extraEnv }, stdio: ['ignore', out, out], detached: true })
  child.unref()
  return child.pid
}

async function waitFor(url, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    try {
      const r = await fetch(url)
      if (r.status < 500) return
    } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 300))
  }
  throw new Error(`timed out waiting for ${url}`)
}

const pids = {}
pids.server = start('server', tsx, [path.join(ROOT, 'server/src/main.ts')])
fs.writeFileSync(pidFile, JSON.stringify(pids))
const base = `http://127.0.0.1:${opts.port}`
await waitFor(`${base}/healthz`, 60_000)

async function session(email) {
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

const alice = await session(USERS[0].email)
let projects = await alice('GET', '/api/projects')
if (firstRun) {
  await alice('POST', '/api/projects', { name: 'Example', template: 'example' })
  projects = await alice('GET', '/api/projects')
  for (const p of projects) {
    await alice('POST', `/api/projects/${p.id}/members`, { email: USERS[1].email, role: 'editor' })
    await alice('POST', `/api/projects/${p.id}/members`, { email: USERS[2].email, role: 'viewer' })
  }
}

if (opts.vitePort) {
  pids.vite = start('vite', path.join(ROOT, 'node_modules/.bin/vite'),
    ['--config', 'web/vite.config.ts', '--port', String(opts.vitePort), '--strictPort'], { FOLIO_API: base })
  fs.writeFileSync(pidFile, JSON.stringify(pids))
  await waitFor(`http://127.0.0.1:${opts.vitePort}/`, 60_000)
}

const info = {
  name: opts.name ?? path.basename(opts.dir),
  server: base,
  web: opts.vitePort ? `http://127.0.0.1:${opts.vitePort}` : `${base} (only if web/dist is built)`,
  dataDir,
  logs: { server: path.join(opts.dir, 'server.log'), vite: opts.vitePort ? path.join(opts.dir, 'vite.log') : null },
  password: PASSWORD,
  users: USERS.map(u => u.email),
  projects: projects.map(p => ({ id: p.id, name: p.name })),
  stop: `node scripts/dev-instance.mjs --stop --dir ${opts.dir}`,
}
fs.writeFileSync(path.join(opts.dir, 'instance.json'), JSON.stringify(info, null, 2))
if (paperNote) console.log(paperNote.trim())
console.log(JSON.stringify(info, null, 2))
