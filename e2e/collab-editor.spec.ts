/**
 * Collaboration through the editor UI: two editors typing in the same file see each other's
 * text, presence and named carets; undo is per user; a viewer's editor is read-only; a role
 * change applies to an open editor without a reload; edits made while the connection is down
 * are kept, announced, protected against closing the tab, and sent once it is back.
 *
 * Offline edits to a file a collaborator deleted, deleted and re-created at the same path, or
 * replaced (text → binary, new epoch) meanwhile are never dropped: a persistent notice keeps
 * the text (copy, save as a new file, compare with the file now there); a rename just follows.
 * Offline edits of an editor who was made a viewer meanwhile are refused by the server and kept
 * the same way (copy, download — viewers cannot create files); the editor turns read-only on the
 * server's text. A plain viewer's connection that drops and comes back is not disturbed.
 *
 * After a reconnect the project (meta) socket comes back on its own backoff, later than the
 * document sockets: state it carries (the file tree) is waited for, never read at once.
 */
import fs from 'node:fs'
import { expect, type BrowserContext, type Page } from '@playwright/test'
import {
  apiAs, barrier, editorIndex, editorText, e2eState, fileIdByPath, folio, json, netSwitch, newProject, openFile, openProject, rawText,
  removeProject, setCursor, shot, test, uploadFile, userContext, waitForEditorText, type NetSwitch,
} from './helpers'

const MAIN = '\\documentclass{article}\n\\begin{document}\n\\section{Shared}\nFirst paragraph of the shared text.\n\nSecond paragraph, written together.\n\\end{document}\n'

let pid: string
test.beforeAll(async () => {
  pid = await newProject('E2E Collaboration', { files: [{ path: 'main.tex', content: MAIN }] })
})
test.afterAll(async () => {
  if (pid) await removeProject(pid)
})

async function editorPage(browser: import('@playwright/test').Browser, user: 'alice' | 'bob' | 'carol'): Promise<Page> {
  const ctx = await userContext(browser, user)
  const page = await ctx.newPage()
  await openProject(page, pid)
  await openFile(page, 'main.tex')
  return page
}

test('two editors type in the same file: live text, presence, named carets, per-user undo', async ({ browser }) => {
  const pa = await editorPage(browser, 'alice')
  const pb = await editorPage(browser, 'bob')
  const original = await editorText(pa)
  expect(await editorText(pb)).toBe(original)

  // presence: the top bar counts the other user, the file tree shows where they are
  await expect(pa.locator('.lay-presence')).toHaveAttribute('aria-label', /1 online/)
  await expect(pa.locator('.ft-row[data-path="main.tex"] .ft-presence')).toHaveAttribute('aria-label', /Bob Editor/)

  await setCursor(pa, await editorIndex(pa, 'First paragraph'))
  await pa.keyboard.type('ALICE-TYPED ')
  await waitForEditorText(pb, 'ALICE-TYPED First paragraph')
  await setCursor(pb, (await editorIndex(pb, 'written together')) + 'written together'.length)
  await pb.keyboard.type(' BOB-TYPED')
  await waitForEditorText(pa, 'written together BOB-TYPED')

  // each sees the other's caret, labelled with the name
  await expect(pb.locator('.cm-ySelectionInfo', { hasText: 'Alice Admin' })).toHaveCount(1)
  await expect(pa.locator('.cm-ySelectionInfo', { hasText: 'Bob Editor' })).toHaveCount(1)
  await shot(pb, 'collab-bob-sees-alice')

  // alice's undo removes her own typing only; both editors agree
  await folio(pa, f => f.useEditor.getState().view.focus())
  await pa.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => editorText(pa)).not.toContain('ALICE-TYPED')
  expect(await editorText(pa)).toContain(' BOB-TYPED')
  await expect.poll(() => editorText(pb)).not.toContain('ALICE-TYPED')
  await pa.keyboard.press('ControlOrMeta+Shift+KeyZ') // a real keyboard sends 'Z' with Shift
  await expect.poll(() => editorText(pa)).toContain('ALICE-TYPED')
  await pa.keyboard.press('ControlOrMeta+z')
  await folio(pb, f => f.useEditor.getState().view.focus())
  await pb.keyboard.press('ControlOrMeta+z')
  await expect.poll(() => editorText(pa)).toBe(original)
  await expect.poll(() => editorText(pb)).toBe(original)
  await barrier(pa)
  await barrier(pb)
  expect(await rawText(pid, await fileIdByPath(pa, 'main.tex'))).toBe(original)
  await pa.context().close()
  await pb.context().close()
})

