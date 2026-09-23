/**
 * CompileService (SPEC §4.5): snapshot → compile dir → sandboxed latexmk → immutable build.
 *
 *   compile()  coordinator (single-flight + one queued follow-up, dedupe, guard, global limit)
 *              → prepare: live texts via CollabService.getText (never waits for disk saves),
 *                binaries from disk, root document, xr external documents, snapshot hash
 *              → execute (per-project dir lock): sync (sync.ts), font-cache warm-up, xr
 *                pre-builds, latexmk (-gt for manual compiles, and for auto compiles whose engine /
 *                draft option differs from the job's previous run — latexmk ignores a changed
 *                -usepretex), status, outputs → builds/<pid>/<id>,
 *                log parsing, meta.json, retention; broadcasts compile:started / compile:done.
 *
 * Deviations from the SPEC text (documented here as the SPEC asks):
 *   - docker also gets `--log-driver none` and `--pull never` (no daemon-side log copies, no
 *     surprise 5 GB pulls during a compile) and a `--ulimit cpu` backstop; the /tmp tmpfs is
 *     mounted `exec` (docker defaults to noexec, which breaks biber — verified); see sandbox.ts.
 *   - a PDF left over from an earlier run never counts: 'success' needs a PDF that this run
 *     (re)wrote, or latexmk exiting 0 with the PDF up to date.
 *   - after 'timedout' / 'terminated' the compile dir is emptied (truncated .aux files would
 *     break the next compile), like Overleaf's CLSI.
 *   - root documents / external documents whose path contains shell- or TeX-special characters
 *     ($ ` " ' \ ; & | < > ! ? * % # ^ { } : ,) are refused: latexmk hands the name to a shell.
 *   - EPS previews mount a temp folder holding only a copy of the file (see preview.ts).
 *   - auto compiles also use -gt when the job's previous run ended with an error (latexmk would
 *     only repeat "gave an error in previous invocation" without running TeX: no PDF, no log);
 *     "stop on first error" is part of the options that force a run when they change.
 *   - xr: external documents are also rebuilt after the main run when it changed the labels
 *     they import (mutual xr), and \externaldocument is found in \input'ed files too (see
 *     external.ts); their errors and undefined references are added to the main log.
 *   - "Clear cached files" is refused (409) while a compile of the project runs instead of
 *     stopping it (it may be a collaborator's); deleting the project still stops it.
 *   - GET /compile/last adds `lastWithPdf` (the newest build of the same root document that has a
 *     PDF) when the build it returns has none, and can be asked for one root document
 *     (`?rootFileId=` / `?main=1`): builds are tracked per root, so a collaborator compiling
 *     another document (an open supplement) never replaces "the last build" of yours.
 *   - an xr external document is rebuilt when any project file it reads changes (its .tex, what
 *     it \input's, its .bib, class, packages, figures), not only its own .tex.
 *   - external documents' outputs are published under names that never collide with the main
 *     document's (`supp__main.pdf` for supp/main.tex next to main.tex); unchanged ones are
 *     hard-linked from the previous build.
 *   - retention: newest 5 builds, builds < 30 min up to 20 in all, plus pinned ones (each root's
 *     last and last successful build, builds a client fetched in the last 10 minutes).
 */
import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { LRUCache } from 'lru-cache'
import pLimit from 'p-limit'
import type {
  CompileRequest, CompileResponse, CompileStatus, Compiler, FileEntry, UserPublic, WordCountResponse,
} from '@folio/shared/api'
import type { ProjectEvent } from '@folio/shared/protocol'
import { comparePaths, extname } from '@folio/shared/paths'
import type { ProjectRecord } from '../db/index.ts'
import { badRequest, HttpError, notFound } from '../http/errors.ts'
import { moduleLog } from '../log.ts'
import type { CompileService, Services } from '../services.ts'
import { CompileCoordinator, type CompileJob, type PreparedSnapshot } from './coordinator.ts'
import {
  detectExternalDocuments, documentDependencies, hasDocumentclass, importedAuxPaths, importedLabelsHash, jobnameOf, outputPath,
  resolveExternalDocs,
} from './external.ts'
import { parseCompileLogs } from './logs.ts'
import {
  isValidProjectId, listBuildIds, newBuildId, publishBuild, publishedName, pruneBuilds,
  readBuildMeta, resolveBuildFileIn, writeBuildMeta, type PublishedSource, type PublishItem,
} from './outputs.ts'
import { PREVIEW_EXTENSIONS, renderPreviewCached } from './preview.ts'
import { createRunner, type CompileRunner, type LatexmkOutcome } from './runner.ts'
import { configureSandbox } from './sandbox.ts'
import { emptyDir, safeFileStat, syncCompileDir, writeManifest, type SnapshotEntry } from './sync.ts'
import { looksLikeTexcount, parseTexcount, texcountArgv } from './wordcount.ts'

export type { CompileRunner } from './runner.ts'
export { DockerRunner, FakeRunner, LocalRunner, createRunner } from './runner.ts'
export { runSandboxed, runSandboxedRaw, reapOrphans, kill } from './sandbox.ts'

const log = moduleLog('compile')

/** stdout tail returned to the client */
const STDOUT_TAIL = 20_000
const MAX_LOG_BYTES = 32 * 1024 * 1024
const WORDCOUNT_TIMEOUT_MS = 60_000
/**
 * Auxiliary containers (texcount, Ghostscript previews) can be requested by any viewer: at most
 * TOOL_CONCURRENCY run at once and at most TOOL_QUEUE_MAX wait — beyond that the request gets 503.
 */
const TOOL_CONCURRENCY = 2
const TOOL_QUEUE_MAX = 16
/** outputs of the main job copied into a build (SPEC order) */
const MAIN_OUTPUTS = ['pdf', 'log', 'synctex.gz', 'aux', 'bbl', 'blg', 'out', 'toc', 'fls']
/** files TeX/latexmk write for a job: a project file with one of these names is not synced */
const JOB_PRODUCTS = ['pdf', 'log', 'synctex.gz', 'synctex', 'fls', 'fdb_latexmk', 'xdv', 'dvi']
/** characters latexmk (which passes the file name through a shell) and TeX cannot take safely */
const SAFE_TEX_PATH = /^[\p{L}\p{N}\p{M} _\-.\/+@=~()[\]]+$/u
/** a build a client fetched (PDF, log, SyncTeX) within this window is not pruned */
const RECENT_ACCESS_MS = 10 * 60_000
/** after a restart, at most this many builds (newest first) are scanned for each root's last build */
const MAX_SCANNED_BUILDS = 60

