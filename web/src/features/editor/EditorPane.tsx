/**
 * The editor column (SPEC §6.7): a toolbar with the breadcrumb of the open file (folders ›
 * file › current section; when the pane is narrow the outer sections fold into a "…" crumb
 * with a menu), the read-only badge for viewers, the connection state and quick
 * formatting actions (groups that do not fit collapse into a ⋯ menu); below it the
 * SourceEditor for text files, BinaryPreview for binary files, or an empty state — which says
 * so when the open file was deleted (openFileGuard). Starts the project index (completions)
 * while mounted; any jump request reveals the editor panel (reveal.ts).
 *
 * Module map (features/editor): SourceEditor (session + view lifecycle), ext/setup (extensions,
 * compartments), lang/latex (stex + token refinement), lang/bibtex, ext/completion,
 * projectIndex, ext/autoClose, ext/folding, ext/editing (commands, keymap), ext/searchPanel,
 * ext/diagnostics, ext/mathPreview (KaTeX), ext/keybindings (vim) + ext/emacs,
 * ext/composition (remote edits wait for IME compositions), ext/remoteCarets (name labels),
 * activeDoc (outline + doc status for the outline panel/breadcrumb), commands
 * (runEditorCommand), reveal (layout + focus rules), openFileGuard (open file deleted),
 * SymbolPalette, data/* (commands, environments, symbols, packages — our own lists).
 *
 * Deviations / additions (contract unchanged):
 * - Emacs keybindings are our own keymap (ext/emacs.ts): @replit/codemirror-emacs registers its
 *   keys in top-level calls marked `/*@__PURE__*\/`, which Vite/Rolldown drop, so none work.
 * - Compile warnings without a precise source location are marked in the gutter only (no
 *   underline across whole paragraphs); errors and undefined references are underlined.
 * - Extra test hooks on window.__folio: projectIndex, editorDiagnostics(), runEditorCommand,
 *   mathPreviewState(view).
 */
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react'
import clsx from 'clsx'
import {
  Bold, ChevronRight, ClipboardCopy, CloudOff, Ellipsis, Eye, FilePlus, FileText, FileX, FolderOpen, Heading, History,
  Image as ImageIcon, ImagePlus, Italic, Link, Link2, List, ListIndentDecrease, ListIndentIncrease, ListOrdered, Omega,
  Quote, Redo2, Search, Sigma, Table, Undo2, type LucideIcon,
} from 'lucide-react'
import type { FileEntry } from '@folio/shared/api'
import { basename, extname } from '@folio/shared/paths'
import { useEditor } from '../../stores/editor'
import { useLayout } from '../../stores/layout'
import { defaultOpenFile, useProject } from '../../stores/project'
import { Button, DropdownMenu, EmptyState, IconButton, Spinner, Tooltip, formatShortcut, type MenuItem } from '../../ui'
import { BinaryPreview } from '../filetree/BinaryPreview'
import { copyText } from '../filetree/actions'
import { runEditorCommand, type EditorCommand } from './commands'
import { sectionTrail, useActiveDoc } from './activeDoc'
import { installOpenFileGuard, useClosedFile } from './openFileGuard'
import { projectIndex } from './projectIndex'
import { revealEditorPanel } from './reveal'
import { SourceEditor } from './SourceEditor'
import { docKindFor } from './ext/setup'
import './editor.css'

export function EditorPane() {
  const openFileId = useEditor(s => s.openFileId)
  const file = useProject(s => (openFileId ? s.files[openFileId] : undefined))
  const loadState = useProject(s => s.loadState)
  const projectId = useProject(s => s.projectId)
  const paneRef = useRef<HTMLElement | null>(null)
  useKeepWidthWhenCollapsed(paneRef)

  // completions index for the whole project while the editor is shown
  useEffect(() => {
    projectIndex.start()
    return () => projectIndex.stop()
  }, [])

  // the open file being deleted closes the editor (never switches to another file)
  useEffect(() => installOpenFileGuard(), [])

  // a jump (search, outline, logs, SyncTeX…) to a file that still has to load shows the editor
  // right away (a file already shown is revealed by its SourceEditor, which then waits for the
  // layout to settle before scrolling)
  useEffect(() => useEditor.subscribe((s, prev) => {
    if (!s.jumpRequest || s.jumpRequest === prev.jumpRequest) return
    if (s.openFileId === prev.openFileId && s.view) return
    revealEditorPanel()
  }), [])

  // nothing open when the project becomes ready (and the store found nothing to restore): open
  // the main document — once per project, so closing the editor later is respected
  const autoOpened = useRef<string | null>(null)
  useEffect(() => {
    if (loadState !== 'ready' || !projectId || autoOpened.current === projectId) return
    if (!useEditor.getState().openFileId) {
      const target = defaultOpenFile()
      if (!target) return // no files yet: try again when they arrive
      useEditor.getState().openFile(target.id)
    }
    autoOpened.current = projectId
  }, [loadState, projectId, openFileId])

  return (
    <section ref={paneRef} className="ed-pane" aria-label="Editor">
      <EditorToolbar file={file} />
      <div className="ed-pane__body">
        {file?.kind === 'text' ? (
          <SourceEditor key={file.id} file={file} />
        ) : file?.kind === 'binary' ? (
          <div className="ed-pane__binary">
            <BinaryPreview file={file} showPath={false} />
          </div>
        ) : (
          <NoFileOpen />
        )}
      </div>
    </section>
  )
}

