/**
 * The Share modal on a throw-away project: a viewer sees a read-only member list; the owner gets
 * inline errors for unknown or invalid emails, changes a member's role (applied live in the
 * member's open project and modal), turns link sharing on, copies and regenerates a link,
 * removes a member (who loses access live), sees someone join by link live, turns link sharing
 * off; a member leaves the project from the modal.
 */
import { expect, type Page } from '@playwright/test'
import { apiAs, e2eState, json, newProject, openProject, removeProject, shot, test, userContext } from './helpers'

let pid: string
let a: Page
let c: Page

test.beforeAll(async () => {
  pid = await newProject('E2E Share')
})
test.afterAll(async () => {
  if (pid) await removeProject(pid)
})

async function shareInfo(): Promise<{ members: { user: { email: string }; role: string }[]; links: { editor: string | null; viewer: string | null } | null }> {
  const api = await apiAs('alice')
  try {
    return await json(await api.get(`/api/projects/${pid}/share`))
  } finally {
    await api.dispose()
  }
}
const roleOf = async (email: string) => (await shareInfo()).members.find(m => m.user.email === email)?.role ?? null

test('owner and members in the Share modal: errors, live role change, links, remove, join, leave', async ({ browser }) => {
  const st = e2eState()
  const actx = await userContext(browser, 'alice')
  await actx.grantPermissions(['clipboard-read', 'clipboard-write'])
  a = await actx.newPage()
  c = await (await userContext(browser, 'carol')).newPage()
  const b = await (await userContext(browser, 'bob')).newPage()
  await openProject(a, pid)
  await openProject(c, pid)
  await openProject(b, pid)

  // carol (viewer): read-only list, "Leave project" on her own row, no link section
  await c.getByRole('button', { name: 'Share', exact: true }).click()
  const carolModal = c.getByRole('dialog', { name: 'Share project' })
  await expect(carolModal.getByText('Only the owner, Alice Admin, can add people')).toBeVisible()
  await expect(carolModal.getByLabel('Email addresses')).toHaveCount(0)
  await expect(carolModal.getByRole('button', { name: /Access for/ })).toHaveCount(0)
  await expect(carolModal.getByRole('button', { name: 'Leave project' })).toBeVisible()
  await expect(carolModal.getByText('Link sharing')).toHaveCount(0)

  // alice (owner): unknown and invalid emails are reported inline
  await a.getByRole('button', { name: 'Share', exact: true }).click()
  const modal = a.getByRole('dialog', { name: 'Share project' })
  const email = modal.getByLabel('Email addresses')
  await email.fill('nobody@example.com')
  await modal.getByRole('button', { name: 'Invite' }).click()
  await expect(modal.locator('.share-invite__error')).toHaveText('No Folio account with this email — ask an admin to create one')
  await email.fill('not-an-email')
  await modal.getByRole('button', { name: 'Invite' }).click()
  await expect(modal.locator('.share-invite__error')).toContainText('isn’t a valid email address')
  await email.fill('')

  // carol viewer → editor: her client and her open modal follow without a reload
  await modal.getByRole('button', { name: 'Access for Carol Viewer: Can view' }).click()
  await a.getByRole('menuitemradio', { name: /Can edit/ }).click()
  await expect(modal.getByRole('button', { name: 'Access for Carol Viewer: Can edit' })).toBeVisible()
  expect(await roleOf(st.users.carol.email)).toBe('editor')
  await c.waitForFunction(() => (window as any).__folio.useProject.getState().role === 'editor', undefined, { timeout: 15_000 })
  await expect(carolModal.locator(`li[data-user-email="${st.users.carol.email}"]`)).toContainText('Can edit')

  // link sharing: full URLs matching the server's tokens; copy; regenerate invalidates the old one
  await modal.getByRole('switch', { name: 'Turn on link sharing' }).click()
  const viewUrl = modal.getByRole('textbox', { name: 'View-only link', exact: true })
  const editUrl = modal.getByRole('textbox', { name: 'Edit link', exact: true })
  await expect(viewUrl).toHaveValue(new RegExp(`^${st.base}/join/`))
  const links = (await shareInfo()).links!
  expect(await viewUrl.inputValue()).toBe(`${st.base}/join/${links.viewer}`)
  expect(await editUrl.inputValue()).toBe(`${st.base}/join/${links.editor}`)
  await modal.getByRole('button', { name: 'Copy view-only link' }).click()
  await expect(modal.getByRole('button', { name: 'Copy view-only link' })).toHaveText(/Copied/)
  expect(await a.evaluate(() => navigator.clipboard.readText())).toBe(await viewUrl.inputValue())
  await shot(a, 'share-links')
  const oldToken = links.viewer!
  await modal.getByRole('button', { name: 'Create a new view-only link' }).click()
  await a.getByRole('dialog', { name: 'Create a new view-only link?' }).getByRole('button', { name: 'Create new link' }).click()
  await expect(viewUrl).not.toHaveValue(`${st.base}/join/${oldToken}`)
  const api = await apiAs('alice')
  expect((await api.get(`/api/share/${oldToken}`)).status()).toBe(404)
  await api.dispose()

  // removing bob closes his project; he joins again with the view-only link and shows up live
  await modal.getByRole('button', { name: 'Access for Bob Editor: Can edit' }).click()
  await a.getByRole('menuitem', { name: 'Remove access' }).click()
  await a.getByRole('dialog', { name: 'Remove Bob Editor?' }).getByRole('button', { name: 'Remove access' }).click()
  await expect(modal.locator(`li[data-user-email="${st.users.bob.email}"]`)).toHaveCount(0)
  await b.waitForFunction(() => (window as any).__folio.useProject.getState().loadState === 'error', undefined, { timeout: 15_000 })
  await b.goto((await viewUrl.inputValue()).replace(st.base, ''))
  await expect(b.getByText('You’ll join as a viewer')).toBeVisible()
  await b.getByRole('button', { name: 'Join project' }).click()
  await expect(b).toHaveURL(new RegExp(`/project/${pid}$`))
  await expect(modal.getByRole('button', { name: 'Access for Bob Editor: Can view' })).toBeVisible()
  expect(await roleOf(st.users.bob.email)).toBe('viewer')

  // link sharing off removes both links
  await modal.getByRole('switch', { name: 'Turn off link sharing' }).click()
  await a.getByRole('dialog', { name: 'Turn off link sharing?' }).getByRole('button', { name: 'Turn off' }).click()
  await expect(viewUrl).toHaveCount(0)
  expect((await shareInfo()).links ?? { editor: null, viewer: null }).toMatchObject({ editor: null, viewer: null })

  // carol leaves from her own row: back on the dashboard, gone from alice's list
  await carolModal.getByRole('button', { name: 'Leave project' }).click()
  await c.getByRole('dialog', { name: 'Leave this project?' }).getByRole('button', { name: 'Leave project' }).click()
  await c.waitForURL(u => new URL(u).pathname === '/', { timeout: 15_000 })
  await expect(modal.locator(`li[data-user-email="${st.users.carol.email}"]`)).toHaveCount(0)
  expect(await roleOf(st.users.carol.email)).toBeNull()

  for (const p of [a, b, c]) await p.context().close()
})
