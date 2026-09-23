/**
 * The CLI tools run as separate processes (tsx) against a temp DATA_DIR, with no server.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.ts'
import { openDb } from '../../src/db/index.ts'
import { verifyPassword } from '../../src/auth/passwords.ts'
import { makeZip } from './helpers.ts'

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const TSX = path.join(ROOT, 'node_modules/.bin/tsx')

describe('CLI', () => {
  let dataDir: string
  let srcDir: string
  let env: NodeJS.ProcessEnv

  function run(script: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise(resolve => {
      execFile(TSX, [path.join(ROOT, 'server/src/cli', script), ...args], { env, cwd: ROOT, timeout: 90_000 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      })
    })
  }

  beforeAll(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-foundation-cli-'))
    srcDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-foundation-src-'))
    // a small paper directory with things the seed must skip
    await fsp.writeFile(path.join(srcDir, 'paper.tex'), '\\documentclass{article}\r\n\\begin{document}x\\end{document}\r\n')
    await fsp.writeFile(path.join(srcDir, 'paper.pdf'), '%PDF-1.5 stale')
    await fsp.writeFile(path.join(srcDir, 'paper.aux'), 'aux')
    await fsp.writeFile(path.join(srcDir, 'supp.tex'), '\\documentclass{article}\\begin{document}y\\end{document}')
    await fsp.mkdir(path.join(srcDir, 'figs'))
    await fsp.writeFile(path.join(srcDir, 'figs', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]))
    await fsp.mkdir(path.join(srcDir, 'ready'))
    await fsp.writeFile(path.join(srcDir, 'ready', 'copy.tex'), 'dup')
    await fsp.writeFile(path.join(srcDir, 'bundle.zip'), await makeZip([{ name: 'x.tex', data: 'x' }]))
    await fsp.symlink('/etc/hostname', path.join(srcDir, 'link.tex'))
    env = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      DATA_DIR: dataDir,
      NODE_ENV: 'test',
      COMPILE_RUNNER: 'fake',
      // a port nobody listens on, so the "server running" probe stays quiet
      PORT: '1',
    }
  })
  afterAll(async () => {
    await fsp.rm(dataDir, { recursive: true, force: true })
    await fsp.rm(srcDir, { recursive: true, force: true })
  })

  it('create-user validates input and creates accounts', async () => {
    const help = await run('create-user.ts', ['--help'])
    expect(help.code).toBe(0)
    expect(help.stdout).toContain('--email')
    expect((await run('create-user.ts', ['--email', 'a@example.com', '--name', 'A'])).code).toBe(2)
    expect((await run('create-user.ts', ['--email', 'a@example.com', '--name', 'A', '--password', 'short'])).code).toBe(2)
    expect((await run('create-user.ts', ['--bogus', 'x'])).code).toBe(2)
    const ok = await run('create-user.ts', ['--email', 'admin@example.com', '--name', 'The Admin', '--password', 'admin password', '--admin'])
    expect(ok.code, ok.stderr).toBe(0)
    expect(ok.stdout).toContain('Created administrator The Admin <admin@example.com>')
    const dup = await run('create-user.ts', ['--email=ADMIN@example.com', '--name=X', '--password=another password'])
    expect(dup.code).toBe(1)
    expect(dup.stderr).toContain('already exists')
  })

  it('reset-password changes the hash and signs out sessions', async () => {
    const config = loadConfig({ DATA_DIR: dataDir })
    let db = openDb(config.dbFile)
    const u = db.users.getByEmail('admin@example.com')!
    db.sessions.create('a'.repeat(64), u.id, 60_000)
    db.close()
    const r = await run('reset-password.ts', ['--email', 'admin@example.com', '--password', 'brand new password'])
    expect(r.code, r.stderr).toBe(0)
    db = openDb(config.dbFile)
    expect(await verifyPassword('brand new password', db.users.getByEmail('admin@example.com')!.passwordHash)).toBe(true)
    expect(db.sessions.get('a'.repeat(64))).toBeNull()
    db.close()
    expect((await run('reset-password.ts', ['--email', 'nobody@example.com', '--password', 'brand new password'])).code).toBe(1)
  })

  it('seed imports a directory with the default exclusions and real git history', async () => {
    const r = await run('seed.ts', ['--src', srcDir, '--owner', 'admin@example.com', '--name', 'Seeded', '--main', 'paper.tex', '--compiler', 'xelatex', '--external', 'supp.tex', '--timeout', '300'])
    expect(r.code, r.stderr + r.stdout).toBe(0)
    expect(r.stdout).toContain('files:     3 (2 text, 1 binary')
    expect(r.stdout).toContain('skipped:   2 excluded, 1 symlink, 1 ignored, 1 build-output')
    expect(r.stdout).toContain('main:      paper.tex')
    // a new project needs no restart of a running server (README: the tools can run meanwhile)
    expect(r.stdout).not.toContain('restart it')
    const config = loadConfig({ DATA_DIR: dataDir })
    const db = openDb(config.dbFile)
    try {
      const u = db.users.getByEmail('admin@example.com')!
      const [p] = db.projects.listForUser(u.id)
      expect(p.project.name).toBe('Seeded')
      expect(p.project.settings).toMatchObject({ compiler: 'xelatex', externalDocs: ['supp.tex'], timeoutSec: 300 })
      const files = db.files.list(p.project.id).map(f => `${f.path}:${f.kind}`).sort()
      expect(files).toEqual(['figs/a.png:binary', 'figs:folder', 'paper.tex:text', 'supp.tex:text'])
      expect(db.files.get(p.project.settings.rootFileId!)!.path).toBe('paper.tex')
      const tex = await fsp.readFile(path.join(config.dirs.projects, p.project.id, 'paper.tex'), 'utf8')
      expect(tex).not.toContain('\r')
      // history initialised by the real HistoryService (separate git dir)
      expect(fs.existsSync(path.join(config.dirs.history, `${p.project.id}.git`))).toBe(true)
    } finally {
      db.close()
    }
    const missing = await run('seed.ts', ['--src', srcDir, '--owner', 'ghost@example.com'])
    expect(missing.code).toBe(1)
    expect(missing.stderr).toContain('create-user')
  })

  it('doctor reports the environment', async () => {
    const r = await run('doctor.ts', [])
    expect(r.stdout).toMatch(/\[ok {2}\] node/)
    expect(r.stdout).toMatch(/\[ok {2}\] data dir/)
    expect(r.stdout).toMatch(/\[ok {2}\] git/)
    expect(r.stdout).toMatch(/Ready.*start Folio with `npm start`/)
    expect(r.stdout).not.toContain('restart it')
  })
})
