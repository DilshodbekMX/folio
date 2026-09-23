/**
 * Test servers never pick up a developer's settings: scripts/e2e-server.mjs (the server under
 * test, and every startServer() instance) runs the server and the CLI tools with
 * FOLIO_ENV_FILE=none and without PUBLIC_ORIGIN — whatever env file or PUBLIC_ORIGIN the
 * environment it was started from names. Otherwise a `.env` with ALLOW_SIGNUP, another compile
 * image or a PUBLIC_ORIGIN (which makes the browser's own origin "cross-origin") would change what
 * the suite tests, or break it.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { expect } from '@playwright/test'
import { apiAs, json, login, startServer, test } from './helpers'

test('an extra server ignores the env file and the PUBLIC_ORIGIN of the environment it starts from', async ({ browser }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-e2e-env-'))
  const envFile = path.join(dir, 'developer.env')
  fs.writeFileSync(envFile, [
    'ALLOW_SIGNUP=true',
    'PUBLIC_ORIGIN=https://folio.invalid',
    'COMPILE_IMAGE=folio-e2e/not-an-image:never',
    'SESSION_TTL_DAYS=1',
    '',
  ].join('\n'))
  const srv = await startServer({ env: { FOLIO_ENV_FILE: envFile, PUBLIC_ORIGIN: 'https://folio.invalid', LOG_LEVEL: 'info' } })
  try {
    // the server's start line names the env file it read: none
    const startLine = fs.readFileSync(path.join(srv.dataDir, 'server.log'), 'utf8').split('\n')
      .map(l => { try { return JSON.parse(l) as Record<string, unknown> } catch { return null } })
      .find(l => !!l && 'envFile' in l)
    expect(startLine, 'JSON start line in server.log').toBeTruthy()
    expect(startLine!.envFile).toBeNull()

    // ALLOW_SIGNUP from the file is not applied
    const anon = await apiAs(null, srv.base)
    expect((await json<{ allowSignup: boolean }>(await anon.get('/api/auth/setup-status'))).allowSignup).toBe(false)
    await anon.dispose()

    // PUBLIC_ORIGIN is not applied: a browser on http://127.0.0.1:<port> logs in (its origin
    // would be refused as cross-origin otherwise) and gets a normal, 30-day session cookie
    const ctx = await browser.newContext({ baseURL: srv.base })
    const page = await ctx.newPage()
    await page.goto('/login')
    await login(page, srv.state.users.alice.email, srv.state.password)
    await expect(page).toHaveURL(`${srv.base}/`)
    await expect(page.getByRole('link', { name: 'Example', exact: true })).toBeVisible()
    const cookie = (await ctx.cookies()).find(c => c.name === 'folio_session')!
    expect(cookie.secure).toBe(false)
    expect(cookie.expires - Date.now() / 1000).toBeGreaterThan(20 * 86_400)

    // nor the compile image
    const system = await page.evaluate(() => fetch('/api/system').then(r => r.json()))
    expect(system.compileImage).not.toBe('folio-e2e/not-an-image:never')
    await ctx.close()
  } finally {
    await srv.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
