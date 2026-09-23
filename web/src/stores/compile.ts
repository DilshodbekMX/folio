/**
 * Compile state of the open project (SPEC §6.3).
 *
 * compile(): single-flight on the client too — while a compile runs, further requests are merged
 * into ONE pending follow-up (any manual request makes it manual, fromScratch is sticky) that
 * starts when the current one finishes; callers of the follow-up share its result.
 * Without an explicit rootFileId it builds the open document when that has its own
 * \documentclass (openRootFileId), otherwise the main document. Viewers may compile by hand;
 * auto-compiles and "Recompile from scratch" need edit rights.
 * Before POSTing, docSessions.barrierAll() makes sure the server has our last keystroke.
 * Options (autoCompile/draft/stopOnFirstError) are persisted per project in localStorage
 * 'folio:compile:<pid>'. changedSinceCompile is set by local/remote edits (docSessions.onChange,
 * 'doc:changed' events for files without a local session) and cleared by a successful compile
 * that started after the last change. 'compile:done' events from other clients refresh `last`.
 *
 * Root documents: a project can have several (the paper, its xr supplement, standalone figures).
 * Each client follows ONE (`root`): the document it compiled last, or the root document opened in
 * the editor (followOpenDocument; other files keep the document on screen). `last`/`lastWithPdf`
 * are that document's newest builds; a collaborator's build of another document is never shown
 * here (it would replace your PDF, and compile-on-open would flip it back for them), does not end
 * "out of date" and does not cancel a queued auto-compile. The newest build of every document
 * seen is kept (`seen`), so switching between the paper and the supplement shows each one's last
 * PDF at once; GET /compile/last?rootFileId= fetches it from the server. 'compile:started' /
 * 'compile:done' of another document (servers name it: rootPath) are ignored. A server that keeps
 * one last build per project ignores ?rootFileId: its answer is only shown when it is of the
 * followed document, or when nothing is on screen yet.
 * After the project connection comes back (realtime/meta onMetaResync) a build finished while it
 * was down is caught up by replaying its 'compile:done' locally (the PDF refreshes and "X is
 * compiling…" ends); a collaborator's compile that was running is polled until it ends.
 */
import { create } from 'zustand'
import type { CompileRequest, CompileResponse } from '@folio/shared/api'
import { hasDocumentclass } from '@folio/shared/latex'
import { extname } from '@folio/shared/paths'
import { api } from '../api/endpoints'
import { ApiError, errorMessage } from '../api/client'
import { isRecord, readJSON, writeJSON } from '../lib/storage'
import { registerTestHook } from './testHooks'
import { compileStatusMessage } from './compileStatus'
import { useProject } from './project'
import { useEditor } from './editor'
import { docSessions } from '../realtime/docs'
import { onMetaResync, projectEvents } from '../realtime/meta'

export { compileStatusMessage } from './compileStatus'

export interface CompileOptions {
  autoCompile: boolean
  /** Fast [draft] mode */
  draft: boolean
  stopOnFirstError: boolean
}

export interface CompileCallOptions {
  /** triggered by auto-compile (server dedupes; 'too-recently-compiled'/'unavailable' are ignored) */
  auto?: boolean
  /** "Recompile from scratch": the server deletes the compile directory first */
  fromScratch?: boolean
  /** compile another root document than the project's main document */
  rootFileId?: string
}

export interface CompileStoreState {
  status: 'idle' | 'compiling'
  /** latest build result (any status that produced a build: success, failure, timedout, …) */
  last: CompileResponse | null
  /** latest result that has a PDF (kept when a later compile fails) */
  lastWithPdf: CompileResponse | null
  /** project-relative path of the root document whose builds this client shows (null: none yet) */
  root: string | null
  /** human-readable problem with the latest compile attempt, null when it succeeded */
  error: string | null
  /** true while the running compile was started by auto-compile */
  runningAuto: boolean
  /** some open documents were offline when the last compile started (server compiled its last synced copy) */
  offline: boolean
  options: CompileOptions
  setOption<K extends keyof CompileOptions>(k: K, v: CompileOptions[K]): void
  compile(o?: CompileCallOptions): Promise<CompileResponse | null>
  stop(): Promise<void>
  clearCache(): Promise<void>
  loadLast(): Promise<void>
  /** show the builds of root document `rootPath` from now on (its newest known build at once) */
  follow(rootPath: string): Promise<void>
  changedSinceCompile: boolean
  markChanged(): void
  logsOpen: boolean
  setLogsOpen(open: boolean): void
  reset(): void
}

