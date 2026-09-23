/**
 * Builds the CodeMirror editor for one collaborative document and keeps its configuration in
 * sync with the user settings. Plain CodeMirror 6 (no basicSetup, no history()): undo/redo is
 * the session's Y.UndoManager through yCollab. Everything a setting can change lives in a
 * Compartment and is reconfigured in place (no view rebuild).
 */
import { Compartment, EditorState, Prec, StateEffect, StateField, type Extension } from '@codemirror/state'
import {
  Decoration, EditorView, crosshairCursor, drawSelection, dropCursor, highlightActiveLine, highlightActiveLineGutter,
  highlightSpecialChars, keymap, lineNumbers, rectangularSelection, tooltips, type DecorationSet, type ViewUpdate,
} from '@codemirror/view'
import { defaultKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, foldKeymap, foldedRanges, indentOnInput, indentUnit, unfoldEffect } from '@codemirror/language'
import { highlightSelectionMatches, searchKeymap } from '@codemirror/search'
import { closeBrackets, closeBracketsKeymap, pickedCompletion } from '@codemirror/autocomplete'
import { lintGutter, lintKeymap } from '@codemirror/lint'
import { yCollab, ySyncAnnotation, yUndoManagerKeymap } from 'y-codemirror.next'
import type { UserSettings } from '@folio/shared/api'
import { extname } from '@folio/shared/paths'
import { MAX_DOC_LENGTH } from '@folio/shared/protocol'
import type { DocSession } from '../../../realtime/docs'
import { latexLanguage } from '../lang/latex'
import { bibtexLanguage } from '../lang/bibtex'
import { completionExtension, docKindFacet, type DocKind } from './completion'
import { escapedBrackets } from './autoClose'
import { holdRemoteWhileComposing } from './composition'
import { bibtexFolding, foldingUI, latexFolding } from './folding'
import { folioKeymap } from './editing'
import { keybindingsNow, loadKeybindings, onVimModeChange, type KeybindingMode } from './keybindings'
import { mathPreview, preloadMathPreview } from './mathPreview'
import { remoteCaretLabels } from './remoteCarets'
import { searchExtension } from './searchPanel'
import { fontExtension, paletteFor, themeExtension, type EditorPalette } from './theme'

export interface EditorConfig {
  settings: UserSettings
  uiTheme: 'light' | 'dark'
  /** project spell-check language, e.g. 'en' */
  spellLang: string
  path: string
  readOnly: boolean
}

export interface EditorCallbacks {
  /** any document change (local or remote) */
  onDocChange?(update: ViewUpdate): void
  /** selection / focus changes and document changes */
  onCursor?(view: EditorView): void
  /** a local change was refused because the document would exceed MAX_DOC_LENGTH */
  onRejectedChange?(): void
}

const LATEX_EXTS = new Set(['tex', 'ltx', 'latex', 'sty', 'cls', 'tikz', 'pgf', 'def', 'clo', 'dtx', 'ins', 'bbl', 'cfg', 'fd', 'ldf', 'rnw', 'rtex', 'mtx'])

export function docKindFor(path: string): DocKind {
  const ext = extname(path)
  if (LATEX_EXTS.has(ext)) return 'latex'
  if (ext === 'bib' || ext === 'bibtex') return 'bibtex'
  return 'text'
}

function languageExtension(path: string): Extension {
  const kind = docKindFor(path)
  if (kind === 'latex') return [latexLanguage, latexFolding(), docKindFacet.of('latex')]
  if (kind === 'bibtex') return [bibtexLanguage, bibtexFolding(), docKindFacet.of('bibtex')]
  return docKindFacet.of('text')
}

/** Guess the indentation unit from the text (tabs, or the smallest common space indent). */
export function detectIndentUnit(text: string): string {
  const counts = new Map<number, number>()
  let tabs = 0
  let spaced = 0
  const lines = text.split('\n', 4000)
  for (const line of lines) {
    const m = /^([ \t]+)\S/.exec(line)
    if (!m) continue
    if (m[1][0] === '\t') {
      tabs++
      continue
    }
    spaced++
    const w = m[1].length
    if (w <= 8) counts.set(w, (counts.get(w) ?? 0) + 1)
  }
  if (tabs > spaced) return '\t'
  for (const w of [2, 3, 4]) {
    if ((counts.get(w) ?? 0) >= 3) return ' '.repeat(w)
  }
  return '    '
}

// -- jump highlight ------------------------------------------------------------------------------

const flashEffect = StateEffect.define<number | null>()
const flashTokens = new WeakMap<EditorView, number>()
const flashDeco = Decoration.line({ class: 'ed-flash-line' })

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes)
    for (const e of tr.effects) {
      if (e.is(flashEffect)) deco = e.value === null ? Decoration.none : Decoration.set([flashDeco.range(e.value)])
    }
    return deco
  },
  provide: f => EditorView.decorations.from(f),
})

