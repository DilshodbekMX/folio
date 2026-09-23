/**
 * The acceptance test on the real paper (XeLaTeX, xr supplement, 63 \bibitem, TikZ): it compiles
 * from the Recompile button with no errors and no undefined references, the external document is
 * built first, the logs pane counts match the build, and SyncTeX works both ways — double-click
 * a word in the PDF → the editor lands on that word; the editor line → highlighted in the PDF;
 * the divider's ← arrow jumps to the source of the visible page. Needs the Docker runner.
 */
import { expect, type Page } from '@playwright/test'
import { docker, e2eState, editorText, folio, lastBuildId, openFile, openProject, pdfView, shot, test, userContext, waitForBuild } from './helpers'

let page: Page
let rootId: string

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  test.skip(!docker(), 'needs the Docker runner (COMPILE_RUNNER=docker)')
  test.skip(!e2eState().projects.paper, 'the paper (../antiddos_v2.tex) is not available')
  page = await (await userContext(browser, 'alice')).newPage()
  await openProject(page, e2eState().projects.paper!)
  await openFile(page, 'antiddos_v2.tex')
  rootId = await folio(page, f => f.useProject.getState().settings.rootFileId as string)
})
test.afterAll(async () => {
  await page?.context().close()
})

const jumpNonce = () => folio(page, f => (f.useEditor.getState().jumpRequest?.nonce as number | undefined) ?? 0)
const jump = () => folio(page, f => f.useEditor.getState().jumpRequest as { fileId: string; line: number; column?: number })

test('the paper compiles with XeLaTeX from the Recompile button: no errors, no undefined references', async () => {
  test.setTimeout(300_000)
  const prev = await lastBuildId(page)
  await page.locator('.pdf-compile__main').click()
  expect(await waitForBuild(page, prev, 280_000)).toBe('success')
  const last = await folio(page, f => {
    const l = f.useCompile.getState().last
    return {
      compiler: l.compiler,
      rootPath: l.rootPath,
      errors: l.log.errors.map((e: any) => e.message),
      undefinedRefs: l.log.warnings.filter((w: any) => w.kind === 'undefined-reference' || w.kind === 'undefined-citation' || /undefined/i.test(w.message)).map((w: any) => w.message),
      // the xr supplement is pre-built when its .aux is missing or changed (always on a fresh server)
      external: l.externalBuilds.filter((b: any) => b.status !== 'success').map((b: any) => `${b.path}:${b.status}`),
      outputs: l.outputFiles.map((o: any) => o.path),
    }
  })
  expect(last).toMatchObject({ compiler: 'xelatex', rootPath: 'antiddos_v2.tex', errors: [], undefinedRefs: [], external: [] })
  expect(last.outputs).toEqual(expect.arrayContaining(['antiddos_v2.pdf', 'antiddos_v2.synctex.gz', 'antiddos_v2_supplementary.pdf']))
  expect((await pdfView(page)).pages).toBeGreaterThan(30)
  await expect(page.locator('.pdfViewer .page[data-page-number="1"] canvas')).toBeVisible()
  await expect(page.locator('.pdf-logsbtn .pdf-count--error')).toHaveCount(0)
  await shot(page, 'paper-compiled')

  // the logs pane agrees with the build; the external document's PDF is among the output files
  const counts = await folio(page, f => {
    const l = f.useCompile.getState().last.log
    return { warnings: l.warnings.length, typesetting: l.typesetting.length }
  })
  await page.locator('.pdf-logsbtn').click()
  const badge = async (id: string) => Number((await page.locator(`#logs-tab-${id} .ui-badge`).textContent()) || 0)
  expect(await badge('warnings')).toBe(counts.warnings)
  expect(await badge('typesetting')).toBe(counts.typesetting)
  expect(await badge('errors')).toBe(0)
  const files = await page.locator('.logs-file__name').allTextContents()
  expect(files.some(f => f.includes('antiddos_v2_supplementary.pdf'))).toBe(true)
  expect(files.some(f => f.startsWith('antiddos_v2.log'))).toBe(true)
  await page.keyboard.press('Escape')
  await expect(page.locator('.logs-pane')).toHaveCount(0)
})

