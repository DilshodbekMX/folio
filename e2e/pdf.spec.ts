/**
 * Compiling and the PDF pane on a throw-away project (a dozen pages of lipsum): first compile
 * from the empty state, pages rendered, a collaborator's viewer follows; zoom and scroll position
 * survive a recompile; the logs pane's counts match the build and "go to location" jumps; stop on
 * first error / try despite errors; draft mode; stopping a running compile; recompile from
 * scratch; clear cached files; auto compile after typing; word count; download name; a viewer
 * compiling by hand. Needs real TeX for most checks (COMPILE_RUNNER=fake runs the rest).
 */
import { execFileSync } from 'node:child_process'
import { expect, type Page, type Request } from '@playwright/test'
import {
  acquireDoc, apiAs, docInsert, docker, docText, folio, lastBuildId, newProject, openFile, openProject, pdfView, removeProject,
  setCursor, shot, test, userContext, waitForBuild,
} from './helpers'

const NAME = 'E2E PDF Pane'
const MAIN = [
  '\\documentclass{article}',
  '\\usepackage{lipsum}',
  '\\begin{document}',
  '\\section{Start}\\label{sec:start}',
  'See Section~\\ref{sec:missing} for nothing.',
  '\\lipsum[1-70]',
  '\\section{End}',
  'Text at the end.',
  '\\end{document}',
  '',
].join('\n')
// a standalone document that keeps TeX busy for a long time (for "Stop compilation")
const SLOW = '\\documentclass{article}\n\\newcount\\n\n\\begin{document}\nSlow.\n\\loop\\advance\\n by 1 \\ifnum\\n<400000000 \\repeat\n\\end{document}\n'

let pid: string
let page: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  pid = await newProject(NAME, { files: [{ path: 'main.tex', content: MAIN }, { path: 'slow.tex', content: SLOW }] })
  const ctx = await userContext(browser, 'alice', { acceptDownloads: true })
  page = await ctx.newPage()
  await openProject(page, pid)
  await openFile(page, 'main.tex')
})
test.afterAll(async () => {
  await page?.context().close()
  if (pid) await removeProject(pid)
})

const compileMenu = () => page.locator('.pdf-compile__caret')
async function menuItem(text: string): Promise<void> {
  await compileMenu().click()
  await page.locator('[role="menu"] [role^="menuitem"]', { hasText: text }).first().click()
  await page.keyboard.press('Escape')
  await expect(page.locator('[role="menu"]')).toHaveCount(0)
}
async function recompile(): Promise<string> {
  const prev = await lastBuildId(page)
  await page.locator('.pdf-compile__main').click()
  return waitForBuild(page, prev)
}
async function lastLog(): Promise<{ errors: number; warnings: number; typesetting: number }> {
  return folio(page, f => {
    const l = f.useCompile.getState().last.log
    return { errors: l.errors.length, warnings: l.warnings.length, typesetting: l.typesetting.length }
  })
}
const tabCount = async (id: string) => Number((await page.locator(`#logs-tab-${id} .ui-badge`).textContent().catch(() => '0')) || 0)

test('first compile from the empty state renders the pages; a collaborator sees the new PDF', async ({ browser }) => {
  await expect(page.locator('.pdf-state__title', { hasText: 'No PDF yet' })).toBeVisible()
  const pb = await (await userContext(browser, 'bob')).newPage()
  await openProject(pb, pid)

  await page.locator('.pdf-state__actions button', { hasText: 'Recompile' }).click()
  expect(await waitForBuild(page, null)).toBe('success')
  const view = await pdfView(page)
  expect(view.pages).toBeGreaterThan(docker() ? 8 : 0)
  await expect(page.locator('.pdfViewer .page[data-page-number="1"] canvas')).toBeVisible()
  await expect(page.locator('.pdf-compile__label')).toHaveText('Recompile')
  await shot(page, 'pdf-first-compile')

  // bob's PDF pane shows the same build without compiling himself
  const buildId = await lastBuildId(page)
  await pb.waitForFunction(id => {
    const v = (window as any).__folio.usePdfView.getState()
    return v.buildId === id && v.status === 'ready'
  }, buildId, { timeout: 30_000 })
  await pb.context().close()
})

