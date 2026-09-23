/**
 * Editor themes. The Folio light/dark themes are one EditorView theme + one HighlightStyle
 * whose colours are CSS variables (`--ed-*`, defined per palette in editor.css on the editor
 * host via `data-ed-theme`), so switching palette is a variable swap. "One Dark" uses
 * @codemirror/theme-one-dark for the text area with a matching chrome palette.
 */
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { oneDark } from '@codemirror/theme-one-dark'
import { tags as t } from '@lezer/highlight'
import type { UserSettings } from '@folio/shared/api'

export type EditorPalette = 'light' | 'dark' | 'one-dark'

export function paletteFor(editorTheme: UserSettings['editorTheme'], uiTheme: 'light' | 'dark'): EditorPalette {
  if (editorTheme === 'one-dark') return 'one-dark'
  if (editorTheme === 'light') return 'light'
  return uiTheme
}

const v = (name: string) => `var(--ed-${name})`

/** Chrome shared by every palette (panels, tooltips, completion, lint, remote cursors). */
const chrome = {
  '&': { height: '100%' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflowX: 'auto' },
  '.cm-content': { padding: '8px 0 30vh' },
  '.cm-line': { padding: '0 14px 0 6px' },
  '.cm-gutter.cm-lineNumbers .cm-gutterElement': { padding: '0 4px 0 6px', minWidth: '28px' },
  '.cm-foldGutter .cm-gutterElement': { padding: '0 2px', cursor: 'pointer' },
  '.cm-lint-marker': { width: '0.95em', height: '0.95em' },
  '.cm-gutter-lint': { width: '14px' },
  '.cm-gutter-lint .cm-gutterElement': { padding: '0 0 0 3px', display: 'flex', alignItems: 'flex-start' },
  '.cm-gutter-lint .cm-gutterElement .cm-lint-marker': { marginTop: '0.3em' },
  '.cm-panels': { backgroundColor: v('panel-bg'), color: v('fg') },
  '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${v('border')}` },
  '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${v('border')}` },
  '.cm-tooltip': {
    backgroundColor: v('tooltip-bg'),
    color: v('fg'),
    border: `1px solid ${v('border')}`,
    borderRadius: '6px',
    boxShadow: v('shadow'),
    fontFamily: 'var(--font-ui)',
    fontSize: '12.5px',
  },
  '.cm-tooltip .cm-tooltip-arrow:before': { borderTopColor: v('border'), borderBottomColor: v('border') },
  '.cm-tooltip .cm-tooltip-arrow:after': { borderTopColor: v('tooltip-bg'), borderBottomColor: v('tooltip-bg') },
  '.cm-tooltip.cm-tooltip-autocomplete': { padding: '3px' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li:first-child': { marginTop: '0' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul': {
    fontFamily: 'inherit',
    maxHeight: '18.5em',
    minWidth: '240px',
    maxWidth: 'min(560px, 80vw)',
  },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    padding: '2px 8px 2px 4px',
    borderRadius: '4px',
    lineHeight: '1.55',
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: v('accent-bg'), color: v('fg') },
  '&:not(.cm-focused) .cm-tooltip-autocomplete ul li[aria-selected]': { backgroundColor: v('hover') },
  '.cm-completionLabel': { fontFamily: v('font'), fontSize: '12.5px', whiteSpace: 'nowrap' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '700', color: v('accent') },
  '.cm-completionDetail': {
    marginLeft: 'auto',
    paddingLeft: '14px',
    fontStyle: 'normal',
    color: v('muted'),
    fontFamily: v('font'),
    fontSize: '11.5px',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    maxWidth: '220px',
  },
  '.cm-completionIcon': {
    width: '1.35em',
    height: '1.35em',
    flex: 'none',
    display: 'inline-grid',
    placeItems: 'center',
    padding: '0',
    marginRight: '2px',
    borderRadius: '4px',
    fontSize: '10.5px',
    fontWeight: '700',
    fontFamily: 'var(--font-mono)',
    opacity: '1',
    boxSizing: 'border-box',
  },
  '.cm-completionIcon:after': { content: '"•"' },
  '.cm-completionIcon-cmd': { color: v('tok-cmd'), backgroundColor: v('icon-bg') },
  '.cm-completionIcon-cmd:after': { content: '"\\\\"' },
  '.cm-completionIcon-user': { color: v('accent'), backgroundColor: v('icon-bg') },
  '.cm-completionIcon-user:after': { content: '"\\\\"' },
  '.cm-completionIcon-math': { color: v('tok-math'), backgroundColor: v('icon-bg') },
  '.cm-completionIcon-math:after': { content: '"∑"' },
  '.cm-completionIcon-env': { color: v('tok-env'), backgroundColor: v('icon-bg') },
  '.cm-completionIcon-env:after': { content: '"{}"' },
  '.cm-completionIcon-label': { color: v('tok-label'), backgroundColor: v('icon-bg') },
  '.cm-completionIcon-label:after': { content: '"#"' },
  '.cm-completionIcon-cite': { color: v('tok-string'), backgroundColor: v('icon-bg') },
  '.cm-completionIcon-cite:after': { content: '"“"' },
  '.cm-completionIcon-file': { color: v('muted'), backgroundColor: v('icon-bg') },
  '.cm-completionIcon-file:after': { content: '"▤"' },
  '.cm-completionIcon-image': { color: v('muted'), backgroundColor: v('icon-bg') },
  '.cm-completionIcon-image:after': { content: '"▣"' },
  '.cm-completionIcon-package': { color: v('tok-package'), backgroundColor: v('icon-bg') },
  '.cm-completionIcon-package:after': { content: '"◆"' },
  '.cm-completionIcon-keyword:after': { content: '"@"' },
  '.cm-completionIcon-property:after': { content: '"="' },
  '.cm-completionInfo': {
    padding: '8px 10px',
    maxWidth: '360px',
    lineHeight: '1.45',
    fontFamily: 'var(--font-ui)',
    fontSize: '12.5px',
    whiteSpace: 'pre-wrap',
  },
  '.cm-completionInfo.cm-completionInfo-right': { marginLeft: '4px' },
  '.cm-completionInfo.cm-completionInfo-left': { marginRight: '4px' },
  '.cm-tooltip-lint': { padding: '0' },
  '.cm-diagnostic': { padding: '6px 10px', borderLeftWidth: '3px', fontFamily: 'var(--font-ui)', whiteSpace: 'normal' },
  '.cm-diagnostic-error': { borderLeftColor: v('error') },
  '.cm-diagnostic-warning': { borderLeftColor: v('warning') },
  '.cm-diagnostic-info': { borderLeftColor: v('info') },
  '.cm-lintRange-error': { backgroundImage: 'none', textDecoration: `underline wavy ${v('error')}`, textUnderlineOffset: '3px', textDecorationSkipInk: 'none' },
  '.cm-lintRange-warning': { backgroundImage: 'none', textDecoration: `underline wavy ${v('warning')}`, textUnderlineOffset: '3px', textDecorationSkipInk: 'none' },
  '.cm-lintRange-info': { backgroundImage: 'none' },
  '.cm-lintRange-active': { backgroundColor: v('lint-active') },
  '.cm-lintRange.ed-lint-quiet': { backgroundImage: 'none', textDecoration: 'none' },
  '.cm-foldPlaceholder': {
    backgroundColor: v('fold-bg'),
    border: `1px solid ${v('border')}`,
    color: v('muted'),
    borderRadius: '4px',
    padding: '0 5px',
    margin: '0 3px',
    cursor: 'pointer',
  },
  // collaborator name labels: shown for a moment after the caret moves (ed-ycaret-active,
  // remoteCarets.ts) and while the pointer is over the caret, then they fade out (J-5); they
  // never take clicks meant for the text under them
  '.cm-ySelectionInfo': {
    opacity: '0',
    pointerEvents: 'none',
    transition: 'opacity .4s ease-in-out',
    top: '-1.35em',
    padding: '1px 5px 2px',
    borderRadius: '4px 4px 4px 0',
    fontFamily: 'var(--font-ui)',
    fontSize: '10.5px',
    fontWeight: '600',
    lineHeight: '1.2',
    letterSpacing: '0.01em',
    boxShadow: '0 1px 2px rgba(0,0,0,.18)',
  },
  '.cm-ySelectionCaret.ed-ycaret-active > .cm-ySelectionInfo, .cm-ySelectionCaret:hover > .cm-ySelectionInfo': {
    opacity: '1',
    transitionDuration: '0s',
  },
  // near the top of the document the label goes under the caret (remoteCarets.ts), else it is
  // cut off under the editor toolbar
  '.cm-ySelectionCaret.ed-ycaret-below > .cm-ySelectionInfo': { top: 'calc(100% + 1px)', borderRadius: '0 4px 4px 4px' },
  '.cm-ySelectionCaret': { borderLeftWidth: '2px', borderRightWidth: '0', marginLeft: '-1px', marginRight: '-1px' },
  // a slightly wider hover target than the 2px caret line
  '.cm-ySelectionCaret::before': { content: '""', position: 'absolute', top: '0', bottom: '0', left: '-3px', right: '-3px' },
  '.cm-ySelectionCaretDot': { display: 'none' },
  '.cm-dialog': { padding: '6px 34px 6px 10px', fontFamily: 'var(--font-ui)', fontSize: '12.5px' },
  '.cm-dialog label': { color: v('muted') },
  '.cm-textfield': {
    height: '26px',
    margin: '0 6px 0 0',
    padding: '0 8px',
    border: `1px solid ${v('input-border')}`,
    borderRadius: '5px',
    backgroundColor: v('input-bg'),
    color: v('fg'),
    fontFamily: v('font'),
    fontSize: '12.5px',
    verticalAlign: 'middle',
    outline: 'none',
  },
  '.cm-textfield:focus': { borderColor: v('accent'), boxShadow: `0 0 0 3px ${v('ring')}` },
  '.cm-button': {
    height: '26px',
    margin: '0',
    padding: '0 12px',
    border: `1px solid ${v('accent')}`,
    borderRadius: '5px',
    backgroundImage: 'none',
    backgroundColor: v('accent'),
    color: v('accent-fg'),
    fontFamily: 'var(--font-ui)',
    fontSize: '12px',
    fontWeight: '600',
    verticalAlign: 'middle',
    cursor: 'pointer',
  },
  '.cm-button:active': { backgroundImage: 'none', filter: 'brightness(0.95)' },
  '.cm-dialog .cm-dialog-close': {
    top: '50%',
    right: '8px',
    transform: 'translateY(-50%)',
    width: '22px',
    height: '22px',
    borderRadius: '4px',
    color: v('muted'),
    fontSize: '16px',
    lineHeight: '20px',
  },
  '.cm-dialog .cm-dialog-close:hover': { backgroundColor: v('hover'), color: v('fg') },
  '.cm-vim-panel': { padding: '2px 10px', fontFamily: v('font'), fontSize: '12.5px' },
  '.cm-vim-panel input': { color: v('fg'), fontFamily: 'inherit' },
}

