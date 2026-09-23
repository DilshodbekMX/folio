/**
 * Sign-in flows: protected pages redirect to /login?next=…, wrong passwords are refused, a
 * successful login returns to the requested page, logout signs the browser out — and closes the
 * realtime connections of that session only (another browser of the same user stays live). A
 * logout while offline signs out at once, never sends the edits still waiting, and ends the
 * server session as soon as the server can be reached again (SEC2-1) — both when the sockets
 * drop and when they survive the outage and the browser only buffers what is written to them.
 */
import { expect, request } from '@playwright/test'
import {
  acquireDoc, barrier, docInsert, docText, e2eState, fileIdByPath, folio, login, netSwitch, newProject, noAutoCompile, openFile, openProject,
  rawText, removeProject, shot, test, userContext,
} from './helpers'

test('login honours ?next=, rejects a wrong password, logout returns to /login', async ({ page }) => {
  const st = e2eState()
  const pid = st.projects.example!
  await page.goto(`/project/${pid}`)
  await expect(page).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(`/project/${pid}`).replace(/[%]/g, '%')}`))
  await expect(page.getByRole('heading', { name: 'Log in to Folio' })).toBeVisible()
  await shot(page, 'login')

  await login(page, st.users.bob.email, 'not the password')
  await expect(page.getByRole('alert')).toContainText('That email and password don’t match an account')

  await login(page, st.users.bob.email)
  await expect(page).toHaveURL(new RegExp(`/project/${pid}$`))
  await page.waitForFunction(() => (window as any).__folio?.useProject?.getState().loadState === 'ready')

  // back to the dashboard, then log out through the account menu
  await page.goto('/')
  await page.getByRole('button', { name: /Account menu for Bob Editor/ }).click()
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  await expect(page).toHaveURL(/\/login$/)
  expect(await page.evaluate(() => fetch('/api/auth/me').then(r => r.status))).toBe(401)
})

test('logging out closes that session\'s sockets only', async ({ browser }) => {
  const st = e2eState()
  const pid = st.projects.example!
  // browser A: a fresh login (its own session); browser B: bob's global-setup session
  const a = await browser.newContext({ baseURL: st.base })
  await noAutoCompile(a)
  const pa = await a.newPage()
  await pa.goto('/login')
  await login(pa, st.users.bob.email)
  await expect(pa).toHaveURL(`${st.base}/`)
  const b = await userContext(browser, 'bob')
  const pb = await b.newPage()
  await openProject(pa, pid)
  await openProject(pb, pid)
  const fa = await acquireDoc(pa, 'main.tex')
  const fb = await acquireDoc(pb, 'main.tex')

  // A logs out from another tab of the same browser session
  const other = await a.newPage()
  await other.goto('/')
  expect(await other.evaluate(() => fetch('/api/auth/logout', { method: 'POST', headers: { 'X-Folio-Csrf': '1' } }).then(r => r.status))).toBe(204)
  // A's editor loses its sockets (4401) and returns to the login page
  await expect(pa).toHaveURL(/\/login/, { timeout: 20_000 })
  // B is untouched: still connected and editing
  expect(await folio(pb, f => f.useProject.getState().connection)).toBe('connected')
  await docInsert(pb, fb, 0, '% still connected\n')
  await barrier(pb)
  expect(await docText(pb, fb)).toContain('% still connected')
  void fa
  await a.close()
  await b.close()
})

test('logging out while offline signs out at once and ends the session once the server is back', async ({ browser }) => {
  const st = e2eState()
  const pid = st.projects.example!
  // a fresh login: its own session (the shared storage states must stay signed in)
  const ctx = await browser.newContext({ baseURL: st.base })
  await noAutoCompile(ctx)
  const net = await netSwitch(ctx)
  const page = await ctx.newPage()
  await page.goto('/login')
  await login(page, st.users.bob.email)
  await expect(page).toHaveURL(`${st.base}/`)
  await openProject(page, pid)
  await openFile(page, 'main.tex')
  const fileId = await fileIdByPath(page, 'main.tex')
  const cookie = (await ctx.cookies()).find(c => c.name === 'folio_session')!
  // the same session, from outside the browser (which is about to go offline)
  const asOldSession = await request.newContext({ baseURL: st.base, storageState: { cookies: [cookie], origins: [] } })

  // offline (requests fail, the sockets drop): a line typed now cannot be sent
  await ctx.setOffline(true)
  net.down()
  await page.waitForFunction(() => (window as any).__folio.docSessions.list().every((s: any) => s.status !== 'connected'), undefined, { timeout: 20_000 })
  const marker = `typed-offline-then-logged-out-${Date.now()}`
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.type(`% ${marker}\n`)

  // back to the dashboard (asks first: unsent edits), then Account menu → Log out (asks again)
  await page.getByRole('link', { name: 'Back to your projects' }).click()
  await page.getByRole('button', { name: 'Leave anyway' }).click()
  await expect(page).toHaveURL(`${st.base}/`)
  await page.getByRole('button', { name: /Account menu for Bob Editor/ }).click()
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  await page.getByRole('button', { name: 'Log out anyway' }).click()

  // signed out here at once; the login page says the server was not told yet
  await expect(page).toHaveURL(/\/login$/)
  await expect(page.getByTestId('logout-pending')).toBeVisible()
  await shot(page, 'auth-logout-offline')
  expect(await folio(page, f => ({ status: f.useAuth.getState().status, me: f.useAuth.getState().me, docs: f.docSessions.list().length }))).toEqual({ status: 'anonymous', me: null, docs: 0 })
  expect(await page.evaluate(() => localStorage.getItem('folio:logout-pending'))).not.toBeNull()
  // …and the server never heard of it: the session is still valid meanwhile
  expect((await asOldSession.get('/api/auth/me')).status()).toBe(200)

  // network back: the logout is sent by itself, the session is gone on the server
  await ctx.setOffline(false)
  net.up()
  await expect(page.getByTestId('logout-pending')).toHaveCount(0, { timeout: 30_000 })
  expect(await page.evaluate(() => localStorage.getItem('folio:logout-pending'))).toBeNull()
  await expect.poll(async () => (await asOldSession.get('/api/auth/me')).status(), { timeout: 20_000 }).toBe(401)
  expect(await page.evaluate(() => fetch('/api/auth/me').then(r => r.status))).toBe(401)

  // the next person to open the app in this browser gets the login page
  const next = await ctx.newPage()
  await next.goto('/')
  await expect(next).toHaveURL(/\/login/)
  // the line typed offline was never sent under bob's account
  await next.waitForTimeout(2000)
  expect(await rawText(pid, fileId)).not.toContain(marker)
  await asOldSession.dispose()
  await ctx.close()
})

/**
 * The same logout during an outage the sockets *survive* (SEC2-1 residual). The browser does not
 * fail a write to a socket it cannot deliver on: it keeps the frame and flushes it when the
 * network returns — closing the socket does not drop it either. An edit typed during such a blip
 * could therefore still reach the server after the logout, moments before the retried logout
 * revoked the session. Folio disconnects every provider as soon as the browser reports no
 * network, so nothing is ever written; the edits stay local until the browser is back.
 *
 * The premise (writes are buffered and the socket stays open, unlike in the test above where the
 * sockets drop) is checked first on a raw document socket of this test's own.
 */
test('logging out during an outage the sockets survive sends nothing either', async ({ browser }) => {
  const st = e2eState()
  const pid = await newProject('Buffered logout', { template: 'example' })
  const ctx = await browser.newContext({ baseURL: st.base })
  await noAutoCompile(ctx)
  const page = await ctx.newPage()
  await page.goto('/login')
  await login(page, st.users.bob.email)
  await expect(page).toHaveURL(`${st.base}/`)
  await openProject(page, pid)
  await openFile(page, 'main.tex')
  const fileId = await fileIdByPath(page, 'main.tex')
  const epoch = await folio<number, string>(page, (f, id) => f.useProject.getState().files[id].epoch, fileId)
  const before = await rawText(pid, fileId)
  const cookie = (await ctx.cookies()).find(c => c.name === 'folio_session')!
  const asOldSession = await request.newContext({ baseURL: st.base, storageState: { cookies: [cookie], origins: [] } })

  // a document socket of our own, outside the app's control (it never sends an update): it shows
  // what the browser does with the app's writes during this outage
  await page.evaluate(async ([projectId, id, ep]) => {
    const w = window as unknown as { __canary: { ws: WebSocket; echo: boolean; closed: number | null } }
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${scheme}://${location.host}/ws/doc/${projectId}/${encodeURIComponent(id)}?epoch=${ep}`)
    ws.binaryType = 'arraybuffer'
    w.__canary = { ws, echo: false, closed: null }
    // MSG_BARRIER echo ([100, nonce]): the server applied everything sent before it
    ws.onmessage = e => { if (new Uint8Array(e.data as ArrayBuffer)[0] === 100) w.__canary.echo = true }
    ws.onclose = e => { w.__canary.closed = e.code }
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve()
      setTimeout(() => reject(new Error('the canary socket did not open')), 15_000)
    })
  }, [pid, fileId, String(epoch)] as const)
  const canary = () => page.evaluate(() => {
    const c = (window as unknown as { __canary: { ws: WebSocket; echo: boolean; closed: number | null } }).__canary
    return { readyState: c.ws.readyState, echo: c.echo, closed: c.closed }
  })

  // the premise: offline, but the socket stays open and a write is only buffered…
  await ctx.setOffline(true)
  expect((await canary()).readyState).toBe(1) // OPEN
  await page.evaluate(() => {
    // MSG_BARRIER "ping"
    (window as unknown as { __canary: { ws: WebSocket } }).__canary.ws.send(new Uint8Array([100, 4, 112, 105, 110, 103]))
  })
  await page.waitForTimeout(1000)
  expect(await canary()).toMatchObject({ readyState: 1, echo: false, closed: null })
  // …and delivered once the network is back
  await ctx.setOffline(false)
  await expect.poll(async () => (await canary()).echo, { timeout: 20_000 }).toBe(true)
  await page.waitForFunction(() => {
    const f = (window as any).__folio
    return f.useProject.getState().connection === 'connected' && f.docSessions.list().every((s: any) => s.status === 'connected')
  }, undefined, { timeout: 30_000 })

  // the outage in which the user types and logs out: Folio stops writing at once (asserted at the
  // end — what matters first is what the server is left with)
  await ctx.setOffline(true)
  await page.waitForTimeout(500)
  const duringTheOutage = await folio(page, f => f.docSessions.list().map((s: any) => s.status))
  const marker = `typed-during-a-blip-then-logged-out-${Date.now()}`
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('ControlOrMeta+Home')
  await page.keyboard.type(`% ${marker}\n`)
  await expect.poll(() => folio(page, f => f.docSessions.pendingFileIds().length), { timeout: 20_000 }).toBe(1)
  // the socket would still have carried it (this is not the dropped-socket case)
  expect((await canary()).readyState).toBe(1) // OPEN

  // back to the dashboard, then Account menu → Log out (both ask while edits are waiting)
  const asksBeforeLeaving = await folio(page, f => f.docSessions.unsyncedFileIds().length > 0)
  await page.getByRole('link', { name: 'Back to your projects' }).click()
  if (asksBeforeLeaving) await page.getByRole('button', { name: 'Leave anyway' }).click()
  await expect(page).toHaveURL(`${st.base}/`)
  await page.getByRole('button', { name: /Account menu for Bob Editor/ }).click()
  await page.getByRole('menuitem', { name: 'Log out' }).click()
  await page.getByRole('button', { name: 'Log out anyway' }).click()
  await expect(page).toHaveURL(/\/login$/)
  expect(await folio(page, f => f.docSessions.list().length)).toBe(0)

  // the network returns: the logout reaches the server and nothing else does
  await ctx.setOffline(false)
  await expect(page.getByTestId('logout-pending')).toHaveCount(0, { timeout: 30_000 })
  await expect.poll(async () => (await asOldSession.get('/api/auth/me')).status(), { timeout: 20_000 }).toBe(401)
  // the server closes the sockets of the session it just ended (our canary is one of them)
  await expect.poll(async () => (await canary()).closed, { timeout: 20_000 }).toBe(4401)
  await page.waitForTimeout(2000)
  expect(await rawText(pid, fileId)).toBe(before)
  // …because Folio stopped writing when the browser reported the outage, and said so
  expect(duringTheOutage).toEqual(['disconnected'])
  expect(asksBeforeLeaving).toBe(true)
  await asOldSession.dispose()
  await ctx.close()
  await removeProject(pid)
})
