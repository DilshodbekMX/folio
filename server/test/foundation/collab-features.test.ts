import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ChatListResponse, ProjectDetail, SearchResponse, ShareInfo } from '@folio/shared/api'
import type { UserRecord } from '../../src/db/index.ts'
import { byPath } from './fakes.ts'
import { Client, makeUser, startTestServer, type TestServer } from './helpers.ts'

describe('sharing, chat, search, admin', () => {
  let t: TestServer
  let alice: UserRecord
  let bob: UserRecord
  let carol: UserRecord
  let admin: UserRecord
  let A: Client
  let B: Client
  let C: Client
  let pid: string

  beforeAll(async () => {
    t = await startTestServer()
    admin = await makeUser(t.services, 'root@example.com', 'Root', true)
    alice = await makeUser(t.services, 'alice@example.com', 'Alice')
    bob = await makeUser(t.services, 'bob@example.com', 'Bob')
    carol = await makeUser(t.services, 'carol@example.com', 'Carol')
    A = Client.as(t, alice)
    B = Client.as(t, bob)
    C = Client.as(t, carol)
    pid = (await A.post('/api/projects', { name: 'Shared', template: 'example' })).body.id
  })
  afterAll(async () => {
    await t.close()
  })

  it('share links: owner creates/regenerates/disables; join adds the role and never downgrades', async () => {
    expect((await B.post(`/api/projects/${pid}/share-links`, { role: 'editor' })).status).toBe(404)
    const links = await A.post(`/api/projects/${pid}/share-links`, { role: 'viewer' })
    expect(links.status).toBe(200)
    expect(links.body.editor).toBeNull()
    expect(links.body.viewer).toMatch(/^[A-Za-z0-9_-]{24}$/)
    const viewerToken = links.body.viewer as string
    const editorToken = (await A.post(`/api/projects/${pid}/share-links`, { role: 'editor' })).body.editor as string

    // token info + join as viewer
    const info = await B.get(`/api/share/${viewerToken}`)
    expect(info.body).toMatchObject({ projectId: pid, projectName: 'Shared', role: 'viewer', alreadyMember: false, owner: { id: alice.id } })
    expect((await new Client(t.base).get(`/api/share/${viewerToken}`)).status).toBe(401)
    const j1 = await B.post(`/api/share/${viewerToken}/join`)
    expect(j1.body).toEqual({ projectId: pid, role: 'viewer' })
    expect((await B.get(`/api/projects/${pid}`)).body.role).toBe('viewer')
    expect((await B.get(`/api/share/${viewerToken}`)).body.alreadyMember).toBe(true)
    // editor link upgrades; the view link afterwards does not downgrade
    expect((await B.post(`/api/share/${editorToken}/join`)).body.role).toBe('editor')
    expect(t.collab.disconnected).toContainEqual({ projectId: pid, userId: bob.id, code: 4403 })
    expect((await B.post(`/api/share/${viewerToken}/join`)).body.role).toBe('editor')
    expect((await B.get(`/api/projects/${pid}`)).body.role).toBe('editor')
    // the owner joining their own link stays owner
    expect((await A.post(`/api/share/${viewerToken}/join`)).body.role).toBe('owner')

    // only the owner sees the tokens
    const ownerView = (await A.get<ShareInfo>(`/api/projects/${pid}/share`)).body
    expect(ownerView.links).toEqual({ editor: editorToken, viewer: viewerToken })
    expect(ownerView.members.map(m => `${m.user.email}:${m.role}`)).toEqual(['alice@example.com:owner', 'bob@example.com:editor'])
    expect((await B.get<ShareInfo>(`/api/projects/${pid}/share`)).body.links).toBeNull()

    // regenerate invalidates the old token; delete disables
    const regen = (await A.post(`/api/projects/${pid}/share-links`, { role: 'viewer' })).body
    expect(regen.viewer).not.toBe(viewerToken)
    expect((await C.get(`/api/share/${viewerToken}`)).status).toBe(404)
    const del = await A.del(`/api/projects/${pid}/share-links/viewer`)
    expect(del.body).toEqual({ editor: editorToken, viewer: null })
    expect((await C.post(`/api/share/${regen.viewer}/join`)).status).toBe(404)
    expect((await A.del(`/api/projects/${pid}/share-links/owner`)).status).toBe(400)
    expect((await C.post('/api/share/short/join')).status).toBe(404)
    expect(t.meta.eventsOf(pid, 'members:changed').length).toBeGreaterThan(0)
  })

  it('members: add by email, change role, remove; access changes disconnect the user', async () => {
    const add = await A.post(`/api/projects/${pid}/members`, { email: 'CAROL@example.com', role: 'viewer' })
    expect(add.status).toBe(201)
    expect(add.body).toMatchObject({ role: 'viewer', user: { id: carol.id } })
    expect((await A.post(`/api/projects/${pid}/members`, { email: 'nobody@example.com', role: 'viewer' })).status).toBe(404)
    expect((await A.post(`/api/projects/${pid}/members`, { email: 'alice@example.com', role: 'viewer' })).status).toBe(400)
    expect((await B.post(`/api/projects/${pid}/members`, { email: 'root@example.com', role: 'viewer' })).status).toBe(403)

    t.collab.disconnected.length = 0
    t.meta.disconnected.length = 0
    const ch = await A.patch(`/api/projects/${pid}/members/${carol.id}`, { role: 'editor' })
    expect(ch.body.role).toBe('editor')
    expect(t.collab.disconnected).toEqual([{ projectId: pid, userId: carol.id, code: 4403 }])
    expect(t.meta.disconnected).toEqual([{ projectId: pid, userId: carol.id, code: 4403 }])
    expect(t.meta.eventsOf(pid, 'access:changed')).toContainEqual({ type: 'access:changed', userId: carol.id })
    expect((await A.patch(`/api/projects/${pid}/members/${alice.id}`, { role: 'viewer' })).status).toBe(400)
    expect((await A.patch(`/api/projects/${pid}/members/${carol.id}`, { role: 'owner' })).status).toBe(400)
    expect((await B.patch(`/api/projects/${pid}/members/${carol.id}`, { role: 'viewer' })).status).toBe(403)

    // a member cannot remove others, but can remove themself; the owner removes anyone
    expect((await B.del(`/api/projects/${pid}/members/${carol.id}`)).status).toBe(403)
    expect((await C.del(`/api/projects/${pid}/members/${carol.id}`)).status).toBe(204)
    expect((await C.get(`/api/projects/${pid}`)).status).toBe(404)
    expect((await A.del(`/api/projects/${pid}/members/${bob.id}`)).status).toBe(204)
    expect((await B.get(`/api/projects/${pid}`)).status).toBe(404)
    expect((await A.del(`/api/projects/${pid}/members/${alice.id}`)).status).toBe(400)
    const members = (await A.get<ShareInfo>(`/api/projects/${pid}/share`)).body.members
    expect(members.map(m => m.user.id)).toEqual([alice.id])
  })

  it('chat: post (viewers too), broadcast, paginate ascending', async () => {
    await A.post(`/api/projects/${pid}/members`, { email: 'bob@example.com', role: 'viewer' })
    const first = await B.post(`/api/projects/${pid}/chat`, { content: '  hello from a viewer  ' })
    expect(first.status).toBe(201)
    expect(first.body).toMatchObject({ content: 'hello from a viewer', user: { id: bob.id } })
    expect(t.meta.eventsOf(pid, 'chat:message').at(-1)).toMatchObject({ message: { id: first.body.id } })
    for (let i = 1; i <= 24; i++) await A.post(`/api/projects/${pid}/chat`, { content: `msg ${i}` })
    expect((await A.post(`/api/projects/${pid}/chat`, { content: '   ' })).status).toBe(400)
    expect((await A.post(`/api/projects/${pid}/chat`, { content: 'x'.repeat(5001) })).status).toBe(400)
    expect((await C.post(`/api/projects/${pid}/chat`, { content: 'intruder' })).status).toBe(404)

    const page1 = (await A.get<ChatListResponse>(`/api/projects/${pid}/chat?limit=10`)).body
    expect(page1.hasMore).toBe(true)
    expect(page1.messages.map(m => m.content)).toEqual(Array.from({ length: 10 }, (_, i) => `msg ${15 + i}`))
    const page2 = (await A.get<ChatListResponse>(`/api/projects/${pid}/chat?limit=10&before=${page1.messages[0].id}`)).body
    expect(page2.messages.map(m => m.content)).toEqual(Array.from({ length: 10 }, (_, i) => `msg ${5 + i}`))
    expect(page2.hasMore).toBe(true)
    const page3 = (await A.get<ChatListResponse>(`/api/projects/${pid}/chat?limit=10&before=${page2.messages[0].id}`)).body
    expect(page3.messages.map(m => m.content)).toEqual(['hello from a viewer', 'msg 1', 'msg 2', 'msg 3', 'msg 4'])
    expect(page3.hasMore).toBe(false)
    expect((await A.get(`/api/projects/${pid}/chat?limit=0`)).status).toBe(400)
    const all = (await A.get<ChatListResponse>(`/api/projects/${pid}/chat`)).body
    expect(all.messages.length).toBe(25)
    expect(all.hasMore).toBe(false)
  })

  it('search: literal, case, whole word, regex, invalid regex, ReDoS guard, caps', async () => {
    const files = (await A.get<ProjectDetail>(`/api/projects/${pid}`)).body.files
    await A.post(`/api/projects/${pid}/files`, { path: 'notes.txt', kind: 'text', content: 'Section one\nsection two\nsubsection three\nnothing (a+b) here\n' })
    const q = (params: string) => A.get(`/api/projects/${pid}/search?${params}`) as Promise<{ status: number; body: SearchResponse & { error: { message: string } } }>

    const lit = (await q('q=section')).body
    const notes = lit.results.find(r => r.path === 'notes.txt')!
    expect(notes.matches.map(m => `${m.line}:${m.column}:${m.length}`)).toEqual(['1:0:7', '2:0:7', '3:3:7'])
    expect(notes.matches[0].preview).toBe('Section one')
    expect(lit.results.some(r => r.fileId === byPath(files, 'main.tex')!.id)).toBe(true)

    const cs = (await q('q=section&caseSensitive=1')).body.results.find(r => r.path === 'notes.txt')!
    expect(cs.matches.map(m => m.line)).toEqual([2, 3])
    const ww = (await q('q=section&wholeWord=1')).body.results.find(r => r.path === 'notes.txt')!
    expect(ww.matches.map(m => m.line)).toEqual([1, 2])
    const special = (await q(`q=${encodeURIComponent('(a+b)')}`)).body.results.find(r => r.path === 'notes.txt')!
    expect(special.matches).toEqual([{ line: 4, column: 8, length: 5, preview: 'nothing (a+b) here' }])
    const re = (await q(`q=${encodeURIComponent('^s\\w+ion')}&regex=1&caseSensitive=1`)).body.results.find(r => r.path === 'notes.txt')!
    expect(re.matches.map(m => `${m.line}:${m.length}`)).toEqual(['2:7', '3:10'])

    const bad = await q(`q=${encodeURIComponent('(unclosed')}&regex=1`)
    expect(bad.status).toBe(400)
    expect(bad.body.error.message).toMatch(/Invalid regular expression/)
    expect((await q('q=')).status).toBe(400)

    // catastrophic backtracking is cut off by the worker time limit, the server stays responsive
    await A.post(`/api/projects/${pid}/files`, { path: 'redos.txt', kind: 'text', content: `${'a'.repeat(40)}!` })
    const started = Date.now()
    const slow = await q(`q=${encodeURIComponent('^(a+)+$')}&regex=1`)
    expect(slow.status).toBe(400)
    expect(slow.body.error.message).toMatch(/too long/)
    expect(Date.now() - started).toBeLessThan(15_000)

    // 2000-match cap
    await A.post(`/api/projects/${pid}/files`, { path: 'many.txt', kind: 'text', content: 'x '.repeat(2500) })
    const capped = (await q('q=x&caseSensitive=1')).body
    expect(capped.truncated).toBe(true)
    expect(capped.results.reduce((n, r) => n + r.matches.length, 0)).toBe(2000)
    // viewers may search, non-members may not
    expect((await B.get(`/api/projects/${pid}/search?q=section`)).status).toBe(200)
    expect((await C.get(`/api/projects/${pid}/search?q=section`)).status).toBe(404)
  })

  it('admin: list/create/delete users; non-admins are refused; cannot delete self', async () => {
    const R = Client.as(t, admin)
    expect((await A.get('/api/admin/users')).status).toBe(403)
    expect((await new Client(t.base).get('/api/admin/users')).status).toBe(401)
    const list = (await R.get('/api/admin/users')).body as { email: string; projectCount: number; isAdmin: boolean }[]
    expect(list.find(u => u.email === 'alice@example.com')).toMatchObject({ projectCount: 1, isAdmin: false })
    expect(list.find(u => u.email === 'root@example.com')).toMatchObject({ isAdmin: true })

    const created = await R.post('/api/admin/users', { email: 'dan@example.com', name: 'Dan', password: 'dan password' })
    expect(created.status).toBe(201)
    expect(created.body).toMatchObject({ email: 'dan@example.com', isAdmin: false, projectCount: 0 })
    expect((await R.post('/api/admin/users', { email: 'dan@example.com', name: 'Dan', password: 'dan password' })).status).toBe(409)
    expect((await R.post('/api/admin/users', { email: 'eve@example.com', name: 'Eve', password: 'short' })).status).toBe(400)
    const login = await new Client(t.base).post('/api/auth/login', { email: 'dan@example.com', password: 'dan password' })
    expect(login.status).toBe(200)

    expect((await R.del(`/api/admin/users/${admin.id}`)).status).toBe(400)
    expect((await R.del('/api/admin/users/AAAAAAAAAAAAAAAA')).status).toBe(404)
    // deleting a user deletes the projects they own and removes their memberships
    const bobsProject = (await B.post('/api/projects', { name: 'Bob own', template: 'blank' })).body.id
    expect((await R.del(`/api/admin/users/${bob.id}`)).status).toBe(204)
    expect(t.services.db.users.get(bob.id)).toBeNull()
    expect(t.services.db.projects.get(bobsProject)).toBeNull()
    expect(t.history.deletedProjects).toContain(bobsProject)
    expect(t.services.db.members.roleOf(pid, bob.id)).toBeNull()
    expect((await B.get('/api/auth/me')).status).toBe(401)
    // chat messages of a deleted user disappear with the account (FK cascade)
    const chat = (await A.get<ChatListResponse>(`/api/projects/${pid}/chat`)).body
    expect(chat.messages.every(m => m.user.id !== bob.id)).toBe(true)
  })
})
