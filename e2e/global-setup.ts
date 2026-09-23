/**
 * Global setup: log every seeded user in through the API once and save their storage states
 * (e2e/.auth/<user>.json), so specs start authenticated with `test.use({ storageState: authFile('bob') })`
 * or helpers.userContext(browser, 'bob'). Also copies the server's state file to e2e/.auth/state.json.
 * A saved state that is still signed in on this server is reused: logins are rate limited
 * (20 per 15 minutes per IP), and re-running specs against a kept server must not use them up.
 */
import fs from 'node:fs'
import { request, type FullConfig } from '@playwright/test'
import { AUTH_DIR, authFile, e2eState, STATE_COPY } from './helpers'

async function stillSignedIn(base: string, file: string, email: string): Promise<boolean> {
  if (!fs.existsSync(file)) return false
  const ctx = await request.newContext({ baseURL: base, storageState: file })
  try {
    const res = await ctx.get('/api/auth/me')
    return res.ok() && (await res.json()).email === email
  } catch {
    return false
  } finally {
    await ctx.dispose()
  }
}

export default async function globalSetup(_config: FullConfig): Promise<void> {
  const state = e2eState()
  fs.mkdirSync(AUTH_DIR, { recursive: true })
  fs.writeFileSync(STATE_COPY, JSON.stringify(state, null, 2))
  for (const [key, user] of Object.entries(state.users)) {
    if (await stillSignedIn(state.base, authFile(key), user.email)) continue
    const ctx = await request.newContext({ baseURL: state.base })
    try {
      const res = await ctx.post('/api/auth/login', {
        headers: { 'X-Folio-Csrf': '1', Origin: state.base },
        data: { email: user.email, password: state.password },
      })
      if (!res.ok()) throw new Error(`global-setup: login as ${user.email} failed: ${res.status()} ${await res.text()}`)
      await ctx.storageState({ path: authFile(key) })
    } finally {
      await ctx.dispose()
    }
  }
}
