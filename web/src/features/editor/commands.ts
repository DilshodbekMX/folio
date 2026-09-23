/**
 * Editor commands for the menus and toolbar (SPEC §6.7): `runEditorCommand(name)` runs one on
 * the active editor (`useEditor.view`) and returns false when it could not run (no editor, or
 * an editing command in a read-only document).
 */
import { selectAll, indentLess, indentMore, toggleComment } from '@codemirror/commands'
import { foldAll, unfoldAll } from '@codemirror/language'
import { gotoLine } from '@codemirror/search'
import { useEditor } from '../../stores/editor'
import { registerTestHook } from '../../stores/testHooks'
import {
  insertDisplayMath, insertFigure, insertLink, insertList, insertTable, insertWithCompletion, setHeading, toggleWrap, wrapWith,
} from './ext/editing'
import { openSearch } from './ext/searchPanel'
import { yRedo, yUndo } from './ext/keybindings'

export type EditorCommand =
  | 'undo' | 'redo' | 'find' | 'replace' | 'gotoLine' | 'selectAll' | 'toggleComment'
  | 'bold' | 'italic' | 'inlineMath' | 'displayMath' | 'bulletList' | 'numberedList'
  | 'section' | 'subsection' | 'subsubsection' | 'paragraph'
  | 'insertFigure' | 'insertTable' | 'insertCitation' | 'insertRef' | 'insertLink'
  | 'indentMore' | 'indentLess' | 'foldAll' | 'unfoldAll'

/** Commands that are available in read-only documents. */
const READ_ONLY_OK = new Set<EditorCommand>(['find', 'gotoLine', 'selectAll', 'foldAll', 'unfoldAll'])

/** Runs a command on the active editor; returns false when it could not run. */
export function runEditorCommand(name: EditorCommand): boolean {
  const view = useEditor.getState().view
  if (!view) return false
  if (view.state.readOnly && !READ_ONLY_OK.has(name)) return false
  switch (name) {
    case 'undo': return yUndo(view)
    case 'redo': return yRedo(view)
    case 'find': return openSearch(view, false)
    case 'replace': return openSearch(view, true)
    case 'gotoLine': return gotoLine(view)
    case 'selectAll': return selectAll(view)
    case 'toggleComment': return toggleComment(view)
    case 'bold': return toggleWrap(view, 'textbf')
    case 'italic': return toggleWrap(view, 'textit')
    case 'inlineMath': return wrapWith(view, '\\(', '\\)')
    case 'displayMath': return insertDisplayMath(view)
    case 'bulletList': return insertList(view, 'itemize')
    case 'numberedList': return insertList(view, 'enumerate')
    case 'section':
    case 'subsection':
    case 'subsubsection':
    case 'paragraph':
      return setHeading(view, name)
    case 'insertFigure': return insertFigure(view)
    case 'insertTable': return insertTable(view)
    case 'insertCitation': return insertWithCompletion(view, 'cite')
    case 'insertRef': return insertWithCompletion(view, 'ref')
    case 'insertLink': return insertLink(view)
    case 'indentMore': return indentMore(view)
    case 'indentLess': return indentLess(view)
    case 'foldAll': return foldAll(view)
    case 'unfoldAll': return unfoldAll(view)
    default: {
      const never: never = name
      void never
      return false
    }
  }
}

registerTestHook('runEditorCommand', runEditorCommand)
