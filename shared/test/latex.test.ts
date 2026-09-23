import { describe, expect, it } from 'vitest'
import {
  extractBibitems, extractBibKeys, extractExternalDocuments, extractIncludes, extractLabels, extractOutline,
  hasDocumentclass, maskLatex, plainTitle, resolveInclude, stripComments,
} from '../src/latex/index.ts'
import { fixtureText, hasFixture, optionalFixtureText } from './helpers.ts'

// The paper fixtures are not distributed (they are an unpublished manuscript); this suite skips without them.
describe.skipIf(!hasFixture('paper/antiddos_v2.tex'))('the real paper', () => {
  const main = optionalFixtureText('paper/antiddos_v2.tex')
  const supp = optionalFixtureText('paper/antiddos_v2_supplementary.tex')

  it('outline: 5 sections and 18 subsections with their lines', () => {
    const o = extractOutline(main)
    expect(o).toHaveLength(23)
    expect(o.filter(i => i.command === 'section')).toHaveLength(5)
    expect(o.filter(i => i.command === 'subsection')).toHaveLength(18)
    expect(o[0]).toMatchObject({ level: 1, title: 'Introduction', line: 114, command: 'section', starred: false })
    expect(o[2]).toMatchObject({ level: 2, title: 'Corpora, Window Construction, and Label Provenance', line: 170 })
    expect(o.at(-1)).toMatchObject({ title: 'Conclusions and Future Work', line: 1380 })
    expect(o.map(i => i.line)).toEqual([...o.map(i => i.line)].sort((a, b) => a - b))
  })

  it('39 labels, 63 bibitems, \\documentclass and the xr external document', () => {
    const labels = extractLabels(main)
    expect(labels).toHaveLength(39)
    expect(labels[0]).toEqual({ label: 'sec:intro', line: 114 })
    const items = extractBibitems(main)
    expect(items).toHaveLength(63)
    expect(items.find(b => b.key === 'Siffer2017Anomaly')!.line).toBe(1545)
    expect(new Set(items.map(b => b.key)).size).toBe(63)
    expect(hasDocumentclass(main)).toBe(true)
    expect(extractExternalDocuments(main)).toEqual([{ name: 'antiddos_v2_supplementary', line: 106 }])
    expect(extractExternalDocuments(supp)).toEqual([{ name: 'antiddos_v2', line: 67 }])
    expect(extractBibitems(supp)).toHaveLength(12)
  })

  it('includes: class, packages and the external document', () => {
    const inc = extractIncludes(main)
    expect(inc).toContainEqual({ command: 'documentclass', path: 'Definitions/mdpi', line: 8 })
    expect(inc).toContainEqual({ command: 'externaldocument', path: 'antiddos_v2_supplementary', line: 106 })
    expect(resolveInclude({ command: 'documentclass', path: 'Definitions/mdpi' }, ['Definitions/mdpi.cls', 'antiddos_v2.tex'])).toBe('Definitions/mdpi.cls')
    expect(resolveInclude({ command: 'externaldocument', path: 'antiddos_v2_supplementary' }, ['antiddos_v2_supplementary.tex'])).toBe('antiddos_v2_supplementary.tex')
  })

  it('is fast enough to run on every keystroke batch', () => {
    const t0 = performance.now()
    for (let i = 0; i < 5; i++) extractOutline(main)
    expect((performance.now() - t0) / 5).toBeLessThan(100)
  })
})

