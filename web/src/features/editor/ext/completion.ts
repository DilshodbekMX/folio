/**
 * LaTeX / BibTeX completion (one `autocompletion({ override })` for the whole editor):
 *   - \commands: built-in data (~450 commands) + commands defined in the project
 *   - \begin{ / \end{: environments (built-in + defined/used in the project); completing a
 *     \begin inserts the matching \end when the document is not already balanced
 *   - \ref-like arguments: labels from every project file
 *   - \cite-like arguments: .bib entries and \bibitem keys (author/title/year info)
 *   - file arguments (\input, \include, \includegraphics, \bibliography, …): project paths
 *   - \usepackage / \documentclass / \bibliographystyle names
 *   - .bib files: entry types after '@' and field names
 * Option lists are memoised per project-index revision, so typing only filters.
 */
import {
  autocompletion, insertCompletionText, pickedCompletion, snippet,
  type Completion, type CompletionContext, type CompletionResult, type CompletionSource,
} from '@codemirror/autocomplete'
import { Facet, type EditorState, type Extension } from '@codemirror/state'
import { indentUnit } from '@codemirror/language'
import type { EditorView } from '@codemirror/view'
import { basename, dirname, extname } from '@folio/shared/paths'
import { useProject } from '../../../stores/project'
import { ARG_COMPLETING_COMMANDS, COMMANDS, type CommandSpec } from '../data/commands'
import { ENVIRONMENTS, type EnvironmentSpec } from '../data/environments'
import { BIB_STYLES, DOCUMENT_CLASSES, PACKAGES } from '../data/packages'
import { projectIndex, type IndexedCite, type ProjectIndexSnapshot } from '../projectIndex'
import { commentStart, countEnvironment, innermostOpenEnvironment, isEscaped, isMathAt } from './latexScan'

export type DocKind = 'latex' | 'bibtex' | 'text'

