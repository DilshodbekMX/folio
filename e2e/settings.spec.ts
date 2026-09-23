/**
 * The Settings modal: editor settings (font size, line height, wrapping) and the UI theme apply
 * at once, are saved on the account and survive a reload; the compiler settings belong to the
 * project, reach a collaborator live, validate the timeout and are read-only for a viewer; the
 * account tab renames the user and refuses a wrong current password. Alice's settings are put
 * back afterwards.
 */
import { expect, type Page } from '@playwright/test'
import { apiAs, json, newProject, openFile, openProject, removeProject, shot, test, userContext } from './helpers'

let pid: string
let saved: Record<string, unknown>
let savedName: string

test.beforeAll(async () => {
  pid = await newProject('E2E Settings', { files: [{ path: 'main.tex', content: '\\documentclass{article}\n\\begin{document}\nSettings.\n\\end{document}\n' }] })
  const api = await apiAs('alice')
  const me = await json<{ name: string; settings: Record<string, unknown> }>(await api.get('/api/auth/me'))
  saved = me.settings
  savedName = me.name
  await api.dispose()
})
test.afterAll(async () => {
  const api = await apiAs('alice')
  await api.patch('/api/auth/me', { data: { name: savedName, settings: saved } })
  await api.dispose()
  if (pid) await removeProject(pid)
})

