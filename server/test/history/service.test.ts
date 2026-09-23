import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { HttpError } from '../../src/http/errors.ts'
import { createHistoryService } from '../../src/history/index.ts'
import { collect, setup, unzip, waitFor, type Harness } from './helpers.ts'

// 1×1 transparent PNG and a second, different image
const PNG_A = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGBgAAAABQABpfZFQAAAAABJRU5ErkJggg==', 'base64')
const PNG_B = Buffer.concat([PNG_A, Buffer.from([0, 1, 2, 3, 0, 255])])

let h: Harness
beforeEach(async () => { h = await setup() })
afterEach(async () => { await h.cleanup() })

async function initWith(files: Record<string, string | Buffer>) {
  for (const [p, c] of Object.entries(files)) await h.put(p, c)
  await h.history.init(h.pid, h.owner)
  h.meta.events.length = 0
}

describe('init and snapshots', () => {
  it('creates a separate git dir and an initial import commit', async () => {
    await initWith({ 'main.tex': '\\documentclass{article}\n', 'refs.bib': '@article{a,}\n', 'fig/plot.png': PNG_A })
    expect(fs.existsSync(path.join(h.gitDir, 'HEAD'))).toBe(true)
    expect(fs.existsSync(path.join(h.projectDir, '.git'))).toBe(false)
    expect(h.git(['config', 'core.bare']).trim()).toBe('false')

    const { versions, hasMore } = await h.history.list(h.pid, {})
    expect(hasMore).toBe(false)
    expect(versions).toHaveLength(1)
    const v = versions[0]
    expect(v.reason).toBe('import')
    expect(v.parentId).toBeNull()
    expect(v.authors).toEqual([h.owner])
    expect(v.changes.map(c => [c.op, c.path]).sort()).toEqual([['added', 'fig/plot.png'], ['added', 'main.tex'], ['added', 'refs.bib']])
    expect(Math.abs(v.createdAt - Date.now())).toBeLessThan(60_000)
  })

  it('init of an empty project still produces a first version', async () => {
    await h.history.init(h.pid, null)
    const { versions } = await h.history.list(h.pid, {})
    expect(versions).toHaveLength(1)
    expect(versions[0].authors).toEqual([])
    expect(versions[0].changes).toEqual([])
  })

  it('snapshot with no change returns null and adds no version', async () => {
    await initWith({ 'main.tex': 'a\n' })
    expect(await h.history.snapshot(h.pid, 'manual', h.owner)).toBeNull()
    expect(await h.history.snapshot(h.pid, 'auto')).toBeNull()
    expect((await h.history.list(h.pid, {})).versions).toHaveLength(1)
    expect(h.collab.flushCount).toBeGreaterThanOrEqual(2)
  })

  it('commits changes, flushes collab first and broadcasts history:changed', async () => {
    await initWith({ 'main.tex': 'a\n' })
    await h.put('main.tex', 'b\n')
    const flushes = h.collab.flushCount
    const sha = await h.history.snapshot(h.pid, 'manual', h.alice)
    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(h.collab.flushCount).toBe(flushes + 1)
    expect(h.meta.events).toContainEqual({ projectId: h.pid, event: { type: 'history:changed', versionId: sha } })
    const { versions } = await h.history.list(h.pid, {})
    expect(versions[0]).toMatchObject({ id: sha, reason: 'manual', changes: [{ path: 'main.tex', op: 'modified' }] })
    expect(versions[0].parentId).toBe(versions[1].id)
  })

  it('commits the disk state even when collab cannot flush', async () => {
    await initWith({ 'main.tex': 'a\n' })
    await h.put('main.tex', 'b\n')
    h.collab.failFlush = true
    expect(await h.history.snapshot(h.pid, 'shutdown')).toMatch(/^[0-9a-f]{40}$/)
  })

  it('records authors and trailers, and resolves deleted users from the commit', async () => {
    await initWith({ 'main.tex': 'a\n' })
    await h.put('main.tex', 'b\n')
    h.collab.editors.set(h.pid, [h.alice.id, h.bob.id, h.owner.id, 'no-such-user-id'])
    const sha = (await h.history.snapshot(h.pid, 'manual', h.owner))!

    const raw = h.git(['cat-file', 'commit', sha])
    expect(raw).toMatch(/^author Olivia Owner <owner@example\.org> /m)
    expect(raw).toMatch(/^committer Folio <folio@localhost> /m)
    const body = h.git(['log', '-1', '--format=%B', sha])
    expect(body).toContain('Folio-Reason: manual')
    expect(body).toContain(`Folio-User-Ids: ${h.owner.id},${h.alice.id},${h.bob.id}`)
    expect(body).toContain('Co-authored-by: Alice Ångström <alice@example.org>')
    expect(body).toContain('Co-authored-by: Bob Builder <bob@example.org>')
    expect(h.git(['log', '-1', `--format=%(trailers:key=Co-authored-by,valueonly)`, sha]).trim().split('\n')).toHaveLength(2)

    let v = (await h.history.list(h.pid, {})).versions[0]
    expect(v.authors).toEqual([h.owner, h.alice, h.bob])

    // Bob's account is deleted: the version keeps his id and the identity recorded in git.
    h.db.users.delete(h.bob.id)
    v = (await h.history.list(h.pid, {})).versions[0]
    expect(v.authors[2]).toMatchObject({ id: h.bob.id, name: 'Bob Builder', email: 'bob@example.org' })
    expect(v.authors[2].color).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })

  it('credits users seen through noteActivity', async () => {
    await initWith({ 'main.tex': 'a\n' })
    await h.put('main.tex', 'b\n')
    h.history.noteActivity(h.pid, h.alice.id)
    const sha = await h.history.snapshot(h.pid, 'auto')
    const v = (await h.history.list(h.pid, {})).versions[0]
    expect(v.id).toBe(sha)
    expect(v.authors).toEqual([h.alice])
    expect(v.reason).toBe('auto')
  })

  it('paginates newest-first with an exclusive before cursor', async () => {
    await initWith({ 'main.tex': 'v0\n' })
    const shas: string[] = []
    for (let i = 1; i <= 6; i++) {
      await h.put('main.tex', `v${i}\n`)
      shas.push((await h.history.snapshot(h.pid, 'manual', h.owner))!)
    }
    const all = (await h.history.list(h.pid, { limit: 100 })).versions.map(v => v.id)
    expect(all).toHaveLength(7)
    expect(all.slice(0, 6)).toEqual([...shas].reverse())

    const seen: string[] = []
    let before: string | undefined
    for (let guard = 0; guard < 10; guard++) {
      const page = await h.history.list(h.pid, { before, limit: 3 })
      seen.push(...page.versions.map(v => v.id))
      if (!page.hasMore) break
      expect(page.versions).toHaveLength(3)
      before = page.versions[page.versions.length - 1].id
    }
    expect(seen).toEqual(all)

    const last = await h.history.list(h.pid, { before: all[6] })
    expect(last).toEqual({ versions: [], hasMore: false })
    // abbreviated sha works as cursor too
    expect((await h.history.list(h.pid, { before: all[0].slice(0, 10), limit: 1 })).versions[0].id).toBe(all[1])
    await expect(h.history.list(h.pid, { before: 'f'.repeat(40) })).rejects.toMatchObject({ status: 404 })
    await expect(h.history.list(h.pid, { before: '--output=/tmp/x' })).rejects.toMatchObject({ status: 400 })
  })

  it('detects renames', async () => {
    await initWith({ 'chapters/intro.tex': 'Intro text that is long enough to be recognised as the same file.\n'.repeat(5) })
    const f = h.db.files.getByPath(h.pid, 'chapters/intro.tex')!
    await h.files.move(h.pid, null, f.id, 'chapters/introduction.tex')
    await h.history.snapshot(h.pid, 'file-op')
    const v = (await h.history.list(h.pid, {})).versions[0]
    expect(v.reason).toBe('file-op')
    expect(v.changes).toEqual([{ path: 'chapters/introduction.tex', op: 'renamed', oldPath: 'chapters/intro.tex' }])
    // diff on the new path shows the old content rather than "added"
    const d = await h.history.diff(h.pid, { to: v.id, path: 'chapters/introduction.tex' })
    expect(d.oldText).toBe(d.newText)
    expect(d.oldText).not.toBeNull()
  })
})