test('zoom and scroll position survive a recompile', async () => {
  test.skip(!docker(), 'the fake runner’s PDF has one page')
  await folio(page, f => f.pdfController().setScaleValue('1.5'))
  await folio(page, f => f.pdfController().goToPage(4))
  await page.waitForFunction(() => (window as any).__folio.usePdfView.getState().page === 4)
  await page.locator('.pdf-slot.is-front').evaluate(el => el.scrollBy(0, 250))
  await page.waitForFunction(() => (window as any).__folio.usePdfView.getState().page === 4)
  const top = await page.locator('.pdf-slot.is-front').evaluate(el => el.scrollTop)
  // sample the page on screen while reloading: it must never jump to the first page
  await page.evaluate(() => {
    const w = window as any
    w.__pageSamples = []
    w.__pageSampler = setInterval(() => w.__pageSamples.push(w.__folio.usePdfView.getState().page), 25)
  })
  expect(await recompile()).toBe('success')
  const samples = await page.evaluate(() => {
    const w = window as any
    clearInterval(w.__pageSampler)
    return w.__pageSamples as number[]
  })
  const after = await pdfView(page)
  expect(after).toMatchObject({ page: 4, scaleValue: '1.5' })
  await expect.poll(() => page.locator('.pdf-slot.is-front').evaluate(el => el.scrollTop)).toBeGreaterThanOrEqual(top - 2)
  expect(Math.abs((await page.locator('.pdf-slot.is-front').evaluate(el => el.scrollTop)) - top)).toBeLessThanOrEqual(2)
  expect(Math.min(...samples)).toBeGreaterThanOrEqual(3)
  await folio(page, f => f.pdfController().setScaleValue('page-width'))
})

test('the logs pane counts match the build', async () => {
  const counts = await lastLog()
  await page.locator('.pdf-logsbtn').click()
  await expect(page.locator('.logs-pane')).toBeVisible()
  expect(await tabCount('errors')).toBe(counts.errors)
  expect(await tabCount('warnings')).toBe(counts.warnings)
  expect(await tabCount('typesetting')).toBe(counts.typesetting)
  expect(await tabCount('all')).toBe(counts.errors + counts.warnings + counts.typesetting)
  if (counts.warnings > 0) await expect(page.locator('.pdf-logsbtn .pdf-count--warning')).toHaveText(String(Math.min(counts.warnings, 99)))
  await page.locator('#logs-tab-errors').click()
  await expect(page.locator('.logs-empty .ui-empty__title')).toHaveText('No errors, great!')
  await shot(page, 'pdf-logs')
  await page.keyboard.press('Escape')
  await expect(page.locator('.logs-pane')).toHaveCount(0)
})

test('a warning in the logs jumps to its line; the raw log is there', async () => {
  test.skip(!docker(), 'the fake runner’s log has no warning with a line')
  // the undefined \ref on line 5 is a warning with a location; its button jumps there
  await page.locator('.pdf-logsbtn').click()
  await page.locator('#logs-tab-warnings').click()
  const card = page.locator('.logs-entry--warning', { hasText: 'sec:missing' }).first()
  await expect(card.locator('button.logs-entry__loc')).toHaveText(/main\.tex, line 5$/)
  await setCursor(page, 0)
  await card.locator('button.logs-entry__loc').click()
  await expect.poll(() => folio(page, f => {
    const v = f.useEditor.getState().view
    return v.state.doc.lineAt(v.state.selection.main.head).number
  })).toBe(5)
  // the raw log and the output files are there too
  await page.locator('#logs-tab-raw').click()
  await expect(page.locator('.logs-raw__text')).toContainText('This is pdfTeX')
  await page.keyboard.press('Escape')
  await expect(page.locator('.logs-pane')).toHaveCount(0)
})

test('stop on first error keeps the last PDF; trying despite errors produces one', async () => {
  test.skip(!docker(), 'needs real TeX')
  let fid = await acquireDoc(page, 'main.tex')
  const marker = '\\folioUndefinedMacroXYZ{}'
  const text = await docText(page, fid)
  await docInsert(page, fid, text.indexOf('\\section{End}'), `${marker}\n`)
  const pdfBefore = await folio(page, f => f.useCompile.getState().lastWithPdf.buildId)

  await menuItem('Stop on first error')
  expect(await folio(page, f => f.useCompile.getState().options.stopOnFirstError)).toBe(true)
  expect(await recompile()).toBe('stopped-on-first-error')
  expect((await pdfView(page)).buildId).toBe(pdfBefore) // the previous PDF stays on screen
  await expect(page.locator('.pdf-logsbtn .pdf-count--error')).toHaveText(/[1-9]/)
  await expect(page.locator('.pdf-banner')).toContainText(/stopped on the first error/i)
  await shot(page, 'pdf-stopped-on-first-error')
  await page.locator('.pdf-banner__action', { hasText: 'View logs' }).click()
  await expect(page.locator('.logs-entry--error .logs-entry__msg').first()).toContainText('Undefined control sequence')
  await page.locator('.logs-head__back').click()

  // after a reload the last PDF is still shown (the newest build has none), with the same banner
  await page.reload()
  await openProject(page, pid)
  await page.waitForFunction(id => {
    const v = (window as any).__folio.usePdfView.getState()
    return v.buildId === id && v.status === 'ready'
  }, pdfBefore, { timeout: 30_000 })
  await expect(page.locator('.pdf-banner')).toContainText(/stopped on the first error/i)
  await openFile(page, 'main.tex')
  fid = await acquireDoc(page, 'main.tex')

  await menuItem('Try to compile despite errors')
  expect(await recompile()).toBe('success')
  expect((await pdfView(page)).buildId).toBe(await lastBuildId(page))
  await expect(page.locator('.pdf-logsbtn .pdf-count--error')).toHaveText(/[1-9]/)

  const now = await docText(page, fid)
  await folio(page, (f, [id, m]: string[]) => {
    const t = (window as any).__e2eDocs[id].ytext
    const i = t.toString().indexOf(m)
    if (i >= 0) t.delete(i, m.length)
  }, [fid, `${marker}\n`])
  expect(now).toContain(marker)
  expect(await recompile()).toBe('success')
  await expect(page.locator('.pdf-logsbtn .pdf-count--error')).toHaveCount(0)
})