test('a viewer gets a read-only editor; demoting and promoting an editor applies live', async ({ browser }) => {
  const pc = await editorPage(browser, 'carol')
  await expect(pc.locator('.ed-badge', { hasText: 'Read only' })).toBeVisible()
  expect(await folio(pc, f => f.useEditor.getState().view.state.readOnly)).toBe(true)
  const before = await editorText(pc)
  await pc.locator('.cm-content').click()
  await pc.keyboard.type('CAROL')
  await pc.keyboard.press('Enter')
  expect(await editorText(pc)).toBe(before)
  // she can still search the file, without the replace row
  await pc.keyboard.press('ControlOrMeta+f')
  await expect(pc.locator('.ed-search')).toBeVisible()
  await expect(pc.locator('.ed-search__row--replace:not([hidden])')).toHaveCount(0)
  await pc.keyboard.press('Escape')
  await pc.context().close()

  // bob is an editor with the file open; the owner makes him a viewer, then an editor again
  const pb = await editorPage(browser, 'bob')
  expect(await folio(pb, f => f.useEditor.getState().view.state.readOnly)).toBe(false)
  const api = await apiAs('alice')
  const share = await json<{ members: { user: { id: string; email: string } }[] }>(await api.get(`/api/projects/${pid}/share`))
  const bobId = share.members.find(m => m.user.email === e2eState().users.bob.email)!.user.id
  await json(await api.patch(`/api/projects/${pid}/members/${bobId}`, { data: { role: 'viewer' } }))
  await pb.waitForFunction(() => {
    const f = (window as any).__folio
    const v = f.useEditor.getState().view
    return f.useProject.getState().role === 'viewer' && !!v && v.state.readOnly === true
  }, undefined, { timeout: 20_000 })
  await expect(pb.locator('.ed-badge', { hasText: 'Read only' })).toBeVisible()
  const text = await editorText(pb)
  await setCursor(pb, 10)
  await pb.keyboard.type('nope')
  expect(await editorText(pb)).toBe(text)

  await json(await api.patch(`/api/projects/${pid}/members/${bobId}`, { data: { role: 'editor' } }))
  await pb.waitForFunction(() => {
    const f = (window as any).__folio
    const v = f.useEditor.getState().view
    return f.useProject.getState().role === 'editor' && !!v && v.state.readOnly === false
  }, undefined, { timeout: 20_000 })
  await expect(pb.locator('.ed-badge', { hasText: 'Read only' })).toHaveCount(0)
  await api.dispose()
  await pb.context().close()
})

test('a collaborator deletes the file being typed in: the editor closes to a notice, no keystroke lands elsewhere', async ({ browser }) => {
  const api = await apiAs('alice')
  const chap = await json<{ id: string }>(await api.post(`/api/projects/${pid}/files`, { data: { path: 'chap.tex', kind: 'text', content: 'Chapter text.\n' } }))
  await api.dispose()
  const pa = await editorPage(browser, 'alice')
  const mainId = await fileIdByPath(pa, 'main.tex')
  const mainBefore = await rawText(pid, mainId)
  await pa.waitForFunction(() => !!(window as any).__folio.useProject.getState().fileByPath('chap.tex'))
  await openFile(pa, 'chap.tex')
  await setCursor(pa, -1)

  // alice keeps typing while bob deletes the file
  let typing = true
  const typer = (async () => {
    for (let i = 0; typing; i++) await pa.keyboard.type(`q${i} `, { delay: 10 })
  })()
  await expect.poll(() => editorText(pa)).toContain('q3 ')
  const bobApi = await apiAs('bob')
  expect((await bobApi.delete(`/api/projects/${pid}/files/${chap.id}`)).status()).toBe(200)
  await bobApi.dispose()
  await expect(pa.getByText('“chap.tex” was deleted', { exact: true })).toBeVisible()
  typing = false
  await typer
  await expect(pa.getByRole('button', { name: 'Open history' })).toBeVisible()
  await expect(pa.getByRole('button', { name: 'Copy its text' })).toBeVisible()
  // the files:changed event names who did it
  await expect(pa.locator('.ui-toast').filter({ hasText: '“chap.tex” was deleted by Bob Editor while you had it open' })).toBeVisible()
  await expect(pa.getByText('Bob Editor deleted it while you had it open', { exact: false })).toBeVisible()
  expect(await folio(pa, f => f.useEditor.getState().openFileId)).toBeNull()
  expect(await folio(pa, f => f.closedFileNotice()?.lastText ?? '')).toContain('Chapter text.')
  // the keystrokes after the deletion went nowhere: main.tex is untouched
  await pa.keyboard.type('stray')
  expect(await rawText(pid, mainId)).toBe(mainBefore)
  await shot(pa, 'collab-file-deleted')
  await pa.context().close()
})

