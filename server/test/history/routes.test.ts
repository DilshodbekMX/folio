import express, { type NextFunction, type Request, type Response } from 'express'
import type { AddressInfo } from 'node:net'
import type { Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import type { HistoryDiffResponse, HistoryFilesResponse, HistoryListResponse, Label, RestoreResponse, UserPublic } from '@folio/shared/api'
import { toPublic } from '../../src/db/index.ts'
import { HttpError } from '../../src/http/errors.ts'
import { contentDisposition, historyRoutes, safeFileStem, versionZipName } from '../../src/history/routes.ts'
import { setup, unzip, type Harness } from './helpers.ts'

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64')

let h: Harness
let server: Server
let base: string
let eve: UserPublic

beforeEach(async () => {
  h = await setup()
  h.db.projects.rename(h.pid, 'Thèse / final: v2')
  h.db.members.upsert(h.pid, h.alice.id, 'editor')
  h.db.members.upsert(h.pid, h.bob.id, 'viewer')
  eve = toPublic(h.db.users.create({ email: 'eve@example.org', name: 'Eve', passwordHash: 'x' }))

  await h.put('main.tex', 'v1\n')
  await h.put('fig.png', PNG)
  await h.put('logo.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')
  await h.history.init(h.pid, h.owner)

  const app = express()
  app.locals.services = h.s
  app.use(express.json())
  // stands in for the session loader: the test picks the user with a header
  app.use((req, _res, next) => {
    const id = req.get('x-test-user')
    if (id) req.user = h.db.users.get(id) ?? undefined
    next()
  })
  app.use(historyRoutes(h.s))
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof HttpError) return void res.status(err.status).json({ error: { code: err.code, message: err.message } })
    if (err instanceof ZodError) return void res.status(400).json({ error: { code: 'validation', message: 'Invalid request' } })
    res.status(500).json({ error: { code: 'internal', message: String(err) } })
  })
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', () => resolve()))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/${h.pid}/history`
})

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>(resolve => server.close(() => resolve()))
  await h.cleanup()
})

function call(method: string, url: string, user: UserPublic | null, body?: unknown): Promise<globalThis.Response> {
  const headers: Record<string, string> = {}
  if (user) headers['x-test-user'] = user.id
  if (body !== undefined) headers['content-type'] = 'application/json'
  return fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) })
}