test('draft mode and recompile from scratch are sent with the request', async () => {
  const bodies: any[] = []
  const onReq = (r: Request) => {
    if (r.method() === 'POST' && r.url().endsWith(`/api/projects/${pid}/compile`)) bodies.push(r.postDataJSON())
  }
  page.on('request', onReq)
  await menuItem('Fast [draft]')
  expect(await recompile()).toBe('success')
  expect(bodies.at(-1)).toMatchObject({ draft: true })
  await expect(page.locator('.pdf-compile__mode')).toHaveText('draft')
  await menuItem('Normal')
  await expect(page.locator('.pdf-compile__mode')).toHaveCount(0)

  const prev = await lastBuildId(page)
  await menuItem('Recompile from scratch')
  expect(await waitForBuild(page, prev)).toBe('success')
  expect(bodies.at(-1)).toMatchObject({ fromScratch: true })
  expect(bodies.at(-1).draft).toBeFalsy()
  page.off('request', onReq)
})

test('a running compile can be stopped; a collaborator sees it running, then not', async ({ browser }) => {
  test.skip(!docker(), 'the fake runner finishes at once')
  const pb = await (await userContext(browser, 'bob')).newPage()
  await openProject(pb, pid)
  // the collaborator shows the same root document (another document's compile is not shown)
  await openFile(pb, 'slow.tex')
  // slow.tex has its own \documentclass: with it open, Recompile builds it
  await openFile(page, 'slow.tex')
  const prev = await lastBuildId(page)
  await page.locator('.pdf-compile__main').click()
  await page.waitForFunction(() => (window as any).__folio.useCompile.getState().status === 'compiling')
  await expect(page.locator('.pdf-compile__label')).toHaveText('Compiling…')
  // wait until TeX runs in its container
  await expect.poll(() => execFileSync('docker', ['ps', '-q', '--filter', `label=folio.project=${pid}`], { encoding: 'utf8' }).trim().length, { timeout: 30_000 }).toBeGreaterThan(0)
  // clearing the cache is refused meanwhile, and does not cancel the compile
  const api = await apiAs('alice')
  const clear = await api.delete(`/api/projects/${pid}/compile/cache`)
  expect(clear.status()).toBe(409)
  expect((await clear.json()).error.code).toBe('compile_running')
  await api.dispose()
  expect(await folio(page, f => f.useCompile.getState().status)).toBe('compiling')
  await expect(pb.locator('.pdf-pane')).toContainText('Alice Admin is compiling…')
  // stop it from the menu
  await compileMenu().click()
  const stop = page.locator('[role="menu"] [role="menuitem"]', { hasText: 'Stop compilation' })
  await expect(stop).not.toHaveAttribute('aria-disabled', 'true')
  await stop.click()
  expect(await waitForBuild(page, prev, 30_000)).toBe('terminated')
  await expect(page.locator('.pdf-banner')).toContainText(/cancelled/i)
  await shot(page, 'pdf-compile-cancelled')
  await expect(pb.locator('.pdf-pane')).not.toContainText('is compiling…')
  await pb.context().close()
  await openFile(page, 'main.tex')
})