describe('comments and verbatim', () => {
  it('stripComments removes unescaped % comments only', () => {
    const src = 'a % comment\n50\\% of b\\\\% gone\n\\verb|%not| x % c\n'
    expect(stripComments(src)).toBe('a \n50\\% of b\\\\\n\\verb|%not| x \n')
    expect(stripComments(src, { preserveOffsets: true })).toBe('a          \n50\\% of b\\\\      \n\\verb|%not| x    \n')
  })

  it('keeps % inside verbatim-like environments', () => {
    const src = '\\begin{verbatim}\n100% sure \\section{No}\n\\end{verbatim}\n% real comment\n'
    expect(stripComments(src)).toBe('\\begin{verbatim}\n100% sure \\section{No}\n\\end{verbatim}\n\n')
  })

  it('maskLatex blanks comments, verbatim, \\verb and \\iffalse blocks but keeps offsets', () => {
    const src = [
      'x % \\section{C}',
      '\\begin{lstlisting}',
      '\\section{L}',
      '\\end{lstlisting}',
      '\\begin{minted}[linenos]{python}',
      '\\label{M}',
      '\\end{minted}',
      '\\iffalse',
      '\\ifx a b \\section{Nested} \\fi',
      '\\section{Hidden}',
      '\\fi',
      '\\begin{comment}\\label{C}\\end{comment}',
      '\\verb+\\label{V}+',
      '\\section{Shown}',
    ].join('\n')
    const m = maskLatex(src)
    expect(m).toHaveLength(src.length)
    expect(m.split('\n')).toHaveLength(src.split('\n').length)
    expect(extractOutline(src).map(o => [o.title, o.line])).toEqual([['Shown', 14]])
    expect(extractLabels(src)).toEqual([])
  })
})

describe('extractOutline', () => {
  it('handles starred sections, short titles, nested braces, multi-line titles and all levels', () => {
    const src = [
      '\\documentclass{book}',
      '\\part{One}',
      '\\chapter*{Preface}',
      '\\section[Short]{Long {\\em nested} title with $x^{2}$}\\label{s1}',
      '\\subsection{Spans',
      '  two lines}',
      '\\subsubsection {Spaced}',
      '\\paragraph{Para.} text',
      '\\subparagraph{Sub}',
      '\\addsec{KOMA}',
      '\\section{\\texorpdfstring{$\\alpha$}{alpha} and \\emph{emph}~x\\\\y}',
      '\\newcommand{\\mysec}[1]{\\section{#1}}',
      '\\renewcommand{\\section}{x}',
      'a\\\\section{not a command}',
    ].join('\n')
    const o = extractOutline(src)
    expect(o.map(i => [i.level, i.command, i.starred, i.title, i.line])).toEqual([
      [-1, 'part', false, 'One', 2],
      [0, 'chapter', true, 'Preface', 3],
      [1, 'section', false, 'Long nested title with $x^{2}$', 4],
      [2, 'subsection', false, 'Spans two lines', 5],
      [3, 'subsubsection', false, 'Spaced', 7],
      [4, 'paragraph', false, 'Para.', 8],
      [5, 'subparagraph', false, 'Sub', 9],
      [1, 'section', true, 'KOMA', 10],
      [1, 'section', false, 'alpha and emph x y', 11],
    ])
    expect(o[2].shortTitle).toBe('Short')
  })

  it('plainTitle drops labels, footnotes and citations', () => {
    expect(plainTitle('Results\\label{sec:r}\\footnote{see \\cite{a}} \\& more\\protect\\cite[p.~3]{b}')).toBe('Results & more')
  })
})

describe('labels, bibitems, bib keys', () => {
  it('extractLabels supports cleveref optional types and ignores macro parameters', () => {
    const src = '\\label{a}\n\\label[lemma]{b} % \\label{c}\n\\newcommand{\\x}[1]{\\label{#1}}\n\\label{ d }'
    expect(extractLabels(src)).toEqual([{ label: 'a', line: 1 }, { label: 'b', line: 2 }, { label: 'd', line: 4 }])
  })

  it('extractBibitems handles natbib optional arguments with braces and brackets', () => {
    const src = '\\bibitem[{Smith et~al.(2020)}]{smith2020}\n\\bibitem[Doe [x]]{doe}\n\\bibitem{plain}'
    // like LaTeX, an unbraced ']' ends the optional argument, so the malformed second item is skipped
    expect(extractBibitems(src).map(b => b.key)).toEqual(['smith2020', 'plain'])
    expect(extractBibitems('\\bibitem{a}\n%\\bibitem{b}\n\\bibitem  {c}')).toEqual([{ key: 'a', line: 1 }, { key: 'c', line: 3 }])
  })

  it('extractBibKeys reads entries, fields and skips @comment/@string/@preamble', () => {
    const bib = fixtureText('texlog/sources/refs.bib')
    const keys = extractBibKeys(bib)
    expect(keys.map(k => [k.key, k.type, k.line])).toEqual([
      ['good', 'article', 1], ['nojournal', 'article', 8], ['good', 'article', 14], ['broken', 'article', 21], ['macroerr', 'article', 27],
    ])
    expect(keys[0]).toMatchObject({ title: 'A Good Paper', author: 'Alice Author', year: '2020' })
    const more = extractBibKeys([
      '@string{j = "Journal"}',
      '@comment{ignored,}',
      '@preamble{"\\newcommand{\\x}{y}"}',
      '@Book(knuth84,',
      '  title = "The {\\TeX}book",',
      '  author = {Donald E. Knuth},',
      '  date = {1984-01-01},',
      ')',
      '@misc{concat, title = {A} # " and " # {B}, year = 1999}',
    ].join('\n'))
    expect(more).toEqual([
      { key: 'knuth84', type: 'book', line: 4, title: 'The \\TeXbook', author: 'Donald E. Knuth', year: '1984' },
      { key: 'concat', type: 'misc', line: 9, title: 'A and B', year: '1999' },
    ])
  })
})

