/**
 * The editor page (SPEC §6.7 composition):
 *
 *   TopBar
 *   [Reconnecting banner]
 *   [Kept changes: unsaved text of documents closed under this user (RecoveredTexts)]
 *   Rail | Group(horizontal)[ Panel rail-panel (Files: FileTree over Outline | Search | Chat)
 *                            | Separator
 *                            | Panel work: Group(horizontal)[ Panel EditorPane | Separator | Panel PdfPane ]
 *                                          + SyncTeX arrows on the divider (overlay)
 *                                          + HistoryView over the whole work area while open ]
 *   ModalHost (useLayout.modal)
 *
 * Focus mode (useLayout.focusMode) hides the top bar and the rail (the store also collapses the
 * rail panel) and shows a floating "Exit focus mode" button; the connection banner stays.
 *
 * All panels stay mounted; layouts are applied by collapsing/expanding panels so the editor
 * and the PDF viewer keep their state when switching views. Sizes persist through
 * useLayout's layoutStorage; a drag that collapses/expands a panel updates useLayout.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Group, Panel, Separator, useDefaultLayout, usePanelRef, type Layout, type LayoutChangedMeta, type PanelImperativeHandle,
} from 'react-resizable-panels'
import { ArrowLeft, ArrowRight, Minimize2, PanelLeftOpen, PanelRightOpen } from 'lucide-react'
import clsx from 'clsx'
import { errorMessage } from '../../api/client'
import { useCompile } from '../../stores/compile'
import { useEditor } from '../../stores/editor'
import { layoutStorage, useLayout, type LayoutView, type RailPanel } from '../../stores/layout'
import { useProject } from '../../stores/project'
import { Spinner, Tooltip, formatShortcut, toast } from '../../ui'
import { FileTreePanel } from '../filetree/FileTreePanel'
import { OutlinePanel } from '../outline/OutlinePanel'
import { SearchPanel } from '../search/SearchPanel'
import { ChatPanel, useChatUnread } from '../chat/ChatPanel'
import { EditorPane } from '../editor/EditorPane'
import { PdfPane } from '../pdf/PdfPane'
import { syncCodeToPdf, syncPdfToCode } from '../pdf/synctex'
import { useAutoCompile } from '../pdf/autoCompile'
import { HistoryView } from '../history/HistoryView'
import { TopBar } from './TopBar'
import { Rail } from './Rail'
import { ConnectionBanner } from './ConnectionBanner'
import { RecoveredTexts } from './RecoveredTexts'
import { ModalHost } from './ModalHost'
import { useGlobalShortcuts } from './useGlobalShortcuts'
import { useProjectNotices } from './notices'
import './layout.css'

// Panel ids double as DOM ids (react-resizable-panels) — keep them unique on the page.
const ID = {
  outer: 'folio-outer',
  work: 'folio-work',
  files: 'folio-files',
  railPanel: 'lay-railpanel',
  workPanel: 'lay-work',
  editor: 'lay-editor',
  pdf: 'lay-pdf',
  tree: 'lay-tree',
  outline: 'lay-outline',
} as const

/** Width of the editor/PDF divider (px); keep in sync with --lay-divider-w in layout.css. */
const DIVIDER_W = 8
const COLLAPSED_EPS = 0.5

/** Expand a collapsed panel; if it comes back tiny (no remembered size), give it `fallback`. */
function ensureExpanded(panel: PanelImperativeHandle | null, minPct: number, fallback: string): void {
  if (!panel) return
  if (panel.isCollapsed()) panel.expand()
  if (panel.getSize().asPercentage < minPct) panel.resize(fallback)
}

export function EditorLayout() {
  useAutoCompile()
  useChatUnread()
  useGlobalShortcuts()
  useProjectNotices()
  const focusMode = useLayout(s => s.focusMode)

  return (
    <div className={clsx('lay-root', focusMode && 'is-focus')}>
      {!focusMode && <TopBar />}
      <ConnectionBanner />
      <RecoveredTexts />
      <div className="lay-body">
        {!focusMode && <Rail />}
        <MainArea />
      </div>
      {focusMode && <ExitFocusButton />}
      <ModalHost />
    </div>
  )
}

