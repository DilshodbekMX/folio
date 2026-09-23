/**
 * SynctexService + routes against fixture build directories (a fake CompileService whose
 * resolveBuildFile points into a temp builds dir). Docker tests (FOLIO_DOCKER_TESTS=1) run the
 * real synctex CLI fallback in the TeX Live image.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CompileResponse } from '@folio/shared/api'
import { forwardSearch, inverseSearch, parseSynctexText } from '@folio/shared/synctex'
import { loadConfig } from '../../src/config.ts'
import { openDb, type Db } from '../../src/db/index.ts'
import { HttpError } from '../../src/http/errors.ts'
import { loadSession } from '../../src/auth/middleware.ts'
import { createSession } from '../../src/auth/sessions.ts'
import type { CompileService, Services } from '../../src/services.ts'
import {
  createSynctexService, dockerSynctexCli, parseCliOutput, type FolioSynctexService, type SynctexCliRequest,
} from '../../src/synctex/index.ts'
import { synctexRoutes } from '../../src/synctex/routes.ts'

const DOCKER = process.env.FOLIO_DOCKER_TESTS === '1'
const SHARED_FIXTURES = fileURLToPath(new URL('../../../shared/test/fixtures/synctex/', import.meta.url))
const HERE = fileURLToPath(new URL('./fixtures/', import.meta.url))
const BUILD_ID_RE = /^[0-9a-f]{8,}-[0-9a-f]{16}$/
const FILE_RE = /^[\w.\-]+$/

const SMALL_FILES = ['main.tex', 'chapters/intro.tex', 'chapters/results.tex']

interface Env {
  root: string
  db: Db
  s: Services
  svc: FolioSynctexService
  pid: string
  owner: string
  viewer: string
  outsider: string
  /** create a build dir with meta.json + files; returns the build id */
  addBuild(files: Record<string, Buffer | string>, meta?: Partial<CompileResponse>): string
  cliCalls: SynctexCliRequest[]
}

function newBuildId(): string {
  return `${Date.now().toString(16)}-${randomBytes(8).toString('hex')}`
}

async function makeEnv(opts: { runCli?: ((req: SynctexCliRequest) => Promise<string | null>) | null; runner?: 'docker' | 'fake' | 'local'; files?: string[] } = {}): Promise<Env> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-synctex-test-'))
  const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: path.join(root, 'data'), COMPILE_RUNNER: opts.runner ?? 'fake' })
  fs.mkdirSync(config.dirs.builds, { recursive: true })
  const db = openDb(':memory:')
  const mk = (name: string) => db.users.create({ email: `${name}@example.test`, name, passwordHash: 'x' }).id
  const owner = mk('owner')
  const viewer = mk('viewer')
  const outsider = mk('outsider')
  const project = db.projects.create({ name: 'P', ownerId: owner })
  db.members.upsert(project.id, viewer, 'viewer')
  const folders = new Set<string>()
  for (const f of opts.files ?? SMALL_FILES) {
    const parts = f.split('/')
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'))
    db.files.create({ projectId: project.id, path: f, kind: 'text' })
  }
  for (const d of folders) db.files.create({ projectId: project.id, path: d, kind: 'folder' })

  const compile = {
    resolveBuildFile(pid: string, buildId: string, file: string): string | null {
      if (!BUILD_ID_RE.test(buildId) || !FILE_RE.test(file) || file.startsWith('.')) return null
      const p = path.join(config.dirs.builds, pid, buildId, file)
      return fs.existsSync(p) ? p : null
    },
  } as unknown as CompileService
  const s = { config, db, compile } as unknown as Services
  const cliCalls: SynctexCliRequest[] = []
  const runCli = opts.runCli === undefined
    ? async (req: SynctexCliRequest) => {
      cliCalls.push(req)
      return null
    }
    : opts.runCli
  const svc = createSynctexService(s, { runCli })
  s.synctex = svc

  const addBuild = (files: Record<string, Buffer | string>, meta: Partial<CompileResponse> = {}) => {
    const buildId = newBuildId()
    const dir = path.join(config.dirs.builds, project.id, buildId)
    fs.mkdirSync(dir, { recursive: true })
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content)
    const outputFiles = Object.keys(files).map(name => ({
      path: name, url: `/api/projects/${project.id}/builds/${buildId}/${name}`, size: 1,
      type: name.endsWith('.synctex.gz') ? 'synctex.gz' : name.slice(name.lastIndexOf('.') + 1),
    }))
    const full: Partial<CompileResponse> = { status: 'success', buildId, jobname: 'main', rootPath: 'main.tex', hasSynctex: true, outputFiles, ...meta }
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(full))
    return buildId
  }
  return { root, db, s, svc, pid: project.id, owner, viewer, outsider, addBuild, cliCalls }
}

