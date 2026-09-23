import { describe, expect, it } from 'vitest'
import { MSG_AWARENESS } from '@folio/shared/protocol'
import { docClient, makeEnv, rawSocket, sleep, waitFor } from './helpers.ts'

const MAIN = '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n'
const isKeepalive = (m: Uint8Array) => m.length === 3 && m[0] === MSG_AWARENESS && m[1] === 1 && m[2] === 0

describe('keepalive and heartbeat', () => {
  it('sends empty awareness keepalive frames on doc and meta rooms', async () => {
    const env = await makeEnv()
    try {
      const f = env.createTextFile('main.tex', MAIN)
      env.startCollab({ keepaliveMs: 50 })
      env.startMeta({ keepaliveMs: 50 })
      const doc = rawSocket(env, `/ws/doc/${env.projectId}/${f.id}?epoch=0&u=${env.users.victor.id}`)
      const meta = rawSocket(env, `/ws/project/${env.projectId}?u=${env.users.victor.id}`)
      await doc.opened
      await meta.opened
      await waitFor(() => doc.messages.filter(isKeepalive).length >= 3, 3000, 'doc keepalives')
      await waitFor(() => meta.messages.filter(isKeepalive).length >= 3, 3000, 'meta keepalives')
    } finally {
      await env.cleanup()
    }
  })

  it('terminates sockets that stop answering pings and keeps responsive ones', async () => {
    const env = await makeEnv()
    try {
      const f = env.createTextFile('main.tex', MAIN)
      const collab = env.startCollab({ pingMs: 100 })
      const url = `/ws/doc/${env.projectId}/${f.id}?epoch=0&u=${env.users.alice.id}`
      const dead = rawSocket(env, url, { autoPong: false })
      const alive = rawSocket(env, url)
      await dead.opened
      await alive.opened
      const code = await Promise.race([dead.closed, sleep(3000).then(() => -1)])
      expect(code).not.toBe(-1)
      await sleep(400)
      expect(alive.ws.readyState).toBe(alive.ws.OPEN)
      expect(collab.stats().rooms[0].connections).toBe(1)
    } finally {
      await env.cleanup()
    }
  })

  // y-websocket 3.1.0 drops a connection after 30 s without any incoming message. A viewer that
  // publishes no awareness state receives nothing but the server keepalive.
  const idleRun = async (keepaliveMs: number) => {
    const env = await makeEnv()
    try {
      const f = env.createTextFile('main.tex', MAIN)
      env.startCollab({ keepaliveMs })
      const v = docClient(env, f, env.users.victor, { connect: false })
      v.provider.awareness.setLocalState(null)
      v.provider.connect()
      await v.synced()
      await sleep(45_000)
      return v.statuses.filter(s => s === 'connected').length
    } finally {
      await env.cleanup()
    }
  }

  it.concurrent('keeps a single idle connection alive for 45 s (KEEPALIVE_MS)', async () => {
    expect(await idleRun(10_000)).toBe(1)
  }, 75_000)

  it.concurrent('control: without the keepalive the idle client reconnects', async () => {
    expect(await idleRun(0)).toBeGreaterThanOrEqual(2)
  }, 75_000)
})
