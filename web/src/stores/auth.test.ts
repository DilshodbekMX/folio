/**
 * SEC2-1: a logout the server never received must not leave this browser signed in. The store
 * signs out locally at once, records the logout, never uses the old session again (init() ends
 * it first), retries when the browser is back online, and a login settles it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Me } from '@folio/shared/api'

type Handler = (method: string, path: string) => Response | 'down'

const BOB: Me = {
  id: 'u-bob', email: 'bob@example.com', name: 'Bob Editor', color: '#2255aa', isAdmin: false,
  settings: {} as Me['settings'],
} as Me
const CAROL: Me = { ...BOB, id: 'u-carol', email: 'carol@example.com', name: 'Carol Viewer' }

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const noContent = () => new Response(null, { status: 204 })
const unauthorized = () => json({ error: { code: 'unauthorized', message: 'Not signed in' } }, 401)

let calls: string[] = []
let handler: Handler = () => 'down'
let win: EventTarget

function installBrowser(stored: Record<string, string> = {}): Map<string, string> {
  const data = new Map(Object.entries(stored))
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() { return data.size },
  })
  win = new EventTarget()
  vi.stubGlobal('window', win)
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET'
    const path = String(url).split('?')[0]
    calls.push(`${method} ${path}`)
    const res = handler(method, path)
    if (res === 'down') throw new TypeError('fetch failed')
    return res
  }))
  return data
}

/** The server as seen through fetch: `session` is the user the browser's cookie belongs to. */
function server(state: { session: Me | null; up: boolean }): Handler {
  return (method, path) => {
    if (!state.up) return 'down'
    if (path === '/api/auth/setup-status') return json({ needsSetup: false, allowSignup: false, version: 'test' })
    if (path === '/api/auth/me') return state.session ? json(state.session) : unauthorized()
    if (path === '/api/auth/logout') {
      state.session = null
      return noContent()
    }
    if (path === '/api/auth/login') {
      state.session = CAROL
      return json(CAROL)
    }
    if (path === '/api/projects') return state.session ? json([]) : unauthorized()
    return json({ error: { code: 'not_found', message: 'nope' } }, 404)
  }
}

async function loadAuth() {
  vi.resetModules()
  return import('./auth')
}