export const DEFAULT_COMPILE_OPTIONS: CompileOptions = { autoCompile: true, draft: false, stopOnFirstError: false }
const BARRIER_TIMEOUT_MS = 10_000
const TOO_RECENT_RETRY_MS = 1100

const optionsKey = (pid: string) => `folio:compile:${pid}`

function loadOptions(pid: string | null): CompileOptions {
  if (!pid) return { ...DEFAULT_COMPILE_OPTIONS }
  return readJSON<CompileOptions>(optionsKey(pid), { ...DEFAULT_COMPILE_OPTIONS }, v => {
    if (!isRecord(v)) return undefined
    const bool = (x: unknown, d: boolean) => (typeof x === 'boolean' ? x : d)
    return {
      autoCompile: bool(v.autoCompile, DEFAULT_COMPILE_OPTIONS.autoCompile),
      draft: bool(v.draft, DEFAULT_COMPILE_OPTIONS.draft),
      stopOnFirstError: bool(v.stopOnFirstError, DEFAULT_COMPILE_OPTIONS.stopOnFirstError),
    }
  })
}

// -- module-private run state ---------------------------------------------------------------------

interface Pending {
  auto: boolean
  fromScratch: boolean
  rootFileId?: string
  promise: Promise<CompileResponse | null>
  resolve: (r: CompileResponse | null) => void
}

/** bumped on reset(): results of compiles started before are dropped */
let generation = 0
let inflight: Promise<CompileResponse | null> | null = null
let pending: Pending | null = null
let changeSeq = 0
/** changeSeq when another client's compile started (null when none is running) */
let remoteStartSeq: number | null = null
/** Date.now() when another client's compile started (null when none is known to run) */
let remoteStartedAt: number | null = null
let catchUpTimer: ReturnType<typeof setTimeout> | null = null
/** poll interval while a collaborator's compile that started before a disconnect is unaccounted for */
const CATCH_UP_POLL_MS = 5000

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

/**
 * features.md "Main document behaviour" (like Overleaf): a compile that names no root builds the
 * open .tex file when it has its own \documentclass (e.g. a supplementary document next to the
 * paper), otherwise the project's main document. Returns the open file's id in the first case,
 * undefined in the second (the server then uses settings.rootFileId). Only the preamble is
 * scanned; a file whose live text is not loaded yet counts as not being a root.
 */
export function openRootFileId(): string | undefined {
  const fileId = useEditor.getState().openFileId
  const project = useProject.getState()
  if (!fileId || fileId === project.settings?.rootFileId) return undefined
  const file = project.files[fileId]
  if (!file || file.kind !== 'text' || extname(file.path) !== 'tex') return undefined
  const session = docSessions.get(fileId)
  if (!session?.isSynced()) return undefined
  const text = session.ytext.toString()
  const body = text.indexOf('\\begin{document}')
  return hasDocumentclass(body >= 0 ? text.slice(0, body) : text) ? fileId : undefined
}

// -- root documents (see the header) --------------------------------------------------------------

function pathOf(fileId: string | null | undefined): string | null {
  return fileId ? (useProject.getState().files[fileId]?.path ?? null) : null
}

/**
 * Path of the root document a compile started now would build: the open document when it has its
 * own \documentclass, otherwise the main document. null when no main document is set (the server
 * then picks one).
 */
export function targetRootPath(): string | null {
  return pathOf(openRootFileId() ?? useProject.getState().settings?.rootFileId)
}

interface RootBuilds {
  /** newest build of the document (any status) */
  last: CompileResponse
  /** newest build of the document that has a PDF */
  withPdf: CompileResponse | null
  /** changeSeq at which `last` was known to contain every edit (null: unknown) */
  seq: number | null
}

/** newest builds of each root document this client knows of (own, collaborators', loaded) */
const seen = new Map<string, RootBuilds>()

const isNewer = (a: CompileResponse, b: CompileResponse | null | undefined) => !b || (a.buildId !== b.buildId && a.compiledAt >= b.compiledAt)