/** Move the cursor to a 1-based line (optional 0-based column), centre it and flash the line. */
export function revealLine(view: EditorView, lineNo: number, column?: number): void {
  const doc = view.state.doc
  const line = doc.line(Math.min(Math.max(1, lineNo), doc.lines))
  const pos = column !== undefined ? Math.min(line.from + column, line.to) : line.from
  const effects: StateEffect<unknown>[] = []
  foldedRanges(view.state).between(pos, pos, (from, to) => {
    effects.push(unfoldEffect.of({ from, to }))
  })
  effects.push(EditorView.scrollIntoView(pos, { y: 'center' }), flashEffect.of(line.from))
  view.dispatch({ selection: { anchor: pos }, effects, userEvent: 'select' })
  const token = (flashTokens.get(view) ?? 0) + 1
  flashTokens.set(view, token)
  setTimeout(() => {
    // only clear our own flash (a newer jump may have replaced it)
    if (flashTokens.get(view) !== token || !view.dom.isConnected) return
    view.dispatch({ effects: flashEffect.of(null) })
  }, 1800)
}

// -- document size -------------------------------------------------------------------------------

/**
 * Refuse local changes that would make the document longer than the server accepts
 * (MAX_DOC_LENGTH). The server would close the session (4413) and drop the change anyway; this
 * way the editor stays usable and says why. Remote changes (y-codemirror's sync) always pass.
 */
function documentSizeLimit(onReject: () => void): Extension {
  return EditorState.transactionFilter.of(tr => {
    if (!tr.docChanged || tr.newDoc.length <= MAX_DOC_LENGTH || tr.newDoc.length <= tr.startState.doc.length) return tr
    if (tr.annotation(ySyncAnnotation) !== undefined) return tr
    queueMicrotask(onReject)
    return []
  })
}

// -- keymaps -------------------------------------------------------------------------------------

const baseKeymap = [
  ...yUndoManagerKeymap,
  ...defaultKeymap.filter(b => b.key !== 'Mod-Enter'),
  ...searchKeymap.filter(b => b.key !== 'Mod-Shift-l' && b.key !== 'Mod-f'),
  ...foldKeymap,
  ...lintKeymap,
  indentWithTab,
]

const PHRASES = { 'Go to line': 'Go to line', go: 'Go', close: 'Close' }

function bracketsExtension(on: boolean): Extension {
  return on ? [escapedBrackets, closeBrackets(), keymap.of(closeBracketsKeymap)] : []
}

function spellExtension(on: boolean, lang: string): Extension {
  return EditorView.contentAttributes.of(
    on
      ? { spellcheck: 'true', lang: lang || 'en', autocorrect: 'off', autocapitalize: 'off' }
      : { spellcheck: 'false', autocorrect: 'off', autocapitalize: 'off' },
  )
}

function readOnlyExtension(ro: boolean): Extension {
  return [
    EditorState.readOnly.of(ro),
    EditorView.editable.of(!ro),
    // keep the text focusable for viewers (cursor keys, selection, find)
    ro ? EditorView.contentAttributes.of({ tabindex: '0' }) : [],
  ]
}

export class EditorController {
  readonly view: EditorView
  private cfg: EditorConfig
  private palette: EditorPalette
  private readonly comp = {
    keymap: new Compartment(),
    theme: new Compartment(),
    font: new Compartment(),
    wrap: new Compartment(),
    spell: new Compartment(),
    completion: new Compartment(),
    brackets: new Compartment(),
    language: new Compartment(),
    readOnly: new Compartment(),
    mathPreview: new Compartment(),
  }
  private destroyed = false
  private keymapRequest = 0
  private vimOff: (() => void) | null = null
  private readonly session: DocSession

