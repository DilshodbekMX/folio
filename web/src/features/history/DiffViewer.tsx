/**
 * Read-only unified diff (@codemirror/merge unifiedMergeView): stex highlighting for TeX-like
 * files, unchanged stretches collapsed, change gutter, light/dark following the UI theme and
 * the user's editor font. Exposes chunk navigation through `DiffHandle`. The diff itself is
 * line-first (./lineDiff): the library's default gives up on large files and shows scattered
 * edits as one change covering most of the file (PERF-1). When one person made the changes
 * shown (`author`), the change gutter takes their colour and changed lines say "Changed by X ·
 * <time>" on hover (J-8); green/red backgrounds keep telling added from removed text.
 */
import { useEffect, useImperativeHandle, useRef, type Ref } from 'react'
import { EditorState, RangeSetBuilder, type Extension } from '@codemirror/state'
import { Decoration, EditorView, ViewPlugin, lineNumbers, highlightSpecialChars, drawSelection, type DecorationSet } from '@codemirror/view'
import { StreamLanguage, syntaxHighlighting, defaultHighlightStyle, HighlightStyle } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { getChunks, goToNextChunk, goToPreviousChunk, unifiedMergeView } from '@codemirror/merge'
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark'
import { tags as t } from '@lezer/highlight'
import { extname } from '@folio/shared/paths'
import { useResolvedTheme, useSettings } from '../../stores/auth'
import { HISTORY_DIFF_CONFIG } from './lineDiff'

export interface DiffStats {
  chunks: number
  added: number
  removed: number
}

export interface DiffHandle {
  next(): void
  prev(): void
}

/** The one person behind the changes shown (colour of their cursor/avatar). */
export interface DiffAuthor {
  name: string
  color: string
  /** when, as shown to the user ("22 Sep 2026, 14:05") */
  when: string
}

const TEX_EXT = new Set(['tex', 'latex', 'ltx', 'sty', 'cls', 'bbl', 'tikz', 'pgf', 'def', 'clo', 'dtx', 'ins', 'rtex', 'bib', 'bst', 'cfg', 'fd', 'ldf', 'lbx', 'bbx', 'cbx'])

const texLanguage = StreamLanguage.define(stex)

/** Light highlighting tuned to the Folio palette (default style for everything else). */
const folioLight = HighlightStyle.define([
  { tag: t.keyword, color: '#1f6f8b' },
  { tag: [t.tagName, t.typeName], color: '#1f7a4d', fontWeight: '600' },
  { tag: t.comment, color: '#7f8a84', fontStyle: 'italic' },
  { tag: [t.string, t.special(t.string)], color: '#9a5b13' },
  { tag: [t.bracket, t.brace, t.squareBracket], color: '#6b4fa8' },
  { tag: t.atom, color: '#b3261e' },
  { tag: t.number, color: '#9a5b13' },
])

const LINE_HEIGHT = { compact: 1.35, normal: 1.55, wide: 1.8 } as const