function record(b: CompileResponse | null | undefined, seq: number | null = null): void {
  if (!b?.buildId || !b.rootPath) return
  const e = seen.get(b.rootPath)
  if (!e) {
    seen.set(b.rootPath, { last: b, withPdf: b.pdfUrl ? b : null, seq })
    return
  }
  if (isNewer(b, e.last)) {
    e.last = b
    e.seq = seq
  } else if (b.buildId === e.last.buildId && seq !== null) {
    e.seq = seq
  }
  if (b.pdfUrl && isNewer(b, e.withPdf)) e.withPdf = b
}

function newestSeen(): RootBuilds | undefined {
  let best: RootBuilds | undefined
  for (const e of seen.values()) if (!best || e.last.compiledAt > best.last.compiledAt) best = e
  return best
}

/** 'compile:started' / 'compile:done' of a server that names the root document (optional field) */
function eventRootPath(e: object): string | null {
  const r = (e as { rootPath?: unknown }).rootPath
  return typeof r === 'string' && r.length > 0 ? r : null
}

/** files reach the disk up to ~10 s after the last keystroke: a newer updatedAt within this is no edit */
const STALE_SLACK_MS = 15_000

/** True when a project file changed after `build` was made (disk timestamps). */
export function buildIsStale(build: CompileResponse): boolean {
  const files = Object.values(useProject.getState().files).filter(f => f.kind !== 'folder')
  return Math.max(0, ...files.map(f => f.updatedAt)) > build.compiledAt + STALE_SLACK_MS
}

