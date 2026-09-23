/**
 * The collaborative CodeMirror editor for one text file.
 *
 * Lifecycle: acquire the file's DocSession → wait for the first sync (spinner) → build the
 * EditorView (EditorController) → publish it (useEditor.setView), follow settings/theme/role
 * changes in place, apply jump requests, show compile diagnostics, report the cursor
 * (throttled) and the live outline (debounced). On unmount the cursor/scroll position is kept
 * (as encoded Y.RelativePositions, so remote edits do not shift it, plus line/column for a new
 * epoch) and the session is released. The line/column part is also remembered across reloads
 * and visits (./editorPositions, J-3): written about once a second while the cursor moves or the
 * editor scrolls, on unmount and when the page is left; a file opened for the first time in a
 * session starts there — unless a jump (outline, logs, SyncTeX, search) asked for a place.
 * Stale sessions (epoch bump / role change) are re-acquired; permanent closes (too large,
 * access) show an error state.
 *
 * Focus: a freshly synced editor takes the focus only when the user opened the file on purpose
 * or nothing else has it (see ./reveal). Jumps reveal the editor panel first and are applied
 * once the editor has a size (the "PDF only" layout collapses it to width 0).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import * as Y from 'yjs'
import { EditorView } from '@codemirror/view'
import { forEachDiagnostic, setDiagnostics } from '@codemirror/lint'
import { AlertTriangle, Download, FileWarning, RefreshCw } from 'lucide-react'
import { MAX_DOC_LENGTH, WS_CLOSE } from '@folio/shared/protocol'
import type { FileEntry } from '@folio/shared/api'
import { extractOutline } from '@folio/shared/latex'
import { api } from '../../api/endpoints'
import { debounce, throttle } from '../../lib/debounce'
import { downloadUrl } from '../../lib/download'
import { docSessions, type DocSession } from '../../realtime/docs'
import { onSignOut, useResolvedTheme, useSettings } from '../../stores/auth'
import { useCompile } from '../../stores/compile'
import { useEditor } from '../../stores/editor'
import { useProject } from '../../stores/project'
import { registerTestHook } from '../../stores/testHooks'
import { Button, EmptyState, Spinner, toast } from '../../ui'
import { useActiveDoc } from './activeDoc'
import { readStoredPosition, storePosition, type LineCol, type StoredPosition } from './editorPositions'
import { rememberDeletedText } from './openFileGuard'
import { projectIndex } from './projectIndex'
import { afterLayout, mayTakeFocus, revealEditorPanel, whenSized } from './reveal'
import { EditorController, docKindFor, revealLine, type EditorConfig } from './ext/setup'
import { diagnosticsFor } from './ext/diagnostics'
import { paletteFor } from './ext/theme'

type Phase =
  | { kind: 'loading' }
  | { kind: 'ready' }
  /** `afterSync`: the session had synced, so the server refused a later update (not the file) */
  | { kind: 'error'; code: number; afterSync: boolean }

/**
 * Cursor and scroll position of a file. The Y positions are kept encoded (never the Y.Doc
 * itself, which would keep every visited document and its provider alive) and are resolved
 * against the doc of whatever session of the same epoch shows the file next; line/column is the
 * fallback when they cannot be resolved (another epoch, the text was replaced).
 */
interface SavedViewState {
  epoch: number
  anchor: Uint8Array
  head: Uint8Array
  top: Uint8Array | null
  lines: StoredPosition
}

/** Document position at the top of the visible area (null when not scrolled). */
function topVisiblePos(view: EditorView): number | null {
  if (view.scrollDOM.scrollTop <= 0) return null
  const rect = view.scrollDOM.getBoundingClientRect()
  return view.lineBlockAtHeight(rect.top - view.documentTop + 1).from
}

/** Cursor + scroll position per file (kept while the project is open). */
const savedViews = new Map<string, SavedViewState>()
let savedFor: string | null = null
// positions belong to the account that was signed in (the next one may open the same project)
onSignOut(() => {
  savedViews.clear()
  savedFor = null
})
/** jump requests already applied (nonces are global and increasing) */
let handledJumpNonce = 0

/** file shown by each live view — lets the store drop a view the moment another file is opened */
const viewFiles = new WeakMap<EditorView, string>()
let viewGuardInstalled = false

/**
 * useEditor.openFile() changes openFileId synchronously while the old view is only torn down
 * when React commits; drop it from the store right away so `view` never belongs to another file
 * (menus, test hooks and helpers read both together).
 */
