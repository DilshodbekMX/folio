/**
 * Non-ASCII and decomposed (NFD, as macOS file names arrive) paths through every route that
 * takes a path (ACC-13): they are stored and served as NFC; a non-ASCII main document compiles
 * and publishes sanitised output names; search finds its text; download.zip marks its names
 * UTF-8.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CompileResponse, FileEntry, HistoryDiffResponse, HistoryListResponse, MoveEntryResponse, SearchResponse, UploadResponse } from '@folio/shared/api'
import type { UserRecord } from '../../src/db/index.ts'
import { Client, formWith } from '../foundation/helpers.ts'
import { startFullServer, type FullServer } from './harness.ts'

const nfd = (s: string) => s.normalize('NFD')

describe('NFD / non-ASCII paths', () => {
  let t: FullServer
  let alice: UserRecord
  let A: Client
  let pid: string

  beforeAll(async () => {
    t = await startFullServer()
    alice = await t.makeUser('alice@example.com', 'Alice Admin')
    A = Client.as(t, alice)
    const r = await A.post('/api/projects', { name: 'Unicode', template: 'blank' })
    expect(r.status).toBe(201)
    pid = r.body.id
  })
  afterAll(async () => {
    await t.close()
  })

  it('create, move and upload store NFC paths, on disk too', async () => {
    expect(nfd('Résumé.tex')).not.toBe('Résumé.tex')
    const created = await A.post<FileEntry>(`/api/projects/${pid}/files`, { path: nfd('Kapitel ü/Résumé.tex'), kind: 'text', content: 'Grüße aus dem Kapitel\n' })
    expect(created.status).toBe(201)
    expect(created.body.path).toBe('Kapitel ü/Résumé.tex')
    expect(t.services.files.getByPath(pid, 'Kapitel ü')?.kind).toBe('folder')
    expect(t.services.files.getByPath(pid, 'Kapitel ü/Résumé.tex')?.id).toBe(created.body.id)

    const moved = await A.patch<MoveEntryResponse>(`/api/projects/${pid}/files/${created.body.id}`, { path: nfd('Kapitel ü/Chapitre é.tex') })
    expect(moved.status).toBe(200)
    expect(moved.body.files.map(f => f.path)).toContain('Kapitel ü/Chapitre é.tex')

    const up = await A.upload<UploadResponse>(`/api/projects/${pid}/upload`, formWith([{ name: nfd('Notizen ä.txt'), data: 'Notiz\n' }], { folder: nfd('Données') }))
    expect(up.status).toBe(200)
    expect(up.body.files.map(f => f.path)).toContain('Données/Notizen ä.txt')
    const all = t.services.files.list(pid).map(f => f.path)
    for (const p of all) expect(p).toBe(p.normalize('NFC'))
    // the collaborative text is readable under its NFC path
    const f = t.services.files.getByPath(pid, 'Kapitel ü/Chapitre é.tex')!
    expect(await t.services.collab.getText(pid, f.id)).toBe('Grüße aus dem Kapitel\n')
  })

  it('history file and diff take an NFD path and answer with the NFC one', async () => {
    expect((await A.post(`/api/projects/${pid}/history/snapshot`)).status).toBe(200)
    const [v] = (await A.get<HistoryListResponse>(`/api/projects/${pid}/history/versions`)).body.versions
    const q = encodeURIComponent(nfd('Kapitel ü/Chapitre é.tex'))
    const diff = await A.get<HistoryDiffResponse>(`/api/projects/${pid}/history/diff?to=${v.id}&path=${q}`)
    expect(diff.status).toBe(200)
    expect(diff.body.path).toBe('Kapitel ü/Chapitre é.tex')
    expect(diff.body.newText).toBe('Grüße aus dem Kapitel\n')
    const file = await A.bytes(`/api/projects/${pid}/history/versions/${v.id}/file?path=${q}`)
    expect(file.status).toBe(200)
    expect(file.data.toString('utf8')).toBe('Grüße aus dem Kapitel\n')
  })

  it('search finds text in non-ASCII files, with NFC paths', async () => {
    const r = await A.get<SearchResponse>(`/api/projects/${pid}/search?q=${encodeURIComponent('Grüße')}`)
    expect(r.status).toBe(200)
    expect(r.body.results.map(x => x.path)).toEqual(['Kapitel ü/Chapitre é.tex'])
  })

  it('a non-ASCII main document compiles and publishes sanitised output names', async () => {
    const main = await A.post<FileEntry>(`/api/projects/${pid}/files`, {
      path: nfd('Résumé paper.tex'), kind: 'text', content: '\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n',
    })
    expect(main.body.path).toBe('Résumé paper.tex')
    const r = await A.post<CompileResponse>(`/api/projects/${pid}/compile`, { rootFileId: main.body.id })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ status: 'success', rootPath: 'Résumé paper.tex', jobname: 'Résumé paper' })
    expect(r.body.pdfUrl).toMatch(/\/R_sum__paper\.pdf$/)
    expect((await A.bytes(r.body.pdfUrl!)).status).toBe(200)
  })

  it('download.zip names are UTF-8 (general purpose flag 0x800)', async () => {
    const zip = await A.bytes(`/api/projects/${pid}/download.zip`)
    expect(zip.status).toBe(200)
    const yauzl = await import('yauzl')
    const z = await yauzl.fromBufferPromise(zip.data, { lazyEntries: true, decodeStrings: false })
    const names: string[] = []
    try {
      for await (const e of z.eachEntry()) {
        const name = new TextDecoder('utf-8', { fatal: true }).decode(e.fileName as unknown as Buffer)
        names.push(name)
        if (/[^\x20-\x7e]/.test(name)) expect(e.generalPurposeBitFlag & 0x800, name).toBe(0x800)
      }
    } finally {
      z.close()
    }
    expect(names).toEqual(expect.arrayContaining(['Kapitel ü/Chapitre é.tex', 'Données/Notizen ä.txt', 'Résumé paper.tex']))
  })
})
