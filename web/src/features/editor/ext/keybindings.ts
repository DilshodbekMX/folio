/**
 * Vim / Emacs keybindings. Vim (@replit/codemirror-vim) is loaded on demand; its u / Ctrl-r /
 * :undo / :redo are routed to the Y.UndoManager (the stock handlers call CodeMirror's history,
 * which Folio does not use), and :w compiles like Mod-s. Emacs is our own keymap (./emacs.ts).
 */
import type { Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { yUndoManagerKeymap } from 'y-codemirror.next'
import type { UserSettings } from '@folio/shared/api'
import { useCompile } from '../../../stores/compile'
import { emacsKeybindings } from './emacs'

export type KeybindingMode = UserSettings['keybindings']

const loaded: Partial<Record<KeybindingMode, Extension>> = { default: [], emacs: emacsKeybindings() }
const loading: Partial<Record<KeybindingMode, Promise<Extension>>> = {}

export function yUndo(view: EditorView): boolean {
  return yUndoManagerKeymap[0].run!(view)
}

export function yRedo(view: EditorView): boolean {
  return yUndoManagerKeymap[1].run!(view)
}

/** vim :w — viewers may compile by hand too (useCompile refuses what needs edit rights) */
function compile(): void {
  useCompile.getState().compile().catch(() => {})
}

async function loadVim(): Promise<Extension> {
  const { vim, Vim, CodeMirror } = await import('@replit/codemirror-vim')
  CodeMirror.commands.undo = cm => {
    yUndo(cm.cm6)
  }
  CodeMirror.commands.redo = cm => {
    yRedo(cm.cm6)
  }
  Vim.defineEx('write', 'w', () => compile())
  Vim.defineEx('undo', 'u', cm => {
    yUndo(cm.cm6 as EditorView)
  })
  Vim.defineEx('redo', 'red', cm => {
    yRedo(cm.cm6 as EditorView)
  })
  return vim({ status: true })
}

/** The extension when already loaded, else null (call loadKeybindings). */
export function keybindingsNow(mode: KeybindingMode): Extension | null {
  return loaded[mode] ?? null
}

export function loadKeybindings(mode: KeybindingMode): Promise<Extension> {
  const have = loaded[mode]
  if (have) return Promise.resolve(have)
  loading[mode] ??= loadVim().then(ext => {
    loaded[mode] = ext
    return ext
  }).catch(err => {
    delete loading[mode]
    throw err
  })
  return loading[mode]!
}

/** Vim mode changes are natural undo boundaries (one `u` should not undo several inserts). */
export async function onVimModeChange(view: EditorView, fn: () => void): Promise<() => void> {
  const { getCM } = await import('@replit/codemirror-vim')
  const cm = getCM(view)
  if (!cm) return () => {}
  cm.on('vim-mode-change', fn)
  return () => cm.off('vim-mode-change', fn)
}
