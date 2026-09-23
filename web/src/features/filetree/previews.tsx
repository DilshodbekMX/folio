/**
 * Preview building blocks shared by BinaryPreview and the history view:
 *   ImagePreview   — <img> with fit / actual-size toggle, checkerboard for transparency
 *   PdfPagePreview — one PDF page rendered with pdf.js into a canvas (page navigation optional)
 *   TextExcerpt    — the first part of a text-like file that is not editable (too large / not UTF-8)
 * pdf.js is loaded lazily (its own chunk) the first time a PDF preview is shown.
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { ChevronLeft, ChevronRight, ImageOff, Maximize2, Minimize2 } from 'lucide-react'
import { PDFJS_ASSET_BASE } from '@folio/shared/api'
import { IconButton, Spinner } from '../../ui'
import './filetree.css'

type PdfjsModule = typeof import('pdfjs-dist')
type PdfDocument = Awaited<ReturnType<PdfjsModule['getDocument']>['promise']>

let pdfjsPromise: Promise<PdfjsModule> | null = null

/** Load pdf.js once (worker via Vite `?url`, as the PDF viewer does). */
export function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')])
    .then(([lib, worker]) => {
      if (!lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = worker.default
      return lib
    })
    .catch(e => {
      pdfjsPromise = null
      throw e
    })
  return pdfjsPromise
}

// ---------------------------------------------------------------------------------------------
// image
// ---------------------------------------------------------------------------------------------

