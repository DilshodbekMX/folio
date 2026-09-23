/**
 * LaTeX editing commands used by the keymap, the menus (runEditorCommand) and the toolbar:
 * bold/italic toggles, math, lists, sectioning, figure/table/link snippets, citation and
 * cross-reference insertion (opening the completion list), compile shortcuts, case changes.
 *
 * Overleaf-compatible bindings (PAR-23), ahead of CodeMirror's defaults: Mod-d deletes the line
 * (CodeMirror's "select next occurrence" moves to Mod-Shift-d), Mod-u / Mod-Shift-u upper- /
 * lower-case the selection or the word at the cursor, F2 folds/unfolds at the cursor,
 * Alt-Shift-1 / Alt-Shift-0 fold / unfold everything.
 */
import { EditorSelection, type ChangeSpec, type EditorState, type SelectionRange } from '@codemirror/state'
import type { Command, EditorView, KeyBinding } from '@codemirror/view'
import { deleteLine } from '@codemirror/commands'
import { foldAll, indentUnit, toggleFold, unfoldAll } from '@codemirror/language'
import { selectNextOccurrence } from '@codemirror/search'
import { snippet, startCompletion } from '@codemirror/autocomplete'
import { useCompile } from '../../../stores/compile'
import { docKindFacet } from './completion'
import { matchBrace } from './latexScan'
import { insertEnvironmentEnd } from './autoClose'
import { openSearch } from './searchPanel'
import { gotoLine } from '@codemirror/search'

const SEARCH_WINDOW = 4000

function isLatex(state: EditorState): boolean {
  return state.facet(docKindFacet) === 'latex'
}

/** Enclosing `\cmd{…}` around [from, to]: offsets of the backslash, the argument and the closing brace. */
export function findEnclosingCommand(state: EditorState, from: number, to: number, cmd: string): { start: number; argStart: number; argEnd: number } | null {
  const base = Math.max(0, from - SEARCH_WINDOW)
  const text = state.sliceDoc(base, Math.min(state.doc.length, to + SEARCH_WINDOW))
  const open = `\\${cmd}{`
  let i = text.lastIndexOf(open, from - base)
  while (i !== -1) {
    const close = matchBrace(text, i + open.length - 1)
    const argStart = base + i + open.length
    if (close !== -1) {
      const argEnd = base + close - 1
      if (argStart <= from && argEnd >= to) return { start: base + i, argStart, argEnd }
    }
    if (i === 0) break
    i = text.lastIndexOf(open, i - 1)
  }
  return null
}

/** Mod-b / Mod-i: wrap the selection in `\cmd{…}`, or remove the wrapper when already inside one. */
export function toggleWrap(view: EditorView, cmd: string): boolean {
  const { state } = view
  if (state.readOnly) return false
  const open = `\\${cmd}{`
  const tr = state.changeByRange(range => {
    const text = state.sliceDoc(range.from, range.to)
    // the selection is exactly \cmd{…}
    if (text.startsWith(open) && text.endsWith('}') && matchBrace(text, open.length - 1) === text.length) {
      return {
        changes: [{ from: range.from, to: range.from + open.length }, { from: range.to - 1, to: range.to }],
        range: EditorSelection.range(range.from, range.to - open.length - 1),
      }
    }
    const enclosing = findEnclosingCommand(state, range.from, range.to, cmd)
    if (enclosing) {
      const shift = (pos: number) => (pos > enclosing.argEnd ? pos - open.length - 1 : Math.max(enclosing.start, pos - open.length))
      return {
        changes: [{ from: enclosing.start, to: enclosing.argStart }, { from: enclosing.argEnd, to: enclosing.argEnd + 1 }],
        range: EditorSelection.range(shift(range.anchor), shift(range.head)),
      }
    }
    return {
      changes: [{ from: range.from, insert: open }, { from: range.to, insert: '}' }],
      range: EditorSelection.range(range.anchor + open.length, range.head + open.length),
    }
  })
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
  return true
}

/** Wrap the selection in a pair of delimiters, cursor inside when empty. */
export function wrapWith(view: EditorView, before: string, after: string): boolean {
  const { state } = view
  if (state.readOnly) return false
  const tr = state.changeByRange(range => ({
    changes: [{ from: range.from, insert: before }, { from: range.to, insert: after }],
    range: EditorSelection.range(range.anchor + before.length, range.head + before.length),
  }))
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.format' }))
  return true
}

function lineIndent(state: EditorState, pos: number): string {
  return /^\s*/.exec(state.doc.lineAt(pos).text)![0]
}

/**
 * Insert a multi-line snippet as its own block: at the cursor when the line is blank, else on
 * a new line after the current one. Template lines are re-indented to the current indentation.
 */