function installViewGuard(): void {
  if (viewGuardInstalled) return
  viewGuardInstalled = true
  useEditor.subscribe((s, prev) => {
    if (s.openFileId === prev.openFileId || !s.view) return
    if (viewFiles.get(s.view) !== s.openFileId) s.setView(null)
  })
}

const OUTLINE_DEBOUNCE_MS = 350
const CURSOR_THROTTLE_MS = 120
/** how often the position is written to localStorage while the cursor moves / the view scrolls */
const PERSIST_THROTTLE_MS = 1000

/** Line/column of the selection and the first visible line (`top`: a document position or null). */
function currentLines(view: EditorView, top: number | null): StoredPosition {
  const { main } = view.state.selection
  const doc = view.state.doc
  const len = doc.length
  const lineCol = (pos: number): LineCol => {
    const line = doc.lineAt(Math.min(pos, len))
    return { line: line.number, col: Math.min(pos, len) - line.from }
  }
  return { anchor: lineCol(main.anchor), head: lineCol(main.head), top: top !== null ? doc.lineAt(Math.min(top, len)).number : null }
}

/**
 * Remember the position across reloads (entries of files no longer in the project are dropped;
 * nothing is written for a file that was just deleted).
 */
function persistPosition(projectId: string, fileId: string, lines: StoredPosition): void {
  const p = useProject.getState()
  const known = p.projectId === projectId && p.loadState === 'ready' ? new Set(Object.keys(p.files)) : undefined
  if (known && known.size > 0 && !known.has(fileId)) return
  storePosition(projectId, fileId, lines, known)
}

/**
 * Keep the cursor and the top visible line of a file (in memory, and its line/column across
 * reloads). `top` is tracked while the view is attached (scroll events): at unmount time the
 * DOM is already detached and reports no scroll.
 */
function saveViewState(projectId: string, fileId: string, view: EditorView, session: DocSession, top: number | null): void {
  try {
    const { main } = view.state.selection
    const len = view.state.doc.length
    const rel = (pos: number) => Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(session.ytext, Math.min(pos, len)))
    const lines = currentLines(view, top)
    savedViews.set(fileId, {
      epoch: session.epoch,
      anchor: rel(main.anchor),
      head: rel(main.head),
      top: top !== null ? rel(top) : null,
      lines,
    })
    persistPosition(projectId, fileId, lines)
  } catch {
    // the document may have been torn down already; nothing to keep
  }
}

/**
 * The saved selection and scroll position of `fileId` in this session's document, if any: the
 * exact one kept while the project is open, else the line/column remembered from an earlier visit.
 */
function savedViewPositions(projectId: string, fileId: string, view: EditorView, session: DocSession): { anchor: number; head: number; top: number | null } | null {
  const saved = savedViews.get(fileId)
  const lines = saved?.lines ?? readStoredPosition(projectId, fileId)
  if (!lines) return null
  const doc = view.state.doc
  const len = doc.length
  const resolve = (bytes: Uint8Array): number | null => {
    try {
      const abs = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(bytes), session.ydoc)
      return abs && abs.type === session.ytext ? Math.min(abs.index, len) : null
    } catch {
      return null
    }
  }
  const fromLineCol = (lc: LineCol): number => {
    if (lc.line > doc.lines) return len
    const line = doc.line(Math.max(1, lc.line))
    return Math.min(line.from + lc.col, line.to)
  }
  if (saved && saved.epoch === session.epoch) {
    const anchor = resolve(saved.anchor)
    const head = resolve(saved.head)
    if (anchor !== null && head !== null) return { anchor, head, top: saved.top ? resolve(saved.top) : null }
  }
  const top = lines.top !== null ? doc.line(Math.min(Math.max(1, lines.top), doc.lines)).from : null
  return { anchor: fromLineCol(lines.anchor), head: fromLineCol(lines.head), top }
}

/**
 * Put back the cursor and scroll position; the scroll waits until the editor has a size.
 * Returns the restored top position and a canceller for the pending scroll.
 */
function restoreViewState(projectId: string, fileId: string, view: EditorView, session: DocSession): { top: number | null; cancel: (() => void) | null } {
  const pos = savedViewPositions(projectId, fileId, view, session)
  if (!pos) return { top: null, cancel: null }
  view.dispatch({ selection: { anchor: pos.anchor, head: pos.head } })
  const top = pos.top
  if (top === null) return { top: null, cancel: null }
  // no margin: the line above must not peek in, or it would be saved as the top line next time
  // and the position would creep up by a line per visit
  const cancel = whenSized(view, () => {
    if (view.dom.isConnected) view.dispatch({ effects: EditorView.scrollIntoView(Math.min(top, view.state.doc.length), { y: 'start', yMargin: 0 }) })
  })
  return { top, cancel }
}