/**
 * While the editor's panel is collapsed ("PDF only") keep the editor laid out at its last width
 * (the panel clips it): CodeMirror would otherwise measure a zero-width, line-wrapped document —
 * every line hundreds of rows high — drift away from its scroll position and restart its measure
 * loop when the panel comes back.
 */
function useKeepWidthWhenCollapsed(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const pane = ref.current
    const panel = pane?.parentElement
    if (!pane || !panel || typeof ResizeObserver === 'undefined') return
    let last = 0
    const ro = new ResizeObserver(() => {
      const width = panel.clientWidth
      if (width >= 2) {
        last = width
        if (pane.style.width) pane.style.width = ''
      } else if (last > 0) {
        pane.style.width = `${last}px`
      }
    })
    ro.observe(panel)
    return () => {
      ro.disconnect()
      pane.style.width = ''
    }
  }, [ref])
}

function NoFileOpen() {
  const hasFiles = useProject(s => Object.values(s.files).some(f => f.kind !== 'folder'))
  const canEdit = useProject(s => s.role === 'owner' || s.role === 'editor')
  const loadState = useProject(s => s.loadState)
  const notice = useClosedFile(s => s.notice)
  // a file created again at the same path (e.g. deleted and re-uploaded)
  const recreated = useProject(s => (notice ? s.fileByPath(notice.path) : undefined))
  if (loadState !== 'ready') {
    return (
      <div className="ed-pane__center">
        <Spinner size={18} label="Loading project" />
      </div>
    )
  }
  if (notice) {
    const name = basename(notice.path)
    const again = recreated && recreated.kind !== 'folder' && recreated.id !== notice.fileId ? recreated : null
    return (
      <div className="ed-pane__center">
        <EmptyState
          icon={FileX}
          title={`“${name}” was deleted`}
          actions={
            <>
              {again && (
                <Button variant="primary" icon={FileText} onClick={() => useEditor.getState().openFile(again.id)}>
                  Open the new “{name}”
                </Button>
              )}
              <Button icon={History} onClick={() => useLayout.getState().setHistoryOpen(true)}>
                Open history
              </Button>
              {!notice.byMe && notice.lastText && (
                <Button icon={ClipboardCopy} onClick={() => void copyText(notice.lastText ?? '', 'Its text')}>
                  Copy its text
                </Button>
              )}
            </>
          }
        >
          {notice.byMe
            ? 'The file you had open was deleted. Deleted files can be restored from the project history.'
            : `${notice.byName ?? 'A collaborator'} deleted it while you had it open. It can be restored from the project history; its last text can also be copied.`}
        </EmptyState>
      </div>
    )
  }
  return (
    <div className="ed-pane__center">
      <EmptyState
        icon={hasFiles ? FolderOpen : FileText}
        title={hasFiles ? 'No file open' : 'This project is empty'}
        actions={
          !hasFiles && canEdit ? (
            <Button variant="primary" icon={FilePlus} onClick={() => useLayout.getState().openModal('newfile')}>
              New file
            </Button>
          ) : undefined
        }
      >
        {hasFiles ? 'Choose a file in the file tree to start editing.' : canEdit ? 'Create a file or upload one to get started.' : 'The owner hasn’t added any files yet.'}
      </EmptyState>
    </div>
  )
}

// -- toolbar ----------------------------------------------------------------------------------------
//
// Tool groups collapse into a "More editor toolbar items" (⋯) menu, lists first, when the editor
// pane is too narrow for all of them; everything stays reachable (PAR-8).

type Tool =
  | { kind: 'command'; command: EditorCommand; label: string; icon: LucideIcon; shortcut?: string }
  | { kind: 'symbols'; label: string; icon: LucideIcon }
  | { kind: 'heading'; label: string; icon: LucideIcon }

