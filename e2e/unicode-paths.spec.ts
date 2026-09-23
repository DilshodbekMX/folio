/**
 * Unicode file and folder names through the UI (ACC-14): "Résumé ü/チャプター.tex" created with
 * the New file dialog lands in the tree under its folder (folders first, natural order with
 * "Über.tex" among the ASCII names), opens from the tree with its breadcrumb, and what is typed
 * into it is found by the project search (case-insensitively also in Über.tex), grouped under
 * that folder; the History lists the path and shows the file. With Docker the file compiles as
 * an \input of main.tex and the error it holds jumps from the Logs to its line.
 */
import { expect } from '@playwright/test'
import {
  compile, cursorLine, docker, folio, lastBuildId, newProject, openFile, openProject, removeProject, shot, test, typeInEditor, userContext,
  waitForBuild,
} from './helpers'

const FOLDER = 'Résumé ü'
const NAME = 'チャプター.tex'
const PATH = `${FOLDER}/${NAME}`

let pid: string

test.beforeAll(async () => {
  pid = await newProject('E2E Unicode — Résumé', {
    files: [
      { path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nIntro.\n\n\\input{Résumé ü/チャプター}\n\\end{document}\n' },
      { path: 'appendix.tex', content: 'Appendix.\n' },
      { path: 'Über.tex', content: 'Über den Anhang.\n' },
      { path: 'zeta.tex', content: 'Zeta.\n' },
    ],
    members: false,
  })
})
test.afterAll(async () => {
  if (pid) await removeProject(pid)
})

const openPath = (page: import('@playwright/test').Page) => folio(page, f => f.useProject.getState().files[f.useEditor.getState().openFileId]?.path ?? null)

test('a Unicode path through the tree, the breadcrumb, the search and the history', async ({ browser }) => {
  const page = await (await userContext(browser, 'alice')).newPage()
  await page.addInitScript(() => {
    try { localStorage.removeItem('folio:search:flags') } catch { /* no storage */ }
  })
  await openProject(page, pid)

  // New file with a folder part: the folder is created, the file opens and is revealed
  await page.getByRole('button', { name: 'New file', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New file' })
  await dialog.locator('input').fill(PATH)
  await dialog.locator('input').press('Enter')
  await expect.poll(() => openPath(page)).toBe(PATH)
  const folderRow = page.locator(`.ft-row[data-path="${FOLDER}"]`)
  await expect(folderRow).toHaveAttribute('data-kind', 'folder')
  await expect(page.locator(`.ft-row[data-path="${PATH}"]`)).toHaveAttribute('aria-selected', 'true')
  // folders first, then a natural order that puts Über.tex with the U names
  const rows = await page.locator('.ft-row').evaluateAll(els => els.map(e => e.getAttribute('data-path')).filter(p => p && !p.includes('/')))
  expect(rows).toEqual([FOLDER, 'appendix.tex', 'main.tex', 'Über.tex', 'zeta.tex'])

  // open another file, then the Unicode one from the tree: the breadcrumb shows folder › file
  await page.locator('.ft-row[data-path="main.tex"]').click()
  await expect.poll(() => openPath(page)).toBe('main.tex')
  await page.locator(`.ft-row[data-path="${PATH}"]`).click()
  await expect.poll(() => openPath(page)).toBe(PATH)
  await expect(page.locator('.ed-crumbs__folder')).toHaveText(FOLDER)
  await expect(page.locator('.ed-crumbs__file')).toHaveText(NAME)

  // type into it (the line with \undefinedmacro is line 3, for the Logs check below)
  await page.waitForFunction(() => !!(window as any).__folio.useEditor.getState().view)
  await typeInEditor(page, 'Kapitel über Résumé, Grüße.')
  await folio(page, f => {
    const v = f.useEditor.getState().view
    v.dispatch({ changes: { from: v.state.doc.length, insert: '\nZweite Zeile.\n\\undefinedmacro Ende ßü.\n' } })
  })
  await folio(page, f => f.docSessions.barrierAll())

  // project search: one result, grouped under the Unicode folder; clicking it opens the file there
  await page.locator('.ft-row[data-path="main.tex"]').click()
  await expect.poll(() => openPath(page)).toBe('main.tex')
  await page.locator('body').click({ position: { x: 700, y: 400 } })
  await page.keyboard.press('ControlOrMeta+Shift+KeyF')
  const panel = page.locator('section.srch')
  const input = panel.getByRole('textbox', { name: 'Search in all project files' })
  await input.fill('über')
  // case-insensitive: "Über den Anhang" in Über.tex matches too; Match case leaves the new file
  await expect(panel.locator('.srch-summary')).toHaveText('2 results in 2 files')
  await panel.getByRole('button', { name: 'Match case' }).click()
  await expect(panel.locator('.srch-summary')).toHaveText('1 result in 1 file')
  const group = panel.locator('.srch-group')
  await expect(group.locator('.srch-file__name')).toHaveText(NAME)
  await expect(group.locator('.srch-file__dir')).toContainText(FOLDER)
  await expect(group.locator('mark.srch-match__hit')).toHaveText('über')
  await shot(page, 'unicode-search')
  await group.locator('.srch-match').first().click()
  await expect.poll(() => openPath(page)).toBe(PATH)
  await expect.poll(() => cursorLine(page)).toBe(1)

  // History: the new version lists the path; the file list and the diff show it
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const hist = page.locator('.hist-root')
  await expect(hist).toBeVisible()
  await expect(hist.locator('.hist-card').first()).toContainText(NAME)
  const histFile = hist.locator(`.hist-file[data-path="${PATH}"]`)
  await expect(histFile).toBeVisible()
  await expect(histFile.locator('.hist-file__dir')).toHaveText(`${FOLDER}/`)
  await histFile.click()
  await expect(hist.locator('.hist-diffbar__path')).toHaveText(PATH)
  await expect(hist.locator('.hist-diff .cm-content')).toContainText('Kapitel über Résumé, Grüße.')
  await expect(hist.locator('.hist-diff .cm-content')).toContainText('Ende ßü.')
  await shot(page, 'unicode-history')
  await page.keyboard.press('Escape')
  await expect(hist).toHaveCount(0)

  // Docker: the error inside the Unicode file is reported at its line and the Logs jump there
  if (docker()) {
    await openFile(page, 'main.tex')
    const prev = await lastBuildId(page)
    await compile(page)
    await waitForBuild(page, prev)
    await page.locator('.pdf-logsbtn').click()
    await page.locator('#logs-tab-errors').click()
    const card = page.locator('.logs-entry--error', { hasText: 'Undefined control sequence' }).first()
    await expect(card.locator('button.logs-entry__loc')).toHaveText(/チャプター\.tex, line 3$/)
    await card.locator('button.logs-entry__loc').click()
    await expect.poll(() => openPath(page)).toBe(PATH)
    await expect.poll(() => cursorLine(page)).toBe(3)
    await shot(page, 'unicode-logs-jump')
  }
  await page.context().close()
})