export const useCompile = create<CompileStoreState>()((set, get) => {
  const current = (gen: number, pid: string) => gen === generation && useProject.getState().projectId === pid

  /**
   * Show the newest builds of root document `root`. Without any, the PDF on screen stays
   * (refreshed with its own document's newest build) — or, with nothing on screen, the newest
   * build of any document is better than an empty pane.
   */
  const show = (root: string | null) => {
    const st = get()
    const shown = st.lastWithPdf ?? st.last
    let e = root ? seen.get(root) : undefined
    if (!e && shown?.rootPath) e = seen.get(shown.rootPath)
    if (!e && !shown) e = newestSeen()
    if (!e) return
    const patch: Partial<CompileStoreState> = {}
    const keep = (cur: CompileResponse | null, next: CompileResponse | null) =>
      cur?.buildId === next?.buildId || (!!cur && !!next && cur.rootPath === next.rootPath && cur.compiledAt > next.compiledAt)
    if (!keep(st.last, e.last)) {
      patch.last = e.last
      patch.error = compileStatusMessage(e.last.status)
    }
    // a document that never produced a PDF (only failed builds) keeps the PDF on screen
    if (e.withPdf && !keep(st.lastWithPdf, e.withPdf)) patch.lastWithPdf = e.withPdf
    if (Object.keys(patch).length > 0) set(patch)
  }

  /** "Out of date" after switching to root document `root`: edits since its build, or no build. */
  const updateChanged = (root: string) => {
    if (inflight) return
    const e = seen.get(root)
    const changed = !e || (e.seq !== null ? e.seq !== changeSeq : buildIsStale(e.last))
    if (changed !== get().changedSinceCompile) set({ changedSinceCompile: changed })
  }

  const applyResult = (res: CompileResponse, auto: boolean, seqAtStart: number, rootAtStart: string | null, requested: string | null) => {
    if (res.status === 'too-recently-compiled' || res.status === 'unavailable') {
      // no build was made: keep the previous result; auto-compile stays silent
      if (!auto) set({ error: compileStatusMessage(res.status) })
      return
    }
    const st = get()
    if (requested && res.rootPath && res.rootPath !== requested) {
      // the server answered with a build of another document than we asked for (our request was
      // merged with a collaborator's): not ours to show, and our edits are not compiled yet
      record(res)
      show(st.root)
      return
    }
    const upToDate = res.status === 'success' && changeSeq === seqAtStart
    record(res, upToDate ? seqAtStart : null)
    // from now on we follow the document we compiled — unless another root document was opened
    // in the editor while it compiled (then the build is only remembered for later)
    if (res.rootPath && st.root !== null && st.root !== rootAtStart && st.root !== res.rootPath) return
    const patch: Partial<CompileStoreState> = { last: res, error: compileStatusMessage(res.status) }
    if (res.rootPath && res.rootPath !== st.root) patch.root = res.rootPath
    if (res.pdfUrl) patch.lastWithPdf = res
    // a failed build of another document than the PDF on screen: that document's own last PDF;
    // without one the PDF on screen stays (the banner and the toolbar say which document it is)
    else if (res.rootPath && st.lastWithPdf && st.lastWithPdf.rootPath !== res.rootPath) {
      const own = seen.get(res.rootPath)?.withPdf
      if (own) patch.lastWithPdf = own
    }
    if (upToDate) patch.changedSinceCompile = false
    set(patch)
  }

  const run = (pid: string, o: CompileCallOptions): Promise<CompileResponse | null> => {
    const gen = generation
    const auto = !!o.auto
    const seqAtStart = changeSeq
    const rootAtStart = get().root
    const requested = pathOf(o.rootFileId ?? useProject.getState().settings?.rootFileId)
    set({ status: 'compiling', runningAuto: auto, ...(auto ? {} : { error: null }) })
    const p = (async (): Promise<CompileResponse | null> => {
      try {
        const offline = docSessions.offlineFileIds().length > 0
        await docSessions.barrierAll(BARRIER_TIMEOUT_MS)
        if (!current(gen, pid)) return null
        const { options } = get()
        const req: CompileRequest = {
          draft: options.draft,
          stopOnFirstError: options.stopOnFirstError,
          auto,
          ...(o.fromScratch ? { fromScratch: true } : {}),
          ...(o.rootFileId ? { rootFileId: o.rootFileId } : {}),
        }
        let res = await api.compile(pid, req)
        if (!auto && res.status === 'too-recently-compiled' && current(gen, pid)) {
          // an auto-compile just ran for us: a manual click should still go through
          await sleep(TOO_RECENT_RETRY_MS)
          if (!current(gen, pid)) return null
          res = await api.compile(pid, req)
        }
        if (requested && res.buildId && res.rootPath && res.rootPath !== requested && current(gen, pid)) {
          // merged on the server with a collaborator's compile of another document: ask once more
          await sleep(TOO_RECENT_RETRY_MS)
          if (!current(gen, pid)) return null
          res = await api.compile(pid, req)
        }
        if (!current(gen, pid)) return null
        set({ offline })
        applyResult(res, auto, seqAtStart, rootAtStart, requested)
        return res
      } catch (e) {
        if (!current(gen, pid)) return null
        // auto-compiles fail quietly unless the server itself is broken
        if (!auto || !(e instanceof ApiError) || e.status >= 500) set({ error: errorMessage(e, 'The compile request failed.') })
        return null
      }
    })()
    inflight = p
    void p.finally(() => {
      if (inflight === p) inflight = null
      if (gen !== generation) return
      const next = pending
      pending = null
      if (next && current(gen, pid)) {
        run(pid, next).then(next.resolve, () => next.resolve(null))
      } else {
        next?.resolve(null)
        set({ status: 'idle', runningAuto: false })
      }
    })
    return p
  }

  return {
    status: 'idle',
    last: null,
    lastWithPdf: null,
    root: null,
    error: null,
    runningAuto: false,
    offline: false,
    options: loadOptions(null),
    changedSinceCompile: false,
    logsOpen: false,

    setOption(k, v) {
      const options = { ...get().options, [k]: v }
      set({ options })
      const pid = useProject.getState().projectId
      if (pid) writeJSON(optionsKey(pid), options)
    },

    compile(o = {}) {
      wireCompile()
      const project = useProject.getState()
      const pid = project.projectId
      if (!pid) return Promise.resolve(null)
      if (!project.role) return Promise.resolve(null)
      // viewers may compile by hand (like Overleaf); auto-compile and "from scratch" need edit rights
      if (!project.canEdit() && (o.auto || o.fromScratch)) {
        if (!o.auto) set({ error: 'Only editors can recompile from scratch.' })
        return Promise.resolve(null)
      }
      const req: CompileCallOptions = { ...o, rootFileId: o.rootFileId ?? openRootFileId() }
      if (inflight) {
        if (pending) {
          pending.auto = pending.auto && !!o.auto
          pending.fromScratch = pending.fromScratch || !!o.fromScratch
          // the newest request decides what to compile
          pending.rootFileId = req.rootFileId
          return pending.promise
        }
        let resolve: (r: CompileResponse | null) => void = () => {}
        const promise = new Promise<CompileResponse | null>(r => {
          resolve = r
        })
        pending = { auto: !!o.auto, fromScratch: !!o.fromScratch, rootFileId: req.rootFileId, promise, resolve }
        return promise
      }
      return run(pid, req)
    },

    async stop() {
      const pid = useProject.getState().projectId
      if (!pid) return
      // the user wants it to stop: drop the queued follow-up as well
      const next = pending
      pending = null
      next?.resolve(null)
      await api.stopCompile(pid)
    },

    async clearCache() {
      const pid = useProject.getState().projectId
      if (!pid) return
      await api.clearCache(pid)
      if (useProject.getState().projectId !== pid) return
      seen.clear()
      set({ last: null, lastWithPdf: null, error: null })
    },

    async loadLast() {
      wireCompile()
      const pid = useProject.getState().projectId
      if (!pid) return
      const gen = generation
      // the newest build of the document we follow (a server without per-document builds
      // answers with the newest of any document)
      const want = get().root ?? targetRootPath()
      const rootFileId = want ? useProject.getState().fileByPath(want)?.id : undefined
      let res: CompileResponse | null
      try {
        res = await api.lastCompile(pid, rootFileId ? { rootFileId } : { main: true })
      } catch (e) {
        console.warn('[compile] loading the last build failed', e)
        return
      }
      if (!res || !current(gen, pid)) return
      record(res)
      // a failed latest build still comes with the newest one that has a PDF (server: lastWithPdf)
      record(res.lastWithPdf)
      if (get().root === null) set({ root: targetRootPath() ?? res.rootPath })
      show(get().root)
    },

    async follow(rootPath) {
      if (get().root === rootPath) return
      set({ root: rootPath })
      show(rootPath)
      updateChanged(rootPath)
      await get().loadLast()
      if (get().root === rootPath) updateChanged(rootPath)
    },

    markChanged() {
      changeSeq++
      if (!get().changedSinceCompile) set({ changedSinceCompile: true })
    },

    setLogsOpen(open) {
      set({ logsOpen: open })
    },

    reset() {
      generation++
      const next = pending
      pending = null
      next?.resolve(null)
      inflight = null
      seen.clear()
      set({
        status: 'idle', last: null, lastWithPdf: null, root: null, error: null, runningAuto: false, offline: false,
        changedSinceCompile: false, logsOpen: false, options: loadOptions(useProject.getState().projectId),
      })
    },
  }
})