test('edits made while offline are kept, announced, and sent when the connection is back', async ({ browser }) => {
  const ctx = await userContext(browser, 'alice')
  const net = await netSwitch(ctx)
  const page = await ctx.newPage()
  await openProject(page, pid)
  await openFile(page, 'main.tex')
  const fileId = await fileIdByPath(page, 'main.tex')

  net.down()
  await page.waitForFunction(() => (window as any).__folio.docSessions.list().every((s: any) => s.status !== 'connected'), undefined, { timeout: 15_000 })
  const marker = `% offline edit ${Date.now()}`
  await setCursor(page, -1)
  await page.keyboard.type(`\n${marker}`)

  // the edit is pending, the banner names the file, the editor says "Offline", closing the tab asks first
  expect(await folio(page, f => f.docSessions.hasPendingChanges())).toBe(true)
  const banner = page.locator('.lay-banner')
  await expect(banner).toContainText('haven’t been saved yet')
  await expect(banner).toContainText('main.tex')
  await expect(page.locator('.ed-badge--offline')).toBeVisible()
  expect(await page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)
    return e.defaultPrevented
  })).toBe(true)
  expect(await rawText(pid, fileId)).not.toContain(marker)
  await shot(page, 'collab-offline-banner')
  // leaving the project in the app asks too; staying keeps the editor
  await page.getByRole('link', { name: 'Back to your projects' }).click()
  const dialog = page.getByRole('dialog', { name: 'Leave with unsaved changes?' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Stay' }).click()
  await expect(dialog).toHaveCount(0)
  expect(new URL(page.url()).pathname).toBe(`/project/${pid}`)

  net.up()
  await expect.poll(() => rawText(pid, fileId), { timeout: 30_000 }).toContain(marker)
  await page.waitForFunction(() => !(window as any).__folio.docSessions.hasPendingChanges(), undefined, { timeout: 15_000 })
  await expect(banner).toHaveCount(0)
  expect(await page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)
    return e.defaultPrevented
  })).toBe(false)
  // exactly once, and the editor still agrees with the server
  const text = await rawText(pid, fileId)
  expect(text.split(marker).length - 1).toBe(1)
  expect(await editorText(page)).toBe(text)
  await ctx.close()
})

test('leaving the project with unsent edits: they are still sent from the dashboard, which says so', async ({ browser }) => {
  const ctx = await userContext(browser, 'alice')
  const net = await netSwitch(ctx)
  const page = await ctx.newPage()
  await openProject(page, pid)
  await openFile(page, 'main.tex')
  const fileId = await fileIdByPath(page, 'main.tex')
  net.down()
  await page.waitForFunction(() => (window as any).__folio.docSessions.list().every((s: any) => s.status !== 'connected'), undefined, { timeout: 15_000 })
  const marker = `% sent after leaving ${Date.now()}`
  await setCursor(page, -1)
  await page.keyboard.type(`\n${marker}`)

  await page.getByRole('link', { name: 'Back to your projects' }).click()
  await page.getByRole('dialog', { name: 'Leave with unsaved changes?' }).getByRole('button', { name: 'Leave anyway' }).click()
  await page.waitForURL(u => new URL(u).pathname === '/')
  await expect(page.locator('.ui-toast', { hasText: 'Still saving your changes' })).toContainText('E2E Collaboration')
  expect(await rawText(pid, fileId)).not.toContain(marker)

  net.up()
  await expect.poll(() => rawText(pid, fileId), { timeout: 30_000 }).toContain(marker)
  await expect(page.locator('.ui-toast', { hasText: 'were saved' })).toContainText('E2E Collaboration')
  await expect(page.locator('.ui-toast', { hasText: 'Still saving your changes' })).toHaveCount(0)
  await expect.poll(() => folio(page, f => f.docSessions.list().length)).toBe(0) // drained sessions close
  await ctx.close()
})