/** Text-area colours for the Folio palettes (values from CSS variables). */
const folioArea = {
  '&': { color: v('fg'), backgroundColor: v('bg') },
  '.cm-content': { caretColor: v('cursor') },
  '.cm-cursor, .cm-dropCursor': { borderLeftColor: v('cursor'), borderLeftWidth: '2px' },
  '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: v('selection'),
  },
  '&:not(.cm-focused) > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': { backgroundColor: v('selection-blur') },
  '.cm-activeLine': { backgroundColor: v('active-line') },
  '.cm-gutters': { backgroundColor: v('gutter-bg'), color: v('gutter-fg'), borderRight: `1px solid ${v('gutter-border')}` },
  '.cm-activeLineGutter': { backgroundColor: v('active-line-gutter'), color: v('gutter-active-fg') },
  '.cm-searchMatch': { backgroundColor: v('match'), outline: `1px solid ${v('match-border')}`, borderRadius: '2px' },
  '.cm-searchMatch.cm-searchMatch-selected': { backgroundColor: v('match-selected') },
  '.cm-selectionMatch': { backgroundColor: v('selection-match') },
  '&.cm-focused .cm-matchingBracket': { backgroundColor: v('bracket-match'), outline: `1px solid ${v('bracket-match-border')}` },
  '&.cm-focused .cm-nonmatchingBracket': { backgroundColor: v('bracket-bad') },
  '.cm-specialChar': { color: v('error') },
}