test('SyncTeX PDF → code: double-clicking a word opens the source at that word', async () => {
  await folio(page, f => f.pdfController().setScaleValue('page-width'))
  await folio(page, f => f.pdfController().goToPage(2))
  await page.waitForFunction(() => !!document.querySelector('.pdf-slot.is-front .page[data-page-number="2"] .textLayer span'))
  const source = await editorText(page)
  // a word of body text that occurs exactly once in the source, so the expected line is unambiguous
  const target = await page.evaluate(src => {
    const once = (w: string) => (src.match(new RegExp(`(?<![A-Za-z])${w}(?![A-Za-z])`, 'g')) ?? []).length === 1
    const box = document.querySelector('.pdf-slot.is-front')!.getBoundingClientRect()
    for (const span of document.querySelectorAll<HTMLElement>('.pdf-slot.is-front .page[data-page-number="2"] .textLayer span')) {
      const node = span.firstChild
      if (!node || node.nodeType !== 3 || (span.textContent ?? '').length < 30) continue
      for (const m of (span.textContent ?? '').matchAll(/[A-Za-z]{8,}/g)) {
        if (!once(m[0])) continue
        const range = document.createRange()
        range.setStart(node, m.index!)
        range.setEnd(node, m.index! + m[0].length)
        const r = range.getBoundingClientRect()
        if (r.width < 4 || r.top < box.top + 5 || r.bottom > box.bottom - 5) continue
        return { word: m[0], x: r.left + r.width / 2, y: r.top + r.height / 2 }
      }
    }
    return null
  }, source)
  expect(target, 'a unique word on page 2').not.toBeNull()
  const n0 = await jumpNonce()
  await page.mouse.dblclick(target!.x, target!.y)
  await expect.poll(jumpNonce).toBeGreaterThan(n0)
  const jr = await jump()
  expect(jr.fileId).toBe(rootId)
  const lineText = source.split('\n')[jr.line - 1] ?? ''
  expect(lineText).toContain(target!.word)
  expect(lineText.slice(jr.column ?? -1, (jr.column ?? -1) + target!.word.length)).toBe(target!.word) // refined to the word
  // the editor follows: the caret is on that line
  await expect.poll(() => folio(page, f => {
    const v = f.useEditor.getState().view
    return v.state.doc.lineAt(v.state.selection.main.head).number as number
  })).toBe(jr.line)
})

test('SyncTeX code → PDF: the cursor line is highlighted in the PDF; ← jumps back from the page shown', async () => {
  const source = await editorText(page)
  const concl = source.split('\n').findIndex(l => l.startsWith('\\section{Conclusions')) + 1
  expect(concl).toBeGreaterThan(0)
  const target = concl + 2
  await folio(page, (f, [id, line]: [string, number]) => f.useEditor.getState().setCursor({ fileId: id, line, column: 0 }), [rootId, target] as [string, number])
  await folio(page, f => f.pdfController().goToPage(1))
  await page.locator('.lay-sync__btn[aria-label="Go to code location in PDF"]').click()
  await expect(page.locator('.pdf-highlight').first()).toBeVisible()
  const hl = await page.evaluate(() => {
    const c = document.querySelector('.pdf-slot.is-front')!.getBoundingClientRect()
    const b = document.querySelector('.pdf-highlight')!.getBoundingClientRect()
    return { visible: b.top >= c.top && b.bottom <= c.bottom }
  })
  expect(hl.visible).toBe(true)
  expect((await pdfView(page)).page).toBeGreaterThan(10) // the conclusions are far from page 1
  await shot(page, 'paper-synctex-highlight')
  await expect(page.locator('.pdf-highlight')).toHaveCount(0, { timeout: 10_000 }) // highlights fade out

  // ← from page 5: the source of what is on screen, well before the conclusions
  await folio(page, f => f.pdfController().goToPage(5))
  await page.waitForFunction(() => (window as any).__folio.usePdfView.getState().page === 5)
  const n0 = await jumpNonce()
  await page.locator('.lay-sync__btn[aria-label="Go to PDF location in code"]').click()
  await expect.poll(jumpNonce).toBeGreaterThan(n0)
  const jr = await jump()
  expect(jr.fileId).toBe(rootId)
  expect(jr.line).toBeGreaterThan(50)
  expect(jr.line).toBeLessThan(concl)
})

test('the supplement opened in the editor compiles on its own (xr to the main paper)', async () => {
  test.setTimeout(300_000)
  await openFile(page, 'antiddos_v2_supplementary.tex')
  const prev = await lastBuildId(page)
  await page.locator('.pdf-compile__main').click()
  expect(await waitForBuild(page, prev, 280_000)).toBe('success')
  const last = await folio(page, f => {
    const l = f.useCompile.getState().last
    return {
      rootPath: l.rootPath,
      errors: l.log.errors.length,
      undefinedRefs: l.log.warnings.filter((w: any) => w.kind === 'undefined-reference' || w.kind === 'undefined-citation' || /undefined/i.test(w.message)).map((w: any) => w.message),
    }
  })
  expect(last).toEqual({ rootPath: 'antiddos_v2_supplementary.tex', errors: 0, undefinedRefs: [] })
  await page.locator('.pdf-logsbtn').click()
  await expect(page.locator('.logs-summary')).toContainText('antiddos_v2_supplementary.tex')
  await page.keyboard.press('Escape')
  // back on the main document, Recompile builds the paper again
  await openFile(page, 'antiddos_v2.tex')
  const prev2 = await lastBuildId(page)
  await page.locator('.pdf-compile__main').click()
  expect(await waitForBuild(page, prev2, 280_000)).toBe('success')
  expect(await folio(page, f => f.useCompile.getState().last.rootPath)).toBe('antiddos_v2.tex')
})
