import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProjectDetail, ProjectSummary } from '@folio/shared/api'
import type { UserRecord } from '../../src/db/index.ts'
import { byPath } from './fakes.ts'
import { Client, makeUser, readZip, startTestServer, type TestServer } from './helpers.ts'

describe('projects', () => {
  let t: TestServer
  let alice: UserRecord
  let bob: UserRecord
  let carol: UserRecord
  let A: Client
  let B: Client
  let C: Client

  beforeAll(async () => {
    t = await startTestServer()
    alice = await makeUser(t.services, 'alice@example.com', 'Alice')
    bob = await makeUser(t.services, 'bob@example.com', 'Bob')
    carol = await makeUser(t.services, 'carol@example.com', 'Carol')
    A = Client.as(t, alice)
    B = Client.as(t, bob)
    C = Client.as(t, carol)
  })
  afterAll(async () => {
    await t.close()
  })

  async function create(c: Client, name: string, template: 'blank' | 'example' = 'blank'): Promise<string> {
    const r = await c.post('/api/projects', { name, template })
    expect(r.status).toBe(201)
    return r.body.id
  }

  it('creates blank and example projects with a root document and history', async () => {
    const pid = await create(A, 'My {paper} & notes_1', 'blank')
    const d = (await A.get<ProjectDetail>(`/api/projects/${pid}`)).body
    expect(d.name).toBe('My {paper} & notes_1')
    expect(d.role).toBe('owner')
    expect(d.owner.email).toBe('alice@example.com')
    expect(d.files.map(f => f.path)).toEqual(['main.tex'])
    expect(d.settings).toMatchObject({ compiler: 'pdflatex', rootFileId: d.files[0].id, timeoutSec: 240, externalDocs: [] })
    expect(d.members).toEqual([expect.objectContaining({ role: 'owner', user: expect.objectContaining({ id: alice.id }) })])
    const main = await fsp.readFile(path.join(t.services.config.dirs.projects, pid, 'main.tex'), 'utf8')
    expect(main).toContain('\\title{My \\{paper\\} \\& notes\\_1}')
    expect(main).toContain('\\author{Alice}')
    expect(t.history.inits).toContain(pid)

    const ex = await create(A, 'Example', 'example')
    const de = (await A.get<ProjectDetail>(`/api/projects/${ex}`)).body
    expect(de.files.map(f => f.path).sort()).toEqual(['main.tex', 'references.bib'])
    expect(de.files.every(f => f.kind === 'text')).toBe(true)
    expect(de.settings.rootFileId).toBe(byPath(de.files, 'main.tex')!.id)

    expect((await A.post('/api/projects', { name: '', template: 'blank' })).status).toBe(400)
    expect((await A.post('/api/projects', { name: 'x', template: 'nope' })).status).toBe(400)
  })

  it('lists projects for the dashboard with role, owner and lastUpdatedBy', async () => {
    const pid = await create(A, 'Listed')
    const list = (await A.get<ProjectSummary[]>('/api/projects')).body
    const p = list.find(x => x.id === pid)!
    expect(p).toMatchObject({ name: 'Listed', role: 'owner', trashed: false, archived: false })
    expect(p.owner.id).toBe(alice.id)
    expect(p.lastUpdatedBy?.id).toBe(alice.id)
    expect(typeof p.lastOpenedAt).toBe('number')
    expect((await B.get<ProjectSummary[]>('/api/projects')).body.find(x => x.id === pid)).toBeUndefined()
  })

  it('renames (owner only), validates and applies settings, broadcasts the changes', async () => {
    const pid = await create(A, 'Old name', 'example')
    t.services.db.members.upsert(pid, bob.id, 'editor')
    t.services.db.members.upsert(pid, carol.id, 'viewer')
    const detail = (await A.get<ProjectDetail>(`/api/projects/${pid}`)).body
    const bibId = byPath(detail.files, 'references.bib')!.id

    const r = await A.patch(`/api/projects/${pid}`, { name: 'New name' })
    expect(r.status).toBe(200)
    expect(r.body.name).toBe('New name')
    expect(t.meta.eventsOf(pid, 'project:renamed')).toEqual([{ type: 'project:renamed', name: 'New name' }])
    expect(t.meta.syncedProjects).toContain(pid)
    expect((await B.patch(`/api/projects/${pid}`, { name: 'Bob name' })).status).toBe(403)

    const s1 = await B.patch(`/api/projects/${pid}`, { settings: { compiler: 'xelatex', timeoutSec: 120, externalDocs: ['supp.tex', 'supp.tex'], rootFileId: bibId } })
    expect(s1.status).toBe(200)
    expect(s1.body.settings).toMatchObject({ compiler: 'xelatex', timeoutSec: 120, externalDocs: ['supp.tex'], rootFileId: bibId })
    expect(t.meta.eventsOf(pid, 'project:settings').length).toBe(1)
    expect((await B.patch(`/api/projects/${pid}`, { settings: { compiler: 'context' } })).status).toBe(400)
    expect((await B.patch(`/api/projects/${pid}`, { settings: { timeoutSec: 10 } })).status).toBe(400)
    expect((await B.patch(`/api/projects/${pid}`, { settings: { timeoutSec: 601 } })).status).toBe(400)
    expect((await B.patch(`/api/projects/${pid}`, { settings: { externalDocs: ['../x.tex'] } })).status).toBe(400)
    expect((await B.patch(`/api/projects/${pid}`, { settings: { externalDocs: ['x.bib'] } })).status).toBe(400)
    expect((await B.patch(`/api/projects/${pid}`, { settings: { rootFileId: 'AAAAAAAAAAAAAAAA' } })).status).toBe(400)
    expect((await B.patch(`/api/projects/${pid}`, { settings: { image: 'evil' } })).status).toBe(400)
    // a folder is not a valid root
    const folder = await B.post(`/api/projects/${pid}/files`, { path: 'chapters', kind: 'folder' })
    expect((await B.patch(`/api/projects/${pid}`, { settings: { rootFileId: folder.body.id } })).status).toBe(400)
    // viewers can only change their own trash/archive flags
    expect((await C.patch(`/api/projects/${pid}`, { settings: { compiler: 'pdflatex' } })).status).toBe(403)
    expect((await C.patch(`/api/projects/${pid}`, { archived: true })).status).toBe(200)
    const carolList = (await C.get<ProjectSummary[]>('/api/projects')).body
    expect(carolList.find(p => p.id === pid)).toMatchObject({ archived: true, role: 'viewer' })
    const aliceList = (await A.get<ProjectSummary[]>('/api/projects')).body
    expect(aliceList.find(p => p.id === pid)).toMatchObject({ archived: false, role: 'owner' })
  })

  it('roles: viewers cannot write, non-members get 404', async () => {
    const pid = await create(A, 'Roles')
    t.services.db.members.upsert(pid, carol.id, 'viewer')
    const main = (await A.get<ProjectDetail>(`/api/projects/${pid}`)).body.files[0]
    expect((await C.get(`/api/projects/${pid}`)).body.role).toBe('viewer')
    const w1 = await C.post(`/api/projects/${pid}/files`, { path: 'x.tex', kind: 'text' })
    expect(w1.status).toBe(403)
    expect(w1.body.error.code).toBe('forbidden')
    expect((await C.patch(`/api/projects/${pid}/files/${main.id}`, { path: 'y.tex' })).status).toBe(403)
    expect((await C.del(`/api/projects/${pid}/files/${main.id}`)).status).toBe(403)
    expect((await C.get(`/api/projects/${pid}/files/${main.id}/raw`)).status).toBe(200)
    const nm = await B.get(`/api/projects/${pid}`)
    expect(nm.status).toBe(404)
    expect(nm.body.error.code).toBe('not_found')
    expect((await B.get(`/api/projects/${pid}/files/${main.id}/raw`)).status).toBe(404)
    expect((await B.post(`/api/projects/${pid}/files`, { path: 'x.tex', kind: 'text' })).status).toBe(404)
    expect((await B.get('/api/projects/not-a-real-id-at-all')).status).toBe(404)
    expect((await new Client(t.base).get(`/api/projects/${pid}`)).status).toBe(401)
  })

  it('copies a project (files, settings, root) owned by the copier', async () => {
    const pid = await create(A, 'Source', 'example')
    t.services.db.members.upsert(pid, carol.id, 'viewer')
    const src = (await A.get<ProjectDetail>(`/api/projects/${pid}`)).body
    await A.post(`/api/projects/${pid}/files`, { path: 'figs/a.txt', kind: 'text', content: 'hello\r\nworld' })
    await A.patch(`/api/projects/${pid}`, { settings: { compiler: 'lualatex' } })
    const r = await C.post(`/api/projects/${pid}/copy`, { name: 'Copy of Source' })
    expect(r.status).toBe(201)
    const copy = (await C.get<ProjectDetail>(`/api/projects/${r.body.id}`)).body
    expect(copy.role).toBe('owner')
    expect(copy.owner.id).toBe(carol.id)
    expect(copy.settings.compiler).toBe('lualatex')
    expect(copy.files.map(f => f.path).sort()).toEqual(['figs', 'figs/a.txt', 'main.tex', 'references.bib'])
    expect(copy.settings.rootFileId).toBe(byPath(copy.files, 'main.tex')!.id)
    expect(copy.settings.rootFileId).not.toBe(src.settings.rootFileId)
    expect(copy.members.map(m => m.user.id)).toEqual([carol.id])
    expect(t.history.copies).toContainEqual({ from: pid, to: r.body.id })
    const txt = await fsp.readFile(path.join(t.services.config.dirs.projects, r.body.id, 'figs/a.txt'), 'utf8')
    expect(txt).toBe('hello\nworld')
    // history copy failure falls back to a fresh init
    t.history.failCopy = true
    const r2 = await A.post(`/api/projects/${pid}/copy`, { name: 'Copy 2' })
    t.history.failCopy = false
    expect(r2.status).toBe(201)
    expect(t.history.inits).toContain(r2.body.id)
  })

  it('trash / restore are per user; delete forever (owner) removes everything; non-owner delete = leave', async () => {
    const pid = await create(A, 'Doomed')
    t.services.db.members.upsert(pid, bob.id, 'editor')
    expect((await A.patch(`/api/projects/${pid}`, { trashed: true })).status).toBe(200)
    expect((await A.get<ProjectSummary[]>('/api/projects')).body.find(p => p.id === pid)!.trashed).toBe(true)
    expect((await B.get<ProjectSummary[]>('/api/projects')).body.find(p => p.id === pid)!.trashed).toBe(false)
    await A.patch(`/api/projects/${pid}`, { trashed: false })
    expect((await A.get<ProjectSummary[]>('/api/projects')).body.find(p => p.id === pid)!.trashed).toBe(false)

    // bob "deletes" → leaves
    expect((await B.del(`/api/projects/${pid}`)).status).toBe(204)
    expect((await B.get(`/api/projects/${pid}`)).status).toBe(404)
    expect(t.collab.disconnected).toContainEqual({ projectId: pid, userId: bob.id, code: 4403 })
    expect(t.meta.eventsOf(pid, 'members:changed').length).toBeGreaterThan(0)
    expect((await A.get(`/api/projects/${pid}`)).status).toBe(200)

    // owner deletes forever
    const dir = path.join(t.services.config.dirs.projects, pid)
    await fsp.access(dir)
    expect((await A.del(`/api/projects/${pid}`)).status).toBe(204)
    expect(t.collab.discardedProjects).toContain(pid)
    expect(t.meta.closed).toContainEqual({ projectId: pid, code: 4410 })
    expect(t.compile.deleted).toContain(pid)
    expect(t.history.deletedProjects).toContain(pid)
    expect(t.meta.eventsOf(pid, 'project:deleted').length).toBe(1)
    await expect(fsp.access(dir)).rejects.toThrow()
    expect(t.services.db.projects.get(pid)).toBeNull()
    expect((await A.get(`/api/projects/${pid}`)).status).toBe(404)
  })

  it('downloads the live state as a zip (round trip through the zip importer)', async () => {
    const pid = await create(A, 'Zipped', 'example')
    await A.post(`/api/projects/${pid}/files`, { path: 'empty', kind: 'folder' })
    await A.post(`/api/projects/${pid}/files`, { path: 'sec/intro.tex', kind: 'text', content: 'Intro ü' })
    const form = new FormData()
    form.append('files', new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])]), 'img.png')
    await A.upload(`/api/projects/${pid}/upload`, form)
    const res = await A.bytes(`/api/projects/${pid}/download.zip`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/zip')
    expect(res.headers.get('content-disposition')).toContain('Zipped.zip')
    expect(t.collab.flushed).toContain(pid)
    const entries = await readZip(res.data)
    expect([...entries.keys()].sort()).toEqual(['empty/', 'img.png', 'main.tex', 'references.bib', 'sec/intro.tex'])
    expect(entries.get('sec/intro.tex')!.toString('utf8')).toBe('Intro ü')
    expect([...entries.get('img.png')!]).toEqual([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3])

    // and back in as a new project
    const up = new FormData()
    up.append('file', new Blob([new Uint8Array(res.data)]), 'Zipped.zip')
    const imp = await A.upload('/api/projects/upload', up)
    expect(imp.status).toBe(201)
    const d = (await A.get<ProjectDetail>(`/api/projects/${imp.body.id}`)).body
    expect(d.name).toBe('Zipped')
    expect(d.files.map(f => `${f.path}:${f.kind}`).sort()).toEqual(['empty:folder', 'img.png:binary', 'main.tex:text', 'references.bib:text', 'sec/intro.tex:text', 'sec:folder'])
    expect(d.settings.rootFileId).toBe(byPath(d.files, 'main.tex')!.id)
    // viewers can download too; non-members cannot
    t.services.db.members.upsert(pid, carol.id, 'viewer')
    expect((await C.bytes(`/api/projects/${pid}/download.zip`)).status).toBe(200)
    expect((await B.bytes(`/api/projects/${pid}/download.zip`)).status).toBe(404)
  })
})
