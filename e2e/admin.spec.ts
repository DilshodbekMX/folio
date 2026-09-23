/**
 * The admin page: reached from the dashboard's account menu; the users table (admin badge,
 * owned project counts, own account not deletable); creating a user (validation, duplicate email,
 * generated password, sign-in details) who can then sign in; deleting that user together with the
 * projects they own; non-administrators do not get the page.
 */
import { expect, request } from '@playwright/test'
import { apiAs, authFile, e2eState, json, shot, test } from './helpers'

test.use({ storageState: authFile('alice') })

test('create a user, who signs in; delete them with their project', async ({ page }) => {
  const st = e2eState()
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await page.goto('/')
  await page.getByRole('button', { name: /Account menu for/ }).click()
  await page.getByRole('menuitem', { name: 'Admin' }).click()
  await expect(page).toHaveURL(/\/admin$/)
  const table = page.locator('table.adm-table')
  const api = await apiAs('alice')
  const users = await json<{ email: string; projectCount: number }[]>(await api.get('/api/admin/users'))
  await expect(table.locator('tbody tr')).toHaveCount(users.length)
  const aliceRow = table.locator(`tr[data-user-email="${st.users.alice.email}"]`)
  await expect(aliceRow.locator('.adm-badge')).toHaveText('Admin')
  await expect(aliceRow.locator('.adm-count')).toHaveText(String(users.find(u => u.email === st.users.alice.email)!.projectCount))
  await expect(aliceRow.getByLabel('You can’t delete your own account')).toBeVisible()
  await expect(page.locator('.adm-system')).toBeVisible()
  await shot(page, 'admin-users')

  // create: required fields, duplicate email and short password are refused
  await page.getByRole('button', { name: 'New user' }).click()
  const dialog = page.getByRole('dialog', { name: 'New user' })
  await dialog.getByRole('button', { name: 'Create user' }).click()
  await expect(dialog.getByText('Enter the person’s name.')).toBeVisible()
  await dialog.locator('input[data-field="name"]').fill('Erin Example')
  await dialog.locator('input[data-field="email"]').fill(st.users.bob.email)
  await dialog.locator('input[data-field="password"]').fill('short')
  await dialog.getByRole('button', { name: 'Create user' }).click()
  await expect(dialog.getByText('Use at least 8 characters.')).toBeVisible()
  await dialog.locator('input[data-field="password"]').fill('long enough password')
  await dialog.getByRole('button', { name: 'Create user' }).click()
  await expect(dialog.getByText('An account with this email already exists.')).toBeVisible()
  const erinEmail = `erin-${Date.now()}@example.com`
  await dialog.locator('input[data-field="email"]').fill(erinEmail)
  await dialog.getByRole('button', { name: 'Generate' }).click()
  const password = await dialog.locator('input[data-field="password"]').inputValue()
  expect(password).toHaveLength(16)
  await dialog.getByRole('button', { name: 'Create user' }).click()
  const created = page.getByRole('dialog', { name: 'Account created' })
  const creds = (await created.locator('.adm-created__creds').textContent())!
  expect(creds).toContain(erinEmail)
  expect(creds).toContain(password)
  expect(creds).toContain(st.base)
  await created.getByRole('button', { name: 'Copy sign-in details' }).click()
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(creds)
  await created.getByRole('button', { name: 'Done' }).click()
  const erinRow = table.locator(`tr[data-user-email="${erinEmail}"]`)
  await expect(erinRow).toBeVisible()

  // the new account signs in and creates a project
  // an empty storage state: inside a test, request contexts default to the test's (alice's) cookies,
  // and logging in with a session cookie ends that session
  const erin = await request.newContext({ baseURL: st.base, storageState: { cookies: [], origins: [] }, extraHTTPHeaders: { 'X-Folio-Csrf': '1', Origin: st.base } })
  await json(await erin.post('/api/auth/login', { data: { email: erinEmail, password } }))
  const project = await json<{ id: string }>(await erin.post('/api/projects', { data: { name: 'Erin’s thesis', template: 'blank' } }))
  await page.reload()
  await expect(erinRow.locator('.adm-count')).toHaveText('1')

  // search, then delete: the confirmation names the owned project, which goes too
  await page.getByRole('textbox', { name: 'Search users' }).fill(erinEmail)
  await expect(table.locator('tbody tr')).toHaveCount(1)
  await erinRow.getByRole('button', { name: 'Delete Erin Example' }).click()
  const confirm = page.getByRole('dialog', { name: 'Delete Erin Example?' })
  await confirm.getByRole('button', { name: 'Delete user and 1 project' }).click()
  await expect(erinRow).toHaveCount(0)
  expect((await json<{ email: string }[]>(await api.get('/api/admin/users'))).some(u => u.email === erinEmail)).toBe(false)
  expect((await api.get(`/api/projects/${project.id}`)).status()).toBe(404)
  expect((await erin.get('/api/auth/me')).status()).toBe(401)
  await erin.dispose()
  await api.dispose()
})

test('non-administrators do not get the admin page', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: authFile('bob') })
  const page = await ctx.newPage()
  await page.goto('/admin')
  await page.waitForFunction(() => (window as any).__folio?.useAuth?.getState().status === 'authenticated')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.locator('table.adm-table')).toHaveCount(0)
  await page.goto('/')
  await page.getByRole('button', { name: /Account menu for/ }).click()
  await expect(page.getByRole('menuitem', { name: 'Log out' })).toBeVisible()
  await expect(page.getByRole('menuitem', { name: 'Admin' })).toHaveCount(0)
  const api = await apiAs('bob')
  expect((await api.get('/api/admin/users')).status()).toBe(403)
  await api.dispose()
  await ctx.close()
})