type GroupId = 'history' | 'heading' | 'format' | 'insert' | 'lists'

interface ToolGroup {
  id: GroupId
  /** only for LaTeX files */
  latex: boolean
  tools: Tool[]
}

const cmd = (command: EditorCommand, label: string, icon: LucideIcon, shortcut?: string): Tool => ({ kind: 'command', command, label, icon, shortcut })

const GROUPS: ToolGroup[] = [
  { id: 'history', latex: false, tools: [cmd('undo', 'Undo', Undo2, 'Mod-z'), cmd('redo', 'Redo', Redo2, 'Mod-Shift-z')] },
  { id: 'heading', latex: true, tools: [{ kind: 'heading', label: 'Heading level', icon: Heading }] },
  { id: 'format', latex: true, tools: [cmd('bold', 'Bold', Bold, 'Mod-b'), cmd('italic', 'Italic', Italic, 'Mod-i')] },
  {
    id: 'insert',
    latex: true,
    tools: [
      cmd('inlineMath', 'Inline math', Sigma),
      { kind: 'symbols', label: 'Insert symbol', icon: Omega },
      cmd('insertLink', 'Insert link', Link),
      cmd('insertRef', 'Insert cross-reference', Link2),
      cmd('insertCitation', 'Insert citation', Quote),
      cmd('insertFigure', 'Insert figure', ImagePlus),
      cmd('insertTable', 'Insert table', Table),
    ],
  },
  {
    id: 'lists',
    latex: true,
    tools: [
      cmd('bulletList', 'Bulleted list', List),
      cmd('numberedList', 'Numbered list', ListOrdered),
      cmd('indentLess', 'Decrease indent', ListIndentDecrease, 'Shift-Tab'),
      cmd('indentMore', 'Increase indent', ListIndentIncrease, 'Tab'),
    ],
  },
]

const HEADINGS: { command: EditorCommand; label: string }[] = [
  { command: 'section', label: 'Section' },
  { command: 'subsection', label: 'Subsection' },
  { command: 'subsubsection', label: 'Subsubsection' },
  { command: 'paragraph', label: 'Paragraph' },
]

/** first into the ⋯ menu when space runs out */
const COLLAPSE_ORDER: GroupId[] = ['lists', 'insert', 'heading', 'format', 'history']

// widths in px (IconButton sm = 24, 1px gaps, group padding 2 × 4 + 1px divider)
const BUTTON_W = 25
const GROUP_PAD = 8
/** room kept for the breadcrumb (file name) and the toolbar padding/gaps */
const CRUMBS_MIN_W = 190
const groupWidth = (n: number) => n * BUTTON_W + GROUP_PAD
const SINGLE_W = groupWidth(1)

/** Which groups go into the ⋯ menu for the available width. */
function collapsedGroups(groups: ToolGroup[], avail: number): Set<GroupId> {
  const collapsed = new Set<GroupId>()
  const needed = () => groups.reduce((w, g) => (collapsed.has(g.id) ? w : w + groupWidth(g.tools.length)), SINGLE_W) + (collapsed.size ? SINGLE_W : 0)
  for (const id of COLLAPSE_ORDER) {
    if (needed() <= avail) break
    if (groups.some(g => g.id === id)) collapsed.add(id)
  }
  return collapsed
}

/** Space the toolbar has for tool buttons (null until measured). */
function useToolSpace(): { toolbarRef: (el: HTMLDivElement | null) => void; statusRef: (el: HTMLDivElement | null) => void; space: number | null } {
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null)
  const [status, setStatus] = useState<HTMLDivElement | null>(null)
  const [space, setSpace] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!toolbar) return
    const measure = () => setSpace(toolbar.clientWidth - (status?.offsetWidth ?? 0) - CRUMBS_MIN_W)
    measure()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(measure)
    ro.observe(toolbar)
    if (status) ro.observe(status)
    return () => ro.disconnect()
  }, [toolbar, status])
  return { toolbarRef: setToolbar, statusRef: setStatus, space }
}

function formatShortcutHint(label: string, shortcut?: string): string {
  return shortcut ? `${label} (${formatShortcut(shortcut)})` : label
}

/** Keep focus in the editor when clicking toolbar buttons. */
const keepFocus = (e: MouseEvent) => e.preventDefault()

function run(command: EditorCommand) {
  useEditor.getState().view?.focus()
  runEditorCommand(command)
}

function openSymbols() {
  useLayout.getState().openModal('symbols')
}