describe('history routes', () => {
  it('enforces authentication and roles', async () => {
    expect((await call('GET', `${base}/versions`, null)).status).toBe(401)
    expect((await call('GET', `${base}/versions`, eve)).status).toBe(404)
    expect((await call('GET', `${base}/versions`, h.bob)).status).toBe(200)
    const head = ((await (await call('GET', `${base}/versions`, h.bob)).json()) as HistoryListResponse).versions[0].id
    expect((await call('POST', `${base}/restore`, h.bob, { versionId: head })).status).toBe(403)
    expect((await call('POST', `${base}/snapshot`, h.bob)).status).toBe(403)
    expect((await call('POST', `${base}/labels`, h.bob, { name: 'x' })).status).toBe(403)
    expect((await call('DELETE', `${base}/labels/abcdefghijklmnop`, h.bob)).status).toBe(403)
    expect((await call('GET', `http://${new URL(base).host}/api/projects/nonexistent00000/history/versions`, h.owner)).status).toBe(404)
  })

  it('lists versions, files, diffs and snapshots', async () => {
    await h.put('main.tex', 'v2\n')
    const snap = await call('POST', `${base}/snapshot`, h.alice)
    expect(snap.status).toBe(200)
    const { versionId } = await snap.json() as { versionId: string }
    expect(versionId).toMatch(/^[0-9a-f]{40}$/)
    expect(await (await call('POST', `${base}/snapshot`, h.alice)).json()).toEqual({ versionId: null })

    const list = await (await call('GET', `${base}/versions?limit=1`, h.bob)).json() as HistoryListResponse
    expect(list.hasMore).toBe(true)
    expect(list.versions[0]).toMatchObject({ id: versionId, reason: 'manual', authors: [h.alice] })
    const next = await (await call('GET', `${base}/versions?limit=1&before=${versionId}`, h.bob)).json() as HistoryListResponse
    expect(next.hasMore).toBe(false)
    expect(next.versions[0].reason).toBe('import')

    const files = await (await call('GET', `${base}/versions/${versionId}/files`, h.bob)).json() as HistoryFilesResponse
    expect(files.files.map(f => [f.path, f.binary]).sort()).toEqual([['fig.png', true], ['logo.svg', true], ['main.tex', false]])

    const diff = await (await call('GET', `${base}/diff?to=${versionId}&path=main.tex`, h.bob)).json() as HistoryDiffResponse
    expect(diff).toMatchObject({ oldText: 'v1\n', newText: 'v2\n', binary: false })

    expect((await call('GET', `${base}/versions?limit=0`, h.bob)).status).toBe(400)
    expect((await call('GET', `${base}/versions?before=--all`, h.bob)).status).toBe(400)
    expect((await call('GET', `${base}/versions/--help/files`, h.bob)).status).toBe(400)
    expect((await call('GET', `${base}/diff?to=${versionId}`, h.bob)).status).toBe(400)
    expect((await call('GET', `${base}/diff?to=${versionId}&path=nope.tex`, h.bob)).status).toBe(404)
  })

  it('serves historical file bytes with safe headers', async () => {
    const png = await call('GET', `${base}/versions/HEAD/file?path=fig.png`, h.bob)
    expect(png.status).toBe(200)
    expect(png.headers.get('content-type')).toBe('image/png')
    expect(png.headers.get('x-content-type-options')).toBe('nosniff')
    expect(png.headers.get('content-disposition')).toBe('inline; filename="fig.png"')
    expect(png.headers.get('cache-control')).toBe('private, no-cache')
    expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true)

    const head = ((await (await call('GET', `${base}/versions`, h.bob)).json()) as HistoryListResponse).versions[0].id
    const svg = await call('GET', `${base}/versions/${head}/file?path=logo.svg`, h.bob)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(svg.headers.get('content-disposition')).toMatch(/^attachment;/)
    expect(svg.headers.get('content-security-policy')).toBe('sandbox')
    expect(svg.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')

    const tex = await call('GET', `${base}/versions/${head}/file?path=main.tex`, h.bob)
    expect(tex.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(tex.headers.get('content-disposition')).toBe('attachment; filename="main.tex"')
    expect(await tex.text()).toBe('v1\n')

    const dl = await call('GET', `${base}/versions/${head}/file?path=fig.png&download=1`, h.bob)
    expect(dl.headers.get('content-disposition')).toMatch(/^attachment;/)

    expect((await call('GET', `${base}/versions/${head}/file?path=missing.tex`, h.bob)).status).toBe(404)
    expect((await call('GET', `${base}/versions/${head}/file?path=../../etc/passwd`, h.bob)).status).toBe(400)
    expect((await call('GET', `${base}/versions/${head}/file`, h.bob)).status).toBe(400)
  })

  it('downloads a version as a zip, named after its label or its time', async () => {
    const version = ((await (await call('GET', `${base}/versions`, h.bob)).json()) as HistoryListResponse).versions[0]
    const head = version.id
    const res = await call('GET', `${base}/versions/${head}/download.zip`, h.bob)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    // never the commit hash: "<project> - YYYY-MM-DD HH.MM.zip" (commit time, server time zone)
    const d = new Date(version.createdAt)
    const p2 = (n: number) => String(n).padStart(2, '0')
    const when = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}`
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="Th_se final v2 - ${when}.zip"; filename*=UTF-8''Th%C3%A8se%20final%20v2%20-%20${encodeURIComponent(when)}.zip`,
    )
    const zip = await unzip(Buffer.from(await res.arrayBuffer()))
    expect([...zip.keys()].sort()).toEqual(['fig.png', 'logo.svg', 'main.tex'])
    expect((await call('GET', `${base}/versions/${'0'.repeat(40)}/download.zip`, h.bob)).status).toBe(404)

    // a labelled version is named after its newest label
    expect((await call('POST', `${base}/labels`, h.alice, { name: 'Submitted: v1', versionId: head })).status).toBe(201)
    const labelled = await call('GET', `${base}/versions/${head}/download.zip`, h.bob)
    expect(labelled.headers.get('content-disposition')).toBe(
      `attachment; filename="Th_se final v2 - Submitted v1.zip"; filename*=UTF-8''Th%C3%A8se%20final%20v2%20-%20Submitted%20v1.zip`,
    )
    await labelled.arrayBuffer()
  })

  it('restores and manages labels', async () => {
    const v1 = ((await (await call('GET', `${base}/versions`, h.alice)).json()) as HistoryListResponse).versions[0].id
    await h.put('main.tex', 'changed\n')
    const res = await call('POST', `${base}/restore`, h.alice, { versionId: v1, path: 'main.tex' })
    expect(res.status).toBe(200)
    const body = await res.json() as RestoreResponse
    expect(body.restored).toEqual(['main.tex'])
    expect(h.collab.setTextCalls.at(-1)).toMatchObject({ path: 'main.tex', text: 'v1\n' })
    expect((await call('POST', `${base}/restore`, h.alice, {})).status).toBe(400)

    const created = await call('POST', `${base}/labels`, h.alice, { name: 'Camera ready' })
    expect(created.status).toBe(201)
    const label = await created.json() as Label
    expect(label).toMatchObject({ name: 'Camera ready', versionId: body.versionId, user: h.alice })
    const older = await (await call('POST', `${base}/labels`, h.owner, { name: 'Old', versionId: v1 })).json() as Label
    expect(older.versionId).toBe(v1)
    expect((await call('POST', `${base}/labels`, h.alice, { name: '' })).status).toBe(400)

    const list = await (await call('GET', `${base}/versions`, h.bob)).json() as HistoryListResponse
    expect(list.versions.find(v => v.id === body.versionId)!.labels.map(l => l.name)).toEqual(['Camera ready'])

    expect((await call('DELETE', `${base}/labels/${label.id}`, h.alice)).status).toBe(204)
    expect((await call('DELETE', `${base}/labels/${label.id}`, h.alice)).status).toBe(404)
  })
})

describe('header helpers', () => {
  it('builds RFC 6266 dispositions and safe names', () => {
    expect(contentDisposition('attachment', 'a.zip')).toBe('attachment; filename="a.zip"')
    expect(contentDisposition('inline', 'ü "x".png')).toBe(`inline; filename="_ _x_.png"; filename*=UTF-8''%C3%BC%20_x_.png`)
    expect(contentDisposition('attachment', 'a\r\nb/c.zip')).toBe('attachment; filename="a__b_c.zip"')
    expect(safeFileStem('  ../../etc/passwd ')).toBe('etc passwd')
    expect(safeFileStem('\u0000')).toBe('project')
    expect(versionZipName('P', { labels: [], createdAt: null, fallback: 'abc1234' })).toBe('P - abc1234.zip')
    expect(versionZipName('P', { labels: [{ name: 'old', createdAt: 1 }, { name: 'new/one', createdAt: 2 }], createdAt: null, fallback: 'x' })).toBe('P - new one.zip')
  })
})
