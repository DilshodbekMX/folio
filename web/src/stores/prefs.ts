/**
 * Display preferences of this browser (localStorage 'folio:prefs'), for options that are not
 * part of the account's UserSettings (the server validates those strictly):
 *   pdfInvertDark — "Dark mode PDF": invert the PDF pages' colours while the dark theme is on
 *                   (App mirrors it to <html data-pdf-invert>; styles/base.css applies it).
 */
import { create } from 'zustand'
import { isRecord, readJSON, writeJSON } from '../lib/storage'
import { registerTestHook } from './testHooks'

export interface PrefsState {
  pdfInvertDark: boolean
  setPdfInvertDark(on: boolean): void
}

const STORAGE_KEY = 'folio:prefs'

function load(): Pick<PrefsState, 'pdfInvertDark'> {
  return readJSON(STORAGE_KEY, { pdfInvertDark: false }, v => (isRecord(v) ? { pdfInvertDark: v.pdfInvertDark === true } : undefined))
}

export const usePrefs = create<PrefsState>()(set => ({
  ...load(),
  setPdfInvertDark: pdfInvertDark => {
    set({ pdfInvertDark })
    writeJSON(STORAGE_KEY, { pdfInvertDark })
  },
}))

registerTestHook('usePrefs', usePrefs)