beforeEach(() => {
  calls = []
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('logout while the server cannot be reached', () => {
  it('signs out here at once, never signs in with the old session, and ends it once back online', async () => {
    const state = { session: BOB as Me | null, up: true }
    handler = server(state)
    const storage = installBrowser()
    const { useAuth, onSignOut, LOGOUT_PENDING_KEY } = await loadAuth()
    await useAuth.getState().init()
    expect(useAuth.getState().status).toBe('authenticated')
    const signOuts: unknown[] = []
    onSignOut(info => signOuts.push(info))

    // offline: the POST cannot reach the server, the session cookie stays valid there
    state.up = false
    await useAuth.getState().logout()
    expect(useAuth.getState()).toMatchObject({ status: 'anonymous', me: null, logoutPending: true })
    expect(signOuts).toEqual([{ userId: 'u-bob', reason: 'logout' }])
    expect(storage.has(LOGOUT_PENDING_KEY)).toBe(true)
    expect(state.session).toBe(BOB)

    // a re-check (e.g. a socket closed with 4401) or a reload while still offline: stays signed out
    calls = []
    await useAuth.getState().init()
    expect(useAuth.getState().status).toBe('anonymous')
    expect(calls).not.toContain('GET /api/auth/me')

    // the network is back: the pending logout goes out first and settles
    state.up = true
    calls = []
    win.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(useAuth.getState().logoutPending).toBe(false))
    expect(calls[0]).toBe('POST /api/auth/logout')
    expect(state.session).toBeNull()
    expect(storage.has(LOGOUT_PENDING_KEY)).toBe(false)
  })

  it('keeps retrying with a timer when no "online" event comes (a server restart)', async () => {
    vi.useFakeTimers()
    const state = { session: BOB as Me | null, up: true }
    handler = server(state)
    installBrowser()
    const { useAuth } = await loadAuth()
    await useAuth.getState().init()
    state.up = false
    await useAuth.getState().logout()
    expect(useAuth.getState().logoutPending).toBe(true)
    state.up = true
    await vi.advanceTimersByTimeAsync(2500)
    expect(useAuth.getState().logoutPending).toBe(false)
    expect(state.session).toBeNull()
  })

  it('a later start of the app ends the recorded session before asking who is signed in', async () => {
    const state = { session: BOB as Me | null, up: true }
    handler = server(state)
    const storage = installBrowser({ 'folio:logout-pending': '1' })
    const { useAuth } = await loadAuth()
    expect(useAuth.getState().logoutPending).toBe(true)
    await useAuth.getState().init()
    expect(calls[0]).toBe('POST /api/auth/logout')
    expect(useAuth.getState()).toMatchObject({ status: 'anonymous', me: null, logoutPending: false })
    expect(state.session).toBeNull()
    expect(storage.has('folio:logout-pending')).toBe(false)
  })

  it('a start of the app that still cannot end it stays signed out and keeps trying', async () => {
    const state = { session: BOB as Me | null, up: false }
    handler = server(state)
    installBrowser({ 'folio:logout-pending': '1' })
    const { useAuth } = await loadAuth()
    await useAuth.getState().init()
    expect(useAuth.getState()).toMatchObject({ status: 'anonymous', me: null, logoutPending: true })
    expect(calls).not.toContain('GET /api/auth/me')
    state.up = true
    win.dispatchEvent(new Event('online'))
    await vi.waitFor(() => expect(useAuth.getState().logoutPending).toBe(false))
    expect(state.session).toBeNull()
  })

  it('logging in while it is pending ends the old session first, then clears the record', async () => {
    const state = { session: BOB as Me | null, up: true }
    handler = server(state)
    const storage = installBrowser({ 'folio:logout-pending': '1' })
    const { useAuth } = await loadAuth()
    await useAuth.getState().login('carol@example.com', 'pw')
    expect(calls.slice(0, 2)).toEqual(['POST /api/auth/logout', 'POST /api/auth/login'])
    expect(useAuth.getState()).toMatchObject({ status: 'authenticated', logoutPending: false })
    expect(useAuth.getState().me?.id).toBe('u-carol')
    expect(storage.has('folio:logout-pending')).toBe(false)
  })

  it('a successful logout settles at once', async () => {
    const state = { session: BOB as Me | null, up: true }
    handler = server(state)
    const storage = installBrowser()
    const { useAuth } = await loadAuth()
    await useAuth.getState().init()
    await useAuth.getState().logout()
    expect(useAuth.getState()).toMatchObject({ status: 'anonymous', logoutPending: false })
    expect(state.session).toBeNull()
    expect(storage.size).toBe(1) // only the remembered theme
  })
})

describe('other ends of a session', () => {
  it('another tab logging out signs this tab out too (reason "ended")', async () => {
    const state = { session: BOB as Me | null, up: true }
    handler = server(state)
    installBrowser()
    const { useAuth, onSignOut, LOGOUT_PENDING_KEY } = await loadAuth()
    await useAuth.getState().init()
    const signOuts: unknown[] = []
    onSignOut(info => signOuts.push(info))
    win.dispatchEvent(Object.assign(new Event('storage'), { key: LOGOUT_PENDING_KEY, newValue: '1' }))
    expect(useAuth.getState()).toMatchObject({ status: 'anonymous', me: null, logoutPending: true })
    expect(signOuts).toEqual([{ userId: 'u-bob', reason: 'ended' }])
    win.dispatchEvent(Object.assign(new Event('storage'), { key: LOGOUT_PENDING_KEY, newValue: null }))
    expect(useAuth.getState().logoutPending).toBe(false)
  })

  it('a request answered 401 ends the local session (reason "ended")', async () => {
    const state = { session: BOB as Me | null, up: true }
    handler = server(state)
    installBrowser()
    const { useAuth, onSignOut } = await loadAuth()
    const { api } = await import('../api/endpoints')
    await useAuth.getState().init()
    const signOuts: unknown[] = []
    onSignOut(info => signOuts.push(info))
    state.session = null
    await expect(api.listProjects()).rejects.toMatchObject({ status: 401 })
    expect(useAuth.getState().status).toBe('anonymous')
    expect(signOuts).toEqual([{ userId: 'u-bob', reason: 'ended' }])
  })

  it('another account found on a re-check: the previous one is signed out first', async () => {
    const state = { session: BOB as Me | null, up: true }
    handler = server(state)
    installBrowser()
    const { useAuth, onSignOut } = await loadAuth()
    await useAuth.getState().init()
    const signOuts: unknown[] = []
    onSignOut(info => signOuts.push({ ...info, meDuring: useAuth.getState().me?.id }))
    state.session = CAROL
    await useAuth.getState().init()
    expect(useAuth.getState().me?.id).toBe('u-carol')
    expect(signOuts).toEqual([{ userId: 'u-bob', reason: 'ended', meDuring: 'u-bob' }])
  })
})
