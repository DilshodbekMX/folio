import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ProjectDetail } from '@folio/shared/api'
import { toPublic, type UserRecord } from '../../src/db/index.ts'
import {
  APP_ROOT, collectDirectory, collectZip, createExcludeMatcher, DEFAULT_SEED_EXCLUDES, ignoreReason, importProject,
} from '../../src/projects/importer.ts'
import { byPath, createTestServices, type TestContext } from './fakes.ts'
import { Client, makeUser, makeZip, patchBytes, startTestServer, type TestServer } from './helpers.ts'

const PAPER_DIR = path.resolve(fileURLToPath(new URL('../../../..', import.meta.url)))

describe('import rules', () => {
  it('ignores build artefacts, VCS/OS junk and hidden files', () => {
    for (const p of ['main.aux', 'a/b.log', 'x.synctex.gz', 'x.synctex(busy)', 'main.fdb_latexmk', 'main.fls', 'main.bbl', 'main.blg', 'x.xdv', 'x.dvi', 'x.out', 'x.toc',
      '__MACOSX/._main.tex', '.git/config', 'sub/.DS_Store', '.hidden/x.tex', 'venv/lib.py', 'Thumbs.db']) {
      expect(ignoreReason(p), p).not.toBeNull()
    }
    for (const p of ['main.tex', 'refs.bib', 'fig.pdf', '.latexmkrc', 'figures/a.png', 'aux.tex', 'log']) expect(ignoreReason(p), p).toBeNull()
  })

  it('exclude patterns match segments or full paths', () => {
    const m = createExcludeMatcher(['ready', '*.zip', 'docs/private'])
    expect(m('ready/a.tex')).toBe(true)
    expect(m('sub/ready')).toBe(true)
    expect(m('bundle.zip')).toBe(true)
    expect(m('a/b/x.ZIP')).toBe(true)
    expect(m('docs/private/x.tex')).toBe(true)
    expect(m('docs/public/x.tex')).toBe(false)
    expect(m('already.tex')).toBe(false)
  })
})

