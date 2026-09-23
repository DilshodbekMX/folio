/**
 * Emacs keybindings (our own keymap).
 *
 * Deviation: @replit/codemirror-emacs is not used — its key and command registrations are
 * top-level calls annotated `/*@__PURE__*\/`, which bundlers (Vite's dependency optimizer,
 * Rolldown) drop, leaving an Emacs mode where no key works. This keymap covers the usual
 * Emacs editing set on top of CodeMirror commands, with a transient mark (C-Space) and a
 * kill ring:
 *   movement   C-f C-b C-n C-p C-a C-e M-f M-b M-< M-> C-v M-v   (extend the region while the mark is set)
 *   mark       C-Space set/unset, C-g quit, C-x C-x exchange point and mark, C-x h select all
 *   kill/yank  C-k (consecutive kills append) C-w M-w C-y M-y M-d M-Backspace C-d
 *   other      C-/ C-_ C-x u undo, C-s C-r search, M-g g go to line, C-l recenter, C-o open line,
 *              C-t transpose, M-u M-l M-c case, M-; comment, M-/ complete, C-x C-s compile
 */
import { EditorSelection, Prec, StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap, type Command } from '@codemirror/view'
import * as cmd from '@codemirror/commands'
import { startCompletion, closeCompletion } from '@codemirror/autocomplete'
import { closeSearchPanel, gotoLine, openSearchPanel } from '@codemirror/search'
import { yUndoManagerKeymap } from 'y-codemirror.next'
import { useCompile } from '../../../stores/compile'

const setMarkEffect = StateEffect.define<boolean>()

/** Transient mark: while true, movement commands extend the selection. */
const markField = StateField.define<boolean>({
  create: () => false,
  update(active, tr) {
    for (const e of tr.effects) if (e.is(setMarkEffect)) active = e.value
    if (tr.docChanged) active = false
    return active
  },
})

const markActive = (s: EditorState) => s.field(markField, false) ?? false

function go(move: Command, select: Command): Command {
  return view => (markActive(view.state) ? select(view) : move(view))
}

function collapse(view: EditorView): void {
  const sel = view.state.selection
  view.dispatch({ selection: EditorSelection.create(sel.ranges.map(r => EditorSelection.cursor(r.head)), sel.mainIndex), effects: setMarkEffect.of(false) })
}

// -- kill ring --------------------------------------------------------------------------------------

const killRing: string[] = []
let yankIndex = 0
/** position right after the last kill (consecutive C-k append) and the last yank range */
let lastKill: { view: EditorView; at: number; len: number } | null = null
let lastYank: { view: EditorView; from: number; to: number } | null = null

function pushKill(view: EditorView, text: string, at: number, append: boolean): void {
  if (append && killRing.length) killRing[killRing.length - 1] += text
  else killRing.push(text)
  if (killRing.length > 60) killRing.shift()
  lastKill = { view, at, len: view.state.doc.length }
  try {
    void navigator.clipboard?.writeText(killRing[killRing.length - 1]).catch(() => {})
  } catch {
    // clipboard unavailable (insecure context): the internal ring still works
  }
}

const killLine: Command = view => {
  if (view.state.readOnly) return false
  const { state } = view
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  const rest = state.sliceDoc(head, line.to)
  const to = /^\s*$/.test(rest) && line.to < state.doc.length ? line.to + 1 : line.to
  if (to === head) return true
  const append = lastKill !== null && lastKill.view === view && lastKill.at === head
  view.dispatch({ changes: { from: head, to }, selection: EditorSelection.cursor(head), userEvent: 'delete.cut' })
  pushKill(view, state.sliceDoc(head, to), head, append)
  return true
}

function killRange(view: EditorView, copyOnly: boolean): boolean {
  const { state } = view
  const r = state.selection.main
  if (r.empty) return true
  pushKill(view, state.sliceDoc(r.from, r.to), r.from, false)
  if (copyOnly || state.readOnly) collapse(view)
  else view.dispatch({ changes: { from: r.from, to: r.to }, selection: EditorSelection.cursor(r.from), effects: setMarkEffect.of(false), userEvent: 'delete.cut' })
  return true
}

function killWord(forward: boolean): Command {
  return view => {
    if (view.state.readOnly) return false
    const head = view.state.selection.main.head
    const sel = forward ? cmd.selectGroupForward : cmd.selectGroupBackward
    view.dispatch({ selection: EditorSelection.cursor(head) })
    sel(view)
    const r = view.state.selection.main
    if (r.empty) return true
    const text = view.state.sliceDoc(r.from, r.to)
    view.dispatch({ changes: { from: r.from, to: r.to }, selection: EditorSelection.cursor(r.from), userEvent: 'delete.cut' })
    pushKill(view, text, r.from, false)
    return true
  }
}

const yank: Command = view => {
  if (view.state.readOnly || !killRing.length) return !killRing.length
  yankIndex = killRing.length - 1
  const text = killRing[yankIndex]
  const r = view.state.selection.main
  view.dispatch({ changes: { from: r.from, to: r.to, insert: text }, selection: EditorSelection.cursor(r.from + text.length), userEvent: 'input.paste' })
  lastYank = { view, from: r.from, to: r.from + text.length }
  return true
}

const yankPop: Command = view => {
  if (!lastYank || lastYank.view !== view || killRing.length < 2 || view.state.readOnly) return true
  if (view.state.selection.main.head !== lastYank.to) return true
  yankIndex = (yankIndex - 1 + killRing.length) % killRing.length
  const text = killRing[yankIndex]
  view.dispatch({ changes: { from: lastYank.from, to: lastYank.to, insert: text }, selection: EditorSelection.cursor(lastYank.from + text.length), userEvent: 'input.paste' })
  lastYank = { view, from: lastYank.from, to: lastYank.from + text.length }
  return true
}

