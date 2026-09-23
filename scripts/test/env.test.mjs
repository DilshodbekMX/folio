/**
 * Settings and signals of the scripts people run Folio with:
 *  - `npm run dev`: web/vite.config.ts follows PORT / HOST / VITE_PORT from the environment and the
 *    app's env file (FOLIO_ENV_FILE, `none`), like the server does;
 *  - scripts/setup.mjs reads the env file too;
 *  - the throw-away servers of scripts/e2e-server.mjs and scripts/dev-instance.mjs never read the
 *    developer's env file, nor PUBLIC_ORIGIN from the shell;
 *  - `npm start` passes a SIGTERM sent to npm on to the server, which shuts down gracefully.
 */
import { afterAll, describe, expect, it } from 'vitest'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, cleanEnv, dummyWebDist, envFile, freePort, removeTempDirs, session, tempDir, waitFor } from './helpers.mjs'

afterAll(() => removeTempDirs())

/** a developer's .env that must never reach a throw-away server */
const leaky = () => envFile({ PUBLIC_ORIGIN: 'https://latex.example.com', ALLOW_SIGNUP: 'true', PORT: '3999', COMPILE_RUNNER: 'docker' })

const run = (args, env, opts = {}) => spawnSync(process.execPath, args, { cwd: ROOT, env: cleanEnv(env), encoding: 'utf8', ...opts })

describe('web/vite.config.ts (npm run dev)', () => {
  const PROBE = `
    const { loadConfigFromFile } = await import('vite')
    const r = await loadConfigFromFile({ command: 'serve', mode: 'development' }, 'web/vite.config.ts', process.cwd(), 'silent')
    const s = r.config.server
    console.log(JSON.stringify({ port: s.port, api: s.proxy['/api'].target, ws: s.proxy['/ws'].target }))`
  const resolve = env => {
    const r = run(['--input-type=module', '-e', PROBE], env)
    if (r.status !== 0) throw new Error(r.stderr)
    return JSON.parse(r.stdout.trim().split('\n').pop())
  }
  const file = envFile({ PORT: '3408', VITE_PORT: '5408' })

  it('defaults to the server on 3100 and Vite on 5173', () => {
    expect(resolve({ FOLIO_ENV_FILE: 'none' })).toEqual({ port: 5173, api: 'http://127.0.0.1:3100', ws: 'ws://127.0.0.1:3100' })
  })

  it('follows PORT and VITE_PORT from the environment', () => {
    expect(resolve({ FOLIO_ENV_FILE: 'none', PORT: '3408', VITE_PORT: '5408' })).toEqual({ port: 5408, api: 'http://127.0.0.1:3408', ws: 'ws://127.0.0.1:3408' })
  })

  it('reads them from the env file the server reads; the environment wins', () => {
    expect(resolve({ FOLIO_ENV_FILE: file })).toEqual({ port: 5408, api: 'http://127.0.0.1:3408', ws: 'ws://127.0.0.1:3408' })
    expect(resolve({ FOLIO_ENV_FILE: file, PORT: '3500' }).api).toBe('http://127.0.0.1:3500')
  })

  it('FOLIO_API overrides the target; HOST picks the address; FOLIO_ENV_FILE=none reads no file', () => {
    expect(resolve({ FOLIO_ENV_FILE: file, FOLIO_API: 'http://127.0.0.1:3777/' }).api).toBe('http://127.0.0.1:3777')
    expect(resolve({ FOLIO_ENV_FILE: 'none', HOST: '0.0.0.0', PORT: '3401' }).api).toBe('http://127.0.0.1:3401')
    expect(resolve({ FOLIO_ENV_FILE: 'none', HOST: '::1', PORT: '3401' }).api).toBe('http://[::1]:3401')
    expect(resolve({ FOLIO_ENV_FILE: 'none', PORT: '' }).api).toBe('http://127.0.0.1:3100')
  })
})

describe('scripts/setup.mjs', () => {
  it('reads the env file: the next steps name the port the doctor checked', async () => {
    const port = await freePort()
    const file = envFile({ PORT: String(port), COMPILE_RUNNER: 'fake', DATA_DIR: path.join(tempDir('setup'), 'data') })
    const r = run(['scripts/setup.mjs', '--no-build'], { FOLIO_ENV_FILE: file })
    expect(r.stdout).toContain(`port ${port} is free`)
    expect(r.stdout).toContain(`start Folio (http://127.0.0.1:${port})`)
  })
})

