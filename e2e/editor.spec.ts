/**
 * The source editor on a throw-away project (chapter file with labels, a .bib, a figure):
 * typing reaches the server, completions for \ref / \cite / \includegraphics / \begin,
 * environment auto-close, Mod-b / Mod-i, Mod-/ comments, folding, find & replace, go to line,
 * outline click-to-jump — and, with real TeX, compile diagnostics in the editor after a failing
 * compile (gutter marker, underline, hover message, logs "go to location").
 */
import { expect, type Page } from '@playwright/test'
import {
  apiAs, barrier, completionLabels, cursorLine, docker, editorIndex, editorText, fileIdByPath, folio, json, lastBuildId, newProject,
  openFile, openProject, png, rawText, removeProject, setCursor, shot, test, userContext, waitForBuild,
} from './helpers'

const MAIN = [
  '\\documentclass{article}',
  '\\usepackage{graphicx}',
  '\\begin{document}',
  '\\section{Introduction}\\label{sec:intro}',
  'Some words here to format.',
  'Math: $a^2 + b^2 = c^2$ and more.',
  '',
  '\\begin{quote}',
  'quoted',
  '\\end{quote}',
  '',
  '\\section{Results}\\label{sec:results}',
  'Results text.',
  '\\input{chapter}',
  '',
  '\\bibliographystyle{plain}',
  '\\bibliography{refs}',
  '\\end{document}',
  '',
].join('\n')
const CHAPTER = '\\subsection{Details}\\label{sec:details}\nDetails of the method.\n'
const BIB = `@article{knuth1984literate,
  author = {Donald E. Knuth},
  title = {Literate Programming},
  journal = {The Computer Journal},
  year = {1984}
}
@book{lamport1994latex,
  author = {Leslie Lamport},
  title = {LaTeX: A Document Preparation System},
  publisher = {Addison-Wesley},
  year = {1994}
}
`

let pid: string
let page: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  pid = await newProject('E2E Editor', {
    files: [
      { path: 'main.tex', content: MAIN },
      { path: 'chapter.tex', content: CHAPTER },
      { path: 'refs.bib', content: BIB },
      { path: 'figures/plot.png', content: png(120, 80) },
    ],
    members: false,
  })
  const ctx = await userContext(browser, 'alice')
  page = await ctx.newPage()
  await openProject(page, pid)
  await openFile(page, 'main.tex')
  // the project index (labels, citation keys, files) feeds the completions
  await page.waitForFunction(() => {
    const s = (window as any).__folio.projectIndex.snapshot()
    return s.labels.length >= 3 && s.cites.length >= 2
  }, undefined, { timeout: 20_000 })
})

test.afterAll(async () => {
  await page?.context().close()
  if (pid) await removeProject(pid)
})

/** The list ignores Enter for its first moments (interactionDelay): wait until `label` leads, then accept. */
async function accept(label: string): Promise<void> {
  await expect.poll(async () => (await completionLabels(page))[0]).toBe(label)
  await page.waitForTimeout(100)
  await page.keyboard.press('Enter')
}

test('typing reaches the server; \\ref, \\cite and \\includegraphics complete from the project', async () => {
  await setCursor(page, (await editorIndex(page, 'Results text.')) + 'Results text.'.length)
  await page.keyboard.type(' See \\ref{')
  const labels = await completionLabels(page)
  expect(labels).toEqual(expect.arrayContaining(['sec:intro', 'sec:results', 'sec:details'])) // labels of every project file
  await page.keyboard.type('sec:det')
  await accept('sec:details')
  await expect.poll(() => editorText(page)).toContain('See \\ref{sec:details}')
  await shot(page, 'editor-complete-ref')

  await page.keyboard.press('End')
  await page.keyboard.type(' and \\cite{')
  expect(await completionLabels(page)).toEqual(expect.arrayContaining(['knuth1984literate', 'lamport1994latex']))
  await page.keyboard.type('lamp')
  await accept('lamport1994latex')
  await expect.poll(() => editorText(page)).toContain('and \\cite{lamport1994latex}')

  await page.keyboard.press('End')
  await page.keyboard.press('Enter')
  await page.keyboard.type('\\includegraphics[width=\\linewidth]{')
  const files = await completionLabels(page)
  expect(files).toContain('figures/plot.png')
  expect(files.filter(f => f.endsWith('.tex') || f.endsWith('.bib'))).toEqual([]) // only images are offered
  await accept('figures/plot.png')
  await expect.poll(() => editorText(page)).toContain('\\includegraphics[width=\\linewidth]{figures/plot.png}')

  // everything typed is on the server once the barrier returns
  await barrier(page)
  const server = await rawText(pid, await fileIdByPath(page, 'main.tex'))
  expect(server).toBe(await editorText(page))
  expect(server).toContain('See \\ref{sec:details} and \\cite{lamport1994latex}')
})