test('an offline edit survives opening many other files (the idle-session limit never drops it)', async ({ browser }) => {
  const api = await apiAs('alice')
  const others = Array.from({ length: 10 }, (_, i) => `many/f${i}.tex`)
  for (const p of others) await json(await api.post(`/api/projects/${pid}/files`, { data: { path: p, kind: 'text', content: `File ${p}.\n` } }))
  await api.dispose()
  const ctx = await userContext(browser, 'alice')
  const net = await netSwitch(ctx)
  const page = await ctx.newPage()
  await openProject(page, pid)
  await openFile(page, 'main.tex')
  const mainId = await fileIdByPath(page, 'main.tex')
  net.down()
  await page.waitForFunction(() => (window as any).__folio.docSessions.list().every((s: any) => s.status !== 'connected'), undefined, { timeout: 15_000 })
  const marker = `% offline, then ten other files ${Date.now()}`
  await setCursor(page, -1)
  await page.keyboard.type(`\n${marker}`)
  for (const p of others) {
    const id = await fileIdByPath(page, p)
    await folio(page, (f, fid: string) => f.useEditor.getState().openFile(fid), id)
    await page.waitForFunction(fid => (window as any).__folio.useEditor.getState().openFileId === fid, id)
  }
  expect(await folio(page, (f, id: string) => f.docSessions.list().some((s: any) => s.fileId === id), mainId)).toBe(true)
  net.up()
  await expect.poll(() => rawText(pid, mainId), { timeout: 30_000 }).toContain(marker)
  await page.waitForFunction(() => !(window as any).__folio.docSessions.hasPendingChanges(), undefined, { timeout: 15_000 })
  await ctx.close()
})

// ---------------------------------------------------------------------------
// INT-1: offline edits to a file a collaborator deletes, re-creates or replaces
// ---------------------------------------------------------------------------

/**
 * Alice with `path` open in her editor and a switch for her WebSockets. `create`: the file is
 * created (by alice, through the API) once her page is open, so it sees that 'files:changed'.
 */
async function aliceOn(browser: import('@playwright/test').Browser, path: string, create?: string): Promise<{ ctx: BrowserContext; net: NetSwitch; page: Page; fileId: string }> {
  return userOn(browser, 'alice', path, create)
}

/** `user` with `path` open in the editor and a switch for the WebSockets (see aliceOn). */
async function userOn(browser: import('@playwright/test').Browser, user: 'alice' | 'bob' | 'carol', path: string, create?: string): Promise<{ ctx: BrowserContext; net: NetSwitch; page: Page; fileId: string }> {
  const ctx = await userContext(browser, user, { permissions: ['clipboard-read', 'clipboard-write'], acceptDownloads: true })
  const net = await netSwitch(ctx)
  const page = await ctx.newPage()
  await openProject(page, pid)
  if (create !== undefined) await createText(path, create)
  await page.waitForFunction(p => !!(window as any).__folio.useProject.getState().fileByPath(p), path)
  await openFile(page, path)
  return { ctx, net, page, fileId: await fileIdByPath(page, path) }
}

/** Wait until the project (meta) socket is connected again and its file tree has `path` as `fileId`. */
async function waitForPath(page: Page, path: string, fileId: string): Promise<void> {
  await page.waitForFunction(([p, id]) => {
    const st = (window as any).__folio.useProject.getState()
    return st.connection === 'connected' && st.fileByPath(p)?.id === id
  }, [path, fileId] as const, { timeout: 30_000 })
}

/** Cut Alice's connection and type `text` at the end of the open file (the edit stays pending). */
async function typeOffline(page: Page, net: NetSwitch, text: string): Promise<void> {
  net.down()
  await page.waitForFunction(() => (window as any).__folio.docSessions.list().every((s: any) => s.status !== 'connected'), undefined, { timeout: 15_000 })
  await setCursor(page, -1)
  await page.keyboard.type(text)
  expect(await folio(page, f => f.docSessions.hasPendingChanges())).toBe(true)
}

async function createText(path: string, content: string, user: 'alice' | 'bob' = 'alice'): Promise<string> {
  const api = await apiAs(user)
  try {
    return (await json<{ id: string }>(await api.post(`/api/projects/${pid}/files`, { data: { path, kind: 'text', content } }))).id
  } finally {
    await api.dispose()
  }
}