function ExitFocusButton() {
  return (
    <Tooltip content={<>Show the toolbar and side panels again ({formatShortcut('Mod-Shift-m')})</>} side="top">
      <button type="button" className="lay-focusexit" onClick={() => useLayout.getState().setFocusMode(false)}>
        <Minimize2 size={14} aria-hidden="true" />
        Exit focus mode
      </button>
    </Tooltip>
  )
}

function MainArea() {
  const railPanel = useLayout(s => s.railPanel)
  const setRailPanel = useLayout(s => s.setRailPanel)
  const railRef = usePanelRef()
  const lastRail = useRef<RailPanel>(railPanel ?? 'files')
  if (railPanel) lastRail.current = railPanel

  const outer = useDefaultLayout({ id: ID.outer, storage: layoutStorage, onlySaveAfterUserInteractions: true })

  useEffect(() => {
    const p = railRef.current
    if (!p) return
    if (railPanel === null) {
      if (!p.isCollapsed()) p.collapse()
    } else {
      ensureExpanded(p, 5, '260px')
    }
  }, [railPanel, railRef])

  const onOuterChanged = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      outer.onLayoutChanged(layout, meta)
      if (!meta.isUserInteraction) return
      const size = layout[ID.railPanel] ?? 0
      const current = useLayout.getState().railPanel
      if (size <= COLLAPSED_EPS && current !== null) setRailPanel(null)
      else if (size > COLLAPSED_EPS && current === null) setRailPanel(lastRail.current)
    },
    [outer, setRailPanel],
  )

  return (
    <Group
      id={ID.outer}
      orientation="horizontal"
      className="lay-group"
      defaultLayout={outer.defaultLayout}
      onLayoutChanged={onOuterChanged}
    >
      <Panel
        id={ID.railPanel}
        panelRef={railRef}
        collapsible
        collapsedSize={0}
        minSize="180px"
        defaultSize="260px"
        maxSize="50%"
        groupResizeBehavior="preserve-pixel-size"
        className="lay-panel lay-railpanel"
        style={{ overflow: 'hidden' }}
        inert={railPanel === null}
      >
        <RailPanelContent active={railPanel ?? lastRail.current} />
      </Panel>
      <Separator id="lay-railpanel-sep" className="lay-sep lay-sep--rail" />
      <Panel id={ID.workPanel} minSize="30%" className="lay-panel" style={{ overflow: 'hidden' }}>
        <WorkArea />
      </Panel>
    </Group>
  )
}

/** Keeps each rail panel mounted after its first use so switching tabs preserves its state. */
function RailPanelContent({ active }: { active: RailPanel }) {
  const [visited, setVisited] = useState<Set<RailPanel>>(() => new Set([active]))
  useEffect(() => {
    setVisited(v => (v.has(active) ? v : new Set(v).add(active)))
  }, [active])
  return (
    <>
      {visited.has('files') && (
        <div className="lay-railpanel__view" hidden={active !== 'files'}>
          <FilesAndOutline />
        </div>
      )}
      {visited.has('search') && (
        <div className="lay-railpanel__view" hidden={active !== 'search'}>
          <SearchPanel />
        </div>
      )}
      {visited.has('chat') && (
        <div className="lay-railpanel__view" hidden={active !== 'chat'}>
          <ChatPanel />
        </div>
      )}
    </>
  )
}