describe("throw-away servers ignore the developer's env file", () => {
  it('(control) a server without isolation does read it', () => {
    const r = run(['--import', 'tsx', '--input-type=module', '-e', `
      await import('./server/src/env.ts')
      const { loadConfig } = await import('./server/src/config.ts')
      const c = loadConfig()
      console.log(JSON.stringify({ publicOrigin: c.publicOrigin, allowSignup: c.allowSignup }))`], { FOLIO_ENV_FILE: leaky() })
    expect(JSON.parse(r.stdout)).toEqual({ publicOrigin: 'https://latex.example.com', allowSignup: true })
  })

  /** signup stays off, and the session cookie is not `Secure` (it would be with that PUBLIC_ORIGIN) */
  async function expectIsolated(base, login) {
    const status = await (await fetch(`${base}/api/auth/setup-status`)).json()
    expect(status.allowSignup).toBe(false)
    const { setCookie } = await login()
    expect(setCookie).not.toMatch(/;\s*Secure/i)
  }

  it('scripts/e2e-server.mjs', async () => {
    const port = await freePort()
    const child = spawn(process.execPath, ['scripts/e2e-server.mjs'], {
      cwd: ROOT,
      env: cleanEnv({
        FOLIO_ENV_FILE: leaky(), PUBLIC_ORIGIN: 'https://shell.example.com',
        E2E_PORT: String(port), E2E_EMPTY: '1', E2E_BUILD: 'never', E2E_WEB_DIST: dummyWebDist(), COMPILE_RUNNER: 'fake',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { out += d })
    const exited = new Promise(r => child.once('exit', r))
    try {
      await waitFor(() => /FOLIO_E2E_READY/.test(out) || child.exitCode !== null, 90_000, 'e2e-server')
      expect(out).toMatch(/FOLIO_E2E_READY/)
      const base = `http://127.0.0.1:${port}`
      await expectIsolated(base, () => session(base, { email: 'admin@example.com', name: 'Admin', setup: true }))
    } finally {
      child.kill('SIGTERM')
      await exited
    }
  })

  it('scripts/dev-instance.mjs', async () => {
    const port = await freePort()
    const dir = tempDir('instance')
    const env = { FOLIO_ENV_FILE: leaky(), PUBLIC_ORIGIN: 'https://shell.example.com' }
    try {
      const r = run(['scripts/dev-instance.mjs', '--name', 'scripts-test', '--dir', dir, '--port', String(port), '--runner', 'fake', '--no-paper'], env, { timeout: 90_000 })
      expect(r.status, r.stderr).toBe(0)
      const base = `http://127.0.0.1:${port}`
      await expectIsolated(base, () => session(base, { email: 'alice@example.com' }))
    } finally {
      run(['scripts/dev-instance.mjs', '--stop', '--dir', dir], env)
      await waitFor(() => fetch(`http://127.0.0.1:${port}/healthz`).then(() => false, () => true), 30_000, 'the dev instance to stop')
    }
  })
})

describe('npm start', () => {
  it('a SIGTERM sent to npm reaches the server, which shuts down gracefully', async () => {
    const dataDir = path.join(tempDir('start'), 'data')
    const log = path.join(path.dirname(dataDir), 'npm.log')
    const port = await freePort()
    const out = fs.openSync(log, 'a')
    // its own process group, like a service manager that signals only the main process
    const npm = spawn('npm', ['start'], {
      cwd: ROOT,
      env: cleanEnv({ FOLIO_ENV_FILE: 'none', DATA_DIR: dataDir, PORT: String(port), COMPILE_RUNNER: 'fake', WEB_DIST: dummyWebDist() }),
      stdio: ['ignore', out, out],
      detached: true,
    })
    fs.closeSync(out)
    const exited = new Promise(r => npm.once('exit', r))
    const base = `http://127.0.0.1:${port}`
    try {
      await waitFor(async () => (await fetch(`${base}/healthz`)).ok, 60_000, `${base}/healthz`)
      npm.kill('SIGTERM')
      await exited
      // nothing is left serving on the port, and the server ran its shutdown
      await expect(fetch(`${base}/healthz`)).rejects.toThrow()
      const text = fs.readFileSync(log, 'utf8')
      expect(text).toMatch(/shutting down/)
      expect(text).toMatch(/"msg":"bye"/)
    } finally {
      try {
        process.kill(-npm.pid, 'SIGKILL')
      } catch {
        /* the whole group is gone */
      }
    }
  })
})