async function bobDeletes(fileId: string): Promise<void> {
  const api = await apiAs('bob')
  try {
    expect((await api.delete(`/api/projects/${pid}/files/${fileId}`)).status()).toBe(200)
  } finally {
    await api.dispose()
  }
}

async function keptTexts(page: Page): Promise<{ fileId: string; path: string; text: string; offline: boolean; code: number | null; by: { name: string } | null }[]> {
  return folio(page, f => f.recovered.items())
}

test('offline edits to a file deleted and re-created meanwhile are kept: persistent notice, compare, copy, save as new file', async ({ browser }) => {
  await createText('b.tex', 'B original text.\n')
  const { ctx, net, page, fileId: oldId } = await aliceOn(browser, 'b.tex')
  const marker = `% alice offline in b.tex ${Date.now()}`
  await typeOffline(page, net, `\n${marker}`)

  // meanwhile bob deletes b.tex and creates a new b.tex (new file id)
  await bobDeletes(oldId)
  const newId = await createText('b.tex', 'B recreated by Bob.\n', 'bob')
  net.up()

  // the editor shows the new b.tex (without the offline edit) …
  await page.waitForFunction(id => (window as any).__folio.useEditor.getState().openFileId === id, newId, { timeout: 30_000 })
  await waitForEditorText(page, 'B recreated by Bob.')
  expect(await editorText(page)).not.toContain(marker)
  expect(await rawText(pid, newId)).toBe('B recreated by Bob.\n')
  // … and alice's text is kept, in a notice that stays
  const notice = page.getByTestId('recovered-notice')
  await expect(notice).toHaveCount(1)
  await expect(notice).toContainText('Your unsaved changes to “b.tex” were kept.')
  await expect(notice).toContainText('“b.tex” was deleted while you were offline and a new file was created in its place. Your changes are not in it.')
  const [kept] = await keptTexts(page)
  expect(kept).toMatchObject({ fileId: oldId, path: 'b.tex', offline: true })
  expect(kept.text).toBe(`B original text.\n\n${marker}`)
  // the notice replaces the transient "was replaced" toast; it does not time out
  await expect(page.locator('.ui-toast', { hasText: 'was replaced' })).toHaveCount(0)
  await page.waitForTimeout(10_500)
  await expect(notice).toBeVisible()
  expect(await folio(page, f => f.docSessions.hasPendingChanges())).toBe(false)
  await shot(page, 'collab-kept-text-notice')

  // compare with the new b.tex
  await notice.getByRole('button', { name: 'Compare with current' }).click()
  const dialog = page.getByRole('dialog', { name: 'Compare “b.tex”' })
  await expect(dialog).toBeVisible()
  await expect(dialog.locator('.cm-content')).toContainText(marker)
  await expect(dialog.locator('.cm-deletedChunk, .cm-deletedLine').first()).toContainText('B recreated by Bob.')
  await shot(page, 'collab-kept-text-compare')
  await dialog.locator('.ui-modal__footer').getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toHaveCount(0)

  // copy
  await notice.getByRole('button', { name: 'Copy my text' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(kept.text)

  // save as a new file next to it, which then opens
  await notice.getByRole('button', { name: 'Save as new file' }).click()
  await expect(notice).toContainText('They are saved in “b (recovered).tex”.')
  const savedId = await folio(page, f => f.useProject.getState().fileByPath('b (recovered).tex')?.id ?? null)
  expect(savedId).toBeTruthy()
  expect(await rawText(pid, savedId!)).toBe(kept.text)
  await page.waitForFunction(id => (window as any).__folio.useEditor.getState().openFileId === id, savedId)
  await waitForEditorText(page, marker)
  // b.tex itself is bob's
  expect(await rawText(pid, newId)).toBe('B recreated by Bob.\n')

  // saved: dismissing needs no confirmation
  await notice.getByRole('button', { name: /^Dismiss/ }).click()
  await expect(notice).toHaveCount(0)
  expect(await keptTexts(page)).toEqual([])
  await ctx.close()
})

test('offline edits to a deleted file are kept; a file re-created there later can be compared; dismissing asks first', async ({ browser }) => {
  // created while alice's page is open: her own 'files:changed' for it must not read as "deleted by you"
  const { ctx, net, page, fileId } = await aliceOn(browser, 'c.tex', 'C original.\n')
  const marker = `% alice offline in c.tex ${Date.now()}`
  await typeOffline(page, net, `\n${marker}`)
  await bobDeletes(fileId)
  net.up()

  // the editor closes to its "deleted" state; the kept text has its notice
  await expect(page.getByText('“c.tex” was deleted', { exact: true })).toBeVisible({ timeout: 30_000 })
  const notice = page.getByTestId('recovered-notice')
  await expect(notice).toContainText('Your unsaved changes to “c.tex” were kept. “c.tex” was deleted while you were offline.')
  await expect(notice).not.toContainText('by you')
  await expect(notice.getByRole('button', { name: 'Compare with current' })).toHaveCount(0)
  await expect(page.locator('.ui-toast', { hasText: 'Your unsaved changes to it were kept' })).toBeVisible()
  expect((await keptTexts(page))[0].text).toBe(`C original.\n\n${marker}`)

  // online now: bob creates c.tex again — the notice says so and can compare
  await createText('c.tex', 'C, a new file.\n', 'bob')
  await expect(notice).toContainText('“c.tex” was deleted while you were offline and a new file was created in its place.')
  await notice.getByRole('button', { name: 'Compare with current' }).click()
  const dialog = page.getByRole('dialog', { name: 'Compare “c.tex”' })
  await expect(dialog.locator('.cm-content')).toContainText(marker)
  await dialog.locator('.ui-modal__footer').getByRole('button', { name: 'Close' }).click()

  // dismissing a text saved nowhere asks first
  await notice.getByRole('button', { name: /^Dismiss/ }).click()
  const confirm = page.getByRole('alertdialog', { name: 'Discard your kept text?' }).or(page.getByRole('dialog', { name: 'Discard your kept text?' }))
  await expect(confirm).toBeVisible()
  await confirm.getByRole('button', { name: 'Cancel' }).click()
  await expect(notice).toHaveCount(1)
  await notice.getByRole('button', { name: /^Dismiss/ }).click()
  await confirm.getByRole('button', { name: 'Discard' }).click()
  await expect(notice).toHaveCount(0)
  await ctx.close()
})

test('the kept text survives a reload of the tab, and the tab asks before closing while it is kept', async ({ browser }) => {
  await createText('r.tex', 'R original.\n')
  const { ctx, net, page, fileId } = await aliceOn(browser, 'r.tex')
  const marker = `% kept across a reload ${Date.now()}`
  await typeOffline(page, net, `\n${marker}`)
  await bobDeletes(fileId)
  net.up()
  const notice = page.getByTestId('recovered-notice')
  await expect(notice).toContainText('Your unsaved changes to “r.tex” were kept.', { timeout: 30_000 })
  expect(await page.evaluate(() => {
    const e = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(e)
    return e.defaultPrevented
  })).toBe(true)
  page.on('dialog', d => void d.accept())
  await page.reload()
  await openProject(page, pid).catch(() => {})
  await expect(page.getByTestId('recovered-notice')).toContainText('Your unsaved changes to “r.tex” were kept.')
  expect((await keptTexts(page))[0].text).toBe(`R original.\n\n${marker}`)
  await ctx.close()
})

test('a collaborator renames the file while alice edits offline: her edits follow it, nothing is set aside', async ({ browser }) => {
  const id = await createText('ren.tex', 'Rename me.\n')
  const { ctx, net, page } = await aliceOn(browser, 'ren.tex')
  const marker = `% offline, file renamed meanwhile ${Date.now()}`
  await typeOffline(page, net, `\n${marker}`)
  const bob = await apiAs('bob')
  await json(await bob.patch(`/api/projects/${pid}/files/${id}`, { data: { path: 'renamed/ren2.tex' } }))
  await bob.dispose()
  net.up()
  await expect.poll(() => rawText(pid, id), { timeout: 30_000 }).toContain(marker)
  await page.waitForFunction(() => !(window as any).__folio.docSessions.hasPendingChanges(), undefined, { timeout: 15_000 })
  // the document socket is back first; the file tree (project socket, own backoff) follows
  await waitForPath(page, 'renamed/ren2.tex', id)
  expect(await folio(page, f => f.useEditor.getState().openFileId)).toBe(id)
  await expect(page.locator('.ed-crumbs__file')).toHaveText('ren2.tex')
  expect(await editorText(page)).toBe(await rawText(pid, id))
  await expect(page.getByTestId('recovered-notice')).toHaveCount(0)
  expect(await keptTexts(page)).toEqual([])
  await ctx.close()
})

test('a collaborator replaces the file with a binary (new epoch) while alice edits offline: her text is kept', async ({ browser }) => {
  const id = await createText('fig.tex', 'Figure source.\n')
  const { ctx, net, page } = await aliceOn(browser, 'fig.tex')
  const marker = `% offline before the binary replace ${Date.now()}`
  await typeOffline(page, net, `\n${marker}`)
  const bob = await apiAs('bob')
  await uploadFile(bob, pid, 'fig.tex', Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]))
  await bob.dispose()
  net.up()

  const notice = page.getByTestId('recovered-notice')
  await expect(notice).toContainText('Your unsaved changes to “fig.tex” were kept. “fig.tex” was replaced with a new version while you were offline. Your changes are not in it.', { timeout: 30_000 })
  // the same file id, now binary at epoch 1: the editor shows its preview; nothing to compare
  await page.waitForFunction(fid => (window as any).__folio.useProject.getState().files[fid]?.kind === 'binary', id)
  expect(await folio(page, (f, fid: string) => f.useProject.getState().files[fid].epoch, id)).toBe(1)
  await expect(page.locator('.ed-pane__binary')).toBeVisible()
  await expect(notice.getByRole('button', { name: 'Compare with current' })).toHaveCount(0)
  const [kept] = await keptTexts(page)
  expect(kept).toMatchObject({ fileId: id, path: 'fig.tex', offline: true })
  expect(kept.text).toBe(`Figure source.\n\n${marker}`)

  await notice.getByRole('button', { name: 'Save as new file' }).click()
  await expect(notice).toContainText('They are saved in “fig (recovered).tex”.')
  const savedId = await fileIdByPath(page, 'fig (recovered).tex')
  expect(await rawText(pid, savedId)).toBe(kept.text)
  await page.waitForFunction(sid => (window as any).__folio.useEditor.getState().openFileId === sid, savedId)
  await ctx.close()
})