describe('files, fileAt and diff', () => {
  it('lists files of a version with binary flags and returns raw bytes', async () => {
    await initWith({ 'main.tex': 'hello\n', 'fig.png': PNG_A, 'data.xyz': 'plain text\n', 'blob.xyz': Buffer.from([1, 0, 2]), 'Makefile': 'all:\n' })
    const head = (await h.history.list(h.pid, {})).versions[0].id
    const res = await h.history.files(h.pid, head)
    expect(res.versionId).toBe(head)
    const byPath = Object.fromEntries(res.files.map(f => [f.path, f]))
    expect(byPath['main.tex']).toEqual({ path: 'main.tex', size: 6, binary: false })
    expect(byPath['fig.png'].binary).toBe(true)
    expect(byPath['data.xyz'].binary).toBe(false)
    expect(byPath['blob.xyz'].binary).toBe(true)
    expect(byPath['Makefile'].binary).toBe(false)

    expect((await h.history.fileAt(h.pid, head, 'fig.png'))!.equals(PNG_A)).toBe(true)
    expect((await h.history.fileAt(h.pid, 'HEAD', 'main.tex'))!.toString()).toBe('hello\n')
    expect(await h.history.fileAt(h.pid, head, 'missing.tex')).toBeNull()
    await expect(h.history.fileAt(h.pid, head, '../etc/passwd')).rejects.toMatchObject({ status: 400 })
    await expect(h.history.files(h.pid, 'nothex')).rejects.toMatchObject({ status: 400 })
    await expect(h.history.files(h.pid, '0'.repeat(40))).rejects.toMatchObject({ status: 404 })
  })

  it('diffs added, modified, deleted and binary files', async () => {
    await initWith({ 'main.tex': 'line 1\nline 2\n', 'old.tex': 'to be deleted\n', 'img.png': PNG_A })
    const v1 = (await h.history.list(h.pid, {})).versions[0].id
    await h.put('main.tex', 'line 1\nline two\n')
    await h.put('new.tex', 'brand new\n')
    await h.del('old.tex')
    await h.put('img.png', PNG_B)
    const v2 = (await h.history.snapshot(h.pid, 'manual', h.owner))!

    const mod = await h.history.diff(h.pid, { to: v2, path: 'main.tex' })
    expect(mod).toEqual({ path: 'main.tex', from: v1, to: v2, binary: false, oldText: 'line 1\nline 2\n', newText: 'line 1\nline two\n' })

    const added = await h.history.diff(h.pid, { to: v2, path: 'new.tex' })
    expect(added).toMatchObject({ binary: false, oldText: null, newText: 'brand new\n' })

    const del = await h.history.diff(h.pid, { to: v2, path: 'old.tex' })
    expect(del).toMatchObject({ binary: false, oldText: 'to be deleted\n', newText: null })

    const bin = await h.history.diff(h.pid, { to: v2, path: 'img.png' })
    expect(bin).toMatchObject({ binary: true, oldText: '', newText: '' })

    // explicit range, and the root version (no parent → from null)
    const range = await h.history.diff(h.pid, { from: v2, to: v1, path: 'new.tex' })
    expect(range).toMatchObject({ from: v2, to: v1, oldText: 'brand new\n', newText: null })
    const root = await h.history.diff(h.pid, { to: v1, path: 'main.tex' })
    expect(root).toMatchObject({ from: null, oldText: null, newText: 'line 1\nline 2\n' })

    await expect(h.history.diff(h.pid, { to: v2, path: 'nope.tex' })).rejects.toMatchObject({ status: 404 })
  })

  it('treats a text-named file with NUL bytes as binary', async () => {
    await initWith({ 'weird.tex': 'ok\n' })
    await h.put('weird.tex', Buffer.from([0x61, 0, 0x62]))
    const v = (await h.history.snapshot(h.pid, 'manual'))!
    expect((await h.history.diff(h.pid, { to: v, path: 'weird.tex' })).binary).toBe(true)
  })
})

