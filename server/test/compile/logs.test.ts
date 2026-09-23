/**
 * parseCompileLogs: a root document in a sub-folder (TeX runs there, latexmk -cd), inputs
 * outside that folder ('../shared/defs.tex'), and latexmk-only problems (missing .bib).
 */
import { describe, expect, it } from 'vitest'
import { parseCompileLogs } from '../../src/compile/logs.ts'

const BANNER = 'This is pdfTeX, Version 3.141592653-2.6-1.40.29 (TeX Live 2026) (preloaded format=pdflatex)\n'
const END = '\nHere is how much of TeX\'s memory you used:\n 1 string\n'

describe('parseCompileLogs', () => {
  it('maps files inside and outside the root folder back to project paths', async () => {
    const log = BANNER + [
      '**main.tex',
      '(./main.tex',
      'LaTeX2e <2026-06-01>',
      '(./sections/intro.tex',
      './sections/intro.tex:2: Undefined control sequence.',
      'l.2 \\introbad',
      '',
      ')',
      '(../shared/defs.tex',
      '../shared/defs.tex:2: Undefined control sequence.',
      'l.2 \\sharedbad',
      '',
      ')',
      ')',
    ].join('\n') + END
    const sources: Record<string, string> = { 'paper/main.tex': '', 'paper/sections/intro.tex': 'x\n\\introbad\n', 'shared/defs.tex': 'y\n\\sharedbad\n' }
    const parsed = await parseCompileLogs({
      logBytes: Buffer.from(log), blgText: null, stdout: '',
      projectFiles: ['paper/main.tex', 'paper/sections/intro.tex', 'shared/defs.tex', 'other/unrelated.tex'],
      rootPath: 'paper/main.tex', texCompileDir: '/compile', getSource: p => sources[p] ?? null,
    })
    expect(parsed!.errors.map(e => [e.file, e.line, e.message])).toEqual([
      ['paper/sections/intro.tex', 2, 'Undefined control sequence: \\introbad'],
      ['shared/defs.tex', 2, 'Undefined control sequence: \\sharedbad'],
    ])
  })

  it('reports a .bib file latexmk could not find, at the \\bibliography that names it', async () => {
    const stdout = 'Bib file(s) not found in search path:\n  nosuchbib.bib\nLatexmk: Veto of running of \'bibtex main\' ($bibtex_use=1)\n'
    const parsed = await parseCompileLogs({
      logBytes: Buffer.from(BANNER + '**main.tex\n(./main.tex\n)' + END), blgText: null, stdout,
      projectFiles: ['paper/main.tex'], rootPath: 'paper/main.tex', texCompileDir: '/compile',
      getSource: p => (p === 'paper/main.tex' ? '\\documentclass{article}\n\\begin{document}\n\\bibliography{nosuchbib}\n\\end{document}\n' : null),
    })
    expect(parsed!.errors.map(e => [e.kind, e.file, e.line])).toEqual([['missing-bib', 'paper/main.tex', 3]])
  })
})
