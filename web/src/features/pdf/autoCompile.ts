/**
 * Auto-compile (SPEC §6.8): when "Auto compile" is on and the user can edit, recompile
 * 2500 ms after typing pauses, and at the latest 5000 ms after the first change of a burst.
 *
 * Triggers — only changes made by this user (deviation from SPEC §6.8, which also listed
 * collaborators' edits):
 *   - docSessions.onChange with `local` = true (typing in this client);
 *   - 'doc:changed' events whose userId is ours for files without a live session here, or that
 *     are not the echo of our own typing (our other tab, a history restore or upload we made).
 * A collaborator's edit is compiled by the collaborator's client (with their options) and the
 * result reaches everyone through 'compile:done'. If every client compiled every edit, clients
 * with different options (Fast [draft], stop on first error) would each run TeX per burst and
 * the PDF would flip to whichever build finished last — the typist could end up looking at a
 * collaborator's draft-mode PDF. A collaborator's edit still marks the PDF "out of date".
 *
 * Compile on open (like Overleaf): once the project is loaded, the newest build of the document a
 * compile would build now (the open document when it has its own \documentclass, else the main
 * document) is loaded; an auto-compile runs when that document has no build yet or a file changed
 * after it. A newer build of ANOTHER root document (a co-author working on the supplement) is not
 * a reason to compile: builds are per document, so neither client's PDF flips.
 *
 * Never starts a compile while one is running: the request is queued and runs when the current
 * compile finishes. It also waits (queued) while the browser tab is hidden and while the PDF is
 * not on screen ("editor only" layout, history view) — like Overleaf, which only auto-compiles
 * with the PDF visible; switching back runs the queued compile right away.
 * A manual compile that starts while a trigger is pending covers those edits, so the pending
 * trigger is dropped. When the server answers 'unavailable' (queue full / backoff) auto-compile
 * pauses with an increasing delay and shows "Auto-compile paused" in the PDF toolbar.
 */
import { useEffect } from 'react'
import { create } from 'zustand'
import type { CompileResponse } from '@folio/shared/api'
import { debounce, type Debounced } from '../../lib/debounce'
import { docSessions } from '../../realtime/docs'
import { projectEvents } from '../../realtime/meta'
import { useAuth } from '../../stores/auth'
import { buildIsStale, followOpenDocument, targetRootPath, useCompile } from '../../stores/compile'
import { useEditor } from '../../stores/editor'
import { useLayout } from '../../stores/layout'
import { useProject } from '../../stores/project'
import { registerTestHook } from '../../stores/testHooks'
import { loadInitialBuild } from './initialBuild'

export const AUTO_COMPILE_DEBOUNCE_MS = 2500
export const AUTO_COMPILE_MAX_WAIT_MS = 5000
const QUEUED_RUN_DELAY_MS = 400
const TOO_RECENT_RETRY_MS = 1500
const MAX_OTHER_ROOT_RETRIES = 3
const PAUSE_STEPS_MS = [15_000, 30_000, 60_000, 120_000]
/** a 'doc:changed' of ours this soon after typing in that file is the echo of that typing */
const LOCAL_ECHO_MS = 5000
/** compile on open waits this long for the open document's text (to see its \documentclass) */
const OPEN_DOC_WAIT_MS = 3000

export interface AutoCompileState {
  /** a trigger is waiting for the typing pause */
  scheduled: boolean
  /** a compile is waiting for the current one / a visible tab / a visible PDF */
  queued: boolean
  /** set while auto-compile is paused after the server said 'unavailable' */
  paused: { until: number; message: string } | null
}

export const useAutoCompileState = create<AutoCompileState>()(() => ({ scheduled: false, queued: false, paused: null }))
registerTestHook('useAutoCompileState', useAutoCompileState)

function enabled(): boolean {
  const project = useProject.getState()
  return project.loadState === 'ready' && project.canEdit() && useCompile.getState().options.autoCompile
}

function pdfVisible(): boolean {
  const layout = useLayout.getState()
  return layout.view !== 'editor' && !layout.historyOpen
}

function tabVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden'
}

