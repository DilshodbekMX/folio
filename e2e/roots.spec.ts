/**
 * A project with two root documents (the paper and a supplement with its own \documentclass,
 * like the real paper's xr supplement): each collaborator keeps the PDF of the document they
 * work on. A collaborator's build of the other document is never shown, does not say "X is
 * compiling…" or "PDF updated by X", and does not end "out of date". The PDF downloads as
 * "<project>.pdf" for the main document and "<project> - <jobname>.pdf" for the other one —
 * also from the dashboard, which always picks the main document's newest PDF even when the
 * newest build of the project is the supplement's. A reload shows the open document's PDF again.
 */
import { expect, type Download, type Page } from '@playwright/test'
import { docker, folio, lastBuildId, newProject, openFile, openProject, pdfView, removeProject, shot, test, userContext, waitForBuild } from './helpers'

const NAME = 'E2E Two Roots'
const MAIN = '\\documentclass{article}\n\\begin{document}\n\\section{Paper}\nMainpaperbody text.\n\\end{document}\n'
const SUPP = '\\documentclass{article}\n\\begin{document}\n\\section{Supplement}\nSupplementbody text.\n\\end{document}\n'

let pid: string
let pa: Page // alice: the paper (main.tex, the main document)
let pb: Page // bob: the supplement (supp.tex)

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  pid = await newProject(NAME, { files: [{ path: 'main.tex', content: MAIN }, { path: 'supp.tex', content: SUPP }] })
  pa = await (await userContext(browser, 'alice', { acceptDownloads: true })).newPage()
  pb = await (await userContext(browser, 'bob', { acceptDownloads: true })).newPage()
  await openProject(pa, pid)
  await openFile(pa, 'main.tex')
  await openProject(pb, pid)
  await openFile(pb, 'supp.tex')
})
test.afterAll(async () => {
  await pa?.context().close()
  await pb?.context().close()
  if (pid) await removeProject(pid)
})

/** root document of the build a page shows, and that build's id */
const shown = (page: Page) => folio(page, f => {
  const c = f.useCompile.getState()
  return { root: (c.lastWithPdf?.rootPath ?? null) as string | null, buildId: (c.lastWithPdf?.buildId ?? null) as string | null, changed: c.changedSinceCompile as boolean }
})

async function recompile(page: Page): Promise<string> {
  const prev = await lastBuildId(page)
  await page.locator('.pdf-compile__main').click()
  expect(await waitForBuild(page, prev)).toBe('success')
  return (await lastBuildId(page))!
}

/** Download the PDF on screen from the PDF toolbar (or its overflow menu when the pane is narrow). */
async function toolbarDownload(page: Page): Promise<Download> {
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
  return download
}

async function bytes(d: Download): Promise<Buffer> {
  const s = await d.createReadStream()
  const chunks: Buffer[] = []
  for await (const c of s) chunks.push(c as Buffer)
  return Buffer.concat(chunks)
}

test('collaborators on different root documents keep their own PDF', async () => {
  // bob builds the supplement first (alice has nothing on screen yet)
  const suppBuild = await recompile(pb)
  expect(await shown(pb)).toMatchObject({ root: 'supp.tex', buildId: suppBuild })
  await expect(pb.getByTestId('pdf-doc')).toContainText('supp.tex')

  // alice builds the paper: bob keeps the supplement, and is not told about alice's compile
  const mainBuild = await recompile(pa)
  expect(await shown(pa)).toMatchObject({ root: 'main.tex', buildId: mainBuild, changed: false })
  await expect(pa.getByTestId('pdf-doc')).toHaveCount(0)
  await pb.waitForTimeout(1500) // compile:done has reached bob by now
  expect(await shown(pb)).toMatchObject({ root: 'supp.tex', buildId: suppBuild })
  expect((await pdfView(pb)).buildId).toBe(suppBuild)
  expect(await pb.locator('.pdf-pane').innerText()).not.toMatch(/is compiling…|PDF updated by/)

  // bob recompiles the supplement: alice keeps the paper — no "compiling", no notice, still up to
  // date (her pane is sampled while bob's compile runs and a little after)
  let sampling = true
  const noticed: string[] = []
  const sampler = (async () => {
    while (sampling) {
      const text = await pa.locator('.pdf-pane').innerText()
      if (/is compiling…|PDF updated by/.test(text)) noticed.push(text)
      await pa.waitForTimeout(100)
    }
  })()
  await pb.locator('.pdf-compile__main').click()
  expect(await waitForBuild(pb, suppBuild)).toBe('success')
  const suppBuild2 = (await lastBuildId(pb))!
  expect(suppBuild2).not.toBe(suppBuild)
  await pa.waitForTimeout(1500)
  sampling = false
  await sampler
  expect(noticed).toEqual([])
  expect(await shown(pa)).toMatchObject({ root: 'main.tex', buildId: mainBuild, changed: false })
  expect((await pdfView(pa)).buildId).toBe(mainBuild)
  await expect(pa.locator('.pdf-chip--stale')).toHaveCount(0)

  if (docker()) {
    // the pages themselves: each one sees their own document
    await expect(pa.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Mainpaperbody', { timeout: 30_000 })
    await expect(pb.locator('.pdfViewer .page[data-page-number="1"] .textLayer')).toContainText('Supplementbody', { timeout: 30_000 })
  }
  await shot(pb, 'roots-supplement-pdf')
})

test('the PDF downloads under the name of its document, also from the dashboard', async () => {
  const paper = await toolbarDownload(pa)
  expect(paper.suggestedFilename()).toBe(`${NAME}.pdf`)
  const supp = await toolbarDownload(pb)
  expect(supp.suggestedFilename()).toBe(`${NAME} - supp.pdf`)
  const paperBytes = await bytes(paper)
  const suppBytes = await bytes(supp)
  expect(paperBytes.subarray(0, 5).toString()).toBe('%PDF-')
  if (docker()) expect(paperBytes.equals(suppBytes)).toBe(false)

  // the newest build of the project is bob's supplement; the dashboard still gets the paper
  const dash = await (await userContext(pb.context().browser()!, 'bob', { acceptDownloads: true })).newPage()
  await dash.goto('/')
  const row = dash.locator('tr.dash-row', { has: dash.getByRole('link', { name: NAME, exact: true }) })
  const [fromDash] = await Promise.all([dash.waitForEvent('download'), row.getByRole('button', { name: 'Download PDF' }).click()])
  expect(fromDash.suggestedFilename()).toBe(`${NAME}.pdf`)
  expect((await bytes(fromDash)).equals(paperBytes)).toBe(true)
  await dash.context().close()
})

test('after a reload each one sees the PDF of the document they have open', async () => {
  const before = await shown(pb)
  await pb.reload()
  await openProject(pb, pid)
  await openFile(pb, 'supp.tex')
  await pb.waitForFunction(id => (window as any).__folio.useCompile.getState().lastWithPdf?.buildId === id, before.buildId, { timeout: 30_000 })
  expect((await shown(pb)).root).toBe('supp.tex')

  // switching to the paper shows its last PDF at once (no compile), and back again
  await openFile(pb, 'main.tex')
  await pb.waitForFunction(() => (window as any).__folio.useCompile.getState().lastWithPdf?.rootPath === 'main.tex', undefined, { timeout: 30_000 })
  await openFile(pb, 'supp.tex')
  await pb.waitForFunction(id => (window as any).__folio.useCompile.getState().lastWithPdf?.buildId === id, before.buildId, { timeout: 30_000 })
})
