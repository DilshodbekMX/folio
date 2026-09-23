/**
 * Cross-module: FileService.move vs. collab's debounced saves. A save that commits between the
 * disk rename and the db update used to re-create the file at its OLD path (collab repaired it
 * only within pathCheckMs). The move now renames and updates the db in one synchronous block, so
 * right after every move the old path is gone and the new path holds the live text — even with a
 * client typing continuously and saves firing every few milliseconds.
 *
 * To make the old race reproducible (its window was a few hundred µs), `fs.promises.lstat` — used
 * only by FileService's symlink checks / directory preparation, never by collab saves — is slowed
 * down while a move runs: every await inside the move then gives pending saves time to commit.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { DOC_TEXT_KEY } from '@folio/shared/protocol'
import { createCollabService, type CollabServiceImpl } from '../../src/collab/index.ts'
import { createSession } from '../../src/auth/sessions.ts'
import type { UserRecord } from '../../src/db/index.ts'
import { Client, makeUser, startTestServer, type TestServer } from '../foundation/helpers.ts'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('move while a document is being edited', () => {
  let t: TestServer
  let alice: UserRecord
  let collab: CollabServiceImpl
  let pid: string

  const realLstat = fsp.lstat
  let slowFs = false

  beforeAll(async () => {
    ;(fsp as { lstat: typeof fsp.lstat }).lstat = (async (...args: Parameters<typeof fsp.lstat>) => {
      if (slowFs) await sleep(15)
      return realLstat(...args)
    }) as typeof fsp.lstat
    t = await startTestServer()
    // the real collab service saving every ~10 ms (production: 2 s idle / 10 s max) with the
    // periodic path repair OFF, so nothing but the move itself can keep the paths consistent
    collab = createCollabService(t.services, { logger: quiet, saveDebounceMs: 5, saveMaxWaitMs: 10, pathCheckMs: 0 })
    t.services.collab = collab
    alice = await makeUser(t.services, 'alice@example.com', 'Alice')
    pid = (await Client.as(t, alice).post('/api/projects', { name: 'Race', template: 'blank' })).body.id
  })
  afterAll(async () => {
    ;(fsp as { lstat: typeof fsp.lstat }).lstat = realLstat
    await collab.shutdown()
    await t.close()
  })

  it('never leaves a copy at the old path and keeps the live text', async () => {
    const A = Client.as(t, alice)
    const created = await A.post(`/api/projects/${pid}/files`, { path: 'chapter.tex', kind: 'text', content: 'start\n' })
    expect(created.status).toBe(201)
    const fileId = created.body.id as string
    const token = createSession(t.services.db, t.services.config, alice.id).token
    const doc = new Y.Doc()
    const provider = new WebsocketProvider(`${t.base.replace('http', 'ws')}/ws/doc/${pid}`, fileId, doc, {
      WebSocketPolyfill: class extends WebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols, { headers: { cookie: `folio_session=${token}`, origin: t.base } })
        }
      } as unknown as typeof globalThis.WebSocket,
      disableBc: true,
      params: { epoch: '0' },
    })
    const ytext = doc.getText(DOC_TEXT_KEY)
    try {
      for (let i = 0; i < 200 && !provider.synced; i++) await sleep(10)

      expect(provider.synced).toBe(true)
      let typing = true
      const typist = (async () => {
        let n = 0
        while (typing) {
          ytext.insert(ytext.length, `${n++} `)
          await sleep(2)
        }
      })()
      const root = t.services.files.projectDir(pid)
      let current = 'chapter.tex'
      for (let i = 0; i < 16; i++) {
        const next = i % 2 === 0 ? `dir${i}/sub/chapter.tex` : `chapter-${i}.tex`
        slowFs = true
        const r = await A.patch(`/api/projects/${pid}/files/${fileId}`, { path: next })
        slowFs = false
        expect(r.status).toBe(200)
        // checked synchronously right after the move: no save may have re-created the old file
        expect(fs.existsSync(path.join(root, current)), `left behind at ${current}`).toBe(false)
        current = next
        await sleep(3 + (i % 7))
      }
      typing = false
      await typist
      await collab.flushProject(pid)
      expect(fs.readFileSync(path.join(root, current), 'utf8')).toBe(ytext.toString())
      expect(t.services.files.get(pid, fileId)!.path).toBe(current)
      // exactly one copy of the document on disk
      const all = fs.readdirSync(root, { recursive: true }).map(String).filter(p => p.endsWith('.tex') && p !== 'main.tex')
      expect(all).toEqual([current])
    } finally {
      provider.destroy()
      doc.destroy()
    }
  })
})
