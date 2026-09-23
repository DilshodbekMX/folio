/**
 * Small, fast LaTeX source scanners used by the editor extensions (auto-close, completion,
 * equation preview, formatting). They work on plain strings / CodeMirror Text and never parse
 * the whole document on a keystroke: callers pass bounded slices.
 */
import type { EditorState, Text } from '@codemirror/state'
import { MATH_ENVIRONMENTS } from '../data/environments'

/** True when the character at `index` is escaped by an odd number of backslashes. */
export function isEscaped(text: string, index: number): boolean {
  let n = 0
  for (let i = index - 1; i >= 0 && text.charCodeAt(i) === 92; i--) n++
  return n % 2 === 1
}

/** Offset of the first unescaped '%' in a line, or -1. */
export function commentStart(line: string): number {
  for (let i = line.indexOf('%'); i !== -1; i = line.indexOf('%', i + 1)) {
    if (!isEscaped(line, i)) return i
  }
  return -1
}

/** True when `offset` (inside `line`) is within a % comment. */
export function inComment(line: string, offset: number): boolean {
  const c = commentStart(line)
  return c !== -1 && c < offset
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Count `\begin{name}` / `\end{name}` in a text, ignoring commented-out occurrences. */
export function countEnvironment(text: string, name: string): { begins: number; ends: number } {
  const re = new RegExp(`\\\\(begin|end)\\s*\\{${escapeRe(name)}\\}`, 'g')
  let begins = 0
  let ends = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const ls = text.lastIndexOf('\n', m.index) + 1
    if (inComment(text.slice(ls, m.index + 1), m.index - ls)) continue
    if (isEscaped(text, m.index)) continue
    if (m[1] === 'begin') begins++
    else ends++
  }
  return { begins, ends }
}

/**
 * Name of the innermost environment opened before `pos` and not yet closed (for `\end{`
 * completion). Looks back at most `window` characters.
 */
export function innermostOpenEnvironment(doc: Text, pos: number, window = 40000): string | null {
  const from = Math.max(0, pos - window)
  const text = doc.sliceString(from, pos)
  const re = /\\(begin|end)\s*\{([^{}\s]+)\}/g
  const stack: string[] = []
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const ls = text.lastIndexOf('\n', m.index) + 1
    if (inComment(text.slice(ls, m.index + 1), m.index - ls) || isEscaped(text, m.index)) continue
    if (m[1] === 'begin') stack.push(m[2])
    else {
      const i = stack.lastIndexOf(m[2])
      if (i !== -1) stack.length = i
    }
  }
  return stack[stack.length - 1] ?? null
}

/** Read a balanced {…} group starting at text[i] === '{'. Returns the index after '}' or -1. */
export function matchBrace(text: string, i: number): number {
  if (text[i] !== '{') return -1
  let depth = 0
  for (let k = i; k < text.length; k++) {
    const c = text[k]
    if (c === '\\') {
      k++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return k + 1
    }
  }
  return -1
}

// ---------------------------------------------------------------------------------------------
// Math regions (equation preview, math-aware completion)
// ---------------------------------------------------------------------------------------------

export interface MathRegion {
  /** start of the opening delimiter */
  from: number
  /** end of the closing delimiter */
  to: number
  /** the math source between the delimiters */
  content: string
  display: boolean
  /** environment name for \begin{…} math, else the delimiter ('$', '$$', '\\(', '\\[') */
  kind: string
}

const MAX_PARAGRAPH_LINES = 400

/** Offsets of the paragraph (blank-line delimited block) around `pos`. */
function paragraphAround(doc: Text, pos: number): { from: number; to: number } {
  const line = doc.lineAt(pos)
  let first = line.number
  let last = line.number
  for (let n = line.number - 1, k = 0; n >= 1 && k < MAX_PARAGRAPH_LINES; n--, k++) {
    if (/^\s*$/.test(doc.line(n).text)) break
    first = n
  }
  for (let n = line.number + 1, k = 0; n <= doc.lines && k < MAX_PARAGRAPH_LINES; n++, k++) {
    if (/^\s*$/.test(doc.line(n).text)) break
    last = n
  }
  return { from: doc.line(first).from, to: doc.line(last).to }
}

