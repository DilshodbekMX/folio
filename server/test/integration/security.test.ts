/**
 * Security regression suite against the whole server (every route module mounted, real services):
 *
 *  - access matrix generated from the ROUTES table (a new route without an entry fails the test):
 *    anonymous → 401, non-member → 404, viewer on editor routes → 403, editor on owner routes → 403,
 *    non-admin on admin routes → 403;
 *  - CSRF: every state-changing route refuses a missing X-Folio-Csrf header and a foreign Origin;
 *  - IDOR: ids of another project (file, build, label, member, version, main document) → 404/400;
 *  - served user content: header-injection-proof Content-Disposition, nosniff, no active content;
 *  - upload request caps; the local TeX runner never sees the server's environment.
 */
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ROUTES, type CompileResponse, type HistoryListResponse, type Label } from '@folio/shared/api'
import type { UserRecord } from '../../src/db/index.ts'
import { createSession } from '../../src/auth/sessions.ts'
import { localTexEnv } from '../../src/compile/runner.ts'
import { Client } from '../foundation/helpers.ts'
import { startFullServer, type FullServer } from './harness.ts'

type RouteKey = keyof typeof ROUTES
type Access = 'public' | 'user' | 'admin' | 'viewer' | 'editor' | 'owner'

/** Minimum access of every route (viewer-level routes may still refuse certain bodies). */
const ACCESS: Record<RouteKey, Access> = {
  health: 'public', system: 'user',
  setupStatus: 'public', setup: 'public', register: 'public', login: 'public', logout: 'public', me: 'user', updateMe: 'user',
  listProjects: 'user', createProject: 'user', uploadProject: 'user',
  getProject: 'viewer', updateProject: 'viewer', deleteProject: 'viewer', copyProject: 'viewer', downloadProject: 'viewer',
  createEntry: 'editor', uploadFiles: 'editor', moveEntry: 'editor', deleteEntry: 'editor', rawFile: 'viewer', previewFile: 'viewer', search: 'viewer',
  // viewers may compile (like Overleaf; compile/routes.ts), not recompile from scratch, stop or clear the cache
  compile: 'viewer', stopCompile: 'editor', clearCache: 'editor', lastCompile: 'viewer', buildFile: 'viewer', wordCount: 'viewer', syncCode: 'viewer', syncPdf: 'viewer',
  historyVersions: 'viewer', historyFiles: 'viewer', historyFile: 'viewer', historyDownload: 'viewer', historyDiff: 'viewer',
  historyRestore: 'editor', historySnapshot: 'editor', createLabel: 'editor', deleteLabel: 'editor',
  shareInfo: 'viewer', addMember: 'owner', updateMember: 'owner', removeMember: 'viewer', createShareLink: 'owner', deleteShareLink: 'owner',
  shareTokenInfo: 'user', joinShareToken: 'user',
  chatList: 'viewer', chatPost: 'viewer',
  adminUsers: 'admin', adminCreateUser: 'admin', adminDeleteUser: 'admin',
}