class AutoCompiler {
  private debounced: Debounced<[]>
  private queuedTimer: ReturnType<typeof setTimeout> | null = null
  private pauseTimer: ReturnType<typeof setTimeout> | null = null
  private pauseStep = 0
  private running = false
  private offs: (() => void)[] = []
  /** when this client last typed in each file */
  private localEdits = new Map<string, number>()
  /** project whose compile-on-open check has run */
  private openChecked: string | null = null
  private stopped = false
  /** consecutive auto-compiles answered with a build of another root document */
  private otherRootRetries = 0

  constructor() {
    this.debounced = debounce(() => this.fire(), AUTO_COMPILE_DEBOUNCE_MS, { maxWait: AUTO_COMPILE_MAX_WAIT_MS })
  }

  start(): void {
    this.offs.push(
      docSessions.onChange((fileId, local) => {
        if (!local) return // a collaborator's edit: their client compiles it
        this.localEdits.set(fileId, Date.now())
        this.onEdit()
      }),
    )
    this.offs.push(
      projectEvents.on('doc:changed', e => {
        const me = useAuth.getState().me?.id
        if (!me || e.userId !== me) return
        // our own typing in a live document was already reported by onChange
        const echo = Date.now() - (this.localEdits.get(e.fileId) ?? -Infinity) < LOCAL_ECHO_MS
        if (docSessions.get(e.fileId)?.isSynced() && echo) return
        this.onEdit()
      }),
    )
    this.offs.push(
      useCompile.subscribe((s, prev) => {
        if (s.status === 'compiling' && prev.status !== 'compiling' && !s.runningAuto) {
          // a manual compile includes every edit made so far
          this.debounced.cancel()
          this.setState({ scheduled: false, queued: false })
        }
        if (s.status === 'idle' && prev.status === 'compiling' && useAutoCompileState.getState().queued) {
          this.runQueuedSoon()
        }
        if (s.options.autoCompile !== prev.options.autoCompile) {
          if (s.options.autoCompile) {
            if (s.changedSinceCompile) this.onEdit()
          } else {
            this.cancelAll()
          }
        }
        // a successful compile (ours, manual, or a collaborator's) ends a pause
        if (s.last !== prev.last && s.last?.status === 'success' && useAutoCompileState.getState().paused) this.resume()
      }),
    )
    this.offs.push(
      useLayout.subscribe((s, prev) => {
        const nowVisible = s.view !== 'editor' && !s.historyOpen
        const wasVisible = prev.view !== 'editor' && !prev.historyOpen
        if (nowVisible && !wasVisible && useAutoCompileState.getState().queued) this.runQueuedSoon()
      }),
    )
    this.offs.push(
      useProject.subscribe((s, prev) => {
        if (s.projectId !== prev.projectId) {
          this.cancelAll()
          this.localEdits.clear()
          this.openChecked = null
        }
        if (s.projectId && s.loadState === 'ready' && this.openChecked !== s.projectId) {
          this.openChecked = s.projectId
          void this.compileOnOpen(s.projectId)
        }
      }),
    )
    const project = useProject.getState()
    if (project.projectId && project.loadState === 'ready') {
      this.openChecked = project.projectId
      void this.compileOnOpen(project.projectId)
    }
    const onVisibility = () => {
      if (tabVisible() && useAutoCompileState.getState().queued) this.runQueuedSoon()
    }
    document.addEventListener('visibilitychange', onVisibility)
    this.offs.push(() => document.removeEventListener('visibilitychange', onVisibility))
  }

  stop(): void {
    this.stopped = true
    for (const off of this.offs.splice(0)) off()
    this.cancelAll()
  }

  private setState(patch: Partial<AutoCompileState>): void {
    useAutoCompileState.setState(patch)
  }

  private cancelAll(): void {
    this.debounced.cancel()
    if (this.queuedTimer !== null) clearTimeout(this.queuedTimer)
    this.queuedTimer = null
    if (this.pauseTimer !== null) clearTimeout(this.pauseTimer)
    this.pauseTimer = null
    this.pauseStep = 0
    this.setState({ scheduled: false, queued: false, paused: null })
  }

  private onEdit(): void {
    if (!enabled()) return
    this.debounced()
    if (!useAutoCompileState.getState().scheduled) this.setState({ scheduled: true })
  }

