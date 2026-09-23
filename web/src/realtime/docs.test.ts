/**
 * realtime/docs.ts against a real collab server (the server's in-process test harness), with
 * real y-websocket clients in Node (ACC-16). What protects offline edits:
 * - edits made while the socket is down are "pending" until the server confirmed them (a
 *   barrier sent after the reconnect's sync), then they are on the server;
 * - a session closed for good (4410: the file was deleted meanwhile) with pending edits hands
 *   its whole text to the kept-text store, owned by the session's user;
 * - signing out destroys every session — never drains it: a logout while offline (SEC2-1)
 *   drops the edits (the user agreed), any other end of the session keeps them for that user;
 *   nothing reaches the server after the sign-out.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileEntry, Me } from '@folio/shared/api'
import { WS_CLOSE } from '@folio/shared/protocol'

// server-side modules are loaded at run time: the web typecheck must not pull Node sources in
const HELPERS = new URL('../../../server/test/collab/helpers.ts', import.meta.url).pathname
const WS_MODULE: string = 'ws'
/* eslint-disable @typescript-eslint/no-explicit-any */
type Harness = {
  makeEnv(o: { withMeta: boolean }): Promise<any>
  waitFor(cond: () => boolean | Promise<boolean>, timeoutMs?: number, what?: string): Promise<void>
  sleep(ms: number): Promise<void>
}
let h: Harness
let WS: any

const MAIN = '\\documentclass{article}\n\\begin{document}\nHello.\n\\end{document}\n'

let env: any
let uid = ''
let session: Map<string, string>
let fetchUp = false
/** the browser's network state (navigator.onLine + the 'online'/'offline' events) */
let online = true
/**
 * A blip the socket survives: like a browser, the stubbed WebSocket holds everything written
 * during it (frames *and* the close) and delivers it in order once it is over.
 */
let buffering = false
let buffered: (() => void)[] = []

// modules under test (loaded once the browser globals are stubbed)
let docs: typeof import('./docs')
let auth: typeof import('../stores/auth')
let project: typeof import('../stores/project')
let recovered: typeof import('./recoveredStore')

beforeAll(async () => {
  h = (await import(/* @vite-ignore */ HELPERS)) as Harness
  WS = (await import(/* @vite-ignore */ WS_MODULE)).default
})

beforeEach(async () => {
  env = await h.makeEnv({ withMeta: false })
  env.startCollab()
  uid = env.users.alice.id
  session = new Map()
  vi.stubGlobal('location', { protocol: 'http:', host: `127.0.0.1:${env.port}` })
  online = true
  buffering = false
  buffered = []
  vi.stubGlobal('window', new EventTarget())
  vi.stubGlobal('navigator', Object.defineProperty({}, 'onLine', { get: () => online }))
  // the harness picks the socket's user from ?u= (the real server reads the session cookie)
  vi.stubGlobal('WebSocket', class extends WS {
    constructor(url: string, protocols?: string | string[]) {
      super(`${url}${url.includes('?') ? '&' : '?'}u=${encodeURIComponent(uid)}`, protocols)
    }

    send(...args: unknown[]): void {
      if (buffering) buffered.push(() => super.send(...args))
      else super.send(...args)
    }

    close(...args: unknown[]): void {
      // a browser sends the close frame behind whatever is still queued, not instead of it
      if (buffering) buffered.push(() => super.close(...args))
      else super.close(...args)
    }
  })
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => session.get(k) ?? null,
    setItem: (k: string, v: string) => void session.set(k, v),
    removeItem: (k: string) => void session.delete(k),
  })
  fetchUp = false
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (!fetchUp) throw new TypeError('fetch failed')
    if (String(url).startsWith('/api/auth/logout')) return new Response(null, { status: 204 })
    return new Response('{}', { status: 401 })
  }))
  vi.resetModules()
  // the app is one bundle: its modules finish evaluating before any queueMicrotask(wire…) runs.
  // Vitest evaluates imports one await at a time, so hold those back until all are loaded.
  const deferred: (() => void)[] = []
  const realQueue = globalThis.queueMicrotask
  globalThis.queueMicrotask = fn => void deferred.push(fn)
  try {
    auth = await import('../stores/auth')
    project = await import('../stores/project')
    docs = await import('./docs')
    recovered = await import('./recoveredStore')
  } finally {
    globalThis.queueMicrotask = realQueue
  }
  for (const fn of deferred) fn()
})

afterEach(async () => {
  for (const s of docs.docSessions.list()) s.destroy()
  await env.cleanup()
  vi.unstubAllGlobals()
})

afterAll(() => {
  vi.resetModules()
})

function signIn(user: { id: string; email: string; name: string }): void {
  uid = user.id
  auth.useAuth.setState({ status: 'authenticated', me: { ...user, color: '#2255aa', isAdmin: false, settings: {} } as unknown as Me })
}

function openProject(files: FileEntry[]): void {
  project.useProject.setState({
    projectId: env.projectId, loadState: 'ready', role: 'editor',
    files: Object.fromEntries(files.map(f => [f.id, f])),
  })
}

/**
 * A network outage the sockets survive: the browser reports it (navigator.onLine + 'offline'),
 * the server keeps the connections, and everything written meanwhile is buffered. Returns the
 * function that ends it: what was buffered is delivered, in order, as a browser would.
 */
function blip(): () => void {
  buffering = true
  online = false
  window.dispatchEvent(new Event('offline'))
  return () => {
    buffering = false
    online = true
    for (const send of buffered.splice(0)) send()
    window.dispatchEvent(new Event('online'))
  }
}

