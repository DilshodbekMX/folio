/**
 * Golden tests on logs generated with texlive/texlive:latest-full (TeX Live 2026) through
 * latexmk with the compile argv of SPEC §4.5 — with the env vars that disable wrapping
 * (max_print_line=10000 …) and without them (wrapped at 79) — plus logs from the research
 * phase (fixtures/texlog/research, sources in research/sources).
 */
import { describe, expect, it } from 'vitest'
import {
  analyzeBiberLog, analyzeBibtexLog, analyzeLatexLog, mergeLogs, parseBiberLog, parseBibtexLog, parseBlg,
  parseLatexLog, parseLatexmkOutput, summarizeLatexmk,
} from '../src/texlog/index.ts'
import { brief, counts, fixture, fixtureText, sourcesIn, type Brief } from './helpers.ts'

const SYN = ['errors.tex', 'sections/intro.tex', 'my dir/file name.tex', 'xerrors.tex', 'missingfile.tex', 'missingpkg.tex',
  'noend.tex', 'bt.tex', 'bb.tex', 'bb2.tex', 'bb3.tex', 'refs.bib', 'refs2.bib', 'refs3.bib']
const opts = (root: string) => ({ projectFiles: SYN, rootPath: root, getSource: sourcesIn('texlog/sources') })

const ERRORS_COMMON: Brief[] = [
  ['error', 'undefined-control-sequence', 'errors.tex', 5],
  ['error', 'missing-dollar', 'errors.tex', 6],
  ['error', 'missing-dollar', 'sections/intro.tex', 1],
  ['error', 'undefined-control-sequence', 'sections/intro.tex', 3],
  ['error', 'package-error', 'errors.tex', 13],
  ['error', 'runaway-argument', 'errors.tex', 16],
  ['error', 'tex-error', 'errors.tex', 16],
]
const WARNINGS_HEAD: Brief[] = [
  ['warning', 'latex-warning', 'errors.tex', null],
  ['warning', 'multiply-defined', 'errors.tex', 12],
  ['warning', 'multiply-defined', 'errors.tex', 12],
  ['warning', 'package-warning', 'errors.tex', 4],
  ['warning', 'package-warning', 'errors.tex', 4],
  ['warning', 'package-warning', 'errors.tex', 4],
  ['warning', 'undefined-reference', 'errors.tex', 7],
  ['warning', 'undefined-citation', 'errors.tex', 7],
  ['warning', 'font-warning', 'errors.tex', 10],
]
const WARNINGS_TAIL: Brief[] = [
  ['warning', 'summary', 'errors.tex', null],
  ['warning', 'summary', 'errors.tex', null],
  ['warning', 'summary', 'errors.tex', null],
]
const BOXES: Brief[] = [
  ['typesetting', 'overfull-hbox', 'my dir/file name.tex', 2],
  ['typesetting', 'overfull-hbox', 'errors.tex', 11],
  ['typesetting', 'overfull-hbox', 'errors.tex', 18],
  ['typesetting', 'overfull-hbox', 'errors.tex', 21],
  ['typesetting', 'underfull-hbox', 'errors.tex', 21],
  ['typesetting', 'underfull-hbox', 'errors.tex', 21],
]

