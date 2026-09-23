/**
 * LaTeX auto-closing:
 *   - Enter at the end of a line ending in `\begin{name}` (plus optional/mandatory arguments)
 *     inserts an indented body line and `\end{name}` when the document does not already
 *     balance that environment (balance-aware, ignores comments; never adds stray braces).
 *   - With auto-close brackets on: `\{`, `\[`, `\(` insert their escaped partner (`\}`,
 *     `\]`, `\)`) and `\$` stays a single literal dollar.
 */
import { EditorSelection, type Extension } from '@codemirror/state'
import { indentUnit } from '@codemirror/language'
import { EditorView, type Command } from '@codemirror/view'
import { countEnvironment, inComment, isEscaped } from './latexScan'
import { docKindFacet } from './completion'

const BEGIN_AT_END = /\\begin\s*\{([A-Za-z@*]+)\}((?:\s*\[[^\]\n]*\]|\s*\{[^{}\n]*(?:\{[^{}\n]*\}[^{}\n]*)*\}|\s*\([^)\n]*\))*)\s*$/
const LIST_ENVS = new Set(['itemize', 'enumerate', 'description'])

/** Enter after `\begin{name}` → body line + `\end{name}` (when unbalanced). */
export const insertEnvironmentEnd: Command = view => {
  const { state } = view
  if (state.readOnly || state.facet(docKindFacet) !== 'latex') return false
  if (state.selection.ranges.length !== 1) return false
  const sel = state.selection.main
  if (!sel.empty) return false
  const line = state.doc.lineAt(sel.head)
  const before = line.text.slice(0, sel.head - line.from)
  const after = line.text.slice(sel.head - line.from)
  if (after.trim() !== '') return false
  const m = BEGIN_AT_END.exec(before)
  if (!m || isEscaped(before, m.index) || inComment(before, m.index)) return false
  const name = m[1]
  const counts = countEnvironment(state.doc.toString(), name)
  // the \begin just typed is counted: balanced means its \end already exists
  if (counts.begins <= counts.ends) return false
  const indent = /^\s*/.exec(line.text)![0]
  const unit = state.facet(indentUnit)
  const body = `${indent}${unit}${LIST_ENVS.has(name) ? '\\item ' : ''}`
  const insert = `\n${body}\n${indent}\\end{${name}}`
  view.dispatch({
    changes: { from: sel.head, to: line.to, insert },
    selection: EditorSelection.cursor(sel.head + 1 + body.length),
    scrollIntoView: true,
    userEvent: 'input',
  })
  return true
}

const PAIRS: Record<string, string> = { '{': '\\}', '[': '\\]', '(': '\\)' }
const CLOSERS = new Set(['}', ']', ')'])

/**
 * Typed `{`, `[`, `(` right after an unescaped backslash insert the escaped closing partner
 * (`\{|\}`); typing that partner again steps over it; a typed `$` after a backslash is a
 * literal dollar (never auto-paired). Must come before closeBrackets() in the extension list.
 */
export const escapedBrackets: Extension = EditorView.inputHandler.of((view, from, to, text) => {
  if (text.length !== 1 || view.state.readOnly || view.composing) return false
  if (text !== '{' && text !== '[' && text !== '(' && text !== '$' && !CLOSERS.has(text)) return false
  if (view.state.facet(docKindFacet) !== 'latex') return false
  if (view.state.selection.ranges.length !== 1) return false
  const line = view.state.doc.lineAt(from)
  const before = line.text.slice(0, from - line.from)
  if (!before.endsWith('\\') || isEscaped(before, before.length - 1)) return false
  if (CLOSERS.has(text)) {
    // `\` + `]` in front of an existing `\]`: step over it instead of duplicating
    if (from !== to || view.state.sliceDoc(from, from + 2) !== `\\${text}`) return false
    view.dispatch({ changes: { from: from - 1, to: from }, selection: EditorSelection.cursor(from + 1), userEvent: 'input.type' })
    return true
  }
  if (text === '$') {
    view.dispatch({ changes: { from, to, insert: '$' }, selection: EditorSelection.cursor(from + 1), userEvent: 'input.type' })
    return true
  }
  const close = PAIRS[text]
  const selected = view.state.sliceDoc(from, to)
  view.dispatch({
    changes: { from, to, insert: `${text}${selected}${close}` },
    selection: selected ? EditorSelection.range(from + 1, from + 1 + selected.length) : EditorSelection.cursor(from + 1),
    userEvent: 'input.type',
  })
  return true
})
