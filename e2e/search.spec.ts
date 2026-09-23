/**
 * Project-wide search on a throw-away project with several files: Mod-Shift-F opens the panel
 * with the query focused; results grouped per file match the server's answer; Match case and
 * Regular expression change the results; an invalid expression is reported; clicking a match
 * (or Enter on it) opens the file with the caret on the match; an empty result says so.
 */
import { expect } from '@playwright/test'
import { apiAs, cursorLine, folio, json, newProject, openProject, removeProject, shot, test, userContext } from './helpers'

const FILES = [
  { path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\n\\section{Detection}\nWe smooth the score with an EWMA filter.\n\\input{chapters/method}\n\\input{chapters/results}\n\\end{document}\n' },
  { path: 'chapters/method.tex', content: '\\section{Method}\nThe EWMA smoothing stage runs first.\nA second ewma (lower case) is not the same word.\nEWMA stage two.\n' },
  { path: 'chapters/results.tex', content: '\\section{Results}\nNothing smoothed here.\nThe EWMA baseline wins.\n' },
]

let pid: string
test.beforeAll(async () => {
  pid = await newProject('E2E Search', { files: FILES, members: false })
})
test.afterAll(async () => {
  if (pid) await removeProject(pid)
})

test('search the project, refine with case and regex, jump to a match', async ({ browser }) => {
  const page = await (await userContext(browser, 'alice')).newPage()
  await page.addInitScript(() => {
    try { localStorage.removeItem('folio:search:flags') } catch { /* no storage */ }
  })
  await openProject(page, pid)
  await page.locator('body').click({ position: { x: 700, y: 400 } })
  await page.keyboard.press('ControlOrMeta+Shift+KeyF')
  const panel = page.locator('section.srch')
  const input = panel.getByRole('textbox', { name: 'Search in all project files' })
  await expect(input).toBeFocused()
  expect(await folio(page, f => f.useLayout.getState().railPanel)).toBe('search')

  await panel.getByRole('button', { name: 'Match case' }).click()
  await expect(panel.getByRole('button', { name: 'Match case' })).toHaveAttribute('aria-pressed', 'true')
  await input.fill('EWMA')
  const api = await apiAs('alice')
  const res = await json<{ results: { fileId: string; path: string; matches: { line: number; column: number }[] }[] }>(
    await api.get(`/api/projects/${pid}/search?q=EWMA&regex=0&caseSensitive=1&wholeWord=0`),
  )
  await api.dispose()
  const total = res.results.reduce((n, r) => n + r.matches.length, 0)
  expect(total).toBe(4)
  await expect(panel.locator('.srch-summary')).toHaveText(`${total} results in ${res.results.length} files`)
  await expect(panel.locator('.srch-group')).toHaveCount(res.results.length)
  expect(await panel.locator('mark.srch-match__hit').allTextContents()).toEqual(Array(total).fill('EWMA'))
  await shot(page, 'search-results')

  // case-insensitive finds the lower-case one too; a regular expression narrows it down
  await panel.getByRole('button', { name: 'Match case' }).click()
  await expect(panel.locator('.srch-summary')).toHaveText('5 results in 3 files')
  await panel.getByRole('button', { name: 'Match case' }).click()
  await panel.getByRole('button', { name: 'Regular expression' }).click()
  await input.fill('EWMA\\s+(smoothing|stage)')
  await expect(panel.locator('.srch-summary')).toHaveText('2 results in 1 file')
  expect(await panel.locator('mark.srch-match__hit').allTextContents()).toEqual(['EWMA smoothing', 'EWMA stage'])
  await input.fill('EWMA(')
  await expect(panel.locator('#srch-problem')).toContainText('Invalid regular expression')

  // clicking a match opens its file with the caret on it
  await input.fill('EWMA')
  await expect(panel.locator('.srch-summary')).toHaveText(`${total} results in ${res.results.length} files`)
  const target = res.results.find(r => r.path === 'chapters/results.tex')!
  const group = panel.locator('.srch-group', { hasText: 'results.tex' })
  await folio(page, f => f.useLayout.getState().setView('pdf')) // "PDF only": a jump shows the editor again
  await group.locator('.srch-match').first().click()
  await expect.poll(() => folio(page, f => f.useLayout.getState().view)).toBe('split')
  await expect.poll(() => folio(page, f => f.useEditor.getState().openFileId)).toBe(target.fileId)
  const jr = await folio(page, f => f.useEditor.getState().jumpRequest)
  expect(jr).toMatchObject({ fileId: target.fileId, line: target.matches[0].line, column: target.matches[0].column })
  await expect.poll(() => cursorLine(page)).toBe(target.matches[0].line)

  // keyboard: ↓ from the field goes to the first file, ↓ again to its first match, Enter opens it
  await input.focus()
  await page.keyboard.press('ArrowDown')
  expect(await page.evaluate(() => document.activeElement?.classList.contains('srch-file'))).toBe(true)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  const first = res.results[0]
  await expect.poll(() => folio(page, f => f.useEditor.getState().jumpRequest)).toMatchObject({ fileId: first.fileId, line: first.matches[0].line })

  await input.fill('zzqqxxnothing')
  await expect(panel.getByText('No results', { exact: true }).first()).toBeVisible()
  await page.context().close()
})