describe('security regression (whole server)', () => {
  let t: FullServer
  let owner: UserRecord
  let editor: UserRecord
  let viewer: UserRecord
  let outsider: UserRecord
  let O: Client, E: Client, V: Client, X: Client, anon: Client
  let pid: string // owner's project (editor + viewer are members)
  let other: string // outsider's project
  let fileId: string, otherFileId: string
  let buildId: string, otherBuildId: string
  let versionId: string, otherVersionId: string
  let labelId: string, otherLabelId: string
  let token: string

  const as = (u: UserRecord) => {
    const c = new Client(t.base)
    c.cookie = `folio_session=${createSession(t.services.db, t.services.config, u.id).token}`
    return c
  }

  beforeAll(async () => {
    t = await startFullServer()
    owner = await t.makeUser('owner@example.com', 'Owner', true)
    editor = await t.makeUser('editor@example.com', 'Editor')
    viewer = await t.makeUser('viewer@example.com', 'Viewer')
    outsider = await t.makeUser('outsider@example.com', 'Outsider')
    O = as(owner)
    E = as(editor)
    V = as(viewer)
    X = as(outsider)
    anon = new Client(t.base)
    pid = (await O.post('/api/projects', { name: 'Secure', template: 'example' })).body.id
    other = (await X.post('/api/projects', { name: 'Other', template: 'example' })).body.id
    await O.post(`/api/projects/${pid}/members`, { email: 'editor@example.com', role: 'editor' })
    await O.post(`/api/projects/${pid}/members`, { email: 'viewer@example.com', role: 'viewer' })
    fileId = t.services.files.getByPath(pid, 'main.tex')!.id
    otherFileId = t.services.files.getByPath(other, 'main.tex')!.id
    buildId = (await O.post<CompileResponse>(`/api/projects/${pid}/compile`, {})).body.buildId!
    otherBuildId = (await X.post<CompileResponse>(`/api/projects/${other}/compile`, {})).body.buildId!
    versionId = (await O.get<HistoryListResponse>(`/api/projects/${pid}/history/versions`)).body.versions[0].id
    otherVersionId = (await X.get<HistoryListResponse>(`/api/projects/${other}/history/versions`)).body.versions[0].id
    labelId = (await O.post<Label>(`/api/projects/${pid}/history/labels`, { name: 'v1', versionId })).body.id
    otherLabelId = (await X.post<Label>(`/api/projects/${other}/history/labels`, { name: 'x', versionId: otherVersionId })).body.id
    token = (await O.post(`/api/projects/${pid}/share-links`, { role: 'viewer' })).body.viewer
    expect([buildId, otherBuildId, versionId, labelId, token].every(Boolean)).toBe(true)
  })
  afterAll(async () => {
    await t?.close()
  })

  /** Concrete request for a route key (ids of the owner's project). */
  function request(key: RouteKey): { method: string; path: string; body?: unknown } {
    const [method, pattern] = ROUTES[key].split(' ')
    const params: Record<string, string> = {
      pid, fileId, buildId, file: 'main.pdf', versionId, labelId, userId: editor.id, role: 'viewer', token,
    }
    let p = pattern.replace(/:([A-Za-z]+)/g, (_, name: string) => encodeURIComponent(params[name]))
    const query: Partial<Record<RouteKey, string>> = {
      search: '?q=section', syncCode: `?buildId=${buildId}&path=main.tex&line=1`, syncPdf: `?buildId=${buildId}&page=1&x=10&y=10`,
      historyFile: '?path=main.tex', historyDiff: `?to=${versionId}&path=main.tex`,
    }
    p += query[key] ?? ''
    const bodies: Partial<Record<RouteKey, unknown>> = {
      createEntry: { path: 'new.tex', kind: 'text' }, moveEntry: { path: 'moved.tex' }, updateProject: { name: 'Renamed' },
      copyProject: { name: 'Copy' }, createProject: { name: 'P', template: 'blank' }, chatPost: { content: 'hi' },
      addMember: { email: 'outsider@example.com', role: 'viewer' }, updateMember: { role: 'viewer' }, createShareLink: { role: 'editor' },
      createLabel: { name: 'L' }, historyRestore: { versionId, path: 'main.tex' },
    }
    return { method, path: p, body: method === 'GET' ? undefined : bodies[key] ?? {} }
  }

  async function send(c: Client, key: RouteKey): Promise<number> {
    const r = request(key)
    if (r.method === 'GET') return (await c.raw('GET', r.path)).status
    return (await c.req(r.method, r.path, r.body)).status
  }

  it('the access table covers every route', () => {
    expect(Object.keys(ACCESS).sort()).toEqual(Object.keys(ROUTES).sort())
  })

  it('anonymous requests are refused with 401 everywhere except the public routes', async () => {
    for (const key of Object.keys(ROUTES) as RouteKey[]) {
      if (ACCESS[key] === 'public') continue
      expect(await send(anon, key), key).toBe(401)
    }
  })

  it('non-members get 404 on every project route (no existence leak)', async () => {
    for (const key of Object.keys(ROUTES) as RouteKey[]) {
      if (!['viewer', 'editor', 'owner'].includes(ACCESS[key])) continue
      expect(await send(X, key), key).toBe(404)
    }
  })

  it('viewers get 403 on every editor/owner route; editors on every owner route', async () => {
    for (const key of Object.keys(ROUTES) as RouteKey[]) {
      if (ACCESS[key] === 'editor' || ACCESS[key] === 'owner') expect(await send(V, key), `viewer ${key}`).toBe(403)
      if (ACCESS[key] === 'owner') expect(await send(E, key), `editor ${key}`).toBe(403)
    }
    // viewer-level routes that refuse writes in their body
    expect((await V.patch(`/api/projects/${pid}`, { name: 'x' })).status).toBe(403)
    expect((await V.patch(`/api/projects/${pid}`, { settings: { compiler: 'xelatex' } })).status).toBe(403)
    expect((await V.del(`/api/projects/${pid}/members/${editor.id}`)).status).toBe(403)
    expect((await E.patch(`/api/projects/${pid}`, { name: 'x' })).status).toBe(403)
    // …while their own per-user flags are allowed
    expect((await V.patch(`/api/projects/${pid}`, { archived: true })).status).toBe(200)
    expect((await V.patch(`/api/projects/${pid}`, { archived: false })).status).toBe(200)
  })

  it('admin routes need an administrator', async () => {
    for (const key of ['adminUsers', 'adminCreateUser', 'adminDeleteUser'] as RouteKey[]) {
      expect(await send(E, key), key).toBe(403)
    }
    expect((await O.get('/api/admin/users')).status).toBe(200)
  })

  it('every state-changing route requires the CSRF header and a same-origin Origin', async () => {
    for (const key of Object.keys(ROUTES) as RouteKey[]) {
      const r = request(key)
      if (r.method === 'GET') continue
      const noHeader = await fetch(t.base + r.path, { method: r.method, headers: { cookie: O.cookie!, origin: t.base, 'content-type': 'application/json' }, body: JSON.stringify(r.body ?? {}) })
      expect(noHeader.status, `${key} without header`).toBe(403)
      const crossSite = await fetch(t.base + r.path, { method: r.method, headers: { cookie: O.cookie!, origin: 'https://evil.example', 'X-Folio-Csrf': '1', 'content-type': 'application/json' }, body: JSON.stringify(r.body ?? {}) })
      expect(crossSite.status, `${key} cross-origin`).toBe(403)
    }
  })

  it('ids of another project are never honoured (IDOR)', async () => {
    const P = `/api/projects/${pid}`
    expect((await O.get(`${P}/files/${otherFileId}/raw`)).status).toBe(404)
    expect((await O.get(`${P}/files/${otherFileId}/preview`)).status).toBe(404)
    expect((await O.patch(`${P}/files/${otherFileId}`, { path: 'stolen.tex' })).status).toBe(404)
    expect((await O.del(`${P}/files/${otherFileId}`)).status).toBe(404)
    expect((await O.get(`${P}/builds/${otherBuildId}/main.pdf`)).status).toBe(404)
    expect((await O.get(`${P}/synctex/pdf?buildId=${otherBuildId}&page=1&x=1&y=1`)).status).toBe(404)
    expect((await O.del(`${P}/history/labels/${otherLabelId}`)).status).toBe(404)
    expect((await O.get(`${P}/history/versions/${otherVersionId}/files`)).status).toBe(404)
    expect((await O.post(`${P}/history/restore`, { versionId: otherVersionId })).status).toBe(404)
    expect((await O.patch(`${P}/members/${outsider.id}`, { role: 'editor' })).status).toBe(404)
    expect((await O.post(`${P}/compile`, { rootFileId: otherFileId })).status).toBe(400)
    expect((await O.patch(P, { settings: { rootFileId: otherFileId } })).status).toBe(400)
    expect((await O.get(`${P}/wordcount?rootFileId=${otherFileId}`)).status).toBe(400)
    // and the other project is untouched
    expect(t.services.files.get(other, otherFileId)?.path).toBe('main.tex')
    expect(t.services.db.labels.get(otherLabelId)).not.toBeNull()
  })

  it('serves user files without header injection or active content', async () => {
    const P = `/api/projects/${pid}`
    const weird = 'we"ird; name=x.png'
    const form = new FormData()
    form.append('folder', '')
    form.append('files', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])]), weird)
    form.append('files', new Blob(['alert(document.cookie)']), 'evil.js')
    form.append('files', new Blob(['<script>alert(1)</script>']), 'evil.html')
    expect((await O.upload(`${P}/upload`, form)).status).toBe(200)
    for (const [name, download] of [[weird, false], [weird, true]] as const) {
      const f = t.services.files.getByPath(pid, name)!
      const r = await O.raw('GET', `${P}/files/${f.id}/raw${download ? '?download=1' : ''}`)
      const cd = r.headers.get('content-disposition')!
      expect(cd).not.toMatch(/[\r\n]/)
      // the quote can never terminate the quoted-string: escaped (attachment) or replaced + filename* (inline)
      if (download) expect(cd).toBe('attachment; filename="we\\"ird; name=x.png"')
      else expect(cd).toBe(`inline; filename="we_ird; name=x.png"; filename*=UTF-8''we%22ird%3B%20name%3Dx.png`)
      expect(r.headers.get('x-content-type-options')).toBe('nosniff')
    }
    for (const name of ['evil.js', 'evil.html']) {
      const f = t.services.files.getByPath(pid, name)!
      const r = await O.raw('GET', `${P}/files/${f.id}/raw`)
      expect(r.headers.get('content-type')).toBe('text/plain; charset=utf-8')
      expect(r.headers.get('content-disposition')).toMatch(/^attachment/)
      expect(r.headers.get('content-security-policy')).toContain('sandbox')
    }
    // build outputs: fixed names, nosniff, never HTML
    const b = await O.raw('GET', `${P}/builds/${buildId}/main.log`)
    expect(b.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(b.headers.get('x-content-type-options')).toBe('nosniff')
    expect((await O.get(`${P}/builds/${buildId}/..%2Fmeta.json`)).status).toBe(404)
    expect((await O.get(`${P}/builds/${buildId}/.hidden`)).status).toBe(404)
  })

  it('caps upload requests before anything is stored', async () => {
    const P = `/api/projects/${pid}`
    const huge = (path: string, length: number | null) => new Promise<number>((resolve, reject) => {
      const headers: Record<string, string> = { cookie: O.cookie!, origin: t.base, 'X-Folio-Csrf': '1', 'content-type': 'multipart/form-data; boundary=x' }
      if (length !== null) headers['content-length'] = String(length)
      else headers['transfer-encoding'] = 'chunked'
      const req = http.request(t.base + path, { method: 'POST', headers }, res => {
        res.resume()
        resolve(res.statusCode!)
      })
      req.on('error', reject)
      req.write('--x\r\n')
      if (length === null) req.end()
    })
    expect(await huge(`${P}/upload`, 400 * 1024 * 1024)).toBe(413)
    expect(await huge('/api/projects/upload', 60 * 1024 * 1024)).toBe(413)
    expect(await huge(`${P}/upload`, null)).toBe(411)
    const tmp = await import('node:fs/promises').then(f => f.readdir(t.services.config.dirs.tmp))
    expect(tmp.filter(n => n.startsWith('upload-'))).toEqual([])
  })

  it('the local TeX runner gets a minimal environment', () => {
    const env = localTexEnv({ PATH: '/usr/bin', HOME: '/home/x', TEXINPUTS: '.:', LANG: 'C', AWS_SECRET_ACCESS_KEY: 's', PUBLIC_ORIGIN: 'https://x', DATA_DIR: '/data', NODE_OPTIONS: '--inspect' })
    expect(env).toMatchObject({ PATH: '/usr/bin', HOME: '/home/x', TEXINPUTS: '.:', LANG: 'C', max_print_line: '10000' })
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
    expect(env.PUBLIC_ORIGIN).toBeUndefined()
    expect(env.DATA_DIR).toBeUndefined()
    expect(env.NODE_OPTIONS).toBeUndefined()
  })
})