describe('restore', () => {
  it('restores a single text file through collab.setText and records a restore version', async () => {
    await initWith({ 'main.tex': 'original\n', 'other.tex': 'other\n' })
    const v1 = (await h.history.list(h.pid, {})).versions[0].id
    await h.put('main.tex', 'edited\n')
    await h.put('other.tex', 'other edited\n')
    await h.history.snapshot(h.pid, 'manual', h.owner)
    await h.put('main.tex', 'edited again (not yet snapshotted)\n')
    h.collab.setTextCalls.length = 0
    h.meta.events.length = 0

    const res = await h.history.restore(h.pid, h.alice, v1, 'main.tex')
    expect(res.restored).toEqual(['main.tex'])
    expect(res.versionId).toMatch(/^[0-9a-f]{40}$/)
    expect(h.collab.setTextCalls).toHaveLength(1)
    expect(h.collab.setTextCalls[0]).toMatchObject({ path: 'main.tex', text: 'original\n', origin: { userId: h.alice.id, reason: 'restore' } })
    expect(h.files.calls).toEqual([])
    expect(fs.readFileSync(path.join(h.projectDir, 'other.tex'), 'utf8')).toBe('other edited\n')
    expect(h.meta.events).toContainEqual({ projectId: h.pid, event: { type: 'history:changed', versionId: res.versionId } })

    const { versions } = await h.history.list(h.pid, {})
    expect(versions[0]).toMatchObject({ id: res.versionId, reason: 'restore', changes: [{ path: 'main.tex', op: 'modified' }] })
    expect(versions[0].authors[0]).toEqual(h.alice)
    // the unsnapshotted edit was captured by the pre-restore snapshot
    expect(versions[1].reason).toBe('auto')
    expect((await h.history.fileAt(h.pid, versions[1].id, 'main.tex'))!.toString()).toBe('edited again (not yet snapshotted)\n')

    // restoring the same state again changes nothing
    const again = await h.history.restore(h.pid, h.alice, v1, 'main.tex')
    expect(again).toEqual({ restored: [], versionId: null })
    await expect(h.history.restore(h.pid, h.alice, v1, 'absent.tex')).rejects.toMatchObject({ status: 404 })
  })

  it('restores a deleted file with writeFile', async () => {
    await initWith({ 'main.tex': 'm\n', 'sec/a.tex': 'section a\n' })
    const v1 = (await h.history.list(h.pid, {})).versions[0].id
    await h.del('sec')
    await h.history.snapshot(h.pid, 'file-op')
    const res = await h.history.restore(h.pid, h.owner, v1, 'sec/a.tex')
    expect(res.restored).toEqual(['sec/a.tex'])
    expect(h.files.calls).toEqual([{ op: 'writeFile', path: 'sec/a.tex', bytes: Buffer.from('section a\n'), replace: false }])
    expect(fs.readFileSync(path.join(h.projectDir, 'sec/a.tex'), 'utf8')).toBe('section a\n')
  })

  it('restores the whole project: removes added files, recreates deleted ones, restores binaries', async () => {
    await initWith({ 'main.tex': 'v1 main\n', 'keep.bib': '@misc{k,}\n', 'img/logo.png': PNG_A, 'gone/deep.tex': 'deep\n' })
    const v1 = (await h.history.list(h.pid, {})).versions[0].id
    await h.put('main.tex', 'v2 main\n')
    await h.put('img/logo.png', PNG_B)
    await h.put('added.tex', 'added later\n')
    await h.put('newdir/sub/x.tex', 'nested new\n')
    await h.del('gone')
    await h.history.snapshot(h.pid, 'manual', h.owner)
    h.collab.setTextCalls.length = 0

    const res = await h.history.restore(h.pid, h.bob, v1)
    expect(res.restored).toEqual(['added.tex', 'gone/deep.tex', 'img/logo.png', 'main.tex', 'newdir/sub/x.tex'])
    expect(h.collab.setTextCalls.map(c => [c.path, c.text])).toEqual([['main.tex', 'v1 main\n']])
    const writes = h.files.calls.filter(c => c.op === 'writeFile')
    expect(writes.map(c => [c.path, c.replace])).toEqual([['gone/deep.tex', false], ['img/logo.png', true]])
    expect(writes[1].bytes!.equals(PNG_A)).toBe(true)
    expect(h.files.calls.filter(c => c.op === 'remove').map(c => c.path).sort()).toEqual(['added.tex', 'newdir'])

    const tree = h.db.files.list(h.pid).filter(f => f.kind !== 'folder').map(f => f.path).sort()
    expect(tree).toEqual(['gone/deep.tex', 'img/logo.png', 'keep.bib', 'main.tex'])
    expect(fs.readFileSync(path.join(h.projectDir, 'img/logo.png')).equals(PNG_A)).toBe(true)
    expect(fs.existsSync(path.join(h.projectDir, 'newdir'))).toBe(false)

    // the new head has the same tree as v1
    expect(h.git(['rev-parse', `${res.versionId}^{tree}`])).toBe(h.git(['rev-parse', `${v1}^{tree}`]))
    const top = (await h.history.list(h.pid, {})).versions[0]
    expect(top.reason).toBe('restore')
    expect(top.authors[0]).toEqual(h.bob)
  })

  it('replaces a folder that is now where a file used to be', async () => {
    await initWith({ 'x': 'file x\n', 'main.tex': 'm\n' })
    const v1 = (await h.history.list(h.pid, {})).versions[0].id
    await h.del('x')
    await h.put('x/inner.tex', 'inner\n')
    await h.history.snapshot(h.pid, 'manual')
    await expect(h.history.restore(h.pid, h.owner, v1, 'x')).rejects.toMatchObject({ status: 409 })
    const res = await h.history.restore(h.pid, h.owner, v1)
    expect(res.restored).toEqual(['x', 'x/inner.tex'])
    expect(fs.readFileSync(path.join(h.projectDir, 'x'), 'utf8')).toBe('file x\n')
  })
})