test('clear cached files empties the logs; the next compile starts again', async () => {
  await page.locator('.pdf-logsbtn').click()
  await page.locator('.logs-files__foot button', { hasText: 'Clear cached files' }).click()
  const dialog = page.getByRole('dialog', { name: 'Clear cached files?' })
  await dialog.getByRole('button', { name: 'Clear cached files' }).click()
  await page.waitForFunction(() => (window as any).__folio.useCompile.getState().lastWithPdf === null, undefined, { timeout: 15_000 })
  await expect(page.locator('.logs-pane .ui-empty__title')).toHaveText('No logs yet')
  await page.keyboard.press('Escape')
  await expect(page.locator('.pdf-state__title', { hasText: 'No PDF yet' })).toBeVisible()
  const api = await apiAs('alice')
  expect((await api.get(`/api/projects/${pid}/compile/last`)).status()).toBe(204)
  await api.dispose()
  expect(await recompile()).toBe('success')
})

test('typing marks the PDF out of date; with auto compile on it recompiles by itself', async () => {
  const endOf = async (needle: string) => (await folio(page, (f, n: string) => f.useEditor.getState().view.state.doc.toString().indexOf(n) as number, needle)) + needle.length
  // auto compile off (the default in these tests): the "Out of date" chip recompiles on click
  await setCursor(page, await endOf('Text at the end.'))
  await page.keyboard.type(' Typed by hand.')
  await expect(page.locator('.pdf-chip--stale')).toBeVisible()
  let prev = await lastBuildId(page)
  await page.locator('.pdf-chip--stale').click()
  expect(await waitForBuild(page, prev)).toBe('success')
  await expect(page.locator('.pdf-chip--stale')).toHaveCount(0)

  await menuItem('On')
  expect(await folio(page, f => f.useCompile.getState().options.autoCompile)).toBe(true)
  prev = await lastBuildId(page)
  await setCursor(page, await endOf('Typed by hand.'))
  await page.keyboard.type(' Typed for auto compile.')
  await page.waitForFunction(() => {
    const f = (window as any).__folio
    return f.useAutoCompileState.getState().scheduled || f.useCompile.getState().status === 'compiling'
  })
  expect(await waitForBuild(page, prev, 60_000)).toBe('success')
  expect(await folio(page, f => f.useCompile.getState().changedSinceCompile)).toBe(false)
  await menuItem('Off')
})

test('word count, and the PDF downloads as "<project name>.pdf"', async () => {
  await page.locator('.lay-menubar__item', { hasText: 'File' }).click()
  await page.getByRole('menuitem', { name: 'Word count' }).click()
  await expect(page.locator('.wc-hero__value')).toHaveText(/\d/, { timeout: 60_000 })
  const words = Number((await page.locator('.wc-hero__value').textContent())!.replace(/[^\d]/g, ''))
  expect(words).toBeGreaterThan(docker() ? 10 : 0) // texcount counts the source (\lipsum is not expanded)
  await shot(page, 'pdf-wordcount')
  await page.keyboard.press('Escape')

  // a narrow PDF pane moves the button into the "More PDF actions" menu
  const button = page.locator('.pdf-toolbar button[aria-label="Download PDF"]')
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    (async () => {
      if (await button.isVisible()) await button.click()
      else {
        await page.getByRole('button', { name: 'More PDF actions' }).click()
        await page.getByRole('menuitem', { name: 'Download PDF' }).click()
      }
    })(),
  ])
  expect(download.suggestedFilename()).toBe(`${NAME}.pdf`)
  const head = await new Promise<string>((resolve, reject) => {
    void download.createReadStream().then(s => {
      s.once('data', (c: Buffer) => resolve(c.subarray(0, 5).toString()))
      s.once('error', reject)
    })
  })
  expect(head).toBe('%PDF-')
})

test('a viewer can recompile by hand but gets no editor-only compile options', async ({ browser }) => {
  const ctx = await userContext(browser, 'carol')
  const pc = await ctx.newPage()
  await openProject(pc, pid)
  await pc.locator('.pdf-compile__caret').click()
  const items = await pc.locator('[role="menu"] [role^="menuitem"]').allTextContents()
  expect(items.join('|')).not.toMatch(/Stop compilation|Recompile from scratch/)
  expect(items.join('|')).toMatch(/Fast \[draft\]/)
  await pc.keyboard.press('Escape')
  let prev = await lastBuildId(pc)
  await pc.locator('.pdf-compile__main').click()
  expect(await waitForBuild(pc, prev)).toBe('success')
  const by = await folio(pc, f => f.useCompile.getState().last.by?.name ?? null)
  expect(by).toBe('Carol Viewer')
  // the keyboard shortcut works for her too (within a second of the last compile the store retries by itself)
  prev = await lastBuildId(pc)
  await pc.locator('.pdf-toolbar').click({ position: { x: 5, y: 5 } })
  await pc.keyboard.press('ControlOrMeta+Enter')
  expect(await waitForBuild(pc, prev)).toBe('success')
  await ctx.close()
})