const headingItems = (enabled: boolean): MenuItem[] =>
  HEADINGS.map(h => ({ label: h.label, disabled: !enabled, onSelect: () => run(h.command) }))

function EditorToolbar({ file }: { file: FileEntry | undefined }) {
  const role = useProject(s => s.role)
  const hasView = useEditor(s => s.view !== null)
  const { toolbarRef, statusRef, space } = useToolSpace()
  const readOnly = role === 'viewer'
  const isText = file?.kind === 'text'
  const isLatex = isText && docKindFor(file.path) === 'latex'
  const editable = isText && hasView && !readOnly

  const groups = readOnly || !isText ? [] : GROUPS.filter(g => !g.latex || isLatex)
  const collapsed = space === null ? new Set<GroupId>() : collapsedGroups(groups, space)

  const toolButton = (t: Tool) => {
    if (t.kind === 'heading') {
      return (
        <DropdownMenu
          key="heading"
          items={headingItems(editable)}
          trigger={<IconButton icon={t.icon} label={t.label} size="sm" disabled={!editable} />}
        />
      )
    }
    if (t.kind === 'symbols') {
      return <IconButton key="symbols" icon={t.icon} label={t.label} size="sm" disabled={!editable} onMouseDown={keepFocus} onClick={openSymbols} />
    }
    return (
      <IconButton
        key={t.command}
        icon={t.icon}
        label={t.label}
        tooltip={formatShortcutHint(t.label, t.shortcut)}
        size="sm"
        disabled={!editable}
        onMouseDown={keepFocus}
        onClick={() => run(t.command)}
      />
    )
  }

  const moreItems: MenuItem[] = []
  for (const g of groups) {
    if (!collapsed.has(g.id)) continue
    if (moreItems.length) moreItems.push({ type: 'separator' })
    for (const t of g.tools) {
      if (t.kind === 'heading') moreItems.push({ label: 'Heading', icon: t.icon, disabled: !editable, items: headingItems(editable) })
      else if (t.kind === 'symbols') moreItems.push({ label: `${t.label}…`, icon: t.icon, disabled: !editable, onSelect: openSymbols })
      else moreItems.push({ label: t.label, icon: t.icon, shortcut: t.shortcut, disabled: !editable, onSelect: () => run(t.command) })
    }
  }

  return (
    <div ref={toolbarRef} className="ed-toolbar" role="toolbar" aria-label="Editor toolbar">
      <Breadcrumb file={file} />
      <div ref={statusRef} className="ed-toolbar__status">
        {isText && <DocStatusChip />}
        {readOnly && (
          <Tooltip content="You have view-only access to this project" side="bottom">
            <span className="ed-badge" tabIndex={0}>
              <Eye size={13} aria-hidden="true" />
              Read only
            </span>
          </Tooltip>
        )}
      </div>
      {isText && (
        <div className="ed-toolbar__actions">
          {groups.filter(g => !collapsed.has(g.id)).map(g => (
            <div key={g.id} className={clsx('ed-toolbar__group', `ed-toolbar__group--${g.id}`)} role="group">
              {g.tools.map(toolButton)}
            </div>
          ))}
          {moreItems.length > 0 && (
            <div className="ed-toolbar__group ed-toolbar__group--more" role="group">
              <DropdownMenu
                align="end"
                items={moreItems}
                trigger={<IconButton icon={Ellipsis} label="More editor toolbar items" size="sm" disabled={!editable} />}
              />
            </div>
          )}
          <div className="ed-toolbar__group" role="group">
            <IconButton
              icon={Search}
              label="Search in file"
              tooltip={formatShortcutHint('Search in file', 'Mod-f')}
              size="sm"
              disabled={!hasView}
              onMouseDown={keepFocus}
              onClick={() => run('find')}
            />
          </div>
        </div>
      )}
    </div>
  )
}

function DocStatusChip() {
  const status = useActiveDoc(s => s.status)
  const docFile = useActiveDoc(s => s.fileId)
  const closed = useActiveDoc(s => s.closed)
  if (!docFile || closed || status !== 'disconnected') return null
  return (
    <Tooltip content="Your changes are kept and will sync when the connection is back" side="bottom">
      <span className="ed-badge ed-badge--offline" tabIndex={0} role="status">
        <CloudOff size={13} aria-hidden="true" />
        Offline
      </span>
    </Tooltip>
  )
}

