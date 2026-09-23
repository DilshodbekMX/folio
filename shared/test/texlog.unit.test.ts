/** Unit tests for unwrapping, the file stack and the edge-case catalogue of docs/research/logparse.md. */
import { describe, expect, it } from 'vitest'
import {
  analyzeLatexLog, groupLogEntries, hintFor, mergeLogs, parseLatexLog, parseLatexmkOutput, unwrapLines, unwrapLog, detectEngine,
} from '../src/texlog/index.ts'
import type { ParsedLog } from '../src/api.ts'

const enc = new TextEncoder()
const concat = (...parts: (string | number[])[]) => {
  const chunks = parts.map(p => (typeof p === 'string' ? enc.encode(p) : Uint8Array.from(p)))
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
  let o = 0
  for (const c of chunks) {
    out.set(c, o)
    o += c.length
  }
  return out
}
const PDFTEX = 'This is pdfTeX, Version 3.141592653-2.6-1.40.29 (TeX Live 2026) (preloaded format=pdflatex)\n'
const XETEX = 'This is XeTeX, Version 3.141592653-2.6-0.999998 (TeX Live 2026) (preloaded format=xelatex)\n'
const LUATEX = 'This is LuaHBTeX, Version 1.24.0 (TeX Live 2026)  (format=lualatex)\n'
const END = '\nHere is how much of TeX\'s memory you used:\n 1 string\n'

/** a complete small log around `body` (root ./main.tex) */
const log = (body: string, banner = PDFTEX) => `${banner}**main.tex\n(./main.tex\nLaTeX2e <2026-06-01>\n${body}\n)${END}`

describe('engine detection and unwrapping', () => {
  it('detects engines from the banner', () => {
    expect(detectEngine(PDFTEX)).toBe('pdftex')
    expect(detectEngine(XETEX)).toBe('xetex')
    expect(detectEngine(LUATEX)).toBe('luatex')
    expect(detectEngine('This is LuaTeX, Version 1.18')).toBe('luatex')
    expect(detectEngine('hello')).toBe('unknown')
  })

  it('pdfTeX: joins 79-byte lines at byte level, even inside a UTF-8 sequence', () => {
    const a = 'x'.repeat(78)
    const bytes = concat(PDFTEX, a, [0xc3], '\n', [0xa9], 'tude continues\nnext line\n')
    const u = unwrapLines(bytes, { maxPrintLine: 79 })
    expect(u.lines[1]).toBe(`${a}étude continues`)
    expect(u.lines[2]).toBe('next line')
    expect(u.lineNo).toEqual([1, 2, 4])
  })

  it('XeTeX: counts code points (80 bytes / 79 code points is wrapped; emoji is one code point)', () => {
    const l1 = 'ë' + 'a'.repeat(78) // 79 code points, 80 bytes
    const l2 = '😀' + 'b'.repeat(78) // 79 code points, 80 UTF-16 units
    const text = `${XETEX}${l1}\nrest1\n${l2}\nrest2\n${'c'.repeat(80)}\nalone\n`
    const u = unwrapLines(text, { maxPrintLine: 79 })
    expect(u.lines.slice(1, 5)).toEqual([`${l1}rest1`, `${l2}rest2`, 'c'.repeat(80), 'alone'])
  })

  it('LuaTeX: 79 or 80 bytes, and early wraps before a multi-byte character', () => {
    const text = `${LUATEX}${'a'.repeat(80)}\nX\n${'b'.repeat(79)}\nY\n${'c'.repeat(77)}\néZ\n${'d'.repeat(77)}\nnot joined\n`
    const u = unwrapLines(text, { maxPrintLine: 79 })
    expect(u.lines.slice(1)).toEqual([`${'a'.repeat(80)}X`, `${'b'.repeat(79)}Y`, `${'c'.repeat(77)}éZ`, 'd'.repeat(77), 'not joined'])
  })

  it('never joins before the start of a new message, or after a truncated context', () => {
    const p = '(/home/detector/texlive/2026/texmf-dist/tex/latex/microtype/microtype-xetex.def'
    expect(p.length).toBe(79)
    const text = `${PDFTEX}${p}\nFile: microtype-xetex.def 2026/03/01\n${'y'.repeat(76)}...\nnext\n${'z'.repeat(79)}\nPackage: foo 2020\n`
    const lines = unwrapLog(text, 'pdftex', 79).split('\n')
    expect(lines[1]).toBe(p)
    expect(lines[2]).toBe('File: microtype-xetex.def 2026/03/01')
    expect(lines[3]).toBe(`${'y'.repeat(76)}...`)
    expect(lines[4]).toBe('next')
    expect(lines[6]).toBe('Package: foo 2020')
  })

  it('auto-detects unwrapped logs (max_print_line=10000) and then never joins 79-character lines', () => {
    const long = Array.from({ length: 4 }, (_, i) => `(/usr/local/texlive/2026/texmf-dist/tex/latex/pkg${i}/${'p'.repeat(90)}.sty)`).join('\n')
    const p79 = ') (/usr/local/texlive/2026/texmf-dist/tex/generic/kvdefinekeys/kvdefinekeys.sty'
    expect(p79.length).toBe(79)
    const u = unwrapLines(`${PDFTEX}${long}\n${p79}\nfollowing text\n`)
    expect(u.maxPrintLine).toBe(Infinity)
    expect(u.lines).toContain(p79)
    expect(u.lines).toContain('following text')
    // a short wrapped-looking log is treated as wrapped at 79
    expect(unwrapLines(`${PDFTEX}${'q'.repeat(79)}\ntail\n`).lines[1]).toBe(`${'q'.repeat(79)}tail`)
  })

  it('handles CRLF logs', () => {
    const text = log('LaTeX Warning: Reference `a\' on page 1 undefined on input line 3.').replace(/\n/g, '\r\n')
    expect(text).toContain('\r\n')
    const r = parseLatexLog(text, { projectFiles: ['main.tex'] })
    expect(r.warnings.map(e => [e.kind, e.file, e.line])).toEqual([['undefined-reference', 'main.tex', 3]])
  })
})

