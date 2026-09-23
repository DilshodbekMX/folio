import { useEffect } from 'react'
import { useCompile } from '../../stores/compile'
import { useLayout, type LayoutView } from '../../stores/layout'
import { isMac, isModKey } from '../../ui'

const modalOpen = () => !!document.querySelector('[data-ui-layer="modal"]')

/** ⌃⌘← / ⌃⌘→ / ⌃⌘↓ (macOS, as in Overleaf): editor only / PDF only / split. */
const LAYOUT_KEYS: Record<string, LayoutView> = { ArrowLeft: 'editor', ArrowRight: 'pdf', ArrowDown: 'split' }

/**
 * Editor-page shortcuts that work anywhere on the page. CodeMirror handles the same keys itself
 * while it has focus (and marks the event handled), so we only act on unhandled events.
 *   Mod-Enter, Mod-s   compile (Mod-s also suppresses the browser's "Save page" dialog); viewers may
 *                      compile by hand too — useCompile refuses what needs edit rights
 *   Mod-Shift-m        focus mode on/off (Overleaf's key; taken before the editor sees it, so
 *                      it works while typing — the editor's lint-panel binding no longer applies)
 *   ⌃⌘ ← → ↓ (macOS)   editor only / PDF only / split view
 */
export function useGlobalShortcuts(): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return
      if (!isModKey(e) || e.altKey || e.shiftKey) return
      const key = e.key.toLowerCase()
      if (key !== 'enter' && key !== 's') return
      e.preventDefault()
      // A modal dialog is open: its own keyboard handling wins.
      if (modalOpen()) return
      useCompile.getState().compile().catch(() => {
        // failures are reported through useCompile.error and the PDF pane
      })
    }
    // capture phase: these must win over the editor's own bindings
    const onKeyDownCapture = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat || modalOpen()) return
      if (isModKey(e) && e.shiftKey && !e.altKey && (e.code === 'KeyM' || e.key.toLowerCase() === 'm')) {
        e.preventDefault()
        e.stopPropagation()
        const layout = useLayout.getState()
        layout.setFocusMode(!layout.focusMode)
        return
      }
      if (isMac && e.ctrlKey && e.metaKey && !e.altKey && !e.shiftKey && LAYOUT_KEYS[e.key]) {
        e.preventDefault()
        e.stopPropagation()
        useLayout.getState().setView(LAYOUT_KEYS[e.key])
      }
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keydown', onKeyDownCapture, true)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keydown', onKeyDownCapture, true)
    }
  }, [])
}
