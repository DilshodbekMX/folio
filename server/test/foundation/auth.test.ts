import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPassword, needsRehash, verifyPassword } from '../../src/auth/passwords.ts'
import { Client, makeUser, PASSWORD, startTestServer, type TestServer } from './helpers.ts'

describe('passwords', () => {
  it('hashes with scrypt N=2^16 and verifies', async () => {
    const h = await hashPassword('hunter2hunter2')
    expect(h).toMatch(/^scrypt\$65536\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/)
    expect(await verifyPassword('hunter2hunter2', h)).toBe(true)
    expect(await verifyPassword('hunter2hunter3', h)).toBe(false)
    expect(needsRehash(h)).toBe(false)
    expect(await verifyPassword('x', 'garbage')).toBe(false)
    expect(await verifyPassword('x', 'scrypt$1048576000$8$1$AAAA$AAAA')).toBe(false)
  })
})

describe('auth routes', () => {
  let t: TestServer
  beforeAll(async () => {
    t = await startTestServer()
  })
  afterAll(async () => {
    await t.close()
  })

  it('first-run setup creates the admin once, then login/logout/me work', async () => {
    const anon = new Client(t.base)
    expect((await anon.get('/api/auth/setup-status')).body).toEqual({ needsSetup: true, allowSignup: false, version: '0.1.0' })
    expect((await anon.get('/api/auth/me')).status).toBe(401)

    const bad = await anon.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: 'short' })
    expect(bad.status).toBe(400)
    expect(bad.body.error.code).toBe('validation')

    const setup = await anon.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: PASSWORD })
    expect(setup.status).toBe(200)
    expect(setup.body).toMatchObject({ email: 'admin@example.com', name: 'Admin', isAdmin: true })
    expect(setup.body.settings.fontSize).toBe(14)
    const cookie = setup.headers.getSetCookie()[0]
    expect(cookie).toMatch(/^folio_session=[A-Za-z0-9_-]{43}; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Lax$/)
    expect((await anon.get('/api/auth/me')).body.email).toBe('admin@example.com')

    const again = await new Client(t.base).post('/api/auth/setup', { email: 'evil@example.com', name: 'Evil', password: PASSWORD })
    expect(again.status).toBe(403)
    expect((await anon.get('/api/auth/setup-status')).body.needsSetup).toBe(false)

    // logout clears the cookie and the session row
    const out = await anon.post('/api/auth/logout')
    expect(out.status).toBe(204)
    expect(out.headers.getSetCookie()[0]).toMatch(/^folio_session=; Max-Age=0;/)
    // cached build files (private, immutable) are dropped from the browser's HTTP cache
    expect(out.headers.get('clear-site-data')).toBe('"cache"')
    expect((await anon.get('/api/auth/me')).status).toBe(401)

    const wrong = await anon.post('/api/auth/login', { email: 'admin@example.com', password: 'not the password' })
    expect(wrong.status).toBe(401)
    expect(wrong.body.error.code).toBe('unauthorized')
    const unknown = await anon.post('/api/auth/login', { email: 'nobody@example.com', password: PASSWORD })
    expect(unknown.status).toBe(401)
    const login = await anon.post('/api/auth/login', { email: 'ADMIN@example.com', password: PASSWORD })
    expect(login.status).toBe(200)
    expect(login.body.isAdmin).toBe(true)
    expect((await anon.get('/api/auth/me')).status).toBe(200)
  })

  it('register is refused unless ALLOW_SIGNUP', async () => {
    const r = await new Client(t.base).post('/api/auth/register', { email: 'x@example.com', name: 'X', password: PASSWORD })
    expect(r.status).toBe(403)
  })

  it('updateMe merges settings, validates them and changes the password with the current one', async () => {
    const u = await makeUser(t.services, 'carol@example.com', 'Carol')
    const c = Client.as(t, u)
    const other = Client.as(t, u)
    const r1 = await c.patch('/api/auth/me', { name: 'Carol C', settings: { fontSize: 16, keybindings: 'vim' } })
    expect(r1.status).toBe(200)
    expect(r1.body.name).toBe('Carol C')
    expect(r1.body.settings).toMatchObject({ fontSize: 16, keybindings: 'vim', theme: 'system', lineWrapping: true })
    const r2 = await c.patch('/api/auth/me', { settings: { theme: 'dark' } })
    expect(r2.body.settings).toMatchObject({ fontSize: 16, keybindings: 'vim', theme: 'dark' })
    expect((await c.patch('/api/auth/me', { settings: { fontSize: 99 } })).status).toBe(400)
    expect((await c.patch('/api/auth/me', { settings: { nope: true } })).status).toBe(400)

    expect((await c.patch('/api/auth/me', { password: 'new password 1' })).status).toBe(400)
    const badCur = await c.patch('/api/auth/me', { password: 'new password 1', currentPassword: 'wrong wrong' })
    expect(badCur.status).toBe(400)
    const ok = await c.patch('/api/auth/me', { password: 'new password 1', currentPassword: PASSWORD })
    expect(ok.status).toBe(200)
    // other sessions are signed out, the current one stays
    expect((await other.get('/api/auth/me')).status).toBe(401)
    expect((await c.get('/api/auth/me')).status).toBe(200)
    const relog = await new Client(t.base).post('/api/auth/login', { email: 'carol@example.com', password: 'new password 1' })
    expect(relog.status).toBe(200)
  })

  it('CSRF: header and same-origin Origin are required for mutations', async () => {
    const u = await makeUser(t.services, 'dave@example.com', 'Dave')
    const c = Client.as(t, u)
    // missing X-Folio-Csrf header
    const noHeader = await c.raw('PATCH', '/api/auth/me', { body: JSON.stringify({ name: 'x' }), headers: { 'content-type': 'application/json', 'X-Folio-Csrf': '' } })
    expect(noHeader.status).toBe(403)
    // wrong Origin
    const evil = await c.raw('PATCH', '/api/auth/me', { body: JSON.stringify({ name: 'x' }), headers: { 'content-type': 'application/json', origin: 'http://evil.example' } })
    expect(evil.status).toBe(403)
    expect(((await evil.json()) as { error: { code: string } }).error.code).toBe('forbidden')
    // no Origin but a cross-site fetch
    const noOrigin = new Client(t.base, null)
    noOrigin.cookie = c.cookie
    const cross = await noOrigin.raw('PATCH', '/api/auth/me', { body: JSON.stringify({ name: 'x' }), headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' } })
    expect(cross.status).toBe(403)
    // non-browser client: no Origin, no Sec-Fetch-Site, header present → allowed
    const cli = await noOrigin.req('PATCH', '/api/auth/me', { name: 'Dave D' }, {})
    expect(cli.status).toBe(200)
    expect(cli.body.name).toBe('Dave D')
    // same-origin fetch metadata without Origin → allowed
    const same = await noOrigin.req('PATCH', '/api/auth/me', { name: 'Dave E' }, { 'sec-fetch-site': 'same-origin' })
    expect(same.status).toBe(200)
    // login is also guarded
    const anon = new Client(t.base, 'http://evil.example')
    expect((await anon.post('/api/auth/login', { email: 'dave@example.com', password: PASSWORD })).status).toBe(403)
    // GETs are never blocked
    expect((await new Client(t.base, 'http://evil.example').get('/api/auth/setup-status')).status).toBe(200)
  })

  it('CSRF behind a loopback reverse proxy: the forwarded host (with its port) and proto make the origin, like for WebSockets', async () => {
    const u = await makeUser(t.services, 'proxied@example.com', 'Proxied')
    const c = Client.as(t, u)
    const proxied = { 'content-type': 'application/json', 'x-forwarded-host': 'latex.example.com:8443', 'x-forwarded-proto': 'https' }
    const ok = await c.raw('PATCH', '/api/auth/me', { body: JSON.stringify({ name: 'Proxied P' }), headers: { ...proxied, origin: 'https://latex.example.com:8443' } })
    expect(ok.status).toBe(200)
    // the port is part of the origin
    const noPort = await c.raw('PATCH', '/api/auth/me', { body: JSON.stringify({ name: 'x' }), headers: { ...proxied, origin: 'https://latex.example.com' } })
    expect(noPort.status).toBe(403)
  })

  it('security headers, JSON 404 for unknown API routes, healthz, system info', async () => {
    const anon = new Client(t.base)
    const res = await anon.raw('GET', '/healthz')
    expect(await res.json()).toEqual({ ok: true })
    const csp = res.headers.get('content-security-policy')!
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(csp).toContain("img-src 'self' data: blob:")
    expect(csp).toContain("worker-src 'self' blob:")
    expect(csp).not.toContain('upgrade-insecure-requests')
    expect(res.headers.get('strict-transport-security')).toBeNull()
    expect(res.headers.get('x-powered-by')).toBeNull()
    const nf = await anon.get('/api/does-not-exist')
    expect(nf.status).toBe(404)
    expect(nf.body.error.code).toBe('not_found')
    expect((await anon.get('/api/system')).status).toBe(401)
    const u = await makeUser(t.services, 'erin@example.com')
    const sys = await Client.as(t, u).get('/api/system')
    expect(sys.body).toMatchObject({ version: '0.1.0', compileRunner: 'fake', dockerOk: true, engines: ['pdflatex', 'latex', 'xelatex', 'lualatex'], allowSignup: false })
    // pdf.js assets are served with immutable caching; unknown ones are 404 (never index.html)
    const cmap = await anon.raw('GET', '/pdfjs/cmaps/Adobe-Japan1-UCS2.bcmap')
    expect(cmap.status).toBe(200)
    expect(cmap.headers.get('cache-control')).toContain('immutable')
    expect((await anon.raw('GET', '/pdfjs/nope/x.js')).status).toBe(404)
    // malformed JSON → 400
    const c = Client.as(t, u)
    const malformed = await c.raw('PATCH', '/api/auth/me', { body: '{"name":', headers: { 'content-type': 'application/json' } })
    expect(malformed.status).toBe(400)
  })
})