describe('file stack', () => {
  it('resolves quoted LuaTeX paths, paths with spaces and parentheses, and /compile prefixes', () => {
    const body = [
      '("./my dir/file name.tex"',
      'LaTeX Warning: Reference `x\' on page 1 undefined on input line 2.',
      ') (./figs (old)/part.tex',
      'LaTeX Warning: Reference `y\' on page 1 undefined on input line 3.',
      ') (/compile/./chapters/one.tex',
      'LaTeX Warning: Reference `z\' on page 1 undefined on input line 4.',
      ')',
    ].join('\n')
    const files = ['main.tex', 'my dir/file name.tex', 'figs (old)/part.tex', 'chapters/one.tex']
    for (const projectFiles of [files, []]) {
      const r = parseLatexLog(log(body), { projectFiles })
      expect(r.warnings.map(e => [e.file, e.line])).toEqual([['my dir/file name.tex', 2], ['figs (old)/part.tex', 3], ['chapters/one.tex', 4]])
    }
  })

  it('handles many tokens per line, output-directory paths, graphics lines and stray parentheses', () => {
    const body = [
      '(/usr/local/texlive/2026/texmf-dist/tex/latex/base/size10.clo) (./a.sty) (out/main.aux) (./sub/b.tex',
      '<use Definitions/logo-orcid.pdf> <Definitions/logo-mdpi.eps>',
      'Package: rerunfilecheck 2025/06/21 v1.11 Rerun checks for auxiliary files (HO)',
      'LaTeX Warning: Reference `in-b\' on page 1 undefined on input line 7.',
      ')) ) extra ) parens )',
      'LaTeX Warning: Reference `in-main\' on page 1 undefined on input line 9.',
    ].join('\n')
    const a = analyzeLatexLog(log(body), { projectFiles: ['main.tex', 'a.sty', 'sub/b.tex'] })
    expect(a.entries.map(e => [e.file, e.line])).toEqual([['sub/b.tex', 7], ['main.tex', 9]])
    expect(a.finalStack).toEqual(['./main.tex'])
  })

  it('does not scan parentheses inside bad-box content, error context or warning continuations', () => {
    const body = [
      '(./sec.tex',
      'Underfull \\hbox (badness 10000) in paragraph at lines 3--4',
      '[]\\T1/ppl/m/n/9 the de-rived fea-ture tree (la-bels',
      ' []',
      '',
      './sec.tex:5: Undefined control sequence.',
      'l.5 (open \\foo',
      '               ',
      'The control sequence at the end of the top line',
      '',
      'Package hyperref Warning: Token not allowed (x',
      '(hyperref)                removing `math shift\' on input line 6.',
      '',
      ')',
      'LaTeX Warning: Reference `r\' on page 1 undefined on input line 12.',
    ].join('\n')
    const a = analyzeLatexLog(log(body), { projectFiles: ['main.tex', 'sec.tex'] })
    expect(a.entries.map(e => [e.level, e.file, e.line])).toEqual([
      ['typesetting', 'sec.tex', 3], ['error', 'sec.tex', 5], ['warning', 'sec.tex', 6], ['warning', 'main.tex', 12],
    ])
    expect(a.entries[1].message).toBe('Undefined control sequence: \\foo')
    expect(a.openParens).toBe(0)
  })

  it('keeps the line only when the innermost file is a project file', () => {
    const body = [
      '(/usr/local/texlive/2026/texmf-dist/tex/latex/foo/foo.sty',
      'Package foo Warning: something on input line 42.',
      ')',
      'Package foo Warning: something else on input line 8.',
    ].join('\n')
    const r = parseLatexLog(log(body), { projectFiles: ['main.tex'] })
    expect(r.warnings.map(e => [e.file, e.line])).toEqual([['main.tex', null], ['main.tex', 8]])
  })

  it('file:line:error lines outside the project fall back to the innermost project file without a line', () => {
    const body = [
      '(/usr/local/texlive/2026/texmf-dist/tex/latex/foo/foo.sty',
      '/usr/local/texlive/2026/texmf-dist/tex/latex/foo/foo.sty:12: Undefined control sequence.',
      'l.12 \\oops',
      '           ',
      ')',
    ].join('\n')
    const r = parseLatexLog(log(body), { projectFiles: ['main.tex'] })
    expect(r.errors.map(e => [e.file, e.line, e.message])).toEqual([['main.tex', null, 'Undefined control sequence: \\oops']])
  })

  it('tracks pdfTeX warnings printed mid-line and page markers', () => {
    const body = [
      '[1{/usr/local/texlive/2026/texmf-var/fonts/map/pdftex/updmap/pdftex.map}] [2] pdfTeX warning (ext4): destination with the same identifier (name{page.1}) has been already used, duplicate ignored',
      '<to be read again> ',
      '                   \\relax ',
      'l.8 \\newpage',
      '             [3]',
      'Missing character: There is no ☃ (U+2603) in font [lmroman10-regular]:mapping=tex-text;!',
    ].join('\n')
    const a = analyzeLatexLog(log(body, XETEX), { projectFiles: ['main.tex'] })
    expect(a.entries.map(e => [e.kind, e.line, e.page])).toEqual([['pdftex-warning', 8, 3], ['missing-character', null, 4]])
  })
})