describe('zip import over HTTP', () => {
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
    form.append('file', new Blob([new Uint8Array(zip)]), name)
    return A.upload('/api/projects/upload', form)
  }
  const projectCount = () => t.services.db.projects.listForUser(alice.id).length

  it('imports a normal zip, strips the single top folder, normalises text, drops junk and the root pdf', async () => {
    const zip = await makeZip([
      { name: 'paper/', dir: true },
      { name: 'paper/main.tex', data: '\uFEFF\\documentclass{article}\r\n\\begin{document}\r\nHi\r\n\\end{document}\r\n' },
      { name: 'paper/main.pdf', data: '%PDF-1.4 stale build' },
      { name: 'paper/main.aux', data: 'aux' },
      { name: 'paper/refs.bib', data: '@misc{x}' },
      { name: 'paper/figs/plot.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0]) },
      { name: 'paper/figs/other.pdf', data: '%PDF-1.4 figure' },
      { name: 'paper/.DS_Store', data: 'junk' },
      { name: '__MACOSX/paper/._main.tex', data: 'junk' },
      { name: 'paper/notes/empty/', dir: true },
    ])
    const r = await upload(zip, 'My Paper.zip')
    expect(r.status).toBe(201)
    const d = (await A.get<ProjectDetail>(`/api/projects/${r.body.id}`)).body
    expect(d.name).toBe('My Paper')
    expect(d.files.map(f => `${f.path}:${f.kind}`).sort()).toEqual([
      'figs/other.pdf:binary', 'figs/plot.png:binary', 'figs:folder', 'main.tex:text', 'notes/empty:folder', 'notes:folder', 'refs.bib:text',
    ])
    expect(d.settings.rootFileId).toBe(byPath(d.files, 'main.tex')!.id)
    const main = await fsp.readFile(path.join(t.services.config.dirs.projects, d.id, 'main.tex'), 'utf8')
    expect(main).toBe('\\documentclass{article}\n\\begin{document}\nHi\n\\end{document}\n')
    expect(t.history.inits).toContain(d.id)
    expect(await fsp.readdir(t.services.config.dirs.tmp)).toEqual([])
  })

  it('picks the shallowest .tex with \\documentclass when there is no main.tex', async () => {
    const zip = await makeZip([
      { name: 'chapters/intro.tex', data: 'Intro' },
      { name: 'sub/standalone.tex', data: '\\documentclass{standalone}' },
      { name: 'paper.tex', data: '% \\documentclass{fake}\n\\documentclass[11pt]{article}\n' },
      { name: 'appendix.tex', data: '%\\documentclass{x}' },
    ])
    const r = await upload(zip)
    expect(r.status).toBe(201)
    const d = (await A.get<ProjectDetail>(`/api/projects/${r.body.id}`)).body
    expect(d.settings.rootFileId).toBe(byPath(d.files, 'paper.tex')!.id)
  })

  it('rejects zip-slip (../) names without writing anything', async () => {
    const before = projectCount()
    const zip = patchBytes(await makeZip([{ name: 'ok.tex', data: 'x' }, { name: 'xx/evil.txt', data: 'pwned' }]), 'xx/evil.txt', '../evil.txt')
    const r = await upload(zip)
    expect(r.status).toBe(400)
    expect(r.body.error.message).toMatch(/unsafe path/i)
    expect(projectCount()).toBe(before)
    expect(fs.existsSync(path.join(t.services.config.dataDir, 'evil.txt'))).toBe(false)
    expect(await fsp.readdir(t.services.config.dirs.tmp)).toEqual([])
  })

  it('rejects absolute paths', async () => {
    const zip = patchBytes(await makeZip([{ name: 'Xtmp/abs-evil.txt', data: 'pwned' }]), 'Xtmp/abs-evil.txt', '/tmp/abs-evil.txt')
    const r = await upload(zip)
    expect(r.status).toBe(400)
    expect(fs.existsSync('/tmp/abs-evil.txt')).toBe(false)
  })

  it('rejects symlink entries', async () => {
    const zip = await makeZip([{ name: 'main.tex', data: 'x' }, { name: 'link.tex', data: '/etc/passwd', mode: 0o120777 }])
    const r = await upload(zip)
    expect(r.status).toBe(400)
    expect(r.body.error.message).toMatch(/symbolic link/)
  })

  it('rejects archives with more than 2000 entries', async () => {
    const entries = Array.from({ length: 2001 }, (_, i) => ({ name: `f${i}.txt`, data: String(i) }))
    const r = await upload(await makeZip(entries))
    expect(r.status).toBe(413)
    expect(r.body.error.code).toBe('too_large')
  })

  it('rejects compression-ratio bombs', async () => {
    const zip = await makeZip([{ name: 'bomb.txt', data: Buffer.alloc(20 * 1024 * 1024) }])
    expect(zip.length).toBeLessThan(100 * 1024)
    const r = await upload(zip)
    expect(r.status).toBe(413)
    expect(r.body.error.message).toMatch(/compression ratio/)
  })

  it('rejects files that are not zips and corrupt archives', async () => {
    expect((await upload(Buffer.from('not a zip at all'))).status).toBe(400)
    const zip = await makeZip([{ name: 'a.tex', data: 'hello world '.repeat(100) }])
    expect((await upload(zip.subarray(0, zip.length - 30))).status).toBe(400)
    const noFile = await A.upload('/api/projects/upload', new FormData())
    expect(noFile.status).toBe(400)
  })

  it('reports invalid names but imports the rest', async () => {
    const ctx = t
    const zipPath = path.join(ctx.services.config.dirs.tmp, 'manual.zip')
    await fsp.writeFile(zipPath, await makeZip([{ name: 'good.tex', data: 'x' }, { name: 'bad*name.tex', data: 'y' }, { name: '.gitignore', data: 'z' }]))
    try {
      const res = await importProject(ctx.services, await collectZip(zipPath, { maxEntryBytes: 1e8 }), { owner: toPublic(alice), name: 'Manual' })
      expect(res.files.map(f => f.path)).toEqual(['good.tex'])
      expect(res.skipped.map(s => `${s.path}:${s.reason}`).sort()).toEqual(['.gitignore:ignored', 'bad*name.tex:invalid-path'])
      expect(res.rootFileId).toBeNull()
    } finally {
      await fsp.rm(zipPath, { force: true })
    }
  })
})