export function SourceEditor({ file }: { file: FileEntry }) {
  const projectId = useProject(s => s.projectId)
  const role = useProject(s => s.role)
  const spellLang = useProject(s => s.settings?.spellLang ?? 'en')
  const settings = useSettings()
  const uiTheme = useResolvedTheme()
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const [ctrl, setCtrl] = useState<EditorController | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [slow, setSlow] = useState(false)
  /** cancels the scroll of a restored position that still waits for the editor's size */
  const cancelRestoreRef = useRef<(() => void) | null>(null)

  const readOnly = role === 'viewer'
  const config = useMemo<EditorConfig>(
    () => ({ settings, uiTheme, spellLang, path: file.path, readOnly }),
    [settings, uiTheme, spellLang, file.path, readOnly],
  )
  const configRef = useRef(config)
  configRef.current = config

  if (projectId !== savedFor) {
    savedViews.clear()
    savedFor = projectId
  }

  // -- session + view lifecycle -----------------------------------------------------------------
  useEffect(() => {
    if (!projectId) return
    const entry = useProject.getState().files[file.id] ?? file
    if (entry.kind !== 'text') return
    let disposed = false
    let controller: EditorController | null = null
    let scrollTopPos: number | null = null
    let offScroll: (() => void) | null = null
    const session = docSessions.acquire(projectId, entry)
    setPhase({ kind: 'loading' })
    setSlow(false)
    const slowTimer = setTimeout(() => setSlow(true), 4000)
    const fileId = entry.id
    const isLatex = docKindFor(entry.path) === 'latex'

    const publishOutline = debounce(() => {
      if (disposed || !controller) return
      useActiveDoc.setState({ outline: isLatex ? extractOutline(controller.view.state.doc.toString()) : [] })
    }, OUTLINE_DEBOUNCE_MS, { maxWait: 2000 })

    const reportCursor = throttle((view: EditorView) => {
      if (disposed) return
      const head = view.state.selection.main.head
      const line = view.state.doc.lineAt(head)
      useEditor.getState().setCursor({ fileId, line: line.number, column: head - line.from })
    }, CURSOR_THROTTLE_MS)

    // the position survives a reload: written while the cursor moves / the view scrolls (once
    // the saved position has been put back), and when the page is left (a reload unmounts nothing)
    let restored = false
    const persistNow = () => {
      const view = controller?.view
      if (!view || !view.dom.isConnected) return
      // an editor without a size ("PDF only" collapses it to width 0) has not scrolled to the
      // restored position yet and reports no scroll: keep the last known top
      const sized = view.scrollDOM.clientWidth > 0 && view.scrollDOM.clientHeight > 0
      const top = sized ? topVisiblePos(view) : scrollTopPos
      persistPosition(projectId, fileId, currentLines(view, top))
    }
    const persist = throttle(() => {
      if (!disposed && restored) persistNow()
    }, PERSIST_THROTTLE_MS)
    const onPageHide = () => {
      if (disposed || !restored) return
      persist.cancel()
      persistNow()
    }
    window.addEventListener('pagehide', onPageHide)

    const offStale = docSessions.onStale(id => {
      if (id === fileId && !disposed) setAttempt(a => a + 1)
    })
    const offClosed = docSessions.onClosed((id, code) => {
      if (id !== fileId || disposed) return
      // the session is dead: drop the view (its edits could not reach the server any more)
      if (controller) {
        offScroll?.()
        persist.cancel()
        saveViewState(projectId, fileId, controller.view, session, scrollTopPos)
        if (useEditor.getState().view === controller.view) useEditor.getState().setView(null)
        controller.destroy()
        controller = null
        setCtrl(null)
      }
      useActiveDoc.setState({ status: 'disconnected', closed: true })
      setPhase({ kind: 'error', code, afterSync: session.isSynced() })
    })
    const offStatus = session.onStatus(status => {
      if (!disposed) useActiveDoc.setState({ status })
    })
    useActiveDoc.setState({ fileId, outline: [], outlineSupported: isLatex, status: session.status, closed: false })

    void session.synced.then(() => {
      if (disposed || !hostRef.current) return
      clearTimeout(slowTimer)
      controller = new EditorController(hostRef.current, session, configRef.current, {
        onDocChange: () => publishOutline(),
        onCursor: view => {
          reportCursor(view)
          persist()
        },
        onRejectedChange: () => {
          toast(`That change was not applied: documents edited in the browser are limited to ${formatLimit()}.`, { tone: 'warning', id: 'ed-too-large' })
        },
      })
      const view = controller.view
      const jump = useEditor.getState().jumpRequest
      const pendingJump = jump && jump.fileId === fileId && jump.nonce > handledJumpNonce
      if (!pendingJump) {
        const saved = restoreViewState(projectId, fileId, view, session)
        // until the view scrolls, the restored top is the position to keep
        scrollTopPos = saved.top
        cancelRestoreRef.current = saved.cancel
      }
      restored = true
      const trackScroll = throttle(() => {
        if (disposed || !view.dom.isConnected) return
        scrollTopPos = topVisiblePos(view)
        persist()
      }, 150)
      view.scrollDOM.addEventListener('scroll', trackScroll, { passive: true })
      offScroll = () => {
        trackScroll.cancel()
        view.scrollDOM.removeEventListener('scroll', trackScroll)
      }
      viewFiles.set(view, fileId)
      installViewGuard()
      if (useEditor.getState().openFileId === fileId) useEditor.getState().setView(view)
      useActiveDoc.setState({
        fileId,
        outline: isLatex ? extractOutline(view.state.doc.toString()) : [],
        outlineSupported: isLatex,
        status: session.status,
      })
      reportCursor(view)
      projectIndex.refreshLive(fileId)
      setCtrl(controller)
      setPhase({ kind: 'ready' })
      if (!pendingJump && !readOnlyNow() && mayTakeFocus(fileId)) view.focus()
    })

    return () => {
      disposed = true
      clearTimeout(slowTimer)
      offStale()
      offClosed()
      offStatus()
      publishOutline.cancel()
      reportCursor.cancel()
      persist.cancel()
      window.removeEventListener('pagehide', onPageHide)
      cancelRestoreRef.current?.()
      cancelRestoreRef.current = null
      offScroll?.()
      if (controller) {
        saveViewState(projectId, fileId, controller.view, session, scrollTopPos)
        // the file was deleted: keep its text for the "was deleted" notice (it may hold edits
        // the server never got)
        if (session.closeCode === WS_CLOSE.GONE) rememberDeletedText(fileId, controller.view.state.doc.toString())
        if (useEditor.getState().view === controller.view) useEditor.getState().setView(null)
        controller.destroy()
        controller = null
      }
      setCtrl(null)
      if (useActiveDoc.getState().fileId === fileId) useActiveDoc.setState({ fileId: null, outline: [], outlineSupported: false })
      docSessions.release(session)
    }
    // the file entry object changes on every save; only identity/epoch matter here
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, file.id, file.epoch, attempt, docKindFor(file.path)])

  // -- settings, theme, role, path ----------------------------------------------------------------
  useEffect(() => {
    ctrl?.update(config)
  }, [ctrl, config])

  // -- jump requests (logs, SyncTeX, search, outline) ------------------------------------------
  // (the editor panel may be collapsed — "PDF only" — or under the History overlay: reveal it and
  // apply the jump once the editor has a size, else the target line ends up off screen)
  useEffect(() => {
    if (!ctrl) return
    const view = ctrl.view
    let cancelPending: (() => void) | null = null
    const apply = () => {
      const req = useEditor.getState().jumpRequest
      if (!req || req.fileId !== file.id || req.nonce <= handledJumpNonce) return
      handledJumpNonce = req.nonce
      // an explicit jump wins over a restored position still waiting to scroll
      cancelRestoreRef.current?.()
      cancelRestoreRef.current = null
      cancelPending?.()
      const go = () => {
        cancelPending = whenSized(view, () => {
          cancelPending = null
          revealLine(view, req.line, req.column)
          focusSoon(view)
        })
      }
      // the editor panel is being shown (or resized): jump once it has its final width
      if (revealEditorPanel()) cancelPending = afterLayout(go)
      else go()
    }
    apply()
    const off = useEditor.subscribe((s, prev) => {
      if (s.jumpRequest !== prev.jumpRequest) apply()
    })
    return () => {
      off()
      cancelPending?.()
    }
  }, [ctrl, file.id])

  // -- compile diagnostics ----------------------------------------------------------------------
  const log = useCompile(s => s.last?.log ?? null)
  useEffect(() => {
    if (!ctrl) return
    const view = ctrl.view
    view.dispatch(setDiagnostics(view.state, diagnosticsFor(log, file.path, view.state.doc)))
  }, [ctrl, log, file.path])

  const palette = paletteFor(settings.editorTheme, uiTheme)

  return (
    <div
      className="ed-editor"
      data-ed-theme={palette}
      data-testid="source-editor"
      style={{ ['--ed-font' as string]: `var(--font-editor-${settings.fontFamily}, var(--font-mono))` }}
    >
      <div ref={hostRef} className="ed-editor__host" hidden={phase.kind === 'error'} />
      {phase.kind === 'loading' && <LoadingState path={file.path} slow={slow} />}
      {phase.kind === 'error' && <ErrorState file={file} code={phase.code} afterSync={phase.afterSync} onRetry={() => setAttempt(a => a + 1)} />}
    </div>
  )
}

