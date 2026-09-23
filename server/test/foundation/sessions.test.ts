/**
 * Sessions and live sockets: sliding expiry (+ cookie refresh), and the rule that a WebSocket
 * lives exactly as long as the session it was opened with (logout, password change, user
 * deletion, expiry → WS_CLOSE.UNAUTHORIZED for that session's sockets only).
 */
import http from 'node:http'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WS_CLOSE } from '@folio/shared/protocol'
import type { UserRecord } from '../../src/db/index.ts'
import { EXTEND_INTERVAL_MS, createSession, hashToken, sessionTtlMs } from '../../src/auth/sessions.ts'
import { sweepSessionSockets } from '../../src/auth/live.ts'
import { Client, makeUser, PASSWORD, startTestServer, type TestServer } from './helpers.ts'

function upgrade(base: string, path: string, headers: Record<string, string>): Promise<void> {
  return new Promise(resolve => {
    const req = http.request(base + path, {
      headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers },
    })
    req.on('upgrade', (_res, socket) => {
      socket.destroy()
      resolve()
    })
    req.on('response', () => resolve())
    req.on('error', () => resolve())
    req.end()
  })
}

describe('sessions and live sockets', () => {
  let t: TestServer
  let alice: UserRecord
  let bob: UserRecord
  let admin: UserRecord

  beforeAll(async () => {
    t = await startTestServer()
    admin = await makeUser(t.services, 'root@example.com', 'Root', true)
    alice = await makeUser(t.services, 'alice@example.com', 'Alice')
    bob = await makeUser(t.services, 'bob@example.com', 'Bob')
  })
  afterAll(async () => {
    await t.close()
  })

  function sessionOf(c: Client): string {
    return hashToken(c.cookie!.slice('folio_session='.length))
  }

  it('the upgrade handler hands the session token hash to both services', async () => {
    const A = Client.as(t, alice)
    const pid = (await A.post('/api/projects', { name: 'WS', template: 'blank' })).body.id
    const fileId = t.services.files.list(pid)[0].id
    await upgrade(t.base, `/ws/doc/${pid}/${fileId}?epoch=0`, { cookie: A.cookie!, origin: t.base })
    expect(t.collab.upgrades.at(-1)!.ctx.sessionTokenHash).toBe(sessionOf(A))
    await upgrade(t.base, `/ws/project/${pid}`, { cookie: A.cookie!, origin: t.base })
    expect(t.meta.upgrades.at(-1)!.ctx.sessionTokenHash).toBe(sessionOf(A))
    await upgrade(t.base, `/ws/project/${pid}`, { origin: t.base })
    expect(t.meta.upgrades.at(-1)!.ctx.sessionTokenHash).toBeNull()
  })

  it('slides the expiry at most once per hour and re-sends the cookie when it does', async () => {
    const A = Client.as(t, alice)
    const hash = sessionOf(A)
    const db = t.services.db
    // fresh session: used within the hour → no db write, no cookie
    const r1 = await A.get('/api/auth/me')
    expect(r1.status).toBe(200)
    expect(r1.headers.getSetCookie()).toEqual([])

    // pretend it was last used 2 h ago and expires in 5 minutes
    const old = Date.now() - EXTEND_INTERVAL_MS - 60 * 60 * 1000
    db.raw.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(old, Date.now() + 5 * 60 * 1000, hash)
    const r2 = await A.get('/api/auth/me')
    expect(r2.status).toBe(200)
    const cookies = r2.headers.getSetCookie()
    expect(cookies).toHaveLength(1)
    expect(cookies[0]).toMatch(/^folio_session=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/)
    expect(cookies[0]).toContain(A.cookie!)
    const row = db.sessions.get(hash)!
    expect(row.expiresAt).toBeGreaterThan(Date.now() + sessionTtlMs(t.services.config) - 60_000)
    expect(row.lastSeenAt).toBeGreaterThan(Date.now() - 60_000)

    // an expired session is gone for good
    db.raw.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1, hash)
    expect((await A.get('/api/auth/me')).status).toBe(401)
    expect(db.sessions.get(hash)).toBeNull()
  })

  it('logout closes the sockets of that session only (4401)', async () => {
    const A1 = Client.as(t, alice)
    const A2 = Client.as(t, alice)
    const h1 = sessionOf(A1)
    const h2 = sessionOf(A2)
    t.collab.liveSessions = [h1, h2]
    t.meta.liveSessions = [h1, h2]
    t.collab.sessionCloses.length = 0
    t.meta.sessionCloses.length = 0
    expect((await A1.post('/api/auth/logout')).status).toBe(204)
    expect(t.collab.sessionCloses).toEqual([{ tokenHashes: [h1], code: WS_CLOSE.UNAUTHORIZED }])
    expect(t.meta.sessionCloses).toEqual([{ tokenHashes: [h1], code: WS_CLOSE.UNAUTHORIZED }])
    expect(t.collab.liveSessions).toEqual([h2])
    expect((await A2.get('/api/auth/me')).status).toBe(200)
    // anonymous logout is a no-op
    t.collab.sessionCloses.length = 0
    expect((await new Client(t.base).post('/api/auth/logout')).status).toBe(204)
    expect(t.collab.sessionCloses).toEqual([])
  })

  it('a password change signs out (and disconnects) every other session of the account', async () => {
    const B1 = Client.as(t, bob)
    const B2 = Client.as(t, bob)
    const B3 = Client.as(t, bob)
    const A = Client.as(t, alice)
    t.collab.sessionCloses.length = 0
    t.meta.sessionCloses.length = 0
    const r = await B1.patch('/api/auth/me', { password: 'a brand new password', currentPassword: PASSWORD })
    expect(r.status).toBe(200)
    const closed = t.collab.sessionCloses.flatMap(c => c.tokenHashes).sort()
    expect(closed).toEqual([sessionOf(B2), sessionOf(B3)].sort())
    expect(t.collab.sessionCloses.every(c => c.code === WS_CLOSE.UNAUTHORIZED)).toBe(true)
    expect(t.meta.sessionCloses.flatMap(c => c.tokenHashes).sort()).toEqual(closed)
    expect((await B1.get('/api/auth/me')).status).toBe(200)
    expect((await B2.get('/api/auth/me')).status).toBe(401)
    expect((await A.get('/api/auth/me')).status).toBe(200)
  })

  it('deleting a user closes all of their sessions\' sockets with 4401 before anything else', async () => {
    const victim = await makeUser(t.services, 'victim@example.com', 'Victim')
    const V1 = Client.as(t, victim)
    const V2 = Client.as(t, victim)
    const R = Client.as(t, admin)
    t.collab.sessionCloses.length = 0
    const del = await R.del(`/api/admin/users/${victim.id}`)
    expect(del.status).toBe(204)
    expect(t.collab.sessionCloses[0].code).toBe(WS_CLOSE.UNAUTHORIZED)
    expect(t.collab.sessionCloses[0].tokenHashes.sort()).toEqual([sessionOf(V1), sessionOf(V2)].sort())
    expect((await V1.get('/api/auth/me')).status).toBe(401)
  })

  it('the periodic sweep closes sockets of expired, deleted or orphaned sessions', async () => {
    const db = t.services.db
    const live = createSession(db, t.services.config, alice.id).tokenHash
    const expired = createSession(db, t.services.config, alice.id).tokenHash
    db.raw.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1000, expired)
    const deleted = createSession(db, t.services.config, alice.id).tokenHash
    db.sessions.delete(deleted)
    t.collab.liveSessions = [live, expired, deleted]
    t.meta.liveSessions = [live, 'never-existed']
    t.collab.sessionCloses.length = 0
    t.meta.sessionCloses.length = 0
    const n = sweepSessionSockets(t.services)
    expect(n).toBe(3)
    expect(t.collab.sessionCloses[0].tokenHashes.sort()).toEqual([deleted, expired, 'never-existed'].sort())
    expect(t.collab.sessionCloses[0].code).toBe(WS_CLOSE.UNAUTHORIZED)
    expect(t.collab.liveSessions).toEqual([live])
    expect(t.meta.liveSessions).toEqual([live])
    // nothing to do the second time
    t.collab.sessionCloses.length = 0
    expect(sweepSessionSockets(t.services)).toBe(0)
    expect(t.collab.sessionCloses).toEqual([])
  })
})
