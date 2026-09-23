/**
 * One account cannot exhaust the server's sockets (file descriptors, memory) for everybody:
 * beyond the per-user cap a WebSocket is accepted and closed with 1013 "try again later", other
 * users still connect, and a closed socket frees its slot.
 */
import WebSocket from 'ws'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createSession } from '../../src/auth/sessions.ts'
import { createUpgradeHandler } from '../../src/http/upgrade.ts'
import { startFullServer, type FullServer } from './harness.ts'

const CAP = 4

interface Opened {
  ws: WebSocket
  /** resolves with the close code */
  closed: Promise<number>
  /** resolves true once the socket is open */
  opened: Promise<boolean>
}

function connect(t: FullServer, path: string, cookie: string): Opened {
  const ws = new WebSocket(t.base.replace(/^http/, 'ws') + path, { headers: { cookie, origin: t.base } })
  const opened = new Promise<boolean>(resolve => {
    ws.once('open', () => resolve(true))
    ws.once('error', () => resolve(false))
  })
  const closed = new Promise<number>(resolve => ws.once('close', code => resolve(code)))
  return { ws, opened, closed }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('WebSockets per account', () => {
  let t: FullServer
  let pid: string
  let aliceCookie: string
  let bobCookie: string
  const all: Opened[] = []

  beforeAll(async () => {
    t = await startFullServer()
    t.server.removeAllListeners('upgrade')
    t.server.on('upgrade', createUpgradeHandler(t.services, { maxSocketsPerUser: CAP }))
    const alice = await t.makeUser('alice@example.com', 'Alice')
    const bob = await t.makeUser('bob@example.com', 'Bob')
    pid = t.services.db.projects.create({ name: 'Sockets', ownerId: alice.id }).id
    t.services.db.members.upsert(pid, bob.id, 'viewer')
    aliceCookie = `folio_session=${createSession(t.services.db, t.services.config, alice.id).token}`
    bobCookie = `folio_session=${createSession(t.services.db, t.services.config, bob.id).token}`
  })
  afterAll(async () => {
    for (const o of all) o.ws.terminate()
    await t.close()
  })

  it('refuses the socket beyond the cap with 1013, keeps the others, and frees slots on close', async () => {
    const mine: Opened[] = []
    for (let i = 0; i < CAP; i++) mine.push(connect(t, `/ws/project/${pid}`, aliceCookie))
    all.push(...mine)
    expect(await Promise.all(mine.map(o => o.opened))).toEqual(Array(CAP).fill(true))

    const extra = connect(t, `/ws/project/${pid}`, aliceCookie)
    all.push(extra)
    expect(await extra.closed).toBe(1013)
    // the accepted ones are untouched
    await sleep(100)
    expect(mine.every(o => o.ws.readyState === WebSocket.OPEN)).toBe(true)

    // another account is not affected
    const other = connect(t, `/ws/project/${pid}`, bobCookie)
    all.push(other)
    expect(await other.opened).toBe(true)
    await sleep(100)
    expect(other.ws.readyState).toBe(WebSocket.OPEN)

    // closing one frees a slot
    mine[0].ws.close()
    await mine[0].closed
    await sleep(100)
    const again = connect(t, `/ws/project/${pid}`, aliceCookie)
    all.push(again)
    expect(await again.opened).toBe(true)
    await sleep(100)
    expect(again.ws.readyState).toBe(WebSocket.OPEN)
  })
})
