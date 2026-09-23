/**
 * Link sharing: a brand-new user follows a view-only link (through /login?next=), joins as a
 * viewer (read-only everywhere, enforced by the server), is upgraded by the editor link without
 * reloading, and is signed out everywhere when the administrator deletes the account.
 */
import { expect } from '@playwright/test'
import { acquireDoc, apiAs, barrier, docInsert, docReadOnly, docText, e2eState, folio, json, login, noAutoCompile, openProject, shot, test } from './helpers'

test('join by link as a viewer, then get upgraded to editor', async ({ browser }) => {
  const st = e2eState()
  const pid = st.projects.example!
  const admin = await apiAs('alice')
  const links = await json<{ viewer: string; editor: string }>(await admin.post(`/api/projects/${pid}/share-links`, { data: { role: 'viewer' } }))
  const editorLinks = await json<{ viewer: string; editor: string }>(await admin.post(`/api/projects/${pid}/share-links`, { data: { role: 'editor' } }))
  const dave = await json<{ id: string }>(await admin.post('/api/admin/users', { data: { email: 'dave@example.com', name: 'Dave Joiner', password: st.password } }))

  const ctx = await browser.newContext({ baseURL: st.base })
  await noAutoCompile(ctx)
  const page = await ctx.newPage()
  await page.goto(`/join/${links.viewer}`)
  await expect(page).toHaveURL(/\/login\?next=/)
  await login(page, 'dave@example.com')
  await expect(page.getByText('You’ll join as a viewer')).toBeVisible()
  await shot(page, 'join-viewer')
  await page.getByRole('button', { name: 'Join project' }).click()
  await expect(page).toHaveURL(new RegExp(`/project/${pid}$`))
  await openProject(page, pid)
  expect(await folio(page, f => f.useProject.getState().role)).toBe('viewer')
  await expect(page.locator('.lay-badge', { hasText: 'View only' })).toBeVisible()

  // the viewer's doc session is read-only and the server drops anything it sends
  const fileId = await acquireDoc(page, 'main.tex')
  expect(await docReadOnly(page, fileId)).toBe(true)
  const before = await (await admin.get(`/api/projects/${pid}/files/${fileId}/raw`)).text()
  await docInsert(page, fileId, 0, '% viewer was here\n')
  await barrier(page)
  expect(await (await admin.get(`/api/projects/${pid}/files/${fileId}/raw`)).text()).toBe(before)
  // REST writes are refused too
  expect(await page.evaluate(id => fetch(`/api/projects/${id}/files`, { method: 'POST', headers: { 'X-Folio-Csrf': '1', 'content-type': 'application/json' }, body: JSON.stringify({ path: 'x.tex', kind: 'text' }) }).then(r => r.status), pid)).toBe(403)

  // the editor link upgrades the open session: sockets are re-established with the new role
  expect(await page.evaluate(t => fetch(`/api/share/${t}/join`, { method: 'POST', headers: { 'X-Folio-Csrf': '1' } }).then(r => r.json()), editorLinks.editor)).toMatchObject({ role: 'editor' })
  await page.waitForFunction(() => (window as any).__folio.useProject.getState().role === 'editor', undefined, { timeout: 20_000 })
  await expect(page.locator('.lay-badge', { hasText: 'View only' })).toHaveCount(0)
  await page.evaluate(() => { (window as any).__e2eDocs = {} })
  const fid = await acquireDoc(page, 'main.tex')
  expect(await docReadOnly(page, fid)).toBe(false)
  const current = await docText(page, fid)
  await docInsert(page, fid, current.length, '\n% dave can edit now\n')
  await barrier(page)
  await expect.poll(async () => (await admin.get(`/api/projects/${pid}/files/${fid}/raw`)).text()).toContain('% dave can edit now')

  // deleting the account signs dave out everywhere (sockets closed with 4401 → login page)
  expect((await admin.delete(`/api/admin/users/${dave.id}`)).status()).toBe(204)
  await expect(page).toHaveURL(/\/login/, { timeout: 20_000 })
  // restore the file for the other specs
  const cleaned = (await (await admin.get(`/api/projects/${pid}/files/${fid}/raw`)).text()).replace('\n% dave can edit now\n', '')
  const form = { folder: '', replace: 'true', files: { name: 'main.tex', mimeType: 'text/plain', buffer: Buffer.from(cleaned) } }
  expect((await admin.post(`/api/projects/${pid}/upload`, { multipart: form })).status()).toBe(200)
  await admin.delete(`/api/projects/${pid}/share-links/viewer`)
  await admin.delete(`/api/projects/${pid}/share-links/editor`)
  await admin.dispose()
  await ctx.close()
})
