import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { FileEntry, ProjectSettings } from '@folio/shared/api'
import { META_FILES_KEY, META_PROJECT_KEY, WS_CLOSE, type MetaPresence } from '@folio/shared/protocol'
import { encodeAwarenessEntries, encodeAwarenessMessage } from '../../src/collab/wire.ts'
import { docClient, makeEnv, metaClient, rawSocket, sleep, waitFor, type DocClient, type Env } from './helpers.ts'

let env: Env

beforeEach(async () => {
  env = await makeEnv()
})

afterEach(async () => {
  await env.cleanup()
})

const filesOf = (c: DocClient) => c.doc.getMap<FileEntry>(META_FILES_KEY)
const projectOf = (c: DocClient) => c.doc.getMap<unknown>(META_PROJECT_KEY)

function dbFiles(): Record<string, FileEntry> {
  const out: Record<string, FileEntry> = {}
  for (const f of env.db.files.list(env.projectId)) {
    out[f.id] = { id: f.id, path: f.path, kind: f.kind, size: f.size, epoch: f.epoch, updatedAt: f.updatedAt }
  }
  return out
}

describe('meta room', () => {
  it('mirrors the db files and project data, and applies syncFiles/syncProject as diffs', async () => {
    const main = env.createTextFile('main.tex', 'x')
    const fig = env.createBinaryFile('fig.png', Buffer.from([1, 2, 3]))
    const meta = env.startMeta()
    const a = metaClient(env, env.users.alice)
    const b = metaClient(env, env.users.victor)
    await a.synced()
    await b.synced()
    expect(filesOf(a).toJSON()).toEqual(dbFiles())
    expect(projectOf(a).get('name')).toBe('Paper')
    expect((projectOf(a).get('settings') as ProjectSettings).compiler).toBe('pdflatex')

    // add, rename, delete — then one syncFiles
    const added = env.createTextFile('refs.bib', '@article{a,}')
    env.db.files.update(main.id, { path: 'paper.tex' })
    env.db.files.delete(fig.id)
    let updates = 0
    b.doc.on('update', () => updates++)
    meta.syncFiles(env.projectId)
    await waitFor(() => filesOf(b).has(added.id) && !filesOf(b).has(fig.id), 5000, 'files sync')
    expect(filesOf(b).toJSON()).toEqual(dbFiles())
    expect(filesOf(a).toJSON()).toEqual(dbFiles())
    expect(updates).toBe(1)

    // an unchanged db produces no update at all
    meta.syncFiles(env.projectId)
    await sleep(100)
    expect(updates).toBe(1)

    env.db.projects.rename(env.projectId, 'Renamed')
    env.db.projects.updateSettings(env.projectId, { compiler: 'xelatex' })
    meta.syncProject(env.projectId)
    await waitFor(() => projectOf(b).get('name') === 'Renamed', 5000, 'project sync')
    expect((projectOf(b).get('settings') as ProjectSettings).compiler).toBe('xelatex')
    expect(projectOf(b).get('updatedAt')).toBe(env.db.projects.get(env.projectId)!.updatedAt)
  })

  it('ignores client updates to the meta document', async () => {
    env.createTextFile('main.tex', 'x')
    env.startMeta()
    const a = metaClient(env, env.users.alice)
    const b = metaClient(env, env.users.bob)
    await a.synced()
    await b.synced()
    filesOf(a).set('evil', { id: 'evil', path: 'evil.tex', kind: 'text', size: 0, epoch: 0, updatedAt: 0 })
    projectOf(a).set('name', 'Hacked')
    await a.barrier()
    await b.barrier()
    await sleep(100)
    expect(filesOf(b).has('evil')).toBe(false)
    expect(projectOf(b).get('name')).toBe('Paper')
    // a new client sees the server state only
    const c = metaClient(env, env.users.victor)
    await c.synced()
    expect(filesOf(c).has('evil')).toBe(false)
    expect(projectOf(c).get('name')).toBe('Paper')
  })

  it('receives doc:changed events emitted by the collab service', async () => {
    const f = env.createTextFile('main.tex', 'hello\n')
    env.startMeta()
    env.startCollab({ docChangedMs: 50 })
    const m = metaClient(env, env.users.victor)
    const d = docClient(env, f, env.users.bob)
    await m.synced()
    await d.synced()
    d.text.insert(0, 'x')
    await d.barrier()
    await waitFor(() => m.events.some(e => e.type === 'doc:changed'), 5000, 'doc:changed event')
    expect(m.events).toContainEqual({ type: 'doc:changed', fileId: f.id, userId: env.users.bob.id })
  })

  it('broadcasts project events to every connection', async () => {
    const meta = env.startMeta()
    const a = metaClient(env, env.users.alice)
    const v = metaClient(env, env.users.victor)
    await a.synced()
    await v.synced()
    meta.broadcast(env.projectId, { type: 'chat:message', message: { id: 1, user: env.users.alice, content: 'hi', createdAt: 1 } })
    meta.broadcast(env.projectId, { type: 'doc:changed', fileId: 'f1', userId: env.users.alice.id })
    await waitFor(() => a.events.length === 2 && v.events.length === 2, 5000, 'events')
    expect(v.events[0]).toEqual({ type: 'chat:message', message: { id: 1, user: env.users.alice, content: 'hi', createdAt: 1 } })
    expect(v.events[1]).toEqual({ type: 'doc:changed', fileId: 'f1', userId: env.users.alice.id })
    meta.broadcast('another-project', { type: 'members:changed' })
    await sleep(100)
    expect(a.events).toHaveLength(2)
  })

  it('shares presence (authoritative identity + openFileId) and removes it on disconnect', async () => {
    env.startMeta()
    const a = metaClient(env, env.users.alice)
    const b = metaClient(env, env.users.bob)
    await a.synced()
    await b.synced()
    b.provider.awareness.setLocalState({ user: { id: 'x', name: 'Impostor', color: '#123456', colorLight: '#12345633' }, openFileId: 'file123', extra: 'dropped' })
    const bId = b.doc.clientID
    await waitFor(() => a.provider.awareness.getStates().has(bId), 5000, 'presence')
    const seen = a.provider.awareness.getStates().get(bId) as MetaPresence
    expect(seen).toEqual({ user: { id: env.users.bob.id, name: 'Bob', color: env.users.bob.color, colorLight: env.users.bob.color + '33' }, openFileId: 'file123' })
    b.provider.awareness.setLocalStateField('openFileId', null)
    await waitFor(() => (a.provider.awareness.getStates().get(bId) as MetaPresence).openFileId === null, 5000, 'presence update')
    b.destroy()
    await waitFor(() => !a.provider.awareness.getStates().has(bId), 5000, 'presence removed')
  })

  it('a client cannot remove or overwrite another user\'s presence', async () => {
    env.startMeta()
    const a = metaClient(env, env.users.alice)
    const m = metaClient(env, env.users.bob)
    await a.synced()
    await m.synced()
    a.provider.awareness.setLocalState({ openFileId: 'f-alice' })
    const aId = a.doc.clientID
    await waitFor(() => m.provider.awareness.getStates().has(aId), 5000, 'alice visible')
    // bob forges an update for alice's client id with a higher clock
    const forged = encodeAwarenessEntries([
      { clientID: aId, clock: 999, json: 'null' },
    ])
    m.provider.ws!.send(encodeAwarenessMessage(forged))
    const forged2 = encodeAwarenessEntries([
      { clientID: aId, clock: 1000, json: JSON.stringify({ openFileId: 'hijacked' }) },
    ])
    m.provider.ws!.send(encodeAwarenessMessage(forged2))
    await m.barrier()
    await a.barrier()
    const c = metaClient(env, env.users.victor)
    await c.synced()
    await waitFor(() => c.provider.awareness.getStates().has(aId), 5000, 'alice visible to new client')
    const seen = c.provider.awareness.getStates().get(aId) as MetaPresence
    expect(seen.openFileId).toBe('f-alice')
    expect(seen.user.id).toBe(env.users.alice.id)
  })

  it('disconnectSessions closes only that session\'s meta sockets', async () => {
    const meta = env.startMeta()
    const a1 = metaClient(env, env.users.alice, { session: 'sess-1' })
    const a2 = metaClient(env, env.users.alice, { session: 'sess-2' })
    await a1.synced()
    await a2.synced()
    expect(meta.openSessions().sort()).toEqual(['sess-1', 'sess-2'])
    expect(meta.disconnectSessions(['sess-1'], WS_CLOSE.UNAUTHORIZED)).toBe(1)
    await waitFor(() => a1.closes.length > 0, 5000, 'closed')
    expect(a1.closes).toEqual([WS_CLOSE.UNAUTHORIZED])
    await sleep(200)
    expect(a2.closes).toEqual([])
    expect(meta.openSessions()).toEqual(['sess-2'])
  })

  it('closes 4401 / 4403 / 4404, disconnectUser (4403) and closeProject (4410)', async () => {
    const meta = env.startMeta()
    const cases: [string, number][] = [
      [`/ws/project/${env.projectId}`, WS_CLOSE.UNAUTHORIZED],
      [`/ws/project/${env.projectId}?u=${env.users.mallory.id}`, WS_CLOSE.FORBIDDEN],
      [`/ws/project/AAAAAAAAAAAAAAAA?u=${env.users.alice.id}`, WS_CLOSE.NOT_FOUND],
    ]
    for (const [url, code] of cases) expect(await rawSocket(env, url).closed, url).toBe(code)
    const a = metaClient(env, env.users.alice)
    const b = metaClient(env, env.users.bob)
    await a.synced()
    await b.synced()
    meta.disconnectUser(env.projectId, env.users.bob.id, WS_CLOSE.FORBIDDEN)
    await waitFor(() => b.closes.length > 0, 5000, 'bob closed')
    expect(b.closes).toEqual([WS_CLOSE.FORBIDDEN])
    expect(a.closes).toEqual([])
    const sidecar = path.join(env.config.dirs.ystate, env.projectId, '_project-meta.ybin')
    expect(fs.existsSync(sidecar)).toBe(true)
    meta.closeProject(env.projectId, WS_CLOSE.GONE)
    await waitFor(() => a.closes.length > 0, 5000, 'alice closed')
    expect(a.closes).toEqual([WS_CLOSE.GONE])
    expect(fs.existsSync(sidecar)).toBe(false)
  })

  it('survives a restart: clients converge with the persisted doc and later deletions propagate', async () => {
    const f1 = env.createTextFile('a.tex', 'a')
    const f2 = env.createTextFile('b.tex', 'b')
    const meta1 = env.startMeta()
    const a = metaClient(env, env.users.alice)
    await a.synced()
    expect(filesOf(a).size).toBe(2)

    env.meta = null
    await meta1.shutdown()
    await waitFor(() => !a.provider.wsconnected, 5000, 'disconnected')
    const meta2 = env.startMeta()
    await waitFor(() => a.provider.synced, 10_000, 'reconnected')
    expect(a.closes).toEqual([])
    env.db.files.delete(f2.id)
    env.db.files.update(f1.id, { path: 'renamed.tex' })
    meta2.syncFiles(env.projectId)
    await waitFor(() => !filesOf(a).has(f2.id) && filesOf(a).get(f1.id)?.path === 'renamed.tex', 5000, 'changes after restart')
    expect(filesOf(a).toJSON()).toEqual(dbFiles())
  })

  it('a client whose meta state is ahead of the server (lost state) is told to start over (4409)', async () => {
    env.createTextFile('a.tex', 'a')
    const meta1 = env.startMeta()
    const a = metaClient(env, env.users.alice)
    await a.synced()
    env.meta = null
    await meta1.shutdown()
    await waitFor(() => !a.provider.wsconnected, 5000, 'disconnected')
    fs.rmSync(path.join(env.config.dirs.ystate, env.projectId, '_project-meta.ybin'))
    env.startMeta()
    await waitFor(() => a.closes.length > 0, 10_000, 'stale close')
    expect(a.closes).toEqual([WS_CLOSE.STALE_EPOCH])
    const fresh = metaClient(env, env.users.alice)
    await fresh.synced()
    expect(filesOf(fresh).toJSON()).toEqual(dbFiles())
  })
})