describe('documentclass, external documents and includes', () => {
  it('hasDocumentclass ignores commented-out declarations', () => {
    expect(hasDocumentclass('% \\documentclass{article}\n\\begin{document}')).toBe(false)
    expect(hasDocumentclass('\\documentclass[11pt]{article}')).toBe(true)
    expect(hasDocumentclass('\\documentclassx')).toBe(false)
  })

  it('extractExternalDocuments reads prefixes and ignores comments', () => {
    const src = '\\externaldocument[S-]{supp}\n%\\externaldocument{old}\n\\externalcitedocument{cites}\n\\zexternaldocument*{z}'
    expect(extractExternalDocuments(src)).toEqual([
      { name: 'supp', prefix: 'S-', line: 1 }, { name: 'cites', line: 3 }, { name: 'z', line: 4 },
    ])
  })

  it('extractIncludes and resolveInclude', () => {
    const src = [
      '\\documentclass{article}',
      '\\usepackage{amsmath,mystyle}',
      '\\input{chapters/intro}',
      '\\include{chapters/two}',
      '\\input plain.tex',
      '\\includegraphics[width=\\linewidth]{figs/plot}',
      '\\bibliography{refs,more}',
      '\\addbibresource{lib.bib}',
      '\\subimport{parts/}{p1}',
      '% \\input{commented}',
      '\\lstinputlisting[language=Python]{code/a.py}',
      '\\inputminted{python}{code/b.py}',
    ].join('\n')
    const inc = extractIncludes(src)
    expect(inc.map(i => [i.command, i.path, i.line])).toEqual([
      ['documentclass', 'article', 1],
      ['usepackage', 'amsmath', 2],
      ['usepackage', 'mystyle', 2],
      ['input', 'chapters/intro', 3],
      ['include', 'chapters/two', 4],
      ['input', 'plain.tex', 5],
      ['includegraphics', 'figs/plot', 6],
      ['bibliography', 'refs', 7],
      ['bibliography', 'more', 7],
      ['addbibresource', 'lib.bib', 8],
      ['subimport', 'parts/p1', 9],
      ['lstinputlisting', 'code/a.py', 11],
      ['inputminted', 'code/b.py', 12],
    ])
    const files = ['chapters/intro.tex', 'figs/plot.pdf', 'refs.bib', 'mystyle.sty', 'sub/x.tex']
    expect(resolveInclude({ command: 'input', path: 'chapters/intro' }, files)).toBe('chapters/intro.tex')
    expect(resolveInclude({ command: 'includegraphics', path: 'figs/plot' }, files)).toBe('figs/plot.pdf')
    expect(resolveInclude({ command: 'bibliography', path: 'refs' }, files)).toBe('refs.bib')
    expect(resolveInclude({ command: 'usepackage', path: 'mystyle' }, files)).toBe('mystyle.sty')
    expect(resolveInclude({ command: 'input', path: 'x' }, files, 'sub')).toBe('sub/x.tex')
    expect(resolveInclude({ command: 'input', path: '../escape' }, files)).toBeNull()
    expect(resolveInclude({ command: 'input', path: 'missing' }, files)).toBeNull()
  })
})