test('online: a file deleted by a collaborator before alice’s last keystrokes were confirmed keeps them, naming who deleted it', async ({ browser }) => {
  const id = await createText('fast.tex', 'Fast.\n')
  const { ctx, page } = await aliceOn(browser, 'fast.tex')
  await setCursor(page, -1)
  const marker = ' typed-just-before-the-delete'
  await page.keyboard.type(marker)
  // confirmation barriers go out 300 ms after a keystroke: delete right away
  const bob = await apiAs('bob')
  const res = bob.delete(`/api/projects/${pid}/files/${id}`)
  const pendingAtDelete = await folio(page, f => f.docSessions.hasPendingChanges())
  expect((await res).status()).toBe(200)
  await bob.dispose()
  await expect(page.getByText('“fast.tex” was deleted', { exact: true })).toBeVisible()
  if (pendingAtDelete) {
    const notice = page.getByTestId('recovered-notice')
    await expect(notice).toContainText('“fast.tex” was deleted by Bob Editor before the server confirmed them.')
    expect((await keptTexts(page))[0].text).toContain(marker)
  }
  // either way the keystrokes that reached the server are in history (snapshot before the delete)
  const api = await apiAs('alice')
  const versions = await json<{ versions: { id: string; reason: string; summary?: string }[] }>(await api.get(`/api/projects/${pid}/history/versions`))
  const pre = versions.versions.find(v => v.summary === 'Before deleting fast.tex')
  expect(pre).toBeTruthy()
  const atPre = await (await api.get(`/api/projects/${pid}/history/versions/${pre!.id}/file?path=fast.tex`)).text()
  expect(atPre.startsWith('Fast.')).toBe(true)
  await api.dispose()
  await ctx.close()
})