describe('entries', () => {
  it('only contain the LogEntry contract fields', () => {
    const r = parseLatexLog(log('Overfull \\hbox (1.0pt too wide) in paragraph at lines 3--5\n[]x\n\n'), { projectFiles: ['main.tex'] })
    expect(Object.keys(r.typesetting[0]).sort()).toEqual(['content', 'file', 'hint', 'kind', 'level', 'line', 'lineEnd', 'logLine', 'message', 'page', 'source'])
    expect(r.typesetting[0]).toMatchObject({ file: 'main.tex', line: 3, lineEnd: 5, source: 'latex', page: 1 })
    // logLine points at the message in the raw log
    const raw = log('Overfull \\hbox (1.0pt too wide) in paragraph at lines 3--5\n[]x\n\n').split('\n')
    expect(raw[r.typesetting[0].logLine! - 1]).toMatch(/^Overfull \\hbox/)
  })

  it('parses LaTeX3 / submodule errors and multi-line LaTeX errors', () => {
    const body = [
      '! LaTeX Error: Unicode character ☃ (U+2603)',
      '               not set up for use with LaTeX.',
      '',
      'l.3 Snow ☃',
      '          .',
    ].join('\n')
    const r = parseLatexLog(log(body), { projectFiles: ['main.tex'] })
    expect(r.errors[0]).toMatchObject({ kind: 'unicode-character', line: 3, file: 'main.tex' })
    expect(r.errors[0].message).toBe('LaTeX Error: Unicode character ☃ (U+2603) not set up for use with LaTeX.')
  })

  it('treats "No file x.aux." as info', () => {
    const r = parseLatexLog(log('No file main.aux.'), { projectFiles: ['main.tex'] })
    expect(r.info.map(e => [e.kind, e.message])).toEqual([['no-file', 'No file main.aux.']])
  })

  it('does not classify Info lines or the word Rerun in a Package: line as warnings', () => {
    const body = [
      'Package: rerunfilecheck 2025/06/21 v1.11 Rerun checks for auxiliary files (HO)',
      'Package hyperref Info: Option `colorlinks\' set `true\' on input line 5.',
      'LaTeX Font Info:    Trying to load font information for T1+lmss on input line 108.',
      'Package pgfplots info on input line 3: something',
    ].join('\n')
    expect(parseLatexLog(log(body), { projectFiles: ['main.tex'] }).warnings).toEqual([])
  })

  it('reports an empty or banner-only log without crashing', () => {
    expect(parseLatexLog('', { projectFiles: [] })).toEqual({ errors: [], warnings: [], typesetting: [], info: [] })
    const r = parseLatexLog(PDFTEX + '**main.tex\n(./main.tex\n', { projectFiles: ['main.tex'] })
    expect(r.errors.map(e => e.kind)).toEqual(['log-truncated'])
  })
})