/** Test hook: the diagnostics shown in the active editor, with 1-based line numbers. */
registerTestHook('editorDiagnostics', () => {
  const view = useEditor.getState().view
  if (!view) return []
  const out: { line: number; severity: string; message: string; text: string }[] = []
  forEachDiagnostic(view.state, (d, from, to) => {
    out.push({ line: view.state.doc.lineAt(from).number, severity: d.severity, message: d.message, text: view.state.sliceDoc(from, to) })
  })
  return out
})

/**
 * Focus the editor; when that does not take (the History overlay closing this very moment still
 * makes the editor inert), try again on the next frames.
 */
function focusSoon(view: EditorView, tries = 3): void {
  view.focus()
  if (view.hasFocus || tries <= 0) return
  requestAnimationFrame(() => {
    if (view.dom.isConnected) focusSoon(view, tries - 1)
  })
}

function readOnlyNow(): boolean {
  return useProject.getState().role === 'viewer'
}

function LoadingState({ path, slow }: { path: string; slow: boolean }) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return (
    <div className="ed-editor__overlay" role="status" aria-live="polite">
      <div className="ed-editor__loading">
        <Spinner size={18} label={null} />
        <span>{slow ? `Still connecting to ${name}…` : `Opening ${name}…`}</span>
      </div>
    </div>
  )
}