describe('review fixes: restore summaries, empty folders, crash recovery, text size', () => {
  it('versions carry their summary; restores say what was restored and from when', async () => {
    await initWith({ 'main.tex': 'original\n', 'other.tex': 'o\n' })
    const v1 = (await h.history.list(h.pid, {})).versions[0]
    await h.put('main.tex', 'edited\n')
    await h.history.snapshot(h.pid, 'manual', h.owner)
    const single = await h.history.restore(h.pid, h.alice, v1.id, 'main.tex')
    await h.put('other.tex', 'o2\n')
    await h.history.snapshot(h.pid, 'manual', h.owner)
    const whole = await h.history.restore(h.pid, h.bob, v1.id)
    const label = await h.history.createLabel(h.pid, h.owner, 'Camera ready')
    void label

    const { versions } = await h.history.list(h.pid, {})
    const byId = new Map(versions.map(v => [v.id, v]))
    const when = /\(\d{1,2} [A-Z][a-z]{2}(?: \d{4})? \d{2}:\d{2}\)$/
    const s1 = byId.get(single.versionId!)!
    expect(s1.summary).toMatch(new RegExp(`^Restored main\\.tex to ${v1.id.slice(0, 7)} `))
    expect(s1.summary).toMatch(when)
    expect(s1.restoredFrom).toEqual({ versionId: v1.id, createdAt: v1.createdAt, path: 'main.tex' })
    const s2 = byId.get(whole.versionId!)!
    expect(s2.summary).toMatch(new RegExp(`^Restored to ${v1.id.slice(0, 7)} `))
    expect(s2.restoredFrom).toEqual({ versionId: v1.id, createdAt: v1.createdAt })
    expect(versions.at(-1)!.summary).toBe('Initial import')
    expect(versions.find(v => v.reason === 'manual')!.summary).toBe('Manual snapshot')
    expect(versions.find(v => v.reason === 'auto')?.summary ?? 'Auto-save before restore').toMatch(/Auto-save/)
    expect(versions.find(v => v.reason === 'import')!.restoredFrom).toBeUndefined()
  })

  it('a project restore keeps folders that are empty now (git cannot record them)', async () => {
    await initWith({ 'main.tex': 'a\n', 'sections/intro.tex': 'i\n' })
    await h.files.create(h.pid, null, 'figures', 'folder')
    await h.history.snapshot(h.pid, 'manual')
    const v = (await h.history.list(h.pid, {})).versions[0].id
    await h.put('main.tex', 'b\n')
    await h.put('later/new.tex', 'n\n')
    await h.history.snapshot(h.pid, 'manual')
    const res = await h.history.restore(h.pid, h.owner, v)
    expect(res.restored).toEqual(['later/new.tex', 'main.tex'])
    const tree = h.db.files.list(h.pid).map(f => f.path).sort()
    expect(tree).toEqual(['figures', 'main.tex', 'sections', 'sections/intro.tex'])
    expect(fs.existsSync(path.join(h.projectDir, 'figures'))).toBe(true)
  })

  it('after a crash, edits on disk are committed at start-up and credited to whoever made them', async () => {
    await initWith({ 'main.tex': 'a\n' })
    // bob edits; collab saved the file, the idle snapshot never ran (the server was killed)
    h.history.noteActivity(h.pid, h.bob.id)
    const pending = path.join(h.gitDir, 'folio-pending.json')
    await waitFor(() => fs.existsSync(pending))
    expect(JSON.parse(fs.readFileSync(pending, 'utf8'))).toEqual([h.bob.id])
    await h.put('main.tex', 'BOB WROTE THIS\n')

    // a new process on the same data
    const restarted = createHistoryService(h.s)
    try {
      expect(await restarted.recoverAfterRestart()).toBe(1)
      const top = (await restarted.list(h.pid, {})).versions[0]
      expect(top).toMatchObject({ reason: 'auto', summary: 'Recovered after restart', changes: [{ path: 'main.tex', op: 'modified' }] })
      expect(top.authors.map(a => a.id)).toEqual([h.bob.id])
      expect(fs.existsSync(pending)).toBe(false)
      // nothing left to recover
      expect(await restarted.recoverAfterRestart()).toBe(0)
    } finally {
      await restarted.shutdown()
    }
  })

  it('text size is counted in characters: a 2.2 MB Greek document stays text in files, diff and restore', async () => {
    const greek = 'α'.repeat(1_100_000) + '\n' // 2.2 MB of UTF-8, 1.1 M characters
    await initWith({ 'main.tex': 'm\n', 'gr.tex': greek })
    expect(h.db.files.getByPath(h.pid, 'gr.tex')!.kind).toBe('text')
    const v1 = (await h.history.list(h.pid, {})).versions[0].id
    await h.put('gr.tex', greek.replace('α', 'β'))
    await h.history.snapshot(h.pid, 'manual')
    const v2 = (await h.history.list(h.pid, {})).versions[0].id

    const files = await h.history.files(h.pid, v2)
    expect(files.files.find(f => f.path === 'gr.tex')).toMatchObject({ binary: false })
    const d = await h.history.diff(h.pid, { to: v2, path: 'gr.tex' })
    expect(d.binary).toBe(false)
    expect(d.newText!.startsWith('β')).toBe(true)

    h.collab.setTextCalls.length = 0
    h.files.calls.length = 0
    await h.history.restore(h.pid, h.owner, v1, 'gr.tex')
    expect(h.collab.setTextCalls.map(c => c.path)).toEqual(['gr.tex'])
    expect(h.files.calls.filter(c => c.op === 'writeFile')).toEqual([])
    expect(h.db.files.getByPath(h.pid, 'gr.tex')!.kind).toBe('text')

    // over the character limit it is binary (as it could never be edited)
    await h.put('big.txt', 'x'.repeat(2 * 1024 * 1024 + 10))
    await h.history.snapshot(h.pid, 'manual')
    const v3 = (await h.history.list(h.pid, {})).versions[0].id
    expect((await h.history.files(h.pid, v3)).files.find(f => f.path === 'big.txt')).toMatchObject({ binary: true })
  })
})