/** Which completion rules apply to the document (set by the language compartment). */
export const docKindFacet = Facet.define<DocKind, DocKind>({ combine: v => v[0] ?? 'text' })

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/** Make a literal string safe inside a snippet template (`\{` would become `{`). */
function escapeTemplate(s: string): string {
  return s.replace(/\\([{}])/g, '\\\\$1').replace(/([$#])\{/g, '$1\\{')
}

/** Readable form of a snippet template for the completion detail. */
function argsDisplay(args: string): string {
  return args
    .replace(/[$#]\{(?:\d+:)?([^{}]*)\}/g, (_m, name: string) => (name ? name : '…'))
    .replace(/\\([{}])/g, '$1')
    .trim()
}

/** End of the token under the cursor (the rest of an argument being replaced). */
function tokenEnd(state: EditorState, pos: number, re: RegExp): number {
  const line = state.doc.lineAt(pos)
  let end = pos
  while (end < line.to && re.test(state.sliceDoc(end, end + 1))) end++
  return end
}

const ARG_CHAR = /[^,{}\s%]/

/** Replace the whole argument token (up to ',' or '}') with the completion label. */
function applyArgument(view: EditorView, completion: Completion, from: number, to: number): void {
  const end = tokenEnd(view.state, to, ARG_CHAR)
  view.dispatch({
    ...insertCompletionText(view.state, completion.label, from, end),
    annotations: pickedCompletion.of(completion),
  })
}

const REOPEN = new Set([...ARG_COMPLETING_COMMANDS].map(n => `\\${n}`))

/** Completions after which the popup re-opens (the cursor lands in a completable argument). */
export function reopensCompletion(c: Completion): boolean {
  return REOPEN.has(c.label)
}

// ---------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------

function applyCommand(name: string, args: string) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const { state } = view
    // swallow the rest of a command name the cursor is in (\tex|tbf → \textbf)
    const end = tokenEnd(state, to, /[A-Za-z@*]/)
    const next = state.sliceDoc(end, end + 1)
    const takesArgs = /^[[{(|]/.test(args)
    if (!args.trim() && args !== ' ') {
      view.dispatch({ ...insertCompletionText(state, `\\${name}`, from, end), annotations: pickedCompletion.of(completion) })
      return
    }
    if (takesArgs && (next === '{' || next === '[')) {
      // arguments already follow: only fix the name
      view.dispatch({ ...insertCompletionText(state, `\\${name}`, from, end), annotations: pickedCompletion.of(completion) })
      return
    }
    snippet(`\\${escapeTemplate(name)}${args}`)(view, completion, from, end)
  }
}

/**
 * Command names are matched by prefix (case-sensitive first, then case-insensitive), then — for
 * three or more typed letters — by substring (\cite → \parencite); scattered fuzzy matches
 * (\beg → \bigwedge) are not listed. Within a tier the ranking weight decides: common commands
 * float up, math-only commands sink outside math (\sec → \section before \sec) and rise inside
 * it, and an exact match gets a small bonus.
 */
interface RankedCommand {
  completion: Completion
  /** name without the backslash */
  name: string
  lower: string
  weight: number
}
interface CommandLists { text: RankedCommand[]; math: RankedCommand[] }
let commandCache: { rev: number; lists: CommandLists } | null = null

const EXACT_BONUS = 8
const CASE_FOLD_PENALTY = 30
const SUBSTRING_PENALTY = 1000
const MIN_SUBSTRING = 3
/** math-only commands outside math / text-only commands inside math */
const MATH_IN_TEXT_PENALTY = 16
const TEXT_IN_MATH_PENALTY = 12

const TEXT_ONLY = /^(?:section|subsection|subsubsection|chapter|part|paragraph|subparagraph|item|caption|label|begin|end|cite|ref|includegraphics|input|include|usepackage|documentclass|footnote|textbf|textit|emph|centering|maketitle|newpage|clearpage|noindent|bibliography|bibliographystyle|title|author)\*?$/

function commandWeight(spec: Pick<CommandSpec, 'name' | 'math' | 'boost'>, inMath: boolean): number {
  let weight = spec.boost ?? 0
  if (inMath) weight += spec.math ? 6 : TEXT_ONLY.test(spec.name) ? -TEXT_IN_MATH_PENALTY : -2
  else if (spec.math) weight -= MATH_IN_TEXT_PENALTY
  return weight
}

function builtinCommand(spec: CommandSpec): Completion {
  return {
    label: `\\${spec.name}`,
    detail: argsDisplay(spec.args),
    info: spec.info,
    type: spec.math ? 'math' : 'cmd',
    apply: applyCommand(spec.name, spec.args),
  }
}

function commandLists(index: ProjectIndexSnapshot): CommandLists {
  if (commandCache && commandCache.rev === index.rev) return commandCache.lists
  const lists: CommandLists = { text: [], math: [] }
  const seen = new Set<string>()
  const add = (completion: Completion, name: string, text: number, math: number) => {
    const lower = name.toLowerCase()
    lists.text.push({ completion, name, lower, weight: text })
    lists.math.push({ completion, name, lower, weight: math })
  }
  for (const spec of COMMANDS) {
    if (seen.has(spec.name)) continue
    seen.add(spec.name)
    add(builtinCommand(spec), spec.name, commandWeight(spec, false), commandWeight(spec, true))
  }
  for (const c of index.commands) {
    if (seen.has(c.name)) continue
    seen.add(c.name)
    const args = (c.optional ? '[${}]' : '') + '{${}}'.repeat(c.args)
    const completion: Completion = {
      label: `\\${c.name}`,
      detail: argsDisplay(args) || undefined,
      info: `Defined in ${c.path}`,
      type: 'user',
      apply: applyCommand(c.name, args),
    }
    add(completion, c.name, c.math ? 0 : 3, c.math ? 6 : 1)
  }
  commandCache = { rev: index.rev, lists }
  return lists
}

/** The command options for the typed `\name` (backslash included), best first, with the matched range of each label. */
function rankCommands(list: readonly RankedCommand[], typed: string): { options: Completion[]; ranges: Map<Completion, [number, number]> } {
  const name = typed.slice(1)
  const lower = name.toLowerCase()
  const hits: { c: RankedCommand; score: number; at: number }[] = []
  for (const c of list) {
    if (c.name.startsWith(name)) {
      hits.push({ c, score: c.weight + (c.name.length === name.length ? EXACT_BONUS : 0), at: 0 })
    } else if (c.lower.startsWith(lower)) {
      hits.push({ c, score: c.weight - CASE_FOLD_PENALTY, at: 0 })
    } else if (lower.length >= MIN_SUBSTRING) {
      const at = c.lower.indexOf(lower)
      if (at > 0) hits.push({ c, score: c.weight - SUBSTRING_PENALTY, at })
    }
  }
  hits.sort((a, b) => b.score - a.score || a.c.name.length - b.c.name.length || (a.c.name < b.c.name ? -1 : a.c.name > b.c.name ? 1 : 0))
  const ranges = new Map<Completion, [number, number]>()
  const options = hits.map(h => {
    // the label is the backslash + name: a prefix match covers the typed backslash too
    ranges.set(h.c.completion, h.at === 0 ? [0, typed.length] : [h.at + 1, h.at + 1 + name.length])
    return h.c.completion
  })
  return { options, ranges }
}

function commandSource(ctx: CompletionContext, before: string): CompletionResult | null {
  const m = /\\[A-Za-z@]*\*?$/.exec(before)
  if (!m) return null
  if (isEscaped(before, m.index)) return null
  const from = ctx.pos - m[0].length
  const lists = commandLists(projectIndex.snapshot())
  const inMath = isMathAt(ctx.state, from)
  const { options, ranges } = rankCommands(inMath ? lists.math : lists.text, m[0])
  if (options.length === 0) return null
  return {
    from,
    options,
    // our own matching and order (the library's fuzzy matcher lists scattered matches)
    filter: false,
    getMatch: completion => ranges.get(completion) ?? [],
    update: (_current, _from, _to, next) => commandSource(next, textBefore(next)),
  }
}

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

const REF_COMMANDS = new Set([
  'ref', 'eqref', 'pageref', 'autoref', 'Autoref', 'autopageref', 'nameref', 'Nameref', 'cref', 'Cref', 'cpageref',
  'Cpageref', 'labelcref', 'labelcpageref', 'crefrange', 'Crefrange', 'cpagerefrange', 'vref', 'Vref', 'vpageref',
  'subref', 'fref', 'Fref', 'zref', 'zcref', 'zpageref', 'namecref', 'nameCref', 'lcnamecref', 'Ref',
])
const LIST_REF_COMMANDS = new Set(['cref', 'Cref', 'cpageref', 'Cpageref', 'labelcref', 'zcref'])
const IMAGE_EXT = /\.(pdf|png|jpe?g|eps|ps|gif|svg|tiff?|bmp|webp)$/i
const TEX_EXT = /\.(tex|ltx|latex|tikz|pgf|txt)$/i

type FileRule = { filter: (path: string) => boolean; strip?: RegExp; list?: boolean }
const FILE_COMMANDS: Record<string, FileRule> = {
  input: { filter: p => TEX_EXT.test(p), strip: /\.tex$/i },
  include: { filter: p => /\.tex$/i.test(p), strip: /\.tex$/i },
  includeonly: { filter: p => /\.tex$/i.test(p), strip: /\.tex$/i, list: true },
  subfile: { filter: p => /\.tex$/i.test(p) },
  subfileinclude: { filter: p => /\.tex$/i.test(p) },
  includestandalone: { filter: p => /\.tex$/i.test(p), strip: /\.tex$/i },
  import: { filter: p => TEX_EXT.test(p) },
  subimport: { filter: p => TEX_EXT.test(p) },
  externaldocument: { filter: p => /\.tex$/i.test(p), strip: /\.tex$/i },
  includegraphics: { filter: p => IMAGE_EXT.test(p) },
  includepdf: { filter: p => /\.pdf$/i.test(p) },
  includesvg: { filter: p => /\.svg$/i.test(p), strip: /\.svg$/i },
  lstinputlisting: { filter: () => true },
  inputminted: { filter: () => true },
  verbatiminput: { filter: () => true },
  bibliography: { filter: p => /\.bib$/i.test(p), strip: /\.bib$/i, list: true },
  addbibresource: { filter: p => /\.bib$/i.test(p) },
  addglobalbib: { filter: p => /\.bib$/i.test(p) },
}

function isCiteCommand(name: string): boolean {
  if (name === 'nocite' || name === 'bibentry') return true
  return /cite/i.test(name) && !/^cite(?:style|indextrue|indexfalse|color)$/.test(name)
}

/** Match the argument being typed: `\cmd[..]{..}{partial` at the end of `before`. */
const ARG_RE = /\\([A-Za-z]+)\*?((?:\s*\[[^\]\n]*\]|\s*\{[^{}\n]*\}|\s*<[^>\n]*>)*)\s*\{([^{}\n]*)$/
const HYPERREF_RE = /\\hyperref\s*\[([^\]\n]*)$/

function argumentFrom(ctx: CompletionContext, partial: string, list: boolean): number {
  let cut = 0
  if (list) cut = partial.lastIndexOf(',') + 1
  let from = ctx.pos - partial.length + cut
  while (from < ctx.pos && /\s/.test(ctx.state.sliceDoc(from, from + 1))) from++
  return from
}

/** Completion info showing a line of LaTeX source. */
function codeInfo(code: string): () => Node {
  return () => {
    const el = document.createElement('code')
    el.className = 'ed-info-code'
    el.textContent = code
    return el
  }
}

let labelCache: { rev: number; options: Completion[] } | null = null
function labelOptions(index: ProjectIndexSnapshot): Completion[] {
  if (labelCache && labelCache.rev === index.rev) return labelCache.options
  const seen = new Set<string>()
  const options: Completion[] = []
  for (const l of index.labels) {
    if (seen.has(l.label)) continue
    seen.add(l.label)
    options.push({
      label: l.label,
      detail: `${basename(l.path)}:${l.line}`,
      info: l.context ? codeInfo(l.context) : undefined,
      type: 'label',
      apply: applyArgument,
    })
  }
  labelCache = { rev: index.rev, options }
  return options
}

function citeInfo(c: IndexedCite): () => Node {
  return () => {
    const root = document.createElement('div')
    root.className = 'ed-cite-info'
    if (c.source === 'bib') {
      if (c.title) {
        const title = document.createElement('div')
        title.className = 'ed-cite-info__title'
        title.textContent = c.title
        root.appendChild(title)
      }
      const meta = document.createElement('div')
      meta.className = 'ed-cite-info__meta'
      meta.textContent = [c.author, c.year].filter(Boolean).join(' · ')
      if (meta.textContent) root.appendChild(meta)
    } else if (c.text) {
      const text = document.createElement('div')
      text.className = 'ed-cite-info__text'
      text.textContent = c.text
      root.appendChild(text)
    }
    const src = document.createElement('div')
    src.className = 'ed-cite-info__src'
    src.textContent = c.source === 'bib' ? `@${c.type ?? 'entry'} · ${c.path}:${c.line}` : `\\bibitem · ${c.path}:${c.line}`
    root.appendChild(src)
    return root
  }
}

let citeCache: { rev: number; options: Completion[] } | null = null
function citeOptions(index: ProjectIndexSnapshot): Completion[] {
  if (citeCache && citeCache.rev === index.rev) return citeCache.options
  const options = index.cites.map<Completion>(c => {
    const who = c.author ? c.author.split(/\s+and\s+/)[0].split(',')[0].trim() : ''
    const detail = c.source === 'bib' ? [who, c.year].filter(Boolean).join(' ') : c.year ?? 'bibitem'
    return { label: c.key, detail, info: citeInfo(c), type: 'cite', apply: applyArgument }
  })
  citeCache = { rev: index.rev, options }
  return options
}

function rootDir(): string {
  const root = useProject.getState().rootFile()
  return root ? dirname(root.path) : ''
}

function fileOptions(index: ProjectIndexSnapshot, rule: FileRule): Completion[] {
  const base = rootDir()
  const prefix = base ? `${base}/` : ''
  const out: Completion[] = []
  for (const f of index.files) {
    if (f.kind === 'folder' || !rule.filter(f.path)) continue
    let path = prefix && f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path
    if (rule.strip) path = path.replace(rule.strip, '')
    out.push({
      label: path,
      detail: f.kind === 'binary' ? extname(f.path).toUpperCase() : undefined,
      type: IMAGE_EXT.test(f.path) ? 'image' : 'file',
      apply: applyArgument,
      boost: path.includes('/') ? 0 : 1,
    })
  }
  return out
}

function nameOptions(names: string[], projectExt: RegExp | null, type: string): Completion[] {
  const seen = new Set<string>()
  const out: Completion[] = []
  if (projectExt) {
    const base = rootDir()
    const prefix = base ? `${base}/` : ''
    for (const f of Object.values(useProject.getState().files)) {
      if (f.kind === 'folder' || !projectExt.test(f.path)) continue
      let p = prefix && f.path.startsWith(prefix) ? f.path.slice(prefix.length) : f.path
      p = p.replace(projectExt, '')
      if (seen.has(p)) continue
      seen.add(p)
      out.push({ label: p, type: 'file', detail: 'project', boost: 5, apply: applyArgument })
    }
  }
  for (const n of names) {
    if (seen.has(n)) continue
    seen.add(n)
    out.push({ label: n, type, apply: applyArgument })
  }
  return out
}

// -- environments ------------------------------------------------------------------------------

const ENV_BY_NAME = new Map(ENVIRONMENTS.map(e => [e.name, e]))
const LIST_ENVS = new Set(['itemize', 'enumerate', 'description'])

function environmentTemplate(spec: EnvironmentSpec | undefined, name: string, indent: string, unit: string): string {
  const args = spec?.args ?? ''
  const bodyLines = spec?.body?.length ? spec.body : LIST_ENVS.has(name) ? ['\\item ${}'] : ['${}']
  const inner = bodyLines.map(l => `${indent}${unit}${l}`).join('\n')
  return `${escapeTemplate(name)}}${args}\n${inner}\n${indent}\\end{${escapeTemplate(name)}}`
}

function applyEnvironment(name: string, isBegin: boolean) {
  return (view: EditorView, completion: Completion, from: number, to: number) => {
    const { state } = view
    const line = state.doc.lineAt(from)
    const end = tokenEnd(state, to, /[^{}\s%]/)
    const hasClose = state.sliceDoc(end, end + 1) === '}'
    const closeEnd = hasClose ? end + 1 : end
    const rest = state.sliceDoc(closeEnd, line.to)
    const spec = ENV_BY_NAME.get(name)
    if (!isBegin) {
      view.dispatch({ ...insertCompletionText(state, `${name}}`, from, closeEnd), annotations: pickedCompletion.of(completion) })
      return
    }
    let block = rest.trim() === ''
    if (block) {
      const text = state.doc.toString()
      const oldName = state.sliceDoc(from, end)
      if (oldName && oldName !== name) {
        // renaming a \begin that already has its \end: only change the name
        const old = countEnvironment(text, oldName)
        if (old.begins > 0 && old.ends >= old.begins) block = false
      }
      if (block) {
        const cur = countEnvironment(text, name)
        const alreadyHere = oldName === name ? 0 : 1
        if (cur.begins + alreadyHere <= cur.ends) block = false
      }
    }
    if (!block) {
      const args = rest.trim() === '' && spec?.args ? spec.args : ''
      if (args) snippet(`${escapeTemplate(name)}}${args}`)(view, completion, from, closeEnd)
      else view.dispatch({ ...insertCompletionText(state, `${name}}`, from, closeEnd), annotations: pickedCompletion.of(completion) })
      return
    }
    const indent = /^\s*/.exec(line.text)![0]
    const unit = state.facet(indentUnit)
    snippet(environmentTemplate(spec, name, indent, unit))(view, completion, from, line.to)
  }
}

let envCache: { rev: number; begin: Completion[]; end: Completion[] } | null = null
function environmentOptions(index: ProjectIndexSnapshot): { begin: Completion[]; end: Completion[] } {
  if (envCache && envCache.rev === index.rev) return envCache
  const begin: Completion[] = []
  const end: Completion[] = []
  const seen = new Set<string>()
  const add = (name: string, info: string | undefined, boost: number, type: string) => {
    if (seen.has(name)) return
    seen.add(name)
    begin.push({ label: name, info, type, boost, apply: applyEnvironment(name, true) })
    end.push({ label: name, info, type, boost, apply: applyEnvironment(name, false) })
  }
  for (const e of ENVIRONMENTS) add(e.name, e.info, e.boost ?? 0, 'env')
  for (const e of index.environments) add(e, 'Used in this project', 2, 'env')
  envCache = { rev: index.rev, begin, end }
  return envCache
}

function argumentSource(ctx: CompletionContext, before: string): CompletionResult | null {
  const hyper = HYPERREF_RE.exec(before)
  if (hyper) {
    const from = argumentFrom(ctx, hyper[1], false)
    return { from, options: labelOptions(projectIndex.snapshot()), validFor: /^[^,\]\s]*$/ }
  }
  const m = ARG_RE.exec(before)
  if (!m) return null
  if (isEscaped(before, m.index)) return null
  const cmd = m[1]
  const prior = m[2]
  const partial = m[3]
  const index = projectIndex.snapshot()

  if (cmd === 'begin' || cmd === 'end') {
    if (prior.trim()) return null
    const envs = environmentOptions(index)
    const from = argumentFrom(ctx, partial, false)
    if (cmd === 'end') {
      const open = innermostOpenEnvironment(ctx.state.doc, from - 5)
      const options = open ? envs.end.map(o => (o.label === open ? { ...o, boost: 99 } : o)) : envs.end
      if (open && !ENV_BY_NAME.has(open) && !index.environments.includes(open)) {
        options.unshift({ label: open, type: 'env', boost: 99, apply: applyEnvironment(open, false) })
      }
      return { from, options, validFor: /^[A-Za-z*@]*$/ }
    }
    return { from, options: envs.begin, validFor: /^[A-Za-z*@]*$/ }
  }
  if (REF_COMMANDS.has(cmd)) {
    const from = argumentFrom(ctx, partial, LIST_REF_COMMANDS.has(cmd))
    let options = labelOptions(index)
    if (cmd === 'eqref') options = options.map(o => (/^eq/.test(o.label) ? { ...o, boost: 5 } : o))
    return { from, options, validFor: /^[^,}\s]*$/ }
  }
  if (isCiteCommand(cmd)) {
    const from = argumentFrom(ctx, partial, true)
    return { from, options: citeOptions(index), validFor: /^[^,}\s]*$/ }
  }
  const rule = FILE_COMMANDS[cmd]
  if (rule) {
    // \import{dir}{file}: complete the second argument only
    if ((cmd === 'import' || cmd === 'subimport' || cmd === 'inputminted') && !/\{/.test(prior)) return null
    const from = argumentFrom(ctx, partial, !!rule.list)
    return { from, options: fileOptions(index, rule), validFor: /^[^,}]*$/ }
  }
  if (cmd === 'usepackage' || cmd === 'RequirePackage') {
    const from = argumentFrom(ctx, partial, true)
    return { from, options: nameOptions(PACKAGES, /\.sty$/i, 'package'), validFor: /^[^,}\s]*$/ }
  }
  if (cmd === 'documentclass' || cmd === 'LoadClass') {
    const from = argumentFrom(ctx, partial, false)
    return { from, options: nameOptions(DOCUMENT_CLASSES, /\.cls$/i, 'package'), validFor: /^[^,}\s]*$/ }
  }
  if (cmd === 'bibliographystyle') {
    const from = argumentFrom(ctx, partial, false)
    return { from, options: nameOptions(BIB_STYLES, /\.bst$/i, 'package'), validFor: /^[^,}\s]*$/ }
  }
  return null
}

