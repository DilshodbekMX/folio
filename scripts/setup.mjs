#!/usr/bin/env node
/**
 * One-time setup for a Folio checkout:  node scripts/setup.mjs [--pull] [--no-build] [--compile]
 *
 *   1. checks Node (≥ 22.12) and that `npm install` has been run
 *   2. runs the doctor (Docker, the TeX Live image, git, data directory, …)
 *   3. --pull: pulls the TeX Live image when it is missing (about 5 GB)
 *   4. builds the web app (web/dist) unless --no-build
 *   5. --compile: compiles a test document in the sandbox (doctor --compile)
 *   6. prints the next steps
 *
 * Nothing here needs root; it never modifies your data directory beyond creating it.
 * Reads the same settings as the server: the environment, then `.env` next to package.json (or
 * FOLIO_ENV_FILE; `none` reads no file), so --pull, the doctor and the next steps agree.
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const args = new Set(process.argv.slice(2))

// the env file, resolved like server/src/env.ts; variables already set in the environment win
const envFileSetting = process.env.FOLIO_ENV_FILE?.trim()
if (envFileSetting !== 'none') {
  const envFile = envFileSetting ? path.resolve(envFileSetting) : path.join(ROOT, '.env')
  if (fs.existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile)
    } catch (err) {
      console.error(`Could not read ${envFile}: ${err.message}`)
      process.exit(1)
    }
  }
  // the doctor runs in ROOT: hand it the same file even when FOLIO_ENV_FILE was relative
  if (envFileSetting) process.env.FOLIO_ENV_FILE = envFile
}
if (args.has('--help') || args.has('-h')) {
  console.log('Usage: node scripts/setup.mjs [--pull] [--no-build] [--compile]\n\n  --pull      docker pull the TeX Live image if it is missing (~5 GB)\n  --no-build  skip building the web app\n  --compile   also compile a test document in the sandbox')
  process.exit(0)
}
for (const a of args) {
  if (!['--pull', '--no-build', '--compile'].includes(a)) {
    console.error(`unknown option ${a} (see --help)`)
    process.exit(2)
  }
}

const bold = s => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s)
const step = s => console.log(`\n${bold(`▸ ${s}`)}`)
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { cwd: ROOT, stdio: 'inherit', env: process.env, ...opts })
const bin = name => path.join(ROOT, 'node_modules/.bin', name)

// 1. prerequisites
step('Node.js and dependencies')
const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 12)) {
  console.error(`Folio needs Node.js 22.12 or newer (this is ${process.versions.node}).`)
  process.exit(1)
}
if (!fs.existsSync(bin('tsx')) || !fs.existsSync(bin('vite'))) {
  console.error('Dependencies are missing: run `npm install` first.')
  process.exit(1)
}
console.log(`Node ${process.versions.node}, dependencies installed.`)

// 2–3. doctor (+ optional pull)
const image = process.env.COMPILE_IMAGE ?? 'texlive/texlive:latest-full'
const runner = process.env.COMPILE_RUNNER ?? 'docker'
if (args.has('--pull') && runner === 'docker') {
  const inspect = spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' })
  if (inspect.status !== 0) {
    step(`Pulling ${image} (about 5 GB — this takes a while)`)
    const pull = run('docker', ['pull', image])
    if (pull.status !== 0) console.error(`docker pull failed; fix Docker first (see the checks below).`)
  }
}
step('Checking this machine (npm run doctor)')
const doctor = run(bin('tsx'), [path.join(ROOT, 'server/src/cli/doctor.ts'), ...(args.has('--compile') ? ['--compile'] : [])])
const doctorOk = doctor.status === 0

// 4. web app
if (!args.has('--no-build')) {
  step('Building the web app (npm run build)')
  const build = run(bin('vite'), ['build', '--config', 'web/vite.config.ts', '--logLevel', 'warn'])
  if (build.status !== 0) {
    console.error('The web build failed.')
    process.exit(1)
  }
  console.log(`Built ${path.join(ROOT, 'web/dist')}.`)
}

// 5. next steps
step('Next steps')
const port = process.env.PORT || '3100'
const host = !process.env.HOST || ['0.0.0.0', '::'].includes(process.env.HOST) ? '127.0.0.1' : process.env.HOST
const url = process.env.PUBLIC_ORIGIN?.replace(/\/+$/, '') || `http://${host.includes(':') ? `[${host}]` : host}:${port}`
console.log([
  doctorOk ? 'All required checks passed.' : 'Some checks failed — fix them (see the → hints above), then run this again.',
  '',
  `  npm start                          start Folio (${url})`,
  '  open /setup in the browser         create the administrator account (first start only)',
  '  npm run create-user -- --email you@example.com --name "Your Name" --password "…" [--admin]',
  '  npm run seed -- --src ~/papers/thesis --owner you@example.com --main thesis.tex',
  '',
  'Configuration: environment variables or a .env file next to package.json (see README.md).',
].join('\n'))
process.exit(doctorOk ? 0 : 1)
