/**
 * Server restart in the middle of a collaborative session: both browsers reconnect by
 * themselves, keep editing, and nothing is duplicated (Yjs state is reloaded from the sidecar
 * before the disk is reconciled). Runs on an isolated server so the main one is not disturbed.
 */
import { expect, type Page } from '@playwright/test'
import {
  acquireDoc, barrier, docInsert, docText, editorText, folio, login, noAutoCompile, openFile, openProject, setCursor, startServer, test,
  waitForDocText, type ExtraServer,
} from './helpers'

let srv: ExtraServer
test.beforeAll(async () => {
  srv = await startServer({ runner: 'fake' })
})
test.afterAll(async () => {
  await srv?.stop()
})

async function signedIn(browser: import('@playwright/test').Browser, email: string): Promise<Page> {
  const ctx = await browser.newContext({ baseURL: srv.base })
  await noAutoCompile(ctx)
  const page = await ctx.newPage()
  await page.goto('/login')
  await login(page, email, srv.state.password)
  await expect(page).toHaveURL(`${srv.base}/`)
  return page
}

const count = (s: string, needle: string) => s.split(needle).length - 1

test('editing continues across a server restart without duplication', async ({ browser }) => {
  const pid = srv.state.projects.example!
  const pa = await signedIn(browser, srv.state.users.alice.email)
  const pb = await signedIn(browser, srv.state.users.bob.email)
  await openProject(pa, pid)
  await openProject(pb, pid)
  const fa = await acquireDoc(pa, 'main.tex')
  const fb = await acquireDoc(pb, 'main.tex')
  await docInsert(pa, fa, 0, '% before restart (alice)\n')
  await docInsert(pb, fb, (await docText(pb, fb)).length, '\n% before restart (bob)\n')
  await barrier(pa)
  await barrier(pb)
  await waitForDocText(pa, fa, 'before restart (bob)')
  const before = await docText(pa, fa)

  await srv.restart()

  // both pages reconnect on their own (1012 → y-websocket reconnect, fresh meta doc)
  for (const p of [pa, pb]) {
    await p.waitForFunction(() => (window as any).__folio.useProject.getState().connection === 'connected', undefined, { timeout: 30_000 })
    await p.waitForFunction(id => (window as any).__e2eDocs[id].status === 'connected' && (window as any).__e2eDocs[id].isSynced(), p === pa ? fa : fb, { timeout: 30_000 })
  }
  expect(await docText(pa, fa)).toBe(before)
  expect(await docText(pb, fb)).toBe(before)

  await docInsert(pa, fa, 0, '% after restart (alice)\n')
  await docInsert(pb, fb, (await docText(pb, fb)).length, '\n% after restart (bob)\n')
  await barrier(pa)
  await barrier(pb)
  await waitForDocText(pa, fa, 'after restart (bob)')
  await waitForDocText(pb, fb, 'after restart (alice)')
  const a = await docText(pa, fa)
  expect(await docText(pb, fb)).toBe(a)
  for (const marker of ['before restart (alice)', 'before restart (bob)', 'after restart (alice)', 'after restart (bob)']) expect(count(a, marker), marker).toBe(1)
  expect(a.length).toBe(before.length + '% after restart (alice)\n'.length + '\n% after restart (bob)\n'.length)
  // the server's copy is the same text
  const raw = await pa.evaluate(([p, f]) => fetch(`/api/projects/${p}/files/${f}/raw`).then(r => r.text()), [pid, fa] as const)
  expect(raw).toBe(a)
  expect(await folio(pa, f => f.useProject.getState().presence.length)).toBe(1)
  await pa.context().close()
  await pb.context().close()
})

test('an edit typed while the server is down is kept and saved once after the restart', async ({ browser }) => {
  const pid = srv.state.projects.example!
  const pa = await signedIn(browser, srv.state.users.alice.email)
  const pb = await signedIn(browser, srv.state.users.bob.email)
  await openProject(pa, pid)
  await openProject(pb, pid)
  await openFile(pa, 'main.tex')
  const fb = await acquireDoc(pb, 'main.tex')
  const marker = '% typed while the server was down'

  await srv.restart(async () => {
    await pa.waitForFunction(() => (window as any).__folio.useProject.getState().connection !== 'connected', undefined, { timeout: 30_000 })
    await setCursor(pa, 0)
    await pa.keyboard.type(`${marker}\n`)
    await expect(pa.locator('.lay-banner')).toContainText('main.tex')
    expect(await folio(pa, f => f.docSessions.hasPendingChanges())).toBe(true)
  })

  await pa.waitForFunction(() => !(window as any).__folio.docSessions.hasPendingChanges(), undefined, { timeout: 30_000 })
  await expect(pa.locator('.lay-banner')).toHaveCount(0)
  await waitForDocText(pb, fb, marker, 30_000)
  const raw = await pa.evaluate(([p, f]) => fetch(`/api/projects/${p}/files/${f}/raw`).then(r => r.text()), [pid, fb] as const)
  expect(count(raw, marker)).toBe(1)
  expect(await editorText(pa)).toBe(raw)
  expect(await docText(pb, fb)).toBe(raw)
  await pa.context().close()
  await pb.context().close()
})
