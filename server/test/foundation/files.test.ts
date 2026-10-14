import fsp from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FileEntry, ProjectDetail } from '@folio/shared/api'
import type { UserRecord } from '../../src/db/index.ts'
import { HttpError } from '../../src/http/errors.ts'
import { byPath } from './fakes.ts'
import { Client, formWith, makeUser, startTestServer, type TestServer } from './helpers.ts'

describe('files', () => {
  let t: TestServer
  let alice: UserRecord
  let A: Client
  let pid: string
  let root: string

  const files = async (): Promise<FileEntry[]> => (await A.get<ProjectDetail>(`/api/projects/${pid}`)).body.files
  const disk = (p: string) => fsp.readFile(path.join(root, p))

  beforeAll(async () => {
    t = await startTestServer()
    alice = await makeUser(t.services, 'alice@example.com', 'Alice')
    A = Client.as(t, alice)
    pid = (await A.post('/api/projects', { name: 'Files', template: 'blank' })).body.id
    root = path.join(t.services.config.dirs.projects, pid)
  })
  afterAll(async () => {
    await t.close()
  })

  it('creates text docs (normalised) and folders, with parents and notifications', async () => {
    t.meta.events.length = 0
    const r = await A.post(`/api/projects/${pid}/files`, { path: 'chapters/one/intro.tex', kind: 'text', content: '\uFEFFa\r\nb\rc' })
    expect(r.status).toBe(201)
    expect(r.body).toMatchObject({ path: 'chapters/one/intro.tex', kind: 'text', size: 5, epoch: 0 })
    expect((await disk('chapters/one/intro.tex')).toString()).toBe('a\nb\nc')
    const all = await files()
    expect(byPath(all, 'chapters')?.kind).toBe('folder')
    expect(byPath(all, 'chapters/one')?.kind).toBe('folder')
    const ev = t.meta.eventsOf(pid, 'files:changed')[0] as { changed: FileEntry[]; deletedIds: string[]; by?: unknown }
    expect(ev.changed.map(f => f.path)).toEqual(['chapters', 'chapters/one', 'chapters/one/intro.tex'])
    // the event names who did it (collaborators' notices: "deleted by Alice")
    expect(ev.by).toEqual({ id: alice.id, name: 'Alice', email: 'alice@example.com', color: alice.color })
    expect(t.meta.syncedFiles).toContain(pid)
    expect(t.history.activity).toContainEqual({ projectId: pid, userId: alice.id })
    expect(t.services.db.projects.get(pid)!.lastUpdatedBy).toBe(alice.id)

    expect((await A.post(`/api/projects/${pid}/files`, { path: 'chapters/one/intro.tex', kind: 'text' })).status).toBe(409)
    expect((await A.post(`/api/projects/${pid}/files`, { path: 'chapters/one/intro.tex/x.tex', kind: 'text' })).status).toBe(409)
    for (const bad of ['../evil.tex', '.git/config', 'a/./b.tex', 'x*.tex', ' lead.tex', '__proto__', '.folio-x']) {
      const res = await A.post(`/api/projects/${pid}/files`, { path: bad, kind: 'text' })
      expect(res.status, bad).toBe(400)
    }
    const f = await A.post(`/api/projects/${pid}/files`, { path: 'figures', kind: 'folder' })
    expect(f.status).toBe(201)
    expect((await fsp.stat(path.join(root, 'figures'))).isDirectory()).toBe(true)
  })

  it('moves and renames files and folders with their descendants', async () => {
    const all = await files()
    const folder = byPath(all, 'chapters')!
    const intro = byPath(all, 'chapters/one/intro.tex')!
    const r = await A.patch(`/api/projects/${pid}/files/${folder.id}`, { path: 'parts/chapters' })
    expect(r.status).toBe(200)
    expect(t.meta.eventsOf(pid, 'files:changed').at(-1)).toMatchObject({ by: { id: alice.id, name: 'Alice' } })
    expect(r.body.files.map((f: FileEntry) => f.path).sort()).toEqual(['parts', 'parts/chapters', 'parts/chapters/one', 'parts/chapters/one/intro.tex'])
    const after = await files()
    expect(byPath(after, 'parts/chapters/one/intro.tex')!.id).toBe(intro.id)
    expect(byPath(after, 'chapters')).toBeUndefined()
    expect((await disk('parts/chapters/one/intro.tex')).toString()).toBe('a\nb\nc')
    await expect(fsp.access(path.join(root, 'chapters'))).rejects.toThrow()
    expect(t.collab.flushed).toContain(pid)

    // rename a file, keep id
    const mv = await A.patch(`/api/projects/${pid}/files/${intro.id}`, { path: 'parts/intro.tex' })
    expect(mv.status).toBe(200)
    expect(mv.body.files).toEqual([expect.objectContaining({ id: intro.id, path: 'parts/intro.tex' })])
    // conflicts and invalid moves
    const main = byPath(after, 'main.tex')!
    expect((await A.patch(`/api/projects/${pid}/files/${main.id}`, { path: 'parts/intro.tex' })).status).toBe(409)
    const parts = byPath(after, 'parts')!
    expect((await A.patch(`/api/projects/${pid}/files/${parts.id}`, { path: 'parts/inner' })).status).toBe(400)
    expect((await A.patch(`/api/projects/${pid}/files/${main.id}`, { path: '../main.tex' })).status).toBe(400)
    expect((await A.patch(`/api/projects/${pid}/files/AAAAAAAAAAAAAAAA`, { path: 'z.tex' })).status).toBe(404)
  })

  it('deletes files and folders (descendants too), discarding Y state and clearing the root doc', async () => {
    const all = await files()
    const parts = byPath(all, 'parts')!
    const intro = byPath(all, 'parts/intro.tex')!
    // a history snapshot that cannot be taken refuses the delete: nothing is removed
    t.history.failBeforeDelete = new HttpError(503, 'unavailable', 'The project history is busy. Please try again in a moment.')
    const refused = await A.del(`/api/projects/${pid}/files/${parts.id}`)
    t.history.failBeforeDelete = null
    expect(refused.status).toBe(503)
    expect(byPath(await files(), 'parts/intro.tex')).toBeDefined()
    expect(t.collab.discarded.some(d => d.fileId === intro.id)).toBe(false)
    t.history.beforeDelete.length = 0
    const r = await A.del(`/api/projects/${pid}/files/${parts.id}`)
    expect(r.status).toBe(200)
    // history was asked to keep the folder's content first, while it still existed
    expect(t.history.beforeDelete).toEqual([{ projectId: pid, paths: ['parts'], replace: false }])
    expect(r.body.deletedIds).toContain(parts.id)
    expect(r.body.deletedIds).toContain(intro.id)
    expect(r.body.deletedIds.length).toBe(4)
    expect(t.collab.discarded).toContainEqual({ projectId: pid, fileId: intro.id, code: 4410 })
    await expect(fsp.access(path.join(root, 'parts'))).rejects.toThrow()
    const ev = t.meta.eventsOf(pid, 'files:changed').at(-1) as { deletedIds: string[]; by?: { id: string } }
    expect(ev.deletedIds.length).toBe(4)
    expect(ev.by?.id).toBe(alice.id)

    const main = byPath(all, 'main.tex')!
    expect(t.services.db.projects.get(pid)!.settings.rootFileId).toBe(main.id)
    expect((await A.del(`/api/projects/${pid}/files/${main.id}`)).status).toBe(200)
    expect(t.services.db.projects.get(pid)!.settings.rootFileId).toBeNull()
    expect(t.meta.eventsOf(pid, 'project:settings').at(-1)).toMatchObject({ settings: { rootFileId: null } })
  })

  it('uploads text, binary, replacements, and relative paths', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])
    const r = await A.upload(`/api/projects/${pid}/upload`, formWith([
      { name: 'main.tex', data: '\\documentclass{article}\r\n\\begin{document}Hi\\end{document}\r\n' },
      { name: 'img/logo.png', data: png },
      { name: 'data/notes', data: 'plain text without extension' },
      { name: 'blob.bin', data: Buffer.from([0, 1, 2, 3]) },
      { name: 'Ünïcode name.tex', data: 'x' },
    ]))
    expect(r.status).toBe(200)
    const up = r.body.files as FileEntry[]
    expect(up.map(f => `${f.path}:${f.kind}`)).toEqual(['main.tex:text', 'img/logo.png:binary', 'data/notes:text', 'blob.bin:binary', 'Ünïcode name.tex:text'])
    expect((await disk('main.tex')).toString()).toBe('\\documentclass{article}\n\\begin{document}Hi\\end{document}\n')
    expect(await disk('img/logo.png')).toEqual(png)
    expect(byPath(await files(), 'img')?.kind).toBe('folder')

    // into a folder
    const r2 = await A.upload(`/api/projects/${pid}/upload`, formWith([{ name: 'deep/a.bib', data: '@misc{a}' }], { folder: 'img' }))
    expect(r2.status).toBe(200)
    expect(r2.body.files[0].path).toBe('img/deep/a.bib')

    // existing without replace → 409 listing the paths, nothing written
    const r3 = await A.upload(`/api/projects/${pid}/upload`, formWith([{ name: 'main.tex', data: 'new' }, { name: 'fresh.tex', data: 'y' }]))
    expect(r3.status).toBe(409)
    expect(r3.body.error.details.existing).toEqual(['main.tex'])
    expect(byPath(await files(), 'fresh.tex')).toBeUndefined()

    // replace a text file with text → through collab.setText (same id, same epoch)
    const main = byPath(await files(), 'main.tex')!
    t.collab.setTextCalls.length = 0
    t.history.beforeDelete.length = 0
    const r4 = await A.upload(`/api/projects/${pid}/upload`, formWith([{ name: 'main.tex', data: 'replaced\r\n' }], { replace: 'true' }))
    expect(r4.status).toBe(200)
    // what it held is committed to history first
    expect(t.history.beforeDelete).toEqual([{ projectId: pid, paths: ['main.tex'], replace: true }])
    expect(r4.body.files[0]).toMatchObject({ id: main.id, epoch: main.epoch, size: 9 })
    expect(t.collab.setTextCalls).toEqual([{ projectId: pid, fileId: main.id, text: 'replaced\n' }])
    expect((await disk('main.tex')).toString()).toBe('replaced\n')

    // replace text with binary content → kind change bumps the epoch and discards Y state
    const r5 = await A.upload(`/api/projects/${pid}/upload`, formWith([{ name: 'data/notes', data: Buffer.from([0xff, 0xfe, 0x00, 0x01]) }], { replace: 'true' }))
    expect(r5.status).toBe(200)
    const notes = r5.body.files[0] as FileEntry
    expect(notes.kind).toBe('binary')
    expect(notes.epoch).toBe(1)
    expect(t.collab.discarded).toContainEqual({ projectId: pid, fileId: notes.id, code: 4409 })

    // binary over binary
    const r6 = await A.upload(`/api/projects/${pid}/upload`, formWith([{ name: 'img/logo.png', data: Buffer.from([1, 2, 3]) }], { replace: 'true' }))
    expect(r6.body.files[0].size).toBe(3)

    // invalid names and a folder target are rejected
    expect((await A.upload(`/api/projects/${pid}/upload`, formWith([{ name: '../escape.tex', data: 'x' }]))).status).toBe(400)
    expect((await A.upload(`/api/projects/${pid}/upload`, formWith([{ name: '.git/hooks/pre-commit', data: 'x' }]))).status).toBe(400)
    expect((await A.upload(`/api/projects/${pid}/upload`, formWith([{ name: 'img', data: 'x' }], { replace: 'true' }))).status).toBe(409)
    expect((await A.upload(`/api/projects/${pid}/upload`, formWith([{ name: 'x.tex', data: 'x' }], { folder: 'main.tex' }))).status).toBe(409)
    expect((await A.upload(`/api/projects/${pid}/upload`, new FormData())).status).toBe(400)
    // temp files are cleaned up
    const tmp = await fsp.readdir(t.services.config.dirs.tmp)
    expect(tmp.filter(n => n.startsWith('upload-'))).toEqual([])
  })

  it('converts text in a Windows encoding to UTF-8, also when it replaces a read-only copy', async () => {
    // Windows-1252: curly quotes and é, and an inputenc declaration that must now say utf8
    const win = Buffer.from([...Buffer.from('\\usepackage[latin1]{inputenc}\r\n% \x93quoted\x94 caf\xe9\r\n', 'latin1')])
    const r = await A.upload(`/api/projects/${pid}/upload`, formWith([{ name: 'win.tex', data: win }]))
    expect(r.status).toBe(200)
    expect(r.body.files[0]).toMatchObject({ path: 'win.tex', kind: 'text' })
    expect((await disk('win.tex')).toString()).toBe('\\usepackage[utf8]{inputenc}\n% “quoted” café\n')

    // a file stored read-only before conversion existed becomes editable when uploaded again
    await fsp.writeFile(path.join(root, 'old.bst'), win)
    const old = t.services.db.files.create({ projectId: pid, path: 'old.bst', kind: 'binary', size: win.length })
    const r2 = await A.upload(`/api/projects/${pid}/upload`, formWith([{ name: 'old.bst', data: win }], { replace: 'true' }))
    expect(r2.status).toBe(200)
    expect(r2.body.files[0]).toMatchObject({ id: old.id, kind: 'text', epoch: old.epoch + 1 })
    expect((await disk('old.bst')).toString()).toContain('“quoted” café')
  })

  it('rejects uploads larger than MAX_UPLOAD_MB with 413', async () => {
    const small = await startTestServer({ MAX_UPLOAD_MB: '1' })
    try {
      const u = await makeUser(small.services, 'x@example.com')
      const c = Client.as(small, u)
      const p = (await c.post('/api/projects', { name: 'P', template: 'blank' })).body.id
      const r = await c.upload(`/api/projects/${p}/upload`, formWith([{ name: 'big.bin', data: Buffer.alloc(1024 * 1024 + 10) }]))
      expect(r.status).toBe(413)
      expect(r.body.error.code).toBe('too_large')
    } finally {
      await small.close()
    }
  })

  it('serves raw files with safe headers', async () => {
    await A.upload(`/api/projects/${pid}/upload`, formWith([
      { name: 'evil.svg', data: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' },
      { name: 'pic.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]) },
      { name: 'doc.pdf', data: Buffer.from('%PDF-1.4\n%\xff\xff\n') },
      { name: 'page.html', data: Buffer.from([0x3c, 0x68, 0xff, 0xfe]) },
    ]))
    const all = await files()
    const get = (p: string, q = '') => A.bytes(`/api/projects/${pid}/files/${byPath(all, p)!.id}/raw${q}`)

    const svg = await get('evil.svg')
    expect(svg.status).toBe(200)
    expect(svg.headers.get('content-type')).toBe('image/svg+xml')
    expect(svg.headers.get('content-disposition')).toMatch(/^attachment; filename="evil.svg"/)
    expect(svg.headers.get('content-security-policy')).toContain('sandbox')
    expect(svg.headers.get('x-content-type-options')).toBe('nosniff')

    const png = await get('pic.png')
    expect(png.headers.get('content-type')).toBe('image/png')
    expect(png.headers.get('content-disposition')).toMatch(/^inline/)
    expect(png.headers.get('content-security-policy')).toContain('sandbox')
    const pngDl = await get('pic.png', '?download=1')
    expect(pngDl.headers.get('content-disposition')).toMatch(/^attachment/)

    const pdf = await get('doc.pdf')
    expect(pdf.headers.get('content-type')).toBe('application/pdf')
    expect(pdf.headers.get('content-disposition')).toMatch(/^inline/)

    const html = await get('page.html')
    expect(byPath(all, 'page.html')!.kind).toBe('binary')
    expect(html.headers.get('content-type')).toBe('application/octet-stream')
    expect(html.headers.get('content-disposition')).toMatch(/^attachment/)

    const tex = await get('main.tex')
    expect(tex.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(tex.headers.get('content-disposition')).toMatch(/^attachment/)
    expect(tex.data.toString()).toBe('replaced\n')
    expect((await get('img')).status).toBe(400)
  })

  it('refuses to follow symlinks planted in the project directory', async () => {
    const outside = path.join(t.dataDir, 'outside.txt')
    await fsp.writeFile(outside, 'secret')
    await fsp.symlink(outside, path.join(root, 'link.tex'))
    const r = await A.post(`/api/projects/${pid}/files`, { path: 'link.tex', kind: 'text', content: 'overwrite?' })
    // the db has no row, the path is a symlink on disk: replaced atomically, the target untouched
    expect(r.status).toBe(201)
    expect(await fsp.readFile(outside, 'utf8')).toBe('secret')
    expect((await fsp.lstat(path.join(root, 'link.tex'))).isSymbolicLink()).toBe(false)

    await fsp.mkdir(path.join(t.dataDir, 'outdir'))
    await fsp.symlink(path.join(t.dataDir, 'outdir'), path.join(root, 'linkdir'))
    const r2 = await A.post(`/api/projects/${pid}/files`, { path: 'linkdir/x.tex', kind: 'text', content: 'x' })
    expect(r2.status).toBe(400)
    expect(await fsp.readdir(path.join(t.dataDir, 'outdir'))).toEqual([])
    // raw reads never follow a link either
    const f = t.services.db.files.create({ projectId: pid, path: 'sneaky.bin', kind: 'binary', size: 6 })
    await fsp.symlink(outside, path.join(root, 'sneaky.bin'))
    const sneaky = await A.bytes(`/api/projects/${pid}/files/${f.id}/raw`)
    expect([400, 404]).toContain(sneaky.status)
    expect(sneaky.data.toString()).not.toContain('secret')
  })
})