describe('errors.tex with pdfLaTeX', () => {
  for (const variant of ['errors-pdf', 'errors-pdf-wrap']) {
    it(`${variant}: every problem at the right file and line`, () => {
      const log = parseLatexLog(fixture(`texlog/synthetic/${variant}.log`), opts('errors.tex'))
      expect(counts(log)).toEqual({ errors: 8, warnings: 12, typesetting: 6, info: 0 })
      expect(brief(log.errors)).toEqual([...ERRORS_COMMON, ['error', 'unicode-character', 'errors.tex', 22]])
      expect(brief(log.warnings)).toEqual([...WARNINGS_HEAD, ...WARNINGS_TAIL])
      expect(brief(log.typesetting)).toEqual(BOXES)
      expect(log.typesetting.map(e => e.lineEnd ?? null)).toEqual([null, null, 19, 21, 21, 21])
    })
  }

  it('builds useful messages, contents and hints', () => {
    const log = parseLatexLog(fixture('texlog/synthetic/errors-pdf.log'), opts('errors.tex'))
    const [ucs, dollar] = log.errors
    expect(ucs.message).toBe('Undefined control sequence: \\undefinedmacro')
    expect(ucs.content).toMatch(/^\.\/errors\.tex:5: Undefined control sequence\.\nl\.5 Text with \\undefinedmacro\n/)
    expect(ucs.content).toMatch(/and I'll forget about whatever was undefined\.$/)
    expect(ucs.hint).toMatch(/usepackage/)
    expect(dollar.message).toBe('Missing $ inserted.')
    expect(dollar.hint).toMatch(/math/)
    expect(log.errors[3].message).toBe('Undefined control sequence: \\anotherundefined')
    const pkg = log.errors[4]
    expect(pkg.message).toBe('Package mypkg Error: Something went wrong.')
    expect(pkg.content).toMatch(/This is the help text\non two lines\.$/)
    const runaway = log.errors[5]
    expect(runaway.message).toBe('Paragraph ended before \\text@command was complete.')
    expect(runaway.content.startsWith('Runaway argument?\n{runaway')).toBe(true)
    expect(runaway.hint).toMatch(/closing brace/)
    const uni = log.errors[7]
    expect(uni.message).toBe('LaTeX Error: Unicode character ☃ (U+2603) not set up for use with LaTeX.')
    expect(uni.hint).toMatch(/XeLaTeX or LuaLaTeX/)
    const font = log.warnings[8]
    expect(font.message).toBe("LaTeX Font Warning: Font shape `OT1/cmr/bx/sc' undefined using `OT1/cmr/bx/n' instead on input line 10.")
    expect(log.warnings[0].message).toBe('LaTeX Warning: Unused global option(s): [nonexistentoption].')
    expect(log.warnings[6].hint).toMatch(/label/)
    expect(log.typesetting[0].hint).toMatch(/margin/)
  })

  it('without sources the multiply-defined labels stay on the root without a line', () => {
    const log = parseLatexLog(fixture('texlog/synthetic/errors-pdf.log'), { projectFiles: SYN })
    const md = log.warnings.filter(e => e.kind === 'multiply-defined')
    expect(md.map(e => [e.file, e.line])).toEqual([['errors.tex', null], ['errors.tex', null]])
  })

  it('wrapped and unwrapped logs give the same entries', () => {
    const key = (l: ReturnType<typeof parseLatexLog>) => [...l.errors, ...l.warnings, ...l.typesetting].map(e => [e.level, e.kind, e.message, e.file, e.line, e.lineEnd ?? null])
    expect(key(parseLatexLog(fixture('texlog/synthetic/errors-pdf-wrap.log'), opts('errors.tex'))))
      .toEqual(key(parseLatexLog(fixture('texlog/synthetic/errors-pdf.log'), opts('errors.tex'))))
    expect(key(parseLatexLog(fixture('texlog/synthetic/errors-xe-wrap.log'), opts('errors.tex'))))
      .toEqual(key(parseLatexLog(fixture('texlog/synthetic/errors-xe.log'), opts('errors.tex'))))
  })

  it('keeps the stack balanced', () => {
    for (const v of ['errors-pdf', 'errors-pdf-wrap', 'errors-xe', 'errors-xe-wrap']) {
      const a = analyzeLatexLog(fixture(`texlog/synthetic/${v}.log`), opts('errors.tex'))
      expect(a.finalStack).toEqual(['./errors.tex'])
      expect(a.openParens).toBe(0)
      expect(a.complete).toBe(true)
    }
  })
})

describe('errors.tex with XeLaTeX', () => {
  it('reports a missing character instead of the Unicode error', () => {
    for (const v of ['errors-xe', 'errors-xe-wrap']) {
      const log = parseLatexLog(fixture(`texlog/synthetic/${v}.log`), opts('errors.tex'))
      expect(counts(log)).toEqual({ errors: 7, warnings: 13, typesetting: 6, info: 0 })
      expect(brief(log.errors)).toEqual(ERRORS_COMMON)
      expect(brief(log.warnings)).toEqual([...WARNINGS_HEAD, ['warning', 'missing-character', 'errors.tex', null], ...WARNINGS_TAIL])
      expect(log.warnings[9].message).toBe('Missing character: There is no ☃ (U+2603) in font [lmroman10-bold]:mapping=tex-text;!')
      expect(log.warnings[8].message).toMatch(/Font shape `TU\/lmr\/bx\/sc' undefined/)
    }
  })

  it('xerrors.tex: missing characters (incl. an emoji that XeTeX wraps by code points)', () => {
    for (const v of ['xerrors-xe', 'xerrors-xe-wrap']) {
      const log = parseLatexLog(fixture(`texlog/synthetic/${v}.log`), opts('xerrors.tex'))
      expect(brief(log.errors)).toEqual([['error', 'undefined-control-sequence', 'xerrors.tex', 4]])
      expect(brief(log.warnings)).toEqual([
        ['warning', 'missing-character', 'xerrors.tex', null],
        ['warning', 'missing-character', 'xerrors.tex', null],
        ['warning', 'font-warning', 'xerrors.tex', 5],
        ['warning', 'summary', 'xerrors.tex', null],
      ])
      expect(log.warnings[1].message).toBe('Missing character: There is no 😀 (U+1F600) in font [lmroman10-regular]:mapping=tex-text;!')
      expect(log.warnings[0].hint).toMatch(/glyph/)
    }
  })
})

describe('fatal errors', () => {
  it('missing \\input file: the line comes from the Emergency stop that follows', () => {
    const log = parseLatexLog(fixture('texlog/synthetic/missingfile.log'), opts('missingfile.tex'))
    expect(brief(log.errors)).toEqual([
      ['error', 'missing-file', 'missingfile.tex', 3],
      ['error', 'emergency-stop', 'missingfile.tex', 3],
    ])
    expect(log.errors[0].message).toBe("LaTeX Error: File `doesnotexist.tex' not found.")
    expect(log.errors[0].hint).toMatch(/file could not be found/)
    expect(log.errors[1].hint).toMatch(/first error/)
    const a = analyzeLatexLog(fixture('texlog/synthetic/missingfile.log'), opts('missingfile.tex'))
    expect(a.entries[1].secondary).toBe(true)
    expect(a.pages).toBeNull()
  })

  it('missing package: the line of \\usepackage is found in the preamble', () => {
    const log = parseLatexLog(fixture('texlog/synthetic/missingpkg.log'), opts('missingpkg.tex'))
    expect(brief(log.errors)).toEqual([
      ['error', 'missing-file', 'missingpkg.tex', 2],
      ['error', 'emergency-stop', 'missingpkg.tex', 3],
    ])
    // without sources TeX's own line (\begin{document}) is kept
    const plain = parseLatexLog(fixture('texlog/synthetic/missingpkg.log'), { projectFiles: SYN })
    expect(plain.errors[0].line).toBe(3)
  })

  it('no \\end{document}', () => {
    const log = parseLatexLog(fixture('texlog/synthetic/noend.log'), opts('noend.tex'))
    expect(brief(log.errors)).toEqual([['error', 'emergency-stop', 'noend.tex', null]])
    expect(log.errors[0].message).toBe('Emergency stop: job aborted, no legal \\end found')
    expect(log.errors[0].hint).toMatch(/\\end\{document\}/)
  })

  it('a truncated log (killed compile) gets an explicit error', () => {
    const text = fixtureText('texlog/synthetic/errors-pdf.log')
    const cut = text.slice(0, text.indexOf('./errors.tex:13:'))
    const log = parseLatexLog(cut, opts('errors.tex'))
    expect(log.errors.at(-1)!.kind).toBe('log-truncated')
    expect(log.errors.at(-1)!.file).toBeNull()
    expect(log.errors.filter(e => e.kind !== 'log-truncated')).toHaveLength(4)
  })
})

describe('BibTeX', () => {
  const blg = fixtureText('texlog/synthetic/bt.blg')

  it('bt.blg: 2 errors and 9 warnings located in refs.bib', () => {
    const log = parseBibtexLog(blg, opts('bt.tex'))
    expect(counts(log)).toEqual({ errors: 2, warnings: 9, typesetting: 0, info: 0 })
    expect(log.errors.map(e => [e.message, e.file, e.line, e.source])).toEqual([
      ['Repeated entry', 'refs.bib', 14, 'bibtex'],
      ["I was expecting a `,' or a `}' (the error may be on the previous line)", 'refs.bib', 22, 'bibtex'],
    ])
    expect(log.warnings.map(e => [e.message, e.file, e.line])).toEqual([
      ['string name "undefinedmacro" is undefined', 'refs.bib', 30],
      ['I didn\'t find a database entry for "missingkey"', 'bt.tex', 3],
      ['to sort, need author or key in broken', 'refs.bib', 21],
      ['empty author in broken', 'refs.bib', 21],
      ['empty title in broken', 'refs.bib', 21],
      ['empty journal in broken', 'refs.bib', 21],
      ['empty year in broken', 'refs.bib', 21],
      ['empty journal in macroerr', 'refs.bib', 27],
      ['empty journal in nojournal', 'refs.bib', 8],
    ])
    expect(log.errors[0].hint).toMatch(/twice/)
    expect(log.errors[1].content).toContain('I\'m skipping whatever remains of this entry')
    expect(log.warnings[1].kind).toBe('undefined-citation')
    const detailed = analyzeBibtexLog(blg, opts('bt.tex'))
    expect(detailed.map(e => e.logLine)).toEqual([6, 10, 15, 17, 18, 19, 20, 21, 22, 23, 24])
    expect(detailed[4].key).toBe('broken')
  })

  it('without sources key-based warnings have no location', () => {
    const log = parseBibtexLog(blg, { projectFiles: SYN })
    expect(log.warnings[3].file).toBeNull()
    expect(log.warnings[0].file).toBe('refs.bib')
  })

  it('parseBlg detects BibTeX and the LaTeX log of the same run has the undefined citation', () => {
    expect(counts(parseBlg(blg, opts('bt.tex')))).toEqual({ errors: 2, warnings: 9, typesetting: 0, info: 0 })
    const latex = parseLatexLog(fixture('texlog/synthetic/bt.log'), opts('bt.tex'))
    expect(brief(latex.warnings)).toEqual([['warning', 'undefined-citation', 'bt.tex', 3], ['warning', 'summary', 'bt.tex', null]])
    const merged = mergeLogs(latex, parseBlg(blg, opts('bt.tex')))
    expect(counts(merged)).toEqual({ errors: 2, warnings: 11, typesetting: 0, info: 0 })
  })
})

describe('Biber', () => {
  it('syntax error in the hashed temp file maps to the .bib data source (bb3.blg)', () => {
    const log = parseBiberLog(fixtureText('texlog/synthetic/bb3.blg'), opts('bb3.tex'))
    expect(log.errors.map(e => [e.message, e.file, e.line, e.source])).toEqual([
      ['syntax error: found "author", expected ","', 'refs3.bib', 9, 'biber'],
    ])
    expect(log.warnings.map(e => [e.kind, e.file, e.line])).toEqual([['duplicate-entry', 'refs3.bib', 14]])
    expect(log.errors[0].hint).toMatch(/comma/)
  })

  it('research fixture fx3/bb.blg: refs.bib:22 and the second "good"', () => {
    const log = parseBiberLog(fixtureText('texlog/research/fx3-bb.blg'), opts('bb.tex'))
    expect(log.errors.map(e => [e.file, e.line])).toEqual([['refs.bib', 22]])
    expect(log.warnings.map(e => [e.message, e.file, e.line])).toEqual([["Duplicate entry key: 'good' in file 'refs.bib', skipping ...", 'refs.bib', 14]])
  })

  it('warnings: duplicate key, bad date, missing entry (bb2.blg)', () => {
    const d = analyzeBiberLog(fixtureText('texlog/synthetic/bb2.blg'), opts('bb2.tex'))
    expect(d.map(e => [e.level, e.kind, e.key, e.file, e.line, e.logLine])).toEqual([
      ['warning', 'duplicate-entry', 'beta', 'refs2.bib', 15, 16],
      ['warning', 'biber-warning', 'alpha', 'refs2.bib', 1, 17],
      ['warning', 'undefined-citation', 'gamma', 'bb2.tex', 5, 18],
    ])
    expect(counts(parseBlg(fixtureText('texlog/synthetic/bb2.blg'), opts('bb2.tex')))).toEqual({ errors: 0, warnings: 3, typesetting: 0, info: 0 })
  })

  it('a crashing biber (FATAL) is blamed on the data source', () => {
    const log = parseBiberLog(fixtureText('texlog/synthetic/bb-segv.blg'), opts('bb.tex'))
    expect(log.errors).toHaveLength(1)
    expect(log.errors[0].message).toMatch(/^Caught signal: SEGV Likely your \.bib has a very bad entry/)
    expect(log.errors[0].file).toBe('refs.bib')
    expect(log.errors[0].line).toBeNull()
  })

  it("biblatex's straight-quoted undefined citations and the rerun request (bb3.log)", () => {
    const log = parseLatexLog(fixture('texlog/synthetic/bb3.log'), opts('bb3.tex'))
    expect(brief(log.warnings)).toEqual([
      ['warning', 'undefined-citation', 'bb3.tex', 5],
      ['warning', 'undefined-citation', 'bb3.tex', 5],
      ['warning', 'latex-warning', 'bb3.tex', 6],
      ['warning', 'summary', 'bb3.tex', null],
      ['warning', 'rerun', 'bb3.tex', null],
    ])
    expect(log.warnings[0].message).toBe("LaTeX Warning: Citation 'good' on page 1 undefined on input line 5.")
    expect(log.warnings[4].message).toBe('Package biblatex Warning: Please (re)run Biber on the file: bb3 and rerun LaTeX afterwards.')
  })

  it('biblatex warnings emitted while reading the .bbl stay on the root', () => {
    const log = parseLatexLog(fixture('texlog/synthetic/bb2.log'), opts('bb2.tex'))
    expect(brief(log.warnings)).toEqual([
      ['warning', 'package-warning', 'bb2.tex', null],
      ['warning', 'package-warning', 'bb2.tex', null],
      ['warning', 'undefined-citation', 'bb2.tex', 5],
    ])
  })
})

describe('latexmk output', () => {
  it('has no xdvipdfmx problems for a normal run', () => {
    expect(counts(parseLatexmkOutput(fixtureText('texlog/synthetic/errors-xe.latexmk.txt')))).toEqual({ errors: 0, warnings: 0, typesetting: 0, info: 0 })
  })

  it('summarises the run', () => {
    expect(summarizeLatexmk(fixtureText('texlog/synthetic/errors-xe.latexmk.txt'))).toEqual({
      version: '4.88', runs: 2, unstable: false, hadErrors: true, upToDate: false,
    })
  })

  it('surfaces xdvipdfmx warnings and unstable references', () => {
    const out = parseLatexmkOutput([
      'xdvipdfmx:warning: Could not locate a virtual/physical font for TFM "foo".',
      'xdvipdfmx:fatal: Cannot proceed without .vf or "physical" font for PDF output...',
      'Latexmk: Maximum runs of pdflatex reached without getting stable files',
    ].join('\n'))
    expect(out.errors.map(e => [e.kind, e.source, e.file])).toEqual([['xdvipdfmx-fatal', 'latexmk', null]])
    expect(out.warnings.map(e => e.kind)).toEqual(['xdvipdfmx-warning', 'unstable'])
  })
})

describe('research fixtures (fx: paths with spaces and parentheses, long wrapped paths)', () => {
  const FX = ['main.tex', 'sections/intro.tex', 'my dir/file name.tex', 'figs (old)/part.tex',
    'a-very-long-directory-name-that-keeps-going-and-going/another-long-directory-name-for-wrap-test/deep.tex']
  const DEEP = FX[4]
  const expected = { pdflatex: [11, 5], xelatex: [12, 5], lualatex: [11, 10] } as const
  const variants = ['pdflatex-wrapped', 'xelatex-wrapped', 'lualatex-wrapped', 'pdflatex-unwrapped', 'xelatex-unwrapped',
    'lualatex-unwrapped', 'pdflatex-fle', 'lualatex-fle']
  for (const v of variants) {
    it(`fx-${v}`, () => {
      const engine = v.split('-')[0] as keyof typeof expected
      const a = analyzeLatexLog(fixture(`texlog/research/fx-${v}.log`), { projectFiles: FX })
      const log = parseLatexLog(fixture(`texlog/research/fx-${v}.log`), { projectFiles: FX })
      expect(brief(log.errors)).toEqual([
        ['error', 'undefined-control-sequence', 'sections/intro.tex', 3],
        ['error', 'undefined-control-sequence', 'figs (old)/part.tex', 2],
        ['error', 'undefined-control-sequence', DEEP, 2],
        ['error', 'undefined-control-sequence', 'main.tex', 18],
      ])
      expect(log.warnings).toHaveLength(expected[engine][0])
      expect(log.typesetting).toHaveLength(expected[engine][1])
      expect(log.info.map(e => e.message)).toEqual(['No file main.aux.'])
      expect(log.typesetting[0]).toMatchObject({ file: 'my dir/file name.tex', line: 2 })
      expect(log.warnings.find(e => e.kind === 'undefined-reference')).toMatchObject({ file: 'sections/intro.tex', line: 4 })
      expect(log.warnings.find(e => e.kind === 'undefined-citation')).toMatchObject({ file: 'sections/intro.tex', line: 4 })
      expect(log.warnings.find(e => e.kind === 'font-warning')).toMatchObject({ file: 'main.tex', line: 10 })
      expect(a.finalStack).toEqual(['./main.tex'])
      expect(a.openParens).toBe(0)
    })
  }

  it('fx2 errors: alignment/vbox/output boxes, environment mismatch, package error with parentheses', () => {
    for (const v of ['fx2-errors', 'fx2-errors-fle']) {
      const log = parseLatexLog(fixture(`texlog/research/${v}.log`), { projectFiles: ['errors.tex'] })
      expect(brief(log.errors)).toEqual([
        ['error', 'missing-dollar', 'errors.tex', 5],
        ['error', 'missing-dollar', 'errors.tex', 6],
        ['error', 'latex-error', 'errors.tex', 13],
        ['error', 'package-error', 'errors.tex', 15],
      ])
      expect(log.errors[2].message).toBe('LaTeX Error: \\begin{itemize} on input line 11 ended by \\end{enumerate}.')
      expect(log.errors[2].hint).toMatch(/\\begin\{x\}/)
      expect(log.errors[3].message).toBe('Package mypkg Error: Something bad happened (really).')
      expect(brief(log.typesetting)).toEqual([
        ['typesetting', 'overfull-hbox', 'errors.tex', 17],
        ['typesetting', 'overfull-vbox', 'errors.tex', 19],
        ['typesetting', 'overfull-vbox', 'errors.tex', null],
      ])
      expect(log.typesetting[0].message).toMatch(/in alignment at lines 17--17/)
      expect(brief(log.warnings)).toEqual([
        ['warning', 'latex-warning', 'errors.tex', null],
        ['warning', 'undefined-reference', 'errors.tex', 25],
        ['warning', 'undefined-reference', 'errors.tex', 25],
        ['warning', 'summary', 'errors.tex', null],
      ])
      expect(log.warnings[0].hint).toMatch(/htbp/)
    }
  })

  it('fx2 missing characters per engine and a multi-byte message wrapped differently by each engine', () => {
    const src = fixtureText('texlog/research/sources/fx2-missingchar.tex')
    const e = /Unicode wrap test: (é+) end of message here/.exec(src)![1]
    const wanted = `Package testpkg Warning: Unicode wrap test: ${e} end of message here on input line 4.`
    const pdf = parseLatexLog(fixture('texlog/research/fx2-missingchar-pdflatex.log'), { projectFiles: ['missingchar.tex'] })
    expect(pdf.errors.map(x => [x.kind, x.line])).toEqual([['unicode-character', 3], ['unicode-character', 3], ['unicode-character', 3], ['unicode-character', 3]])
    const xe = parseLatexLog(fixture('texlog/research/fx2-missingchar-xelatex.log'), { projectFiles: ['missingchar.tex'] })
    expect(xe.warnings.filter(x => x.kind === 'missing-character')).toHaveLength(4)
    const lua = parseLatexLog(fixture('texlog/research/fx2-missingchar-lualatex.log'), { projectFiles: ['missingchar.tex'] })
    expect(lua.warnings.filter(x => x.kind === 'missing-character')).toHaveLength(12)
    for (const log of [pdf, xe, lua]) {
      expect(log.warnings.find(x => /Unicode wrap test/.test(x.message))!.message).toBe(wanted)
      expect(log.warnings.find(x => /Second message/.test(x.message))!.message)
        .toBe('Package testpkg Warning: Second message with ascii only padding padding padding padding padding padding padding.')
    }
  })

  it('fx6: pdfTeX warning with TeX context gets the l.N line', () => {
    const log = parseLatexLog(fixture('texlog/research/fx6-dup.log'), { projectFiles: ['dup.tex'] })
    const w = log.warnings.find(x => x.kind === 'pdftex-warning')!
    expect(w.message).toBe('pdfTeX warning (ext4): destination with the same identifier (name{page.1}) has been already used, duplicate ignored')
    expect([w.file, w.line]).toEqual(['dup.tex', 8])
    expect(brief(log.errors)).toEqual([['error', 'missing-file', 'dup.tex', 9]])
    expect(log.warnings.find(x => x.kind === 'rerun')!.message).toMatch(/rerunfilecheck Warning: File `dup\.out' has changed/)
  })

  it('fx7: expl3 warning continuation, errors with multi-paragraph help, missing character error', () => {
    const a = analyzeLatexLog(fixture('texlog/research/fx7-l3.log'), { projectFiles: ['l3.tex'] })
    const log = parseLatexLog(fixture('texlog/research/fx7-l3.log'), { projectFiles: ['l3.tex'] })
    expect(log.warnings[0].message).toBe('Package mymod Warning: First line second line (with paren)')
    expect(brief(log.errors)).toEqual([
      ['error', 'package-error', 'l3.tex', 6],
      ['error', 'latex-error', 'l3.tex', 10],
      ['error', 'missing-character', 'l3.tex', 13],
    ])
    expect(log.errors[1].message).toBe("LaTeX cmd Error: Command '\\foo' already defined.")
    expect(log.errors[1].content).toMatch(/The existing definition of '\\foo' will not be altered\.$/)
    expect(a.finalStack).toEqual(['./l3.tex'])
    expect(a.openParens).toBe(0)
  })
})
