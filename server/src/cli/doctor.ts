/**
 * npm run doctor [-- --compile] — can this machine run Folio? Checks Node, the data directory
 * (writable, free space), the database, git, Docker (CLI, daemon, permissions) and the TeX Live
 * image (or latexmk for the local runner), the font/TeX cache, pdf.js assets, the built web app
 * and whether a Folio server is already running. Every problem comes with the fix.
 *
 *   --compile   also compile a one-page document in the sandbox (proves the whole chain; the
 *               first run with a cold cache can take a minute)
 *
 * Exit code 1 when a check failed (warnings do not fail).
 */
// must stay the first import: loads .env before config/log read process.env
import '../env.ts'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { compileUserProblem, loadConfig, parsePublicOrigin } from '../config.ts'
import { openDb } from '../db/index.ts'
import { classifyDockerFailure, explainDockerFailure, runSandboxed } from '../compile/sandbox.ts'
import { latexmkArgv, SANDBOX_ENV } from '../compile/runner.ts'
import { parseArgs, runCli, usage, type OptionSpec } from './args.ts'
import { serverSeemsRunning } from './container.ts'

const exec = promisify(execFile)

const spec = {
  compile: { type: 'boolean', description: 'also compile a test document in the sandbox' },
} satisfies Record<string, OptionSpec>
const help = usage('doctor', 'Check that this machine can run Folio.', spec)

type Level = 'ok' | 'warn' | 'fail'
interface Check { name: string; level: Level; detail: string; fix?: string }

/** Environment for the probes: minimal, but with everything the docker CLI needs to find its daemon. */
function probeEnv(): NodeJS.ProcessEnv {
  const keep = /^(PATH|HOME|USER|LANG|LC_ALL|XDG_RUNTIME_DIR|DOCKER_[A-Z_]+)$/
  const env: NodeJS.ProcessEnv = { LC_ALL: 'C' }
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && keep.test(k)) env[k] = v
  env.LC_ALL = 'C'
  return env
}

async function run(cmd: string, args: string[], timeoutMs = 20_000): Promise<{ ok: boolean; out: string; missing: boolean }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: probeEnv() })
    return { ok: true, out: `${stdout}${stderr}`.trim(), missing: false }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string; code?: string | number }
    return { ok: false, out: `${e.stderr ?? ''}${e.stdout ?? ''}`.trim() || e.message, missing: e.code === 'ENOENT' }
  }
}

function versionAtLeast(v: string, min: number[]): boolean {
  const parts = v.split('.').map(n => parseInt(n, 10))
  for (let i = 0; i < min.length; i++) {
    const a = parts[i] ?? 0
    if (a !== min[i]) return a > min[i]
  }
  return true
}

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`
}

async function isFolio(host: string, port: number): Promise<boolean> {
  try {
    const r = await fetch(`http://${host.includes(':') ? `[${host}]` : host}:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
    return r.ok && (await r.json() as { ok?: boolean }).ok === true
  } catch {
    return false
  }
}

const HELLO = String.raw`\documentclass{article}
\begin{document}
Hello from Folio's doctor.
\end{document}
`