/** The text before the cursor on its line (at most 600 characters). */
function textBefore(ctx: CompletionContext): string {
  const line = ctx.state.doc.lineAt(ctx.pos)
  return line.text.slice(Math.max(0, ctx.pos - line.from - 600), ctx.pos - line.from)
}

export const latexCompletionSource: CompletionSource = ctx => {
  if (ctx.state.facet(docKindFacet) !== 'latex') return null
  const before = textBefore(ctx)
  if (commentStart(before) !== -1) return null
  return argumentSource(ctx, before) ?? commandSource(ctx, before)
}

// ---------------------------------------------------------------------------------------------
// BibTeX
// ---------------------------------------------------------------------------------------------

const BIB_TYPES: [string, string[]][] = [
  ['article', ['author', 'title', 'journal', 'year', 'volume', 'number', 'pages', 'doi']],
  ['inproceedings', ['author', 'title', 'booktitle', 'year', 'pages', 'publisher', 'doi']],
  ['book', ['author', 'title', 'publisher', 'year', 'address', 'isbn']],
  ['incollection', ['author', 'title', 'booktitle', 'editor', 'publisher', 'year', 'pages']],
  ['inbook', ['author', 'title', 'chapter', 'publisher', 'year', 'pages']],
  ['misc', ['author', 'title', 'howpublished', 'year', 'note', 'url']],
  ['online', ['author', 'title', 'url', 'urldate', 'year']],
  ['techreport', ['author', 'title', 'institution', 'number', 'year']],
  ['phdthesis', ['author', 'title', 'school', 'year']],
  ['mastersthesis', ['author', 'title', 'school', 'year']],
  ['proceedings', ['title', 'editor', 'publisher', 'year']],
  ['manual', ['title', 'author', 'organization', 'year']],
  ['unpublished', ['author', 'title', 'note', 'year']],
  ['booklet', ['title', 'author', 'howpublished', 'year']],
]
const BIB_FIELDS = [
  'author', 'title', 'journal', 'booktitle', 'year', 'month', 'volume', 'number', 'pages', 'doi', 'url', 'urldate',
  'publisher', 'address', 'editor', 'edition', 'series', 'chapter', 'institution', 'organization', 'school',
  'howpublished', 'note', 'isbn', 'issn', 'eprint', 'archiveprefix', 'primaryclass', 'keywords', 'abstract', 'language',
  'date', 'eventtitle', 'location', 'type',
]