const smallGz = () => fs.readFileSync(path.join(SHARED_FIXTURES, 'small.synctex.gz'))
const smallText = () => zlib.gunzipSync(smallGz()).toString('latin1')
const gzText = (t: string) => zlib.gzipSync(Buffer.from(t, 'latin1'))

describe('SynctexService', () => {
  let env: Env
  let buildId: string
  const reference = parseSynctexText(smallText())

  beforeAll(async () => {
    env = await makeEnv()
    buildId = env.addBuild({ 'main.synctex.gz': smallGz(), 'main.pdf': 'pdf' })
  })
  afterAll(async () => {
    env.db.close()
    await fsp.rm(env.root, { recursive: true, force: true })
  })

  it('code → PDF: rectangles for a line of an \\input file (same as the shared parser)', async () => {
    const r = await env.svc.codeToPdf(env.pid, buildId, 'chapters/intro.tex', 3, 0)
    expect(r.pdf.length).toBeGreaterThan(0)
    expect(r.pdf).toEqual(forwardSearch(reference, '/compile/./chapters/intro.tex', 3).slice(0, 100))
    expect(r.pdf[0].page).toBe(1)
    const p2 = await env.svc.codeToPdf(env.pid, buildId, 'chapters/results.tex', 19, 0)
    expect(p2.pdf[0].page).toBe(2)
    expect(env.cliCalls).toHaveLength(0)
  })

  it('PDF → code: project path, file id, line and column 0', async () => {
    const [rect] = (await env.svc.codeToPdf(env.pid, buildId, 'chapters/intro.tex', 3, 0)).pdf
    const r = await env.svc.pdfToCode(env.pid, buildId, rect.page, rect.x + 30, rect.y + rect.height / 2)
    const fileId = env.db.files.getByPath(env.pid, 'chapters/intro.tex')!.id
    expect(r.code[0]).toEqual({ path: 'chapters/intro.tex', fileId, line: 3, column: 0 })
    const js = inverseSearch(reference, rect.page, rect.x + 30, rect.y + rect.height / 2)
    expect(js[0].line).toBe(3)
  })

  it('files that were not part of the compile give no rectangles', async () => {
    expect(await env.svc.codeToPdf(env.pid, buildId, 'nothere.tex', 1, 0)).toEqual({ pdf: [] })
  })

  it('unknown builds and malformed ids are 404', async () => {
    await expect(env.svc.codeToPdf(env.pid, newBuildId(), 'main.tex', 1, 0)).rejects.toMatchObject({ status: 404 })
    await expect(env.svc.codeToPdf(env.pid, '../../etc', 'main.tex', 1, 0)).rejects.toBeInstanceOf(HttpError)
    await expect(env.svc.pdfToCode('bad/pid', buildId, 1, 1, 1)).rejects.toMatchObject({ status: 404 })
    const noSynctex = env.addBuild({ 'main.pdf': 'pdf' })
    await expect(env.svc.codeToPdf(env.pid, noSynctex, 'main.tex', 1, 0)).rejects.toMatchObject({ status: 404, message: 'This build has no SyncTeX data' })
  })

  it('caches parsed builds (one parse for concurrent requests) and can invalidate them', async () => {
    const id = env.addBuild({ 'main.synctex.gz': smallGz(), 'main.pdf': 'pdf' })
    const [a, b] = await Promise.all([env.svc.load(env.pid, id), env.svc.load(env.pid, id)])
    expect(a).toBe(b)
    expect(await env.svc.load(env.pid, id)).toBe(a)
    env.svc.invalidate(env.pid)
    expect(await env.svc.load(env.pid, id)).not.toBe(a)
    expect(a.compileRoot).toBe('/compile/')
    expect([...a.inputsByPath.keys()].sort()).toEqual(['chapters/intro.tex', 'chapters/results.tex', 'main.tex'])
  })

  it('maps a root document in a sub-folder (TeX ran in /compile/thesis)', async () => {
    const e2 = await makeEnv({ files: ['thesis/main.tex', 'thesis/chapters/intro.tex', 'thesis/chapters/results.tex'] })
    try {
      const text = smallText().replaceAll('/compile/./', '/compile/thesis/./')
      const id = e2.addBuild({ 'main.synctex.gz': gzText(text), 'main.pdf': 'pdf' }, { rootPath: 'thesis/main.tex' })
      const r = await e2.svc.codeToPdf(e2.pid, id, 'thesis/chapters/intro.tex', 3, 0)
      expect(r.pdf.length).toBeGreaterThan(0)
      const back = await e2.svc.pdfToCode(e2.pid, id, r.pdf[0].page, r.pdf[0].x + 30, r.pdf[0].y + r.pdf[0].height / 2)
      expect(back.code[0]).toMatchObject({ path: 'thesis/chapters/intro.tex', line: 3 })
    } finally {
      e2.db.close()
      await fsp.rm(e2.root, { recursive: true, force: true })
    }
  })

  it('maps host paths recorded by the local runner through the root document', async () => {
    const text = smallText().replaceAll('/compile/./', '/srv/folio/data/compiles/abc/./')
    const id = env.addBuild({ 'main.synctex.gz': gzText(text), 'main.pdf': 'pdf' })
    const b = await env.svc.load(env.pid, id)
    expect(b.compileRoot).toBe('/srv/folio/data/compiles/abc/')
    expect((await env.svc.codeToPdf(env.pid, id, 'main.tex', 10, 0)).pdf.length).toBeGreaterThan(0)
  })

  it('falls back to the CLI when the file cannot be parsed, and parses its output', async () => {
    const calls: SynctexCliRequest[] = []
    const cliOut = {
      view: ['This is SyncTeX command line utility, version 1.5', 'SyncTeX result begin', 'Output:/compile/main.pdf', 'Page:1',
        'x:144.586136', 'y:395.750092', 'h:125.798241', 'v:397.871307', 'W:358.655029', 'H:9.696959', 'before:', 'offset:-1',
        'middle:', 'after:', 'SyncTeX result end', ''].join('\n'),
      edit: ['This is SyncTeX command line utility, version 1.5', 'SyncTeX result begin', 'Output:/compile/main.pdf',
        'Input:/compile/./chapters/intro.tex', 'Line:3', 'Column:-1', 'Offset:0', 'Context:', 'SyncTeX result end', ''].join('\n'),
    }
    const e3 = await makeEnv({
      runCli: async req => {
        calls.push(req)
        const argv = req.args('/compile/main.pdf')
        return argv[0] === 'view' ? cliOut.view : cliOut.edit
      },
    })
    try {
      const id = e3.addBuild({ 'main.synctex.gz': Buffer.from('this is not gzip and not synctex'), 'main.pdf': 'pdf' })
      const f = await e3.svc.codeToPdf(e3.pid, id, 'chapters/intro.tex', 3, 0)
      expect(f.pdf).toEqual([{ page: 1, x: 125.798241, y: 397.871307 - 9.696959, width: 358.655029, height: 9.696959 }])
      expect(calls[0].args('/compile/main.pdf')).toEqual(['view', '-i', '3:0:/compile/chapters/intro.tex', '-o', '/compile/main.pdf'])
      expect(calls[0].buildDir).toBe(path.join(e3.s.config.dirs.builds, e3.pid, id))
      const inv = await e3.svc.pdfToCode(e3.pid, id, 1, 150.5, 390.25)
      expect(inv.code).toEqual([{ path: 'chapters/intro.tex', fileId: e3.db.files.getByPath(e3.pid, 'chapters/intro.tex')!.id, line: 3, column: 0 }])
      expect(calls[1].args('/compile/main.pdf')).toEqual(['edit', '-o', '1:150.5:390.25:/compile/main.pdf'])
    } finally {
      e3.db.close()
      await fsp.rm(e3.root, { recursive: true, force: true })
    }
  })

  it('without a CLI an unparseable file just gives no results', async () => {
    const e4 = await makeEnv({ runCli: null })
    try {
      const id = e4.addBuild({ 'main.synctex.gz': zlib.gzipSync(Buffer.from('garbage')), 'main.pdf': 'pdf' })
      expect(await e4.svc.codeToPdf(e4.pid, id, 'main.tex', 3, 0)).toEqual({ pdf: [] })
      expect(await e4.svc.pdfToCode(e4.pid, id, 1, 100, 100)).toEqual({ code: [] })
    } finally {
      e4.db.close()
      await fsp.rm(e4.root, { recursive: true, force: true })
    }
  })

  it('refuses decompression bombs (maxOutputLength) instead of exhausting memory', async () => {
    const bomb = zlib.gzipSync(Buffer.alloc(300 * 1024 * 1024, 0x20), { level: 9 })
    const id = env.addBuild({ 'main.synctex.gz': bomb, 'main.pdf': 'pdf' })
    const b = await env.svc.load(env.pid, id)
    expect(b.index).toBeNull()
    expect((await env.svc.codeToPdf(env.pid, id, 'main.tex', 1, 0)).pdf).toEqual([])
  }, 60_000)

  it('parseCliOutput splits records on Output lines', () => {
    const recs = parseCliOutput('junk\nSyncTeX result begin\nOutput:a.pdf\nInput:/x/./a.tex\nLine:3\nOutput:a.pdf\nInput:/x/./b.tex\nLine:7\nSyncTeX result end\nOutput:ignored\n')
    expect(recs).toEqual([{ Input: '/x/./a.tex', Line: '3' }, { Input: '/x/./b.tex', Line: '7' }])
  })
})

