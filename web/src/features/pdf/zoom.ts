/**
 * PDF zoom values. pdf.js takes a "scale value": a preset ('page-width', 'page-fit', 'auto', …)
 * or a number as a string ('1.5' = 150 %). The user's choice is remembered in
 * useAuth settings.pdfZoom (debounced, so Ctrl+wheel zooming does not flood the server).
 */
import { debounce } from '../../lib/debounce'
import { getSettings, useAuth } from '../../stores/auth'

export const MIN_SCALE = 0.1
export const MAX_SCALE = 25
export const DEFAULT_SCALE_VALUE = 'page-width'

const PRESETS = ['page-width', 'page-fit', 'page-height', 'auto', 'page-actual'] as const
export type ScalePreset = (typeof PRESETS)[number]

export function isPreset(v: string): v is ScalePreset {
  return (PRESETS as readonly string[]).includes(v)
}

/** Percent steps offered in the zoom menu. */
export const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4] as const

/** A safe pdf.js scale value from untrusted input (settings, storage); falls back to fit-width. */
export function normalizeScaleValue(v: unknown): string {
  if (typeof v === 'string' && isPreset(v)) return v
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN
  if (Number.isFinite(n) && n >= MIN_SCALE && n <= MAX_SCALE) return String(Math.round(n * 1000) / 1000)
  return DEFAULT_SCALE_VALUE
}

/** Label for the zoom button: 'Fit width', 'Fit page', or the percentage. */
export function zoomLabel(scaleValue: string, scale: number): string {
  if (scaleValue === 'page-width') return 'Fit width'
  if (scaleValue === 'page-fit') return 'Fit page'
  if (scaleValue === 'page-height') return 'Fit height'
  return `${Math.round(scale * 100)}%`
}

export function percentLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`
}

/** The zoom the viewer starts with (the user's remembered choice). */
export function initialScaleValue(): string {
  return normalizeScaleValue(getSettings().pdfZoom)
}

const persist = debounce((value: string) => {
  const auth = useAuth.getState()
  if (auth.status !== 'authenticated' || !auth.me) return
  if (auth.me.settings.pdfZoom === value) return
  auth.updateSettings({ pdfZoom: value }).catch(e => {
    console.warn('[pdf] could not remember the PDF zoom', e)
  })
}, 1200)

/** Remember the zoom the user picked (presets and numbers alike). */
export function rememberScaleValue(value: string): void {
  const v = normalizeScaleValue(value)
  persist(v)
}
