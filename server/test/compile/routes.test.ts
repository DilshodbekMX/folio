/**
 * compileRoutes over HTTP (ephemeral port) with the fake runner: roles, validation, output file
 * serving (Range, caching headers, traversal), last build, word count, EPS preview.
 */
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CompileResponse } from '@folio/shared/api'
import { compileRoutes } from '../../src/compile/routes.ts'
import { FakeRunner } from '../../src/compile/runner.ts'
import { errorHandler } from '../../src/http/error-handler.ts'
import { HELLO_TEX, makeEnv, type TestEnv } from './helpers.ts'

let env: TestEnv
let server: Server
let base: string
let epsId: string

beforeAll(async () => {
  env = await makeEnv({ runner: new FakeRunner({ delayMs: 10 }), userGuardMs: 0 })
  env.write('main.tex', HELLO_TEX)
  epsId = env.write('logo.eps', Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\n')).id
  const app = express()
  app.locals.services = env.s
  app.use(express.json())
  // stand-in for the session loader: the tests pick the user with a header
  app.use((req, _res, next) => {
    const id = req.header('x-test-user')
    if (id) req.user = env.db.users.get(id) ?? undefined
    next()
  })
  app.use(compileRoutes(env.s))
  app.use(errorHandler)
  server = app.listen(0, '127.0.0.1')
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise(r => server?.close(r))
  await env?.close()
})

function call(method: string, path: string, user: string | null, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(base + path, {
    method,
    headers: { ...(user ? { 'x-test-user': user } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}

describe('compile routes', () => {
  let build: CompileResponse

  it('GET compile/last is 204 before the first build', async () => {
    const r = await call('GET', `/api/projects/${env.pid}/compile/last`, env.viewer.id)
    expect(r.status).toBe(204)
  })

  it('POST compile is open to viewers (like Overleaf), but not "from scratch"', async () => {
    expect((await call('POST', `/api/projects/${env.pid}/compile`, null, {})).status).toBe(401)
    expect((await call('POST', `/api/projects/${env.pid}/compile`, env.outsider.id, {})).status).toBe(404)
    const byViewer = await call('POST', `/api/projects/${env.pid}/compile`, env.viewer.id, {})
    expect(byViewer.status).toBe(200)
    expect(((await byViewer.json()) as CompileResponse)).toMatchObject({ status: 'success', by: { id: env.viewer.id } })
    const scratch = await call('POST', `/api/projects/${env.pid}/compile`, env.viewer.id, { fromScratch: true })
    expect(scratch.status).toBe(403)
    const bad = await call('POST', `/api/projects/${env.pid}/compile`, env.editor.id, { draft: 'yes' })
    expect(bad.status).toBe(400)
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe('validation')
    const r = await call('POST', `/api/projects/${env.pid}/compile`, env.editor.id, { draft: false })
    expect(r.status).toBe(200)
    build = (await r.json()) as CompileResponse
    expect(build.status).toBe('success')
    expect(build.by?.id).toBe(env.editor.id)
  })

  it('GET compile/last returns the build for viewers', async () => {
    const r = await call('GET', `/api/projects/${env.pid}/compile/last`, env.viewer.id)
    expect(r.status).toBe(200)
    expect(((await r.json()) as CompileResponse).buildId).toBe(build.buildId)
  })

  it('serves build files with immutable caching and Range support', async () => {
    const r = await call('GET', build.pdfUrl!, env.viewer.id)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('application/pdf')
    expect(r.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    expect(r.headers.get('accept-ranges')).toBe('bytes')
    const pdf = Buffer.from(await r.arrayBuffer())
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    const part = await call('GET', build.pdfUrl!, env.viewer.id, undefined, { range: 'bytes=0-4' })
    expect(part.status).toBe(206)
    expect(await part.text()).toBe('%PDF-')
    const logRes = await call('GET', build.logUrl!, env.viewer.id)
    expect(logRes.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await logRes.text()).toMatch(/This is pdfTeX/)
    const meta = await call('GET', `/api/projects/${env.pid}/builds/${build.buildId}/meta.json`, env.viewer.id)
    expect(meta.status).toBe(200)
  })

  it('rejects bad build ids, names and traversal; hides builds from outsiders', async () => {
    const p = `/api/projects/${env.pid}/builds`
    for (const url of [
      `${p}/${build.buildId}/missing.pdf`,
      `${p}/${build.buildId}/..%2F..%2F..%2Fdb.sqlite`,
      `${p}/${build.buildId}/%2e%2e`,
      `${p}/not-a-build/main.pdf`,
      `${p}/${build.buildId}/.hidden`,
    ]) {
      const r = await call('GET', url, env.owner.id)
      expect(r.status, url).toBe(404)
    }
    expect((await call('GET', build.pdfUrl!, env.outsider.id)).status).toBe(404)
    expect((await call('GET', build.pdfUrl!, null)).status).toBe(401)
  })

  it('wordcount (viewer+)', async () => {
    const r = await call('GET', `/api/projects/${env.pid}/wordcount`, env.viewer.id)
    expect(r.status).toBe(200)
    expect(await r.json()).toMatchObject({ rootPath: 'main.tex', textWords: 12 })
    const bad = await call('GET', `/api/projects/${env.pid}/wordcount?rootFileId=${'x'.repeat(16)}`, env.viewer.id)
    expect(bad.status).toBe(400)
  })

  it('EPS preview (viewer+) returns a PNG and supports conditional requests', async () => {
    const r = await call('GET', `/api/projects/${env.pid}/files/${epsId}/preview`, env.viewer.id)
    expect(r.status).toBe(200)
    expect(r.headers.get('content-type')).toBe('image/png')
    const png = Buffer.from(await r.arrayBuffer())
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    const etag = r.headers.get('etag')
    expect(etag).toBeTruthy()
    // (fetch adds `Cache-Control: no-cache` to conditional requests unless one is given — browsers revalidating <img> do not)
    const again = await call('GET', `/api/projects/${env.pid}/files/${epsId}/preview`, env.viewer.id, undefined, { 'if-none-match': etag!, 'cache-control': 'max-age=0' })
    expect(again.status).toBe(304)
    const tex = await call('GET', `/api/projects/${env.pid}/files/${env.fileId('main.tex')}/preview`, env.viewer.id)
    expect(tex.status).toBe(400)
    expect((await call('GET', `/api/projects/${env.pid}/files/${epsId}/preview`, env.outsider.id)).status).toBe(404)
  })

  it('stop and clear cache require editor', async () => {
    expect((await call('POST', `/api/projects/${env.pid}/compile/stop`, env.viewer.id)).status).toBe(403)
    expect((await call('POST', `/api/projects/${env.pid}/compile/stop`, env.editor.id)).status).toBe(204)
    expect((await call('DELETE', `/api/projects/${env.pid}/compile/cache`, env.viewer.id)).status).toBe(403)
    expect((await call('DELETE', `/api/projects/${env.pid}/compile/cache`, env.editor.id)).status).toBe(204)
    expect((await call('GET', build.pdfUrl!, env.viewer.id)).status).toBe(404)
    expect((await call('GET', `/api/projects/${env.pid}/compile/last`, env.viewer.id)).status).toBe(204)
  })
})
