/**
 * Real compiles in the sandbox (texlive/texlive:latest-full). Run with FOLIO_DOCKER_TESTS=1.
 * Containers are named folio-server-compile-* and must all be gone after each test.
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { CompileResponse, ProjectSettings } from '@folio/shared/api'
import { kill, runSandboxed } from '../../src/compile/sandbox.ts'
import { DOCKER, HELLO_TEX, PAPER_DIR, TEST_PREFIX, importTree, leftoverContainers, makeEnv, type TestEnv } from './helpers.ts'

let env: TestEnv

function project(files: Record<string, string | Buffer>, settings: Partial<ProjectSettings> = {}): string {
  env.pid = env.newProject()
  for (const [p, c] of Object.entries(files)) env.write(p, c)
  if (Object.keys(settings).length) env.setSettings(settings)
  return env.pid
}

function buildFile(r: CompileResponse, name: string): Buffer {
  const p = env.compile.resolveBuildFile(env.pid, r.buildId!, name)
  if (!p) throw new Error(`build file ${name} missing`)
  return fs.readFileSync(p)
}

const UNDEFINED_REF = /(?:Reference|Citation) [`'][^']*' on page \S+ undefined|There were undefined (?:references|citations)/

describe.skipIf(!DOCKER)('docker sandbox compiles', () => {
  beforeAll(async () => {
    env = await makeEnv({ runnerKind: 'docker', userGuardMs: 0 })
  })

  afterEach(async () => {
    expect(await leftoverContainers()).toEqual([])
  })

  afterAll(async () => {
    await env?.close()
    expect(await leftoverContainers()).toEqual([])
  })

  it('hello world with pdflatex: success, synctex, warm font cache marker', async () => {
    project({ 'main.tex': HELLO_TEX })
    const t0 = Date.now()
    const r = await env.compile.compile(env.pid, env.owner, {})
    console.log(`[timing] first docker compile incl. font-cache warm-up: ${Date.now() - t0} ms (compileMs ${r.timings.compileMs})`)
    expect(r.status, r.stdout).toBe('success')
    expect(r.hasSynctex).toBe(true)
    expect(r.outputFiles.map(f => f.path)).toEqual(expect.arrayContaining(['main.pdf', 'main.log', 'main.synctex.gz', 'main.aux']))
    expect(buildFile(r, 'main.pdf').subarray(0, 5).toString()).toBe('%PDF-')
    const synctex = zlib.gunzipSync(buildFile(r, 'main.synctex.gz')).toString('utf8')
    expect(synctex).toMatch(/^Input:\d+:\/compile\/\.\/main\.tex$/m)
    expect(r.log?.errors ?? []).toEqual([])
    const markers = fs.readdirSync(env.config.dirs.texcache).filter(n => n.startsWith('.warm-'))
    expect(markers).toHaveLength(1)
    // unchanged auto compile → served from the cache without docker
    const again = await env.compile.compile(env.pid, env.owner, { auto: true })
    expect(again.cached).toBe(true)
    expect(again.buildId).toBe(r.buildId)
    // manual recompile runs latexmk -gt (one pass)
    const t1 = Date.now()
    const forced = await env.compile.compile(env.pid, env.owner, {})
    console.log(`[timing] warm manual recompile of hello world: ${Date.now() - t1} ms`)
    expect(forced.status).toBe('success')
    expect(forced.buildId).not.toBe(r.buildId)
    expect(forced.stdout).toMatch(/Run number 1 of rule 'pdflatex'/)
  })

  const ERROR_TEX = String.raw`\documentclass{article}
\begin{document}
\section{Broken}
Some text before the error.
\undefinedmacro
More text after it.
\end{document}
`

  it('undefined control sequence: PDF anyway (-f) and an error with file + line', async () => {
    project({ 'main.tex': ERROR_TEX })
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status).toBe('success')
    const raw = buildFile(r, 'main.log').toString('utf8')
    expect(raw).toMatch(/\.\/main\.tex:5: Undefined control sequence/)
    if (r.log) {
      expect(r.log.errors.length).toBeGreaterThanOrEqual(1)
      expect(r.log.errors[0]).toMatchObject({ file: 'main.tex', line: 5, level: 'error' })
      expect(r.log.errors[0].message).toMatch(/Undefined control sequence/)
    }
  })

  it('stop on first error: no PDF, stopped-on-first-error', async () => {
    project({ 'main.tex': ERROR_TEX })
    const r = await env.compile.compile(env.pid, env.owner, { stopOnFirstError: true })
    expect(r.status).toBe('stopped-on-first-error')
    expect(r.pdfUrl).toBeNull()
    expect(r.logUrl).toBeTruthy()
    if (r.log) expect(r.log.errors[0]).toMatchObject({ file: 'main.tex', line: 5 })
    // after a successful compile, a failing one must not report the stale PDF as success
    env.write('main.tex', HELLO_TEX)
    expect((await env.compile.compile(env.pid, env.owner, { stopOnFirstError: true })).status).toBe('success')
    env.write('main.tex', ERROR_TEX)
    const again = await env.compile.compile(env.pid, env.owner, { stopOnFirstError: true })
    expect(again.status).toBe('stopped-on-first-error')
    expect(again.pdfUrl).toBeNull()
  })

  it('draft mode replaces images by frames', async () => {
    const png = fs.readFileSync(new URL('../fixtures/fake-build/preview.png', import.meta.url))
    const tex = String.raw`\documentclass{article}
\usepackage{graphicx}
\begin{document}
\includegraphics[width=3cm]{figs/logo.png}
\end{document}
`
    project({ 'main.tex': tex, 'figs/logo.png': png })
    const normal = await env.compile.compile(env.pid, env.owner, {})
    expect(normal.status, normal.stdout).toBe('success')
    const imageRe = /\/Subtype\s*\/Image/
    expect(buildFile(normal, 'main.pdf').toString('latin1')).toMatch(imageRe)
    const draft = await env.compile.compile(env.pid, env.owner, { draft: true })
    expect(draft.status).toBe('success')
    expect(draft.stdout).toMatch(/PassOptionsToPackage\{draft\}\{graphicx\}/)
    expect(buildFile(draft, 'main.pdf').toString('latin1')).not.toMatch(imageRe)
    // auto compiles (no -gt) toggling draft: latexmk alone would say "up-to-date"
    const autoNormal = await env.compile.compile(env.pid, env.owner, { auto: true, draft: false })
    expect(autoNormal.cached).toBe(false) // dedupe compares with the last successful build only (the draft one)
    expect(autoNormal.stdout).toMatch(/Run number 1 of rule 'pdflatex'/)
    expect(buildFile(autoNormal, 'main.pdf').toString('latin1')).toMatch(imageRe)
    env.write('main.tex', tex + '% edit\n')
    const autoDraft = await env.compile.compile(env.pid, env.owner, { auto: true, draft: true })
    expect(autoDraft.cached).toBe(false)
    expect(buildFile(autoDraft, 'main.pdf').toString('latin1')).not.toMatch(imageRe)
    const autoNormal2 = await env.compile.compile(env.pid, env.owner, { auto: true, draft: false })
    expect(autoNormal2.cached).toBe(false)
    expect(buildFile(autoNormal2, 'main.pdf').toString('latin1')).toMatch(imageRe)
  })

  const BIB = `@book{knuth84,
  author = {Donald E. Knuth},
  title = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year = {1984}
}
@article{lamport94,
  author = {Leslie Lamport},
  title = {{\\LaTeX}: A Document Preparation System},
  journal = {Addison-Wesley},
  year = {1994}
}
`

  it('bibtex document with a .bib file', async () => {
    const tex = String.raw`\documentclass{article}
\begin{document}
See \cite{knuth84} and \cite{lamport94}.
\bibliographystyle{plain}
\bibliography{refs}
\end{document}
`
    project({ 'main.tex': tex, 'refs.bib': BIB })
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status, r.stdout).toBe('success')
    expect(r.outputFiles.map(f => f.path)).toEqual(expect.arrayContaining(['main.bbl', 'main.blg']))
    expect(buildFile(r, 'main.bbl').toString()).toMatch(/\\bibitem\{knuth84\}/)
    expect(buildFile(r, 'main.log').toString()).not.toMatch(UNDEFINED_REF)
    if (r.log) expect(r.log.warnings.filter(w => /undefined/i.test(w.message))).toEqual([])
  })

  it('biber / biblatex document', async () => {
    const tex = String.raw`\documentclass{article}
\usepackage[backend=biber]{biblatex}
\addbibresource{refs.bib}
\begin{document}
See \cite{knuth84} and \cite{lamport94}.
\printbibliography
\end{document}
`
    project({ 'main.tex': tex, 'refs.bib': BIB })
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status, r.stdout).toBe('success')
    expect(r.stdout).toMatch(/biber/)
    expect(r.outputFiles.map(f => f.path)).toEqual(expect.arrayContaining(['main.bbl', 'main.blg']))
    expect(buildFile(r, 'main.blg').toString()).toMatch(/This is Biber/)
    expect(buildFile(r, 'main.log').toString()).not.toMatch(UNDEFINED_REF)
    if (r.log) expect(r.log.errors).toEqual([])
  })

  it('xr pair: the external document is pre-built → 0 undefined references', async () => {
    const main = String.raw`\documentclass{article}
\usepackage{xr}
\externaldocument{supp}
\begin{document}
\section{Main}\label{sec:main}
See Table~\ref{tab:s1} and Section~\ref{sec:supp} of the supplement.
\end{document}
`
    const supp = String.raw`\documentclass{article}
\begin{document}
\section{Supplement}\label{sec:supp}
\begin{table}[h]\centering\caption{S1}\label{tab:s1}\begin{tabular}{c}x\end{tabular}\end{table}
\end{document}
`
    project({ 'main.tex': main, 'supp.tex': supp })
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status, r.stdout).toBe('success')
    expect(r.externalBuilds).toEqual([{ path: 'supp.tex', status: 'success' }])
    expect(r.outputFiles.map(f => f.path)).toEqual(expect.arrayContaining(['supp.pdf', 'supp.log']))
    const log = buildFile(r, 'main.log').toString()
    expect(log).not.toMatch(UNDEFINED_REF)
    expect(log).not.toMatch(/No file supp\.aux/)
    if (r.log) expect(r.log.warnings.filter(w => w.kind === 'undefined-reference')).toEqual([])
    // second compile: supp unchanged → no pre-build
    const r2 = await env.compile.compile(env.pid, env.owner, {})
    expect(r2.externalBuilds).toEqual([])
    expect(buildFile(r2, 'main.log').toString()).not.toMatch(UNDEFINED_REF)
  })

  it('mutual xr in a sub-folder: the external PDF gets the references to the main document (no ??)', async () => {
    const main = String.raw`\documentclass{article}
\usepackage{xr}
\externaldocument[S-]{supp/supp}
\begin{document}
\section{Main}\label{sec:main}
See supplementary Section~\ref{S-sec:supp}.
\end{document}
`
    const supp = String.raw`\documentclass{article}
\usepackage{xr}
\externaldocument[M-]{../main}
\begin{document}
\section{Supp}\label{sec:supp}
As shown in main Section~\ref{M-sec:main}.
\end{document}
`
    project({ 'main.tex': main, 'supp/supp.tex': supp })
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status, r.stdout).toBe('success')
    expect(r.externalBuilds).toEqual([{ path: 'supp/supp.tex', status: 'success' }])
    expect(buildFile(r, 'main.log').toString()).not.toMatch(UNDEFINED_REF)
    expect(buildFile(r, 'supp.log').toString()).not.toMatch(UNDEFINED_REF)
    expect(r.log!.warnings.filter(w => w.kind === 'external-undefined-references')).toEqual([])
    // up to date: nothing is rebuilt, and it stays resolved
    const r2 = await env.compile.compile(env.pid, env.owner, {})
    expect(r2.externalBuilds).toEqual([])
    expect(buildFile(r2, 'supp.log').toString()).not.toMatch(UNDEFINED_REF)
  })

  it('an external document with an undefined reference is reported in the main log', async () => {
    const main = '\\documentclass{article}\n\\usepackage{xr}\n\\externaldocument{supp}\n\\begin{document}\nMain.\n\\end{document}\n'
    const supp = '\\documentclass{article}\n\\begin{document}\nSee \\ref{nowhere}.\n\\end{document}\n'
    project({ 'main.tex': main, 'supp.tex': supp })
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status, r.stdout).toBe('success')
    const w = r.log!.warnings.find(x => x.kind === 'external-undefined-references')
    expect(w).toMatchObject({ file: 'supp.tex', message: 'supp.tex (external document): 1 undefined reference or citation' })
  })

  it('\\externaldocument in an \\input preamble file is detected and built', async () => {
    project({
      'main.tex': '\\documentclass{article}\n\\input{preamble}\n\\begin{document}\nSee \\ref{S-sec:supp}.\n\\end{document}\n',
      'preamble.tex': '\\usepackage{xr}\n\\externaldocument[S-]{supp}\n',
      'supp.tex': '\\documentclass{article}\n\\begin{document}\n\\section{Supp}\\label{sec:supp}\nText.\n\\end{document}\n',
    })
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status, r.stdout).toBe('success')
    expect(r.externalBuilds).toEqual([{ path: 'supp.tex', status: 'success' }])
    expect(buildFile(r, 'main.log').toString()).not.toMatch(UNDEFINED_REF)
  })

  it('ACC-1: an external document whose content comes from \\input is rebuilt when that file changes', async () => {
    project({
      'main.tex': '\\documentclass{article}\n\\usepackage{xr}\n\\externaldocument{supp}\n\\begin{document}\nSee \\ref{s:a} and \\ref{s:b}.\n\\end{document}\n',
      'supp.tex': '\\documentclass{article}\n\\begin{document}\n\\input{part}\n\\end{document}\n',
      'part.tex': '\\section{A}\\label{s:a}\nText.\n',
    })
    const r1 = await env.compile.compile(env.pid, env.owner, {})
    expect(r1.status, r1.stdout).toBe('success')
    expect(r1.externalBuilds).toEqual([{ path: 'supp.tex', status: 'success' }])
    expect(buildFile(r1, 'main.log').toString()).toMatch(/Reference `s:b' on page 1 undefined/)
    env.write('part.tex', '\\section{B}\\label{s:b}\nText.\n\\section{A}\\label{s:a}\nText.\n')
    const r2 = await env.compile.compile(env.pid, env.owner, {})
    expect(r2.status, r2.stdout).toBe('success')
    expect(r2.externalBuilds).toEqual([{ path: 'supp.tex', status: 'success' }])
    expect(buildFile(r2, 'main.log').toString()).not.toMatch(UNDEFINED_REF)
    if (r2.log) expect(r2.log.warnings.filter(w => w.kind === 'undefined-reference')).toEqual([])
  })

  it('ACC-2: main.tex and supp/main.tex never collide in the build', async () => {
    const main = '\\documentclass{article}\n\\usepackage{xr}\n\\externaldocument{supp/main}\n\\begin{document}\nMAIN DOCUMENT, see \\ref{s:x}.\n\\end{document}\n'
    project({
      'main.tex': main,
      'supp/main.tex': '\\documentclass{article}\n\\begin{document}\n\\section{Supp}\\label{s:x}\nSUPPLEMENT TEXT.\n\\end{document}\n',
    })
    const r1 = await env.compile.compile(env.pid, env.owner, {})
    expect(r1.status, r1.stdout).toBe('success')
    expect(r1.outputFiles.map(f => f.path)).toEqual(expect.arrayContaining(['main.pdf', 'main.log', 'supp__main.pdf', 'supp__main.log']))
    expect(r1.log!.warnings.filter(w => w.kind === 'external-undefined-references')).toEqual([])
    expect(buildFile(r1, 'main.log').toString()).not.toMatch(UNDEFINED_REF)
    // the main document stops on an error: no PDF, and nothing else is shown in its place
    env.write('main.tex', main.replace('MAIN DOCUMENT', 'MAIN DOCUMENT \\undefinedcommand'))
    env.write('supp/main.tex', '\\documentclass{article}\n\\begin{document}\n\\section{Supp}\\label{s:x}\nSUPPLEMENT TEXT changed.\n\\end{document}\n')
    const r2 = await env.compile.compile(env.pid, env.owner, { stopOnFirstError: true })
    expect(r2.status).toBe('stopped-on-first-error')
    expect(r2.pdfUrl).toBeNull()
    expect(r2.log!.errors.map(e => `${e.file}:${e.line}`)).toEqual(['main.tex:5'])
  })

  it('ACC-3: mutual xr with a non-ASCII \\include: a label added in the chapter rebuilds the external document', async () => {
    project({
      'main.tex': '\\documentclass{article}\n\\usepackage{xr}\n\\externaldocument{supp}\n\\begin{document}\n\\include{Kapitel_ä}\n\\end{document}\n',
      'Kapitel_ä.tex': '\\section{A}\\label{m:a}\nText.\n',
      'supp.tex': '\\documentclass{article}\n\\usepackage{xr}\n\\externaldocument{main}\n\\begin{document}\n\\section{S}\\label{s:s}\nSee \\ref{m:a} and \\ref{m:b}.\n\\end{document}\n',
    })
    const r1 = await env.compile.compile(env.pid, env.owner, {})
    expect(r1.status, r1.stdout).toBe('success')
    expect(buildFile(r1, 'supp.log').toString()).toMatch(/Reference `m:b' on page 1 undefined/)
    env.write('Kapitel_ä.tex', '\\section{A}\\label{m:a}\nText.\n\\section{B}\\label{m:b}\nMore.\n')
    const r2 = await env.compile.compile(env.pid, env.owner, {})
    expect(r2.status, r2.stdout).toBe('success')
    expect(r2.externalBuilds).toEqual([{ path: 'supp.tex', status: 'success' }])
    expect(buildFile(r2, 'supp.log').toString()).not.toMatch(UNDEFINED_REF)
    expect(r2.log!.warnings.filter(w => w.kind === 'external-undefined-references')).toEqual([])
  })

  it('ACC-13: a non-ASCII file path: error file:line, SyncTeX both ways', async () => {
    project({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nIntro text.\n\n\\input{Kapitel ü/チャプター}\n\\end{document}\n',
      'Kapitel ü/チャプター.tex': 'Chapter text here.\n\\undefinedmacro\nMore chapter text.\n',
    })
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status, r.stdout).toBe('success')
    expect(r.log!.errors.map(e => `${e.file}:${e.line}`)).toEqual(['Kapitel ü/チャプター.tex:2'])
    const { createSynctexService } = await import('../../src/synctex/index.ts')
    const sync = createSynctexService(env.s, { runCli: null })
    const fwd = await sync.codeToPdf(env.pid, r.buildId!, 'Kapitel ü/チャプター.tex', 1, 0)
    expect(fwd.pdf.length).toBeGreaterThan(0)
    const box = fwd.pdf[0]
    const inv = await sync.pdfToCode(env.pid, r.buildId!, box.page, box.x + 1, box.y + box.height / 2)
    expect(inv.code[0]).toMatchObject({ path: 'Kapitel ü/チャプター.tex', fileId: env.fileId('Kapitel ü/チャプター.tex') })
  })

  it('auto compile after a TeX error and an unrelated edit: still a build with PDF and log', async () => {
    project({
      'main.tex': '\\documentclass{article}\n\\begin{document}\nHello \\foobar{} world.\n\\end{document}\n',
      'unused.tex': 'nothing here\n',
    })
    const r1 = await env.compile.compile(env.pid, env.owner, {})
    expect(r1.status, r1.stdout).toBe('success')
    expect(r1.log!.errors).toHaveLength(1)
    env.write('unused.tex', 'nothing here more\n')
    const r2 = await env.compile.compile(env.pid, env.editor, { auto: true })
    expect(r2.status, r2.stdout).toBe('success')
    expect(r2.buildId).toBeTruthy()
    expect(r2.pdfUrl).toBeTruthy()
    expect(r2.log!.errors.map(e => [e.file, e.line])).toEqual([['main.tex', 3]])
  })

  it('a missing .bib file is reported as an error at its \\bibliography line', async () => {
    project({ 'main.tex': '\\documentclass{article}\n\\begin{document}\nSee \\cite{a}.\n\\bibliographystyle{plain}\n\\bibliography{nosuchbib}\n\\end{document}\n' })
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status, r.stdout).toBe('success')
    expect(r.log!.errors.map(e => [e.kind, e.message, e.file, e.line])).toEqual([['missing-bib', 'Bibliography file "nosuchbib.bib" not found', 'main.tex', 5]])
  })

  it('main document in a sub-folder: errors in files outside it keep their file and line', async () => {
    project({
      'paper/main.tex': '\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\input{../shared/defs}\n\\end{document}\n',
      'paper/sections/intro.tex': 'Intro text.\n\\introbad\n',
      'shared/defs.tex': 'Shared text.\n\\sharedbad\n',
    }, {})
    env.setSettings({ rootFileId: env.fileId('paper/main.tex') })
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status, r.stdout).toBe('success')
    expect(r.log!.errors.map(e => `${e.file}:${e.line} ${e.message}`)).toEqual([
      'paper/sections/intro.tex:2 Undefined control sequence: \\introbad',
      'shared/defs.tex:2 Undefined control sequence: \\sharedbad',
    ])
  })

  it('timeout: an infinite loop is killed after timeoutSec and no container is left', async () => {
    project({ 'main.tex': '\\documentclass{article}\n\\begin{document}\n\\def\\x{\\x}\\x\n\\end{document}\n' }, { timeoutSec: 5 })
    const t0 = Date.now()
    const r = await env.compile.compile(env.pid, env.owner, {})
    const took = Date.now() - t0
    console.log(`[timing] timeout test: ${took} ms`)
    expect(r.status).toBe('timedout')
    expect(took).toBeGreaterThanOrEqual(4500)
    expect(took).toBeLessThan(20_000)
    expect(await leftoverContainers()).toEqual([])
  })

  it('stop: a running compile is terminated and its container killed', async () => {
    project({ 'main.tex': '\\documentclass{article}\n\\begin{document}\n\\def\\x{\\x}\\x\n\\end{document}\n' }, { timeoutSec: 60 })
    const running = env.compile.compile(env.pid, env.owner, {})
    // wait until the container exists
    for (let i = 0; i < 100 && (await leftoverContainers()).length === 0; i++) await new Promise(r => setTimeout(r, 100))
    const t0 = Date.now()
    await env.compile.stop(env.pid)
    const r = await running
    expect(r.status).toBe('terminated')
    expect(Date.now() - t0).toBeLessThan(10_000)
    expect(await leftoverContainers()).toEqual([])
  })

  it('lualatex works (font caches warmed)', async () => {
    const tex = String.raw`\documentclass{article}
\usepackage{fontspec}
\begin{document}
\section{Lua}
Héllo from Lua\TeX{} — \directlua{tex.print(6*7)}.
\textbf{\textsc{Bold small caps}}
\end{document}
`
    project({ 'main.tex': tex }, { compiler: 'lualatex' })
    const t0 = Date.now()
    const r = await env.compile.compile(env.pid, env.owner, {})
    console.log(`[timing] lualatex compile: ${Date.now() - t0} ms`)
    expect(r.status, r.stdout).toBe('success')
    expect(r.stdout).not.toMatch(/Segmentation fault/)
    expect(buildFile(r, 'main.log').toString()).toMatch(/This is LuaHBTeX/)
  })

  it('word count with texcount in the sandbox', async () => {
    project({
      'main.tex': String.raw`\documentclass{article}
\begin{document}
\section{Intro}
Some words here.
\input{sec/a}
\begin{figure}\caption{A caption here}\end{figure}
\end{document}
`,
      'sec/a.tex': '\\subsection{Sub}\nMore words in the included file $a$ and\n\\[ b \\]\n',
    })
    const wc = await env.compile.wordCount(env.pid)
    expect(wc).toMatchObject({ rootPath: 'main.tex', textWords: 10, headerWords: 2, captionWords: 3, headers: 2, floats: 1, mathInline: 1, mathDisplay: 1 })
    expect(wc.raw).toMatch(/File\(s\) total/)
  })

  it('EPS preview renders a PNG with Ghostscript', async () => {
    project({ 'Definitions/logo-mdpi.eps': fs.readFileSync(path.join(PAPER_DIR, 'Definitions/logo-mdpi.eps')) })
    const id = env.fileId('Definitions/logo-mdpi.eps')
    const png = await env.compile.renderPreview(env.pid, id)
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    const width = png.readUInt32BE(16)
    const height = png.readUInt32BE(20)
    expect(width).toBeGreaterThan(50)
    expect(height).toBeGreaterThan(30)
    // cached
    const t0 = Date.now()
    expect((await env.compile.renderPreview(env.pid, id)).equals(png)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(500)
  })

  it('runSandboxed: unprivileged, no network, read-only root, private exec /tmp, ro mounts', async () => {
    const dir = fs.mkdtempSync(path.join(env.root, 'mnt-'))
    fs.writeFileSync(path.join(dir, 'in.txt'), 'hello')
    const r = await runSandboxed({
      name: `${TEST_PREFIX}probe`,
      image: env.config.compile.image,
      mounts: [{ host: dir, container: '/in', ro: true }],
      argv: ['sh', '-c', 'id -u; cat /in/in.txt; echo; touch /x 2>/dev/null || echo ROOT_RO; touch /in/y 2>/dev/null || echo MOUNT_RO; ls /sys/class/net; printf "#!/bin/sh\\necho TMP_EXEC\\n" > /tmp/t && chmod +x /tmp/t && /tmp/t; grep CapEff /proc/self/status'],
      workdir: '/in',
      timeoutMs: 30_000,
      labels: { 'folio.test': 'server-compile' },
    })
    expect(r.code, r.stderr).toBe(0)
    const lines = r.stdout.trim().split('\n')
    expect(lines[0]).toBe(env.config.compile.user.split(':')[0])
    expect(lines).toEqual(expect.arrayContaining(['hello', 'ROOT_RO', 'MOUNT_RO', 'lo', 'TMP_EXEC', 'CapEff:\t0000000000000000']))
    expect(lines.filter(l => /^(eth|en|wl)/.test(l))).toEqual([])
  })

  it('reapOrphans kills this instance\'s containers only', async () => {
    const mine = runSandboxed({ name: `${TEST_PREFIX}orphan-mine`, image: env.config.compile.image, mounts: [], argv: ['sleep', '60'], timeoutMs: 60_000 })
    const other = runSandboxed({
      name: `${TEST_PREFIX}orphan-other`, image: env.config.compile.image, mounts: [], argv: ['sleep', '60'], timeoutMs: 60_000,
      labels: { 'folio.instance': 'someone-else' },
    })
    for (let i = 0; i < 100 && (await leftoverContainers()).length < 2; i++) await new Promise(r => setTimeout(r, 100))
    expect((await leftoverContainers()).sort()).toEqual([`${TEST_PREFIX}orphan-mine`, `${TEST_PREFIX}orphan-other`])
    expect(await env.compile.runner.reap()).toBe(1)
    expect((await mine).code).toBe(137)
    expect(await leftoverContainers()).toEqual([`${TEST_PREFIX}orphan-other`])
    expect(await kill(`${TEST_PREFIX}orphan-other`)).toBe(true)
    expect((await other).code).toBe(137)
  })

  it('info() reports docker and the TeX Live version', async () => {
    expect(await env.compile.info()).toEqual({ runner: 'docker', image: env.config.compile.image, texLive: 'TeX Live 2026', dockerOk: true })
  })

  it('THE REAL PAPER: xelatex + xr supplement → success, > 100 kB, no undefined references', async () => {
    env.pid = env.newProject('antiddos_v2')
    const skipGenerated = (name: string) => /\.(aux|log|out|toc|synctex\.gz|fdb_latexmk|fls|xdv|bbl|blg)$/.test(name)
    for (const f of ['antiddos_v2.tex', 'antiddos_v2_supplementary.tex']) importTree(env, PAPER_DIR, f)
    importTree(env, PAPER_DIR, 'Definitions', skipGenerated)
    importTree(env, PAPER_DIR, 'figures', skipGenerated)
    env.setSettings({
      compiler: 'xelatex',
      rootFileId: env.fileId('antiddos_v2.tex'),
      externalDocs: ['antiddos_v2_supplementary.tex'],
      timeoutSec: 300,
    })
    const t0 = Date.now()
    const cold = await env.compile.compile(env.pid, env.owner, {})
    const coldMs = Date.now() - t0
    expect(cold.status, cold.stdout).toBe('success')
    expect(cold.externalBuilds).toEqual([{ path: 'antiddos_v2_supplementary.tex', status: 'success' }])
    const pdf = buildFile(cold, 'antiddos_v2.pdf')
    expect(pdf.length).toBeGreaterThan(100 * 1024)
    const log = buildFile(cold, 'antiddos_v2.log').toString('utf8')
    expect(log).toMatch(/This is XeTeX/)
    expect(log).not.toMatch(UNDEFINED_REF)
    expect(log).not.toMatch(/No file antiddos_v2_supplementary\.aux/)
    if (cold.log) {
      expect(cold.log.errors).toEqual([])
      expect(cold.log.warnings.filter(w => w.kind === 'undefined-reference' || /undefined/i.test(w.message))).toEqual([])
    }
    expect(cold.hasSynctex).toBe(true)
    // mutual xr: the supplementary is rebuilt after the main paper, so it has no ?? either
    expect(buildFile(cold, 'antiddos_v2_supplementary.log').toString('utf8')).not.toMatch(UNDEFINED_REF)

    const t1 = Date.now()
    const warm = await env.compile.compile(env.pid, env.owner, {})
    const warmMs = Date.now() - t1
    expect(warm.status).toBe('success')
    expect(warm.externalBuilds).toEqual([])
    expect(buildFile(warm, 'antiddos_v2.log').toString('utf8')).not.toMatch(UNDEFINED_REF)

    const t2 = Date.now()
    const auto = await env.compile.compile(env.pid, env.owner, { auto: true })
    const autoMs = Date.now() - t2
    expect(auto.cached).toBe(true)
    console.log(`[timing] real paper: cold ${coldMs} ms (sync ${cold.timings.syncMs} ms, TeX ${cold.timings.compileMs} ms, incl. supplement pre-build); ` +
      `warm manual recompile ${warmMs} ms (TeX ${warm.timings.compileMs} ms); unchanged auto compile ${autoMs} ms (cached); PDF ${pdf.length} bytes; ` +
      `errors ${cold.log?.errors.length ?? 'n/a'}, warnings ${cold.log?.warnings.length ?? 'n/a'}`)
  }, 600_000)
})