describe('directory import of the real paper (read-only)', () => {
  let ctx: TestContext
  beforeAll(async () => {
    ctx = await createTestServices()
  })
  afterAll(async () => {
    await ctx.cleanup()
  })

  it.skipIf(!fs.existsSync(path.join(PAPER_DIR, 'antiddos_v2.tex')))('imports the paper with the seed exclusions', async () => {
    expect(APP_ROOT).toBe(path.join(PAPER_DIR, 'overleaf'))
    const before = fs.statSync(path.join(PAPER_DIR, 'antiddos_v2.tex')).mtimeMs
    const owner = await makeUser(ctx.services, 'owner@example.com', 'Owner')
    const src = await collectDirectory(PAPER_DIR, { exclude: DEFAULT_SEED_EXCLUDES, skipDirs: [ctx.services.config.dataDir] })
    const res = await importProject(ctx.services, src, {
      owner: toPublic(owner),
      name: 'AntiDDoS Shield v2',
      rootPath: 'antiddos_v2.tex',
      compiler: 'xelatex',
      externalDocs: ['antiddos_v2_supplementary.tex'],
    })
    const report = {
      files: res.textPaths.length + res.binaryPaths.length,
      bytes: res.totalBytes,
      text: res.textPaths,
      binary: res.binaryPaths,
      skipped: res.skipped.map(s => `${s.path} (${s.reason}${s.detail ? `: ${s.detail}` : ''})`),
    }
    if (process.env.FOLIO_IMPORT_REPORT) await fsp.writeFile(process.env.FOLIO_IMPORT_REPORT, JSON.stringify(report, null, 2))
    // 47 files at the time of writing; the user's folder may gain new material, so only assert the core set
    expect(report.files).toBeGreaterThanOrEqual(47)
    for (const p of ['antiddos_v2.tex', 'antiddos_v2_supplementary.tex', 'Definitions/mdpi.cls', 'figures/figure1_intervals.tikz']) {
      expect([...res.textPaths, ...res.binaryPaths]).toContain(p)
    }
    expect(res.rootPath).toBe('antiddos_v2.tex')
    const proj = ctx.services.db.projects.get(res.projectId)!
    expect(proj.settings).toMatchObject({ compiler: 'xelatex', externalDocs: ['antiddos_v2_supplementary.tex'] })
    // classification edge cases from the research
    expect(res.textPaths).toContain('Definitions/mdpi.cls') // stray 0x1C byte, still text
    expect(res.textPaths).toContain('inst') // no extension, sniffed as UTF-8
    expect(res.textPaths).toContain('figures/regenerate_figures.sh')
    expect(res.binaryPaths).toContain('Definitions/logo-mdpi.eps')
    expect(res.binaryPaths).toContain('figures/fig_clock_scatter.png')
    // skipped: app dir, ready/, zips, build outputs, root pdfs
    const skipped = res.skipped.map(s => s.path)
    expect(skipped).toContain('overleaf')
    expect(skipped).toContain('ready')
    expect(skipped).toContain('antiddos_v2_submission.zip')
    expect(skipped).toContain('antiddos_v2.pdf')
    expect(skipped).toContain('antiddos_v2_supplementary.pdf')
    expect(skipped).toContain('antiddos_v2.aux')
    // CRLF normalised (journalnames.tex had 4770 CRLF line endings)
    const jn = await fsp.readFile(path.join(ctx.services.config.dirs.projects, res.projectId, 'Definitions/journalnames.tex'), 'utf8')
    expect(jn.includes('\r')).toBe(false)
    // the source directory was not touched
    expect(fs.statSync(path.join(PAPER_DIR, 'antiddos_v2.tex')).mtimeMs).toBe(before)
  })
})
