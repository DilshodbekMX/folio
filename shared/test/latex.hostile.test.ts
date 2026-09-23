/**
 * @folio/shared/latex on hostile input. These helpers run on the server's event loop at every
 * compile (\documentclass / \externaldocument detection) and in every collaborator's browser, so
 * they must stay (near) linear: unclosed braces/brackets, thousands of \iffalse on one line,
 * unterminated .bib strings… used to take seconds for a few hundred kB (quadratic rescans).
 */
import { describe, expect, it } from 'vitest'
import {
  extractBibitems, extractBibKeys, extractExternalDocuments, extractIncludes, extractLabels, extractOutline,
  hasDocumentclass, maskLatex, stripComments,
} from '../src/latex/index.ts'

const SIZE = 1_000_000
const rep = (p: string) => p.repeat(Math.ceil(SIZE / p.length)).slice(0, SIZE)
/** generous bound for a 1 MB adversarial input (typically < 150 ms) */
const LIMIT_MS = 2500

function timed(fn: () => unknown): number {
  const t0 = performance.now()
  fn()
  return performance.now() - t0
}

const texHelpers: [string, (t: string) => unknown][] = [
  ['maskLatex', maskLatex], ['stripComments', stripComments], ['hasDocumentclass', hasDocumentclass],
  ['extractOutline', extractOutline], ['extractLabels', extractLabels], ['extractBibitems', extractBibitems],
  ['extractExternalDocuments', extractExternalDocuments], ['extractIncludes', extractIncludes],
]

describe('latex helpers stay fast on hostile input', () => {
  const patterns = [
    '\\section{', '\\label{', '\\bibitem[', '\\documentclass[', '\\externaldocument[', '\\iffalse', '\\iffalse\\fi',
    '\\lstinline[', '\\section{\\label{', '{', '[', '\\', '%',
  ]
  for (const p of patterns) {
    it(`handles 1 MB of ${JSON.stringify(p)}`, () => {
      const text = rep(p)
      for (const [name, fn] of texHelpers) expect(timed(() => fn(text)), name).toBeLessThan(LIMIT_MS)
    })
  }
  it('handles deeply nested sections', () => {
    const text = rep('\\section{'.repeat(200) + '}'.repeat(200))
    expect(timed(() => extractOutline(text))).toBeLessThan(LIMIT_MS)
  })
  it('handles hostile .bib files', () => {
    for (const p of ['@a{k,t="{', '@a{k,t="', '@a{k,\n t = {', ' @a{', '@misc{']) {
      expect(timed(() => extractBibKeys(rep(p))), p).toBeLessThan(LIMIT_MS)
    }
  })
  it('still finds what matters in normal documents', () => {
    const doc = [
      '\\documentclass[a4paper]{article}',
      '\\usepackage{xr}\\externaldocument[S-]{supp}',
      '\\begin{document}',
      '% \\section{commented}',
      '\\iffalse \\section{hidden} \\fi',
      '\\section[Short]{A \\emph{real} title}\\label{sec:a}',
      '\\bibitem[Doe(2020)]{doe20} Doe.',
      '\\end{document}',
    ].join('\n')
    expect(hasDocumentclass(doc)).toBe(true)
    expect(extractExternalDocuments(doc)).toEqual([{ name: 'supp', prefix: 'S-', line: 2 }])
    expect(extractOutline(doc).map(o => [o.title, o.shortTitle, o.line])).toEqual([['A real title', 'Short', 6]])
    expect(extractLabels(doc)).toEqual([{ label: 'sec:a', line: 6 }])
    expect(extractBibitems(doc)).toEqual([{ key: 'doe20', line: 7 }])
    // an absurdly long "title" is ignored rather than scanned for ever
    expect(extractOutline(`\\section{${'x'.repeat(5000)}}`)).toEqual([])
    expect(extractBibKeys('@article{k,\n  title = "A {B} title",\n  year = 2020\n}\n')).toEqual([{ key: 'k', type: 'article', title: 'A B title', year: '2020', line: 1 }])
  })
})