const lightTheme = EditorView.theme({ ...chrome, ...folioArea }, { dark: false })
const darkTheme = EditorView.theme({ ...chrome, ...folioArea }, { dark: true })
const oneDarkChrome = EditorView.theme(chrome, { dark: true })

export const folioHighlightStyle = HighlightStyle.define([
  { tag: t.comment, color: v('tok-comment'), fontStyle: 'italic' },
  { tag: t.macroName, color: v('tok-cmd') },
  { tag: t.keyword, color: v('tok-keyword') },
  { tag: t.className, color: v('tok-env') },
  { tag: t.heading, color: v('tok-heading'), fontWeight: '600' },
  { tag: t.labelName, color: v('tok-label') },
  { tag: t.string, color: v('tok-string') },
  { tag: t.namespace, color: v('tok-package') },
  { tag: t.processingInstruction, color: v('tok-math-delim'), fontWeight: '600' },
  { tag: t.special(t.variableName), color: v('tok-math') },
  { tag: t.special(t.macroName), color: v('tok-math-cmd') },
  { tag: t.special(t.number), color: v('tok-number') },
  { tag: t.special(t.bracket), color: v('tok-math-cmd') },
  { tag: t.number, color: v('tok-number') },
  { tag: t.bracket, color: v('tok-bracket') },
  { tag: t.escape, color: v('tok-escape') },
  { tag: t.operator, color: v('tok-operator'), fontWeight: '600' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.monospace, fontFamily: 'var(--font-mono)' },
  { tag: t.propertyName, color: v('tok-cmd') },
  { tag: t.variableName, color: v('tok-label') },
  { tag: t.separator, color: v('tok-bracket') },
])

/** The colour theme + syntax highlighting of a palette. */
export function themeExtension(palette: EditorPalette): Extension {
  if (palette === 'one-dark') return [oneDarkChrome, oneDark]
  return [palette === 'dark' ? darkTheme : lightTheme, syntaxHighlighting(folioHighlightStyle)]
}

export const LINE_HEIGHTS: Record<UserSettings['lineHeight'], number> = { compact: 1.33, normal: 1.6, wide: 2 }

/** Font size / family / line height (a compartment of its own). */
export function fontExtension(s: Pick<UserSettings, 'fontSize' | 'fontFamily' | 'lineHeight'>): Extension {
  const size = Math.min(24, Math.max(10, Math.round(s.fontSize || 14)))
  return EditorView.theme({
    '&': { fontSize: `${size}px` },
    '.cm-scroller': {
      fontFamily: `var(--font-editor-${s.fontFamily}, var(--font-mono))`,
      lineHeight: String(LINE_HEIGHTS[s.lineHeight] ?? LINE_HEIGHTS.normal),
    },
  })
}