describe('helpers', () => {
  const e = (level: 'error' | 'warning', message: string) => ({ level, message, content: message, file: 'a.tex', line: 1, source: 'latex' as const })
  it('mergeLogs concatenates per level and skips nulls', () => {
    const a: ParsedLog = { errors: [e('error', 'x')], warnings: [], typesetting: [], info: [] }
    const b: ParsedLog = { errors: [e('error', 'y')], warnings: [e('warning', 'w')], typesetting: [], info: [] }
    const m = mergeLogs(a, null, b, undefined)
    expect(m.errors.map(x => x.message)).toEqual(['x', 'y'])
    expect(m.warnings).toHaveLength(1)
  })

  it('groupLogEntries collapses identical entries', () => {
    const g = groupLogEntries([e('warning', 'w'), e('warning', 'w'), e('warning', 'v')])
    expect(g.map(x => [x.entry.message, x.count])).toEqual([['w', 2], ['v', 1]])
  })

  it('hintFor uses our own wording keyed by message', () => {
    expect(hintFor({ message: 'Undefined control sequence: \\foo' })).toMatch(/not defined/)
    expect(hintFor({ message: "LaTeX Warning: Reference `a' on page 1 undefined on input line 3." })).toMatch(/label/)
    expect(hintFor({ message: 'Overfull \\hbox (3.0pt too wide) detected at line 3' })).toMatch(/margin/)
    expect(hintFor({ message: 'Package hyperref Warning: Rerun to get /PageLabels entry.' })).toMatch(/Recompil/)
    expect(hintFor({ message: "LaTeX Font Warning: Font shape `OT1/cmr/bx/sc' undefined" })).toMatch(/font/)
    expect(hintFor({ message: 'something unknown' })).toBeUndefined()
  })
})

describe('limits', () => {
  it('caps the number of entries per level and the size of each entry', () => {
    const many = Array.from({ length: 1205 }, (_, i) => `LaTeX Warning: Reference \`r${i}' on page 1 undefined on input line ${i + 1}.\n`).join('\n')
    const r = parseLatexLog(log(many), { projectFiles: ['main.tex'] })
    expect(r.warnings).toHaveLength(1000)
    expect(r.info.map(e => [e.kind, e.message])).toEqual([['truncated-list', '205 more warnings were not listed; see the raw log.']])
    const box = `Overfull \\hbox (1.0pt too wide) in paragraph at lines 3--5\n${'x'.repeat(9000)}\n\n`
    const b = parseLatexLog(log(box), { projectFiles: ['main.tex'] })
    expect(b.typesetting[0].content.length).toBeLessThan(4100)
  })
})

