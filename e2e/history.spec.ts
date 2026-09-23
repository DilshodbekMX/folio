/**
 * Project history on a throw-away project with two editors: opening History records a version
 * (author, changed file, summary) and shows its diff; a collaborator's new version appears live;
 * comparing a range; labels (add, filter, delete, seen live); downloading a version; restoring one
 * file (the collaborator's editor follows) and the whole project (newer files removed), each
 * recorded as a "Restored …" version; a viewer browses without restore or label actions.
 */
import fs from 'node:fs'
import { expect, type Page } from '@playwright/test'
import { apiAs, fileIdByPath, folio, json, newProject, openFile, openProject, rawText, removeProject, shot, test, userContext } from './helpers'

const MAIN = '\\documentclass{article}\n\\begin{document}\n\\section{Introduction}\nOriginal introduction.\n\n\\section{Method}\nOriginal method.\n\\end{document}\n'
const stamp = Date.now().toString(36)
const MARK_A = `% HISTORY-A-${stamp}: alice was here`
const MARK_B = `% HISTORY-B-${stamp}: bob was here`

interface Version { id: string; summary?: string; reason: string; restoredFrom?: { versionId: string; path?: string }; authors: { name: string }[]; changes: { path: string }[] }

let pid: string
let baseVersion: string
let a: Page
let b: Page

test.describe.configure({ mode: 'serial' })

async function versions(): Promise<Version[]> {
  const api = await apiAs('alice')
  try {
    return (await json<{ versions: Version[] }>(await api.get(`/api/projects/${pid}/history/versions?limit=50`))).versions
  } finally {
    await api.dispose()
  }
}

test.beforeAll(async ({ browser }) => {
  pid = await newProject('E2E History', { files: [{ path: 'main.tex', content: MAIN }] })
  const api = await apiAs('alice')
  await json(await api.post(`/api/projects/${pid}/history/snapshot`))
  await api.dispose()
  baseVersion = (await versions())[0].id
  a = await (await userContext(browser, 'alice', { acceptDownloads: true })).newPage()
  b = await (await userContext(browser, 'bob')).newPage()
  await openProject(a, pid)
  await openProject(b, pid)
})
test.afterAll(async () => {
  await a?.context().close()
  await b?.context().close()
  if (pid) await removeProject(pid)
})

/** Insert a line before \section{Method} through the page's doc session (acquired and released). */
async function edit(page: Page, line: string): Promise<void> {
  await folio(page, async (f, text: string) => {
    const st = f.useProject.getState()
    const s = f.docSessions.acquire(st.projectId, st.fileByPath('main.tex'))
    await s.synced
    s.ytext.insert(s.ytext.toString().indexOf('\\section{Method}'), `${text}\n`)
    await f.docSessions.barrierAll()
    f.docSessions.release(s)
  }, line)
}
async function openHistory(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await expect(page.locator('.hist-root')).toBeVisible()
  await expect(page.locator('.hist-card').first()).toBeVisible({ timeout: 30_000 })
}
async function closeHistory(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Back to editor' }).click()
  await expect(page.locator('.hist-root')).toHaveCount(0)
}
const card = (page: Page, versionId: string) => page.locator(`.hist-card[data-version="${versionId}"]`)
const diffText = (page: Page) => page.locator('.hist-diff__cm .cm-content').innerText()

test('opening History records the edit as a version and shows its diff; a collaborator’s version appears live', async () => {
  await edit(a, MARK_A)
  await openHistory(a)
  const first = a.locator('.hist-card').first()
  await expect(first).toHaveClass(/is-selected/)
  await expect(first.locator('.hist-card__names')).toHaveText('You')
  await expect(first).toContainText('main.tex')
  await expect(a.locator('.hist-head__what')).toHaveText(/^Viewing/)
  await expect.poll(() => diffText(a)).toContain(MARK_A)
  await expect(a.locator('.hist-diff__cm .cm-changedLine').first()).toBeVisible()
  await expect(a.locator('.hist-diffbar__stats')).toContainText('+1')
  const newest = (await versions())[0]
  expect(newest.authors.map(x => x.name)).toEqual(['Alice Admin'])
  expect(newest.changes.map(c => c.path)).toEqual(['main.tex'])
  await shot(a, 'history-diff')

  // bob edits and opens History: his version shows up in alice's open list; her selection stays
  const count = await a.locator('.hist-card').count()
  await edit(b, MARK_B)
  await openHistory(b)
  await expect(a.locator('.hist-card')).toHaveCount(count + 1)
  await expect(a.locator('.hist-card').first().locator('.hist-card__names')).toContainText('Bob Editor')
  await expect(a.locator('.hist-card').nth(1)).toHaveClass(/is-selected/)
  await closeHistory(b)
})

test('comparing a range shows both edits', async () => {
  await a.locator('.hist-card').first().locator('.hist-card__select').click()
  await card(a, baseVersion).locator('.hist-card__select').click({ modifiers: ['Shift'] })
  await expect(a.locator('.hist-head__what')).toHaveText(/^Comparing/)
  await expect(a.locator('.hist-card.is-in-range')).toHaveCount(3)
  await a.locator('.hist-file', { hasText: 'main.tex' }).click()
  await expect.poll(() => diffText(a)).toContain(MARK_A)
  expect(await diffText(a)).toContain(MARK_B)
  await shot(a, 'history-compare')
  await a.getByRole('button', { name: 'Stop comparing' }).click()
  await expect(a.locator('.hist-head__what')).toHaveText(/^Viewing/)
})

