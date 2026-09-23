/**
 * Editor page layout (SPEC §6.3). `view`, `railPanel`, `outlineOpen` and panel layouts are
 * persisted in localStorage ('folio:layout'); modal/history/unread/focus-mode state is per
 * session and is reset when another project is opened.
 *
 * Focus mode (beyond SPEC §6.3, Overleaf's Layout → Focus mode): hides the top bar, the rail and
 * its panel; leaving it brings the rail panel back.
 */
import { create } from 'zustand'
import { isRecord, readJSON, writeJSON } from '../lib/storage'
import { cancelAllDialogs } from '../ui/Dialogs'
import { registerTestHook } from './testHooks'
import { useProject } from './project'

export type LayoutView = 'split' | 'editor' | 'pdf'
export type RailPanel = 'files' | 'search' | 'chat'
export type ModalType = 'share' | 'settings' | 'wordcount' | 'shortcuts' | 'upload' | 'newfile' | 'newfolder' | 'symbols'
export interface ModalState { type: ModalType; props?: Record<string, unknown> }
/** react-resizable-panels v4 layout: panel id → size */
export type PanelLayout = Record<string, number>

export interface LayoutState {
  view: LayoutView
  setView(v: LayoutView): void
  railPanel: RailPanel | null
  setRailPanel(p: RailPanel | null): void
  /** clicking the active rail icon collapses the panel */
  toggleRailPanel(p: RailPanel): void
  historyOpen: boolean
  setHistoryOpen(o: boolean): void
  modal: ModalState | null
  openModal(type: ModalType, props?: Record<string, unknown>): void
  closeModal(): void
  unreadChat: number
  setUnreadChat(n: number): void
  /** file outline section under the file tree */
  outlineOpen: boolean
  setOutlineOpen(o: boolean): void
  /** persisted panel group layouts keyed by Group id */
  panelLayouts: Record<string, PanelLayout>
  setPanelLayout(groupId: string, layout: PanelLayout): void
  /** top bar, rail and rail panel hidden */
  focusMode: boolean
  setFocusMode(on: boolean): void
}

const STORAGE_KEY = 'folio:layout'
const VIEWS: readonly LayoutView[] = ['split', 'editor', 'pdf']
const RAIL_PANELS: readonly RailPanel[] = ['files', 'search', 'chat']

interface Persisted {
  view: LayoutView
  railPanel: RailPanel | null
  outlineOpen: boolean
  panelLayouts: Record<string, PanelLayout>
}

const DEFAULTS: Persisted = { view: 'split', railPanel: 'files', outlineOpen: true, panelLayouts: {} }

function sanitizeLayouts(v: unknown): Record<string, PanelLayout> {
  const out: Record<string, PanelLayout> = {}
  if (!isRecord(v)) return out
  for (const [group, layout] of Object.entries(v)) {
    if (!isRecord(layout)) continue
    const clean: PanelLayout = {}
    for (const [panel, size] of Object.entries(layout)) {
      if (typeof size === 'number' && Number.isFinite(size) && size >= 0) clean[panel] = size
    }
    if (Object.keys(clean).length > 0) out[group] = clean
  }
  return out
}

function loadPersisted(): Persisted {
  return readJSON<Persisted>(STORAGE_KEY, DEFAULTS, v => {
    if (!isRecord(v)) return undefined
    return {
      view: VIEWS.includes(v.view as LayoutView) ? (v.view as LayoutView) : DEFAULTS.view,
      railPanel: v.railPanel === null ? null : RAIL_PANELS.includes(v.railPanel as RailPanel) ? (v.railPanel as RailPanel) : DEFAULTS.railPanel,
      outlineOpen: typeof v.outlineOpen === 'boolean' ? v.outlineOpen : DEFAULTS.outlineOpen,
      panelLayouts: sanitizeLayouts(v.panelLayouts),
    }
  })
}

const initial = loadPersisted()

/** rail panel that was open when focus mode started */
let railBeforeFocus: RailPanel | null = null

export const useLayout = create<LayoutState>()((set, get) => ({
  view: initial.view,
  setView: view => set({ view }),
  railPanel: initial.railPanel,
  setRailPanel: railPanel => set({ railPanel }),
  toggleRailPanel: p => set(s => ({ railPanel: s.railPanel === p ? null : p })),
  historyOpen: false,
  setHistoryOpen: historyOpen => set({ historyOpen }),
  modal: null,
  openModal: (type, props) => set({ modal: props ? { type, props } : { type } }),
  closeModal: () => set({ modal: null }),
  unreadChat: 0,
  setUnreadChat: n => set({ unreadChat: Math.max(0, Math.floor(n) || 0) }),
  outlineOpen: initial.outlineOpen,
  setOutlineOpen: outlineOpen => set({ outlineOpen }),
  panelLayouts: initial.panelLayouts,
  setPanelLayout: (groupId, layout) => set(s => ({ panelLayouts: { ...s.panelLayouts, [groupId]: { ...layout } } })),
  focusMode: false,
  setFocusMode: on => {
    const s = get()
    if (on === s.focusMode) return
    if (on) {
      railBeforeFocus = s.railPanel
      set({ focusMode: true, railPanel: null })
    } else {
      set({ focusMode: false, railPanel: s.railPanel ?? railBeforeFocus })
      railBeforeFocus = null
    }
  },
}))

useLayout.subscribe((s, prev) => {
  if (s.view === prev.view && s.railPanel === prev.railPanel && s.outlineOpen === prev.outlineOpen && s.panelLayouts === prev.panelLayouts) return
  // focus mode hides the rail panel only for now: remember the one it hid
  const railPanel = s.focusMode && s.railPanel === null ? railBeforeFocus : s.railPanel
  const persisted: Persisted = { view: s.view, railPanel, outlineOpen: s.outlineOpen, panelLayouts: s.panelLayouts }
  writeJSON(STORAGE_KEY, persisted)
})

/**
 * Storage adapter for react-resizable-panels' `useDefaultLayout({ id, storage: layoutStorage })`:
 * keeps panel sizes inside the persisted layout store instead of separate localStorage keys
 * (the library calls it with keys like 'react-resizable-panels:<id>').
 */
export const layoutStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void } = {
  getItem(key) {
    const layout = useLayout.getState().panelLayouts[key]
    return layout ? JSON.stringify(layout) : null
  },
  setItem(key, value) {
    try {
      const parsed: unknown = JSON.parse(value)
      const clean = sanitizeLayouts({ [key]: parsed })[key]
      if (clean) useLayout.getState().setPanelLayout(key, clean)
    } catch {
      // ignore malformed layouts
    }
  },
}

registerTestHook('useLayout', useLayout)

// Per-session UI state belongs to one project: reset it when another project is opened.
let wired = false
export function wireLayout(): void {
  if (wired) return
  wired = true
  useProject.subscribe((s, prev) => {
    if (s.projectId === prev.projectId) return
    if (useLayout.getState().focusMode) useLayout.getState().setFocusMode(false)
    useLayout.setState({ historyOpen: false, modal: null, unreadChat: 0 })
    // a confirmation asked for the previous project must not act after the switch
    cancelAllDialogs()
  })
}
queueMicrotask(wireLayout)
