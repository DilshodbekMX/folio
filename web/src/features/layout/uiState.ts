/** Small UI state local to the editor chrome (not part of the shared layout store). */
import { create } from 'zustand'

interface ChromeState {
  aboutOpen: boolean
  setAboutOpen(open: boolean): void
}

export const useChrome = create<ChromeState>()(set => ({
  aboutOpen: false,
  setAboutOpen: aboutOpen => set({ aboutOpen }),
}))

/** Static user guide shipped in web/public. */
export const HELP_URL = '/help.html'