  constructor(parent: HTMLElement, session: DocSession, cfg: EditorConfig, callbacks: EditorCallbacks = {}) {
    this.session = session
    this.cfg = cfg
    this.palette = paletteFor(cfg.settings.editorTheme, cfg.uiTheme)
    const text = session.ytext.toString()
    const s = cfg.settings
    const undoManager = session.undoManager
    const listener = EditorView.updateListener.of(update => {
      if (update.docChanged) callbacks.onDocChange?.(update)
      if (update.docChanged || update.selectionSet || update.focusChanged) callbacks.onCursor?.(update.view)
      // natural undo boundaries: cursor jumps and accepted completions
      for (const tr of update.transactions) {
        if ((tr.isUserEvent('select') && !tr.docChanged) || tr.annotation(pickedCompletion)) {
          undoManager.stopCapturing()
          break
        }
      }
    })
    const state = EditorState.create({
      doc: text,
      extensions: [
        this.comp.keymap.of(keybindingsNow(s.keybindings) ?? []),
        keymap.of(folioKeymap),
        lintGutter({ hoverTime: 120 }),
        lineNumbers(),
        highlightActiveLineGutter(),
        foldingUI(),
        highlightSpecialChars(),
        drawSelection(),
        dropCursor(),
        EditorState.allowMultipleSelections.of(true),
        indentOnInput(),
        indentUnit.of(detectIndentUnit(text)),
        bracketMatching(),
        this.comp.brackets.of(bracketsExtension(s.autoCloseBrackets)),
        this.comp.completion.of(completionExtension(s.autoComplete)),
        rectangularSelection(),
        crosshairCursor(),
        highlightActiveLine(),
        highlightSelectionMatches({ minSelectionLength: 2 }),
        searchExtension(),
        keymap.of(baseKeymap),
        this.comp.language.of(languageExtension(cfg.path)),
        documentSizeLimit(() => callbacks.onRejectedChange?.()),
        yCollab(session.ytext, session.awareness, { undoManager }),
        holdRemoteWhileComposing(session.provider),
        remoteCaretLabels,
        this.comp.wrap.of(s.lineWrapping ? EditorView.lineWrapping : []),
        this.comp.spell.of(spellExtension(s.spellCheck, cfg.spellLang)),
        this.comp.theme.of(themeExtension(this.palette)),
        this.comp.font.of(fontExtension(s)),
        this.comp.mathPreview.of(s.equationPreview ? mathPreview() : []),
        this.comp.readOnly.of(readOnlyExtension(cfg.readOnly)),
        flashField,
        EditorView.contentAttributes.of({ 'aria-label': `Source editor: ${cfg.path}` }),
        // tooltips stay within the text area vertically (never over the toolbar), full width horizontally
        tooltips({
          tooltipSpace: view => {
            const r = view.scrollDOM.getBoundingClientRect()
            return { top: r.top, bottom: r.bottom, left: 0, right: window.innerWidth }
          },
        }),
        EditorState.phrases.of(PHRASES),
        Prec.low(listener),
      ],
    })
    this.view = new EditorView({ state, parent })
    if (s.equationPreview) preloadMathPreview()
    if (!keybindingsNow(s.keybindings)) this.applyKeybindings(s.keybindings)
    else if (s.keybindings === 'vim') this.watchVim()
  }

  /** Apply changed settings / theme / path / read-only state in place. */
  update(next: EditorConfig): void {
    if (this.destroyed) return
    const prev = this.cfg
    this.cfg = next
    const a = prev.settings
    const b = next.settings
    const effects: StateEffect<unknown>[] = []
    const palette = paletteFor(b.editorTheme, next.uiTheme)
    if (palette !== this.palette) {
      this.palette = palette
      effects.push(this.comp.theme.reconfigure(themeExtension(palette)))
    }
    if (a.fontSize !== b.fontSize || a.fontFamily !== b.fontFamily || a.lineHeight !== b.lineHeight) {
      effects.push(this.comp.font.reconfigure(fontExtension(b)))
    }
    if (a.lineWrapping !== b.lineWrapping) effects.push(this.comp.wrap.reconfigure(b.lineWrapping ? EditorView.lineWrapping : []))
    if (a.spellCheck !== b.spellCheck || prev.spellLang !== next.spellLang) {
      effects.push(this.comp.spell.reconfigure(spellExtension(b.spellCheck, next.spellLang)))
    }
    if (a.autoComplete !== b.autoComplete) effects.push(this.comp.completion.reconfigure(completionExtension(b.autoComplete)))
    if (a.autoCloseBrackets !== b.autoCloseBrackets) effects.push(this.comp.brackets.reconfigure(bracketsExtension(b.autoCloseBrackets)))
    if (a.equationPreview !== b.equationPreview) {
      effects.push(this.comp.mathPreview.reconfigure(b.equationPreview ? mathPreview() : []))
      if (b.equationPreview) preloadMathPreview()
    }
    if (docKindFor(prev.path) !== docKindFor(next.path)) effects.push(this.comp.language.reconfigure(languageExtension(next.path)))
    if (prev.readOnly !== next.readOnly) effects.push(this.comp.readOnly.reconfigure(readOnlyExtension(next.readOnly)))
    if (effects.length) this.view.dispatch({ effects })
    if (a.keybindings !== b.keybindings) this.applyKeybindings(b.keybindings)
  }

  private applyKeybindings(mode: KeybindingMode): void {
    const req = ++this.keymapRequest
    this.vimOff?.()
    this.vimOff = null
    const now = keybindingsNow(mode)
    if (now) {
      this.view.dispatch({ effects: this.comp.keymap.reconfigure(now) })
      if (mode === 'vim') this.watchVim()
      return
    }
    loadKeybindings(mode)
      .then(ext => {
        if (this.destroyed || req !== this.keymapRequest) return
        this.view.dispatch({ effects: this.comp.keymap.reconfigure(ext) })
        if (mode === 'vim') this.watchVim()
      })
      .catch(err => console.error(`[editor] could not load ${mode} keybindings`, err))
  }

  private watchVim(): void {
    const req = this.keymapRequest
    void onVimModeChange(this.view, () => this.session.undoManager.stopCapturing()).then(off => {
      if (this.destroyed || req !== this.keymapRequest) off()
      else this.vimOff = off
    })
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.vimOff?.()
    this.vimOff = null
    this.view.destroy()
  }
}