function FilesAndOutline() {
  const outlineOpen = useLayout(s => s.outlineOpen)
  const setOutlineOpen = useLayout(s => s.setOutlineOpen)
  const outlineRef = usePanelRef()
  const files = useDefaultLayout({ id: ID.files, storage: layoutStorage, onlySaveAfterUserInteractions: true })

  useEffect(() => {
    const p = outlineRef.current
    if (!p) return
    if (!outlineOpen) {
      if (!p.isCollapsed()) p.collapse()
    } else if (p.isCollapsed()) {
      p.expand()
    }
  }, [outlineOpen, outlineRef])

  const onChanged = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      files.onLayoutChanged(layout, meta)
      if (!meta.isUserInteraction) return
      const collapsed = outlineRef.current?.isCollapsed() ?? false
      if (collapsed === useLayout.getState().outlineOpen) setOutlineOpen(!collapsed)
    },
    [files, outlineRef, setOutlineOpen],
  )

  return (
    <Group id={ID.files} orientation="vertical" className="lay-group" defaultLayout={files.defaultLayout} onLayoutChanged={onChanged}>
      <Panel id={ID.tree} minSize="20%" className="lay-panel" style={{ overflow: 'hidden' }}>
        <FileTreePanel />
      </Panel>
      <Separator id="lay-outline-sep" className="lay-sep lay-sep--h" />
      {/* Collapses down to the outline's own header row (--panel-header-h) so it can be reopened. */}
      <Panel
        id={ID.outline}
        panelRef={outlineRef}
        collapsible
        collapsedSize="34px"
        minSize="96px"
        defaultSize="35%"
        className="lay-panel"
        style={{ overflow: 'hidden' }}
      >
        <OutlinePanel />
      </Panel>
    </Group>
  )
}

function WorkArea() {
  const view = useLayout(s => s.view)
  const setView = useLayout(s => s.setView)
  const historyOpen = useLayout(s => s.historyOpen)
  const editorRef = usePanelRef()
  const pdfRef = usePanelRef()
  const work = useDefaultLayout({ id: ID.work, storage: layoutStorage, onlySaveAfterUserInteractions: true })
  const [editorPct, setEditorPct] = useState<number>(() => work.defaultLayout?.[ID.editor] ?? 50)

  // Apply the chosen view by collapsing/expanding panels (never unmounting them).
  useEffect(() => {
    const e = editorRef.current
    const p = pdfRef.current
    if (!e || !p) return
    if (view === 'split') {
      ensureExpanded(e, 15, '50%')
      ensureExpanded(p, 15, '50%')
    } else if (view === 'editor') {
      if (e.isCollapsed()) e.expand()
      if (!p.isCollapsed()) p.collapse()
    } else {
      if (p.isCollapsed()) p.expand()
      if (!e.isCollapsed()) e.collapse()
    }
  }, [view, editorRef, pdfRef])

  const onChanging = useCallback((layout: Layout) => {
    const pct = layout[ID.editor]
    if (typeof pct === 'number') setEditorPct(pct)
  }, [])

  const onChanged = useCallback(
    (layout: Layout, meta: LayoutChangedMeta) => {
      work.onLayoutChanged(layout, meta)
      onChanging(layout)
      if (!meta.isUserInteraction) return
      const e = layout[ID.editor] ?? 0
      const p = layout[ID.pdf] ?? 0
      const next: LayoutView = e <= COLLAPSED_EPS ? 'pdf' : p <= COLLAPSED_EPS ? 'editor' : 'split'
      if (next !== useLayout.getState().view) setView(next)
    },
    [work, onChanging, setView],
  )

  return (
    <div className="lay-work" style={{ ['--lay-divider-w' as string]: `${DIVIDER_W}px` }}>
      <Group
        id={ID.work}
        orientation="horizontal"
        className="lay-group"
        defaultLayout={work.defaultLayout}
        onLayoutChange={onChanging}
        onLayoutChanged={onChanged}
      >
        <Panel
          id={ID.editor}
          panelRef={editorRef}
          collapsible
          collapsedSize={0}
          minSize="18%"
          defaultSize="50%"
          className="lay-panel lay-editorpanel"
          style={{ overflow: 'hidden' }}
          inert={view === 'pdf'}
        >
          <EditorPane />
        </Panel>
        <Separator id="lay-divider" className="lay-sep lay-sep--divider" />
        <Panel
          id={ID.pdf}
          panelRef={pdfRef}
          collapsible
          collapsedSize={0}
          minSize="18%"
          defaultSize="50%"
          className="lay-panel lay-pdfpanel"
          style={{ overflow: 'hidden' }}
          inert={view === 'editor'}
        >
          <PdfPane />
        </Panel>
      </Group>
      {!historyOpen && <DividerControls view={view} editorPct={editorPct} onShow={setView} />}
      {historyOpen && (
        <div className="lay-history">
          <HistoryView />
        </div>
      )}
    </div>
  )
}