export interface CompileServiceOptions {
  /** inject a runner (tests); default from config.compile.runner */
  runner?: CompileRunner
  /** container name prefix (default 'folio-c-'; the SPEC name is folio-c-<buildId>) */
  namePrefix?: string
  /** kill leftover containers of this instance at start-up (default: true) */
  reapOnStart?: boolean
  /** per-user auto-compile guard (default 1000 ms) */
  userGuardMs?: number
}

export interface CompileSweepOptions {
  now?: number
  /** a compile dir unused for this long is deleted (default 3 days) */
  idleMs?: number
  /** cached EPS previews older than this are deleted (default 30 days) */
  previewMaxAgeMs?: number
}

export interface CompileSweepResult {
  /** builds removed by the retention rule */
  builds: number
  /** idle compile directories removed */
  compileDirs: number
  /** leftovers of projects that no longer exist (compile dir / builds / previews) */
  orphans: number
  previews: number
}

export const COMPILE_DIR_IDLE_MS = 3 * 24 * 60 * 60 * 1000
export const PREVIEW_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

export type FolioCompileService = CompileService & {
  readonly runner: CompileRunner
  /**
   * Periodic housekeeping (main.ts runs it hourly): build retention for every project (newest 5
   * + builds < 30 min up to 20 + every root's last and last successful build + builds fetched in
   * the last minutes; projects idle for `idleMs` keep only their newest build and the pinned
   * ones), idle compile directories deleted (the next compile is a full run), leftovers of
   * deleted projects removed, old EPS previews dropped. Never touches a project while it compiles.
   */
  sweep(opts?: CompileSweepOptions): Promise<CompileSweepResult>
}

interface PreparedExternal {
  path: string
  jobname: string
  /** hash of every project file the external document reads (its rebuild key, with the imported labels) */
  depsHash: string
  /** compile-dir paths of the .aux files this external document imports itself (mutual xr) */
  imports: string[]
  /** base name of its outputs in a build (`supp` → supp.pdf, supp.log); never one of the main document's */
  publishedBase: string
}

interface Prepared extends PreparedSnapshot {
  compiler: Compiler
  rootPath: string
  jobname: string
  externals: PreparedExternal[]
  /** compile-dir paths of the .aux files the main document imports */
  mainImports: string[]
  entries: SnapshotEntry[]
  projectFiles: string[]
  texts: Map<string, string>
  timeoutMs: number
  snapshotMs: number
}

interface ProjectState {
  /** most recent build (any root document) that produced a build dir */
  newest: CompileResponse | null
  /** most recent build per root document (rootPath; '' when unknown) */
  last: Map<string, CompileResponse>
  /** last successful build with a PDF per root document (hash '' when found on disk) */
  lastSuccess: Map<string, { hash: string; response: CompileResponse }>
  /** the builds on disk were scanned (after a restart nothing is in memory) */
  loading: Promise<void> | null
  /** external documents' outputs of the last build (compile-dir path → published copy) */
  published: Map<string, PublishedSource>
}

interface Fingerprint {
  key: string
  size: number
}

function sha1(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex')
}

function tail(s: string, n: number): string {
  return s.length > n ? s.slice(s.length - n) : s
}

async function fileSha1(p: string): Promise<string> {
  const h = createHash('sha1')
  for await (const chunk of createReadStream(p)) h.update(chunk as Buffer)
  return h.digest('hex')
}

async function fingerprint(base: string, rel: string): Promise<Fingerprint | null> {
  const st = await safeFileStat(base, rel)
  return st ? { key: `${st.ino}:${st.size}:${st.mtimeMs}`, size: st.size } : null
}

function classify(out: LatexmkOutcome, pdfOk: boolean, stopOnFirstError: boolean): CompileStatus {
  if (out.timedOut) return 'timedout'
  if (out.terminated) return 'terminated'
  if (out.error) return 'error'
  if (pdfOk) return 'success'
  return stopOnFirstError ? 'stopped-on-first-error' : 'failure'
}

/**
 * latexmk refused to run TeX because nothing changed since a run that failed ("Nothing to do …
 * gave an error in previous invocation of latexmk", exit 12): the outcome says nothing about
 * the current sources.
 */
function isNoOpFailure(out: LatexmkOutcome): boolean {
  if (out.code === 0 || out.code === null || out.error || out.timedOut || out.terminated) return false
  return /^Latexmk: (?:Nothing to do for|All targets .* are up-to-date)/m.test(out.output) &&
    !/^Run number \d+ of rule '(?:pdf|xe|lua)?latex'/m.test(out.output)
}

function rootOf(r: CompileResponse): string {
  return r.rootPath ?? ''
}

/**
 * Base names for the external documents' outputs: the jobname when it is free, else a name
 * derived from the path (supp/main.tex → supp__main), never one of the main document's.
 */
function externalBases(mainJobname: string, paths: string[]): string[] {
  const used = new Set([publishedName(mainJobname)])
  return paths.map(p => {
    const byPath = publishedName(outputPath(p, '').slice(0, -1).replace(/\//g, '__'))
    let base = [publishedName(jobnameOf(p)), byPath].find(c => !used.has(c))
    for (let n = 1; !base; n++) if (!used.has(`ext${n}__${byPath}`)) base = `ext${n}__${byPath}`
    used.add(base)
    return base
  })
}

async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker))
  return out
}

