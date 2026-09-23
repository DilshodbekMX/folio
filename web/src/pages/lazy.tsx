/**
 * Route-level code splitting (PERF-6). The editor page — CodeMirror, Yjs and the realtime
 * sessions, the file tree, history, the PDF pane — and the admin page are loaded on demand, so
 * /login and the dashboard only download what they show. Once the dashboard is idle the editor
 * code is fetched in the background, so opening a project does not wait for it.
 *
 * Nothing on the dashboard or the login page may import the editor's modules statically (the
 * stores/project, realtime/docs|meta|recovered and features/editor graphs): what they need
 * lives in small modules (realtime/syncState, realtime/recoveredStore, stores/compileStatus).
 *
 * A chunk that cannot be loaded (offline, or Folio was rebuilt and the old chunk is gone) shows
 * a "Reload" page instead of a blank screen (LazyBoundary).
 */
import { Component, lazy, useSyncExternalStore, type ReactNode } from 'react'
import { RefreshCw } from 'lucide-react'
import { Button, FolioMark } from '../ui'

type ProjectModule = typeof import('./ProjectPage')

let projectModule: Promise<ProjectModule> | null = null
let editorLoaded = false
const loadedListeners = new Set<() => void>()

/** Load the editor page's code (once; a failed attempt may be retried). */
export function loadProjectPage(): Promise<ProjectModule> {
  if (!projectModule) {
    const p = import('./ProjectPage')
    projectModule = p
    p.then(
      () => {
        editorLoaded = true
        for (const fn of [...loadedListeners]) fn()
      },
      () => {
        if (projectModule === p) projectModule = null
      },
    )
  }
  return projectModule
}

/** Fetch the editor code in the background once the page is idle (the dashboard calls it). */
export function prefetchProjectPage(): () => void {
  if (editorLoaded || typeof window === 'undefined') return () => {}
  const run = () => {
    loadProjectPage().catch(() => {
      // offline: it is loaded (and reported) when a project is opened
    })
  }
  const w = window as Window & {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number
    cancelIdleCallback?: (id: number) => void
  }
  if (w.requestIdleCallback) {
    const id = w.requestIdleCallback(run, { timeout: 4000 })
    return () => w.cancelIdleCallback?.(id)
  }
  const t = window.setTimeout(run, 1500)
  return () => window.clearTimeout(t)
}

function subscribeLoaded(fn: () => void): () => void {
  loadedListeners.add(fn)
  return () => {
    loadedListeners.delete(fn)
  }
}

/** True once the editor code has been loaded in this tab (document sessions can exist from then on). */
export function useEditorCodeLoaded(): boolean {
  return useSyncExternalStore(subscribeLoaded, () => editorLoaded, () => false)
}

export const LazyProjectPage = lazy(() => loadProjectPage().then(m => ({ default: m.ProjectPage })))
export const LazyAdminPage = lazy(() => import('./AdminPage').then(m => ({ default: m.AdminPage })))
/** App-level notice about edits of projects left earlier that are still being sent (editor code). */
export const LazyBackgroundSyncNotice = lazy(() => import('../features/layout/unsynced').then(m => ({ default: m.BackgroundSyncNotice })))

/** A lazily loaded page whose code could not be fetched: offer to reload instead of a blank page. */
export class LazyBoundary extends Component<{ children: ReactNode; quiet?: boolean }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown): void {
    console.error('[folio] a page could not be loaded', error)
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children
    if (this.props.quiet) return null
    return (
      <div className="pg-center">
        <div className="pg-card pg-state">
          <FolioMark size={32} tile className="pg-card__mark" />
          <h1 className="pg-state__title">This page couldn’t be loaded</h1>
          <p className="pg-state__text">
            The connection may have dropped, or Folio was updated since this tab was opened. Reload to try again.
          </p>
          <div className="pg-state__actions">
            <Button variant="primary" icon={RefreshCw} onClick={() => window.location.reload()}>
              Reload
            </Button>
          </div>
        </div>
      </div>
    )
  }
}