test('\\begin completes environments and auto-closes them', async () => {
  await setCursor(page, (await editorIndex(page, '\\bibliographystyle')) - 1)
  await page.keyboard.press('Enter')
  await page.keyboard.type('\\begin{')
  expect(await completionLabels(page)).toEqual(expect.arrayContaining(['itemize', 'equation']))
  await page.keyboard.type('itemi')
  await accept('itemize')
  await page.keyboard.type('first point')
  expect(await editorText(page)).toMatch(/\\begin\{itemize\}\n\s+\\item first point\n\\end\{itemize\}/)

  // a typed \begin{center} + Enter inserts the matching \end
  await setCursor(page, (await editorIndex(page, '\\bibliographystyle')) - 1)
  await page.keyboard.press('Enter')
  await page.keyboard.type('\\begin{center')
  await page.keyboard.press('Escape') // close the completion list
  await page.keyboard.type('}') // steps over the auto-inserted brace
  await page.keyboard.press('Enter')
  await page.keyboard.type('centred')
  const text = await editorText(page)
  expect(text).toMatch(/\\begin\{center\}\n\s+centred\n\\end\{center\}/)
  expect(text).not.toContain('\\begin{center}}')

  // Enter after a \begin that already has its \end adds nothing
  await setCursor(page, (await editorIndex(page, '\\begin{quote}')) + '\\begin{quote}'.length)
  await page.keyboard.press('Enter')
  expect((await editorText(page)).match(/\\end\{quote\}/g)).toHaveLength(1)
})

test('Mod-b / Mod-i wrap and unwrap, Mod-/ toggles comments', async () => {
  const w = await editorIndex(page, 'words')
  await folio(page, (f, [a, b]: number[]) => {
    const v = f.useEditor.getState().view
    v.focus()
    v.dispatch({ selection: { anchor: a, head: b } })
  }, [w, w + 5])
  await page.keyboard.press('ControlOrMeta+b')
  expect(await editorText(page)).toContain('Some \\textbf{words} here')
  await page.keyboard.press('ControlOrMeta+b')
  expect(await editorText(page)).toContain('Some words here')
  await page.keyboard.press('ControlOrMeta+i')
  expect(await editorText(page)).toContain('Some \\textit{words} here')
  await page.keyboard.press('ControlOrMeta+i')
  expect(await editorText(page)).toContain('Some words here')

  // Overleaf's keys: Mod-u / Mod-Shift-u change the case, Mod-d deletes the line
  await folio(page, (f, [a, b]: number[]) => f.useEditor.getState().view.dispatch({ selection: { anchor: a, head: b } }), [w, w + 5])
  await page.keyboard.press('ControlOrMeta+u')
  expect(await editorText(page)).toContain('Some WORDS here')
  await page.keyboard.press('ControlOrMeta+Shift+KeyU')
  expect(await editorText(page)).toContain('Some words here')
  const beforeLine = await editorText(page)
  await setCursor(page, (await editorIndex(page, 'and more.')) + 'and more.'.length)
  await page.keyboard.press('Enter')
  await page.keyboard.type('a line to delete')
  expect(await editorText(page)).toContain('and more.\na line to delete\n')
  await page.keyboard.press('ControlOrMeta+d')
  expect(await editorText(page)).toBe(beforeLine)

  await setCursor(page, (await editorIndex(page, 'Some words')) + 2)
  await page.keyboard.press('ControlOrMeta+/')
  expect(await editorText(page)).toContain('\n% Some words here')
  await page.keyboard.press('ControlOrMeta+/')
  expect(await editorText(page)).toContain('\nSome words here')
  expect(await editorText(page)).not.toContain('% Some words')
})

test('folding a section from the gutter and unfolding it', async () => {
  await setCursor(page, 0)
  const marker = page.locator('.cm-foldGutter .ed-fold-marker.is-open').first()
  await page.locator('.cm-gutters').hover()
  await marker.click()
  await expect(page.locator('.cm-foldPlaceholder')).toHaveCount(1)
  await shot(page, 'editor-folded')
  await page.locator('.cm-foldPlaceholder').click()
  await expect(page.locator('.cm-foldPlaceholder')).toHaveCount(0)
  // F2 folds and unfolds at the cursor
  await setCursor(page, await editorIndex(page, '\\begin{quote}'))
  await page.keyboard.press('F2')
  await expect(page.locator('.cm-foldPlaceholder')).toHaveCount(1)
  await page.keyboard.press('F2')
  await expect(page.locator('.cm-foldPlaceholder')).toHaveCount(0)
})

test('find, replace all, go to line', async () => {
  await setCursor(page, 0)
  await page.keyboard.press('ControlOrMeta+f')
  const panel = page.locator('.ed-search')
  await expect(panel).toBeVisible()
  await panel.locator('input[main-field]').fill('point')
  await expect(panel.locator('.ed-search__count')).toContainText('1')
  await page.keyboard.press('Enter')
  expect(await folio(page, f => {
    const v = f.useEditor.getState().view
    const r = v.state.selection.main
    return v.state.sliceDoc(r.from, r.to)
  })).toBe('point')
  await panel.locator('.ed-search__toggle').click()
  await panel.locator('.ed-search__row--replace input').fill('POINT')
  await panel.locator('.ed-search__action', { hasText: 'Replace all' }).click()
  await expect.poll(() => editorText(page)).toContain('first POINT')
  expect(await editorText(page)).not.toContain('first point')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)

  await folio(page, f => f.useEditor.getState().view.focus())
  await page.keyboard.press('ControlOrMeta+Shift+l')
  await page.locator('.cm-goto-line input').fill('5')
  await page.keyboard.press('Enter')
  await expect.poll(() => cursorLine(page)).toBe(5)
})