describe('synctex routes', () => {
  let env: Env
  let buildId: string
  let server: import('node:http').Server
  let base: string
  const cookies: Record<string, string> = {}

  beforeAll(async () => {
    env = await makeEnv()
    buildId = env.addBuild({ 'main.synctex.gz': smallGz(), 'main.pdf': 'pdf' })
    const app = express()
    app.locals.services = env.s
    app.use(loadSession)
    app.use(synctexRoutes(env.s))
    app.use(((err, _req, res, _next) => {
      const status = err instanceof HttpError ? err.status : 500
      res.status(status).json({ error: { code: err instanceof HttpError ? err.code : 'internal', message: String(err?.message) } })
    }) as express.ErrorRequestHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', () => resolve()))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    for (const who of ['owner', 'viewer', 'outsider'] as const) {
      cookies[who] = `folio_session=${createSession(env.db, env.s.config, env[who]).token}`
    }
  })
  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    env.db.close()
    await fsp.rm(env.root, { recursive: true, force: true })
  })

  const get = (p: string, who: 'owner' | 'viewer' | 'outsider' | null = 'viewer') =>
    fetch(base + p, { headers: who ? { cookie: cookies[who] } : {} })

  it('viewers can sync both ways', async () => {
    const code = await get(`/api/projects/${env.pid}/synctex/code?buildId=${buildId}&path=chapters%2Fintro.tex&line=3&column=0`)
    expect(code.status).toBe(200)
    expect(code.headers.get('cache-control')).toMatch(/no-store/)
    const body = await code.json() as { pdf: { page: number; x: number; y: number; width: number; height: number }[] }
    expect(body.pdf[0].page).toBe(1)
    const r = body.pdf[0]
    const pdf = await get(`/api/projects/${env.pid}/synctex/pdf?buildId=${buildId}&page=${r.page}&x=${(r.x + 30).toFixed(3)}&y=${(r.y + r.height / 2).toFixed(3)}`)
    expect(pdf.status).toBe(200)
    const back = await pdf.json() as { code: { path: string; line: number }[] }
    expect(back.code[0]).toMatchObject({ path: 'chapters/intro.tex', line: 3 })
    // column is optional
    expect((await get(`/api/projects/${env.pid}/synctex/code?buildId=${buildId}&path=main.tex&line=10`, 'owner')).status).toBe(200)
  })

  it('requires a member session', async () => {
    expect((await get(`/api/projects/${env.pid}/synctex/code?buildId=${buildId}&path=main.tex&line=1`, null)).status).toBe(401)
    expect((await get(`/api/projects/${env.pid}/synctex/code?buildId=${buildId}&path=main.tex&line=1`, 'outsider')).status).toBe(404)
  })

  it('validates parameters strictly', async () => {
    const q = (s: string) => get(`/api/projects/${env.pid}/synctex/${s}`)
    const bad = [
      `code?path=main.tex&line=1`,
      `code?buildId=nope&path=main.tex&line=1`,
      `code?buildId=${buildId}&line=1`,
      `code?buildId=${buildId}&path=main.tex&line=0`,
      `code?buildId=${buildId}&path=main.tex&line=1.5`,
      `code?buildId=${buildId}&path=main.tex&line=-3`,
      `code?buildId=${buildId}&path=main.tex&line=1e3`,
      `code?buildId=${buildId}&path=main.tex&line=1&line=2`,
      `code?buildId=${buildId}&path=main.tex&line=1&column=x`,
      `code?buildId=${buildId}&path=..%2Fetc%2Fpasswd&line=1`,
      `code?buildId=${buildId}&path=%2Fetc%2Fpasswd%2F..&line=1`,
      `pdf?buildId=${buildId}&page=1&x=10`,
      `pdf?buildId=${buildId}&page=one&x=10&y=10`,
      `pdf?buildId=${buildId}&page=1&x=1e3&y=10`,
      `pdf?buildId=${buildId}&page=1&x=Infinity&y=10`,
      `pdf?buildId=${buildId}&page=1&x=10&y=0x10`,
      `pdf?buildId=${buildId}&page=1&x=10&y=999999`,
    ]
    for (const b of bad) {
      const res = await q(b)
      expect([b, res.status]).toEqual([b, 400])
    }
    expect((await q(`pdf?buildId=${buildId}&page=1&x=-5.25&y=10`)).status).toBe(200)
    expect((await q(`code?buildId=${newBuildId()}&path=main.tex&line=1`)).status).toBe(404)
  })
})