describe('labels', () => {
  it('creates (after snapshotting), lists and deletes labels, mirrored as git tags', async () => {
    await initWith({ 'main.tex': 'a\n' })
    const v1 = (await h.history.list(h.pid, {})).versions[0].id
    await h.put('main.tex', 'b\n')

    const label = await h.history.createLabel(h.pid, h.alice, '  Submitted to journal  ')
    expect(label).toMatchObject({ name: 'Submitted to journal', user: h.alice })
    expect(label.versionId).not.toBe(v1)
    const top = (await h.history.list(h.pid, {})).versions[0]
    expect(top.id).toBe(label.versionId)
    expect(top.reason).toBe('label')
    expect(h.git(['log', '-1', '--format=%s', label.versionId]).trim()).toBe('Submitted to journal')
    expect(top.labels).toEqual([label])
    expect(h.git(['rev-parse', `refs/tags/folio-${label.id}`]).trim()).toBe(label.versionId)

    // labelling an unchanged state points at HEAD without a new commit; several labels per version
    const again = await h.history.createLabel(h.pid, h.owner, 'Second')
    expect(again.versionId).toBe(label.versionId)
    const old = await h.history.createLabel(h.pid, h.owner, 'First draft', v1.slice(0, 8))
    expect(old.versionId).toBe(v1)
    const { versions } = await h.history.list(h.pid, {})
    expect(versions[0].labels.map(l => l.name).sort()).toEqual(['Second', 'Submitted to journal'])
    expect(versions[1].labels.map(l => l.name)).toEqual(['First draft'])

    h.meta.events.length = 0
    await h.history.deleteLabel(h.pid, label.id)
    expect(h.meta.events).toEqual([{ projectId: h.pid, event: { type: 'history:changed', versionId: label.versionId } }])
    expect((await h.history.list(h.pid, {})).versions[0].labels.map(l => l.name)).toEqual(['Second'])
    expect(() => h.git(['rev-parse', '--verify', '-q', `refs/tags/folio-${label.id}`])).toThrow()
    await expect(h.history.deleteLabel(h.pid, label.id)).rejects.toMatchObject({ status: 404 })

    await expect(h.history.createLabel(h.pid, h.owner, '   ')).rejects.toMatchObject({ status: 400 })
    await expect(h.history.createLabel(h.pid, h.owner, 'x'.repeat(201))).rejects.toMatchObject({ status: 400 })
    await expect(h.history.createLabel(h.pid, h.owner, 'bad', 'f'.repeat(40))).rejects.toMatchObject({ status: 404 })
  })

  it('a label of another project cannot be deleted through this one', async () => {
    await initWith({ 'main.tex': 'a\n' })
    const other = h.db.projects.create({ name: 'Other', ownerId: h.owner.id })
    const l = h.db.labels.create({ projectId: other.id, versionId: 'a'.repeat(40), name: 'x', userId: null })
    await expect(h.history.deleteLabel(h.pid, l.id)).rejects.toBeInstanceOf(HttpError)
    expect(h.db.labels.get(l.id)).not.toBeNull()
  })
})