test('outline lists the sections and jumps to one', async () => {
  const rows = page.locator('.ed-outline__row')
  await expect(rows.filter({ hasText: 'Introduction' })).toHaveCount(1)
  await setCursor(page, 0)
  await rows.filter({ hasText: 'Results' }).first().click()
  const resultsLine = (await editorText(page)).split('\n').findIndex(l => l.startsWith('\\section{Results}')) + 1
  await expect.poll(() => cursorLine(page)).toBe(resultsLine)
  await expect(page.locator('.ed-outline__row.is-active')).toHaveText('Results')
  await expect(page.locator('.ed-crumbs')).toContainText('Results')
})

test('a failing compile shows its error in the editor; fixing it clears the diagnostic', async () => {
  test.skip(!docker(), 'needs real TeX (COMPILE_RUNNER=docker)')
  const MARK = '\\undefinedmacro '
  const at = await editorIndex(page, 'Some words')
  const errLine = (await editorText(page)).slice(0, at).split('\n').length
  await setCursor(page, at)
  await page.keyboard.type(MARK)

  // Mod-Enter in the editor compiles (barrier first: the compile sees the macro)
  let prev = await lastBuildId(page)
  await page.keyboard.press('ControlOrMeta+Enter')
  await waitForBuild(page, prev)
  expect(await folio(page, f => f.useCompile.getState().last.log.errors.length)).toBeGreaterThan(0)
  await expect.poll(() => folio(page, f => f.editorDiagnostics().filter((d: any) => d.severity === 'error'))).toEqual(
    expect.arrayContaining([expect.objectContaining({ line: errLine, text: '\\undefinedmacro' })]),
  )
  await expect(page.locator('.cm-gutter-lint .cm-lint-marker-error').first()).toBeVisible()
  await page.locator('.cm-lintRange-error').first().hover()
  await expect(page.locator('.cm-tooltip-lint')).toContainText(/Undefined control sequence/i)
  await shot(page, 'editor-diagnostic')

  // the logs' "go to code location" puts the caret on that line
  await setCursor(page, 0)
  await page.locator('.pdf-logsbtn').click()
  const card = page.locator('.logs-entry--error').first()
  await expect(card).toContainText('Undefined control sequence')
  await card.locator('button.logs-entry__loc').click()
  await expect.poll(() => cursorLine(page)).toBe(errLine)
  await expect(page.locator('.logs-pane')).toBeVisible()
  await page.locator('.logs-head__back').click()

  // remove the macro and recompile: no error diagnostics remain
  const pos = await editorIndex(page, MARK)
  await folio(page, (f, [p, n]: number[]) => f.useEditor.getState().view.dispatch({ changes: { from: p, to: p + n } }), [pos, MARK.length])
  prev = await lastBuildId(page)
  await folio(page, f => f.useEditor.getState().view.focus())
  await page.keyboard.press('ControlOrMeta+s')
  await waitForBuild(page, prev)
  expect(await folio(page, f => f.useCompile.getState().last.log.errors.length)).toBe(0)
  await expect.poll(() => folio(page, f => f.editorDiagnostics().filter((d: any) => d.severity === 'error').length)).toBe(0)
})

test('a change that would make a document too large is refused; the file stays editable', async () => {
  const api = await apiAs('alice')
  await json(await api.post(`/api/projects/${pid}/files`, { data: { path: 'big.txt', kind: 'text', content: `${'x'.repeat(99)}\n`.repeat(20_900) } }))
  await api.dispose()
  await page.waitForFunction(() => !!(window as any).__folio.useProject.getState().fileByPath('big.txt'))
  await openFile(page, 'big.txt')
  const length = () => folio(page, f => f.useEditor.getState().view.state.doc.length as number)
  expect(await length()).toBe(2_090_000)
  // a 120 000-character paste would pass the 2 MiB limit: refused, with a message
  await folio(page, f => f.useEditor.getState().view.dispatch({ changes: { from: 0, insert: 'y'.repeat(120_000) }, userEvent: 'input.paste' }))
  await expect(page.locator('.ui-toast', { hasText: 'That change was not applied' })).toBeVisible()
  expect(await length()).toBe(2_090_000)
  // typing still works and reaches the server
  await setCursor(page, 0)
  await page.keyboard.type('ok ')
  expect(await length()).toBe(2_090_003)
  await barrier(page)
  const server = await rawText(pid, await fileIdByPath(page, 'big.txt'))
  expect(server.length).toBe(2_090_003)
  expect(server.startsWith('ok x')).toBe(true)
  await openFile(page, 'main.tex')
})