export function createCompileService(s: Services, opts: CompileServiceOptions = {}): FolioCompileService {
  const config = s.config
  const namePrefix = opts.namePrefix ?? 'folio-c-'
  const instance = sha1(config.dataDir).slice(0, 12)
  const labels = { 'folio.kind': 'compile', 'folio.instance': instance }
  configureSandbox({ labels, user: config.compile.user, memory: config.compile.memory, cpus: config.compile.cpus })
  const runner = opts.runner ?? createRunner(config, { labels, namePrefix })

  const states = new Map<string, ProjectState>()
  /** project → build id → when a client last fetched one of its files */
  const recentAccess = new Map<string, Map<string, number>>()
  const dirLocks = new Map<string, Promise<unknown>>()
  /** compile requests of a project not answered yet (running, or waiting as the follow-up) */
  const inProgress = new Map<string, number>()
  const toolLimit = pLimit(TOOL_CONCURRENCY)
  const wordCounts = new Map<string, Promise<WordCountResponse>>()

  /** Run an auxiliary container job through the global tool limit (503 when the queue is full). */
  function toolSlot<T>(fn: () => Promise<T>): Promise<T> {
    if (toolLimit.activeCount >= TOOL_CONCURRENCY && toolLimit.pendingCount >= TOOL_QUEUE_MAX) {
      return Promise.reject(new HttpError(503, 'unavailable', 'The server is busy; please try again in a moment.'))
    }
    return toolLimit(fn)
  }

  /** The runner with tool() going through toolSlot (EPS previews). */
  const limitedRunner: CompileRunner = {
    get kind() { return runner.kind },
    texCompileDir: d => runner.texCompileDir(d),
    latexmk: job => runner.latexmk(job),
    tool: job => toolSlot(() => runner.tool(job)),
    warmup: () => runner.warmup(),
    reap: () => runner.reap(),
    info: () => runner.info(),
  }
  const binaryHashes = new LRUCache<string, { key: string; sha1: string }>({ max: 20_000 })

  if (opts.reapOnStart !== false && runner.kind === 'docker') {
    runner.reap().catch(err => log.warn({ err }, 'reaping orphan containers failed'))
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------

  function assertProjectId(pid: string): void {
    if (!isValidProjectId(pid)) throw notFound('Project not found')
  }
  const compileDirOf = (pid: string) => path.join(config.dirs.compiles, pid)
  const buildsDirOf = (pid: string) => path.join(config.dirs.builds, pid)
  const previewsDirOf = (pid: string) => path.join(config.dirs.previews, pid)

  function stateOf(pid: string): ProjectState {
    let st = states.get(pid)
    if (!st) {
      st = { newest: null, last: new Map(), lastSuccess: new Map(), loading: null, published: new Map() }
      states.set(pid, st)
    }
    return st
  }

  /**
   * Fill in what a restart forgot, from the builds' meta.json (newest first): the newest build,
   * each root document's newest build and newest successful one. Builds made since the start
   * are newer than anything on disk, so they are never replaced. Once per project.
   */
  function loadFromDisk(pid: string, st: ProjectState): Promise<void> {
    st.loading ??= (async () => {
      const ids = (await listBuildIds(buildsDirOf(pid))).slice(0, MAX_SCANNED_BUILDS)
      for (const id of ids) {
        const meta = await readBuildMeta(path.join(buildsDirOf(pid), id))
        if (!meta || meta.buildId !== id) continue
        const root = rootOf(meta)
        st.newest ??= meta
        if (!st.last.has(root)) st.last.set(root, meta)
        if (meta.status === 'success' && meta.pdfUrl && !st.lastSuccess.has(root)) st.lastSuccess.set(root, { hash: '', response: meta })
      }
    })().catch(err => log.warn({ err, projectId: pid }, 'could not read the saved builds'))
    return st.loading
  }

  function noteAccess(pid: string, buildId: string): void {
    let m = recentAccess.get(pid)
    if (!m) {
      m = new Map()
      recentAccess.set(pid, m)
    }
    m.set(buildId, Date.now())
  }

  /** Builds to keep whatever their age: every root's last and last successful build, recently fetched ones. */
  function pinnedBuilds(pid: string, st: ProjectState | undefined, now: number): string[] {
    const keep = new Set<string>()
    if (st) {
      if (st.newest?.buildId) keep.add(st.newest.buildId)
      for (const r of st.last.values()) if (r.buildId) keep.add(r.buildId)
      for (const { response } of st.lastSuccess.values()) if (response.buildId) keep.add(response.buildId)
    }
    const m = recentAccess.get(pid)
    if (m) {
      for (const [id, at] of m) {
        if (Math.abs(now - at) <= RECENT_ACCESS_MS) keep.add(id)
        else m.delete(id)
      }
      if (m.size === 0) recentAccess.delete(pid)
    }
    return [...keep]
  }

  function withDirLock<T>(pid: string, fn: () => Promise<T>): Promise<T> {
    const prev = dirLocks.get(pid) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    const tailP = run.then(() => undefined, () => undefined)
    dirLocks.set(pid, tailP)
    void tailP.then(() => { if (dirLocks.get(pid) === tailP) dirLocks.delete(pid) })
    return run
  }

  function broadcast(pid: string, event: ProjectEvent): void {
    try {
      s.meta?.broadcast(pid, event)
    } catch (err) {
      log.warn({ err, type: event.type }, 'broadcast failed')
    }
  }

  function compilerOf(project: ProjectRecord | null): Compiler {
    return project?.settings.compiler ?? 'pdflatex'
  }

  function statusOnly(job: CompileJob, status: CompileStatus, message: string, extra: Partial<CompileResponse> = {}): CompileResponse {
    return {
      status,
      buildId: null,
      jobname: null,
      rootPath: null,
      pdfUrl: null,
      logUrl: null,
      hasSynctex: false,
      outputFiles: [],
      log: null,
      stdout: message,
      externalBuilds: [],
      timings: { syncMs: 0, compileMs: 0, totalMs: Date.now() - job.requestedAt },
      cached: false,
      compiledAt: Date.now(),
      compiler: compilerOf(s.db.projects.get(job.projectId)),
      by: job.user,
      ...extra,
    }
  }

  async function binarySha1(abs: string, st: { ino: number; size: number; mtimeMs: number }): Promise<string> {
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`
    const hit = binaryHashes.get(abs)
    if (hit && hit.key === key) return hit.sha1
    const h = await fileSha1(abs)
    binaryHashes.set(abs, { key, sha1: h })
    return h
  }

  /** Live snapshot of the project's files (text from collab, binaries from disk). */
  async function readSnapshot(pid: string): Promise<{ files: FileEntry[]; entries: SnapshotEntry[]; texts: Map<string, string> }> {
    const files = s.files.list(pid)
    const texts = new Map<string, string>()
    const entries = await mapLimit(files, 16, async (f): Promise<SnapshotEntry | null> => {
      try {
        if (f.kind === 'folder') return { path: f.path, kind: 'folder', sha1: '', size: 0 }
        if (f.kind === 'text') {
          const text = await s.collab.getText(pid, f.id)
          texts.set(f.path, text)
          const data = Buffer.from(text, 'utf8')
          return { path: f.path, kind: 'text', sha1: sha1(data), size: data.length, data }
        }
        const abs = s.files.absPath(pid, f.path)
        const st = await fs.lstat(abs)
        if (!st.isFile()) return null
        return { path: f.path, kind: 'binary', sha1: await binarySha1(abs, st), size: st.size, source: abs }
      } catch (err) {
        log.warn({ err, projectId: pid, path: f.path }, 'skipping unreadable file in compile snapshot')
        return null
      }
    })
    return { files, entries: entries.filter((e): e is SnapshotEntry => e !== null), texts }
  }

  async function pickRoot(files: FileEntry[], texts: Map<string, string>, project: ProjectRecord, requested?: string): Promise<FileEntry | null> {
    if (requested) {
      const f = files.find(x => x.id === requested)
      if (!f || f.kind !== 'text' || !texts.has(f.path)) throw badRequest('The requested main document does not exist or is not a text file')
      return f
    }
    const configured = project.settings.rootFileId ? files.find(x => x.id === project.settings.rootFileId) : undefined
    if (configured && configured.kind === 'text' && texts.has(configured.path)) return configured
    const candidates: FileEntry[] = []
    for (const f of files) {
      if (f.kind !== 'text' || extname(f.path) !== 'tex') continue
      const text = texts.get(f.path)
      if (text !== undefined && await hasDocumentclass(text)) candidates.push(f)
    }
    const depth = (p: string) => p.split('/').length
    candidates.sort((a, b) => {
      const am = a.path.split('/').pop() === 'main.tex' ? 0 : 1
      const bm = b.path.split('/').pop() === 'main.tex' ? 0 : 1
      return am - bm || depth(a.path) - depth(b.path) || comparePaths(a.path, b.path)
    })
    return candidates[0] ?? null
  }

  async function prepare(job: CompileJob): Promise<{ prepared: Prepared } | { response: CompileResponse }> {
    const t0 = Date.now()
    const pid = job.projectId
    assertProjectId(pid)
    const project = s.db.projects.get(pid)
    if (!project) throw notFound('Project not found')
    const { files, entries, texts } = await readSnapshot(pid)
    const root = await pickRoot(files, texts, project, job.req.rootFileId)
    const compiler = compilerOf(project)
    if (!root) {
      return { response: statusOnly(job, 'no-root', 'No main document found: add a .tex file with \\documentclass or choose the main document in the project settings.') }
    }
    if (!SAFE_TEX_PATH.test(root.path)) {
      return {
        response: statusOnly(job, 'error', `The main document "${root.path}" cannot be compiled because its name contains characters TeX tools cannot handle safely. Rename it using letters, digits, spaces and - _ . + @ = ~ ( ) [ ].`,
          { rootPath: root.path, jobname: jobnameOf(root.path) }),
      }
    }
    const textPaths = new Map<string, string>()
    for (const e of entries) if (e.kind === 'text') textPaths.set(e.path, e.sha1)
    const shaOf = new Map<string, string>()
    for (const e of entries) if (e.kind !== 'folder') shaOf.set(e.path, e.sha1)
    const projectPaths = new Set(shaOf.keys())
    const explicit = Array.isArray(project.settings.externalDocs) ? project.settings.externalDocs.filter(x => typeof x === 'string') : []
    // \externaldocument may sit in a preamble file the root \input's: follow the includes
    const mainNames = await detectExternalDocuments(root.path, texts)
    const isTextFile = (q: string) => textPaths.has(q)
    // the listed external documents belong to the main document: when one of them is compiled
    // on its own (e.g. the open file), its own \externaldocument lines decide
    const useExplicit = explicit.length > 0 && !resolveExternalDocs({ rootPath: '', explicit, detected: [], isTextFile }).includes(root.path)
    const externalPaths: string[] = []
    for (const p of resolveExternalDocs({ rootPath: root.path, explicit: useExplicit ? explicit : [], detected: useExplicit ? [] : mainNames, isTextFile })) {
      if (!SAFE_TEX_PATH.test(p)) {
        log.warn({ projectId: pid, path: p }, 'skipping external document with an unsafe name')
        continue
      }
      externalPaths.push(p)
    }
    const bases = externalBases(jobnameOf(root.path), externalPaths)
    const externals: PreparedExternal[] = []
    for (const [i, p] of externalPaths.entries()) {
      const imports = importedAuxPaths(p, await detectExternalDocuments(p, texts))
      // the rebuild key covers every project file the external document reads
      const deps = await documentDependencies(p, texts, projectPaths)
      const depsHash = sha1(deps.map(d => `${d}\u0000${shaOf.get(d) ?? ''}`).join('\n'))
      externals.push({ path: p, jobname: jobnameOf(p), depsHash, imports, publishedBase: bases[i] })
    }
    const mainImports = mainNames.length > 0 ? importedAuxPaths(root.path, mainNames) : externals.map(e => outputPath(e.path, 'aux'))
    const settingsTimeout = Number(project.settings.timeoutSec)
    const timeoutSec = Math.min(Math.max(Number.isFinite(settingsTimeout) && settingsTimeout > 0 ? settingsTimeout : config.compile.defaultTimeoutSec, 1), config.compile.maxTimeoutSec)

    const h = createHash('sha256')
    h.update(JSON.stringify({
      v: 1, compiler, draft: !!job.req.draft, stopOnFirstError: !!job.req.stopOnFirstError, rootPath: root.path,
      externals: externals.map(e => e.path), image: config.compile.image, runner: runner.kind,
    }))
    for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
      h.update(`\n${e.kind}\u0000${e.path}\u0000${e.sha1}`)
    }
    return {
      prepared: {
        hash: h.digest('hex'),
        compiler,
        rootPath: root.path,
        jobname: jobnameOf(root.path),
        externals,
        mainImports,
        entries,
        projectFiles: files.filter(f => f.kind !== 'folder').map(f => f.path),
        texts,
        timeoutMs: timeoutSec * 1000,
        snapshotMs: Date.now() - t0,
      },
    }
  }

  async function cachedBuild(pid: string, p: Prepared): Promise<CompileResponse | null> {
    const st = states.get(pid)
    const hit = st?.lastSuccess.get(p.rootPath)
    if (!st || !hit || hit.hash !== p.hash || !hit.response.buildId) return null
    const meta = await readBuildMeta(path.join(buildsDirOf(pid), hit.response.buildId))
    if (!meta) {
      st.lastSuccess.delete(p.rootPath)
      return null
    }
    st.last.set(p.rootPath, hit.response)
    st.newest = hit.response
    return { ...hit.response, cached: true }
  }

  function skipSet(p: Prepared): Set<string> {
    const skip = new Set<string>()
    for (const doc of [p.rootPath, ...p.externals.map(e => e.path)]) {
      for (const ext of JOB_PRODUCTS) skip.add(outputPath(doc, ext))
    }
    return skip
  }

  // -------------------------------------------------------------------------
  // the build
  // -------------------------------------------------------------------------

  async function runBuild(job: CompileJob, p: Prepared, signal: AbortSignal, buildId: string): Promise<CompileResponse> {
    const pid = job.projectId
    const compileDir = compileDirOf(pid)
    const req = job.req
    const syncStart = Date.now()
    if (req.fromScratch) await fs.rm(compileDir, { recursive: true, force: true })
    const { manifest } = await syncCompileDir(compileDir, p.entries, { skip: skipSet(p) })
    const syncMs = p.snapshotMs + (Date.now() - syncStart)

    const compileStart = Date.now()
    await runner.warmup()
    const deadline = Date.now() + p.timeoutMs
    const remaining = () => Math.max(1, deadline - Date.now())

    // xr external documents, built first when their .aux is missing, their source changed or the
    // labels they import (mutual xr: the main document's) changed since their last build
    const externalBuilds: CompileResponse['externalBuilds'] = []
    let aborted: LatexmkOutcome | null = null
    const stopped = (o: LatexmkOutcome) => o.timedOut || o.terminated || !!o.error
    const extKey = async (ext: PreparedExternal) => `${ext.depsHash}:${p.compiler}:${await importedLabelsHash(compileDir, ext.imports)}`
    const extUpToDate = async (ext: PreparedExternal) =>
      manifest.externals[ext.path] === await extKey(ext) && !!await safeFileStat(compileDir, outputPath(ext.path, 'aux'))
    const buildExternal = async (ext: PreparedExternal, i: number, pass: string): Promise<LatexmkOutcome> => {
      const key = await extKey(ext)
      const pdfRel = outputPath(ext.path, 'pdf')
      const before = await fingerprint(compileDir, pdfRel)
      // -gt: we know an input changed (possibly only an imported .aux latexmk does not track)
      const out = await runner.latexmk({
        name: `${namePrefix}${buildId}-${pass}${i}`, projectId: pid, compileDir, rootPath: ext.path, jobname: ext.jobname,
        compiler: p.compiler, draft: !!req.draft, stopOnFirstError: false, force: true, timeoutMs: remaining(), signal,
      })
      const after = await fingerprint(compileDir, pdfRel)
      const pdfOk = !!after && after.size > 0 && (after.key !== before?.key || out.code === 0)
      const entry = { path: ext.path, status: classify(out, pdfOk, false) }
      const at = externalBuilds.findIndex(e => e.path === ext.path)
      if (at >= 0) externalBuilds[at] = entry
      else externalBuilds.push(entry)
      if (!stopped(out) && await safeFileStat(compileDir, outputPath(ext.path, 'aux'))) manifest.externals[ext.path] = key
      else delete manifest.externals[ext.path]
      return out
    }
    for (const [i, ext] of p.externals.entries()) {
      if (signal.aborted) {
        aborted = { code: null, output: '', timedOut: false, terminated: true, error: null, durationMs: 0 }
        break
      }
      if (await extUpToDate(ext)) continue
      const out = await buildExternal(ext, i, 'x')
      if (stopped(out)) {
        aborted = out
        break
      }
    }

    // main document
    const candidates = MAIN_OUTPUTS.concat(p.compiler === 'latex' ? ['dvi'] : [])
    const before = new Map<string, Fingerprint | null>()
    for (const ext of candidates) before.set(ext, await fingerprint(compileDir, outputPath(p.rootPath, ext)))
    let outcome: LatexmkOutcome
    let pdfOk = false
    if (aborted) {
      outcome = aborted
    } else {
      // Manual compiles always run *latex (-gt). Auto compiles too when the options changed
      // (latexmk ignores a changed -usepretex) or when the previous run ended with an error:
      // latexmk would then only repeat "gave an error in previous invocation" (exit 12) without
      // running TeX, and the build would have neither a new PDF nor a log.
      const optionsKey = JSON.stringify([p.compiler, !!req.draft, !!req.stopOnFirstError])
      const force = !req.auto || manifest.jobs[p.rootPath] !== `${optionsKey}:ok`
      let mainRuns = 0
      const runMain = (f: boolean) => runner.latexmk({
        name: `${namePrefix}${buildId}${mainRuns++ > 0 ? `-m${mainRuns}` : ''}`, projectId: pid, compileDir, rootPath: p.rootPath, jobname: p.jobname,
        compiler: p.compiler, draft: !!req.draft, stopOnFirstError: !!req.stopOnFirstError, force: f,
        timeoutMs: remaining(), signal,
      })
      outcome = await runMain(force)
      if (!force && isNoOpFailure(outcome)) outcome = await runMain(true)
      if (!stopped(outcome) && p.externals.some(e => e.imports.length > 0)) {
        // mutual xr: externals that import this document's labels are rebuilt when this run
        // changed them, so their PDFs do not keep '??'; if that changes the labels this
        // document imports, it runs once more
        const mainLabels = await importedLabelsHash(compileDir, p.mainImports)
        let rebuilt = false
        for (const [i, ext] of p.externals.entries()) {
          if (ext.imports.length === 0 || await extUpToDate(ext)) continue
          const out = await buildExternal(ext, i, 'y')
          rebuilt = true
          if (stopped(out)) {
            outcome = out
            break
          }
        }
        if (rebuilt && !stopped(outcome) && await importedLabelsHash(compileDir, p.mainImports) !== mainLabels) {
          outcome = await runMain(true)
        }
      }
      const after = await fingerprint(compileDir, outputPath(p.rootPath, 'pdf'))
      pdfOk = !!after && after.size > 0 && (after.key !== before.get('pdf')?.key || outcome.code === 0)
      if (!stopped(outcome)) manifest.jobs[p.rootPath] = `${optionsKey}:${outcome.code === 0 ? 'ok' : 'error'}`
      else delete manifest.jobs[p.rootPath]
    }
    const status = classify(outcome, pdfOk, !!req.stopOnFirstError)
    const compileMs = Date.now() - compileStart

    // outputs
    const items: PublishItem[] = []
    for (const ext of candidates) {
      const rel = outputPath(p.rootPath, ext)
      if (status !== 'success') {
        if (ext === 'pdf' || ext === 'synctex.gz' || ext === 'dvi') continue
        const now = await fingerprint(compileDir, rel)
        if (!now || now.key === before.get(ext)?.key) continue
      }
      items.push({ rel, name: publishedName(`${p.jobname}.${ext}`) })
    }
    // the main document's files: its PDF / log are never taken from anything else
    const mainNames = new Set(items.map(i => i.name))
    for (const ext of p.externals) {
      for (const e of ['pdf', 'log']) items.push({ rel: outputPath(ext.path, e), name: `${ext.publishedBase}.${e}`, reusable: true })
    }
    const buildDir = path.join(buildsDirOf(pid), buildId)
    const outputFiles = await publishBuild({ compileDir, buildDir, projectId: pid, buildId, items, reuse: stateOf(pid).published })
    const hasBuild = outputFiles.length > 0
    if (!hasBuild) await fs.rm(buildDir, { recursive: true, force: true })

    const mainFile = (name: string) => (mainNames.has(name) ? outputFiles.find(f => f.path === name) ?? null : null)
    const pdfFile = mainFile(publishedName(`${p.jobname}.pdf`))
    const logFile = mainFile(publishedName(`${p.jobname}.log`))
    const blgFile = mainFile(publishedName(`${p.jobname}.blg`))
    const readOut = async (name: string | undefined): Promise<Buffer | null> => {
      if (!name) return null
      const abs = path.join(buildDir, name)
      const st = await fs.lstat(abs).catch(() => null)
      if (!st?.isFile()) return null
      if (st.size <= MAX_LOG_BYTES) return fs.readFile(abs)
      const fh = await fs.open(abs, 'r')
      try {
        const buf = Buffer.alloc(MAX_LOG_BYTES)
        await fh.read(buf, 0, MAX_LOG_BYTES, 0)
        return buf
      } finally {
        await fh.close()
      }
    }
    const parsed = await parseCompileLogs({
      logBytes: await readOut(logFile?.path),
      blgText: (await readOut(blgFile?.path))?.toString('utf8') ?? null,
      stdout: outcome.output,
      projectFiles: p.projectFiles,
      rootPath: p.rootPath,
      texCompileDir: runner.texCompileDir(compileDir),
      getSource: q => p.texts.get(q) ?? null,
    })
    if (parsed) {
      // the external documents' own problems: their errors, and references they left undefined
      for (const ext of p.externals) {
        const f = outputFiles.find(o => o.path === `${ext.publishedBase}.log`)
        const bytes = f ? await readOut(f.path) : null
        if (!bytes) continue
        const xl = await parseCompileLogs({
          logBytes: bytes, blgText: null, stdout: '', projectFiles: p.projectFiles, rootPath: ext.path,
          texCompileDir: runner.texCompileDir(compileDir), getSource: q => p.texts.get(q) ?? null,
        })
        if (!xl) continue
        parsed.errors.push(...xl.errors)
        const undef = xl.warnings.filter(w => w.kind === 'undefined-reference' || w.kind === 'undefined-citation')
        if (undef.length > 0) {
          parsed.warnings.push({
            level: 'warning', source: 'latex', kind: 'external-undefined-references', file: ext.path, line: null,
            message: `${ext.path} (external document): ${undef.length} undefined reference${undef.length === 1 ? '' : 's'} or citation${undef.length === 1 ? '' : 's'}`,
            content: undef.slice(0, 20).map(w => `${w.file ?? ''}${w.line ? `:${w.line}` : ''} ${w.message}`.trim()).join('\n') +
              (undef.length > 20 ? `\n… and ${undef.length - 20} more` : ''),
            hint: 'The PDF of this external document shows ?? for these references or citations. Check the label names and the prefix given to \\externaldocument; Folio rebuilds the external document after the main one whenever the labels it imports change.',
          })
        }
      }
    }

    let stdout = tail(outcome.output, STDOUT_TAIL)
    if (status === 'timedout') stdout += `\n[Folio] The compile was stopped after the ${Math.round(p.timeoutMs / 1000)} s timeout.`
    else if (status === 'terminated') stdout += '\n[Folio] The compile was stopped.'
    else if (outcome.error) stdout += `\n[Folio] ${outcome.error}`

    const response: CompileResponse = {
      status,
      buildId: hasBuild ? buildId : null,
      jobname: p.jobname,
      rootPath: p.rootPath,
      pdfUrl: pdfFile?.url ?? null,
      logUrl: logFile?.url ?? null,
      hasSynctex: outputFiles.some(f => f.type === 'synctex.gz'),
      outputFiles,
      log: parsed,
      stdout,
      externalBuilds,
      timings: { syncMs, compileMs, totalMs: Date.now() - job.requestedAt },
      cached: false,
      compiledAt: Date.now(),
      compiler: p.compiler,
      by: job.user,
    }
    if (hasBuild) await writeBuildMeta(buildDir, response)

    if (status === 'timedout' || status === 'terminated') {
      // partially written .aux/.toc files would poison the next run
      await emptyDir(compileDir)
    } else {
      await writeManifest(compileDir, manifest)
    }
    return response
  }

  async function execute(job: CompileJob, p: Prepared, signal: AbortSignal): Promise<CompileResponse> {
    const pid = job.projectId
    const buildId = newBuildId()
    broadcast(pid, { type: 'compile:started', by: job.user, auto: !!job.req.auto, rootPath: p.rootPath })
    let response: CompileResponse
    try {
      response = await withDirLock(pid, () => runBuild(job, p, signal, buildId))
    } catch (err) {
      log.error({ err, projectId: pid }, 'compile failed with an internal error')
      response = statusOnly(job, 'error', `Internal error while compiling: ${(err as Error).message}`, { rootPath: p.rootPath, jobname: p.jobname, compiler: p.compiler })
    }
    const st = stateOf(pid)
    // after a restart: what is on disk (other roots' last builds, the last good PDF) stays pinned
    await loadFromDisk(pid, st)
    if (response.buildId) {
      st.last.set(p.rootPath, response)
      st.newest = response
    }
    if (response.status === 'success' && response.buildId && response.pdfUrl) st.lastSuccess.set(p.rootPath, { hash: p.hash, response })
    const keep = pinnedBuilds(pid, st, Date.now())
    pruneBuilds(buildsDirOf(pid), { keep }).catch(err => log.warn({ err, projectId: pid }, 'pruning old builds failed'))
    broadcast(pid, { type: 'compile:done', by: job.user, status: response.status, buildId: response.buildId, rootPath: p.rootPath, jobname: p.jobname })
    return response
  }

  const coordinator = new CompileCoordinator<Prepared>({
    prepare,
    execute,
    statusOnly: (job, status, message) => statusOnly(job, status, message),
    cachedBuild,
  }, { maxConcurrent: config.compile.maxConcurrent, userGuardMs: opts.userGuardMs })

  // -------------------------------------------------------------------------
  // CompileService
  // -------------------------------------------------------------------------

  async function wipeProject(pid: string, what: { previews: boolean }): Promise<void> {
    await coordinator.stop(pid)
    await coordinator.idle(pid)
    await withDirLock(pid, async () => {
      await fs.rm(compileDirOf(pid), { recursive: true, force: true })
      await fs.rm(buildsDirOf(pid), { recursive: true, force: true })
      if (what.previews) await fs.rm(previewsDirOf(pid), { recursive: true, force: true })
    })
    states.delete(pid)
    recentAccess.delete(pid)
  }

  /**
   * "Clear cached files" never cancels a compile (possibly a collaborator's): while one runs it
   * is refused with 409, checked again once the compile directory lock is held.
   */
  async function clearProjectCache(pid: string): Promise<void> {
    const busy = () => new HttpError(409, 'compile_running', 'A compile is running. Clear the cached files when it has finished.')
    const compiling = () => (inProgress.get(pid) ?? 0) > 0
    if (compiling()) throw busy()
    await withDirLock(pid, async () => {
      if (compiling()) throw busy()
      await fs.rm(compileDirOf(pid), { recursive: true, force: true })
      await fs.rm(buildsDirOf(pid), { recursive: true, force: true })
      states.delete(pid)
      recentAccess.delete(pid)
    })
  }

  /** Newest build of a root document that has a PDF (in memory, else from the builds on disk). */
  async function lastWithPdf(pid: string, st: ProjectState, root: string): Promise<CompileResponse | null> {
    const known = st.lastSuccess.get(root)?.response
    if (known?.pdfUrl && known.buildId && await readBuildMeta(path.join(buildsDirOf(pid), known.buildId))) return known
    const meta = await newestSuccess(pid, root)
    // pinned by retention from now on (the keep list includes lastSuccess)
    if (meta) st.lastSuccess.set(root, { hash: '', response: meta })
    else st.lastSuccess.delete(root)
    return meta
  }

  /** meta.json of the newest successful build (with a PDF) of a root document on disk */
  async function newestSuccess(pid: string, root: string): Promise<CompileResponse | null> {
    for (const id of await listBuildIds(buildsDirOf(pid))) {
      const meta = await readBuildMeta(path.join(buildsDirOf(pid), id))
      if (meta && meta.buildId === id && meta.status === 'success' && meta.pdfUrl && rootOf(meta) === root) return meta
    }
    return null
  }

  /** Path of the document a compile without an explicit root builds (settings, else auto-detected). */
  async function defaultRootPath(pid: string): Promise<string | null> {
    const project = s.db.projects.get(pid)
    if (!project) return null
    const files = s.files.list(pid)
    const configured = project.settings.rootFileId ? files.find(x => x.id === project.settings.rootFileId) : undefined
    if (configured?.kind === 'text') return configured.path
    const texts = new Map<string, string>()
    for (const f of files) {
      if (f.kind !== 'text' || extname(f.path) !== 'tex') continue
      try {
        texts.set(f.path, await s.collab.getText(pid, f.id))
      } catch {
        // unreadable: not a candidate
      }
    }
    return (await pickRoot(files, texts, project))?.path ?? null
  }

  async function dirNames(dir: string): Promise<string[]> {
    try {
      return (await fs.readdir(dir, { withFileTypes: true })).filter(d => d.isDirectory() && isValidProjectId(d.name)).map(d => d.name)
    } catch {
      return []
    }
  }

  /** mtime of the newest of the given paths (0 when none exists) */
  async function newestMtime(paths: string[]): Promise<number> {
    let newest = 0
    for (const p of paths) {
      const st = await fs.lstat(p).catch(() => null)
      if (st && st.mtimeMs > newest) newest = st.mtimeMs
    }
    return newest
  }

  async function sweep(o: CompileSweepOptions = {}): Promise<CompileSweepResult> {
    const now = o.now ?? Date.now()
    const idleMs = o.idleMs ?? COMPILE_DIR_IDLE_MS
    const previewMaxAge = o.previewMaxAgeMs ?? PREVIEW_MAX_AGE_MS
    const out: CompileSweepResult = { builds: 0, compileDirs: 0, orphans: 0, previews: 0 }
    const pids = new Set([...await dirNames(config.dirs.compiles), ...await dirNames(config.dirs.builds), ...await dirNames(config.dirs.previews)])
    for (const pid of pids) {
      try {
        if (coordinator.isRunning(pid)) continue
        if (!s.db.projects.get(pid)) {
          // the project was deleted while the server was down (or a delete failed half-way)
          await withDirLock(pid, async () => {
            if (s.db.projects.get(pid)) return
            await fs.rm(compileDirOf(pid), { recursive: true, force: true })
            await fs.rm(buildsDirOf(pid), { recursive: true, force: true })
            await fs.rm(previewsDirOf(pid), { recursive: true, force: true })
          })
          states.delete(pid)
          out.orphans++
          continue
        }
        const compileDir = compileDirOf(pid)
        const lastUse = await newestMtime([compileDir, path.join(compileDir, '.folio-sync.json')])
        const newestBuild = (await listBuildIds(buildsDirOf(pid)))[0]
        const lastBuildAt = newestBuild ? parseInt(newestBuild.slice(0, newestBuild.indexOf('-')), 16) : 0
        const idle = now - Math.max(lastUse, lastBuildAt) > idleMs
        // after a restart nothing is in memory: still never delete a root's last build with a PDF
        const st = stateOf(pid)
        await loadFromDisk(pid, st)
        const keep = pinnedBuilds(pid, st, now)
        await withDirLock(pid, async () => {
          if (coordinator.isRunning(pid)) return
          out.builds += (await pruneBuilds(buildsDirOf(pid), idle ? { keepNewest: 1, maxAgeMs: 0, keep, now } : { keep, now })).length
          if (idle && lastUse > 0) {
            await fs.rm(compileDir, { recursive: true, force: true })
            out.compileDirs++
          }
        })
        const previews = previewsDirOf(pid)
        for (const name of await fs.readdir(previews).catch(() => [] as string[])) {
          const st2 = await fs.lstat(path.join(previews, name)).catch(() => null)
          if (st2 && now - st2.mtimeMs > previewMaxAge) {
            await fs.rm(path.join(previews, name), { recursive: true, force: true })
            out.previews++
          }
        }
      } catch (err) {
        log.warn({ err, projectId: pid }, 'compile housekeeping failed for a project')
      }
    }
    if (out.builds || out.compileDirs || out.orphans || out.previews) log.info(out, 'compile housekeeping')
    return out
  }

  async function wordCountNow(projectId: string, rootFileId?: string): Promise<WordCountResponse> {
    const job: CompileJob = {
      projectId,
      user: { id: '', name: '', email: '', color: '' },
      req: rootFileId ? { rootFileId } : {},
      requestedAt: Date.now(),
    }
    const prep = await prepare(job)
    if ('response' in prep) {
      if (prep.response.status === 'no-root') throw badRequest('No main document found')
      throw badRequest(prep.response.stdout)
    }
    const p = prep.prepared
    return withDirLock(projectId, async () => {
      const compileDir = compileDirOf(projectId)
      await syncCompileDir(compileDir, p.entries, { skip: skipSet(p) })
      const rootDir = path.posix.dirname(p.rootPath)
      const r = await runner.tool({
        name: `${namePrefix}wc-${randomBytes(6).toString('hex')}`,
        projectId,
        argv: texcountArgv(path.posix.basename(p.rootPath)),
        mounts: [{ host: compileDir, container: '/compile', ro: true }],
        workdir: rootDir === '.' ? '/compile' : `/compile/${rootDir}`,
        timeoutMs: WORDCOUNT_TIMEOUT_MS,
      })
      if (r.error) throw new HttpError(503, 'unavailable', `Word count is unavailable: ${r.error}`)
      if (r.timedOut) throw new HttpError(504, 'timeout', 'Word count took too long')
      const raw = r.stdout.toString('utf8')
      if (r.code !== 0 || !looksLikeTexcount(raw)) {
        throw new HttpError(422, 'wordcount_failed', 'texcount could not count this document', { stderr: r.stderr.slice(-2000) })
      }
      return { rootPath: p.rootPath, ...parseTexcount(raw), raw }
    })
  }

  const service: FolioCompileService = {
    runner,
    sweep,

    compile(projectId: string, user: UserPublic, req: CompileRequest): Promise<CompileResponse> {
      assertProjectId(projectId)
      if (!s.db.projects.get(projectId)) return Promise.reject(notFound('Project not found'))
      const clean: CompileRequest = {
        ...(req.rootFileId ? { rootFileId: req.rootFileId } : {}),
        draft: !!req.draft,
        stopOnFirstError: !!req.stopOnFirstError,
        auto: !!req.auto,
        fromScratch: !!req.fromScratch,
      }
      inProgress.set(projectId, (inProgress.get(projectId) ?? 0) + 1)
      return coordinator.compile({ projectId, user, req: clean, requestedAt: Date.now() }).finally(() => {
        const left = (inProgress.get(projectId) ?? 1) - 1
        if (left <= 0) inProgress.delete(projectId)
        else inProgress.set(projectId, left)
      })
    },

    async stop(projectId: string): Promise<void> {
      assertProjectId(projectId)
      await coordinator.stop(projectId)
    },

    async clearCache(projectId: string): Promise<void> {
      assertProjectId(projectId)
      await clearProjectCache(projectId)
    },

    async lastBuild(projectId: string, opts: { rootPath?: string; main?: boolean } = {}): Promise<CompileResponse | null> {
      assertProjectId(projectId)
      const st = stateOf(projectId)
      await loadFromDisk(projectId, st)
      let last: CompileResponse | null
      if (opts.rootPath !== undefined) last = st.last.get(opts.rootPath) ?? null
      else if (opts.main) {
        const root = await defaultRootPath(projectId)
        last = root === null ? null : st.last.get(root) ?? null
      } else last = st.newest
      if (!last || last.pdfUrl) return last
      // a failed / stopped / timed-out build has no PDF: point at the newest build of the same
      // document that has one, so a reload (or a viewer) still shows the last good PDF
      const good = await lastWithPdf(projectId, st, rootOf(last))
      return good && good.buildId !== last.buildId ? { ...last, lastWithPdf: good } : last
    },

    resolveBuildFile(projectId: string, buildId: string, file: string): string | null {
      const abs = resolveBuildFileIn(config.dirs.builds, projectId, buildId, file)
      // a client is reading this build (PDF ranges, SyncTeX): retention keeps it for a while
      if (abs && file !== 'meta.json') noteAccess(projectId, buildId)
      return abs
    },

    wordCount(projectId: string, rootFileId?: string): Promise<WordCountResponse> {
      assertProjectId(projectId)
      // concurrent requests for the same document share one texcount run
      const key = `${projectId}\u0000${rootFileId ?? ''}`
      let pending = wordCounts.get(key)
      if (!pending) {
        pending = toolSlot(() => wordCountNow(projectId, rootFileId)).finally(() => wordCounts.delete(key))
        wordCounts.set(key, pending)
      }
      return pending
    },

    async renderPreview(projectId: string, fileId: string): Promise<Buffer> {
      assertProjectId(projectId)
      const f = s.files.get(projectId, fileId)
      if (!f || f.kind === 'folder') throw notFound('File not found')
      const ext = extname(f.path)
      if (f.kind !== 'binary' || !PREVIEW_EXTENSIONS.has(ext)) throw badRequest('Previews are only rendered for EPS and PostScript files')
      return renderPreviewCached({
        runner: limitedRunner,
        projectId,
        source: s.files.absPath(projectId, f.path),
        ext,
        cacheDir: previewsDirOf(projectId),
        tmpDir: config.dirs.tmp,
        containerName: `${namePrefix}gs-${randomBytes(6).toString('hex')}`,
      })
    },

    async deleteProject(projectId: string): Promise<void> {
      assertProjectId(projectId)
      await wipeProject(projectId, { previews: true })
      coordinator.forget(projectId)
    },

    async info() {
      const i = await runner.info()
      return { runner: runner.kind, image: config.compile.image, texLive: i.texLive, dockerOk: i.dockerOk }
    },

    async shutdown(): Promise<void> {
      await coordinator.shutdown()
      if (runner.kind === 'docker') await runner.reap().catch(() => 0)
    },
  }
  return service
}
