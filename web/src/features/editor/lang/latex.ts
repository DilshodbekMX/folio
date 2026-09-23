/**
 * LaTeX language: `StreamLanguage` over @codemirror/legacy-modes' stex (MIT), with a thin
 * token-refining wrapper so the highlighter can tell apart what stex lumps together:
 *   \begin/\end (keyword), environment names, sectioning commands and their titles,
 *   label/ref/cite keys, file paths, package names, math delimiters, math content
 *   (inline, display and math environments), escapes, alignment/line-break operators,
 *   and \textbf/\emph arguments (strong/emphasis).
 * The wrapper only calls stex's public stream-parser functions; the extra context lives in our
 * own state object, so incremental re-parsing stays as cheap as plain stex.
 */
import { StreamLanguage, type StreamParser, type StringStream } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { tags as t, type Tag } from '@lezer/highlight'
import { MATH_ENVIRONMENTS } from '../data/environments'

type ArgKind = 'env' | 'heading' | 'label' | 'path' | 'package' | 'strong' | 'emphasis' | 'mono'

interface ArgState {
  kind: ArgKind
  /** '{' seen and not yet closed */
  depth: number
  /** still waiting for the '{' of the argument (optional […] arguments may come first) */
  awaiting: boolean
  /** nesting of […] while awaiting */
  square: number
  /** begin / end — for environment names */
  env: 'begin' | 'end' | null
  /** collected environment name */
  text: string
}

interface LatexState {
  inner: unknown
  math: boolean
  mathEnv: string | null
  arg: ArgState | null
}

const SECTIONS = new Set(['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph', 'addchap', 'addsec', 'title', 'frametitle'])
const LABELS = /^(?:label|[a-zA-Z]*ref|[cC]ref|crefrange|[a-zA-Z]*cite[a-zA-Z]*|nocite|bibitem|hyperref|externaldocument)$/
const PATHS = new Set(['input', 'include', 'includeonly', 'subfile', 'includegraphics', 'includepdf', 'includesvg', 'includestandalone', 'lstinputlisting', 'inputminted', 'verbatiminput', 'bibliography', 'addbibresource', 'graphicspath', 'import', 'subimport', 'url', 'href'])
const PACKAGES = new Set(['usepackage', 'RequirePackage', 'documentclass', 'LoadClass', 'usetikzlibrary', 'bibliographystyle', 'usetheme'])
const STRONG = new Set(['textbf', 'mathbf', 'boldsymbol', 'bm'])
const EMPHASIS = new Set(['textit', 'emph', 'textsl'])
const MONO = new Set(['texttt', 'verb', 'lstinline'])

// the stex parser (typed loosely: legacy-modes types it as StreamParser<unknown>)
const inner = stex as StreamParser<unknown>

function argKindFor(name: string): ArgKind | null {
  const base = name.endsWith('*') ? name.slice(0, -1) : name
  if (SECTIONS.has(base)) return 'heading'
  if (LABELS.test(base)) return 'label'
  if (PATHS.has(base)) return 'path'
  if (PACKAGES.has(base)) return 'package'
  if (STRONG.has(base)) return 'strong'
  if (EMPHASIS.has(base)) return 'emphasis'
  if (MONO.has(base)) return 'mono'
  return null
}

const ARG_STYLE: Record<ArgKind, string> = {
  env: 'envName',
  heading: 'heading',
  label: 'labelName',
  path: 'path',
  package: 'packageName',
  strong: 'strong',
  emphasis: 'emphasis',
  mono: 'monospace',
}

