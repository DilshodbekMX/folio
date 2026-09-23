/**
 * Dashboard project lifecycle through the UI (owner): create a blank project, rename it, copy it,
 * move it to the trash, restore it, delete it forever — each step checked against the API.
 * Then search, archive / unarchive and download .zip as the owner, and "Shared with you",
 * trash and leave as a member.
 */
import fs from 'node:fs'
import { expect, type Page } from '@playwright/test'
import { apiAs, authFile, e2eState, json, newProject, noAutoCompile, openProject, removeProject, shot, test } from './helpers'

test.use({ storageState: authFile('alice') })

const row = (page: Page, name: string) => page.locator('tr.dash-row', { has: page.getByRole('link', { name, exact: true }) })

async function projectsByName(name: string) {
  const api = await apiAs('alice')
  try {
    return (await json<{ id: string; name: string; trashed: boolean }[]>(await api.get('/api/projects'))).filter(p => p.name === name)
  } finally {
    await api.dispose()
  }
}

test('create, rename, copy, trash, restore and delete a project', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('link', { name: 'Example', exact: true })).toBeVisible()
  await shot(page, 'dashboard-light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await shot(page, 'dashboard-dark')
  await page.emulateMedia({ colorScheme: 'light' })

  // create
  await page.getByRole('button', { name: 'New project' }).first().click()
  await page.getByRole('menuitem', { name: /Blank project/ }).click()
  const dialog = page.getByRole('dialog', { name: 'New blank project' })
  await dialog.getByLabel('Project name').fill('E2E Lifecycle')
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(page).toHaveURL(/\/project\/[A-Za-z0-9_-]{16}$/)
  const pid = page.url().split('/').pop()!
  await openProject(page, pid)
  expect((await projectsByName('E2E Lifecycle')).map(p => p.id)).toEqual([pid])

  // rename (row menu)
  await page.goto('/')
  await row(page, 'E2E Lifecycle').getByRole('button', { name: 'More actions' }).click()
  await page.getByRole('menuitem', { name: 'Rename…' }).click()
  const rename = page.getByRole('dialog', { name: 'Rename project' })
  await rename.getByLabel('New name').fill('E2E Renamed')
  await rename.getByRole('button', { name: 'Rename' }).click()
  await expect(row(page, 'E2E Renamed')).toBeVisible()
  await expect.poll(async () => (await projectsByName('E2E Renamed')).length).toBe(1)

  // copy (row icon)
  await row(page, 'E2E Renamed').getByRole('button', { name: 'Make a copy' }).click()
  const copy = page.getByRole('dialog', { name: 'Copy project' })
  await expect(copy.getByLabel('New name')).toHaveValue('E2E Renamed (Copy)')
  await copy.getByRole('button', { name: 'Copy' }).click()
  await expect(row(page, 'E2E Renamed (Copy)')).toBeVisible()
  const copies = await projectsByName('E2E Renamed (Copy)')
  expect(copies).toHaveLength(1)
  expect(copies[0].id).not.toBe(pid)

  // trash → gone from "All projects", listed under "Trashed projects"
  await row(page, 'E2E Renamed').getByRole('button', { name: 'Move to trash' }).click()
  await page.getByRole('dialog', { name: 'Trash project' }).getByRole('button', { name: 'Move to trash' }).click()
  await expect(row(page, 'E2E Renamed')).toHaveCount(0)
  await expect.poll(async () => (await projectsByName('E2E Renamed'))[0]?.trashed).toBe(true)
  await page.getByRole('button', { name: /Trashed projects/ }).click()
  await expect(row(page, 'E2E Renamed')).toBeVisible()
  await shot(page, 'dashboard-trash')

  // restore
  await row(page, 'E2E Renamed').getByRole('button', { name: 'Restore' }).click()
  await expect(row(page, 'E2E Renamed')).toHaveCount(0)
  await expect.poll(async () => (await projectsByName('E2E Renamed'))[0]?.trashed).toBe(false)

  // trash again and delete forever
  await page.getByRole('button', { name: /All projects/ }).click()
  await row(page, 'E2E Renamed').getByRole('button', { name: 'Move to trash' }).click()
  await page.getByRole('dialog', { name: 'Trash project' }).getByRole('button', { name: 'Move to trash' }).click()
  await page.getByRole('button', { name: /Trashed projects/ }).click()
  await row(page, 'E2E Renamed').getByRole('button', { name: 'Delete forever' }).click()
  const confirm = page.getByRole('dialog')
  await confirm.getByRole('button', { name: 'Delete forever' }).click()
  await expect(row(page, 'E2E Renamed')).toHaveCount(0)
  await expect.poll(async () => (await projectsByName('E2E Renamed')).length).toBe(0)
  const api = await apiAs('alice')
  expect((await api.get(`/api/projects/${pid}`)).status()).toBe(404)
  // the copy is independent and still there
  expect((await api.get(`/api/projects/${copies[0].id}`)).status()).toBe(200)
  await api.delete(`/api/projects/${copies[0].id}`)
  await api.dispose()
})