// -- other commands -----------------------------------------------------------------------------------

const setMark: Command = view => {
  if (markActive(view.state)) collapse(view)
  else view.dispatch({ effects: setMarkEffect.of(true) })
  return true
}

const keyboardQuit: Command = view => {
  closeCompletion(view)
  closeSearchPanel(view)
  collapse(view)
  return true
}

const exchangePointAndMark: Command = view => {
  const sel = view.state.selection
  view.dispatch({
    selection: EditorSelection.create(sel.ranges.map(r => EditorSelection.range(r.head, r.anchor)), sel.mainIndex),
    effects: setMarkEffect.of(!sel.main.empty),
  })
  return true
}

const recenter: Command = view => {
  view.dispatch({ effects: EditorView.scrollIntoView(view.state.selection.main.head, { y: 'center' }) })
  return true
}

function changeCase(mode: 'upper' | 'lower' | 'capitalize'): Command {
  return view => {
    if (view.state.readOnly) return false
    const head = view.state.selection.main.head
    view.dispatch({ selection: EditorSelection.cursor(head) })
    cmd.selectGroupForward(view)
    const r = view.state.selection.main
    const text = view.state.sliceDoc(r.from, r.to)
    const out = mode === 'upper' ? text.toUpperCase() : mode === 'lower' ? text.toLowerCase() : text.replace(/[A-Za-z]/, c => c.toUpperCase())
    view.dispatch({ changes: { from: r.from, to: r.to, insert: out }, selection: EditorSelection.cursor(r.to), userEvent: 'input' })
    return true
  }
}

const compile: Command = () => {
  useCompile.getState().compile().catch(() => {}) // viewers may compile by hand too
  return true
}

const undo: Command = view => yUndoManagerKeymap[0].run!(view)
const redo: Command = view => yUndoManagerKeymap[1].run!(view)

const bindings: { key: string; run: Command }[] = [
  { key: 'Ctrl-f', run: go(cmd.cursorCharForward, cmd.selectCharForward) },
  { key: 'Ctrl-b', run: go(cmd.cursorCharBackward, cmd.selectCharBackward) },
  { key: 'Ctrl-n', run: go(cmd.cursorLineDown, cmd.selectLineDown) },
  { key: 'Ctrl-p', run: go(cmd.cursorLineUp, cmd.selectLineUp) },
  { key: 'Ctrl-a', run: go(cmd.cursorLineBoundaryBackward, cmd.selectLineBoundaryBackward) },
  { key: 'Ctrl-e', run: go(cmd.cursorLineBoundaryForward, cmd.selectLineBoundaryForward) },
  { key: 'Alt-f', run: go(cmd.cursorGroupForward, cmd.selectGroupForward) },
  { key: 'Alt-b', run: go(cmd.cursorGroupBackward, cmd.selectGroupBackward) },
  { key: 'Alt-<', run: go(cmd.cursorDocStart, cmd.selectDocStart) },
  { key: 'Alt->', run: go(cmd.cursorDocEnd, cmd.selectDocEnd) },
  { key: 'Ctrl-v', run: go(cmd.cursorPageDown, cmd.selectPageDown) },
  { key: 'Alt-v', run: go(cmd.cursorPageUp, cmd.selectPageUp) },
  { key: 'Ctrl-Space', run: setMark },
  { key: 'Ctrl-@', run: setMark },
  { key: 'Ctrl-g', run: keyboardQuit },
  { key: 'Ctrl-x Ctrl-x', run: exchangePointAndMark },
  { key: 'Ctrl-x h', run: cmd.selectAll },
  { key: 'Ctrl-k', run: killLine },
  { key: 'Ctrl-w', run: view => killRange(view, false) },
  { key: 'Alt-w', run: view => killRange(view, true) },
  { key: 'Ctrl-y', run: yank },
  { key: 'Alt-y', run: yankPop },
  { key: 'Alt-d', run: killWord(true) },
  { key: 'Alt-Backspace', run: killWord(false) },
  { key: 'Ctrl-d', run: cmd.deleteCharForward },
  { key: 'Ctrl-/', run: undo },
  { key: 'Ctrl-_', run: undo },
  { key: 'Ctrl-x u', run: undo },
  { key: 'Ctrl-Shift-/', run: redo },
  { key: 'Ctrl-s', run: openSearchPanel },
  { key: 'Ctrl-r', run: openSearchPanel },
  { key: 'Alt-g g', run: gotoLine },
  { key: 'Alt-g Alt-g', run: gotoLine },
  { key: 'Ctrl-l', run: recenter },
  { key: 'Ctrl-o', run: cmd.splitLine },
  { key: 'Ctrl-t', run: cmd.transposeChars },
  { key: 'Alt-u', run: changeCase('upper') },
  { key: 'Alt-l', run: changeCase('lower') },
  { key: 'Alt-c', run: changeCase('capitalize') },
  { key: 'Alt-;', run: cmd.toggleComment },
  { key: 'Alt-/', run: startCompletion },
  { key: 'Ctrl-x Ctrl-s', run: compile },
]
const keyBindings = bindings.map(b => ({ ...b, preventDefault: true }))

/** Clicking elsewhere clears the mark, like typing does. */
const clearMarkOnPointer = EditorView.domEventHandlers({
  mousedown(_e, view) {
    if (markActive(view.state)) view.dispatch({ effects: setMarkEffect.of(false) })
    return false
  },
})

export function emacsKeybindings(): Extension {
  return [markField, clearMarkOnPointer, Prec.high(keymap.of(keyBindings))]
}
