/**
 * The file tree on a throw-away project, with a collaborator watching: create a file and a
 * folder, inline rename (F2) with validation, drag-to-move, delete with confirmation; uploads
 * through the modal (conflict → Replace) and OS drops onto a folder; "Set as main document";
 * binary previews (PNG, PDF with pdf.js, EPS rendered by Ghostscript on the server); the
 * read-only tree of a viewer.
 */
import fs from 'node:fs'
import path from 'node:path'
import { expect, type Page } from '@playwright/test'
import { folio, newProject, openProject, png, removeProject, ROOT, shot, test, userContext } from './helpers'

const EPS = `%!PS-Adobe-3.0 EPSF-3.0
%%BoundingBox: 0 0 120 60
%%EndComments
0.2 0.5 0.3 setrgbcolor
newpath 10 10 moveto 110 50 lineto 110 10 lineto closepath fill
showpage
%%EOF
`
const PDF = fs.readFileSync(path.join(ROOT, 'server/test/fixtures/fake-build/main.pdf'))

let pid: string
let a: Page
let b: Page

test.describe.configure({ mode: 'serial' })

test.beforeAll(async ({ browser }) => {
  pid = await newProject('E2E File tree', {
    files: [
      { path: 'other.tex', content: '\\documentclass{article}\n\\begin{document}\nAnother root.\n\\end{document}\n' },
      { path: 'figures/plot.png', content: png(240, 160) },
      { path: 'figures/doc.pdf', content: PDF },
      { path: 'figures/shape.eps', content: Buffer.from(EPS) }, // uploaded: classified by the server (binary)
    ],
  })
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

const row = (page: Page, p: string) => page.locator(`.ft-row[data-path="${p}"]`)
const hasPath = (page: Page, p: string, present = true) =>
  page.waitForFunction(([pp, want]) => Object.values((window as any).__folio.useProject.getState().files).some((f: any) => f.path === pp) === want, [p, present] as const, { timeout: 15_000 })
const openPath = (page: Page) => folio(page, f => f.useProject.getState().files[f.useEditor.getState().openFileId]?.path ?? null)

test('create, rename (with validation), move by drag and delete — live for the collaborator', async () => {
  // new file from the toolbar: created, opened, revealed; bob sees it
  await a.getByRole('button', { name: 'New file', exact: true }).click()
  const dialog = a.getByRole('dialog', { name: 'New file' })
  await dialog.locator('input').fill('chapter1.tex')
  await dialog.locator('input').press('Enter')
  await hasPath(a, 'chapter1.tex')
  await expect.poll(() => openPath(a)).toBe('chapter1.tex')
  await expect(row(a, 'chapter1.tex')).toHaveAttribute('aria-selected', 'true')
  await hasPath(b, 'chapter1.tex')
  await expect(row(b, 'chapter1.tex')).toBeVisible()

  // new folder from the empty area's context menu
  const box = (await a.locator('.ft-scroll').boundingBox())!
  await a.mouse.click(box.x + box.width / 2, box.y + box.height - 15, { button: 'right' })
  await a.getByRole('menuitem', { name: 'New folder…' }).click()
  await a.getByRole('dialog', { name: 'New folder' }).locator('input').fill('chapters')
  await a.getByRole('dialog', { name: 'New folder' }).locator('input').press('Enter')
  await hasPath(a, 'chapters')
  await expect(row(a, 'chapters')).toHaveAttribute('data-kind', 'folder')

  // F2 renames inline: invalid and duplicate names are refused, Escape cancels
  await row(a, 'chapter1.tex').click()
  await row(a, 'chapter1.tex').press('F2')
  const input = a.locator('.ft-rename__input')
  expect(await input.evaluate((el: HTMLInputElement) => el.value.slice(el.selectionStart!, el.selectionEnd!))).toBe('chapter1')
  await input.fill('bad/name.tex')
  await input.press('Enter')
  await expect(a.locator('.ft-rename__error')).toBeVisible()
  await input.fill('main.tex')
  await expect(a.locator('.ft-rename__error')).toContainText('already exists')
  await shot(a, 'filetree-rename-error')
  await input.fill('intro.tex')
  await input.press('Enter')
  await hasPath(a, 'intro.tex')
  await expect(row(a, 'chapter1.tex')).toHaveCount(0)
  await hasPath(b, 'intro.tex')
  await row(a, 'intro.tex').press('F2')
  await a.locator('.ft-rename__input').fill('nope.tex')
  await a.locator('.ft-rename__input').press('Escape')
  await expect(a.locator('.ft-rename__input')).toHaveCount(0)
  await expect(row(a, 'intro.tex')).toBeVisible()

  // drag onto a folder moves the file; a folder cannot go into itself
  await row(a, 'intro.tex').dragTo(row(a, 'chapters'))
  await hasPath(a, 'chapters/intro.tex')
  await hasPath(b, 'chapters/intro.tex')
  await expect(row(a, 'chapters')).toHaveAttribute('aria-expanded', 'true')
  await row(a, 'chapters').dragTo(row(a, 'chapters/intro.tex'))
  await expect.poll(() => folio(a, f => Object.values(f.useProject.getState().files).map((x: any) => x.path).filter((p: string) => p.startsWith('chapters')).sort())).toEqual(['chapters', 'chapters/intro.tex'])

  // Delete asks first (Cancel has the focus); confirming removes it everywhere
  await row(a, 'chapters/intro.tex').click()
  await row(a, 'chapters/intro.tex').press('Delete')
  const confirm = a.getByRole('dialog', { name: 'Delete “intro.tex”?' })
  await expect(confirm).toContainText('permanently delete')
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused()
  await confirm.getByRole('button', { name: 'Delete' }).click()
  await hasPath(a, 'chapters/intro.tex', false)
  await hasPath(b, 'chapters/intro.tex', false)
})

test('upload through the modal (conflict → Replace) and by dropping files on a folder', async () => {
  await a.getByRole('button', { name: 'Upload', exact: true }).click()
  const modal = a.getByRole('dialog')
  await expect(modal).toContainText('Drag files or folders here')
  await modal.locator('select').selectOption('') // the target folder follows the tree's selection: upload to the root
  await a.locator('[data-testid="ft-upload-files"]').setInputFiles([
    { name: 'photo.png', mimeType: 'image/png', buffer: png(64, 48, [200, 60, 60]) },
    { name: 'notes.tex', mimeType: 'text/x-tex', buffer: Buffer.from('\\section{Notes}\nUploaded.\n') },
  ])
  await expect(modal).toHaveCount(0)
  await hasPath(a, 'photo.png')
  const kinds = await folio(a, f => Object.fromEntries(Object.values(f.useProject.getState().files).map((x: any) => [x.path, x.kind])))
  expect(kinds).toMatchObject({ 'photo.png': 'binary', 'notes.tex': 'text' })
  await hasPath(b, 'photo.png')

  // the same name again: the modal asks, Replace overwrites the same entry
  const before = await folio(a, f => f.useProject.getState().fileByPath('photo.png'))
  await a.getByRole('button', { name: 'Upload', exact: true }).click()
  await a.getByRole('dialog').locator('select').selectOption('')
  await a.locator('[data-testid="ft-upload-files"]').setInputFiles([{ name: 'photo.png', mimeType: 'image/png', buffer: png(80, 40, [20, 160, 90]) }])
  await expect(a.locator('.ft-upload__conflict')).toContainText('already exists')
  await a.locator('.ft-upload__conflict').getByRole('button', { name: 'Replace' }).click()
  await expect(a.getByRole('dialog')).toHaveCount(0)
  await expect.poll(async () => (await folio(a, f => f.useProject.getState().fileByPath('photo.png'))).size).not.toBe(before.size)
  expect((await folio(a, f => f.useProject.getState().fileByPath('photo.png'))).id).toBe(before.id)

  // files dragged from the OS onto a folder row are uploaded into that folder
  await a.evaluate(b64 => {
    const el = document.querySelector('.ft-row[data-path="chapters"]')!
    const r = el.getBoundingClientRect()
    const dt = new DataTransfer()
    dt.items.add(new File([Uint8Array.from(atob(b64), c => c.charCodeAt(0))], 'dropped.png', { type: 'image/png' }))
    dt.items.add(new File(['% dropped\n'], 'dropped.tex', { type: 'text/x-tex' }))
    const init = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: r.left + 30, clientY: r.top + r.height / 2 }
    el.dispatchEvent(new DragEvent('dragenter', init))
    el.dispatchEvent(new DragEvent('dragover', init))
    el.dispatchEvent(new DragEvent('drop', init))
  }, png(32, 32).toString('base64'))
  await hasPath(a, 'chapters/dropped.png')
  await hasPath(a, 'chapters/dropped.tex')
  await expect(a.locator('.ui-toast--success').first()).toBeVisible()
  await hasPath(b, 'chapters/dropped.png')
})

test('set as main document from the context menu', async () => {
  const root = await folio(a, f => f.useProject.getState().settings.rootFileId as string)
  await row(a, 'other.tex').click({ button: 'right' })
  const items = await a.getByRole('menuitem').allTextContents()
  for (const t of ['Rename', 'Download', 'Set as main document', 'Copy path', 'Delete']) expect(items.some(i => i.startsWith(t)), t).toBe(true)
  await a.getByRole('menuitem', { name: 'Set as main document' }).click()
  const otherId = await folio(a, f => f.useProject.getState().fileByPath('other.tex').id as string)
  await expect.poll(() => folio(a, f => f.useProject.getState().settings.rootFileId)).toBe(otherId)
  await expect(row(a, 'other.tex').locator('.ft-mainbadge')).toHaveCount(1)
  await expect.poll(() => folio(b, f => f.useProject.getState().settings.rootFileId)).toBe(otherId)
  // and back
  await row(a, 'main.tex').click({ button: 'right' })
  await a.getByRole('menuitem', { name: 'Set as main document' }).click()
  await expect.poll(() => folio(a, f => f.useProject.getState().settings.rootFileId)).toBe(root)
  await expect(row(a, 'main.tex').locator('.ft-mainbadge')).toHaveCount(1)
})

test('binary previews: PNG, the first page of a PDF, an EPS rendered on the server', async () => {
  if ((await row(a, 'figures').getAttribute('aria-expanded')) !== 'true') await row(a, 'figures').click()
  const preview = a.locator('#lay-editor .ft-preview')

  await row(a, 'figures/plot.png').click()
  await expect(preview.locator('img.ft-imgview__img')).toBeVisible()
  expect(await preview.locator('img.ft-imgview__img').evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(240)
  await expect(preview.locator('.ft-preview__meta')).toContainText('240 × 160 px')
  expect(await folio(a, f => f.useEditor.getState().view)).toBeNull() // no text editor for binaries
  await shot(a, 'filetree-preview-png')

  await row(a, 'figures/doc.pdf').click()
  await a.waitForFunction(() => {
    const c = document.querySelector<HTMLCanvasElement>('#lay-editor .ft-pdfview__canvas')
    return !!c && c.width > 50 && !c.classList.contains('is-rendering')
  }, undefined, { timeout: 20_000 })

  await row(a, 'figures/shape.eps').click()
  const eps = preview.locator('img.ft-imgview__img')
  await expect(eps).toBeVisible({ timeout: 30_000 })
  expect(await eps.getAttribute('src')).toContain('/preview')
  await expect.poll(() => eps.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(0)
  await shot(a, 'filetree-preview-eps')

  // download from the preview keeps the file name
  await row(a, 'figures/plot.png').click()
  const [download] = await Promise.all([a.waitForEvent('download'), preview.getByRole('button', { name: 'Download' }).click()])
  expect(download.suggestedFilename()).toBe('plot.png')
})

test('a viewer gets a read-only tree', async ({ browser }) => {
  const c = await (await userContext(browser, 'carol')).newPage()
  await openProject(c, pid)
  await expect(c.getByRole('button', { name: 'New file', exact: true })).toHaveCount(0)
  await expect(c.getByRole('button', { name: 'Upload', exact: true })).toHaveCount(0)
  await expect(row(c, 'main.tex')).toHaveAttribute('draggable', 'false')
  await row(c, 'main.tex').click()
  await row(c, 'main.tex').press('F2')
  await expect(c.locator('.ft-rename__input')).toHaveCount(0)
  await row(c, 'main.tex').press('Delete')
  await expect(c.getByRole('dialog')).toHaveCount(0)
  await row(c, 'main.tex').click({ button: 'right' })
  const items = await c.getByRole('menuitem').allTextContents()
  expect(items.filter(t => /Rename|Delete|Set as main|New /.test(t))).toEqual([])
  expect(items.some(t => t.startsWith('Download'))).toBe(true)
  await c.keyboard.press('Escape')
  // the tree does not accept dropped files either
  expect(await c.evaluate(() => {
    const dt = new DataTransfer()
    dt.items.add(new File(['x'], 'viewer.txt'))
    const ev = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt })
    document.querySelector('.ft-scroll')!.dispatchEvent(ev)
    return ev.defaultPrevented
  })).toBe(false)
  await c.context().close()
})
