/**
 * The keyboard shortcuts Folio supports, grouped for the shortcuts modal. Key specs use
 * CodeMirror's syntax ('Mod' = ⌘ on macOS, Ctrl elsewhere); `mac` overrides the keys on macOS
 * where CodeMirror binds different keys there. Keep in sync with the editor keymap
 * (features/editor), the global shortcuts (features/layout/useGlobalShortcuts.ts), the PDF viewer
 * (features/pdf) and this module's own panels.
 */

export interface ShortcutItem {
  label: string
  /** alternatives, each a key spec ('Mod-Shift-z') */
  keys?: string[]
  /** macOS alternatives when they differ */
  mac?: string[]
  /** a mouse gesture or a short phrase shown instead of keys */
  gesture?: string
  /** macOS variant of `gesture` */
  macGesture?: string
  /** small print under the label */
  note?: string
}

export interface ShortcutGroup {
  id: string
  title: string
  items: ShortcutItem[]
}

export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    id: 'common',
    title: 'Common',
    items: [
      { label: 'Recompile', keys: ['Mod-Enter', 'Mod-s'] },
      { label: 'Find in the file', keys: ['Mod-f'] },
      { label: 'Find and replace', keys: ['Mod-h'] },
      { label: 'Search in all project files', keys: ['Mod-Shift-f'] },
      { label: 'Undo', keys: ['Mod-z'] },
      { label: 'Redo', keys: ['Mod-y', 'Mod-Shift-z'], mac: ['Mod-Shift-z'] },
      { label: 'Select all', keys: ['Mod-a'] },
    ],
  },
  {
    id: 'navigation',
    title: 'Navigation',
    items: [
      { label: 'Go to line', keys: ['Mod-Shift-l'] },
      { label: 'Beginning of document', keys: ['Mod-Home'], mac: ['Mod-ArrowUp'] },
      { label: 'End of document', keys: ['Mod-End'], mac: ['Mod-ArrowDown'] },
      { label: 'Jump to the matching bracket', keys: ['Mod-Shift-\\'] },
      { label: 'Next compile problem', keys: ['F8'] },
    ],
  },
  {
    id: 'layout',
    title: 'Layout',
    items: [
      { label: 'Focus mode on / off', keys: ['Mod-Shift-m'], note: 'Hides the toolbar and the side panels' },
      { label: 'Editor only', keys: [], mac: ['Ctrl-Mod-ArrowLeft'] },
      { label: 'PDF only', keys: [], mac: ['Ctrl-Mod-ArrowRight'] },
      { label: 'Split view', keys: [], mac: ['Ctrl-Mod-ArrowDown'] },
    ],
  },
  {
    id: 'editing',
    title: 'Editing',
    items: [
      { label: 'Toggle comment', keys: ['Mod-/'] },
      { label: 'Bold', keys: ['Mod-b'], note: 'Wraps the selection in \\textbf{…}' },
      { label: 'Italic', keys: ['Mod-i'], note: 'Wraps the selection in \\textit{…}' },
      { label: 'Indent / outdent', keys: ['Tab', 'Shift-Tab'] },
      { label: 'Delete line', keys: ['Mod-d', 'Mod-Shift-k'] },
      { label: 'Move line up / down', keys: ['Alt-ArrowUp', 'Alt-ArrowDown'] },
      { label: 'Copy line up / down', keys: ['Shift-Alt-ArrowUp', 'Shift-Alt-ArrowDown'] },
      { label: 'Select the next occurrence', keys: ['Mod-Shift-d'] },
      { label: 'Upper case / lower case', keys: ['Mod-u', 'Mod-Shift-u'] },
      { label: 'Add a cursor above / below', keys: ['Mod-Alt-ArrowUp', 'Mod-Alt-ArrowDown'] },
      { label: 'Fold / unfold at the cursor', keys: ['F2'] },
      { label: 'Fold / unfold the current block', keys: ['Ctrl-Shift-[', 'Ctrl-Shift-]'], mac: ['Mod-Alt-[', 'Mod-Alt-]'] },
      { label: 'Fold / unfold everything', keys: ['Alt-Shift-1', 'Alt-Shift-0', 'Ctrl-Alt-[', 'Ctrl-Alt-]'] },
    ],
  },
  {
    id: 'find',
    title: 'Find and replace bar',
    items: [
      { label: 'Next / previous match', keys: ['Enter', 'Shift-Enter'], note: 'F3 and Shift+F3 also work in the text' },
      { label: 'Replace all', keys: ['Mod-Enter'], note: 'In the replace field' },
      { label: 'Match case / regular expression / whole word', keys: ['Alt-c', 'Alt-r', 'Alt-w'] },
      { label: 'Close and return to the text', keys: ['Escape'] },
    ],
  },
  {
    id: 'autocomplete',
    title: 'Autocomplete',
    items: [
      { label: 'Show suggestions', keys: ['Ctrl-Space'] },
      { label: 'Choose a suggestion', keys: ['ArrowUp', 'ArrowDown'] },
      { label: 'Insert the suggestion', keys: ['Enter'] },
      { label: 'Close the list', keys: ['Escape'] },
      { label: 'Next / previous placeholder', keys: ['Tab', 'Shift-Tab'], note: 'After inserting a snippet such as \\begin{…}' },
    ],
  },
  {
    id: 'pdf',
    title: 'PDF preview',
    items: [
      { label: 'Go to the code for a place in the PDF', gesture: 'Double-click' },
      { label: 'Zoom in / out', keys: ['Mod-=', 'Mod--'] },
      { label: 'Zoom with the mouse wheel', gesture: 'Ctrl + scroll', macGesture: '⌘ + scroll' },
      { label: 'Fit to width / fit to page', keys: ['Mod-0', 'Mod-9'] },
    ],
  },
  {
    id: 'panels',
    title: 'Chat and project search',
    items: [
      { label: 'Send a chat message', keys: ['Enter'] },
      { label: 'New line in a chat message', keys: ['Shift-Enter'] },
      { label: 'Move between search results', keys: ['ArrowUp', 'ArrowDown'] },
      { label: 'Open the selected result', keys: ['Enter'] },
      { label: 'Collapse / expand a file’s results', keys: ['ArrowLeft', 'ArrowRight'] },
    ],
  },
]