registerTestHook('useCompile', useCompile)

function stopCatchUp(): void {
  if (catchUpTimer !== null) clearTimeout(catchUpTimer)
  catchUpTimer = null
}

/**
 * The project connection came back: 'compile:done' events sent meanwhile were missed. A newer
 * build is replayed as its event (compile store + "X is compiling…" indicator follow it); a
 * collaborator's compile that was running and has not produced a build yet is polled until it
 * does, or until it must have ended (timeout).
 */
async function catchUpCompiles(pid: string): Promise<void> {
  stopCatchUp()
  const { root } = useCompile.getState()
  let res: CompileResponse | null
  try {
    const rootFileId = root ? useProject.getState().fileByPath(root)?.id : undefined
    res = await api.lastCompile(pid, rootFileId ? { rootFileId } : { main: true })
  } catch (e) {
    console.warn('[compile] catching up after reconnect failed', e)
    return
  }
  if (useProject.getState().projectId !== pid) return
  const { last } = useCompile.getState()
  if (res?.buildId && res.buildId !== last?.buildId && (!last || res.compiledAt >= last.compiledAt) && !inflight) {
    // (a build of another document only ends the "X is compiling…" indicator here)
    const done = { type: 'compile:done' as const, by: res.by, status: res.status, buildId: res.buildId, rootPath: res.rootPath }
    projectEvents.emit(done)
    return
  }
  if (remoteStartedAt === null) return
  const limitMs = (useProject.getState().settings?.timeoutSec ?? 600) * 1000 + 30_000
  if (Date.now() - remoteStartedAt > limitMs) {
    // it ended while we were away without a new build (cached, refused or stopped)
    projectEvents.emit({ type: 'compile:done', by: null, status: 'unavailable', buildId: null })
    return
  }
  catchUpTimer = setTimeout(() => {
    catchUpTimer = null
    if (remoteStartedAt !== null && useProject.getState().projectId === pid) void catchUpCompiles(pid)
  }, CATCH_UP_POLL_MS)
}

