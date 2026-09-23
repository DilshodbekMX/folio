/**
 * Project chat between two members of a throw-away project: sending with Enter (links and
 * `code` formatted), the unread badge on the rail of a member whose chat is closed, cleared when
 * the chat opens with a "new messages" divider, a multi-line reply (Shift+Enter) received live,
 * and the 5000-character limit.
 */
import { expect } from '@playwright/test'
import { apiAs, json, netSwitch, newProject, openProject, removeProject, shot, test, userContext } from './helpers'

let pid: string
test.beforeAll(async () => {
  pid = await newProject('E2E Chat')
})
test.afterAll(async () => {
  if (pid) await removeProject(pid)
})

test('messages, unread badge, divider, multi-line replies, length limit', async ({ browser }) => {
  const a = await (await userContext(browser, 'alice')).newPage()
  const b = await (await userContext(browser, 'bob')).newPage()
  await openProject(a, pid)
  await openProject(b, pid)
  const unread = (p: typeof a) => p.evaluate(() => (window as any).__folio.useLayout.getState().unreadChat as number)

  const aRail = a.getByRole('navigation', { name: 'Side panels' })
  const bRail = b.getByRole('navigation', { name: 'Side panels' })
  await aRail.getByRole('button', { name: 'Chat' }).click()
  const aChat = a.locator('section.chat')
  await expect(aChat.getByText('No messages yet')).toBeVisible()
  const input = aChat.getByRole('textbox', { name: 'Message' })
  await expect(input).toBeFocused()
  await input.fill('Hi Bob! The draft is at https://example.com/paper.pdf (see `\\section{Results}`).')
  await input.press('Enter')
  const mine = aChat.locator('.chat-group--mine .chat-msg').last()
  await expect(mine).toBeVisible()
  await expect(input).toHaveValue('')
  await expect(mine.locator('a.chat-link')).toHaveAttribute('href', 'https://example.com/paper.pdf')
  await expect(mine.locator('a.chat-link')).toHaveAttribute('rel', /noopener/)
  await expect(mine.locator('code.chat-code')).toHaveText('\\section{Results}')

  // bob's chat is closed: the rail counts the messages
  await expect.poll(() => unread(b)).toBe(1)
  await expect(bRail.getByRole('button', { name: 'Chat' }).locator('.ui-iconbtn__badge')).toHaveText('1')
  for (const text of ['Could you check the method section?', 'Thanks!']) {
    await input.fill(text)
    await input.press('Enter')
  }
  await expect.poll(() => unread(b)).toBe(3)
  await expect(bRail.getByRole('button', { name: 'Chat' }).locator('.ui-iconbtn__badge')).toHaveText('3')
  expect(await unread(a)).toBe(0) // the sender has the chat open
  await shot(b, 'chat-unread-badge')

  // opening the chat clears the badge and marks where the new messages start
  await bRail.getByRole('button', { name: 'Chat' }).click()
  const bChat = b.locator('section.chat')
  await expect.poll(() => unread(b)).toBe(0)
  await expect(bRail.locator('.ui-iconbtn__badge')).toHaveCount(0)
  await expect(bChat.locator('.chat-sep--unread')).toBeVisible()
  await expect(bChat.locator('.chat-group').last().locator('.chat-group__name')).toHaveText('Alice Admin')
  await expect(bChat.locator('.chat-group').last().locator('.chat-msg')).toHaveCount(3)

  // a two-line reply arrives live and keeps its line break
  const bInput = bChat.getByRole('textbox', { name: 'Message' })
  await bInput.click()
  await bInput.pressSequentially('Sure, looking now.')
  await bInput.press('Shift+Enter')
  await bInput.pressSequentially('Line two.')
  await expect(bInput).toHaveValue('Sure, looking now.\nLine two.')
  await bInput.press('Enter')
  const reply = aChat.locator('.chat-group:not(.chat-group--mine) .chat-msg__text').last()
  await expect(reply).toHaveText('Sure, looking now.\nLine two.', { useInnerText: true })
  expect(await unread(a)).toBe(0)

  // over 5000 characters cannot be sent
  await bInput.fill('x'.repeat(5001))
  await expect(bChat.getByText('1 characters over the limit')).toBeVisible()
  await expect(bChat.getByRole('button', { name: 'Send message' })).toBeDisabled()
  await bInput.fill('')
  await a.context().close()
  await b.context().close()
})

test('messages and builds from while the connection was down are caught up when it is back', async ({ browser }) => {
  const ctx = await userContext(browser, 'bob')
  const net = await netSwitch(ctx)
  const b = await ctx.newPage()
  await openProject(b, pid)
  const unread = () => b.evaluate(() => (window as any).__folio.useLayout.getState().unreadChat as number)
  expect(await unread()).toBe(0)

  net.down()
  await b.waitForFunction(() => (window as any).__folio.useProject.getState().connection !== 'connected', undefined, { timeout: 15_000 })
  const api = await apiAs('alice')
  for (const content of ['Posted while you were away.', 'And another one.']) await json(await api.post(`/api/projects/${pid}/chat`, { data: { content } }))
  const build = await json<{ buildId: string; status: string }>(await api.post(`/api/projects/${pid}/compile`, { data: {}, timeout: 120_000 }))
  expect(build.status).toBe('success')
  await api.dispose()
  expect(await unread()).toBe(0)

  net.up()
  await b.waitForFunction(() => (window as any).__folio.useProject.getState().connection === 'connected', undefined, { timeout: 30_000 })
  await expect.poll(unread, { timeout: 15_000 }).toBe(2)
  await expect.poll(() => b.evaluate(() => (window as any).__folio.useCompile.getState().last?.buildId ?? null), { timeout: 15_000 }).toBe(build.buildId)
  await ctx.close()
})