/**
 * Controls that sit on the editor/PDF divider. They are rendered outside the panel group,
 * stacked above it, so react-resizable-panels does not treat clicks on them as drags.
 */
function DividerControls({ view, editorPct, onShow }: { view: LayoutView; editorPct: number; onShow: (v: LayoutView) => void }) {
  const hasSync = useCompile(s => !!(s.lastWithPdf ?? s.last)?.hasSynctex)
  const openFileId = useEditor(s => s.openFileId)
  const openIsText = useProject(s => (openFileId ? s.files[openFileId]?.kind === 'text' : false))
  const [busy, setBusy] = useState<'code' | 'pdf' | null>(null)

  const run = async (dir: 'code' | 'pdf') => {
    if (busy) return
    setBusy(dir)
    try {
      await (dir === 'code' ? syncCodeToPdf() : syncPdfToCode())
    } catch (e) {
      toast(`SyncTeX didn’t work: ${errorMessage(e)}. Recompile and try again.`, { tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  if (view === 'editor') {
    return (
      <Tooltip content="Show the PDF next to the editor" side="left">
        <button type="button" className="lay-edgetab lay-edgetab--right" onClick={() => onShow('split')} aria-label="Show PDF">
          <PanelRightOpen size={16} aria-hidden="true" />
        </button>
      </Tooltip>
    )
  }
  if (view === 'pdf') {
    return (
      <Tooltip content="Show the editor next to the PDF" side="right">
        <button type="button" className="lay-edgetab lay-edgetab--left" onClick={() => onShow('split')} aria-label="Show editor">
          <PanelLeftOpen size={16} aria-hidden="true" />
        </button>
      </Tooltip>
    )
  }

  const left = `calc((100% - var(--lay-divider-w)) * ${editorPct / 100} + var(--lay-divider-w) / 2)`
  const codeHint = !hasSync ? 'Compile the project to enable SyncTeX' : !openIsText ? 'Open a text file first' : null
  return (
    <div className="lay-sync" style={{ left }} role="group" aria-label="SyncTeX">
      <Tooltip content={codeHint ?? 'Go to code location in PDF'} side="right">
        <button
          type="button"
          className={clsx('lay-sync__btn', busy === 'code' && 'is-busy')}
          aria-label="Go to code location in PDF"
          aria-disabled={codeHint ? true : undefined}
          onClick={() => {
            if (!codeHint) void run('code')
          }}
        >
          {busy === 'code' ? <Spinner size={12} label={null} /> : <ArrowRight size={14} aria-hidden="true" />}
        </button>
      </Tooltip>
      <Tooltip content={hasSync ? 'Go to PDF location in code (tip: double-click the PDF for best results)' : 'Compile the project to enable SyncTeX'} side="right">
        <button
          type="button"
          className={clsx('lay-sync__btn', busy === 'pdf' && 'is-busy')}
          aria-label="Go to PDF location in code"
          aria-disabled={hasSync ? undefined : true}
          onClick={() => {
            if (hasSync) void run('pdf')
          }}
        >
          {busy === 'pdf' ? <Spinner size={12} label={null} /> : <ArrowLeft size={14} aria-hidden="true" />}
        </button>
      </Tooltip>
    </div>
  )
}