function baseTheme(dark: boolean, fontSize: number, fontFamily: string, lineHeight: number): Extension {
  return EditorView.theme(
    {
      '&': {
        height: '100%',
        fontSize: `${fontSize}px`,
        backgroundColor: 'var(--bg)',
        color: 'var(--fg)',
      },
      '.cm-scroller': {
        fontFamily: `var(--font-editor-${fontFamily}, var(--font-mono))`,
        lineHeight: String(lineHeight),
        overflow: 'auto',
      },
      '.cm-content': { padding: '8px 0 48px', caretColor: 'transparent' },
      '.cm-gutters': {
        backgroundColor: 'var(--bg-subtle)',
        color: 'var(--fg-subtle)',
        borderRight: '1px solid var(--border)',
      },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 12px', minWidth: '44px' },
      '&.cm-focused': { outline: 'none' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
      '.cm-collapsedLines': {
        background: 'var(--bg-subtle)',
        color: 'var(--fg-muted)',
        borderTop: '1px solid var(--border)',
        borderBottom: '1px solid var(--border)',
        fontFamily: 'var(--font-ui)',
        fontSize: '12px',
        padding: '3px 12px',
        cursor: 'pointer',
      },
      '.cm-collapsedLines:hover': { background: 'var(--bg-hover)', color: 'var(--fg)' },
      // the default ⦚ glyphs are missing from many UI fonts
      '.cm-collapsedLines:before': { content: '"⋯"', marginInlineEnd: '8px', fontWeight: '700' },
      '.cm-collapsedLines:after': { content: 'none' },
      '&.cm-merge-b .cm-changedLine, .cm-inlineChangedLine': {
        backgroundColor: dark ? 'rgba(70, 180, 125, 0.13)' : 'rgba(31, 122, 77, 0.09)',
      },
      '&.cm-merge-b .cm-changedText': {
        background: dark ? 'rgba(70, 180, 125, 0.34)' : 'rgba(31, 122, 77, 0.24)',
        borderRadius: '2px',
      },
      '.cm-deletedChunk': {
        backgroundColor: dark ? 'rgba(239, 106, 96, 0.13)' : 'rgba(196, 49, 43, 0.07)',
        paddingLeft: '6px',
      },
      '.cm-deletedChunk .cm-deletedText': {
        background: dark ? 'rgba(239, 106, 96, 0.34)' : 'rgba(196, 49, 43, 0.2)',
        borderRadius: '2px',
      },
      '.cm-deletedLine, .cm-deletedLine del': { textDecoration: 'none' },
      '&.hist-whole--added .cm-line': { backgroundColor: dark ? 'rgba(70, 180, 125, 0.13)' : 'rgba(31, 122, 77, 0.08)' },
      '&.hist-whole--deleted .cm-line': { backgroundColor: dark ? 'rgba(239, 106, 96, 0.13)' : 'rgba(196, 49, 43, 0.07)' },
      '&.hist-whole--added .cm-gutters': { boxShadow: 'inset -3px 0 0 var(--success)' },
      '&.hist-whole--deleted .cm-gutters': { boxShadow: 'inset -3px 0 0 var(--danger)' },
      '.cm-changeGutter': { width: '4px', paddingLeft: '0' },
      '&.cm-merge-b .cm-changedLineGutter': { background: 'var(--success)' },
      '.cm-deletedLineGutter': { background: 'var(--danger)' },
      // one author: their colour marks every change (the backgrounds stay green/red)
      '&.hist-by-author .cm-changeGutter': { width: '5px' },
      '&.hist-by-author.cm-merge-b .cm-changedLineGutter, &.hist-by-author .cm-deletedLineGutter': { background: 'var(--hist-author)' },
      '&.hist-by-author .cm-deletedChunk': { boxShadow: 'inset 3px 0 0 var(--hist-author)' },
    },
    { dark },
  )
}

/** "Changed by X · <time>" on the changed lines and removed blocks of the diff. */
function authorTitles(title: string): Extension {
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet
    constructor(readonly view: EditorView) {
      const builder = new RangeSetBuilder<Decoration>()
      const deco = Decoration.line({ attributes: { title } })
      const doc = view.state.doc
      let done = 0
      for (const c of getChunks(view.state)?.chunks ?? []) {
        if (c.toB <= c.fromB) continue // removed text only: a block widget, titled below
        const first = Math.max(done + 1, doc.lineAt(Math.min(c.fromB, doc.length)).number)
        const last = doc.lineAt(Math.min(Math.max(c.fromB, c.endB), doc.length)).number
        for (let n = first; n <= last; n++) builder.add(doc.line(n).from, doc.line(n).from, deco)
        done = Math.max(done, last)
      }
      this.decorations = builder.finish()
      this.label()
    }
    update(): void {
      this.label()
    }
    /** removed text is drawn by the merge extension as block widgets: title them after rendering */
    label(): void {
      this.view.requestMeasure({
        key: this,
        read: () => null,
        write: () => {
          for (const el of this.view.dom.querySelectorAll<HTMLElement>('.cm-deletedChunk:not([title])')) el.title = title
        },
      })
    }
  }, { decorations: v => v.decorations })
}

