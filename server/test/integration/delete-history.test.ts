/**
 * Deleting (or overwriting) a file keeps what it held restorable from history, across the real
 * FileService, CollabService and git history: edits made within the 30 s idle window — by
 * setText, by a live editor whose text the server has not saved to disk yet, or uploads — are
 * committed (reason 'file-op') before the file goes. A project restore that removes files (the
 * history lock is held while FileService runs) and a delete racing it both complete.
 */
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FileEntry, HistoryListResponse, HistoryVersion } from '@folio/shared/api'
import { DOC_TEXT_KEY } from '@folio/shared/protocol'
import { createSession } from '../../src/auth/sessions.ts'
import { toPublic, type UserRecord } from '../../src/db/index.ts'
import { Client, formWith } from '../foundation/helpers.ts'
import { startFullServer, type FullServer } from './harness.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('history keeps what a delete removes', () => {
  let t: FullServer
  let alice: UserRecord
  let A: Client

  beforeAll(async () => {
    t = await startFullServer()
    alice = await t.makeUser('alice@example.com', 'Alice Admin')
    A = Client.as(t, alice)
  })
  afterAll(async () => {
    await t.close()
  })

  async function newProject(name: string): Promise<string> {
    const r = await A.post('/api/projects', { name, template: 'blank' })
    expect(r.status).toBe(201)
    return r.body.id as string
  }

  async function createFile(pid: string, p: string, content: string): Promise<FileEntry> {
    const r = await A.post(`/api/projects/${pid}/files`, { path: p, kind: 'text', content })
    expect(r.status).toBe(201)
    return r.body as FileEntry
  }

  async function versions(pid: string): Promise<HistoryVersion[]> {
    return (await A.get<HistoryListResponse>(`/api/projects/${pid}/history/versions`)).body.versions
  }

  async function atVersion(pid: string, versionId: string, p: string): Promise<string | null> {
    const buf = await t.services.history.fileAt(pid, versionId, p)
    return buf ? buf.toString('utf8') : null
  }

  it('a file edited (setText) and deleted within the idle window: its last text is in history', async () => {
    const pid = await newProject('Delete after edit')
    const b = await createFile(pid, 'b.tex', 'first draft\n')
    await t.services.collab.setText(pid, b.id, 'the edited text, never snapshotted\n', { userId: alice.id, reason: 'test' })
    const before = (await versions(pid)).length

    expect((await A.del(`/api/projects/${pid}/files/${b.id}`)).status).toBe(200)

    const after = await versions(pid)
    expect(after.length).toBe(before + 1)
    const pre = after[0]
    expect(pre).toMatchObject({ reason: 'file-op', summary: 'Before deleting b.tex' })
    expect(pre.authors.map(a => a.id)).toContain(alice.id)
    expect(await atVersion(pid, pre.id, 'b.tex')).toBe('the edited text, never snapshotted\n')
    // and the file is gone
    expect(t.services.files.getByPath(pid, 'b.tex')).toBeNull()
  })

  it('a live editor’s text the server has not saved to disk yet is committed before the delete', async () => {
    const pid = await newProject('Delete while typing')
    const c = await createFile(pid, 'chap.tex', 'start\n')
    const token = createSession(t.services.db, t.services.config, alice.id).token
    const doc = new Y.Doc()
    const provider = new WebsocketProvider(`${t.base.replace('http', 'ws')}/ws/doc/${pid}`, c.id, doc, {
      WebSocketPolyfill: class extends WebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols, { headers: { cookie: `folio_session=${token}`, origin: t.base } })
        }
      } as unknown as typeof globalThis.WebSocket,
      disableBc: true,
      params: { epoch: String(c.epoch) },
    })
    try {
      for (let i = 0; i < 300 && !provider.synced; i++) await sleep(10)
      expect(provider.synced).toBe(true)
      doc.getText(DOC_TEXT_KEY).insert(0, 'TYPED LIVE ')
      // the server has the keystrokes (collab saves to disk only after 2 s of quiet)
      for (let i = 0; i < 300 && !(await t.services.collab.getText(pid, c.id)).includes('TYPED LIVE'); i++) await sleep(10)
      expect((await A.del(`/api/projects/${pid}/files/${c.id}`)).status).toBe(200)
      const [pre] = await versions(pid)
      expect(pre).toMatchObject({ reason: 'file-op', summary: 'Before deleting chap.tex' })
      expect(await atVersion(pid, pre.id, 'chap.tex')).toBe('TYPED LIVE start\n')
    } finally {
      provider.destroy()
      doc.destroy()
    }
  })

  it('deleting a folder commits the pending changes of everything below it', async () => {
    const pid = await newProject('Delete folder')
    await createFile(pid, 'parts/one.tex', 'one\n')
    const two = await createFile(pid, 'parts/deep/two.tex', 'two\n')
    await t.services.collab.setText(pid, two.id, 'two, edited\n', { userId: alice.id, reason: 'test' })
    const folder = t.services.files.getByPath(pid, 'parts')!
    expect((await A.del(`/api/projects/${pid}/files/${folder.id}`)).status).toBe(200)
    const [pre] = await versions(pid)
    expect(pre).toMatchObject({ reason: 'file-op', summary: 'Before deleting parts' })
    expect(await atVersion(pid, pre.id, 'parts/one.tex')).toBe('one\n')
    expect(await atVersion(pid, pre.id, 'parts/deep/two.tex')).toBe('two, edited\n')
  })

  it('no extra version when what is deleted has not changed since the last one', async () => {
    const pid = await newProject('Delete unchanged')
    const keep = await createFile(pid, 'keep.tex', 'k\n')
    const gone = await createFile(pid, 'gone.tex', 'g\n')
    expect((await A.post(`/api/projects/${pid}/history/snapshot`)).status).toBe(200)
    // another file changes: that is not a reason for a pre-delete version of gone.tex
    await t.services.collab.setText(pid, keep.id, 'k, edited\n', { userId: alice.id, reason: 'test' })
    const before = (await versions(pid)).length
    expect((await A.del(`/api/projects/${pid}/files/${gone.id}`)).status).toBe(200)
    expect((await versions(pid)).length).toBe(before)
  })

  it('overwriting a text file with an upload (text → binary, new epoch) keeps its last text', async () => {
    const pid = await newProject('Replace by upload')
    const f = await createFile(pid, 'figure.tex', 'v1\n')
    await t.services.collab.setText(pid, f.id, 'v2, edited before the replace\n', { userId: alice.id, reason: 'test' })
    const r = await A.upload(`/api/projects/${pid}/upload`, formWith([{ name: 'figure.tex', data: Buffer.from([0x00, 0x01, 0xff, 0xfe, 0x00]) }], { replace: 'true' }))
    expect(r.status).toBe(200)
    expect(t.services.files.getByPath(pid, 'figure.tex')).toMatchObject({ kind: 'binary', epoch: f.epoch + 1 })
    const [pre] = (await versions(pid)).filter(v => v.reason === 'file-op')
    expect(pre.summary).toBe('Before replacing figure.tex')
    expect(await atVersion(pid, pre.id, 'figure.tex')).toBe('v2, edited before the replace\n')
  })

  it('a project restore removing files, and a delete racing it, both complete', async () => {
    const pid = await newProject('Restore removes')
    const v1 = (await versions(pid))[0].id
    await createFile(pid, 'later.tex', 'added after v1\n')
    const other = await createFile(pid, 'other.tex', 'another later file\n')
    await t.services.collab.setText(pid, other.id, 'another later file, edited\n', { userId: alice.id, reason: 'test' })
    const user = toPublic(alice)
    const restore = t.services.history.restore(pid, user, v1)
    const del = A.del(`/api/projects/${pid}/files/${other.id}`)
    const done = await Promise.race([Promise.allSettled([restore, del]), sleep(20_000).then(() => 'timeout' as const)])
    expect(done).not.toBe('timeout')
    const [rs, ds] = done as PromiseSettledResult<unknown>[]
    expect(rs.status).toBe('fulfilled')
    // the delete either ran first (200) or found the file already removed by the restore (404)
    expect(ds.status).toBe('fulfilled')
    expect([200, 404]).toContain((ds as PromiseFulfilledResult<{ status: number }>).value.status)
    expect(t.services.files.getByPath(pid, 'later.tex')).toBeNull()
    expect(t.services.files.getByPath(pid, 'other.tex')).toBeNull()
    // both texts are in history
    const all = await versions(pid)
    const texts = await Promise.all(all.map(v => atVersion(pid, v.id, 'other.tex')))
    expect(texts).toContain('another later file, edited\n')
    expect((await Promise.all(all.map(v => atVersion(pid, v.id, 'later.tex'))))).toContain('added after v1\n')
  })
})