const bibTypeOptions: Completion[] = BIB_TYPES.map(([type, fields]) => ({
  label: `@${type}`,
  type: 'keyword',
  detail: 'entry',
  apply: snippet(`@${type}{\${key},\n${fields.map(f => `  ${f} = {\${}},`).join('\n')}\n}`),
}))
const bibFieldOptions: Completion[] = BIB_FIELDS.map(f => ({
  label: f,
  type: 'property',
  apply: snippet(`${f} = {\${}},`),
}))

export const bibtexCompletionSource: CompletionSource = ctx => {
  if (ctx.state.facet(docKindFacet) !== 'bibtex') return null
  const line = ctx.state.doc.lineAt(ctx.pos)
  const before = line.text.slice(0, ctx.pos - line.from)
  const type = /^\s*@[A-Za-z]*$/.exec(before)
  if (type) return { from: ctx.pos - type[0].trimStart().length, options: bibTypeOptions, validFor: /^@[A-Za-z]*$/ }
  const field = /^\s+([A-Za-z]*)$/.exec(before)
  if (field && (field[1] || ctx.explicit)) return { from: ctx.pos - field[1].length, options: bibFieldOptions, validFor: /^[A-Za-z]*$/ }
  return null
}

// ---------------------------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------------------------

export function completionExtension(activateOnTyping: boolean): Extension {
  return autocompletion({
    override: [latexCompletionSource, bibtexCompletionSource],
    activateOnTyping,
    activateOnCompletion: reopensCompletion,
    maxRenderedOptions: 60,
    icons: true,
    closeOnBlur: true,
    tooltipClass: () => 'ed-completion',
    interactionDelay: 60,
  })
}
