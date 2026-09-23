/**
 * Showing the editor and giving it the keyboard focus.
 *
 * - revealEditorPanel(): a jump (search result, outline, log entry, SyncTeX, breadcrumb) or a
 *   file opened from the tree must be visible: the "PDF only" layout switches to split and the
 *   History overlay closes (FE-4).
 * - whenSized(view, fn): runs fn once the editor has a size. In the "PDF only" layout the editor
 *   panel is collapsed to width 0; scrolling it there leaves the caret far off screen once it is
 *   shown again (and makes CodeMirror's measure loop restart).
 * - Focus (INT-1): an editor that has just synced takes the focus only when the user asked for
 *   that file (requestEditorFocus, e.g. a click in the file tree), or when nothing else holds the
 *   focus typing would go to. It never takes it from a text field, a tree (file tree, outline),
 *   a menu or a dialog: keystrokes meant for those must not land in a document the store opened
 *   by itself.
 */
import type { EditorView } from '@codemirror/view'
import { useEditor } from '../../stores/editor'
import { useLayout } from '../../stores/layout'

/**
 * Make the editor visible: leave the "PDF only" layout and close the History overlay. Returns
 * true when the layout changed (the editor panel is about to be resized).
 */
export function revealEditorPanel(): boolean {
  const layout = useLayout.getState()
  let changed = false
  if (layout.historyOpen) {
    layout.setHistoryOpen(false)
    changed = true
  }
  if (layout.view === 'pdf') {
    layout.setView('split')
    changed = true
  }
  return changed
}

/** Run `fn` once the layout change just requested has been rendered (two frames). */
export function afterLayout(fn: () => void): () => void {
  let raf = requestAnimationFrame(() => {
    raf = requestAnimationFrame(fn)
  })
  return () => cancelAnimationFrame(raf)
}

function hasSize(view: EditorView): boolean {
  return view.dom.isConnected && view.scrollDOM.clientWidth > 0 && view.scrollDOM.clientHeight > 0
}

/**
 * Run `fn` now when the editor is laid out, else as soon as it gets a size (the editor panel
 * expanding). Returns a cancel function.
 */
export function whenSized(view: EditorView, fn: () => void): () => void {
  if (hasSize(view)) {
    fn()
    return () => {}
  }
  if (typeof ResizeObserver === 'undefined') {
    fn()
    return () => {}
  }
  let done = false
  const ro = new ResizeObserver(() => {
    if (done || !hasSize(view)) return
    done = true
    ro.disconnect()
    fn()
  })
  ro.observe(view.scrollDOM)
  return () => {
    done = true
    ro.disconnect()
  }
}

/** A focus request lives this long (a slow connection can take a while to sync). */
const FOCUS_REQUEST_MS = 60_000
let focusRequest: { fileId: string; at: number } | null = null
/** a file the store opened by itself (the open file was replaced): it must not take the focus */
let noFocus: { fileId: string; at: number } | null = null

/** The user opened this file on purpose: its editor takes the focus once it has synced. */
export function requestEditorFocus(fileId: string): void {
  if (useEditor.getState().openFileId === fileId) return
  focusRequest = { fileId, at: Date.now() }
}

/** The store opened this file by itself: its editor must not take the focus when it has synced. */
export function suppressAutoFocus(fileId: string): void {
  noFocus = { fileId, at: Date.now() }
  if (focusRequest?.fileId === fileId) focusRequest = null
}

function takeFocusRequest(fileId: string): boolean {
  const req = focusRequest
  if (!req || req.fileId !== fileId) return false
  focusRequest = null
  return Date.now() - req.at < FOCUS_REQUEST_MS
}

/** Where typing is going somewhere else: text fields, trees, lists, menus and dialogs. */
const KEEP_FOCUS = [
  'input', 'textarea', 'select', '[contenteditable]:not([contenteditable="false"])',
  '[role="dialog"]', '[role="alertdialog"]', '[role="tree"]', '[role="treeitem"]', '[role="menu"]', '[role="menuitem"]',
  '[role="listbox"]', '[role="option"]', '[role="grid"]', '[role="textbox"]',
].join(', ')

/**
 * May the editor of `fileId`, which has just synced, take the keyboard focus? Yes when the user
 * asked for this file, or when the focus is on nothing / a plain button or link; no when it is
 * somewhere the user is typing or navigating.
 */
export function mayTakeFocus(fileId: string): boolean {
  if (noFocus && noFocus.fileId === fileId) {
    const fresh = Date.now() - noFocus.at < FOCUS_REQUEST_MS
    noFocus = null
    if (fresh) return false
  }
  if (takeFocusRequest(fileId)) return true
  const active = document.activeElement
  if (!active || active === document.body || active === document.documentElement) return true
  return !active.closest(KEEP_FOCUS)
}