export function ImagePreview({ src, alt, className, onSize, allowZoom = true }: {
  src: string
  alt: string
  className?: string
  onSize?: (w: number, h: number) => void
  allowZoom?: boolean
}) {
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [actual, setActual] = useState(false)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)

  useEffect(() => {
    setStatus('loading')
    setSize(null)
  }, [src])

  return (
    <div className={clsx('ft-imgview', actual && 'is-actual', className)}>
      {status === 'loading' && (
        <div className="ft-viewstate">
          <Spinner size={18} label="Loading preview" />
        </div>
      )}
      {status === 'error' && (
        <div className="ft-viewstate ft-viewstate--error">
          <ImageOff size={20} aria-hidden="true" />
          <span>The image could not be displayed.</span>
        </div>
      )}
      <div className="ft-imgview__scroll" hidden={status !== 'ready'}>
        <img
          src={src}
          alt={alt}
          className="ft-imgview__img"
          draggable={false}
          onLoad={e => {
            const img = e.currentTarget
            setStatus('ready')
            setSize({ w: img.naturalWidth, h: img.naturalHeight })
            onSize?.(img.naturalWidth, img.naturalHeight)
          }}
          onError={() => setStatus('error')}
          onClick={() => allowZoom && setActual(a => !a)}
        />
      </div>
      {allowZoom && status === 'ready' && size && (
        <div className="ft-imgview__tools">
          <IconButton
            size="sm"
            variant="secondary"
            icon={actual ? Minimize2 : Maximize2}
            label={actual ? 'Fit to window' : 'Actual size (100%)'}
            onClick={() => setActual(a => !a)}
          />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------------------------

export function PdfPagePreview({ url, className, navigation = true, onInfo }: {
  url: string
  className?: string
  /** show page navigation for multi-page documents */
  navigation?: boolean
  onInfo?: (info: { pages: number; width: number; height: number }) => void
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const [doc, setDoc] = useState<PdfDocument | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [rendering, setRendering] = useState(true)
  const [box, setBox] = useState({ w: 0, h: 0 })
  const onInfoRef = useRef(onInfo)
  onInfoRef.current = onInfo

  // load the document
  useEffect(() => {
    let cancelled = false
    let task: ReturnType<PdfjsModule['getDocument']> | null = null
    setDoc(null)
    setError(null)
    setPage(1)
    setRendering(true)
    loadPdfjs()
      .then(lib => {
        if (cancelled) return
        task = lib.getDocument({
          url,
          cMapUrl: `${PDFJS_ASSET_BASE}cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${PDFJS_ASSET_BASE}standard_fonts/`,
          wasmUrl: `${PDFJS_ASSET_BASE}wasm/`,
          iccUrl: `${PDFJS_ASSET_BASE}iccs/`,
          enableXfa: false,
        })
        return task.promise
      })
      .then(d => {
        if (!d) return
        if (cancelled) {
          void d.loadingTask.destroy()
          return
        }
        setDoc(d)
      })
      .catch((e: unknown) => {
        if (cancelled) return
        setError(e instanceof Error && /password/i.test(e.message) ? 'This PDF is password protected.' : 'The PDF could not be displayed.')
        setRendering(false)
      })
    return () => {
      cancelled = true
      void task?.destroy()
    }
  }, [url])

  useEffect(() => () => {
    void doc?.loadingTask.destroy()
  }, [doc])

  // track the available width
  useEffect(() => {
    const el = wrapRef.current
    if (!el) return
    const ro = new ResizeObserver(entries => {
      const r = entries[0]?.contentRect
      const w = Math.floor(r?.width ?? 0)
      const h = Math.floor(r?.height ?? 0)
      setBox(prev => (Math.abs(prev.w - w) > 4 || Math.abs(prev.h - h) > 4 ? { w, h } : prev))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // render the current page
  useEffect(() => {
    if (!doc || box.w <= 0) return
    let cancelled = false
    let renderTask: { cancel(): void; promise: Promise<void> } | null = null
    setRendering(true)
    ;(async () => {
      const p = await doc.getPage(Math.min(page, doc.numPages))
      if (cancelled) return
      const base = p.getViewport({ scale: 1 })
      // fit the whole page (figures are often tiny: never blow them up more than 4×)
      const fitW = Math.min(box.w - 8, 1100) / base.width
      const fitH = box.h > 240 ? (box.h - (doc.numPages > 1 && navigation ? 56 : 8)) / base.height : Infinity
      const scale = Math.max(0.1, Math.min(fitW, fitH, 4))
      const viewport = p.getViewport({ scale })
      const dpr = Math.min(window.devicePixelRatio || 1, 3)
      const canvas = canvasRef.current
      if (!canvas) return
      canvas.width = Math.floor(viewport.width * dpr)
      canvas.height = Math.floor(viewport.height * dpr)
      canvas.style.width = `${Math.floor(viewport.width)}px`
      canvas.style.height = `${Math.floor(viewport.height)}px`
      renderTask = p.render({ canvas, viewport, transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined })
      await renderTask.promise
      if (cancelled) return
      setRendering(false)
      onInfoRef.current?.({ pages: doc.numPages, width: base.width, height: base.height })
    })().catch((e: unknown) => {
      if (cancelled || (e instanceof Error && e.name === 'RenderingCancelledException')) return
      setError('The PDF could not be displayed.')
      setRendering(false)
    })
    return () => {
      cancelled = true
      renderTask?.cancel()
    }
  }, [doc, page, box, navigation])

  const pages = doc?.numPages ?? 0
  return (
    <div ref={wrapRef} className={clsx('ft-pdfview', className)}>
      {error ? (
        <div className="ft-viewstate ft-viewstate--error">
          <ImageOff size={20} aria-hidden="true" />
          <span>{error}</span>
        </div>
      ) : (
        <>
          <div className="ft-pdfview__page">
            <canvas ref={canvasRef} className={clsx('ft-pdfview__canvas', rendering && 'is-rendering')} aria-label={`Page ${page} of the PDF`} role="img" />
            {rendering && (
              <div className="ft-viewstate ft-viewstate--overlay">
                <Spinner size={18} label="Rendering PDF" />
              </div>
            )}
          </div>
          {navigation && pages > 1 && (
            <div className="ft-pdfview__nav" role="group" aria-label="Pages">
              <IconButton size="sm" icon={ChevronLeft} label="Previous page" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))} />
              <span className="ft-pdfview__count" aria-live="polite">
                Page {page} of {pages}
              </span>
              <IconButton size="sm" icon={ChevronRight} label="Next page" disabled={page >= pages} onClick={() => setPage(p => Math.min(pages, p + 1))} />
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// text excerpt
// ---------------------------------------------------------------------------------------------

const EXCERPT_BYTES = 256 * 1024

/** First EXCERPT_BYTES of a same-origin URL decoded as text (UTF-8, falling back to Latin-1). */
async function fetchExcerpt(url: string, signal: AbortSignal): Promise<{ text: string; truncated: boolean }> {
  const res = await fetch(url, { credentials: 'same-origin', signal })
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.byteLength
    if (total >= EXCERPT_BYTES) {
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
  }
  const bytes = new Uint8Array(Math.min(total, EXCERPT_BYTES))
  let off = 0
  for (const c of chunks) {
    const n = Math.min(c.byteLength, bytes.byteLength - off)
    bytes.set(c.subarray(0, n), off)
    off += n
    if (off >= bytes.byteLength) break
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: !truncated }).decode(bytes)
  } catch {
    text = new TextDecoder('latin1').decode(bytes)
  }
  return { text: text.replace(/\r\n?/g, '\n'), truncated }
}

export function TextExcerpt({ url }: { url: string }) {
  const [state, setState] = useState<{ text: string; truncated: boolean } | 'loading' | 'error'>('loading')
  useEffect(() => {
    const ctrl = new AbortController()
    setState('loading')
    fetchExcerpt(url, ctrl.signal).then(setState, () => {
      if (!ctrl.signal.aborted) setState('error')
    })
    return () => ctrl.abort()
  }, [url])
  if (state === 'loading') {
    return (
      <div className="ft-viewstate">
        <Spinner size={18} label="Loading" />
      </div>
    )
  }
  if (state === 'error') return <div className="ft-viewstate ft-viewstate--error">The file could not be read.</div>
  return (
    <div className="ft-textview">
      <pre className="ft-textview__pre">{state.text}</pre>
      {state.truncated && <div className="ft-textview__more">Showing the first 256 KB. Download the file to see all of it.</div>}
    </div>
  )
}
