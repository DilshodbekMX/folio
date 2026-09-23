import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { UserRecord } from '../../src/db/index.ts'
import { createSession } from '../../src/auth/sessions.ts'
import { Client, makeUser, startTestServer, type TestServer } from './helpers.ts'

/** Send an upgrade request; resolves 'upgraded' on 101, 'destroyed' when the server drops the socket. */
function tryUpgrade(base: string, path: string, headers: Record<string, string>): Promise<'upgraded' | 'destroyed'> {
  return new Promise(resolve => {
    const req = http.request(base + path, {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
    })
    req.on('upgrade', (_res, socket) => {
      socket.destroy()
      resolve('upgraded')
    })
    req.on('response', () => resolve('destroyed'))
    req.on('error', () => resolve('destroyed'))
    req.end()
  })
}

describe('websocket upgrade routing', () => {
  let t: TestServer
  let alice: UserRecord
  let bob: UserRecord
  let pid: string
  let fileId: string
  let aliceCookie: string
  let bobCookie: string

  beforeAll(async () => {
    t = await startTestServer()
    alice = await makeUser(t.services, 'alice@example.com', 'Alice')
    bob = await makeUser(t.services, 'bob@example.com', 'Bob')
    const A = Client.as(t, alice)
    pid = (await A.post('/api/projects', { name: 'WS', template: 'blank' })).body.id
    fileId = t.services.files.list(pid)[0].id
    aliceCookie = `folio_session=${createSession(t.services.db, t.services.config, alice.id).token}`
    bobCookie = `folio_session=${createSession(t.services.db, t.services.config, bob.id).token}`
  })
  afterAll(async () => {
    await t.close()
  })

  it('routes doc sockets with user, role and epoch', async () => {
    const r = await tryUpgrade(t.base, `/ws/doc/${pid}/${fileId}?epoch=3`, { cookie: aliceCookie, origin: t.base })
    expect(r).toBe('upgraded')
    const call = t.collab.upgrades.at(-1)!
    expect(call.ctx).toMatchObject({ projectId: pid, fileId, epoch: 3, role: 'owner', user: { id: alice.id, email: 'alice@example.com' } })
  })

  it('passes a null user/role for anonymous and non-member sockets (the service closes them)', async () => {
    await tryUpgrade(t.base, `/ws/doc/${pid}/${fileId}?epoch=0`, {})
    expect(t.collab.upgrades.at(-1)!.ctx).toMatchObject({ user: null, role: null, epoch: 0 })
    await tryUpgrade(t.base, `/ws/doc/${pid}/${fileId}`, { cookie: bobCookie })
    expect(t.collab.upgrades.at(-1)!.ctx).toMatchObject({ user: { id: bob.id }, role: null, epoch: -1 })
    t.services.db.members.upsert(pid, bob.id, 'viewer')
    await tryUpgrade(t.base, `/ws/doc/${pid}/${fileId}?epoch=0`, { cookie: bobCookie })
    expect(t.collab.upgrades.at(-1)!.ctx.role).toBe('viewer')
  })

  it('routes meta sockets', async () => {
    const r = await tryUpgrade(t.base, `/ws/project/${pid}`, { cookie: aliceCookie, origin: t.base })
    expect(r).toBe('upgraded')
    expect(t.meta.upgrades.at(-1)!.ctx).toMatchObject({ projectId: pid, role: 'owner', user: { id: alice.id } })
  })

  it('destroys cross-origin and unknown upgrades', async () => {
    const before = t.collab.upgrades.length + t.meta.upgrades.length
    expect(await tryUpgrade(t.base, `/ws/doc/${pid}/${fileId}?epoch=0`, { cookie: aliceCookie, origin: 'http://evil.example' })).toBe('destroyed')
    expect(await tryUpgrade(t.base, `/ws/project/${pid}`, { cookie: aliceCookie, origin: 'null' })).toBe('destroyed')
    expect(await tryUpgrade(t.base, '/ws/other/thing', { cookie: aliceCookie })).toBe('destroyed')
    expect(await tryUpgrade(t.base, `/ws/doc/${pid}`, { cookie: aliceCookie })).toBe('destroyed')
    expect(await tryUpgrade(t.base, `/api/projects`, { cookie: aliceCookie })).toBe('destroyed')
    expect(await tryUpgrade(t.base, `/ws/doc/${pid}/${encodeURIComponent('../x')}`, { cookie: aliceCookie })).toBe('destroyed')
    expect(t.collab.upgrades.length + t.meta.upgrades.length).toBe(before)
  })
})
