/**
 * @folio/shared/latex — lightweight LaTeX source helpers (browser-safe, no dependencies):
 * outline, labels, \bibitem keys, .bib entries, \documentclass detection, xr external
 * documents and included files.
 *
 * All extractors work on a masked copy of the source (maskLatex) in which comments, the
 * bodies of verbatim-like environments, \verb|…| arguments and \iffalse…\fi blocks are
 * blanked out with spaces, so offsets and line numbers stay those of the original text.
 *
 * Every helper is linear (or bounded) in the input size, also on hostile input: these run on
 * the server's event loop at every compile and in every collaborator's browser. Braced
 * arguments are matched through a one-pass brace index, optional arguments are scanned at most
 * MAX_OPT_SPAN characters, arguments longer than a per-extractor cap are ignored (no real title
 * or label is that long) and the number of matches per extractor is capped.
 */

export interface OutlineItem {
  /** LaTeX sectioning depth: part -1, chapter 0, section 1, subsection 2, subsubsection 3, paragraph 4, subparagraph 5 */
  level: number
  /** title as plain text (long title when a [short] title is given) */
  title: string
  /** 1-based line of the sectioning command */
  line: number
  /** command name without backslash and star, e.g. 'section' */
  command: string
  starred: boolean
  /** the optional [short] title, plain text */
  shortTitle?: string
  /** 0-based character offset of the command */
  offset: number
}

export interface LabelDef { label: string; line: number }
export interface BibitemDef { key: string; line: number }
export interface BibEntryDef {
  key: string
  /** entry type in lower case, e.g. 'article' */
  type: string
  title?: string
  author?: string
  year?: string
  /** 1-based line of the '@type{key' */
  line: number
}
export interface ExternalDocument {
  /** file name as written (without .tex, e.g. 'antiddos_v2_supplementary') */
  name: string
  /** the optional [prefix] */
  prefix?: string
  line: number
}

export type IncludeCommand =
  | 'input' | 'include' | 'subfile' | 'import' | 'subimport' | 'includegraphics' | 'includepdf'
  | 'includesvg' | 'lstinputlisting' | 'inputminted' | 'verbatiminput' | 'bibliography' | 'addbibresource'
  | 'documentclass' | 'usepackage' | 'externaldocument'
export interface IncludeRef {
  command: IncludeCommand
  /** path argument as written (for import/subimport: directory + file) */
  path: string
  line: number
}

const SECTION_LEVELS: Record<string, number> = {
  part: -1, chapter: 0, addchap: 0, section: 1, addsec: 1, subsection: 2, subsubsection: 3,
  paragraph: 4, subparagraph: 5,
}

const VERBATIM_ENVS = /^(?:verbatim\*?|Verbatim\*?|BVerbatim|LVerbatim|lstlisting|minted|comment|filecontents\*?|luacode\*?|pycode|sagesilent|sageblock)$/

// ---------------------------------------------------------------------------
// Masking / comments
// ---------------------------------------------------------------------------

function blank(out: string[], text: string, from: number, to: number): void {
  for (let i = from; i < to; i++) out[i] = text[i] === '\n' ? '\n' : ' '
}

/**
 * Same-length copy of `text` with comments, verbatim-like environment bodies, \verb/\lstinline
 * arguments and \iffalse … \fi blocks replaced by spaces (newlines kept).
 */
export function maskLatex(text: string): string {
  return scanLatex(text).masked
}

/**
 * Start of the line containing each of a series of NON-DECREASING offsets, in amortised O(1):
 * every newline of the text is visited once (a per-offset lastIndexOf would be quadratic on a
 * single very long line).
 */
class LineCursor {
  private start = 0
  private next: number
  constructor(private readonly t: string) {
    this.next = t.indexOf('\n')
  }
  startOf(offset: number): number {
    while (this.next !== -1 && this.next < offset) {
      this.start = this.next + 1
      this.next = this.t.indexOf('\n', this.start)
    }
    return this.start
  }
}

