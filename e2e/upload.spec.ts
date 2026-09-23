/**
 * Importing a project from a .zip: through the dashboard's upload modal (a single top-level
 * folder is unwrapped, build output skipped, the main document detected), the API's report of
 * skipped entries, and the round trip download.zip → upload.
 */
import { expect } from '@playwright/test'
import yazl from 'yazl'
import { apiAs, authFile, json, openProject, shot, test } from './helpers'

test.use({ storageState: authFile('alice') })

function zipOf(entries: { name: string; data: string | Buffer }[]): Promise<Buffer> {
  const zip = new yazl.ZipFile()
  for (const e of entries) zip.addBuffer(Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data), e.name)
  zip.end()
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c))
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    zip.outputStream.on('error', reject)
  })
}

const PAPER = [
  { name: 'thesis/paper.tex', data: '\\documentclass{article}\n\\begin{document}\nHello \\input{sections/intro}\n\\end{document}\n' },
  { name: 'thesis/sections/intro.tex', data: 'Introduction text.\n' },
  { name: 'thesis/refs.bib', data: '@article{k, title={T}, year=2020}\n' },
  { name: 'thesis/paper.aux', data: 'stale' },
  { name: 'thesis/paper.pdf', data: '%PDF-1.5 stale' },
  { name: 'thesis/.DS_Store', data: 'junk' },
]

test('upload a .zip from the dashboard', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'New project' }).first().click()
  await page.getByRole('menuitem', { name: /Upload a \.zip/ }).click()
  const modal = page.getByRole('dialog', { name: 'Upload a project' })
  await expect(modal).toBeVisible()
  await shot(page, 'upload-modal')
  await modal.locator('input[type=file]').setInputFiles({ name: 'My Thesis.zip', mimeType: 'application/zip', buffer: await zipOf(PAPER) })
  await expect(page).toHaveURL(/\/project\/[A-Za-z0-9_-]{16}$/, { timeout: 30_000 })
  const pid = page.url().split('/').pop()!
  await openProject(page, pid)

  const api = await apiAs('alice')
  const detail = await json<{ name: string; files: { id: string; path: string }[]; settings: { rootFileId: string | null } }>(await api.get(`/api/projects/${pid}`))
  expect(detail.name).toBe('My Thesis')
  expect(detail.files.map(f => f.path).sort()).toEqual(['paper.tex', 'refs.bib', 'sections', 'sections/intro.tex'])
  expect(detail.settings.rootFileId).toBe(detail.files.find(f => f.path === 'paper.tex')!.id)
  await api.delete(`/api/projects/${pid}`)
  await api.dispose()
})

test('the upload API reports skipped entries; download.zip re-imports unchanged', async () => {
  const api = await apiAs('alice')
  const up = await api.post('/api/projects/upload', { multipart: { file: { name: 'thesis.zip', mimeType: 'application/zip', buffer: await zipOf(PAPER) } } })
  expect(up.status()).toBe(201)
  const body = await json<{ id: string; skipped?: { path: string; reason: string }[] }>(up)
  expect(Object.fromEntries((body.skipped ?? []).map(s => [s.path, s.reason]))).toEqual({
    'thesis/.DS_Store': expect.stringContaining('.DS_Store'),
    'thesis/paper.aux': 'build artefact (.aux)',
    'thesis/paper.pdf': expect.stringContaining('build output'),
  })

  const dl = await api.get(`/api/projects/${body.id}/download.zip`)
  expect(dl.status()).toBe(200)
  expect(dl.headers()['content-type']).toBe('application/zip')
  const again = await api.post('/api/projects/upload', { multipart: { file: { name: 'roundtrip.zip', mimeType: 'application/zip', buffer: await dl.body() } } })
  expect(again.status()).toBe(201)
  const a = await json<{ files: { path: string; size: number }[] }>(await api.get(`/api/projects/${body.id}`))
  const b = await json<{ files: { path: string; size: number }[] }>(await api.get(`/api/projects/${(await json(again)).id}`))
  const summary = (f: { path: string; size: number }[]) => f.map(x => `${x.path}:${x.size}`).sort()
  expect(summary(b.files)).toEqual(summary(a.files))
  for (const id of [body.id, (await json(again)).id]) await api.delete(`/api/projects/${id}`)
  await api.dispose()
})
