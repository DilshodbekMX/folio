/**
 * Configuration: the env file (FOLIO_ENV_FILE, `none`), PUBLIC_ORIGIN validation and the user
 * compile containers run as.
 */
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { compileUserProblem, loadConfig, parsePublicOrigin } from '../../src/config.ts'

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const TSX = path.join(ROOT, 'node_modules/.bin/tsx')

describe('env file (FOLIO_ENV_FILE)', () => {
  let dir: string
  let envFile: string
  let probe: string

  beforeAll(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-env-test-'))
    envFile = path.join(dir, 'dev.env')
    await fsp.writeFile(envFile, 'PUBLIC_ORIGIN=https://latex.example.com\nALLOW_SIGNUP=true\n')
    probe = path.join(dir, 'probe.mts')
    await fsp.writeFile(probe, [
      `import { ENV_FILE, envFileLoaded } from ${JSON.stringify(path.join(ROOT, 'server/src/env.ts'))}`,
      `const { loadConfig } = await import(${JSON.stringify(path.join(ROOT, 'server/src/config.ts'))})`,
      'const c = loadConfig()',
      'console.log(JSON.stringify({ file: ENV_FILE, loaded: envFileLoaded, publicOrigin: c.publicOrigin, allowSignup: c.allowSignup }))',
    ].join('\n'))
  })
  afterAll(async () => {
    await fsp.rm(dir, { recursive: true, force: true })
  })

  /** the probe in a process of its own, as a server would start (not under vitest) */
  function run(env: Record<string, string>): Promise<{ file: string | null; loaded: boolean; publicOrigin: string | null; allowSignup: boolean }> {
    return new Promise((resolve, reject) => {
      execFile(TSX, [probe], { cwd: dir, timeout: 60_000, env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', ...env } }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`${err.message}\n${stderr}`))
        resolve(JSON.parse(String(stdout).trim().split('\n').at(-1)!))
      })
    })
  }

  it('loads the named file; variables set in the environment win', async () => {
    expect(await run({ FOLIO_ENV_FILE: envFile })).toEqual({ file: envFile, loaded: true, publicOrigin: 'https://latex.example.com', allowSignup: true })
    expect((await run({ FOLIO_ENV_FILE: envFile, PUBLIC_ORIGIN: 'https://other.example.org' })).publicOrigin).toBe('https://other.example.org')
  })

  it('FOLIO_ENV_FILE=none loads no file: a throw-away server never inherits a developer\'s .env', async () => {
    expect(await run({ FOLIO_ENV_FILE: 'none' })).toEqual({ file: null, loaded: false, publicOrigin: null, allowSignup: false })
  })
})

describe('PUBLIC_ORIGIN', () => {
  it('is normalised to a bare origin', () => {
    expect(parsePublicOrigin(undefined)).toBeNull()
    expect(parsePublicOrigin('  ')).toBeNull()
    expect(parsePublicOrigin('https://latex.example.com')).toBe('https://latex.example.com')
    expect(parsePublicOrigin('https://latex.example.com/')).toBe('https://latex.example.com')
    expect(parsePublicOrigin('HTTPS://Latex.Example.COM:443/')).toBe('https://latex.example.com')
    expect(parsePublicOrigin('http://10.0.0.5:3100')).toBe('http://10.0.0.5:3100')
    expect(loadConfig({ PUBLIC_ORIGIN: 'https://latex.example.com/' }).publicOrigin).toBe('https://latex.example.com')
  })

  it('refuses values that would reject every login: no scheme, a path, a query, credentials', () => {
    expect(() => parsePublicOrigin('latex.example.com')).toThrow(/with its scheme/)
    expect(() => parsePublicOrigin('localhost:3100')).toThrow(/https:\/\/ or http:\/\//)
    expect(() => parsePublicOrigin('ftp://latex.example.com')).toThrow(/https:\/\/ or http:\/\//)
    expect(() => parsePublicOrigin('https://example.com/folio')).toThrow(/root of its origin/)
    expect(() => parsePublicOrigin('https://example.com/?a=1')).toThrow(/root of its origin/)
    expect(() => parsePublicOrigin('https://user:pw@example.com')).toThrow(/user name or password/)
    expect(() => loadConfig({ PUBLIC_ORIGIN: 'latex.example.com' })).toThrow(/PUBLIC_ORIGIN/)
  })
})

describe('compile user', () => {
  const docker = loadConfig({ COMPILE_RUNNER: 'docker' })
  it('refuses to run compile containers as root by default', () => {
    expect(compileUserProblem(docker, {}, 1000)).toBeNull()
    const asRoot = loadConfig({ COMPILE_RUNNER: 'docker' })
    asRoot.compile.user = '0:0'
    expect(compileUserProblem(asRoot, {}, 0)).toMatchObject({ fatal: true, message: expect.stringMatching(/running as root/) })
    // an explicit, unprivileged COMPILE_USER is the documented way out
    const explicit = loadConfig({ COMPILE_RUNNER: 'docker', COMPILE_USER: '1000:1000' })
    expect(compileUserProblem(explicit, { COMPILE_USER: '1000:1000' }, 0)).toBeNull()
    // an explicit root COMPILE_USER only warns
    const zero = loadConfig({ COMPILE_RUNNER: 'docker', COMPILE_USER: '0:0' })
    expect(compileUserProblem(zero, { COMPILE_USER: '0:0' }, 1000)).toMatchObject({ fatal: false })
    // the local runner under root warns, the fake runner (tests) does not care
    expect(compileUserProblem(loadConfig({ COMPILE_RUNNER: 'local' }), {}, 0)).toMatchObject({ fatal: false })
    expect(compileUserProblem(loadConfig({ COMPILE_RUNNER: 'fake' }), {}, 0)).toBeNull()
  })
})
