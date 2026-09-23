/**
 * State of the PDF viewer on screen (page, zoom, loaded build) + access to the live controller.
 *
 * The controller (PdfController, pdf.js) is loaded lazily; this module only holds a type
 * reference so the pdf.js bundle stays out of the main chunk. React components read the zustand
 * store; non-React code (synctex.ts, keyboard handlers) uses getPdfController().
 */
import { create } from 'zustand'
import { registerTestHook } from '../../../stores/testHooks'
import type { PdfController } from './PdfController'

export type PdfDocStatus = 'empty' | 'loading' | 'ready' | 'error'

export interface PdfViewState {
  /** the pdf.js module is loaded and a controller exists */
  controllerReady: boolean
  status: PdfDocStatus
  /** why the current PDF could not be shown */
  error: string | null
  /** build whose PDF is on screen (null while none is shown) */
  buildId: string | null
  /** 1-based page at the top of the viewport */
  page: number
  pages: number
  /** numeric scale (1 = 100 %) */
  scale: number
  /** pdf.js scale value: 'page-width' | 'page-fit' | 'auto' | numeric string */
  scaleValue: string
}

export const INITIAL_PDF_VIEW: PdfViewState = {
  controllerReady: false,
  status: 'empty',
  error: null,
  buildId: null,
  page: 0,
  pages: 0,
  scale: 1,
  scaleValue: 'page-width',
}

export const usePdfView = create<PdfViewState>()(() => ({ ...INITIAL_PDF_VIEW }))

let controller: PdfController | null = null

// Playwright: window.__folio.usePdfView / window.__folio.pdfController()
registerTestHook('usePdfView', usePdfView)
registerTestHook('pdfController', () => controller)

export function setPdfController(c: PdfController | null): void {
  controller = c
  usePdfView.setState({ controllerReady: c !== null })
}

export function getPdfController(): PdfController | null {
  return controller
}

/**
 * Resolves true once the PDF of `buildId` is on screen (or false after `timeoutMs`, or when
 * another build/an error takes its place).
 */
export function whenPdfShown(buildId: string, timeoutMs = 15_000): Promise<boolean> {
  const done = (s: PdfViewState) => s.buildId === buildId && s.status === 'ready'
  if (done(usePdfView.getState())) return Promise.resolve(true)
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsub = usePdfView.subscribe(s => {
      if (done(s)) finish(true)
      else if (s.status === 'error' || s.status === 'empty') finish(false)
    })
    const finish = (v: boolean) => {
      unsub()
      if (timer !== null) clearTimeout(timer)
      resolve(v)
    }
    timer = setTimeout(() => finish(false), timeoutMs)
  })
}
