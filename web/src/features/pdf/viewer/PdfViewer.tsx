/**
 * React host of the pdf.js viewer. The controller (and pdf.js, ~1 MB) is loaded on demand; the
 * DOM inside the host belongs to pdf.js and is never rendered by React.
 *
 * Shows the PDF of `buildId` (a new build keeps zoom + scroll position), remembers the viewport
 * position per project and document (`docKey`: null for the main document, else the root
 * document's path), so reopening the project — or switching between the paper and its
 * supplement — returns to the same spot in each.
 */
import { useEffect, useRef } from 'react'
import { isRecord, readJSON, writeJSON } from '../../../lib/storage'
import { throttle, type Debounced } from '../../../lib/debounce'
import { initialScaleValue, rememberScaleValue } from '../zoom'
import { syncFromDoubleClick } from '../synctex'
import type { PdfController, ViewPosition } from './PdfController'
import { INITIAL_PDF_VIEW, getPdfController, setPdfController, usePdfView } from './store'

/** the main document keeps the per-project key it had before documents were told apart */
export const positionKey = (pid: string, docKey: string | null = null) => (docKey ? `folio:pdfpos:${pid}:${docKey}` : `folio:pdfpos:${pid}`)

function readPosition(pid: string, docKey: string | null): ViewPosition | null {
  return readJSON<ViewPosition | null>(positionKey(pid, docKey), null, v => {
    if (!isRecord(v)) return undefined
    const { page, left, top } = v
    if (typeof page !== 'number' || typeof left !== 'number' || typeof top !== 'number') return undefined
    if (!Number.isFinite(page) || !Number.isFinite(left) || !Number.isFinite(top) || page < 1) return undefined
    return { page: Math.floor(page), left, top }
  })
}

export interface PdfViewerProps {
  projectId: string
  pdfUrl: string | null
  buildId: string | null
  /** which root document the PDF is of (null: the main document) */
  docKey?: string | null
  /** bump to retry a failed load of the same build */
  reloadKey?: number
}

export function PdfViewer({ projectId, pdfUrl, buildId, docKey = null, reloadKey = 0 }: PdfViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const ctrlRef = useRef<PdfController | null>(null)
  const ready = usePdfView(s => s.controllerReady)

  useEffect(() => {
    let cancelled = false
    let ctrl: PdfController | null = null
    // one throttle per document, so switching documents never drops the last save of the other
    const savers = new Map<string, Debounced<[ViewPosition]>>()
    const savePosition = (pos: ViewPosition, doc: string | null) => {
      const key = positionKey(projectId, doc)
      let save = savers.get(key)
      if (!save) {
        save = throttle((p: ViewPosition) => writeJSON(key, p), 600)
        savers.set(key, save)
      }
      save(pos)
    }
    import('./PdfController')
      .then(mod => {
        const host = hostRef.current
        if (cancelled || !host) return
        ctrl = new mod.PdfController(
          host,
          {
            onView: patch => usePdfView.setState(patch),
            onDoubleClick: p => syncFromDoubleClick(p),
            onUserZoom: v => rememberScaleValue(v),
            onPosition: (pos, doc) => savePosition(pos, doc),
          },
          { initialScaleValue: initialScaleValue(), positionFor: doc => readPosition(projectId, doc) },
        )
        ctrlRef.current = ctrl
        setPdfController(ctrl)
      })
      .catch(e => {
        console.error('[pdf] loading the PDF viewer failed', e)
        if (!cancelled) usePdfView.setState({ status: 'error', error: 'The PDF viewer could not be loaded. Reload the page to try again.' })
      })
    return () => {
      cancelled = true
      for (const save of savers.values()) save.flush()
      if (ctrl) {
        ctrl.destroy()
        if (getPdfController() === ctrl) setPdfController(null)
      }
      ctrlRef.current = null
      usePdfView.setState({ ...INITIAL_PDF_VIEW })
    }
  }, [projectId])

  useEffect(() => {
    const ctrl = ctrlRef.current
    if (!ready || !ctrl) return
    if (!pdfUrl || !buildId) {
      if (ctrl.hasDocument || usePdfView.getState().status !== 'empty') ctrl.clear()
      return
    }
    if (ctrl.buildId === buildId && usePdfView.getState().status === 'ready') return
    ctrl.load(pdfUrl, buildId, docKey).catch(e => {
      console.warn('[pdf] could not load', pdfUrl, e)
    })
  }, [ready, pdfUrl, buildId, docKey, reloadKey])

  return <div ref={hostRef} className="pdf-viewer" />
}
