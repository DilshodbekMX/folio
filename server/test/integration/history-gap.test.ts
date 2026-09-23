/**
 * An edit typed right after a snapshot is never lost to history, across the real collab and
 * history services (the verifier's "history gap"): collab reports activity at most once per
 * second per file and user, and an edit inside that window used to go unreported for good when
 * nobody typed afterwards — no idle snapshot followed, and a delete more than 5 s later trusted
 * "nothing noted since the last snapshot" and removed the file without a 'Before deleting'
 * version, although the edit (synced, so nobody kept a copy) was only on disk.
 *
 * Now the throttle reports such an edit at the end of its window (trailing edge), and the
 * pre-delete shortcut also requires collab's own edit counter to be unchanged.
 */
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { afterEach, describe, expect, it } from 'vitest'
import type { FileEntry, HistoryListResponse, HistoryVersion } from '@folio/shared/api'
import { DOC_TEXT_KEY } from '@folio/shared/protocol'
import { createSession } from '../../src/auth/sessions.ts'
import type { UserRecord } from '../../src/db/index.ts'
import { Client } from '../foundation/helpers.ts'
import { startFullServer, type FullServer, type FullServerOptions } from './harness.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

interface World {
  t: FullServer
  alice: UserRecord
  bob: UserRecord
  A: Client
  pid: string
  file: FileEntry
  live: { text: Y.Text; destroy(): void }
}

let world: World | null = null
afterEach(async () => {
  world?.live.destroy()
  await world?.t.close()
  world = null
})

/** A project owned by alice with `gap.tex`, bob (editor) typing in it through a real y-websocket client. */
async function setup(opts: FullServerOptions = {}): Promise<World> {
  const t = await startFullServer({}, opts)
  const alice = await t.makeUser('alice@example.com', 'Alice Admin')
  const bob = await t.makeUser('bob@example.com', 'Bob Editor')
  const A = Client.as(t, alice)
  const created = await A.post('/api/projects', { name: 'Gap', template: 'blank' })
  expect(created.status).toBe(201)
  const pid = created.body.id as string
  t.services.db.members.upsert(pid, bob.id, 'editor')
  const made = await A.post(`/api/projects/${pid}/files`, { path: 'gap.tex', kind: 'text', content: 'Gap start.\n' })
  expect(made.status).toBe(201)
  const file = made.body as FileEntry

  const token = createSession(t.services.db, t.services.config, bob.id).token
  const doc = new Y.Doc()
  const provider = new WebsocketProvider(`${t.base.replace('http', 'ws')}/ws/doc/${pid}`, file.id, doc, {
    WebSocketPolyfill: class extends WebSocket {
      constructor(url: string, protocols?: string | string[]) {
        super(url, protocols, { headers: { cookie: `folio_session=${token}`, origin: t.base } })
      }
    } as unknown as typeof globalThis.WebSocket,
    disableBc: true,
    params: { epoch: String(file.epoch) },
  })
  for (let i = 0; i < 300 && !provider.synced; i++) await sleep(10)
  expect(provider.synced).toBe(true)
  const live = { text: doc.getText(DOC_TEXT_KEY), destroy: () => { provider.destroy(); doc.destroy() } }
  world = { t, alice, bob, A, pid, file, live }
  return world
}

/** Bob types `s` at the end; resolves once the server's copy has it. */
async function type(w: World, s: string): Promise<void> {
  w.live.text.insert(w.live.text.length, s)
  for (let i = 0; i < 500; i++) {
    if ((await w.t.services.collab.getText(w.pid, w.file.id)).includes(s)) return
    await sleep(5)
  }
  throw new Error(`the server never got ${JSON.stringify(s)}`)
}

async function versions(w: World): Promise<HistoryVersion[]> {
  return (await w.A.get<HistoryListResponse>(`/api/projects/${w.pid}/history/versions`)).body.versions
}

async function textAt(w: World, versionId: string): Promise<string | null> {
  const buf = await w.t.services.history.fileAt(w.pid, versionId, 'gap.tex')
  return buf ? buf.toString('utf8') : null
}

async function manualSnapshot(w: World): Promise<void> {
  expect((await w.A.post(`/api/projects/${w.pid}/history/snapshot`)).status).toBe(200)
}

describe('history after a snapshot', () => {
  it('an edit right after a snapshot, then silence: an idle snapshot still captures it', async () => {
    const w = await setup({ history: { idleMs: 300 } })
    await type(w, 'X1-noted\n')       // first edit of the window: reported at once
    await manualSnapshot(w)            // takes the pending window (like the 5-min cap, a label, a restore…)
    await type(w, 'X2-after-snapshot\n') // inside the 1 s throttle window of X1's report — then nobody types
    let newest: { v: HistoryVersion; text: string | null } | null = null
    for (let i = 0; i < 200; i++) {
      const [v] = await versions(w)
      const text = await textAt(w, v.id)
      if (text?.includes('X2-after-snapshot')) {
        newest = { v, text }
        break
      }
      await sleep(50)
    }
    expect(newest, 'no version ever held X2').not.toBeNull()
    expect(newest!.v.reason).toBe('auto')
    expect(newest!.v.authors.map(a => a.id)).toContain(w.bob.id)
    expect(newest!.text).toBe('Gap start.\nX1-noted\nX2-after-snapshot\n')
  })

  it('the verifier’s case: X1, snapshot, X2 within 1 s, delete 6.5 s later → “Before deleting” holds X2', async () => {
    const w = await setup()
    await type(w, 'X1-noted\n')
    await manualSnapshot(w)
    await type(w, 'X2-after-snapshot\n')
    await sleep(6500)
    expect((await w.A.del(`/api/projects/${w.pid}/files/${w.file.id}`)).status).toBe(200)
    const [pre] = await versions(w)
    expect(pre).toMatchObject({ reason: 'file-op', summary: 'Before deleting gap.tex' })
    expect(await textAt(w, pre.id)).toBe('Gap start.\nX1-noted\nX2-after-snapshot\n')
    expect(w.t.services.files.getByPath(w.pid, 'gap.tex')).toBeNull()
  }, 30_000)

  it('the pre-delete shortcut also trusts collab’s edit counter, not only the (throttled) activity reports', async () => {
    // a throttle window far longer than the test: X2's report is still pending at the delete
    const w = await setup({ collab: { activityThrottleMs: 60_000 }, history: { unnotedEditSlackMs: 0 } })
    await type(w, 'X1-noted\n')
    await manualSnapshot(w)
    await type(w, 'X2-report-pending\n')
    await sleep(20)
    expect((await w.A.del(`/api/projects/${w.pid}/files/${w.file.id}`)).status).toBe(200)
    const [pre] = await versions(w)
    expect(pre).toMatchObject({ reason: 'file-op', summary: 'Before deleting gap.tex' })
    expect(await textAt(w, pre.id)).toBe('Gap start.\nX1-noted\nX2-report-pending\n')
  })

  it('nothing typed since the snapshot: the delete adds no version (the shortcut still applies)', async () => {
    const w = await setup({ history: { unnotedEditSlackMs: 0 } })
    await type(w, 'X1\n')
    await sleep(1100) // X1's throttle window is over: nothing is scheduled any more
    await manualSnapshot(w)
    const before = (await versions(w)).length
    await sleep(20)
    expect((await w.A.del(`/api/projects/${w.pid}/files/${w.file.id}`)).status).toBe(200)
    expect((await versions(w)).length).toBe(before)
  })
})