describe('archive, delete, copy', () => {
  it('streams a valid zip of a version', async () => {
    await initWith({ 'main.tex': 'v1\n', 'img/a.png': PNG_A })
    const v1 = (await h.history.list(h.pid, {})).versions[0].id
    await h.put('main.tex', 'v2\n')
    await h.put('extra.tex', 'extra\n')
    await h.history.snapshot(h.pid, 'manual')

    const zip = await unzip(await collect(await h.history.archive(h.pid, v1)))
    expect([...zip.keys()].sort()).toEqual(['img/a.png', 'main.tex'])
    expect(zip.get('main.tex')!.toString()).toBe('v1\n')
    expect(zip.get('img/a.png')!.equals(PNG_A)).toBe(true)

    // HEAD snapshots pending edits first
    await h.put('main.tex', 'v3 unsaved\n')
    const head = await unzip(await collect(await h.history.archive(h.pid, 'HEAD')))
    expect(head.get('main.tex')!.toString()).toBe('v3 unsaved\n')
    expect([...head.keys()].sort()).toEqual(['extra.tex', 'img/a.png', 'main.tex'])

    // no temp files are left behind
    const tmp = path.join(h.config.dirs.history, '.tmp')
    expect(fs.existsSync(tmp) ? fs.readdirSync(tmp) : []).toEqual([])
    await expect(h.history.archive(h.pid, 'b'.repeat(40))).rejects.toMatchObject({ status: 404 })
  })

  it('deleteProject removes the git dir and ignores later activity', async () => {
    await initWith({ 'main.tex': 'a\n' })
    await h.history.deleteProject(h.pid)
    expect(fs.existsSync(h.gitDir)).toBe(false)
    h.history.noteActivity(h.pid, h.owner.id)
    await h.put('main.tex', 'b\n')
    expect(await h.history.snapshot(h.pid, 'manual')).toBeNull()
    expect(fs.existsSync(h.gitDir)).toBe(false)
  })

  it('copyProject starts a fresh history for the copy', async () => {
    await initWith({ 'main.tex': 'a\n' })
    await h.put('main.tex', 'b\n')
    await h.history.snapshot(h.pid, 'manual')
    const copy = h.db.projects.create({ name: 'Copy', ownerId: h.alice.id })
    const copyDir = path.join(h.config.dirs.projects, copy.id)
    fs.mkdirSync(copyDir)
    fs.writeFileSync(path.join(copyDir, 'main.tex'), 'b\n')
    await h.history.copyProject(h.pid, copy.id, h.alice)
    const { versions } = await h.history.list(copy.id, {})
    expect(versions).toHaveLength(1)
    expect(versions[0]).toMatchObject({ reason: 'import', authors: [h.alice], changes: [{ path: 'main.tex', op: 'added' }] })
    expect(h.git(['log', '-1', '--format=%s']).trim()).not.toContain('Copied') // source untouched
  })

  it('list() lazily starts history for a project without a git dir', async () => {
    await h.put('main.tex', 'a\n')
    const { versions } = await h.history.list(h.pid, {})
    expect(versions).toHaveLength(1)
    expect(versions[0].reason).toBe('import')
    const ghost = await h.history.list('NoSuchProject123', {})
    expect(ghost).toEqual({ versions: [], hasMore: false })
    await expect(h.history.list('../../etc', {})).rejects.toMatchObject({ status: 404 })
  })
})

describe('concurrency', () => {
  it('parallel snapshots and edits never corrupt the repository', async () => {
    await initWith({ 'main.tex': 'start\n' })
    const tasks: Promise<string | null>[] = []
    for (let i = 0; i < 12; i++) {
      await h.put(`f${i}.tex`, `file ${i}\n`)
      tasks.push(h.history.snapshot(h.pid, 'auto'))
      if (i % 3 === 0) tasks.push(h.history.snapshot(h.pid, 'manual', h.owner))
    }
    tasks.push(h.history.list(h.pid, {}).then(() => null))
    tasks.push(h.history.createLabel(h.pid, h.owner, 'mid-flight').then(() => null))
    const results = await Promise.all(tasks)
    const shas = results.filter((x): x is string => !!x)
    expect(new Set(shas).size).toBe(shas.length)

    h.git(['fsck', '--strict', '--no-progress'])
    expect(fs.existsSync(path.join(h.gitDir, 'index.lock'))).toBe(false)
    const files = h.git(['ls-tree', '-r', '--name-only', 'HEAD']).trim().split('\n').sort()
    expect(files).toEqual(['main.tex', ...Array.from({ length: 12 }, (_, i) => `f${i}.tex`)].sort())
    expect(await h.history.snapshot(h.pid, 'auto')).toBeNull()
  })
})