export function insertBlock(view: EditorView, lines: string[]): boolean {
  const { state } = view
  if (state.readOnly) return false
  const sel = state.selection.main
  const line = state.doc.lineAt(sel.head)
  const indent = lineIndent(state, sel.head)
  const blank = line.text.trim() === ''
  const template = lines.map(l => indent + l).join('\n')
  if (blank) snippet(template)(view, null, line.from, line.to)
  else snippet(`\n${template}`)(view, null, line.to, line.to)
  return true
}

/** The indent unit of the editor ('    ' by default). */
function unit(state: EditorState): string {
  return state.facet(indentUnit)
}

export function insertDisplayMath(view: EditorView): boolean {
  const { state } = view
  if (state.readOnly) return false
  const sel = state.selection.main
  const u = unit(state)
  if (!sel.empty) {
    const text = state.sliceDoc(sel.from, sel.to)
    const indent = lineIndent(state, sel.from)
    const insert = `\\[\n${indent}${u}${text}\n${indent}\\]`
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: EditorSelection.range(sel.from + 3 + indent.length + u.length, sel.from + 3 + indent.length + u.length + text.length), scrollIntoView: true, userEvent: 'input.format' })
    return true
  }
  return insertBlock(view, ['\\[', `${u}\${}`, '\\]'])
}

/** Bullet / numbered list; selected lines become \item entries. */
export function insertList(view: EditorView, env: 'itemize' | 'enumerate'): boolean {
  const { state } = view
  if (state.readOnly) return false
  const sel = state.selection.main
  const u = unit(state)
  if (!sel.empty) {
    const first = state.doc.lineAt(sel.from)
    const last = state.doc.lineAt(sel.to)
    const indent = lineIndent(state, first.from)
    const items = state.sliceDoc(first.from, last.to).split('\n').map(l => l.trim()).filter(Boolean)
    const body = items.map(l => `${indent}${u}${l.startsWith('\\item') ? l : `\\item ${l}`}`).join('\n')
    const insert = `${indent}\\begin{${env}}\n${body}\n${indent}\\end{${env}}`
    view.dispatch({ changes: { from: first.from, to: last.to, insert }, selection: EditorSelection.cursor(first.from + insert.length), scrollIntoView: true, userEvent: 'input.format' })
    return true
  }
  return insertBlock(view, [`\\begin{${env}}`, `${u}\\item \${}`, `\\end{${env}}`])
}

const HEADING_LINE = /^(\s*)\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)(\*?)\s*\{/

/** Turn the current line into a heading of the given level (or change its level). */
export function setHeading(view: EditorView, level: string): boolean {
  const { state } = view
  if (state.readOnly) return false
  const sel = state.selection.main
  const line = state.doc.lineAt(sel.head)
  const m = HEADING_LINE.exec(line.text)
  if (m) {
    const from = line.from + m[1].length + 1
    const to = from + m[2].length
    if (m[2] === level) {
      // same level again: back to normal text
      const braceAt = line.from + m[0].length - 1
      const close = matchBrace(line.text, m[0].length - 1)
      if (close === -1) return true
      const argEnd = line.from + close - 1
      view.dispatch({
        changes: [{ from: line.from + m[1].length, to: braceAt + 1 }, { from: argEnd, to: argEnd + 1 }],
        userEvent: 'input.format',
      })
      return true
    }
    view.dispatch({ changes: { from, to, insert: level }, userEvent: 'input.format' })
    return true
  }
  if (!sel.empty && state.doc.lineAt(sel.from).number === state.doc.lineAt(sel.to).number) {
    const text = state.sliceDoc(sel.from, sel.to)
    const insert = `\\${level}{${text}}`
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert }, selection: EditorSelection.range(sel.from + level.length + 2, sel.from + level.length + 2 + text.length), userEvent: 'input.format' })
    return true
  }
  if (line.text.trim() === '') {
    snippet(`${lineIndent(state, sel.head)}\\${level}{\${}}`)(view, null, line.from, line.to)
    return true
  }
  // a short plain line becomes the heading's title
  if (line.text.trim().length <= 120 && !line.text.includes('\\begin') && !line.text.trim().startsWith('%')) {
    const lead = lineIndent(state, line.from)
    const title = line.text.trim()
    view.dispatch({
      changes: { from: line.from + lead.length, to: line.to, insert: `\\${level}{${title}}` },
      selection: EditorSelection.cursor(line.from + lead.length + level.length + 2 + title.length),
      userEvent: 'input.format',
    })
    return true
  }
  return insertBlock(view, [`\\${level}{\${}}`])
}