describe('Origin rule with PUBLIC_ORIGIN (DNS rebinding)', () => {
  it('accepts the public origin and literal hosts, refuses other Host-derived names', async () => {
    const { isAllowedOrigin, isLiteralHost } = await import('../../src/http/origin.ts')
    const { loadConfig } = await import('../../src/config.ts')
    const pub = loadConfig({ PUBLIC_ORIGIN: 'https://latex.example.com/' })
    const open = loadConfig({})
    expect(isAllowedOrigin(pub, 'https://latex.example.com', 'http', '127.0.0.1:3100')).toBe(true)
    expect(isAllowedOrigin(pub, 'http://127.0.0.1:3100', 'http', '127.0.0.1:3100')).toBe(true)
    expect(isAllowedOrigin(pub, 'http://localhost:3100', 'http', 'localhost:3100')).toBe(true)
    expect(isAllowedOrigin(pub, 'http://[::1]:3100', 'http', '[::1]:3100')).toBe(true)
    // a rebinding page: Origin and Host both name the attacker's domain
    expect(isAllowedOrigin(pub, 'http://rebind.evil.example:3100', 'http', 'rebind.evil.example:3100')).toBe(false)
    // without PUBLIC_ORIGIN the Host rule is all there is (documented: set PUBLIC_ORIGIN when exposing Folio)
    expect(isAllowedOrigin(open, 'http://myserver.lan:3100', 'http', 'myserver.lan:3100')).toBe(true)
    expect(isAllowedOrigin(open, 'http://evil.example', 'http', 'myserver.lan:3100')).toBe(false)
    expect(isLiteralHost('10.0.0.7:8080')).toBe(true)
    expect(isLiteralHost('localhost')).toBe(true)
    expect(isLiteralHost('127.0.0.1.nip.io')).toBe(false)
    expect(isLiteralHost('evil.example:3100')).toBe(false)
  })
})