describe('registration with ALLOW_SIGNUP', () => {
  let t: TestServer
  beforeAll(async () => {
    t = await startTestServer({ ALLOW_SIGNUP: 'true' })
  })
  afterAll(async () => {
    await t.close()
  })

  it('requires setup first, then registers non-admin users and rejects duplicates', async () => {
    const a = new Client(t.base)
    expect((await a.post('/api/auth/register', { email: 'a@example.com', name: 'A', password: PASSWORD })).status).toBe(403)
    await a.post('/api/auth/setup', { email: 'admin@example.com', name: 'Admin', password: PASSWORD })
    const b = new Client(t.base)
    const r = await b.post('/api/auth/register', { email: 'b@example.com', name: 'B', password: PASSWORD })
    expect(r.status).toBe(200)
    expect(r.body.isAdmin).toBe(false)
    expect((await b.get('/api/auth/me')).body.email).toBe('b@example.com')
    const dup = await new Client(t.base).post('/api/auth/register', { email: 'B@example.com', name: 'B2', password: PASSWORD })
    expect(dup.status).toBe(409)
  })

  it('rate-limits login attempts per IP (20 / 15 min)', async () => {
    const c = new Client(t.base)
    let limited = 0
    for (let i = 0; i < 22; i++) {
      const r = await c.post('/api/auth/login', { email: 'nobody@example.com', password: 'wrong password' })
      if (r.status === 429) {
        limited++
        expect(r.body.error.code).toBe('rate_limited')
      }
    }
    // setup + register + dup register above used 3 of the shared 20
    expect(limited).toBeGreaterThanOrEqual(2)
  })
})
