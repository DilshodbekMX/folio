/**
 * Editor menu bar: File / Edit / Insert / View / Format / Help, following Overleaf's structure
 * limited to what Folio supports. Menus call runEditorCommand, the compile/layout stores and
 * API downloads. Below 860 px the menu bar collapses into one "Menu" button with the same menus
 * as submenus (see layout.css).
 */
import { useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { useNavigate } from 'react-router'
import {
  BookOpen, Bold, Copy, Download, ExternalLink, FilePlus, FileText, FolderPlus, History, Info, Italic, Keyboard,
  Link2, List, ListOrdered, Menu, MessageSquareQuote, Omega, PanelLeft, PanelRight, Columns2, Quote, Redo2, Search, Settings, Sigma,
  Table, Image, Undo2, Upload, WholeWord, IndentIncrease, IndentDecrease, TextCursorInput, Hash, TextSearch,
} from 'lucide-react'
import { api } from '../../api/endpoints'
import { errorMessage } from '../../api/client'
import { downloadUrl, openInNewTab, safeFilename } from '../../lib/download'
import { useAuth, useSettings } from '../../stores/auth'
import { useCompile } from '../../stores/compile'
import { useEditor } from '../../stores/editor'
import { useLayout, type LayoutView } from '../../stores/layout'
import { usePrefs } from '../../stores/prefs'
import { useProject } from '../../stores/project'
import { DropdownMenu, isMac, promptDialog, toast, type MenuItem } from '../../ui'
import { runEditorCommand, type EditorCommand } from '../editor/commands'
import { downloadPdf } from '../pdf/PdfToolbar'
import { openProjectSearch, selectedSearchText } from '../search/SearchPanel'
import { HELP_URL, useChrome } from './uiState'
import { confirmLeaveProject } from './unsynced'

/** Focus the editor, then run the command (the command may move focus, e.g. into the search panel). */
export function runCommand(cmd: EditorCommand): void {
  useEditor.getState().view?.focus()
  runEditorCommand(cmd)
}

export const LAYOUT_OPTIONS: { id: LayoutView; label: string; icon: typeof Columns2 }[] = [
  { id: 'split', label: 'Split view', icon: Columns2 },
  { id: 'editor', label: 'Editor only', icon: PanelLeft },
  { id: 'pdf', label: 'PDF only', icon: PanelRight },
]

/** ⌃⌘← / ⌃⌘→ / ⌃⌘↓ on macOS (features/layout/useGlobalShortcuts.ts) */
const LAYOUT_SHORTCUTS: Record<LayoutView, string> = { editor: 'Ctrl-Mod-ArrowLeft', pdf: 'Ctrl-Mod-ArrowRight', split: 'Ctrl-Mod-ArrowDown' }

function focusModeItem(focusMode: boolean): MenuItem {
  return {
    type: 'checkbox',
    label: 'Focus mode',
    shortcut: 'Mod-Shift-m',
    checked: focusMode,
    onSelect: () => useLayout.getState().setFocusMode(!focusMode),
  }
}

export function layoutMenuItems(view: LayoutView, setView: (v: LayoutView) => void, pdfUrl: string | null, focusMode = false): MenuItem[] {
  return [
    ...LAYOUT_OPTIONS.map<MenuItem>(o => ({
      type: 'radio',
      label: o.label,
      checked: view === o.id,
      shortcut: isMac ? LAYOUT_SHORTCUTS[o.id] : undefined,
      onSelect: () => setView(o.id),
    })),
    focusModeItem(focusMode),
    { type: 'separator' },
    { label: 'Open PDF in new tab', icon: ExternalLink, disabled: !pdfUrl, onSelect: () => pdfUrl && openInNewTab(pdfUrl) },
  ]
}

async function copyThisProject(navigate: (to: string) => void) {
  const { projectId, name } = useProject.getState()
  if (!projectId) return
  const newName = await promptDialog({
    title: 'Make a copy',
    label: 'New name',
    initial: `${name} (Copy)`,
    confirmLabel: 'Copy',
    message: 'The copy is owned by you. Collaborators, share links, history and chat are not copied.',
    validate: v => (!v ? 'Enter a project name.' : v.length > 150 ? 'Project names can be at most 150 characters.' : null),
  })
  // the user may have left the project while the dialog was open
  if (newName === null || useProject.getState().projectId !== projectId) return
  try {
    const { id } = await api.copyProject(projectId, { name: newName })
    if (useProject.getState().projectId !== projectId) return
    if (await confirmLeaveProject()) navigate(`/project/${id}`)
    else toast(`Copied to “${newName}”. You can open it from your project list.`, { tone: 'success' })
  } catch (e) {
    toast(`Couldn’t copy the project: ${errorMessage(e)}`, { tone: 'error' })
  }
}

function useMenus(): { id: string; label: string; items: MenuItem[] }[] {
  const navigate = useNavigate()
  const projectId = useProject(s => s.projectId)
  const name = useProject(s => s.name)
  const canEdit = useProject(s => s.role === 'owner' || s.role === 'editor')
  const hasView = useEditor(s => s.view !== null)
  const view = useLayout(s => s.view)
  const setView = useLayout(s => s.setView)
  const openModal = useLayout(s => s.openModal)
  const setHistoryOpen = useLayout(s => s.setHistoryOpen)
  const logsOpen = useCompile(s => s.logsOpen)
  const pdfUrl = useCompile(s => s.lastWithPdf?.pdfUrl ?? null)
  const focusMode = useLayout(s => s.focusMode)
  const pdfInvert = usePrefs(s => s.pdfInvertDark)
  const settings = useSettings()
  const setAboutOpen = useChrome(s => s.setAboutOpen)
  const editable = canEdit && hasView

  const setting = <K extends 'equationPreview' | 'lineWrapping'>(k: K, v: boolean) => {
    useAuth.getState().updateSettings({ [k]: v } as Partial<Record<K, boolean>>).catch(e => toast(`Couldn’t save the setting: ${errorMessage(e)}`, { tone: 'error' }))
  }
  const cmd = (label: string, command: EditorCommand, extra: Partial<MenuItem> = {}): MenuItem => ({
    label,
    disabled: !editable,
    onSelect: () => runCommand(command),
    ...extra,
  })

  const file: MenuItem[] = [
    { label: 'New file…', icon: FilePlus, disabled: !canEdit, onSelect: () => openModal('newfile') },
    { label: 'New folder…', icon: FolderPlus, disabled: !canEdit, onSelect: () => openModal('newfolder') },
    { label: 'Upload files…', icon: Upload, disabled: !canEdit, onSelect: () => openModal('upload') },
    { type: 'separator' },
    { label: 'Make a copy…', icon: Copy, onSelect: () => void copyThisProject(navigate) },
    { type: 'separator' },
    { label: 'Show version history', icon: History, onSelect: () => setHistoryOpen(true) },
    { label: 'Word count', icon: WholeWord, onSelect: () => openModal('wordcount') },
    { type: 'separator' },
    {
      label: 'Download',
      icon: Download,
      items: [
        {
          label: 'Source (.zip)',
          onSelect: () => projectId && downloadUrl(api.downloadProjectUrl(projectId), `${safeFilename(name, 'project')}.zip`),
        },
        {
          label: 'PDF',
          disabled: !pdfUrl,
          description: pdfUrl ? undefined : 'Compile the project first',
          // saved as "<project name>.pdf" (the build URL would name it after the jobname)
          onSelect: () => void downloadPdf(),
        },
      ],
    },
    { type: 'separator' },
    { label: 'Settings', icon: Settings, onSelect: () => openModal('settings') },
  ]

  const edit: MenuItem[] = [
    cmd('Undo', 'undo', { icon: Undo2, shortcut: 'Mod-z' }),
    cmd('Redo', 'redo', { icon: Redo2, shortcut: 'Mod-Shift-z' }),
    { type: 'separator' },
    { label: 'Find', icon: Search, shortcut: 'Mod-f', disabled: !hasView, onSelect: () => runCommand('find') },
    cmd('Find and replace', 'replace', { icon: TextCursorInput }),
    { label: 'Go to line…', icon: Hash, shortcut: 'Mod-Shift-l', disabled: !hasView, onSelect: () => runCommand('gotoLine') },
    { label: 'Search in project…', icon: TextSearch, shortcut: 'Mod-Shift-f', onSelect: () => openProjectSearch(selectedSearchText()) },
    { label: 'Select all', shortcut: 'Mod-a', disabled: !hasView, onSelect: () => runCommand('selectAll') },
    { type: 'separator' },
    cmd('Toggle comment', 'toggleComment', { icon: MessageSquareQuote, shortcut: 'Mod-/' }),
  ]

  const insert: MenuItem[] = [
    {
      label: 'Math',
      icon: Sigma,
      disabled: !editable,
      items: [cmd('Inline math', 'inlineMath'), cmd('Display math', 'displayMath')],
    },
    { label: 'Symbol…', icon: Omega, disabled: !editable, onSelect: () => openModal('symbols') },
    { type: 'separator' },
    cmd('Figure', 'insertFigure', { icon: Image }),
    cmd('Table', 'insertTable', { icon: Table }),
    { type: 'separator' },
    cmd('Citation', 'insertCitation', { icon: Quote }),
    cmd('Cross-reference', 'insertRef', { icon: Link2 }),
    cmd('Link', 'insertLink', { icon: ExternalLink }),
  ]

  const viewMenu: MenuItem[] = [
    ...layoutMenuItems(view, setView, null).slice(0, 3),
    focusModeItem(focusMode),
    { type: 'separator' },
    { type: 'header', label: 'Editor' },
    { type: 'checkbox', label: 'Equation preview', checked: settings.equationPreview, keepOpen: true, onSelect: () => setting('equationPreview', !settings.equationPreview) },
    { type: 'checkbox', label: 'Line wrapping', checked: settings.lineWrapping, keepOpen: true, onSelect: () => setting('lineWrapping', !settings.lineWrapping) },
    { label: 'Fold all', disabled: !hasView, onSelect: () => runCommand('foldAll') },
    { label: 'Unfold all', disabled: !hasView, onSelect: () => runCommand('unfoldAll') },
    { type: 'separator' },
    { type: 'header', label: 'PDF' },
    { type: 'checkbox', label: 'Logs and output files', checked: logsOpen, onSelect: () => useCompile.getState().setLogsOpen(!logsOpen) },
    {
      type: 'checkbox',
      label: 'Dark mode PDF',
      description: 'Invert the PDF’s colours in the dark theme',
      checked: pdfInvert,
      keepOpen: true,
      onSelect: () => usePrefs.getState().setPdfInvertDark(!pdfInvert),
    },
    { label: 'Open PDF in new tab', disabled: !pdfUrl, onSelect: () => pdfUrl && openInNewTab(pdfUrl) },
  ]

  const format: MenuItem[] = [
    cmd('Bold', 'bold', { icon: Bold, shortcut: 'Mod-b' }),
    cmd('Italics', 'italic', { icon: Italic, shortcut: 'Mod-i' }),
    { type: 'separator' },
    cmd('Bullet list', 'bulletList', { icon: List }),
    cmd('Numbered list', 'numberedList', { icon: ListOrdered }),
    cmd('Increase indentation', 'indentMore', { icon: IndentIncrease }),
    cmd('Decrease indentation', 'indentLess', { icon: IndentDecrease }),
    { type: 'separator' },
    {
      label: 'Paragraph styles',
      icon: FileText,
      disabled: !editable,
      items: [
        cmd('Section', 'section'),
        cmd('Subsection', 'subsection'),
        cmd('Subsubsection', 'subsubsection'),
        cmd('Paragraph', 'paragraph'),
      ],
    },
  ]

  const help: MenuItem[] = [
    { label: 'Keyboard shortcuts', icon: Keyboard, onSelect: () => openModal('shortcuts') },
    { label: 'Documentation', icon: BookOpen, onSelect: () => openInNewTab(HELP_URL) },
    { type: 'separator' },
    { label: 'About Folio', icon: Info, onSelect: () => setAboutOpen(true) },
  ]

  return [
    { id: 'file', label: 'File', items: file },
    { id: 'edit', label: 'Edit', items: edit },
    { id: 'insert', label: 'Insert', items: insert },
    { id: 'view', label: 'View', items: viewMenu },
    { id: 'format', label: 'Format', items: format },
    { id: 'help', label: 'Help', items: help },
  ]
}

/**
 * role="menubar" with roving focus, hover-to-switch while open and ←/→ between menus; plus the
 * compact "Menu" button that replaces it on narrow windows.
 */
export function MenuBar() {
  const menus = useMenus()
  const [open, setOpen] = useState<string | null>(null)
  // Focus override for menus opened by hover-switch ('none') or ←/→ navigation ('first');
  // null lets DropdownMenu decide (keyboard → first item, mouse → the menu itself).
  const [override, setOverride] = useState<'first' | 'none' | null>(null)
  const [focusIndex, setFocusIndex] = useState(0)
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  // menu opened by moving the pointer onto its title while another one was open: the click that
  // usually follows must not toggle it closed again
  const hoverOpened = useRef<string | null>(null)

  const moveFocus = (i: number) => {
    const n = menus.length
    const j = (i + n) % n
    setFocusIndex(j)
    refs.current[j]?.focus()
    return j
  }

  const onTriggerKey = (i: number) => (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const j = moveFocus(i + (e.key === 'ArrowRight' ? 1 : -1))
      if (open) {
        setOverride('first')
        setOpen(menus[j].id)
      }
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault()
      moveFocus(e.key === 'Home' ? 0 : menus.length - 1)
    }
  }

  return (
    <>
      <div className="lay-menubar" role="menubar" aria-label="Editor menu">
        {menus.map((m, i) => (
          <DropdownMenu
            key={m.id}
            items={m.items}
            open={open === m.id}
            initialFocus={open === m.id && override ? override : undefined}
            minWidth={220}
            onOpenChange={o => {
              if (o) {
                setOverride(null)
                setOpen(m.id)
              } else if (open === m.id) {
                setOpen(null)
              }
            }}
            onNavigate={dir => {
              const j = moveFocus(i + (dir === 'right' ? 1 : -1))
              setOverride('first')
              setOpen(menus[j].id)
            }}
            trigger={
              <button
                ref={el => {
                  refs.current[i] = el
                }}
                type="button"
                role="menuitem"
                tabIndex={i === focusIndex ? 0 : -1}
                className="lay-menubar__item"
                onFocus={() => setFocusIndex(i)}
                onMouseEnter={() => {
                  if (open && open !== m.id) {
                    hoverOpened.current = m.id
                    setOverride('none')
                    setOpen(m.id)
                    refs.current[i]?.focus()
                  }
                }}
                onMouseLeave={() => {
                  if (hoverOpened.current === m.id) hoverOpened.current = null
                }}
                onClick={(e: MouseEvent<HTMLButtonElement>) => {
                  // DropdownMenu skips its toggle for a prevented click: the menu stays open
                  if (hoverOpened.current === m.id && open === m.id) e.preventDefault()
                  hoverOpened.current = null
                }}
                onKeyDown={onTriggerKey(i)}
              >
                {m.label}
              </button>
            }
          />
        ))}
      </div>
      <DropdownMenu
        items={menus.map(m => ({ id: m.id, label: m.label, items: m.items }))}
        minWidth={200}
        trigger={
          <button type="button" className="lay-menubar__compact" aria-label="Menu">
            <Menu size={16} aria-hidden="true" />
            <span>Menu</span>
          </button>
        }
      />
    </>
  )
}