/**
 * The math region containing `pos` ($…$, $$…$$, \(…\), \[…\], or a math environment such as
 * equation/align), or null. Math cannot span blank lines, so only the surrounding paragraph is
 * scanned.
 */
export function findMathAt(doc: Text, pos: number): MathRegion | null {
  const para = paragraphAround(doc, pos)
  const base = para.from
  const t = doc.sliceString(para.from, para.to)
  const p = pos - base
  const n = t.length
  let open: { kind: string; start: number; cs: number; display: boolean } | null = null
  const close = (end: number, contentEnd: number): MathRegion | null => {
    const o = open!
    open = null
    if (o.start < p && p < end) {
      return { from: base + o.start, to: base + end, content: t.slice(o.cs, contentEnd), display: o.display, kind: o.kind }
    }
    return null
  }
  let i = 0
  while (i < n) {
    const c = t.charCodeAt(i)
    if (c === 37 /* % */) {
      const e = t.indexOf('\n', i)
      if (e === -1) break
      i = e + 1
      continue
    }
    // past the cursor with no math open (or math that started after it): not inside math
    if (open ? open.start >= p : i >= p) break
    if (c === 92 /* \ */) {
      const next = t[i + 1]
      if (!open) {
        if (next === '(' || next === '[') {
          open = { kind: next === '(' ? '\\(' : '\\[', start: i, cs: i + 2, display: next === '[' }
          i += 2
          continue
        }
        if (next === 'b' && t.startsWith('\\begin', i)) {
          const m = /^\\begin\s*\{([A-Za-z]+\*?)\}/.exec(t.slice(i, i + 48))
          if (m && MATH_ENVIRONMENTS.has(m[1])) {
            open = { kind: m[1], start: i, cs: i + m[0].length, display: true }
            i += m[0].length
            continue
          }
        }
      } else if ((open.kind === '\\(' && next === ')') || (open.kind === '\\[' && next === ']')) {
        const r = close(i + 2, i)
        if (r) return r
        i += 2
        continue
      } else if (next === 'e' && open.kind.length > 2 && t.startsWith('\\end', i)) {
        const m = /^\\end\s*\{([A-Za-z]+\*?)\}/.exec(t.slice(i, i + 48))
        if (m && m[1] === open.kind) {
          const r = close(i + m[0].length, i)
          if (r) return r
          i += m[0].length
          continue
        }
      }
      i += 2
      continue
    }
    if (c === 36 /* $ */) {
      const dbl = t.charCodeAt(i + 1) === 36
      if (!open) {
        open = dbl ? { kind: '$$', start: i, cs: i + 2, display: true } : { kind: '$', start: i, cs: i + 1, display: false }
        i += dbl ? 2 : 1
        continue
      }
      if (open.kind === '$$' && dbl) {
        const r = close(i + 2, i)
        if (r) return r
        i += 2
        continue
      }
      if (open.kind === '$') {
        const r = close(i + 1, i)
        if (r) return r
        i += 1
        continue
      }
    }
    i++
  }
  return null
}

/** True when `pos` is inside math (cheap: paragraph scan). */
export function isMathAt(state: EditorState, pos: number): boolean {
  return findMathAt(state.doc, pos) !== null
}

/**
 * Turn a math region into source KaTeX can render: drop labels/tags/comments and wrap
 * multi-line environments in their inline counterparts (align → aligned, gather → gathered).
 */
export function mathForPreview(region: MathRegion): string {
  let src = region.content
    .replace(/(^|[^\\])%[^\n]*/g, '$1')
    .replace(/\\(?:label|tag\*?)\s*\{[^{}]*\}/g, '')
    .replace(/\\(?:nonumber|notag)(?![A-Za-z])/g, '')
    .replace(/\\intertext\s*\{[^{}]*\}/g, '\\\\')
    .trim()
  const env = region.kind.replace(/\*$/, '')
  if (env === 'align' || env === 'flalign' || env === 'eqnarray') src = `\\begin{aligned}${src}\\end{aligned}`
  else if (env === 'alignat') src = `\\begin{alignedat}${src}\\end{alignedat}`
  else if (env === 'gather' || env === 'multline') src = `\\begin{gathered}${src}\\end{gathered}`
  return src
}
