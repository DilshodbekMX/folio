/**
 * The PDF pane (SPEC §6.7/§6.8): toolbar, pdf.js viewer, compile states and the logs pane.
 *
 * The pane is never unmounted while the project is open (the layout collapses it to width 0 in
 * "editor only" view); the viewer keeps its document, zoom and scroll position across that and
 * across recompiles. What is displayed:
 *   - the PDF of useCompile.lastWithPdf (an older PDF stays visible while a later compile failed,
 *     with a banner explaining it);
 *   - no PDF at all: the first-compile call to action, or the failure of the latest compile;
 *   - the logs pane (useCompile.logsOpen) on top of the viewer, like Overleaf.
 *
 * Module layout: viewer/ (pdf.js controller, React host, view store), CompileButton, PdfToolbar,
 * PdfStates (empty/failure/banner), synctex.ts, autoCompile.ts, useRemoteCompiles, zoom.ts.
 *
 * Deviations (documented, public contract unchanged):
 *   - The viewer is double-buffered (two PDFViewer instances; a new build renders hidden and
 *     swaps in when the pages in view are painted) instead of one viewer with the min-height
 *     trick from the research notes: recompiles never flash blank pages.
 *   - Auto-compile also waits while the PDF is not on screen ("editor only" layout, history) or
 *     the browser tab is hidden, and runs the queued compile when it is shown again (Overleaf
 *     only auto-compiles with the PDF visible).
 *   - Auto-compile reacts to this user's own changes only (collaborators' clients compile theirs;
 *     everyone gets the result through 'compile:done'), and compiles once when a project opens
 *     without an up-to-date build (see autoCompile.ts).
 *   - Viewers can recompile by hand; a compile builds the open document when it has its own
 *     \documentclass (stores/compile.ts openRootFileId).
 *   - Several root documents (paper + supplement): each client shows the PDF of the document it
 *     compiled or has open (useCompile.root); a co-author's build of another document never
 *     replaces it. The toolbar names the document when it is not the main one.
 *   - A collaborator's build that refreshes the PDF shows a short "PDF updated by X" notice in
 *     the pane (once per burst of their compiles, not while you type) instead of a toast.
 *   - The compile options menu has no "Syntax checks" group: Folio has no chktex pre-check.
 *   - "Download PDF" fetches the bytes and saves them as "<project name>.pdf" (another root
 *     document: "<project name> - <jobname>.pdf"): the build URL's Content-Disposition names the
 *     file after the job, and browsers prefer it over the download attribute.
 *   - Besides settings.pdfZoom, the viewport position is remembered per project and document in
 *     localStorage ('folio:pdfpos:<projectId>' for the main document, '…:<rootPath>' for others)
 *     so reopening a project, or switching between the paper and its supplement, returns to the
 *     same spot; a document seen for the first time opens at page 1.
 *   - Extra test hooks: window.__folio.usePdfView, window.__folio.pdfController(),
 *     window.__folio.useAutoCompileState.
 */
import { useEffect, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { useCompile } from '../../stores/compile'
import { useProject } from '../../stores/project'
import { LogsPane } from '../logs/LogsPane'
import { loadInitialBuild } from './initialBuild'
import { PdfToolbar } from './PdfToolbar'
import { CompileBanner, CompileFailure, FirstCompile, ViewerError } from './PdfStates'
import { useRemoteCompiles } from './useRemoteCompiles'
import { PdfViewer } from './viewer/PdfViewer'
import { usePdfView } from './viewer/store'
import './pdf.css'

/** Tracks the initial "last build" request so the pane doesn't flash the call to action. */
function useInitialLoad(projectId: string | null): boolean {
  const [loading, setLoading] = useState(() => useCompile.getState().last === null)
  useEffect(() => {
    if (!projectId) return
    if (useCompile.getState().last !== null) {
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    void loadInitialBuild(projectId).finally(() => {
      if (alive) setLoading(false)
    })
    return () => {
      alive = false
    }
  }, [projectId])
  return loading
}

export function PdfPane() {
  const projectId = useProject(s => s.projectId)
  const last = useCompile(s => s.last)
  const lastWithPdf = useCompile(s => s.lastWithPdf)
  const compiling = useCompile(s => s.status === 'compiling')
  const runningAuto = useCompile(s => s.runningAuto)
  const logsOpen = useCompile(s => s.logsOpen)
  const viewStatus = usePdfView(s => s.status)
  const viewError = usePdfView(s => s.error)
  const shownBuild = usePdfView(s => s.buildId)
  const { compilingBy: remoteBy, updatedBy } = useRemoteCompiles()
  const mainPath = useProject(s => (s.settings?.rootFileId ? (s.files[s.settings.rootFileId]?.path ?? null) : null))
  const initialLoading = useInitialLoad(projectId)
  const [reloadKey, setReloadKey] = useState(0)

  const pdfUrl = lastWithPdf?.pdfUrl ?? null
  const buildId = lastWithPdf?.pdfUrl ? lastWithPdf.buildId : null
  // the viewer remembers its position per document (null: the main document)
  const docKey = lastWithPdf?.rootPath && lastWithPdf.rootPath !== mainPath ? lastWithPdf.rootPath : null

  let overlay: ReactNode = null
  if (!pdfUrl) {
    if (last && last.status !== 'success' && !compiling) overlay = <CompileFailure build={last} />
    else overlay = <FirstCompile loading={initialLoading && !compiling && !last} recompiling={last !== null} />
  } else if (viewStatus === 'error' && !shownBuild) {
    overlay = <ViewerError message={viewError ?? 'The PDF could not be displayed.'} onRetry={() => setReloadKey(k => k + 1)} />
  } else if (viewStatus === 'loading' || (viewStatus === 'empty' && pdfUrl)) {
    overlay = (
      <div className="pdf-state pdf-state--quiet pdf-state--overlay" aria-busy="true">
        <span className="pdf-loading">Loading PDF…</span>
      </div>
    )
  }

  const busy = compiling || remoteBy !== null
  const busyLabel = compiling ? (runningAuto ? 'Auto-compiling' : 'Compiling') : remoteBy ? `${remoteBy.name} is compiling` : ''

  return (
    <div className="pdf-pane">
      <PdfToolbar />
      <div className="pdf-body">
        <div className={clsx('pdf-progress', busy && 'is-active')} role={busy ? 'progressbar' : undefined} aria-label={busy ? busyLabel : undefined} aria-hidden={!busy}>
          <span className="pdf-progress__bar" />
        </div>
        {remoteBy && !compiling ? (
          <div className="pdf-remote" role="status">
            {remoteBy.name} is compiling…
          </div>
        ) : (
          updatedBy && (
            <div className="pdf-remote pdf-remote--updated" role="status">
              PDF updated by {updatedBy.name}
            </div>
          )
        )}
        <CompileBanner />
        {viewStatus === 'ready' && viewError && (
          <div className="pdf-banner pdf-banner--warning" role="alert">
            <p className="pdf-banner__text">
              <strong>The new PDF couldn’t be displayed.</strong> {viewError}
            </p>
            <button type="button" className="pdf-banner__action" onClick={() => setReloadKey(k => k + 1)}>
              Try again
            </button>
          </div>
        )}
        <div className="pdf-stage" inert={logsOpen}>
          {projectId && <PdfViewer projectId={projectId} pdfUrl={pdfUrl} buildId={buildId} docKey={docKey} reloadKey={reloadKey} />}
          {overlay}
        </div>
        {logsOpen && (
          <div className="pdf-logs">
            <LogsPane />
          </div>
        )}
      </div>
    </div>
  )
}