async function openSettings(page: Page, tab: string) {
  await page.getByRole('navigation', { name: 'Side panels' }).getByRole('button', { name: 'Settings' }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.getByRole('tab', { name: tab }).click()
  return dialog
}
const cm = (page: Page) => page.evaluate(() => {
  const v = (window as any).__folio.useEditor.getState().view
  return { font: getComputedStyle(v.contentDOM).fontSize, lh: parseFloat(getComputedStyle(v.scrollDOM).lineHeight), wrap: v.contentDOM.classList.contains('cm-lineWrapping') as boolean }
})

test('editor settings and the theme apply live, are saved and survive a reload', async ({ browser }) => {
  const page = await (await userContext(browser, 'alice')).newPage()
  await openProject(page, pid)
  await openFile(page, 'main.tex')
  const before = await cm(page)
  const dialog = await openSettings(page, 'Editor')
  await dialog.locator('select[data-setting="fontSize"]').selectOption('18')
  await dialog.locator('select[data-setting="lineHeight"]').selectOption('wide')
  await dialog.locator('[data-setting="lineWrapping"] button[role="switch"]').click()
  await expect.poll(() => cm(page)).toMatchObject({ font: '18px', wrap: !before.wrap })
  expect((await cm(page)).lh).toBeGreaterThan(before.lh)

  await dialog.getByRole('tab', { name: 'Appearance' }).click()
  await dialog.getByRole('radio', { name: /Dark/ }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // "Dark mode PDF" is a per-browser preference mirrored on <html>
  await expect(page.locator('html')).not.toHaveAttribute('data-pdf-invert')
  await dialog.locator('[data-setting="pdfInvertDark"] button[role="switch"]').click()
  await expect(page.locator('html')).toHaveAttribute('data-pdf-invert')
  await shot(page, 'settings-dark')
  const api = await apiAs('alice')
  await expect.poll(async () => (await json<{ settings: any }>(await api.get('/api/auth/me'))).settings).toMatchObject({ fontSize: 18, lineHeight: 'wide', lineWrapping: !before.wrap, theme: 'dark' })
  await api.dispose()

  await page.reload()
  await page.waitForFunction(() => !!(window as any).__folio?.useEditor?.getState().view)
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.locator('html')).toHaveAttribute('data-pdf-invert')
  await expect.poll(() => cm(page)).toMatchObject({ font: '18px', wrap: !before.wrap })
  await page.context().close()
})

test('compiler settings are per project, live for collaborators, read-only for viewers', async ({ browser }) => {
  const page = await (await userContext(browser, 'alice')).newPage()
  const bob = await (await userContext(browser, 'bob')).newPage()
  await openProject(page, pid)
  await openProject(bob, pid)
  const dialog = await openSettings(page, 'Compiler')
  await dialog.locator('select[data-setting="compiler"]').selectOption('xelatex')
  await expect.poll(() => page.evaluate(() => (window as any).__folio.useProject.getState().settings.compiler)).toBe('xelatex')
  await expect.poll(() => bob.evaluate(() => (window as any).__folio.useProject.getState().settings.compiler)).toBe('xelatex')

  const timeout = dialog.locator('input[data-setting="timeoutSec"]')
  await timeout.fill('10')
  await timeout.press('Enter')
  await expect(dialog.getByText('Enter a whole number of seconds between 30 and 600.')).toBeVisible()
  await timeout.fill('120')
  await timeout.press('Tab')
  await expect.poll(() => bob.evaluate(() => (window as any).__folio.useProject.getState().settings.timeoutSec)).toBe(120)
  const api = await apiAs('alice')
  expect((await json<{ settings: any }>(await api.get(`/api/projects/${pid}`))).settings).toMatchObject({ compiler: 'xelatex', timeoutSec: 120 })
  await api.dispose()
  // the compile mode here is this browser's option for the project
  await dialog.locator('select[data-setting="draft"]').selectOption('draft')
  expect(await page.evaluate(() => (window as any).__folio.useCompile.getState().options.draft)).toBe(true)
  await dialog.locator('select[data-setting="draft"]').selectOption('normal')

  const carol = await (await userContext(browser, 'carol')).newPage()
  await openProject(carol, pid)
  const cdialog = await openSettings(carol, 'Compiler')
  await expect(cdialog.locator('select[data-setting="compiler"]')).toBeDisabled()
  await expect(cdialog.getByText('You have view-only access')).toBeVisible()
  for (const p of [page, bob, carol]) await p.context().close()
})

test('account: the name changes everywhere; a wrong current password is refused', async ({ browser }) => {
  const page = await (await userContext(browser, 'alice')).newPage()
  await openProject(page, pid)
  const dialog = await openSettings(page, 'Account')
  await dialog.locator('input[data-setting="name"]').fill('Alice A. Admin')
  await dialog.getByRole('button', { name: 'Save', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).__folio.useAuth.getState().me.name)).toBe('Alice A. Admin')
  await expect(dialog.getByRole('textbox', { name: 'Email' })).toBeDisabled()

  await dialog.getByLabel('Current password').fill('wrong-password')
  await dialog.getByLabel('New password', { exact: true }).fill('folio-pass-456')
  await dialog.getByLabel('Confirm new password').fill('folio-pass-456')
  await dialog.getByRole('button', { name: 'Change password' }).click()
  await expect(dialog.locator('.set-form__error')).toBeVisible()
  // the password did not change: the session still works
  const api = await apiAs('alice')
  expect((await api.get('/api/auth/me')).status()).toBe(200)
  await api.dispose()
  await page.context().close()
})

test('the keyboard shortcuts list matches the editor’s keys', async ({ browser }) => {
  const page = await (await userContext(browser, 'alice')).newPage()
  await openProject(page, pid)
  await page.getByRole('navigation', { name: 'Side panels' }).getByRole('button', { name: 'Help' }).click()
  await page.getByRole('menuitem', { name: 'Keyboard shortcuts' }).click()
  const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
  await dialog.getByRole('textbox', { name: 'Filter shortcuts' }).fill('line')
  const row = (label: string) => dialog.locator('.keys-item', { has: page.locator('.keys-item__label', { hasText: label }) })
  await expect(row('Delete line').locator('.ui-kbd-group').first()).toHaveAttribute('aria-label', /^(Ctrl|⌘)[+ ]?D$/i)
  await dialog.getByRole('textbox', { name: 'Filter shortcuts' }).fill('occurrence')
  await expect(row('Select the next occurrence').locator('.ui-kbd-group').first()).toHaveAttribute('aria-label', /Shift/i)
  await page.keyboard.press('Escape')
  await page.context().close()
})