/** A build of root document `rootPath` would be shown here (see useCompile's show()). */
function showsDocument(rootPath: string): boolean {
  const st = useCompile.getState()
  const shown = st.lastWithPdf ?? st.last
  return st.root === null || !shown || rootPath === st.root || rootPath === shown.rootPath
}

/**
 * Follow the open document when it is a root document — the main document, or a .tex file with
 * its own \documentclass (e.g. the supplement): its newest build is shown. Any other file
 * (chapters, .bib, images) keeps the document on screen. Resolves once that document's newest
 * build is loaded.
 */
export function followOpenDocument(): Promise<void> {
  const project = useProject.getState()
  const fileId = useEditor.getState().openFileId
  if (project.loadState !== 'ready' || !fileId) return Promise.resolve()
  const isRoot = fileId === project.settings?.rootFileId || openRootFileId() === fileId
  const path = isRoot ? pathOf(fileId) : null
  return path ? useCompile.getState().follow(path) : Promise.resolve()
}

let wired = false
export function wireCompile(): void {
  if (wired) return
  wired = true
  useProject.subscribe((s, prev) => {
    if (s.projectId === prev.projectId) return
    remoteStartSeq = null
    remoteStartedAt = null
    stopCatchUp()
    useCompile.getState().reset()
  })
  docSessions.onChange(() => useCompile.getState().markChanged())
  projectEvents.on('doc:changed', e => {
    // edits in files we have a live session for were already seen through onChange
    if (!docSessions.get(e.fileId)?.isSynced()) useCompile.getState().markChanged()
  })
  projectEvents.on('compile:started', e => {
    if (inflight) return
    // a compile of another root document than the one shown here (when the server names it)
    const rootPath = eventRootPath(e)
    if (rootPath && !showsDocument(rootPath)) return
    remoteStartSeq = changeSeq
    remoteStartedAt = Date.now()
  })
  projectEvents.on('compile:done', e => {
    // a build of another root document than the one shown here: not ours to show
    const rootPath = eventRootPath(e)
    if (rootPath && !showsDocument(rootPath)) return
    const startSeq = remoteStartSeq
    remoteStartSeq = null
    remoteStartedAt = null
    stopCatchUp()
    if (e.status === 'too-recently-compiled' || e.status === 'unavailable') return
    const st = useCompile.getState()
    // our own compile's event (the HTTP response brings the result), or already shown
    if (inflight || (e.buildId !== null && st.last?.buildId === e.buildId)) return
    void st.loadLast().then(() => {
      // a collaborator's successful build of the document we compile, started after our last
      // edit, is up to date — one of another document is not (it was not even shown)
      const now = useCompile.getState()
      const target = targetRootPath()
      if (e.status === 'success' && startSeq !== null && startSeq === changeSeq && !inflight && e.buildId !== null &&
        now.last?.buildId === e.buildId && (target === null || now.last.rootPath === target)) {
        record(now.last, startSeq)
        useCompile.setState({ changedSinceCompile: false })
      }
    })
  })
  // the open document decides which root document's PDF is shown (followOpenDocument)
  useEditor.subscribe((s, prev) => {
    if (s.openFileId !== prev.openFileId || s.view !== prev.view) void followOpenDocument()
  })
  useProject.subscribe((s, prev) => {
    if (s.projectId === prev.projectId && s.settings?.rootFileId !== prev.settings?.rootFileId) void followOpenDocument()
  })
  onMetaResync(pid => {
    if (useProject.getState().projectId === pid) void catchUpCompiles(pid)
  })
  // options of the project that is already open when this module is wired
  const pid = useProject.getState().projectId
  if (pid) useCompile.setState({ options: loadOptions(pid) })
}
queueMicrotask(wireCompile)