// ---------------------------------------------------------------------------
// Role changes while offline
// ---------------------------------------------------------------------------

async function memberId(user: 'bob' | 'carol'): Promise<string> {
  const api = await apiAs('alice')
  try {
    const share = await json<{ members: { user: { id: string; email: string } }[] }>(await api.get(`/api/projects/${pid}/share`))
    return share.members.find(m => m.user.email === e2eState().users[user].email)!.user.id
  } finally {
    await api.dispose()
  }
}

async function setRole(userId: string, role: 'editor' | 'viewer'): Promise<void> {
  const api = await apiAs('alice')
  try {
    await json(await api.patch(`/api/projects/${pid}/members/${userId}`, { data: { role } }))
  } finally {
    await api.dispose()
  }
}

test('an editor made a viewer while offline: the refused edits are kept (copy, download), the editor turns read-only on the server’s text', async ({ browser }) => {
  const original = 'Demoted original.\n'
  const id = await createText('demoted.tex', original)
  const bobId = await memberId('bob')
  const { ctx, net, page } = await userOn(browser, 'bob', 'demoted.tex')
  try {
    const marker = `% bob offline, made a viewer meanwhile ${Date.now()}`
    await typeOffline(page, net, `\n${marker}`)
    // his sockets are down: the role change cannot close them now
    await setRole(bobId, 'viewer')
    net.up()

    const notice = page.getByTestId('recovered-notice')
    await expect(notice).toContainText('Your unsaved changes to “demoted.tex” were kept.', { timeout: 30_000 })
    await expect(notice).toContainText('Your role in this project was changed to viewer while you were offline, so the server did not accept them.')
    // the client knows its new role; the editor is read-only and shows the server's text
    await page.waitForFunction(fid => {
      const f = (window as any).__folio
      const v = f.useEditor.getState().view
      const s = f.docSessions.get(fid)
      return f.useProject.getState().role === 'viewer' && f.useEditor.getState().openFileId === fid
        && !!v && v.state.readOnly === true && !!s && s.readOnly && s.isSynced() && s.status === 'connected'
    }, id, { timeout: 30_000 })
    await expect(page.locator('.ed-badge', { hasText: 'Read only' })).toBeVisible()
    expect(await editorText(page)).toBe(original)
    expect(await rawText(pid, id)).toBe(original)
    expect(await folio(page, f => f.docSessions.hasPendingChanges())).toBe(false)
    const [kept] = await keptTexts(page)
    expect(kept).toMatchObject({ fileId: id, path: 'demoted.tex', offline: true, code: 4403 })
    expect(kept.text).toBe(`${original}\n${marker}`)
    await shot(page, 'collab-demoted-offline-kept')

    // viewers cannot create files: copy it, or download it
    await expect(notice.getByRole('button', { name: 'Save as new file' })).toHaveCount(0)
    await notice.getByRole('button', { name: 'Copy my text' }).click()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(kept.text)
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      notice.getByRole('button', { name: 'Download as file' }).click(),
    ])
    expect(download.suggestedFilename()).toBe('demoted (recovered).tex')
    expect(fs.readFileSync(await download.path(), 'utf8')).toBe(kept.text)

    // typing goes nowhere, and the server never got the refused edit
    await setCursor(page, 3)
    await page.keyboard.type('nope')
    expect(await editorText(page)).toBe(original)
    await page.waitForTimeout(1000)
    expect(await rawText(pid, id)).toBe(original)
  } finally {
    await setRole(bobId, 'editor')
    await ctx.close()
  }
})