/** maskLatex plus the offsets of the '%' characters that start comments. */
function scanLatex(text: string): { masked: string; comments: number[] } {
  const out = text.split('')
  const comments: number[] = []
  const n = text.length
  let i = 0
  // shared by every \iffalse block (offsets only grow): per-line cache of the first comment '%'
  let cursor: LineCursor | null = null
  let lineStart = -1
  let commentAt = -1
  while (i < n) {
    const c = text[i]
    if (c === '%') {
      let e = text.indexOf('\n', i)
      if (e === -1) e = n
      comments.push(i)
      blank(out, text, i, e)
      i = e
      continue
    }
    if (c !== '\\') {
      i++
      continue
    }
    // control sequence
    const m = /^\\([A-Za-z@]+)(\*?)/.exec(text.slice(i, i + 64))
    if (!m) {
      i += 2 // control symbol such as \% or \\ — skip both characters
      continue
    }
    const name = m[1]
    let j = i + m[0].length
    if ((name === 'verb' || name === 'lstinline') && j < n) {
      if (name === 'lstinline' && text[j] === '[') {
        const close = text.slice(j, j + MAX_OPT_SPAN).indexOf(']')
        if (close !== -1) j += close + 1
      }
      const delim = text[j]
      if (delim && !/[\sA-Za-z*]/.test(delim)) {
        const endDelim = name === 'lstinline' && delim === '{' ? '}' : delim
        let e = j + 1
        while (e < n && text[e] !== endDelim && text[e] !== '\n') e++
        blank(out, text, j + 1, e)
        i = e + 1
        continue
      }
    }
    if (name === 'begin') {
      const env = /^\s*\{([^{}]+)\}/.exec(text.slice(j, j + 80))
      if (env && VERBATIM_ENVS.test(env[1].trim())) {
        const envName = env[1].trim()
        let bodyStart = j + env[0].length
        if (envName === 'minted') {
          // \begin{minted}[options]{language}
          const opts = /^\s*(?:\[[^\]\n]*\])?\s*\{[^}\n]*\}/.exec(text.slice(bodyStart, bodyStart + 200))
          if (opts) bodyStart += opts[0].length
        }
        const endRe = new RegExp(`\\\\end\\s*\\{${envName.replace(/[*]/g, '\\*')}\\}`, 'g')
        endRe.lastIndex = bodyStart
        const em = endRe.exec(text)
        const bodyEnd = em ? em.index : n
        blank(out, text, bodyStart, bodyEnd)
        i = bodyEnd
        continue
      }
    }
    if (name === 'iffalse') {
      // blank until the matching \fi (\if… inside nest)
      const re = /\\(if[A-Za-z@]*|fi)(?![A-Za-z@])/g
      re.lastIndex = j
      let depth = 1
      let e = n
      cursor ??= new LineCursor(text)
      for (let mm = re.exec(text); mm; mm = re.exec(text)) {
        // skip commented-out tokens (first comment '%' of the line, cached per line: linear)
        const ls = cursor.startOf(mm.index)
        if (ls !== lineStart) {
          lineStart = ls
          commentAt = firstCommentOffset(text, ls)
        }
        if (commentAt !== -1 && commentAt < mm.index) continue
        if (mm[1] === 'fi') {
          if (--depth === 0) {
            e = mm.index
            break
          }
        } else if (!/\\newif\s*$/.test(text.slice(Math.max(0, mm.index - 8), mm.index))) depth++
      }
      blank(out, text, j, e)
      i = e
      continue
    }
    i = j
  }
  return { masked: out.join(''), comments }
}

/** Offset of the first '%' of the line starting at `ls` that is not escaped by a backslash, or -1. */
function firstCommentOffset(text: string, ls: number): number {
  for (let k = ls; k < text.length; k++) {
    const c = text[k]
    if (c === '\n') return -1
    if (c === '\\') k++
    else if (c === '%') return k
  }
  return -1
}

/**
 * Remove LaTeX comments ('%' not escaped by a backslash) while keeping line breaks.
 * '%' inside verbatim-like environments and \verb is not a comment and is kept.
 * With preserveOffsets the comment text is replaced by spaces instead of removed.
 */
export function stripComments(text: string, opts: { preserveOffsets?: boolean } = {}): string {
  const { comments } = scanLatex(text)
  if (!comments.length) return text
  let out = ''
  let pos = 0
  for (const start of comments) {
    let end = text.indexOf('\n', start)
    if (end === -1) end = text.length
    out += text.slice(pos, start)
    if (opts.preserveOffsets) out += ' '.repeat(end - start)
    pos = end
  }
  return out + text.slice(pos)
}