export function DiffViewer({ path, oldText, newText, collapse, author, onStats, ref }: {
  path: string
  /** null → the file did not exist on the old side */
  oldText: string | null
  /** null → the file does not exist on the new side */
  newText: string | null
  /** collapse unchanged stretches (off when showing an unchanged file) */
  collapse: boolean
  /** the one person behind these changes, when known */
  author?: DiffAuthor | null
  onStats?: (s: DiffStats) => void
  ref?: Ref<DiffHandle>
}) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const viewRef = useRef<EditorView | null>(null)
  const theme = useResolvedTheme()
  const settings = useSettings()
  const onStatsRef = useRef(onStats)
  onStatsRef.current = onStats

  useImperativeHandle(ref, () => ({
    next: () => {
      const v = viewRef.current
      if (v) goToNextChunk(v)
    },
    prev: () => {
      const v = viewRef.current
      if (v) goToPreviousChunk(v)
    },
  }), [])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const dark = theme === 'dark'
    const lang = TEX_EXT.has(extname(path)) ? [texLanguage] : []
    // whole-file additions/deletions are shown as the file itself, tinted, rather than a diff
    // against an empty document (which would show a phantom empty line)
    const mode: 'added' | 'deleted' | 'diff' | 'plain' =
      oldText === null && newText !== null ? 'added'
        : newText === null && oldText !== null ? 'deleted'
          : (newText ?? '') === (oldText ?? '') ? 'plain' : 'diff'
    const doc = mode === 'deleted' ? oldText ?? '' : newText ?? ''
    const original = oldText ?? ''
    const extensions: Extension[] = [
      lineNumbers(),
      highlightSpecialChars(),
      drawSelection(),
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.contentAttributes.of({ 'aria-label': `${mode === 'added' ? 'New file' : mode === 'deleted' ? 'Deleted file' : 'Changes in'} ${path}`, tabindex: '0' }),
      settings.lineWrapping ? EditorView.lineWrapping : [],
      ...lang,
      syntaxHighlighting(dark ? oneDarkHighlightStyle : folioLight),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      baseTheme(dark, settings.fontSize, settings.fontFamily, LINE_HEIGHT[settings.lineHeight] ?? 1.55),
    ]
    if (mode === 'added' || mode === 'deleted') extensions.push(EditorView.editorAttributes.of({ class: `hist-whole hist-whole--${mode}` }))
    if (mode === 'diff') {
      extensions.push(unifiedMergeView({
        original,
        mergeControls: false,
        highlightChanges: true,
        gutter: true,
        syntaxHighlightDeletions: true,
        allowInlineDiffs: false,
        collapseUnchanged: collapse ? { margin: 3, minSize: 6 } : undefined,
        diffConfig: HISTORY_DIFF_CONFIG,
      }))
      if (author) {
        extensions.push(
          EditorView.editorAttributes.of({ class: 'hist-by-author', style: `--hist-author: ${author.color}` }),
          authorTitles(`Changed by ${author.name} · ${author.when}`),
        )
      }
    }
    const state = EditorState.create({ doc, extensions })
    let view = viewRef.current
    if (!view) {
      view = new EditorView({ state, parent: host })
      viewRef.current = view
    } else {
      view.setState(state)
    }

    // stats + scroll to the first change
    const chunks = mode === 'diff' ? getChunks(view.state)?.chunks ?? [] : []
    let added = mode === 'added' ? countDocLines(doc) : 0
    let removed = mode === 'deleted' ? countDocLines(doc) : 0
    for (const c of chunks) {
      if (c.toB > c.fromB) added += view.state.doc.lineAt(Math.max(c.fromB, c.toB - 1)).number - view.state.doc.lineAt(c.fromB).number + 1
      if (c.toA > c.fromA) removed += countLines(original, c.fromA, c.toA)
    }
    onStatsRef.current?.({ chunks: mode === 'added' || mode === 'deleted' ? 1 : chunks.length, added, removed })
    const first = chunks[0]
    const v = view
    requestAnimationFrame(() => {
      if (viewRef.current !== v) return
      if (first) {
        const pos = Math.min(first.fromB, v.state.doc.length)
        v.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 48 }) })
      } else {
        v.scrollDOM.scrollTop = 0
      }
    })
  }, [path, oldText, newText, collapse, author?.name, author?.color, author?.when, theme, settings.fontSize, settings.fontFamily, settings.lineHeight, settings.lineWrapping])

  useEffect(() => () => {
    viewRef.current?.destroy()
    viewRef.current = null
  }, [])

  return <div ref={hostRef} className="hist-diff__cm" />
}

/** Lines of a whole file, not counting the empty line after a final newline. */
function countDocLines(text: string): number {
  if (!text) return 0
  let n = 1
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) n++
  return text.endsWith('\n') ? n - 1 : n
}

function countLines(text: string, from: number, to: number): number {
  let n = 1
  const end = Math.min(to, text.length)
  for (let i = from; i < end; i++) if (text.charCodeAt(i) === 10) n++
  // a chunk ending right after a newline does not include the next line
  if (end > from && text.charCodeAt(end - 1) === 10) n--
  return Math.max(1, n)
}