test('labels: add, filter, seen live, delete; download a version as .zip', async () => {
  const name = `Submitted ${stamp}`
  await openHistory(b)
  await a.locator('.hist-card').nth(1).locator('.hist-card__select').click()
  await a.locator('.hist-head__actions').getByRole('button', { name: 'Add label' }).click()
  const dialog = a.getByRole('dialog', { name: 'Add label' })
  await dialog.locator('input').fill(name)
  await dialog.locator('input').press('Enter')
  await expect(a.locator('.hist-label', { hasText: name })).toBeVisible()
  await expect(b.locator('.hist-label', { hasText: name })).toBeVisible() // live for bob
  await a.locator('.hist-list__head').getByRole('tab', { name: 'Labels' }).click()
  await expect(a.locator('.hist-card')).toHaveCount(1)
  await a.locator('.hist-list__head').getByRole('tab', { name: 'All history' }).click()
  await a.locator('.hist-label', { hasText: name }).locator('.hist-label__delete').click()
  await a.getByRole('dialog', { name: 'Delete label?' }).getByRole('button', { name: 'Delete label' }).click()
  await expect(a.locator('.hist-label', { hasText: name })).toHaveCount(0)
  await expect(b.locator('.hist-label', { hasText: name })).toHaveCount(0)
  await closeHistory(b)

  const [zip] = await Promise.all([a.waitForEvent('download'), a.locator('.hist-head__actions').getByRole('button', { name: 'Download .zip' }).click()])
  expect(zip.suggestedFilename()).toMatch(/\.zip$/)
  const bytes = fs.readFileSync(await zip.path())
  expect(bytes.subarray(0, 2).toString()).toBe('PK')
})

test('restoring a file: the collaborator’s editor follows, the restore is a version of its own', async () => {
  await openFile(b, 'main.tex')
  await expect.poll(() => folio(b, f => f.useEditor.getState().view.state.doc.toString())).toContain(MARK_B)

  await card(a, baseVersion).locator('.hist-card__select').click()
  await a.locator('.hist-files__head').getByRole('tab', { name: 'All files' }).click()
  await a.locator('.hist-file', { hasText: 'main.tex' }).first().click()
  await expect.poll(() => diffText(a)).toContain('Original introduction.')
  expect(await diffText(a)).not.toContain(MARK_A)
  await a.getByRole('button', { name: 'Restore this file' }).click()
  const confirm = a.getByRole('dialog', { name: 'Restore this file?' })
  await expect(confirm).toContainText('main.tex')
  await confirm.getByRole('button', { name: 'Restore this file' }).click()
  await expect(a.locator('.hist-root')).toHaveCount(0)
  await expect(a.locator('.ui-toast--success').first()).toContainText('Restored')

  // bob's open editor shows the restored text; the server has it
  await b.waitForFunction(([m1, m2]) => {
    const t = (window as any).__folio.useEditor.getState().view?.state.doc.toString() ?? ''
    return t.includes('Original introduction.') && !t.includes(m1) && !t.includes(m2)
  }, [MARK_A, MARK_B], { timeout: 20_000 })
  expect(await rawText(pid, await fileIdByPath(a, 'main.tex'))).toBe(MAIN)

  const restore = (await versions())[0]
  expect(restore.reason).toBe('restore')
  expect(restore.summary).toMatch(/^Restored main\.tex/)
  expect(restore.restoredFrom).toMatchObject({ versionId: baseVersion, path: 'main.tex' })
  await openHistory(a)
  await expect(a.locator('.hist-card').first().locator('.hist-card__summary')).toContainText('Restored')
})

test('restoring the project removes files created since that version', async () => {
  const api = await apiAs('alice')
  await json(await api.post(`/api/projects/${pid}/files`, { data: { path: 'probe.tex', kind: 'text', content: 'probe\n' } }))
  await api.dispose()
  await a.waitForFunction(() => !!(window as any).__folio.useProject.getState().fileByPath('probe.tex'))
  await closeHistory(a)
  await openHistory(a)
  await card(a, baseVersion).locator('.hist-card__select').click()
  await a.locator('.hist-head__actions').getByRole('button', { name: 'Restore project' }).click()
  const confirm = a.getByRole('dialog', { name: 'Restore the whole project?' })
  await confirm.getByRole('button', { name: 'Restore project' }).click()
  await a.waitForFunction(() => !(window as any).__folio.useProject.getState().fileByPath('probe.tex'), undefined, { timeout: 20_000 })
  await b.waitForFunction(() => !(window as any).__folio.useProject.getState().fileByPath('probe.tex'), undefined, { timeout: 20_000 })
  await expect(a.locator('.hist-root')).toHaveCount(0)
  await expect(a.locator('.ui-toast--success', { hasText: 'Project restored' })).toBeVisible()
  const restore = (await versions())[0]
  expect(restore.reason).toBe('restore')
  expect(restore.summary).toMatch(/^Restored to /)
  expect(restore.restoredFrom?.versionId).toBe(baseVersion)
})

test('a viewer browses the history without restore or label actions', async ({ browser }) => {
  const c = await (await userContext(browser, 'carol')).newPage()
  await openProject(c, pid)
  await openHistory(c)
  const actions = c.locator('.hist-head__actions')
  await expect(actions.getByRole('button', { name: 'Download .zip' })).toBeVisible()
  await expect(actions.getByRole('button', { name: 'Restore project' })).toHaveCount(0)
  await expect(actions.getByRole('button', { name: 'Add label' })).toHaveCount(0)
  await card(c, baseVersion).locator('.hist-card__select').click()
  await expect(c.locator('.hist-diff__cm .cm-content, .hist-diff__state').first()).toBeVisible()
  await expect(c.getByRole('button', { name: /Restore this file|Restore deleted file/ })).toHaveCount(0)
  await c.context().close()
})