/** "2 MB" */
function formatLimit(): string {
  return `${Math.round(MAX_DOC_LENGTH / (1024 * 1024))} MB`
}

function ErrorState({ file, code, afterSync, onRetry }: { file: FileEntry; code: number; afterSync: boolean; onRetry: () => void }) {
  const projectId = useProject(s => s.projectId)
  // too large when opened: the file itself cannot be edited here. Too large after it had synced:
  // the server refused one change (e.g. a huge paste); the file on the server is fine.
  const fileTooLarge = code === WS_CLOSE.TOO_LARGE && !afterSync
  const changeTooLarge = code === WS_CLOSE.TOO_LARGE && afterSync
  const access = code === WS_CLOSE.FORBIDDEN || code === WS_CLOSE.NOT_FOUND || code === WS_CLOSE.UNAUTHORIZED
  const title = fileTooLarge
    ? 'This file is too large to edit'
    : changeTooLarge
      ? 'Your last change was not applied'
      : access ? 'You can’t open this file right now' : 'The connection to this file was closed'
  const text = fileTooLarge
    ? `Documents over ${formatLimit()} can’t be edited in the browser. Download the file to work on it locally, or split it into smaller files with \\input.`
    : changeTooLarge
      ? `It would have made this document larger than ${formatLimit()}, the limit for editing in the browser. The file itself is unchanged and everything before that change is saved. Reload the file to continue editing.`
      : access
        ? 'Your access to this project may have changed. Folio is checking; reload the file once it has finished.'
        : 'The server rejected an update from this editor. Reload the file to continue — your synced changes are safe.'
  return (
    <div className="ed-editor__overlay">
      <EmptyState
        icon={fileTooLarge || changeTooLarge ? FileWarning : AlertTriangle}
        title={title}
        actions={
          <>
            {!fileTooLarge && (
              <Button variant="primary" icon={RefreshCw} onClick={onRetry}>
                Reload file
              </Button>
            )}
            {projectId && (
              <Button icon={Download} onClick={() => downloadUrl(api.rawFileUrl(projectId, file.id, { download: true }), file.path.slice(file.path.lastIndexOf('/') + 1))}>
                Download
              </Button>
            )}
          </>
        }
      >
        {text}
      </EmptyState>
    </div>
  )
}