describe('review fixes', () => {
  it("xr's warning keeps its text and line ('No file x.aux' / 'LABELS NOT IMPORTED.' have no (xr) prefix)", () => {
    const body = 'Package xr Warning: \nNo file supp.aux\nLABELS NOT IMPORTED.\n on input line 3.\n\n(./other.tex)'
    const r = parseLatexLog(log(body), { projectFiles: ['main.tex', 'other.tex'] })
    expect(r.warnings).toHaveLength(1)
    const w = r.warnings[0]
    expect(w.message).toBe('Package xr Warning: No file supp.aux LABELS NOT IMPORTED. on input line 3.')
    expect([w.file, w.line, w.kind]).toEqual(['main.tex', 3, 'xr-no-file'])
    expect(w.hint).toMatch(/External documents/)
  })

  it('a warning with an empty first line never swallows the next message', () => {
    const body = 'Package foo Warning: \n(./other.tex\nLaTeX Warning: Reference `a\' on page 1 undefined on input line 2.\n)'
    const r = parseLatexLog(log(body), { projectFiles: ['main.tex', 'other.tex'] })
    expect(r.warnings.map(w => [w.file, w.line, w.kind])).toEqual([['main.tex', null, 'package-warning'], ['other.tex', 2, 'undefined-reference']])
  })

  it('maps files outside the root folder (../shared/defs.tex) when the project list names them', () => {
    // root paper/main.tex: TeX runs in /compile/paper and prints paths relative to it
    const body = '(./sections/intro.tex\n./sections/intro.tex:2: Undefined control sequence.\nl.2 \\introbad\n\n)\n(../shared/defs.tex\n../shared/defs.tex:2: Undefined control sequence.\nl.2 \\sharedbad\n\n)'
    const files = ['main.tex', 'sections/intro.tex', '../shared/defs.tex']
    const r = parseLatexLog(log(body), { projectFiles: files, compileDir: '/compile/paper' })
    expect(r.errors.map(e => [e.file, e.line, e.message])).toEqual([
      ['sections/intro.tex', 2, 'Undefined control sequence: \\introbad'],
      ['../shared/defs.tex', 2, 'Undefined control sequence: \\sharedbad'],
    ])
    // without a project list, '../' names are still not project files
    const r2 = parseLatexLog(log(body), { projectFiles: [], compileDir: '/compile/paper' })
    expect(r2.errors.map(e => e.file)).toEqual(['sections/intro.tex', 'main.tex'])
  })

  it('reports a .bib file latexmk could not find (it vetoes BibTeX, so there is no .blg)', () => {
    // latexmk 4.88 output for \bibliography{nosuchbib} (the relevant part is printed twice per run)
    const out = [
      'Latexmk: Failed to find one or more bibliography files in search path.',
      'Latexmk: Found bibliography file(s):',
      '  nosuchbib.bib',
      'Bib file(s) not found in search path:',
      '  nosuchbib.bib',
      "Latexmk: Veto of running of 'bibtex main' ($bibtex_use=1)",
      'the setting for the non-use/conditional use of bibtex/biber:',
      '  bibtex main',
      'Reason: I am configured only to use bibtex/biber if all .bib files exist,',
      "but the following didn't:",
      '  nosuchbib.bib',
      '  Latex failed to resolve 1 citation(s)',
    ].join('\n')
    const src: Record<string, string> = {
      'main.tex': '\\documentclass{article}\n\\begin{document}\nSee \\cite{a}.\n\\bibliographystyle{plain}\n\\bibliography{refs,nosuchbib}\n\\end{document}\n',
    }
    const r = parseLatexmkOutput(out, { projectFiles: ['main.tex'], rootPath: 'main.tex', getSource: p => src[p] })
    expect(r.errors.map(e => [e.kind, e.message, e.file, e.line])).toEqual([['missing-bib', 'Bibliography file "nosuchbib.bib" not found', 'main.tex', 5]])
    expect(r.errors[0].hint).toMatch(/\.bib file/)
    // without sources: still reported, without a location
    expect(parseLatexmkOutput(out).errors.map(e => [e.file, e.line])).toEqual([[null, null]])
    expect(parseLatexmkOutput('Latexmk: All targets (main.pdf) are up-to-date\n').errors).toEqual([])
  })
})