describe.skipIf(!DOCKER)('synctex CLI fallback in the TeX Live sandbox (docker)', () => {
  let env: Env
  let buildId: string

  beforeAll(async () => {
    env = await makeEnv({ runner: 'docker', runCli: null })
    buildId = env.addBuild({ 'main.synctex.gz': smallGz(), 'main.pdf': fs.readFileSync(path.join(HERE, 'small-main.pdf')) })
  })
  afterAll(async () => {
    env.db.close()
    await fsp.rm(env.root, { recursive: true, force: true })
  })

  it('agrees with the JS parser', async () => {
    const cli = dockerSynctexCli(env.s, {
      name: () => `folio-shared-parsers-${randomBytes(6).toString('hex')}`,
      labels: { 'folio.test': 'shared-parsers' },
    })
    const withCli = createSynctexService(env.s, { runCli: cli })
    const b = await withCli.load(env.pid, buildId)
    const js = await env.svc.codeToPdf(env.pid, buildId, 'chapters/intro.tex', 3, 0)
    b.index = null // force the CLI path
    const viaCli = await withCli.codeToPdf(env.pid, buildId, 'chapters/intro.tex', 3, 0)
    expect(viaCli.pdf.length).toBeGreaterThan(0)
    expect(viaCli.pdf[0].page).toBe(js.pdf[0].page)
    expect(Math.abs(viaCli.pdf[0].y - js.pdf[0].y)).toBeLessThan(1)
    const r = js.pdf[0]
    const inv = await withCli.pdfToCode(env.pid, buildId, r.page, r.x + 30, r.y + r.height / 2)
    expect(inv.code[0]).toMatchObject({ path: 'chapters/intro.tex', line: 3, column: 0 })
  }, 120_000)
})