test('search, archive and download as the owner; a member finds it shared, trashes it and leaves', async ({ page, browser }) => {
  const name = `E2E Dash Shared ${Date.now().toString(36)}`
  const pid = await newProject(name)
  try {
    await page.goto('/')
    await page.getByRole('textbox', { name: 'Search in all projects' }).fill(name)
    await expect(page.locator('tr.dash-row')).toHaveCount(1)
    await expect(row(page, name)).toBeVisible()

    const [zip] = await Promise.all([page.waitForEvent('download'), row(page, name).getByRole('button', { name: 'Download .zip' }).click()])
    expect(zip.suggestedFilename()).toBe(`${name}.zip`)
    expect(fs.readFileSync(await zip.path()).subarray(0, 2).toString()).toBe('PK')

    // archive: gone from "All projects", listed under "Archived projects", back after Unarchive
    await row(page, name).getByRole('button', { name: 'Archive' }).click()
    await page.getByRole('dialog', { name: 'Archive project' }).getByRole('button', { name: 'Archive' }).click()
    await expect(row(page, name)).toHaveCount(0)
    await page.getByRole('button', { name: /Archived projects/ }).click()
    await expect(row(page, name)).toBeVisible()
    await row(page, name).getByRole('button', { name: 'Unarchive' }).click()
    await expect(row(page, name)).toHaveCount(0)
    await page.getByRole('button', { name: /All projects/ }).click()
    await expect(row(page, name)).toBeVisible()

    // bob: under "Shared with you" with the owner's name; trash, then leave from the trash
    const ctx = await browser.newContext({ storageState: authFile('bob'), acceptDownloads: true })
    await noAutoCompile(ctx)
    const pb = await ctx.newPage()
    await pb.goto('/')
    await pb.getByRole('button', { name: /Shared with you/ }).click()
    await expect(row(pb, name).locator('.dash-owner__name')).toHaveText('Alice Admin')
    await row(pb, name).getByRole('button', { name: 'Move to trash' }).click()
    await pb.getByRole('dialog', { name: 'Trash project' }).getByRole('button', { name: 'Move to trash' }).click()
    await expect(row(pb, name)).toHaveCount(0)
    await pb.getByRole('button', { name: /Trashed projects/ }).click()
    await row(pb, name).getByRole('button', { name: 'Leave project' }).click()
    await pb.getByRole('dialog', { name: 'Leave project' }).getByRole('button', { name: 'Leave' }).click()
    await expect(row(pb, name)).toHaveCount(0)
    const api = await apiAs('alice')
    const share = await json<{ members: { user: { email: string } }[] }>(await api.get(`/api/projects/${pid}/share`))
    expect(share.members.map(m => m.user.email)).not.toContain(e2eState().users.bob.email)
    await api.dispose()
    // the owner still has it, untouched
    await page.reload()
    await expect(row(page, name)).toBeVisible()
    await ctx.close()
  } finally {
    await removeProject(pid)
  }
})
