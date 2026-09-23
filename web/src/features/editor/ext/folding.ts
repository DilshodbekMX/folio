/**
 * Code folding for StreamLanguage modes (no syntax tree): LaTeX sectioning commands fold to
 * the next heading of the same or a higher level (or \end{document}), `\begin{x}` folds to its
 * matching `\end{x}`, and BibTeX entries fold to their closing brace. Results are cached per
 * document version because the fold gutter asks for every visible line on every update.
 */
import type { EditorState, Extension, Text } from '@codemirror/state'
import { codeFolding, foldGutter, foldService } from '@codemirror/language'
import { commentStart } from './latexScan'

type FoldRange = { from: number; to: number } | null

export const SECTION_LEVELS: Record<string, number> = {
  part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5,
}
const HEADING_RE = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/
const MAX_ENV_LINES = 6000

const cache = new WeakMap<Text, Map<number, FoldRange>>()

function cached(doc: Text, lineStart: number, compute: () => FoldRange): FoldRange {
  let m = cache.get(doc)
  if (!m) {
    m = new Map()
    cache.set(doc, m)
  }
  if (m.has(lineStart)) return m.get(lineStart)!
  const r = compute()
  m.set(lineStart, r)
  return r
}

function headingLevel(line: string): number | null {
  if (line.indexOf('\\') === -1) return null
  const m = HEADING_RE.exec(line)
  return m ? SECTION_LEVELS[m[1]] : null
}

function foldSection(doc: Text, lineNo: number, level: number, lineEnd: number): FoldRange {
  let end = lineNo
  for (let n = lineNo + 1; n <= doc.lines; n++) {
    const text = doc.line(n).text
    if (text.indexOf('\\') !== -1) {
      const l = headingLevel(text)
      if (l !== null && l <= level) break
      if (/^\s*\\(?:end\s*\{document\}|appendix\b|bibliography\b|printbibliography\b|begin\s*\{thebibliography\})/.test(text)) break
    }
    end = n
  }
  while (end > lineNo && /^\s*$/.test(doc.line(end).text)) end--
  if (end <= lineNo) return null
  return { from: lineEnd, to: doc.line(end).to }
}

function foldEnvironment(doc: Text, lineNo: number, text: string, lineEnd: number): FoldRange {
  const re = /\\begin\s*\{([^{}]+)\}/g
  const cs = commentStart(text)
  let m: RegExpExecArray | null = null
  // the last \begin on the line that is not commented out and not closed on the same line
  for (let x = re.exec(text); x; x = re.exec(text)) {
    if (cs !== -1 && x.index > cs) break
    if (x[1] === 'document') continue
    const rest = text.slice(x.index + x[0].length)
    if (new RegExp(`\\\\end\\s*\\{${x[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`).test(rest)) continue
    m = x
  }
  if (!m) return null
  const name = m[1]
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const tokenRe = new RegExp(`\\\\(begin|end)\\s*\\{${esc}\\}`, 'g')
  let depth = 1
  for (let n = lineNo + 1, k = 0; n <= doc.lines && k < MAX_ENV_LINES; n++, k++) {
    const line = doc.line(n)
    if (line.text.indexOf('\\') === -1) continue
    const lcs = commentStart(line.text)
    tokenRe.lastIndex = 0
    for (let x = tokenRe.exec(line.text); x; x = tokenRe.exec(line.text)) {
      if (lcs !== -1 && x.index > lcs) break
      depth += x[1] === 'begin' ? 1 : -1
      if (depth === 0) {
        // fold up to the \end so the collapsed block reads `\begin{x}…\end{x}`
        const to = line.from + x.index
        return to > lineEnd ? { from: lineEnd, to } : null
      }
    }
  }
  return null
}

function foldBibEntry(doc: Text, lineNo: number, text: string, lineEnd: number): FoldRange {
  const m = /^\s*@\s*[A-Za-z]+\s*([{(])/.exec(text)
  if (!m) return null
  const open = m[1]
  const close = open === '{' ? '}' : ')'
  let depth = 0
  const start = doc.line(lineNo).from + m.index + m[0].length - 1
  const end = Math.min(doc.length, start + 50000)
  const body = doc.sliceString(start, end)
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (c === '\\') {
      i++
      continue
    }
    if (c === open || (open === '(' && c === '{')) depth++
    else if (c === close || (open === '(' && c === '}')) {
      depth--
      if (depth === 0) {
        const to = start + i
        return to > lineEnd ? { from: lineEnd, to } : null
      }
    }
  }
  return null
}

const latexFold = foldService.of((state: EditorState, lineStart: number, lineEnd: number) => {
  const doc = state.doc
  return cached(doc, lineStart, () => {
    const text = doc.sliceString(lineStart, lineEnd)
    if (text.indexOf('\\') === -1) return null
    const lineNo = doc.lineAt(lineStart).number
    const level = headingLevel(text)
    if (level !== null) {
      const cs = commentStart(text)
      if (cs === -1 || cs > text.indexOf('\\')) return foldSection(doc, lineNo, level, lineEnd)
    }
    if (text.indexOf('\\begin') !== -1) return foldEnvironment(doc, lineNo, text, lineEnd)
    return null
  })
})

const bibFold = foldService.of((state: EditorState, lineStart: number, lineEnd: number) => {
  const doc = state.doc
  return cached(doc, lineStart, () => {
    const text = doc.sliceString(lineStart, lineEnd)
    if (text.indexOf('@') === -1) return null
    return foldBibEntry(doc, doc.lineAt(lineStart).number, text, lineEnd)
  })
})

export function latexFolding(): Extension {
  return latexFold
}

export function bibtexFolding(): Extension {
  return bibFold
}

const SVG_NS = 'http://www.w3.org/2000/svg'

function chevron(open: boolean): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', '14')
  svg.setAttribute('height', '14')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2.2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', open ? 'M6 9l6 6 6-6' : 'M9 6l6 6-6 6')
  svg.appendChild(path)
  return svg
}

/** Fold gutter with chevron markers and a compact placeholder. */
export function foldingUI(): Extension {
  return [
    codeFolding({
      placeholderDOM(_view, onclick) {
        const el = document.createElement('span')
        el.className = 'cm-foldPlaceholder ed-fold-placeholder'
        el.textContent = '⋯'
        el.title = 'Unfold'
        el.setAttribute('aria-label', 'folded code')
        el.onclick = onclick
        return el
      },
    }),
    foldGutter({
      markerDOM(open) {
        const el = document.createElement('span')
        el.className = open ? 'ed-fold-marker is-open' : 'ed-fold-marker is-closed'
        el.title = open ? 'Fold' : 'Unfold'
        el.appendChild(chevron(open))
        return el
      },
    }),
  ]
}