runCli(async () => {
  const args = parseArgs(process.argv.slice(2), spec)
  if (args.help) {
    console.log(help)
    return 0
  }
  const checks: Check[] = []
  const add = (name: string, level: Level, detail: string, fix?: string) => checks.push({ name, level, detail, fix })
  // a malformed PUBLIC_ORIGIN stops the server from starting: report it, and check the rest without it
  let originError: string | null = null
  try {
    parsePublicOrigin(process.env.PUBLIC_ORIGIN)
  } catch (err) {
    originError = (err as Error).message
  }
  const config = loadConfig(originError ? { ...process.env, PUBLIC_ORIGIN: undefined } : process.env)

  const node = process.versions.node
  add('node', versionAtLeast(node, [22, 12]) ? 'ok' : 'fail', `Node ${node}`, versionAtLeast(node, [22, 12]) ? undefined : 'install Node 22.12 or newer')

  // the address people use (CSRF / WebSocket origin check, Secure cookies)
  if (originError) add('public origin', 'fail', originError, 'set PUBLIC_ORIGIN to the scheme and host people open, e.g. https://latex.example.com (no path: Folio must be served at the root of its origin)')
  else if (config.publicOrigin) add('public origin', 'ok', `${config.publicOrigin}${config.publicOrigin.startsWith('https:') ? ' (Secure cookies)' : ''}`)

  // who TeX runs as
  const userProblem = compileUserProblem(config)
  if (userProblem) {
    add('compile user', userProblem.fatal ? 'fail' : 'warn', userProblem.message,
      userProblem.fatal ? 'run Folio as a normal user in the docker group (systemd: User=folio), or set COMPILE_USER=<uid>:<gid>' : undefined)
  } else if (config.compile.runner === 'docker') {
    add('compile user', 'ok', `compile containers run as ${config.compile.user}`)
  }

  // data directory: writable + free space
  try {
    if (!fs.existsSync(config.dataDir)) fs.mkdirSync(config.dataDir, { recursive: true, mode: 0o700 })
    for (const dir of Object.values(config.dirs)) fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(config.dirs.tmp, `doctor-${process.pid}`)
    await fsp.writeFile(probe, 'ok')
    await fsp.rm(probe)
    const st = await fsp.statfs(config.dataDir)
    const free = st.bavail * st.bsize
    add('data dir', free < 2 * 1024 ** 3 ? 'warn' : 'ok', `${config.dataDir} (writable, ${gb(free)} free)`,
      free < 2 * 1024 ** 3 ? 'free some disk space: builds, history and the TeX cache need room' : undefined)
  } catch (err) {
    add('data dir', 'fail', `${config.dataDir}: ${(err as Error).message}`, 'set DATA_DIR to a directory this user can write')
  }

  // database
  try {
    const db = openDb(config.dbFile)
    const users = db.users.count()
    const projects = (db.raw.prepare('SELECT COUNT(*) AS n FROM projects').get() as { n: number }).n
    // the integrity check belongs here, not in the server's start-up: it reads the whole file
    const integrity = db.raw.pragma('quick_check', { simple: true }) as string
    db.close()
    if (integrity !== 'ok') {
      add('database', 'fail', `${config.dbFile}: PRAGMA quick_check says “${integrity}”`,
        'the database is damaged and cannot be repaired in place: stop Folio and restore your newest backup (README → Data and backups)')
    } else if (users) add('database', 'ok', `${users} account${users === 1 ? '' : 's'}, ${projects} project${projects === 1 ? '' : 's'}, quick_check ok`)
    else add('database', 'warn', 'no accounts yet', 'open the web app and complete /setup, or: npm run create-user -- --email you@example.com --name "Your Name" --password … --admin')
  } catch (err) {
    add('database', 'fail', `${config.dbFile}: ${(err as Error).message}`)
  }

  // git (history)
  const git = await run('git', ['--version'])
  const gitVersion = /git version (\d+\.\d+(\.\d+)?)/.exec(git.out)?.[1]
  if (!git.ok || !gitVersion) add('git', 'fail', git.missing ? 'git is not installed' : `git failed: ${git.out.split('\n')[0]}`, 'install git (used for the project history)')
  else add('git', versionAtLeast(gitVersion, [2, 24]) ? 'ok' : 'fail', `git ${gitVersion}`, versionAtLeast(gitVersion, [2, 24]) ? undefined : 'install git 2.24 or newer')

  // compiler
  let dockerReady = false
  if (config.compile.runner === 'docker') {
    const info = await run('docker', ['info', '--format', '{{.ServerVersion}}'])
    if (!info.ok) {
      const f = classifyDockerFailure(info.out)
      if (info.missing) add('docker', 'fail', 'the docker command is not installed', 'install Docker Engine (https://docs.docker.com/engine/install/)')
      else if (f?.kind === 'daemon') add('docker', 'fail', `the Docker daemon is not reachable (${f.line.slice(0, 120)})`, `start Docker (e.g. sudo systemctl start docker)${process.env.DOCKER_HOST ? `, or check DOCKER_HOST=${process.env.DOCKER_HOST}` : ''}`)
      else if (f?.kind === 'permission') add('docker', 'fail', `this user (${os.userInfo().username}) may not use Docker`, `sudo usermod -aG docker ${os.userInfo().username}, then log in again`)
      else add('docker', 'fail', info.out.split('\n')[0] || 'docker info failed')
    } else {
      add('docker', 'ok', `Docker ${info.out.split('\n')[0]}`)
      const image = await run('docker', ['image', 'inspect', '--format', '{{.Id}} {{.Created}} {{.Size}}', config.compile.image])
      if (image.ok) {
        const [id, created, size] = image.out.split(' ')
        add('tex image', 'ok', `${config.compile.image} (${id.slice(7, 19)}, ${created.slice(0, 10)}, ${gb(Number(size))})`)
        dockerReady = true
      } else {
        add('tex image', 'fail', `${config.compile.image} is not pulled`, `docker pull ${config.compile.image}   (about 5 GB)`)
      }
    }
  } else if (config.compile.runner === 'local') {
    const latexmk = await run('latexmk', ['-v'])
    add('latexmk', latexmk.ok ? 'warn' : 'fail', latexmk.ok ? `${latexmk.out.split('\n').find(l => l.includes('Latexmk')) ?? 'latexmk'} — local runner: compiles are NOT sandboxed` : 'latexmk not found on PATH',
      latexmk.ok ? 'use COMPILE_RUNNER=docker on shared servers' : 'install TeX Live, or use COMPILE_RUNNER=docker')
  } else {
    add('compile', 'warn', 'COMPILE_RUNNER=fake: compiles return a fixture PDF', 'only for tests — use COMPILE_RUNNER=docker')
  }

  // TeX font cache warm-up marker (written by the compile service after its first warm-up)
  if (dockerReady) {
    const markers = (await fsp.readdir(config.dirs.texcache).catch(() => [] as string[])).filter(n => n.startsWith('.warm-'))
    add('tex cache', markers.length ? 'ok' : 'warn', markers.length ? 'font caches are warm' : 'cold', markers.length ? undefined : 'nothing to do: the first compile warms it (about a minute)')
  }

  // static assets
  const pdfjsOk = ['cmaps', 'standard_fonts', 'wasm', 'iccs'].every(d => fs.existsSync(path.join(config.pdfjsDir, d)))
  add('pdf.js assets', pdfjsOk ? 'ok' : 'fail', pdfjsOk ? 'cmaps, fonts, wasm, iccs present' : `missing under ${config.pdfjsDir}`, pdfjsOk ? undefined : 'npm install')
  const webOk = fs.existsSync(path.join(config.webDist, 'index.html'))
  add('web app', webOk ? 'ok' : 'warn', webOk ? `built (${config.webDist})` : `not built (${config.webDist})`, webOk ? undefined : 'npm run build   (not needed for npm run dev)')

  // a server on the configured port?
  const probeHost = config.host === '0.0.0.0' || config.host === '::' ? '127.0.0.1' : config.host
  if (await serverSeemsRunning(config)) {
    if (await isFolio(probeHost, config.port)) add('server', 'ok', `Folio is running on http://${probeHost}:${config.port}`)
    else add('server', 'warn', `port ${config.port} on ${config.host} is used by another program`, 'stop it, or start Folio with PORT=<another port>')
  } else {
    add('server', 'ok', `port ${config.port} is free (start Folio with npm start, or npm run dev)`)
  }

  // optional end-to-end compile in the sandbox
  if (args.compile) {
    if (config.compile.runner !== 'docker') add('test compile', 'warn', 'skipped (only for COMPILE_RUNNER=docker)')
    else if (!dockerReady) add('test compile', 'fail', 'skipped: Docker or the image is not available')
    else {
      const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-doctor-'))
      const cache = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-doctor-cache-'))
      try {
        await fsp.writeFile(path.join(work, 'main.tex'), HELLO)
        await fsp.mkdir(path.join(cache, 'xdg'))
        await fsp.mkdir(path.join(cache, 'texmf-var'))
        const t0 = Date.now()
        const r = await runSandboxed({
          image: config.compile.image,
          mounts: [{ host: work, container: '/compile' }, { host: cache, container: '/cache' }],
          argv: latexmkArgv({ jobname: 'main', compiler: 'pdflatex', draft: false, stopOnFirstError: true, force: true, rootFile: '/compile/main.tex' }),
          env: SANDBOX_ENV,
          workdir: '/compile',
          timeoutMs: 180_000,
          user: config.compile.user,
          memory: config.compile.memory,
          cpus: config.compile.cpus,
          labels: { 'folio.kind': 'doctor' },
          mergeStderr: true,
          keep: 'tail',
        })
        const pdf = await fsp.stat(path.join(work, 'main.pdf')).catch(() => null)
        if (r.code === 0 && pdf && pdf.size > 0) add('test compile', 'ok', `pdfLaTeX in the sandbox: ${((Date.now() - t0) / 1000).toFixed(1)} s, ${pdf.size} byte PDF`)
        else add('test compile', 'fail', r.error ?? explainDockerFailure(r.stdout, config.compile.image) ?? `latexmk exited with ${r.code}: ${r.stdout.trim().split('\n').slice(-3).join(' | ')}`)
      } finally {
        await fsp.rm(work, { recursive: true, force: true })
        await fsp.rm(cache, { recursive: true, force: true })
      }
    }
  }

  const icon: Record<Level, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL' }
  console.log(`Folio ${config.version} — ${config.env} · data ${config.dataDir} · compiler ${config.compile.runner}\n`)
  for (const c of checks) {
    console.log(`[${icon[c.level]}] ${c.name.padEnd(14)} ${c.detail}`)
    if (c.fix && c.level !== 'ok') console.log(`${' '.repeat(22)}→ ${c.fix}`)
  }
  const failed = checks.filter(c => c.level === 'fail')
  const warned = checks.filter(c => c.level === 'warn')
  console.log('')
  if (failed.length) console.log(`${failed.length} problem${failed.length === 1 ? '' : 's'} to fix before Folio can work properly (${failed.map(c => c.name).join(', ')}).`)
  else console.log(`Ready${warned.length ? ` (${warned.length} note${warned.length === 1 ? '' : 's'})` : ''}: start Folio with \`npm start\` (built app) or \`npm run dev\` (development).`)
  if (!args.compile && config.compile.runner === 'docker' && !failed.length) console.log('Tip: `npm run doctor -- --compile` also compiles a test document in the sandbox.')
  return failed.length ? 1 : 0
}, help)
