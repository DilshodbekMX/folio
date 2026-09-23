/**
 * First run on an empty server: every route leads to /setup, the form validates, the first
 * account becomes the administrator and lands on an empty dashboard; afterwards /setup is gone.
 */
import { expect, test } from '@playwright/test'
import { apiAs, json, shot, startServer, type ExtraServer } from './helpers'

let srv: ExtraServer

test.beforeAll(async () => {
  srv = await startServer({ empty: true })
})
test.afterAll(async () => {
  await srv?.stop()
})

test('first-run setup creates the administrator', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: srv.base })
  const page = await ctx.newPage()
  const api = await apiAs(null, srv.base)
  expect(await json(await api.get('/api/auth/setup-status'))).toMatchObject({ needsSetup: true })

  await page.goto('/project/doesnotexist0000')
  await expect(page).toHaveURL(/\/setup$/)
  await expect(page.getByRole('heading', { name: 'Set up Folio' })).toBeVisible()
  await shot(page, 'setup-empty')

  // client-side validation
  await page.getByLabel('Your name').fill('Ada Admin')
  await page.getByLabel('Email', { exact: true }).fill('ada.example.com')
  await page.getByLabel('Password', { exact: true }).fill('short')
  await page.getByLabel('Confirm password').fill('different')
  await page.getByRole('button', { name: 'Create administrator account' }).click()
  await expect(page.getByText('Enter a valid email address, like name@example.com.')).toBeVisible()
  await expect(page.getByText('Use at least 8 characters.')).toBeVisible()
  await expect(page.getByText('The passwords don’t match.')).toBeVisible()
  expect(await json(await api.get('/api/auth/setup-status'))).toMatchObject({ needsSetup: true })

  await page.getByLabel('Email', { exact: true }).fill('ada@example.com')
  await page.getByLabel('Password', { exact: true }).fill('correct horse battery')
  await page.getByLabel('Confirm password').fill('correct horse battery')
  await page.getByRole('button', { name: 'Create administrator account' }).click()
  await expect(page).toHaveURL(`${srv.base}/`)
  await expect(page.getByText('No projects yet')).toBeVisible()
  await shot(page, 'setup-done-dashboard')

  const me = await page.evaluate(() => fetch('/api/auth/me').then(r => r.json()))
  expect(me).toMatchObject({ email: 'ada@example.com', name: 'Ada Admin', isAdmin: true })
  expect(await json(await api.get('/api/auth/setup-status'))).toMatchObject({ needsSetup: false })

  // setup is closed now: the page redirects, and the API refuses a second administrator
  await page.goto('/setup')
  await expect(page).toHaveURL(`${srv.base}/`)
  const again = await api.post('/api/auth/setup', { data: { email: 'eve@example.com', name: 'Eve', password: 'correct horse battery' } })
  expect(again.status()).toBe(403)
  await ctx.close()
  await api.dispose()
})