// ---------------------------------------------------------------------------
// Scanning helpers
// ---------------------------------------------------------------------------

class LineIndex {
  private readonly starts: number[] = [0]
  constructor(text: string) {
    for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) this.starts.push(i + 1)
  }
  line(offset: number): number {
    let lo = 0
    let hi = this.starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (this.starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/** Skip spaces and at most one line break (a blank line ends a macro's arguments). */
function skipSpace(t: string, i: number): number {
  let nl = 0
  while (i < t.length) {
    const c = t[i]
    if (c === '\n') {
      if (++nl > 1) return i
    } else if (c !== ' ' && c !== '\t' && c !== '\r') break
    i++
  }
  return i
}

/** Longest optional […] argument that is recognised (keeps scans of unclosed '[' bounded). */
const MAX_OPT_SPAN = 1000

/**
 * Offsets of the matching '}' for every '{' of a text, computed in one pass (same escaping rule
 * as readBraced: a backslash escapes the next character). -1 when unbalanced.
 */
class BraceIndex {
  private readonly close: Int32Array
  constructor(private readonly t: string) {
    this.close = new Int32Array(t.length).fill(-1)
    const stack: number[] = []
    for (let k = 0; k < t.length; k++) {
      const c = t.charCodeAt(k)
      if (c === 92 /* \ */) {
        k++
        continue
      }
      if (c === 123 /* { */) stack.push(k)
      else if (c === 125 /* } */ && stack.length) this.close[stack.pop()!] = k
    }
  }
  /** end offset (after the '}') of the group opening at `i`, or -1 */
  endOf(i: number): number {
    if (this.t[i] !== '{') return -1
    const c = this.close[i]
    return c === -1 ? -1 : c + 1
  }
  read(i: number, maxLength = Infinity): { content: string; end: number } | null {
    const end = this.endOf(i)
    if (end === -1 || end - i - 2 > maxLength) return null
    return { content: this.t.slice(i + 1, end - 1), end }
  }
}

/** Read a balanced {…} group starting at t[i] === '{'. */
function readBraced(t: string, i: number): { content: string; end: number } | null {
  if (t[i] !== '{') return null
  let depth = 0
  for (let k = i; k < t.length; k++) {
    const c = t[k]
    if (c === '\\') {
      k++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      if (--depth === 0) return { content: t.slice(i + 1, k), end: k + 1 }
    }
  }
  return null
}

/** Read an optional […] argument starting at t[i] === '[' (brackets inside braces do not close it). */
function readBracketed(t: string, i: number): { content: string; end: number } | null {
  if (t[i] !== '[') return null
  let braces = 0
  const limit = Math.min(t.length, i + 1 + MAX_OPT_SPAN)
  for (let k = i + 1; k < limit; k++) {
    const c = t[k]
    if (c === '\\') {
      k++
      continue
    }
    if (c === '{') braces++
    else if (c === '}') braces = Math.max(0, braces - 1)
    else if (c === ']' && braces === 0) return { content: t.slice(i + 1, k), end: k + 1 }
    else if (c === '\n' && t[k + 1] === '\n') return null
  }
  return null
}

interface CommandMatch {
  name: string
  star: boolean
  offset: number
  /** optional arguments in order */
  opts: string[]
  /** mandatory arguments in order */
  args: string[]
  end: number
}

interface FindOptions {
  /** mandatory arguments longer than this are not recognised (default 1024) */
  maxArgLength?: number
  /** stop after this many matches (default 20000) */
  maxMatches?: number
  /** brace index of `masked` (shared by several scans of the same text) */
  braces?: BraceIndex
}

/**
 * Find `\name` occurrences (names from `names`) in masked text and read up to `maxOpt` optional
 * and `nArgs` mandatory arguments (optional arguments may precede each mandatory one).
 */
function* findCommands(masked: string, names: RegExp, nArgs: number, maxOpt = 2, o: FindOptions = {}): Generator<CommandMatch> {
  const re = new RegExp(`\\\\(${names.source})(?![A-Za-z@])(\\*?)`, 'g')
  const braces = o.braces ?? new BraceIndex(masked)
  const maxArg = o.maxArgLength ?? 1024
  let budget = o.maxMatches ?? 20_000
  // failed candidates (e.g. an unclosed '[') cost up to MAX_OPT_SPAN each: bound them as well
  let attempts = budget * 10 + 1000
  for (let m = re.exec(masked); m && budget > 0 && attempts-- > 0; m = re.exec(masked)) {
    // \\section is a line break followed by "section", not a command
    let bs = 0
    for (let q = m.index - 1; q >= 0 && masked[q] === '\\'; q--) bs++
    if (bs % 2 === 1) continue
    // skip definitions such as \renewcommand{\section}… or \def\section
    const before = masked.slice(Math.max(0, m.index - 24), m.index)
    if (/\\(?:def|gdef|edef|xdef|let|(?:re)?newcommand\*?\s*\{?|providecommand\*?\s*\{?|DeclareRobustCommand\*?\s*\{?|NewDocumentCommand\s*\{?|RenewDocumentCommand\s*\{?)\s*$/.test(before)) continue
    let i = m.index + m[0].length
    const opts: string[] = []
    const args: string[] = []
    let ok = true
    for (let a = 0; a < nArgs; a++) {
      let nOpt = 0
      for (;;) {
        const j = skipSpace(masked, i)
        if (masked[j] === '[' && nOpt < maxOpt) {
          const o = readBracketed(masked, j)
          if (!o) break
          opts.push(o.content)
          i = o.end
          nOpt++
          continue
        }
        break
      }
      const j = skipSpace(masked, i)
      const g = braces.read(j, maxArg)
      if (!g) {
        ok = false
        break
      }
      args.push(g.content)
      i = g.end
    }
    if (!ok) continue
    budget--
    yield { name: m[1], star: m[2] === '*', offset: m.index, opts, args, end: i }
  }
}

const FORMAT_CMDS = /\\(?:emph|textbf|textit|texttt|textsc|textrm|textsf|textsl|textup|textmd|textnormal|underline|mbox|hbox|text|uppercase|lowercase|MakeUppercase|MakeLowercase|textcolor\{[^{}]*\}|boldsymbol|mathbf|mathrm)\s*\{/g

/** Plain-text rendering of a title: drops labels/footnotes, unwraps formatting, resolves \texorpdfstring. */
export function plainTitle(raw: string): string {
  let s = raw
  // \texorpdfstring{tex}{pdf} → pdf
  for (let guard = 0; guard < 20; guard++) {
    const k = s.search(/\\texorpdfstring\s*\{/)
    if (k === -1) break
    const a = readBraced(s, s.indexOf('{', k))
    const b = a ? readBraced(s, skipSpace(s, a.end)) : null
    if (!a || !b) break
    s = s.slice(0, k) + b.content + s.slice(b.end)
  }
  // drop \label{…}, \index{…}, \footnote[…]{…}, \cite…{…}
  for (let guard = 0; guard < 50; guard++) {
    const m = /\\(?:label|index|footnote|footnotemark|thanks|cite[A-Za-z]*|nocite|ref)\*?\s*(?:\[[^\]]*\]\s*)*/.exec(s)
    if (!m) break
    const j = m.index + m[0].length
    const g = s[j] === '{' ? readBraced(s, j) : null
    s = s.slice(0, m.index) + s.slice(g ? g.end : j)
  }
  // unwrap formatting commands: \emph{x} → x
  for (let guard = 0; guard < 50; guard++) {
    FORMAT_CMDS.lastIndex = 0
    const m = FORMAT_CMDS.exec(s)
    if (!m) break
    const g = readBraced(s, m.index + m[0].length - 1)
    if (!g) break
    s = s.slice(0, m.index) + g.content + s.slice(g.end)
  }
  // font switches ({\em x}, {\bfseries x}) and grouping braces outside math
  s = s.replace(/\\(?:em|bf|it|sl|sc|tt|rm|sf|bfseries|itshape|slshape|scshape|upshape|mdseries|normalfont|ttfamily|rmfamily|sffamily|tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)(?![A-Za-z@])\s*/g, '')
  s = stripTextBraces(s)
  s = s
    .replace(/\\\\(\[[^\]]*\])?/g, ' ')
    .replace(/\\(?:protect|newline|linebreak|nobreak|noindent|hfill|quad|qquad|,|;|!|\/)(?![A-Za-z])/g, ' ')
    .replace(/~/g, ' ')
    .replace(/\\([&%$#_{}])/g, '$1')
    .replace(/\\ /g, ' ')
    .replace(/--/g, '–')
    .replace(/\s+/g, ' ')
    .trim()
  return s
}

/** Remove unescaped { } outside $…$ / \(…\) math. */
function stripTextBraces(s: string): string {
  let out = ''
  let math = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === '\\') {
      const next = s[i + 1] ?? ''
      if (next === '(' || next === '[') math = true
      else if (next === ')' || next === ']') math = false
      out += c + next
      i++
      continue
    }
    if (c === '$') math = !math
    if (!math && (c === '{' || c === '}')) continue
    out += c
  }
  return out
}

// ---------------------------------------------------------------------------
// Extractors
// ---------------------------------------------------------------------------

/** Sectioning commands (part … subparagraph, incl. starred and KOMA \addsec/\addchap) in document order. */
export function extractOutline(text: string): OutlineItem[] {
  const masked = maskLatex(text)
  const lines = new LineIndex(text)
  const out: OutlineItem[] = []
  for (const m of findCommands(masked, /part|chapter|addchap|section|addsec|subsection|subsubsection|paragraph|subparagraph/, 1, 1, { maxArgLength: 1000, maxMatches: 5000 })) {
    if (m.args[0].includes('#')) continue // inside a macro definition
    const starred = m.star || m.name === 'addsec' || m.name === 'addchap'
    const command = m.name === 'addsec' ? 'section' : m.name === 'addchap' ? 'chapter' : m.name
    const item: OutlineItem = {
      level: SECTION_LEVELS[m.name], title: plainTitle(m.args[0]), line: lines.line(m.offset),
      command, starred, offset: m.offset,
    }
    if (m.opts.length) item.shortTitle = plainTitle(m.opts[0])
    out.push(item)
  }
  return out
}

/** \label{…} definitions (including cleveref's \label[type]{…}). */
export function extractLabels(text: string): LabelDef[] {
  const masked = maskLatex(text)
  const lines = new LineIndex(text)
  const out: LabelDef[] = []
  for (const m of findCommands(masked, /label/, 1, 1, { maxArgLength: 256 })) {
    const label = m.args[0].trim()
    if (!label || label.includes('#')) continue
    out.push({ label, line: lines.line(m.offset) })
  }
  return out
}

/** \bibitem[…]{key} entries of thebibliography. */
export function extractBibitems(text: string): BibitemDef[] {
  const masked = maskLatex(text)
  const lines = new LineIndex(text)
  const out: BibitemDef[] = []
  for (const m of findCommands(masked, /bibitem/, 1, 1, { maxArgLength: 256 })) {
    const key = m.args[0].trim()
    if (!key || key.includes('#')) continue
    out.push({ key, line: lines.line(m.offset) })
  }
  return out
}

/** true when the source has a (non-commented) \documentclass. */
export function hasDocumentclass(text: string): boolean {
  return /\\documentclass(?![A-Za-z@])/.test(maskLatex(text))
}

/** xr / xr-hyper \externaldocument[prefix]{name} (also \externalcitedocument and zref's \zexternaldocument). */
export function extractExternalDocuments(text: string): ExternalDocument[] {
  const masked = maskLatex(text)
  const lines = new LineIndex(text)
  const out: ExternalDocument[] = []
  for (const m of findCommands(masked, /externaldocument|externalcitedocument|zexternaldocument/, 1, 2, { maxMatches: 100 })) {
    const name = m.args[0].trim()
    if (!name || name.includes('#')) continue
    const d: ExternalDocument = { name, line: lines.line(m.offset) }
    if (m.opts[0] !== undefined && m.opts[0].trim() !== '') d.prefix = m.opts[0].trim()
    out.push(d)
  }
  return out
}

const INCLUDE_ARGS: Record<IncludeCommand, number> = {
  input: 1, include: 1, subfile: 1, import: 2, subimport: 2, includegraphics: 1, includepdf: 1,
  includesvg: 1, lstinputlisting: 1, inputminted: 2, verbatiminput: 1, bibliography: 1, addbibresource: 1,
  documentclass: 1, usepackage: 1, externaldocument: 1,
}

/**
 * Files referenced by the source: \input, \include, \subfile, \import/\subimport (dir + file),
 * \includegraphics, \includepdf, \includesvg, \lstinputlisting, \inputminted, \verbatiminput,
 * \bibliography (one entry per comma-separated name), \addbibresource, \documentclass and
 * \usepackage (names as written, e.g. 'Definitions/mdpi'), \externaldocument.
 */
export function extractIncludes(text: string): IncludeRef[] {
  const masked = maskLatex(text)
  const lines = new LineIndex(text)
  const braces = new BraceIndex(masked)
  const out: IncludeRef[] = []
  for (const cmd of Object.keys(INCLUDE_ARGS) as IncludeCommand[]) {
    for (const m of findCommands(masked, new RegExp(cmd), INCLUDE_ARGS[cmd], 2, { braces, maxMatches: 5000 })) {
      const line = lines.line(m.offset)
      const add = (path: string) => {
        const p = path.trim()
        if (p && !p.includes('#')) out.push({ command: cmd, path: p, line })
      }
      if (cmd === 'import' || cmd === 'subimport') {
        const dir = m.args[0].trim().replace(/\/?$/, '/')
        add(dir === '/' ? m.args[1] : dir + m.args[1].trim())
      } else if (cmd === 'inputminted') add(m.args[1])
      else if (cmd === 'bibliography' || cmd === 'usepackage') for (const part of m.args[0].split(',')) add(part)
      else add(m.args[0])
    }
  }
  // plain-TeX style "\input file" without braces
  const plain = /\\input(?![A-Za-z@])[ \t]+([^\s{}\\%]+)/g
  for (let m = plain.exec(masked); m; m = plain.exec(masked)) {
    out.push({ command: 'input', path: m[1], line: lines.line(m.index) })
  }
  return out.sort((a, b) => a.line - b.line)
}

const DEFAULT_EXTS: Partial<Record<IncludeCommand, string[]>> = {
  input: ['.tex', ''], include: ['.tex'], subfile: ['.tex', ''], import: ['.tex', ''], subimport: ['.tex', ''],
  includegraphics: ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps', '.PDF', '.PNG', '.JPG'], includepdf: ['', '.pdf'],
  includesvg: ['.svg', ''], bibliography: ['.bib'], addbibresource: [''], documentclass: ['.cls'],
  usepackage: ['.sty'], externaldocument: ['.tex'], lstinputlisting: [''], inputminted: [''], verbatiminput: [''],
}

/**
 * Resolve an include to a project path, trying the command's default extensions.
 * TeX resolves relative to the directory of the root document (`baseDir`), not of the including file.
 */
export function resolveInclude(inc: Pick<IncludeRef, 'command' | 'path'>, projectFiles: Iterable<string>, baseDir = ''): string | null {
  const files = projectFiles instanceof Set ? projectFiles as Set<string> : new Set(projectFiles)
  const clean = inc.path.replace(/^"(.*)"$/, '$1').replace(/^\.\//, '')
  const base = baseDir.replace(/\/+$/, '')
  for (const ext of DEFAULT_EXTS[inc.command] ?? ['']) {
    const cand = normalizeRel(base ? `${base}/${clean}${ext}` : `${clean}${ext}`)
    if (cand && files.has(cand)) return cand
  }
  return null
}

function normalizeRel(p: string): string | null {
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (!out.length) return null
      out.pop()
    } else out.push(seg)
  }
  return out.join('/')
}

// ---------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------

/** longest .bib field value that is recognised */
const MAX_BIB_VALUE = 64 * 1024

function readBibValue(t: string, i: number, braces: BraceIndex, budget: { left: number }): { value: string; end: number } | null {
  i = skipWs(t, i)
  const parts: string[] = []
  for (;;) {
    const c = t[i]
    if (c === '{') {
      const g = braces.read(i, MAX_BIB_VALUE)
      if (!g) return null
      parts.push(g.content)
      i = g.end
    } else if (c === '"') {
      let k = i + 1
      let depth = 0
      const limit = Math.min(t.length, i + 1 + MAX_BIB_VALUE, i + 1 + Math.max(0, budget.left))
      for (; k < limit; k++) {
        const d = t[k]
        if (d === '\\') {
          k++
          continue
        }
        if (d === '{') depth++
        else if (d === '}') depth--
        else if (d === '"' && depth <= 0) break
      }
      budget.left -= k - i
      if (k >= limit) return null
      parts.push(t.slice(i + 1, k))
      i = k + 1
    } else {
      const m = /^[A-Za-z0-9_:.+\-/]+/.exec(t.slice(i, i + 200))
      if (!m) return null
      parts.push(m[0])
      i += m[0].length
    }
    i = skipWs(t, i)
    if (t[i] === '#') {
      i = skipWs(t, i + 1)
      continue
    }
    return { value: parts.join(''), end: i }
  }
}

function skipWs(t: string, i: number): number {
  while (i < t.length && /\s/.test(t[i])) i++
  return i
}

function cleanBib(s: string): string {
  return s.replace(/[{}]/g, '').replace(/\\([&%$#_])/g, '$1').replace(/~/g, ' ').replace(/\s+/g, ' ').trim()
}

/** Entries of a .bib file (skips @comment, @string, @preamble) with title/author/year when present. */
export function extractBibKeys(bibText: string): BibEntryDef[] {
  const lines = new LineIndex(bibText)
  const braces = new BraceIndex(bibText)
  const cursor = new LineCursor(bibText)
  // total characters quoted values may scan: keeps hostile files (many unterminated quotes) linear
  const budget = { left: 16 * bibText.length + 1_000_000 }
  const out: BibEntryDef[] = []
  const re = /@\s*([A-Za-z]+)\s*([{(])\s*/g
  // first non-whitespace offset of the line being scanned (cached per line: linear)
  let lineStart = -1
  let firstText = 0
  for (let m = re.exec(bibText); m && out.length < 50_000; m = re.exec(bibText)) {
    const type = m[1].toLowerCase()
    if (type === 'comment' || type === 'string' || type === 'preamble') continue
    // the entry must start a line (after optional whitespace), otherwise it's inside a field or free text
    const ls = cursor.startOf(m.index)
    if (ls !== lineStart) {
      lineStart = ls
      firstText = ls
      while (firstText < bibText.length && bibText[firstText] !== '\n' && /\s/.test(bibText[firstText])) firstText++
    }
    if (firstText < m.index) continue
    const keyStart = m.index + m[0].length
    const km = /^([^,\s{}()"=#%]+)[ \t]*(,|[)}]|\r?\n|$)/.exec(bibText.slice(keyStart, keyStart + 300))
    if (!km) continue
    const entry: BibEntryDef = { key: km[1], type, line: lines.line(m.index) }
    // fields until the closing delimiter of the entry
    const close = m[2] === '{' ? '}' : ')'
    let i = keyStart + km[0].length
    if (km[2] === ',' || km[2].endsWith('\n')) {
      for (let guard = 0; guard < 200; guard++) {
        i = skipWs(bibText, i)
        if (i >= bibText.length || bibText[i] === close || bibText[i] === '@') break
        const f = /^([A-Za-z][\w\-:.]*)\s*=\s*/.exec(bibText.slice(i, i + 100))
        if (!f) break
        const v = readBibValue(bibText, i + f[0].length, braces, budget)
        if (!v) break
        const field = f[1].toLowerCase()
        if (field === 'title' && entry.title === undefined) entry.title = cleanBib(v.value)
        else if (field === 'author' && entry.author === undefined) entry.author = cleanBib(v.value)
        else if (field === 'year' && entry.year === undefined) entry.year = cleanBib(v.value)
        else if (field === 'date' && entry.year === undefined) {
          const y = /\d{4}/.exec(v.value)
          if (y) entry.year = y[0]
        }
        i = skipWs(bibText, v.end)
        if (bibText[i] === ',') i++
      }
    }
    out.push(entry)
    re.lastIndex = Math.max(re.lastIndex, keyStart)
  }
  return out
}