  private runQueuedSoon(delay = QUEUED_RUN_DELAY_MS): void {
    if (this.queuedTimer !== null) clearTimeout(this.queuedTimer)
    this.queuedTimer = setTimeout(() => {
      this.queuedTimer = null
      this.fire()
    }, delay)
  }

  private fire(): void {
    this.setState({ scheduled: false })
    if (!enabled()) {
      this.setState({ queued: false })
      return
    }
    const paused = useAutoCompileState.getState().paused
    if (paused && Date.now() < paused.until) {
      this.setState({ queued: true })
      return
    }
    if (!tabVisible() || !pdfVisible() || this.running || useCompile.getState().status === 'compiling') {
      this.setState({ queued: true })
      return
    }
    this.setState({ queued: false })
    if (!useCompile.getState().changedSinceCompile) return
    void this.run()
  }

  private async run(): Promise<void> {
    this.running = true
    const target = targetRootPath()
    let res: CompileResponse | null = null
    try {
      res = await useCompile.getState().compile({ auto: true })
    } finally {
      this.running = false
    }
    if (!enabled()) return
    if (res?.status === 'unavailable') {
      this.pause()
      return
    }
    if (res?.status === 'too-recently-compiled') {
      this.runQueuedSoon(TOO_RECENT_RETRY_MS)
      return
    }
    // the server answered with a build of another document (our request was merged with a
    // collaborator's): our edits are still not compiled — try again (a few times)
    const otherRoot = !!res?.buildId && !!res.rootPath && target !== null && res.rootPath !== target && targetRootPath() === target
    this.otherRootRetries = otherRoot ? this.otherRootRetries + 1 : 0
    if (otherRoot && useCompile.getState().changedSinceCompile && this.otherRootRetries <= MAX_OTHER_ROOT_RETRIES) {
      this.runQueuedSoon(TOO_RECENT_RETRY_MS)
      return
    }
    if (res && useAutoCompileState.getState().paused) this.resume()
    if (useAutoCompileState.getState().queued && useCompile.getState().status === 'idle') this.runQueuedSoon()
  }

  /** Compile on open when the newest build is missing or stale (see the header). */
  private async compileOnOpen(pid: string): Promise<void> {
    await loadInitialBuild(pid)
    // the open document decides what a compile builds: wait (briefly) for its text
    const openId = useEditor.getState().openFileId
    const session = openId ? docSessions.get(openId) : undefined
    if (session && !session.isSynced()) {
      await Promise.race([session.synced, new Promise(r => setTimeout(r, OPEN_DOC_WAIT_MS))]).catch(() => {})
    }
    // show (and load) the newest build of the document a compile would build now
    await followOpenDocument()
    const compile = useCompile.getState()
    if (this.stopped || useProject.getState().projectId !== pid || !enabled() || compile.status === 'compiling') return
    const last = compile.last
    const target = targetRootPath()
    // no build of that document yet (the PDF on screen, if any, is of another one), or files
    // changed after it was made
    const stale = last === null || (target !== null && last.rootPath !== target) || buildIsStale(last)
    if (!stale) return
    compile.markChanged()
    this.fire()
  }

  private pause(): void {
    const delay = PAUSE_STEPS_MS[Math.min(this.pauseStep, PAUSE_STEPS_MS.length - 1)]
    this.pauseStep++
    const until = Date.now() + delay
    this.setState({
      paused: { until, message: 'The compile server is busy, so auto-compile is paused for a moment. Recompile manually or wait — it resumes by itself.' },
      queued: true,
    })
    if (this.pauseTimer !== null) clearTimeout(this.pauseTimer)
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null
      if (useAutoCompileState.getState().queued) this.fire()
    }, delay)
  }

  private resume(): void {
    if (this.pauseTimer !== null) clearTimeout(this.pauseTimer)
    this.pauseTimer = null
    this.pauseStep = 0
    this.setState({ paused: null })
  }
}

/** Auto-compile driver; mounted once by EditorLayout. */
export function useAutoCompile(): void {
  useEffect(() => {
    const auto = new AutoCompiler()
    auto.start()
    return () => auto.stop()
  }, [])
}
