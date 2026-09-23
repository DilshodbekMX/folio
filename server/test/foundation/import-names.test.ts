/**
 * Zip entry names: drive-like names such as "a:b.tex" (legal project paths on POSIX) survive
 * import → download.zip → re-import, entry names are decoded like zip tools write them, unsafe
 * names are still refused, and the upload reports what it skipped (CreateProjectResponse.skipped).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { CreateProjectResponse, ProjectDetail } from '@folio/shared/api'
import type { UserRecord } from '../../src/db/index.ts'
import { decodeZipEntryName } from '../../src/projects/importer.ts'
import { Client, makeUser, makeZip, patchBytes, startTestServer, type TestServer } from './helpers.ts'

describe('decodeZipEntryName', () => {
  const plain = { generalPurposeBitFlag: 0, extraFields: [] }
  const utf8Flag = { generalPurposeBitFlag: 0x800, extraFields: [] }
  it('decodes flagged UTF-8, unflagged UTF-8 and CP437 names', () => {
    expect(decodeZipEntryName(utf8Flag, Buffer.from('Kapitel/Über.tex'))).toBe('Kapitel/Über.tex')
    expect(decodeZipEntryName(plain, Buffer.from('Kapitel/Über.tex'))).toBe('Kapitel/Über.tex')
    // 0x81 is 'ü' in CP437 and not valid UTF-8 on its own
    expect(decodeZipEntryName(plain, Buffer.from([0x81, 0x2e, 0x74, 0x65, 0x78]))).toBe('ü.tex')
    expect(decodeZipEntryName(plain, Buffer.from('win\\path\\a.tex'))).toBe('win/path/a.tex')
    expect(decodeZipEntryName(plain, Buffer.from('a:b.tex'))).toBe('a:b.tex')
    expect(decodeZipEntryName(plain, Buffer.from('C:/notes/x.tex'))).toBe('C:/notes/x.tex')
  })
  it('refuses absolute, parent and NUL names', () => {
    expect(() => decodeZipEntryName(plain, Buffer.from('/etc/passwd'))).toThrow(/absolute/)
    expect(() => decodeZipEntryName(plain, Buffer.from('a/../../x'))).toThrow(/relative/)
    expect(() => decodeZipEntryName(plain, Buffer.from('..\\x'))).toThrow(/relative/)
    expect(() => decodeZipEntryName(plain, Buffer.from('a\u0000b'))).toThrow(/NUL/)
  })
})

describe('zip upload names and skipped report', () => {
  let t: TestServer
  let alice: UserRecord
  let A: Client

  beforeAll(async () => {
    t = await startTestServer()
    alice = await makeUser(t.services, 'alice@example.com', 'Alice')
    A = Client.as(t, alice)
  })
  afterAll(async () => {
    await t.close()
  })

  async function upload(zip: Buffer, name = 'upload.zip') {
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(zip)], { type: 'application/zip' }), name)
    return A.upload<CreateProjectResponse>('/api/projects/upload', form)
  }

  it('imports "a:b.tex", exports it and re-imports the export unchanged', async () => {
    const zip = patchBytes(await makeZip([
      { name: 'main.tex', data: '\\documentclass{article}\\begin{document}\\input{a:b}\\end{document}' },
      { name: 'x_b.tex', data: 'drive-like name' },
      { name: 'figs/c:d.txt', data: 'nested colon' },
    ]), 'x_b.tex', 'a:b.tex')
    const r = await upload(zip)
    expect(r.status).toBe(201)
    expect(r.body.skipped).toBeUndefined()
    const d = (await A.get<ProjectDetail>(`/api/projects/${r.body.id}`)).body
    expect(d.files.map(f => f.path).sort()).toEqual(['a:b.tex', 'figs', 'figs/c:d.txt', 'main.tex'])

    const dl = await A.bytes(`/api/projects/${r.body.id}/download.zip`)
    expect(dl.status).toBe(200)
    const entries = await readZipLenient(dl.data)
    expect(entries.get('a:b.tex')?.toString()).toBe('drive-like name')
    expect(entries.get('figs/c:d.txt')?.toString()).toBe('nested colon')

    const again = await upload(dl.data, 'roundtrip.zip')
    expect(again.status).toBe(201)
    const d2 = (await A.get<ProjectDetail>(`/api/projects/${again.body.id}`)).body
    expect(d2.files.map(f => f.path).sort()).toEqual(d.files.map(f => f.path).sort())
    expect(d2.settings.rootFileId).toBe(d2.files.find(f => f.path === 'main.tex')!.id)
  })

  it('still rejects zip-slip names', async () => {
    const zip = patchBytes(await makeZip([{ name: 'ok.tex', data: 'x' }, { name: 'xx/evil.txt', data: 'pwned' }]), 'xx/evil.txt', '../evil.txt')
    const r = await upload(zip)
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({ error: { message: expect.stringMatching(/unsafe path/i) } })
  })

  it('reports skipped entries with readable reasons', async () => {
    const zip = await makeZip([
      { name: 'paper/main.tex', data: '\\documentclass{article}\\begin{document}x\\end{document}' },
      { name: 'paper/main.aux', data: 'aux' },
      { name: 'paper/main.pdf', data: '%PDF-1.5' },
      { name: 'paper/.DS_Store', data: 'x' },
      { name: 'paper/bad*name.tex', data: 'x' },
    ])
    const r = await upload(zip)
    expect(r.status).toBe(201)
    const skipped = Object.fromEntries((r.body.skipped ?? []).map(s => [s.path, s.reason]))
    expect(Object.keys(skipped).sort()).toEqual(['paper/.DS_Store', 'paper/bad*name.tex', 'paper/main.aux', 'paper/main.pdf'].sort())
    expect(skipped['paper/main.aux']).toMatch(/build artefact \(\.aux\)/)
    expect(skipped['paper/.DS_Store']).toMatch(/\.DS_Store/)
    expect(skipped['paper/bad*name.tex']).toMatch(/^invalid name: .*forbidden character/)
    expect(skipped['paper/main.pdf']).toMatch(/build output/)
    const d = (await A.get<ProjectDetail>(`/api/projects/${r.body.id}`)).body
    expect(d.files.map(f => f.path)).toEqual(['main.tex'])
  })
})

/** readZip with yauzl's strict name check disabled (it refuses "a:b.tex" like the old importer did). */
async function readZipLenient(buf: Buffer): Promise<Map<string, Buffer>> {
  const yauzl = (await import('yauzl')).default
  const zip = await yauzl.fromBufferPromise(buf, { decodeStrings: false })
  const out = new Map<string, Buffer>()
  for await (const e of zip.eachEntry()) {
    const name = (e.fileName as unknown as Buffer).toString('utf8')
    if (name.endsWith('/')) continue
    const stream = await zip.openReadStreamPromise(e)
    const chunks: Buffer[] = []
    for await (const c of stream) chunks.push(c as Buffer)
    out.set(name, Buffer.concat(chunks))
  }
  zip.close()
  return out
}