// Breadcrumb fitting (J-7): parent sections keep their natural width (up to the CSS cap); the
// current section and folders shrink with an ellipsis. When the current section would get
// narrower than MIN_LAST_PX, a folder narrower than MIN_FOLDER_PX, or the crumbs overflow, the
// outermost parents fold one by one into a "…" crumb whose menu lists them — never a clipped
// sliver of a parent that shows a single letter.
const MIN_LAST_PX = 80
const MIN_FOLDER_PX = 48

const sectionLabel = (item: { title: string; command: string }) => item.title || `\\${item.command}`

function Breadcrumb({ file }: { file: FileEntry | undefined }) {
  const outline = useActiveDoc(s => (file && s.fileId === file.id ? s.outline : null))
  const cursorLine = useEditor(s => (file && s.cursor?.fileId === file.id ? s.cursor.line : null))
  const [nav, setNav] = useState<HTMLElement | null>(null)
  const listRef = useRef<HTMLOListElement | null>(null)
  const [width, setWidth] = useState(0)
  const [fold, setFold] = useState({ key: '', count: 0 })
  const trail = file && outline ? sectionTrail(outline, cursorLine) : []
  const layoutKey = `${file?.path ?? ''}|${width}|${trail.map(t => `${t.line}:${t.title}`).join('|')}`
  // parents folded into "…" (recomputed from none whenever the width or the trail changes)
  const folded = fold.key === layoutKey ? fold.count : 0
  const parents = Math.max(0, trail.length - 1)

  useLayoutEffect(() => {
    if (!nav || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => setWidth(Math.round(nav.clientWidth)))
    ro.observe(nav)
    return () => ro.disconnect()
  }, [nav])

  useLayoutEffect(() => {
    const ol = listRef.current
    if (!ol || folded >= parents) return
    const squeezed = (el: Element | null, min: number) => el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1 && el.clientWidth < min
    const tight = ol.scrollWidth > ol.clientWidth + 1
      || squeezed(ol.querySelector('.ed-crumbs__section:last-child .ed-crumbs__sectionbtn'), MIN_LAST_PX)
      || Array.from(ol.querySelectorAll('.ed-crumbs__folder > span')).some(el => squeezed(el, MIN_FOLDER_PX))
    if (tight) setFold({ key: layoutKey, count: folded + 1 })
  }, [layoutKey, folded, parents])

  if (!file) return <div className="ed-crumbs" />
  const parts = file.path.split('/')
  const name = parts.pop()!
  const FileIcon = file.kind === 'binary' && /^(png|jpe?g|gif|svg|webp|bmp|eps|pdf)$/.test(extname(file.path)) ? ImageIcon : FileText
  const jump = (line: number) => useEditor.getState().jumpTo({ fileId: file.id, line })
  const hidden = trail.slice(0, folded)
  return (
    <nav ref={setNav} className="ed-crumbs" aria-label="File path">
      <ol ref={listRef}>
        {parts.map((p, i) => (
          <li key={`${i}:${p}`} className="ed-crumbs__folder" title={parts.slice(0, i + 1).join('/')}>
            <span>{p}</span>
            <ChevronRight size={12} className="ed-crumbs__sep" aria-hidden="true" />
          </li>
        ))}
        <li className="ed-crumbs__file" aria-current="page">
          <FileIcon size={14} aria-hidden="true" />
          <span>{name}</span>
        </li>
        {hidden.length > 0 && (
          <li className="ed-crumbs__section ed-crumbs__section--more">
            <ChevronRight size={12} className="ed-crumbs__sep" aria-hidden="true" />
            <DropdownMenu
              items={hidden.map(item => ({ id: `${item.line}`, label: sectionLabel(item), description: `Line ${item.line}`, onSelect: () => jump(item.line) }))}
              trigger={
                <button
                  type="button"
                  className="ed-crumbs__sectionbtn ed-crumbs__more"
                  title={hidden.map(sectionLabel).join(' › ')}
                  aria-label={`Enclosing sections: ${hidden.map(sectionLabel).join(', ')}`}
                >
                  <Ellipsis size={14} aria-hidden="true" />
                </button>
              }
            />
          </li>
        )}
        {trail.slice(folded).map(item => (
          <li key={`${item.line}:${item.title}`} className="ed-crumbs__section">
            <ChevronRight size={12} className="ed-crumbs__sep" aria-hidden="true" />
            <button
              type="button"
              className="ed-crumbs__sectionbtn"
              title={`${item.title} — line ${item.line}`}
              onMouseDown={keepFocus}
              onClick={() => jump(item.line)}
            >
              {sectionLabel(item)}
            </button>
          </li>
        ))}
      </ol>
    </nav>
  )
}