describe('robustness', () => {
  it('removes a stale index.lock left by a crashed git process', async () => {
    await initWith({ 'main.tex': 'a\n' })
    const lock = path.join(h.gitDir, 'index.lock')
    fs.writeFileSync(lock, '')
    const old = new Date(Date.now() - 10 * 60_000)
    fs.utimesSync(lock, old, old)
    await h.put('main.tex', 'b\n')
    expect(await h.history.snapshot(h.pid, 'manual')).toMatch(/^[0-9a-f]{40}$/)
    expect(fs.existsSync(lock)).toBe(false)

    // a fresh lock is respected (another git process may own it): 503 "busy", not a 500
    fs.writeFileSync(lock, '')
    await h.put('main.tex', 'c\n')
    await expect(h.history.snapshot(h.pid, 'manual')).rejects.toMatchObject({ status: 503, code: 'unavailable' })
    fs.rmSync(lock)
    expect(await h.history.snapshot(h.pid, 'manual')).toMatch(/^[0-9a-f]{40}$/)
  })

  it('removes a lock that is older than this process at once (left by a crash before the restart)', async () => {
    await initWith({ 'main.tex': 'a\n' })
    const bootAt = Date.now() - process.uptime() * 1000
    for (const rel of ['index.lock', 'refs/heads/main.lock', 'packed-refs.lock']) {
      const lock = path.join(h.gitDir, rel)
      fs.writeFileSync(lock, '')
      // older than the process, but far younger than the 5-minute age limit
      const t = new Date(bootAt - 2000)
      fs.utimesSync(lock, t, t)
    }
    await h.put('main.tex', 'b\n')
    expect(await h.history.snapshot(h.pid, 'manual')).toMatch(/^[0-9a-f]{40}$/)
    expect(fs.existsSync(path.join(h.gitDir, 'index.lock'))).toBe(false)
    expect(fs.existsSync(path.join(h.gitDir, 'packed-refs.lock'))).toBe(false)
    const restored = await h.history.restore(h.pid, h.owner, (await h.history.list(h.pid, {})).versions[1].id)
    expect(restored.versionId).toMatch(/^[0-9a-f]{40}$/)
  })

  it('a snapshot that fails keeps the pending authors for the next one', async () => {
    await initWith({ 'main.tex': 'a\n' })
    await h.put('main.tex', 'alice edited\n')
    h.history.noteActivity(h.pid, h.alice.id)
    const lock = path.join(h.gitDir, 'index.lock')
    fs.writeFileSync(lock, '')
    await expect(h.history.snapshot(h.pid, 'auto')).rejects.toMatchObject({ status: 503 })
    fs.rmSync(lock)
    const sha = await h.history.snapshot(h.pid, 'auto')
    const top = (await h.history.list(h.pid, {})).versions[0]
    expect(top.id).toBe(sha)
    expect(top.authors.map(a => a.id)).toEqual([h.alice.id])
  })

  it('moves an invalid git dir aside instead of deleting it', async () => {
    await h.put('main.tex', 'a\n')
    fs.mkdirSync(h.gitDir, { recursive: true })
    fs.writeFileSync(path.join(h.gitDir, 'precious'), 'keep me')
    await h.history.init(h.pid, h.owner)
    expect((await h.history.list(h.pid, {})).versions).toHaveLength(1)
    const aside = fs.readdirSync(h.config.dirs.history).filter(n => n.startsWith(`${h.pid}.git.invalid-`))
    expect(aside).toHaveLength(1)
    expect(fs.readFileSync(path.join(h.config.dirs.history, aside[0], 'precious'), 'utf8')).toBe('keep me')
  })

  it('runs git gc --auto after the configured number of commits', async () => {
    await h.cleanup()
    h = await setup({ gcEveryCommits: 3 })
    await initWith({ 'main.tex': 'a\n' })
    for (let i = 0; i < 4; i++) {
      await h.put('main.tex', `edit ${i}\n`)
      await h.history.snapshot(h.pid, 'manual')
    }
    await h.history.shutdown() // waits for the background gc
    h.git(['fsck', '--no-progress'])
    expect((await h.history.list(h.pid, {})).versions).toHaveLength(5)
  })
})

