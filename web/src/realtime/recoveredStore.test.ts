/**
 * REG-4: text kept from a user's closed documents is that user's alone — never shown to, or
 * prompted about for, another account signed in later in the same tab; a logout discards it,
 * any other end of the session keeps it (hidden) for that user.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Me } from '@folio/shared/api'

const KEY = 'folio:recovered:v1'
const me = (id: string): Me => ({ id, email: `${id}@example.com`, name: id, color: '#2255aa', isAdmin: false, settings: {} } as unknown as Me)

function item(userId: string | undefined, extra: Record<string, unknown> = {}) {
  return {
    id: `k-${userId}-${Math.random().toString(36).slice(2, 8)}`, ...(userId ? { userId } : {}),
    projectId: 'p1', projectName: 'Example', fileId: 'f1', epoch: 1, path: 'secret.tex',
    text: `draft of ${userId}`, code: 4410, offline: true, by: null, at: 1, savedAs: null, ...extra,
  }
}

let session: Map<string, string>

async function load(stored: unknown[] = []) {
  session = new Map(stored.length ? [[KEY, JSON.stringify(stored)]] : [])
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  })
  vi.resetModules()
  const auth = await import('../stores/auth')
  const store = await import('./recoveredStore')
  return { ...auth, ...store }
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('kept texts per user', () => {
  it('drops stored entries without an owner (older format)', async () => {
    const m = await load([item(undefined), item('alice')])
    expect(m.useRecovered.getState().items.map(i => i.userId)).toEqual(['alice'])
  })

  it('shows, and asks about, only the signed-in user’s entries', async () => {
    const m = await load([item('alice'), item('bob', { savedAs: { fileId: 'f2', path: 'secret (recovered).tex' } })])
    m.useAuth.setState({ status: 'authenticated', me: me('bob') })
    expect(m.ownRecovered(m.useRecovered.getState().items).map(i => i.userId)).toEqual(['bob'])
    // Bob's own entry is saved; Alice's unsaved one is not his to be asked about
    expect(m.hasUnsavedRecovered()).toBe(false)
    m.useAuth.setState({ me: me('alice') })
    expect(m.ownRecovered(m.useRecovered.getState().items).map(i => i.userId)).toEqual(['alice'])
    expect(m.hasUnsavedRecovered()).toBe(true)
  })

  it('nobody signed in: nothing is shown, the last user is still asked before the tab closes', async () => {
    const m = await load([item('alice')])
    expect(m.ownRecovered(m.useRecovered.getState().items)).toEqual([])
    expect(m.hasUnsavedRecovered()).toBe(false)
    m.useAuth.setState({ status: 'authenticated', me: me('alice') })
    m.useAuth.setState({ status: 'anonymous', me: null })
    expect(m.hasUnsavedRecovered()).toBe(true)
  })

  it('a logout discards that user’s entries (memory and sessionStorage), not other users’', async () => {
    const m = await load([item('alice'), item('carol')])
    m.useAuth.setState({ status: 'authenticated', me: me('alice') })
    await m.useAuth.getState().logout()
    expect(m.useRecovered.getState().items.map(i => i.userId)).toEqual(['carol'])
    expect(session.get(KEY) ?? '').not.toContain('draft of alice')
    expect(m.hasUnsavedRecovered()).toBe(false)
  })

  it('a session that ended otherwise keeps them for that user only', async () => {
    const m = await load([item('alice')])
    m.useAuth.setState({ status: 'authenticated', me: me('alice') })
    // the server answers 401 to a request: the session expired
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    const { api } = await import('../api/endpoints')
    await expect(api.listProjects()).rejects.toMatchObject({ status: 401 })
    expect(m.useAuth.getState().status).toBe('anonymous')
    expect(m.useRecovered.getState().items.map(i => i.userId)).toEqual(['alice'])
    m.useAuth.setState({ status: 'authenticated', me: me('bob') })
    expect(m.ownRecovered(m.useRecovered.getState().items)).toEqual([])
    expect(m.hasUnsavedRecovered()).toBe(false)
  })
})