/** Insert `\cmd{}` (e.g. \cite, \ref) at the cursor and open the completion list inside it. */
export function insertWithCompletion(view: EditorView, cmd: string): boolean {
  const { state } = view
  if (state.readOnly) return false
  const text = `\\${cmd}{}`
  const tr = state.changeByRange((range: SelectionRange) => ({
    changes: { from: range.from, to: range.to, insert: text } as ChangeSpec,
    range: EditorSelection.cursor(range.from + text.length - 1),
  }))
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }))
  startCompletion(view)
  return true
}

export function insertLink(view: EditorView): boolean {
  const { state } = view
  if (state.readOnly) return false
  const sel = state.selection.main
  const text = state.sliceDoc(sel.from, sel.to).replace(/[{}]/g, m => `\\${m}`)
  snippet(`\\href{\${url}}{\${${text || 'text'}}}`)(view, null, sel.from, sel.to)
  return true
}

export function insertFigure(view: EditorView): boolean {
  const u = unit(view.state)
  return insertBlock(view, [
    '\\begin{figure}[htbp]',
    `${u}\\centering`,
    `${u}\\includegraphics[width=0.8\\linewidth]{\${1:}}`,
    `${u}\\caption{\${2:Caption}}`,
    `${u}\\label{fig:\${3:label}}`,
    '\\end{figure}',
  ])
}

export function insertTable(view: EditorView): boolean {
  const u = unit(view.state)
  return insertBlock(view, [
    '\\begin{table}[htbp]',
    `${u}\\centering`,
    `${u}\\caption{\${1:Caption}}`,
    `${u}\\label{tab:\${2:label}}`,
    `${u}\\begin{tabular}{ccc}`,
    `${u}${u}\\hline`,
    `${u}${u}\${3:} &  &  \\\\`,
    `${u}${u} &  &  \\\\`,
    `${u}${u} &  &  \\\\`,
    `${u}${u}\\hline`,
    `${u}\\end{tabular}`,
    '\\end{table}',
  ])
}

/**
 * Upper- or lower-case every selection range; an empty range changes the word at the cursor
 * (the cursor stays where it was).
 */
export function changeCase(upper: boolean): Command {
  return view => {
    const { state } = view
    if (state.readOnly) return false
    let changed = false
    const tr = state.changeByRange(range => {
      const target = range.empty ? state.wordAt(range.head) : range
      if (!target || target.empty) return { range }
      const text = state.sliceDoc(target.from, target.to)
      const out = upper ? text.toUpperCase() : text.toLowerCase()
      if (out === text) return { range }
      changed = true
      const changes = { from: target.from, to: target.to, insert: out }
      if (range.empty) return { changes, range: EditorSelection.cursor(Math.min(range.head, target.from + out.length)) }
      // keep the whole (possibly longer, e.g. ß → SS) text selected, in the same direction
      return { changes, range: range.anchor <= range.head ? EditorSelection.range(target.from, target.from + out.length) : EditorSelection.range(target.from + out.length, target.from) }
    })
    if (!changed) return true
    view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input.case' }))
    return true
  }
}

/** Mod-Enter / Mod-s: viewers may compile by hand as well (useCompile refuses what needs edit rights). */
function compile(): boolean {
  useCompile.getState().compile().catch(() => {
    // failures are shown by the PDF pane (useCompile.error)
  })
  return true
}

/** Folio's own bindings (before the default keymap; after vim/emacs). */
export const folioKeymap: KeyBinding[] = [
  { key: 'Mod-Enter', run: compile, preventDefault: true },
  { key: 'Mod-s', run: compile, preventDefault: true },
  { key: 'Mod-b', run: view => isLatex(view.state) && toggleWrap(view, 'textbf') },
  { key: 'Mod-i', run: view => isLatex(view.state) && toggleWrap(view, 'textit') },
  { key: 'Mod-Shift-l', run: gotoLine, preventDefault: true },
  { key: 'Mod-f', run: view => openSearch(view, false), scope: 'editor search-panel', preventDefault: true },
  { key: 'Mod-h', run: view => openSearch(view, true), scope: 'editor search-panel', preventDefault: true },
  { key: 'Enter', run: insertEnvironmentEnd },
  // Overleaf's bindings
  { key: 'Mod-d', run: deleteLine, preventDefault: true },
  { key: 'Mod-Shift-d', run: selectNextOccurrence, preventDefault: true },
  { key: 'Mod-u', run: changeCase(true), preventDefault: true },
  { key: 'Mod-Shift-u', run: changeCase(false), preventDefault: true },
  { key: 'F2', run: toggleFold, preventDefault: true },
  { key: 'Alt-Shift-1', run: foldAll, preventDefault: true },
  { key: 'Alt-Shift-0', run: unfoldAll, preventDefault: true },
]