/** The server refuses new sockets and the current one drops (a network outage). */
function cut(s: import('./docs').DocSession): () => void {
  const collab = env.collab
  env.collab = null
  s.provider.ws?.close()
  return () => {
    env.collab = collab
  }
}

async function editOffline(text: string) {
  const f: FileEntry = env.createTextFile('main.tex', MAIN)
  signIn(env.users.alice)
  openProject([f])
  const s = docs.docSessions.acquire(env.projectId, f)
  await s.synced
  expect(s.ytext.toString()).toBe(MAIN)
  const restore = cut(s)
  await h.waitFor(() => s.status !== 'connected', 5000, 'socket down')
  s.ytext.insert(0, text)
  expect(s.hasPendingChanges()).toBe(true)
  return { f, s, restore }
}

describe('offline edits', () => {
  it('stay pending while the socket is down, and are on the server once confirmed after the reconnect', async () => {
    const collab = env.collab
    const { f, s, restore } = await editOffline('% typed offline\n')
    expect(docs.useDocSync.getState().unsynced).toEqual([{ fileId: f.id, projectId: env.projectId }])
    // released while pending: kept (draining), never destroyed before the server has the edits
    docs.docSessions.release(s)
    expect(docs.docSessions.list()).toContain(s)
    restore()
    await h.waitFor(() => !s.hasPendingChanges(), 15_000, 'edits confirmed')
    expect(await collab.getText(env.projectId, f.id)).toBe(`% typed offline\n${MAIN}`)
    expect(docs.useDocSync.getState().pending).toEqual([])
  })

  it('a document deleted meanwhile (4410) hands its whole text to the kept texts, owned by the user', async () => {
    const { f, s, restore } = await editOffline('% my offline draft\n')
    env.db.files.delete(f.id)
    restore()
    await h.waitFor(() => s.closeCode === WS_CLOSE.GONE, 15_000, 'closed as gone')
    const items = recovered.useRecovered.getState().items
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ userId: env.users.alice.id, fileId: f.id, text: `% my offline draft\n${MAIN}`, code: WS_CLOSE.GONE, offline: true })
    docs.docSessions.release(s)
  })
})

describe('signing out destroys the sessions (never drains them)', () => {
  it('a logout while offline drops the unsent edits: nothing reaches the server afterwards', async () => {
    const collab = env.collab
    const { f, s, restore } = await editOffline('% never sent\n')
    docs.docSessions.release(s)
    await auth.useAuth.getState().logout()
    expect(auth.useAuth.getState()).toMatchObject({ status: 'anonymous', logoutPending: true })
    expect(docs.docSessions.list()).toEqual([])
    expect(docs.useDocSync.getState().pending).toEqual([])
    expect(recovered.useRecovered.getState().items).toEqual([])
    restore()
    await h.sleep(3500)
    expect(await collab.getText(env.projectId, f.id)).toBe(MAIN)
  })

  /**
   * The SEC2-1 residual: during a blip the socket survives, so a write does not fail — the
   * browser keeps it and flushes it when the network returns, behind a close frame that does not
   * cancel it. Folio must therefore stop writing as soon as the browser reports no network:
   * without that, the edit below reaches the server when the blip ends, under the session the
   * logout is only about to revoke.
   */
  it('a logout during a blip the socket survives sends nothing either (buffered writes)', async () => {
    const collab = env.collab
    const f: FileEntry = env.createTextFile('main.tex', MAIN)
    signIn(env.users.alice)
    openProject([f])
    const s = docs.docSessions.acquire(env.projectId, f)
    await s.synced
    const restore = blip()
    // the socket is still open on both sides; Folio stopped writing to it the moment the browser
    // reported the outage (without that, the insert below goes into the browser's send buffer)
    const statusDuringBlip = s.status
    s.ytext.insert(0, '% typed during the blip\n')
    expect(s.hasPendingChanges()).toBe(true)
    docs.docSessions.release(s)

    await auth.useAuth.getState().logout()
    expect(auth.useAuth.getState()).toMatchObject({ status: 'anonymous', logoutPending: true })
    expect(docs.docSessions.list()).toEqual([])
    // the network is back: everything the browser had buffered is delivered now
    restore()
    await h.sleep(3500)
    expect(await collab.getText(env.projectId, f.id)).toBe(MAIN)
    expect(statusDuringBlip).not.toBe('connected')
  })

  it('a session that ended otherwise keeps the text for that user; another user signing in never gets it', async () => {
    const collab = env.collab
    const { f, restore } = await editOffline('% kept for alice\n')
    // the session expired: a request is answered 401
    fetchUp = true
    const { api } = await import('../api/endpoints')
    await expect(api.listProjects()).rejects.toMatchObject({ status: 401 })
    expect(auth.useAuth.getState().status).toBe('anonymous')
    expect(docs.docSessions.list()).toEqual([])
    const items = recovered.useRecovered.getState().items
    expect(items.map(i => [i.userId, i.text])).toEqual([[env.users.alice.id, `% kept for alice\n${MAIN}`]])
    restore()
    signIn(env.users.bob)
    expect(recovered.ownRecovered(recovered.useRecovered.getState().items)).toEqual([])
    // Bob opens the same file: a fresh session of his, without Alice's edit
    const b = docs.docSessions.acquire(env.projectId, f)
    await b.synced
    expect(b.userId).toBe(env.users.bob.id)
    expect(b.ytext.toString()).toBe(MAIN)
    await h.sleep(500)
    expect(await collab.getText(env.projectId, f.id)).toBe(MAIN)
    docs.docSessions.release(b)
  })
})