test('a viewer whose connection drops and comes back stays connected and catches up (nothing is set aside)', async ({ browser }) => {
  const id = await createText('viewed.tex', 'Viewed, first version.\n')
  const { ctx, net, page } = await userOn(browser, 'carol', 'viewed.tex')
  const alice = await apiAs('alice')
  try {
    // two rounds: from the second one on, carol's copy holds deletions (the server knows them)
    for (const text of ['Viewed, changed while carol was away.\n', 'Viewed, changed again.\n']) {
      net.down()
      await page.waitForFunction(() => (window as any).__folio.docSessions.list().every((s: any) => s.status !== 'connected'), undefined, { timeout: 15_000 })
      await uploadFile(alice, pid, 'viewed.tex', Buffer.from(text))
      net.up()
      await waitForEditorText(page, text, 30_000)
      expect(await editorText(page)).toBe(text)
    }
    await page.waitForTimeout(1500)
    const s = await folio(page, (f, fid: string) => {
      const x = f.docSessions.get(fid)
      return x ? { status: x.status, closeCode: x.closeCode, stale: x.stale, readOnly: x.readOnly } : null
    }, id)
    expect(s).toEqual({ status: 'connected', closeCode: null, stale: false, readOnly: true })
    expect(await folio(page, f => f.useProject.getState().role)).toBe('viewer')
    await expect(page.getByTestId('recovered-notice')).toHaveCount(0)
    expect(await keptTexts(page)).toEqual([])
  } finally {
    await alice.dispose()
    await ctx.close()
  }
})
