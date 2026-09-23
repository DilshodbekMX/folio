/**
 * pdf.js bootstrap (pdfjs-dist 6.3.289). Import this module BEFORE 'pdfjs-dist/web/pdf_viewer.mjs':
 * pdf_viewer.mjs destructures `globalThis.pdfjsLib` while it is evaluated, and ES modules are
 * evaluated in import order, so the core library (which sets that global) must come first.
 *
 * The worker is a separate module chunk resolved by Vite (`?url`); the asset folders (cmaps,
 * standard fonts, wasm decoders, ICC profiles) are served by the Folio server under /pdfjs/.
 */
import * as pdfjsLib from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { PDFJS_ASSET_BASE } from '@folio/shared/api'

pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl

const g = globalThis as { pdfjsLib?: unknown }
if (!g.pdfjsLib) g.pdfjsLib = pdfjsLib

/** getDocument() options shared by every load (option names checked against the 6.3.289 types). */
export const DOCUMENT_ASSET_OPTIONS = {
  cMapUrl: `${PDFJS_ASSET_BASE}cmaps/`,
  cMapPacked: true,
  standardFontDataUrl: `${PDFJS_ASSET_BASE}standard_fonts/`,
  wasmUrl: `${PDFJS_ASSET_BASE}wasm/`,
  iccUrl: `${PDFJS_ASSET_BASE}iccs/`,
  enableXfa: false,
} as const

export { pdfjsLib }