function token(stream: StringStream, st: LatexState): string | null {
  if (st.arg?.awaiting && stream.sol()) st.arg = null
  const style = inner.token(stream, st.inner)
  const cur = stream.current()

  if (style === 'comment') return 'comment'

  // math delimiters: stex reports every $, $$, \(, \), \[, \] as 'keyword' and toggles its mode
  if (style === 'keyword') {
    st.math = !st.math
    return 'mathDelim'
  }

  const arg = st.arg

  if (style === 'bracket') {
    if (arg) {
      if (cur === '[') arg.square++
      else if (cur === ']') arg.square = Math.max(0, arg.square - 1)
      else if (arg.square === 0 || !arg.awaiting) {
        if (cur === '{') {
          if (arg.awaiting) {
            arg.awaiting = false
            arg.depth = 1
          } else arg.depth++
        } else if (cur === '}') {
          arg.depth--
          if (arg.depth <= 0) finishArg(st)
        }
      }
    }
    return st.math || st.mathEnv ? 'mathBracket' : 'bracket'
  }

  // commands
  if (style === 'tag' && cur.charCodeAt(0) === 92) {
    const inMath = st.math || st.mathEnv !== null
    if (/^\\[$&%#{}_]$/.test(cur)) return 'escape'
    if (cur === '\\\\') return 'lineBreak'
    if (/^\\[,;:!/ ]$/.test(cur)) return inMath ? 'mathCommand' : 'escape'
    const name = cur.slice(1)
    // a command inside an optional argument, e.g. \includegraphics[width=\linewidth]{…}
    if (arg && arg.awaiting && arg.square > 0) return inMath ? 'mathCommand' : 'command'
    const inArg = arg !== null && !arg.awaiting && arg.depth > 0
    if (name === 'begin' || name === 'end') {
      if (!inArg) st.arg = newArg('env', name)
      return 'beginEnd'
    }
    if (inArg) return inMath ? 'mathCommand' : arg.kind === 'heading' ? 'headingCommand' : 'command'
    const kind = argKindFor(stream.match('*', false) ? `${name}*` : name)
    if (inMath) {
      if (kind === 'label') {
        st.arg = newArg('label', null)
        return 'command'
      }
      if (arg?.awaiting) st.arg = null
      return 'mathCommand'
    }
    if (kind) {
      st.arg = newArg(kind, null)
      return kind === 'heading' ? 'sectionCommand' : 'command'
    }
    if (arg?.awaiting) st.arg = null
    return 'command'
  }

  // text / other tokens
  if (arg) {
    if (arg.awaiting) {
      if (arg.square > 0) return st.math || st.mathEnv ? 'math' : null
      if (/^\s*$/.test(cur) || cur === '*') return st.math || st.mathEnv ? 'math' : null
      st.arg = null
    } else if (arg.depth > 0) {
      if (arg.kind === 'env') {
        arg.text += cur
        return 'envName'
      }
      if (arg.kind === 'label' || arg.kind === 'path' || arg.kind === 'package') return ARG_STYLE[arg.kind]
      if (st.math || st.mathEnv) return 'math'
      return ARG_STYLE[arg.kind]
    }
  }

  if (st.math || st.mathEnv) {
    if (style === 'number') return 'mathNumber'
    return 'math'
  }
  if (style === 'atom' && /^\d/.test(cur)) return 'number'
  if (cur === '&') return 'alignment'
  if (cur === '~') return 'escape'
  return null
}

function newArg(kind: ArgKind, env: 'begin' | 'end' | null): ArgState {
  return { kind, depth: 0, awaiting: true, square: 0, env, text: '' }
}

function finishArg(st: LatexState): void {
  const arg = st.arg
  st.arg = null
  if (!arg || arg.kind !== 'env') return
  const name = arg.text.trim()
  if (arg.env === 'begin' && !st.mathEnv && !st.math && MATH_ENVIRONMENTS.has(name)) st.mathEnv = name
  else if (arg.env === 'end' && st.mathEnv === name) st.mathEnv = null
}

const latexParser: StreamParser<LatexState> = {
  name: 'latex',
  startState(indentUnit) {
    return { inner: inner.startState!(indentUnit), math: false, mathEnv: null, arg: null }
  },
  copyState(s) {
    return {
      inner: inner.copyState!(s.inner),
      math: s.math,
      mathEnv: s.mathEnv,
      arg: s.arg ? { ...s.arg } : null,
    }
  },
  token,
  blankLine(s, indentUnit) {
    inner.blankLine?.(s.inner, indentUnit)
    s.math = false
    s.mathEnv = null
    s.arg = null
  },
  languageData: {
    commentTokens: { line: '%' },
    closeBrackets: { brackets: ['(', '[', '{', '$'], before: ')]}:;>$' },
  },
  tokenTable: {
    command: t.macroName,
    beginEnd: t.keyword,
    envName: t.className,
    sectionCommand: t.heading,
    headingCommand: t.heading,
    heading: t.heading,
    labelName: t.labelName,
    path: t.string,
    packageName: t.namespace,
    strong: t.strong,
    emphasis: t.emphasis,
    monospace: t.monospace,
    mathDelim: t.processingInstruction,
    math: t.special(t.variableName),
    mathCommand: t.special(t.macroName),
    mathNumber: t.special(t.number),
    mathBracket: t.special(t.bracket),
    bracket: t.bracket,
    escape: t.escape,
    lineBreak: t.operator,
    alignment: t.operator,
    number: t.number,
    comment: t.comment,
  } satisfies Record<string, Tag>,
}

export const latexLanguage = StreamLanguage.define(latexParser)