describe('review round 2: crash attribution, restore over empty folders, gc bookkeeping', () => {
  it('crash recovery credits the users of the window pending before the crash and the ones after it (REG-3)', async () => {
    await initWith({ 'main.tex': 'a\n' })
    // alice's edit reached the disk, the idle snapshot never ran (kill -9)
    h.history.noteActivity(h.pid, h.alice.id)
    const pending = path.join(h.gitDir, 'folio-pending.json')
    await waitFor(() => fs.existsSync(pending))
    await h.put('main.tex', 'a\n% ALICE-EDIT\n')

    // a new process: it reads the pending files before listening, then bob reconnects and edits
    const restarted = createHistoryService(h.s)
    try {
      await restarted.loadPendingAuthors()
      restarted.noteActivity(h.pid, h.bob.id)
      await waitFor(() => fs.existsSync(pending) && JSON.parse(fs.readFileSync(pending, 'utf8')).length === 2)
      // bob's arrival must not drop alice from the file
      expect(JSON.parse(fs.readFileSync(pending, 'utf8')).sort()).toEqual([h.alice.id, h.bob.id].sort())
      await h.put('main.tex', 'a\n% ALICE-EDIT\n% BOB-OFFLINE\n')
      expect(await restarted.recoverAfterRestart()).toBe(1)
      const top = (await restarted.list(h.pid, {})).versions[0]
      expect(top.summary).toBe('Recovered after restart')
      expect(top.authors.map(a => a.id).sort()).toEqual([h.alice.id, h.bob.id].sort())
    } finally {
      await restarted.shutdown()
    }
  })

  it('an idle snapshot that runs before the recovery pass also credits the pre-crash users (REG-3)', async () => {
    await initWith({ 'main.tex': 'a\n' })
    h.history.noteActivity(h.pid, h.alice.id)
    const pending = path.join(h.gitDir, 'folio-pending.json')
    await waitFor(() => fs.existsSync(pending))
    await h.put('main.tex', 'a\n% ALICE-EDIT\n')

    const restarted = createHistoryService(h.s, { idleMs: 50 })
    try {
      await restarted.loadPendingAuthors()
      restarted.noteActivity(h.pid, h.bob.id)
      await h.put('main.tex', 'a\n% ALICE-EDIT\n% BOB\n')
      const top = await waitFor(async () => {
        const v = (await restarted.list(h.pid, {})).versions[0]
        return v.reason === 'auto' ? v : null
      })
      expect(top.authors.map(a => a.id).sort()).toEqual([h.alice.id, h.bob.id].sort())
      // credited once: the recovery pass finds nothing left, and the pending file is gone
      expect(await restarted.recoverAfterRestart()).toBe(0)
      await waitFor(() => !fs.existsSync(pending))
    } finally {
      await restarted.shutdown()
    }
  })

  it('a project restore brings back a file whose path is now an empty folder (REG-5)', async () => {
    await initWith({ 'main.tex': 'm\n', 'appendix': 'appendix text\n', 'sec/a.tex': 'section a\n' })
    const v1 = (await h.history.list(h.pid, {})).versions[0].id
    await h.del('appendix')
    await h.del('sec/a.tex')
    await h.files.create(h.pid, null, 'appendix', 'folder')
    await h.files.create(h.pid, null, 'sec/a.tex', 'folder')
    await h.history.snapshot(h.pid, 'manual')
    const res = await h.history.restore(h.pid, h.owner, v1)
    expect(res.restored).toEqual(['appendix', 'sec/a.tex'])
    expect(res.skipped).toBeUndefined()
    expect(h.db.files.getByPath(h.pid, 'appendix')).toMatchObject({ kind: 'text' })
    expect(h.db.files.getByPath(h.pid, 'sec/a.tex')).toMatchObject({ kind: 'text' })
    expect(fs.readFileSync(path.join(h.projectDir, 'appendix'), 'utf8')).toBe('appendix text\n')
    expect(fs.readFileSync(path.join(h.projectDir, 'sec/a.tex'), 'utf8')).toBe('section a\n')
    // an empty folder the version has no file at still stays
    await h.files.create(h.pid, null, 'figures', 'folder')
    await h.history.restore(h.pid, h.owner, v1)
    expect(h.db.files.getByPath(h.pid, 'figures')).toMatchObject({ kind: 'folder' })
  })

  it('packs the repository with git gc when due, with the bookkeeping kept across restarts (PERF-3)', async () => {
    await h.cleanup()
    h = await setup({ gcEveryCommits: 1000, gcIntervalMs: 60 * 60_000, gcMinLooseObjects: 5 })
    await initWith({ 'main.tex': 'a\n' })
    for (let i = 0; i < 3; i++) {
      await h.put('main.tex', `edit ${i}\n`)
      await h.history.snapshot(h.pid, 'manual')
    }
    await h.history.shutdown() // waits for the bookkeeping
    const countObjects = () => Object.fromEntries(h.git(['count-objects', '-v']).trim().split('\n').map(l => l.split(': ')).map(([k, v]) => [k, Number(v)]))
    expect(countObjects().count).toBeGreaterThanOrEqual(5)
    expect(countObjects().packs).toBe(0)
    const gcFile = path.join(h.gitDir, 'folio-gc.json')
    const before = JSON.parse(fs.readFileSync(gcFile, 'utf8'))
    expect(before.commits).toBe(3)
    // the last check was two hours ago (the server restarted several times meanwhile)
    fs.writeFileSync(gcFile, JSON.stringify({ commits: before.commits, lastAt: Date.now() - 2 * 60 * 60_000 }))
    const restarted = createHistoryService(h.s, { gcEveryCommits: 1000, gcIntervalMs: 60 * 60_000, gcMinLooseObjects: 5 })
    try {
      await h.put('main.tex', 'after the restart\n')
      await restarted.snapshot(h.pid, 'manual')
    } finally {
      await restarted.shutdown()
    }
    expect(countObjects()).toMatchObject({ count: 0, packs: 1 })
    expect(JSON.parse(fs.readFileSync(gcFile, 'utf8'))).toMatchObject({ commits: 0 })
    h.git(['fsck', '--no-progress'])
    expect((await h.history.list(h.pid, {})).versions).toHaveLength(5)
  })
})
