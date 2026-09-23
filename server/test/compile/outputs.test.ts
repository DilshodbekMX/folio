/**
 * Build outputs: id format, strict resolveBuildFile validation, retention, publishing rules;
 * plus the pure helpers of the compile module (docker argv, texcount parser, xr resolution).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  BUILD_ID_RE, buildTimestamp, listBuildIds, MAX_RECENT_BUILDS, newBuildId, outputType, publishBuild, publishedName, pruneBuilds,
  resolveBuildFileIn,
} from '../../src/compile/outputs.ts'
import { buildDockerArgs } from '../../src/compile/sandbox.ts'
import { latexmkArgv, mapContainerPath } from '../../src/compile/runner.ts'
import { parseTexcount } from '../../src/compile/wordcount.ts'
import {
  documentDependencies, fallbackExternalDocuments, fallbackHasDocumentclass, importedLabelsHash, jobnameOf, outputPath, resolveExternalDocs,
} from '../../src/compile/external.ts'
import { gsPreviewArgv, isPng } from '../../src/compile/preview.ts'

let tmp: string
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-outputs-test-')) })
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }) })

const PID = 'Abc_def-12345678'

describe('build ids and names', () => {
  it('generates ids that validate and encode their time', () => {
    const now = Date.now()
    const id = newBuildId(now)
    expect(id).toMatch(BUILD_ID_RE)
    expect(buildTimestamp(id)).toBe(now)
    expect(buildTimestamp('nope')).toBeNaN()
  })

  it('sanitises published names and derives output types', () => {
    expect(publishedName('main.pdf')).toBe('main.pdf')
    expect(publishedName('my paper.pdf')).toBe('my_paper.pdf')
    expect(publishedName('.hidden.log')).toBe('_hidden.log')
    expect(publishedName('é$x.log')).toBe('__x.log')
    expect(outputType('main.synctex.gz')).toBe('synctex.gz')
    expect(outputType('main.PDF')).toBe('pdf')
    expect(outputType('main.blg')).toBe('blg')
  })
})

describe('resolveBuildFileIn', () => {
  let buildId: string
  beforeEach(() => {
    buildId = newBuildId()
    fs.mkdirSync(path.join(tmp, PID, buildId), { recursive: true })
    fs.writeFileSync(path.join(tmp, PID, buildId, 'main.pdf'), '%PDF')
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret')
    fs.writeFileSync(path.join(tmp, PID, buildId, '.hidden'), 'x')
  })

  it('returns the path of an existing output', () => {
    expect(resolveBuildFileIn(tmp, PID, buildId, 'main.pdf')).toBe(path.join(tmp, PID, buildId, 'main.pdf'))
  })

  it('rejects traversal, bad ids, dot-files, directories and missing files', () => {
    for (const f of ['../secret.txt', '..', '.', '../../secret.txt', 'a/b', 'main.pdf/', '.hidden', 'x\u0000y', '%2e%2e', 'missing.pdf', '']) {
      expect(resolveBuildFileIn(tmp, PID, buildId, f), f).toBeNull()
    }
    expect(resolveBuildFileIn(tmp, PID, '..', 'secret.txt')).toBeNull()
    expect(resolveBuildFileIn(tmp, PID, 'abcdef12-0123', 'main.pdf')).toBeNull()
    expect(resolveBuildFileIn(tmp, PID, buildId.toUpperCase(), 'main.pdf')).toBeNull()
    expect(resolveBuildFileIn(tmp, '../x', buildId, 'main.pdf')).toBeNull()
    expect(resolveBuildFileIn(tmp, 'a/b', buildId, 'main.pdf')).toBeNull()
  })

  it('rejects symlinks (file, build dir and project dir)', () => {
    fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(tmp, PID, buildId, 'link.log'))
    expect(resolveBuildFileIn(tmp, PID, buildId, 'link.log')).toBeNull()
    const other = newBuildId()
    fs.symlinkSync(path.join(tmp, PID, buildId), path.join(tmp, PID, other))
    expect(resolveBuildFileIn(tmp, PID, other, 'main.pdf')).toBeNull()
    fs.mkdirSync(path.join(tmp, 'real', buildId), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'real', buildId, 'main.pdf'), 'x')
    fs.symlinkSync(path.join(tmp, 'real'), path.join(tmp, 'Zzz_linked_proj1'))
    expect(resolveBuildFileIn(tmp, 'Zzz_linked_proj1', buildId, 'main.pdf')).toBeNull()
  })
})

describe('retention', () => {
  it('keeps the newest 5, anything younger than 30 min, and pinned ids', async () => {
    const dir = path.join(tmp, PID)
    const now = Date.now()
    const ids: string[] = []
    // 8 old builds (2 h … 2 h + 7 min ago) and 2 recent ones
    for (let i = 0; i < 8; i++) ids.push(newBuildId(now - 2 * 3600_000 - i * 60_000))
    ids.push(newBuildId(now - 5 * 60_000), newBuildId(now - 60_000))
    for (const id of ids) fs.mkdirSync(path.join(dir, id), { recursive: true })
    fs.mkdirSync(path.join(dir, 'not-a-build'))
    const pinned = ids[7] // the oldest
    const removed = await pruneBuilds(dir, { keep: [pinned], now })
    const left = await listBuildIds(dir)
    // newest first: 2 recent + 3 newest old ones are the newest 5; the pinned one survives too
    expect(left).toEqual([ids[9], ids[8], ids[0], ids[1], ids[2], pinned])
    expect(removed.sort()).toEqual([ids[3], ids[4], ids[5], ids[6]].sort())
    expect(fs.existsSync(path.join(dir, 'not-a-build'))).toBe(true)
  })

  it('keeps builds younger than 30 minutes even beyond the newest 5', async () => {
    const dir = path.join(tmp, PID)
    const now = Date.now()
    const ids = Array.from({ length: 8 }, (_, i) => newBuildId(now - i * 60_000))
    for (const id of ids) fs.mkdirSync(path.join(dir, id), { recursive: true })
    expect(await pruneBuilds(dir, { now })).toEqual([])
    expect(await listBuildIds(dir)).toHaveLength(8)
  })

  it('caps the recent builds at 20 (auto compile publishes several a minute); pinned ones stay', async () => {
    const dir = path.join(tmp, PID)
    const now = Date.now()
    // 40 builds of the last 20 minutes, one every 30 s
    const ids = Array.from({ length: 40 }, (_, i) => newBuildId(now - i * 30_000))
    for (const id of ids) fs.mkdirSync(path.join(dir, id), { recursive: true })
    const pinned = ids[33]
    const removed = await pruneBuilds(dir, { now, keep: [pinned] })
    expect(removed).toHaveLength(40 - MAX_RECENT_BUILDS - 1)
    expect(await listBuildIds(dir)).toEqual([...ids.slice(0, MAX_RECENT_BUILDS), pinned])
  })
})

describe('publishBuild', () => {
  it('copies regular files only (never symlinks) and reports sizes and urls', async () => {
    const compileDir = path.join(tmp, 'compile')
    fs.mkdirSync(compileDir)
    fs.writeFileSync(path.join(compileDir, 'main.pdf'), '%PDF-1.5 xyz')
    fs.writeFileSync(path.join(tmp, 'secret.txt'), 'secret')
    fs.symlinkSync(path.join(tmp, 'secret.txt'), path.join(compileDir, 'main.log'))
    const buildId = newBuildId()
    const buildDir = path.join(tmp, 'builds', PID, buildId)
    const files = await publishBuild({
      compileDir, buildDir, projectId: PID, buildId,
      items: [{ rel: 'main.pdf', name: 'main.pdf' }, { rel: 'main.log', name: 'main.log' }, { rel: 'main.aux', name: 'main.aux' }, { rel: 'main.pdf', name: 'meta.json' }],
    })
    expect(files).toEqual([{ path: 'main.pdf', url: `/api/projects/${PID}/builds/${buildId}/main.pdf`, size: 12, type: 'pdf' }])
    expect(fs.readdirSync(buildDir)).toEqual(['main.pdf'])
    // a copy, not a link: later changes in the compile dir do not leak into the build
    fs.writeFileSync(path.join(compileDir, 'main.pdf'), 'changed')
    expect(fs.readFileSync(path.join(buildDir, 'main.pdf'), 'utf8')).toBe('%PDF-1.5 xyz')
  })

  it('hard-links an unchanged reusable output to the previous build, copies a changed one', async () => {
    const compileDir = path.join(tmp, 'compile')
    fs.mkdirSync(compileDir)
    fs.writeFileSync(path.join(compileDir, 'supp.pdf'), '%PDF-1.5 supplement')
    fs.writeFileSync(path.join(compileDir, 'main.pdf'), '%PDF-1.5 main')
    const reuse = new Map()
    const publish = async () => {
      const buildId = newBuildId()
      const buildDir = path.join(tmp, 'builds', PID, buildId)
      await publishBuild({
        compileDir, buildDir, projectId: PID, buildId, reuse,
        items: [{ rel: 'main.pdf', name: 'main.pdf' }, { rel: 'supp.pdf', name: 'supp.pdf', reusable: true }],
      })
      return buildDir
    }
    const b1 = await publish()
    const b2 = await publish()
    const ino = (d: string, n: string) => fs.statSync(path.join(d, n)).ino
    expect(ino(b2, 'supp.pdf')).toBe(ino(b1, 'supp.pdf'))
    expect(ino(b2, 'main.pdf')).not.toBe(ino(b1, 'main.pdf'))
    // the external document was rebuilt: a new copy
    fs.rmSync(path.join(compileDir, 'supp.pdf'))
    fs.writeFileSync(path.join(compileDir, 'supp.pdf'), '%PDF-1.5 supplement v2')
    const b3 = await publish()
    expect(ino(b3, 'supp.pdf')).not.toBe(ino(b2, 'supp.pdf'))
    expect(fs.readFileSync(path.join(b3, 'supp.pdf'), 'utf8')).toBe('%PDF-1.5 supplement v2')
    expect(fs.readFileSync(path.join(b2, 'supp.pdf'), 'utf8')).toBe('%PDF-1.5 supplement')
    // the previous build was pruned meanwhile: copy instead of failing
    fs.rmSync(b3, { recursive: true, force: true })
    const b4 = await publish()
    expect(fs.readFileSync(path.join(b4, 'supp.pdf'), 'utf8')).toBe('%PDF-1.5 supplement v2')
  })
})

describe('xr helpers', () => {
  it('importedLabelsHash follows \\@input lines with UTF-8 (non-ASCII) chapter names', async () => {
    const dir = path.join(tmp, 'compile')
    fs.mkdirSync(dir)
    // TeX writes the \include'd name as UTF-8 bytes, whatever the engine
    fs.writeFileSync(path.join(dir, 'main.aux'), Buffer.from('\\relax\n\\@input{Kapitel_ä.aux}\n\\newlabel{m:a}{{1}{1}}\n', 'utf8'))
    fs.writeFileSync(path.join(dir, 'Kapitel_ä.aux'), '\\newlabel{m:c}{{1}{1}}\n')
    const h1 = await importedLabelsHash(dir, ['main.aux'])
    fs.appendFileSync(path.join(dir, 'Kapitel_ä.aux'), '\\newlabel{m:d}{{2}{1}}\n')
    const h2 = await importedLabelsHash(dir, ['main.aux'])
    expect(h2).not.toBe(h1)
    // the chapter's labels are what changed: the main .aux alone is unchanged
    expect(await importedLabelsHash(dir, ['main.aux'])).toBe(h2)
  })

  it('documentDependencies lists what a document reads: \\input chains, .bib, class, figures', async () => {
    const texts = new Map([
      ['supp.tex', '\\documentclass{mycls}\n\\usepackage{mysty}\n\\begin{document}\n\\input{part}\n\\includegraphics{fig/plot}\n\\bibliography{refs}\n\\end{document}\n'],
      ['part.tex', '\\section{A}\\label{s:a}\n\\input{sub/deeper}\n'],
      ['sub/deeper.tex', 'text\n'],
      ['main.tex', '\\documentclass{article}\n'],
      ['refs.bib', '@article{a, title={A}}\n'],
      ['mysty.sty', '\\ProvidesPackage{mysty}\n'],
      ['mycls.cls', '\\ProvidesClass{mycls}\n'],
    ])
    const all = new Set([...texts.keys(), 'fig/plot.pdf', 'unrelated.png'])
    expect(await documentDependencies('supp.tex', texts, all)).toEqual(
      ['fig/plot.pdf', 'mycls.cls', 'mysty.sty', 'part.tex', 'refs.bib', 'sub/deeper.tex', 'supp.tex'])
  })
})

describe('command lines', () => {
  it('builds the hardened docker argv', () => {
    const args = buildDockerArgs({
      name: 'folio-c-abc', image: 'texlive/texlive:latest-full', argv: ['latexmk', '-v'],
      mounts: [{ host: '/data/compiles/p', container: '/compile' }, { host: '/data/texcache', container: '/cache', ro: true }],
      env: { HOME: '/tmp' }, workdir: '/compile', timeoutMs: 1000, memory: '2g', cpus: '2', user: '1000:1000',
      labels: { 'folio.kind': 'compile', 'folio.project': 'p1' }, cpuLimitSec: 90,
    })
    const joined = args.join(' ')
    expect(args.slice(0, 3)).toEqual(['run', '--rm', '--init'])
    for (const flag of [
      '--name folio-c-abc', '--network none', '--cap-drop ALL', '--security-opt no-new-privileges', '--pids-limit 512',
      '--memory 2g', '--memory-swap 2g', '--cpus 2', '--read-only', '--tmpfs /tmp:rw,exec,nosuid,nodev,size=256m',
      '--user 1000:1000', '--label folio.kind=compile', '--label folio.project=p1', '-e HOME=/tmp',
      '-v /data/compiles/p:/compile:rw', '-v /data/texcache:/cache:ro', '-w /compile', '--ulimit cpu=90:100', '--pull never',
    ]) expect(joined).toContain(flag)
    expect(args.slice(-3)).toEqual(['texlive/texlive:latest-full', 'latexmk', '-v'])
  })

  it('refuses unsafe docker parameters', () => {
    const base = { name: 'folio-c-x', image: 'img', argv: ['true'], mounts: [], timeoutMs: 1 }
    expect(() => buildDockerArgs({ ...base, mounts: [{ host: '/a:b', container: '/x' }] })).toThrow()
    expect(() => buildDockerArgs({ ...base, mounts: [{ host: 'relative', container: '/x' }] })).toThrow()
    expect(() => buildDockerArgs({ ...base, name: '-rf' })).toThrow()
    expect(() => buildDockerArgs({ ...base, image: '--privileged' })).toThrow()
    expect(() => buildDockerArgs({ ...base, env: { 'A B': 'x' } })).toThrow()
    expect(() => buildDockerArgs({ ...base, user: 'root' })).toThrow()
  })

  it('builds the latexmk argv (SPEC §4.5)', () => {
    expect(latexmkArgv({ jobname: 'main', compiler: 'xelatex', draft: false, stopOnFirstError: false, force: true, rootFile: '/compile/main.tex' }))
      .toEqual(['latexmk', '-norc', '-cd', '-jobname=main', '-synctex=1', '-interaction=batchmode', '-file-line-error', '-time', '-gt', '-f', '-xelatex', '/compile/main.tex'])
    expect(latexmkArgv({ jobname: 'a b', compiler: 'latex', draft: true, stopOnFirstError: true, force: false, rootFile: '/compile/x/a b.tex' }))
      .toEqual(['latexmk', '-norc', '-cd', '-jobname=a b', '-synctex=1', '-interaction=batchmode', '-file-line-error', '-time', '-halt-on-error',
        '-usepretex=\\PassOptionsToPackage{draft}{graphicx}\\PassOptionsToPackage{draft}{graphics}', '-pdfdvi', '/compile/x/a b.tex'])
  })

  it('maps container paths for the local runner', () => {
    const mounts = [{ host: '/h/compile', container: '/compile' }, { host: '/h/in', container: '/in' }]
    expect(mapContainerPath('/compile/main.tex', mounts)).toBe('/h/compile/main.tex')
    expect(mapContainerPath('/compile', mounts)).toBe('/h/compile')
    expect(mapContainerPath('/in/input.eps', mounts)).toBe('/h/in/input.eps')
    expect(mapContainerPath('/compiled/x', mounts)).toBe('/compiled/x')
    expect(mapContainerPath('-q', mounts)).toBe('-q')
  })

  it('gs argv renders the first page to stdout as PNG', () => {
    const a = gsPreviewArgv('/in/input.eps')
    expect(a).toEqual(expect.arrayContaining(['gs', '-dSAFER', '-dEPSCrop', '-sDEVICE=png16m', '-r150', '-sOutputFile=-', '-dFirstPage=1', '-dLastPage=1']))
    expect(isPng(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0]))).toBe(true)
    expect(isPng(Buffer.from('GIF89a....'))).toBe(false)
  })
})

describe('texcount parser', () => {
  it('parses a single-file count', () => {
    const raw = fs.readFileSync(new URL('../fixtures/fake-build/texcount.txt', import.meta.url), 'utf8')
    expect(parseTexcount(raw)).toEqual({ textWords: 12, headerWords: 1, captionWords: 0, headers: 1, floats: 0, mathInline: 1, mathDisplay: 1 })
  })

  it('uses the "File(s) total" block with -inc', () => {
    const raw = `File: main.tex
Words in text: 3
Words in headers: 1
Words outside text (captions, etc.): 3
Number of headers: 1
Number of floats/tables/figures: 1
Number of math inlines: 0
Number of math displayed: 0

Included file: ./sec/a.tex
Words in text: 7
Words in headers: 1
Words outside text (captions, etc.): 0
Number of headers: 1
Number of floats/tables/figures: 0
Number of math inlines: 1
Number of math displayed: 1

Sum of files: main.tex
File(s) total: main.tex
Words in text: 10
Words in headers: 2
Words outside text (captions, etc.): 3
Number of headers: 2
Number of floats/tables/figures: 1
Number of math inlines: 1
Number of math displayed: 1
Files: 2
`
    expect(parseTexcount(raw)).toEqual({ textWords: 10, headerWords: 2, captionWords: 3, headers: 2, floats: 1, mathInline: 1, mathDisplay: 1 })
  })
})

describe('xr helpers', () => {
  it('detects \\externaldocument outside comments', () => {
    const t = '\\usepackage{xr}\n\\externaldocument[S-]{supp}\n% \\externaldocument{no}\n\\externalcitedocument{cites}\n\\foo 100\\% \\externaldocument{yes}\n'
    expect(fallbackExternalDocuments(t)).toEqual([{ name: 'supp', prefix: 'S-' }, { name: 'cites' }, { name: 'yes' }])
    expect(fallbackHasDocumentclass('% \\documentclass{article}\n')).toBe(false)
    expect(fallbackHasDocumentclass('\\documentclass[a4paper]{Definitions/mdpi}\n')).toBe(true)
  })

  it('resolves external documents relative to the root folder', () => {
    const files = new Set(['paper/main.tex', 'paper/supp.tex', 'supp2.tex', 'x.tex'])
    const isTextFile = (p: string) => files.has(p)
    expect(resolveExternalDocs({ rootPath: 'paper/main.tex', explicit: [], detected: ['supp', '../supp2', 'missing', 'main', '../../etc/passwd'], isTextFile }))
      .toEqual(['paper/supp.tex', 'supp2.tex'])
    expect(resolveExternalDocs({ rootPath: 'paper/main.tex', explicit: ['x', 'paper/supp.tex', '../y'], detected: ['supp'], isTextFile }))
      .toEqual(['x.tex', 'paper/supp.tex'])
    expect(jobnameOf('a/b/antiddos_v2_supplementary.tex')).toBe('antiddos_v2_supplementary')
    expect(outputPath('a/b/main.tex', 'aux')).toBe('a/b/main.aux')
    expect(outputPath('main.tex', 'synctex.gz')).toBe('main.synctex.gz')
  })
})
