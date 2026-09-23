/**
 * HistoryService.snapshotBeforeDelete: FileService calls it before deleting (or overwriting)
 * files, so edits made since the last version stay restorable. It commits only when the doomed
 * paths differ from HEAD, costs nothing while nothing was noted since the last snapshot, and
 * returns at once from inside a history operation of the same project (restore → files.remove).
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { HistoryServiceOptions } from '../../src/history/index.ts'
import { setup, sleep, type Harness } from './helpers.ts'

let h: Harness | null = null
afterEach(async () => {
  await h?.cleanup()
  h = null
})

async function start(files: Record<string, string>, opts: HistoryServiceOptions = {}): Promise<Harness> {
  h = await setup(opts)
  for (const [p, c] of Object.entries(files)) await h.put(p, c)
  await h.history.init(h.pid, h.owner)
  h.meta.events.length = 0
  return h
}

/** an edit collab has saved to disk, reported the way collab reports it */
async function edit(x: Harness, p: string, text: string, userId: string | null): Promise<void> {
  await x.put(p, text)
  x.history.noteActivity(x.pid, userId)
}

describe('snapshotBeforeDelete', () => {
  it('commits the pending edits of a file about to be deleted (reason file-op)', async () => {
    const x = await start({ 'main.tex': 'main\n', 'chap.tex': 'v1\n' })
    await edit(x, 'chap.tex', 'v2, edited just before the delete\n', x.alice.id)
    const sha = await x.history.snapshotBeforeDelete(x.pid, ['chap.tex'])
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    const [v] = (await x.history.list(x.pid, {})).versions
    expect(v).toMatchObject({ id: sha, reason: 'file-op', summary: 'Before deleting chap.tex' })
    expect(v.authors.map(a => a.id)).toEqual([x.alice.id])
    expect((await x.history.fileAt(x.pid, sha!, 'chap.tex'))!.toString()).toBe('v2, edited just before the delete\n')
    expect(x.meta.events.some(e => e.event.type === 'history:changed')).toBe(true)
  })

  it('covers everything below a deleted folder, including files that were never committed', async () => {
    const x = await start({ 'main.tex': 'main\n' })
    await x.put('figs/notes.tex', 'uploaded a moment ago\n')
    await x.put('figs/deeper/more.tex', 'also new\n')
    const sha = await x.history.snapshotBeforeDelete(x.pid, ['figs'])
    expect(sha).not.toBeNull()
    expect((await x.history.fileAt(x.pid, sha!, 'figs/notes.tex'))!.toString()).toBe('uploaded a moment ago\n')
    expect((await x.history.fileAt(x.pid, sha!, 'figs/deeper/more.tex'))!.toString()).toBe('also new\n')
  })

  it('says "replacing" when the file is about to be overwritten', async () => {
    const x = await start({ 'chap.tex': 'v1\n' })
    await edit(x, 'chap.tex', 'v2\n', x.bob.id)
    const sha = await x.history.snapshotBeforeDelete(x.pid, ['chap.tex'], { replace: true })
    expect((await x.history.list(x.pid, {})).versions[0]).toMatchObject({ id: sha, reason: 'file-op', summary: 'Before replacing chap.tex' })
  })

  it('makes no commit when the doomed paths did not change; other pending edits keep their regular snapshot', async () => {
    const x = await start({ 'main.tex': 'a\n', 'chap.tex': 'c\n' })
    await edit(x, 'main.tex', 'b\n', x.alice.id)
    const flushes = x.collab.flushCount
    expect(await x.history.snapshotBeforeDelete(x.pid, ['chap.tex'])).toBeNull()
    // live documents were flushed for the check, but nothing was committed
    expect(x.collab.flushCount).toBeGreaterThan(flushes)
    expect((await x.history.list(x.pid, {})).versions).toHaveLength(1)
    // the window with alice's edit is still pending: the next snapshot credits her
    const sha = await x.history.snapshot(x.pid, 'auto')
    expect(sha).not.toBeNull()
    expect((await x.history.list(x.pid, {})).versions[0].authors.map(a => a.id)).toEqual([x.alice.id])
  })

  it('costs nothing (no flush, no git) while no activity was noted since the last snapshot', async () => {
    const x = await start({ 'main.tex': 'a\n', 'chap.tex': 'c\n' }, { unnotedEditSlackMs: 0 })
    await sleep(5)
    const flushes = x.collab.flushCount
    expect(await x.history.snapshotBeforeDelete(x.pid, ['chap.tex'])).toBeNull()
    expect(x.collab.flushCount).toBe(flushes)
    // activity makes it look again
    await edit(x, 'chap.tex', 'changed\n', x.alice.id)
    expect(await x.history.snapshotBeforeDelete(x.pid, ['chap.tex'])).not.toBeNull()
  })

  it('right after a snapshot it checks the work tree even without noted activity (throttled edit reports)', async () => {
    const x = await start({ 'chap.tex': 'c\n' })
    // saved by collab, but its noteActivity was throttled away
    await x.put('chap.tex', 'typed right after the last snapshot\n')
    const sha = await x.history.snapshotBeforeDelete(x.pid, ['chap.tex'])
    expect(sha).not.toBeNull()
    expect((await x.history.fileAt(x.pid, sha!, 'chap.tex'))!.toString()).toBe('typed right after the last snapshot\n')
  })

  it('trusts "nothing noted" only while collab’s edit counter is unchanged too, however long ago the snapshot was', async () => {
    const x = await start({ 'chap.tex': 'c\n' }, { unnotedEditSlackMs: 0 })
    await sleep(5)
    // collab applied (and saved) an edit, but its activity report never reached history
    await x.put('chap.tex', 'counted by collab, never reported\n')
    const sha = await x.history.snapshotBeforeDelete(x.pid, ['chap.tex'])
    expect(sha).not.toBeNull()
    expect((await x.history.fileAt(x.pid, sha!, 'chap.tex'))!.toString()).toBe('counted by collab, never reported\n')
    // that snapshot recorded the counter: free again until the next change
    await sleep(5)
    const flushes = x.collab.flushCount
    expect(await x.history.snapshotBeforeDelete(x.pid, ['chap.tex'])).toBeNull()
    expect(x.collab.flushCount).toBe(flushes)
  })

  it('never takes the shortcut when collab cannot say how many edits it applied', async () => {
    const x = await start({ 'chap.tex': 'c\n' }, { unnotedEditSlackMs: 0 })
    x.collab.editCount = () => { throw new Error('collab is gone') }
    await sleep(5)
    const flushes = x.collab.flushCount
    expect(await x.history.snapshotBeforeDelete(x.pid, ['chap.tex'])).toBeNull() // nothing changed: no commit…
    expect(x.collab.flushCount).toBeGreaterThan(flushes) // … but it looked
  })

  it('a failed snapshot leaves the next check looking at the work tree', async () => {
    const x = await start({ 'chap.tex': 'c\n' }, { unnotedEditSlackMs: 0 })
    await x.put('chap.tex', 'pending\n')
    x.history.noteActivity(x.pid, null) // no user to credit again when the snapshot fails
    // a fresh index.lock (not stale yet) makes `git add` fail: the snapshot is refused (busy)
    const lock = path.join(x.gitDir, 'index.lock')
    fs.writeFileSync(lock, '')
    await expect(x.history.snapshot(x.pid, 'auto')).rejects.toThrow(/busy/)
    fs.rmSync(lock)
    await sleep(5)
    const sha = await x.history.snapshotBeforeDelete(x.pid, ['chap.tex'])
    expect(sha).not.toBeNull()
    expect((await x.history.fileAt(x.pid, sha!, 'chap.tex'))!.toString()).toBe('pending\n')
  })

  it('returns at once when a restore of the same project removes files (no deadlock)', async () => {
    const x = await start({ 'main.tex': 'a\n' })
    const v1 = (await x.history.list(x.pid, {})).versions[0].id
    await edit(x, 'extra.tex', 'only in the newer version\n', x.alice.id)
    await x.history.snapshot(x.pid, 'manual', x.alice)
    // FileService.remove snapshots before deleting; the harness' fake files do the same
    const fakeRemove = x.files.remove
    const seen: (string | null)[] = []
    x.files.remove = async (pid, user, fileId) => {
      seen.push(await x.history.snapshotBeforeDelete(pid, [x.db.files.get(fileId)!.path]))
      return fakeRemove(pid, user, fileId)
    }
    const restore = x.history.restore(x.pid, x.owner, v1)
    const r = await Promise.race([restore, sleep(15_000).then(() => 'timeout' as const)])
    expect(r).not.toBe('timeout')
    expect(seen).toEqual([null])
    expect(x.db.files.getByPath(x.pid, 'extra.tex')).toBeFalsy()
    // the removed file is still in history
    const versions = (await x.history.list(x.pid, {})).versions
    expect(versions.some(v => v.changes.some(c => c.path === 'extra.tex' && c.op === 'added'))).toBe(true)
  })
})
