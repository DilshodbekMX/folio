/**
 * HistoryService — per-project version history on the git CLI (SPEC §4.6).
 *
 * Layout: the git dir is `<dataDir>/history/<pid>.git` (created `git init --bare`, then
 * `core.bare=false`); the work tree is the project directory, which only ever holds user files.
 * See git.ts for the hardening flags/environment of every git invocation.
 *
 * Concurrency: two levels of per-project serialisation.
 *   - `ops` (this file) serialises multi-step mutations of one project: snapshot, restore,
 *     label, init, delete. Restore holds it across pre-snapshot → apply → snapshot.
 *   - the runner (git.ts) serialises individual git processes per git dir, so read commands
 *     (log/show/ls-tree) never overlap a running add/commit either.
 *
 * Snapshot = collab.flushProject → `git add -A --force` → commit only if the index differs
 * from HEAD. Authors = explicit user + collab.takeEditors + users seen by noteActivity.
 *
 * Deviations from the letter of SPEC §4.6 (all keep the public contract):
 *   - `--work-tree` is passed only while the project directory exists: git refuses to run any
 *     command when it points at a missing directory (verified with git 2.34.1), which would
 *     break reads while a project is being deleted. `git add` never runs without it.
 *   - The snapshot taken before a restore is recorded with reason 'auto' (summary
 *     "Auto-save before restore"): it only captures pending edits, so the list does not show
 *     two "restore" versions per restore.
 *   - Entries whose name starts with `.git` / `.folio` (reserved by shared/paths.ts) are
 *     excluded from snapshots, and `info/attributes` neutralises in-tree .gitattributes, so a
 *     file planted in the project dir can never change what git records.
 *   - `copyProject` starts a fresh history (like Overleaf: copies start with empty history).
 *   - `archive` writes `git archive --format=zip` to a temp file (unlinked immediately after
 *     opening) and returns a stream of it, so git errors surface before any response byte is
 *     sent and a slow download never holds the project's git lock.
 *   - versionId 'HEAD' is accepted wherever a version is expected; `archive(pid, 'HEAD')`
 *     snapshots first so "download current version" includes the latest edits.
 *
 * Crash safety:
 *   - The users of a pending snapshot window are also kept in `<git dir>/folio-pending.json`
 *     (rewritten when someone new joins the window), and `recoverAfterRestart()` (main.ts, after
 *     listening) commits every work tree that differs from HEAD — edits saved to disk but not yet
 *     snapshotted when the server died — crediting those users ('Recovered after restart').
 *     `loadPendingAuthors()` (main.ts, before listening) reads every such file first: until a
 *     project's next version credits them, those users stay in its pending file and in whichever
 *     version comes first (the recovery, or an idle / pre-delete snapshot of an edit made after
 *     the restart) — a collaborator reconnecting right after the restart cannot overwrite them.
 *   - git lock files older than this process are left over from a crash (all git commands of a
 *     repository are serialised in this process) and removed before the next snapshot; a lock
 *     that still blocks git surfaces as 503 "busy", not 500.
 *   - A project restore keeps folders that are empty now (git records no folders, so an empty
 *     folder cannot differ from the version) — unless the version has a file at that path.
 *   - Housekeeping: after `gcEveryCommits` commits of a project, or `gcIntervalMs` after its last
 *     check when enough loose objects piled up, `git gc` packs the repository. The counters live
 *     in `<git dir>/folio-gc.json`, so restarts do not reset them (`gc --auto` is not used: it
 *     estimates from one objects/ subdirectory and often declines).
 *
 * Deletes: FileService.remove (and writeFile replacing an existing file) calls
 * `snapshotBeforeDelete` first, so edits made to a file since the last version (typed, uploaded,
 * saved by collab or still only in a live Y.Doc) are committed before the file disappears — they
 * would otherwise be lost with it when the delete falls inside the 30 s idle window. It costs
 * nothing while nothing changed since the last snapshot (no activity noted, collab's edit
 * counter unchanged — see quietSinceLastSnapshot); otherwise it takes the `ops` lock,
 * flushes live docs, runs one `git status` and commits (reason 'file-op') only when the deleted
 * paths differ from HEAD. It releases the lock before FileService takes its project lock.
 * Lock order: `ops` before the project lock (files/lock.ts), never the other way round — a
 * restore holds `ops` while it calls into FileService (which takes the project lock), so no
 * code may wait for `ops` while holding the project lock (projects/service.ts deletes a
 * project's history BEFORE taking its project lock). A restore stops as soon as its project is
 * deleted. A restore removing files calls snapshotBeforeDelete from inside its own `ops` hold —
 * `locked()` records the hold in an AsyncLocalStorage context — and it returns at once: the
 * restore snapshotted first.
 * Residual window: an edit that reaches a live document after the flush and before FileService
 * discards the document (a few ms) is not in history; the editor that made it keeps its text
 * (web: realtime/recovered.ts).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type {
  HistoryDiffResponse, HistoryFilesResponse, HistoryListResponse, HistoryReason, HistoryVersion,
  Label, RestoreResponse, UserPublic,
} from '@folio/shared/api'
import {
  classifyByName, classifyFile, decodeUtf8Text, MAX_TEXT_FILE_BYTES, MAX_TEXT_LENGTH, normalizeText, textLengthFits,
} from '@folio/shared/filetypes'
import { isWithin, normalizePath, validatePath } from '@folio/shared/paths'
import type { HistoryService, Services } from '../services.ts'
import { toPublic, USER_COLORS } from '../db/index.ts'
import { badRequest, conflict, HttpError, notFound } from '../http/errors.ts'
import { moduleLog } from '../log.ts'
import {
  BLOB_MAX_BUFFER, createGitRunner, FULL_SHA_RE, GitError, KeyedMutex, REV_RE,
  type GitRepo, type GitRunner,
} from './git.ts'
import {
  buildCommitMessage, LOG_FORMAT, parseBatchCheckLine, parseCatFileBatch, parseLog, parseLsTree,
  parseNameStatus, sanitizeIdent, sanitizeLine, type Ident, type LogRecord, type TreeEntry,
} from './parse.ts'
import { SnapshotScheduler } from './scheduler.ts'

export { GitError } from './git.ts'

export interface HistoryServiceOptions {
  /** snapshot after this much quiet time following activity (default 30 s) */
  idleMs?: number
  /** snapshot at the latest this long after the first activity of a window (default 5 min) */
  maxMs?: number
  /** run `git gc` after this many commits of a project (default 200) … */
  gcEveryCommits?: number
  /** … or when its last check is older than this and it has enough loose objects (default 24 h) */
  gcIntervalMs?: number
  /** loose objects that make the interval check run `git gc` (default 100) */
  gcMinLooseObjects?: number
  /** git executable (default 'git') */
  gitBinary?: string
  /** mirror labels as lightweight tags refs/tags/folio-<labelId> (default true) */
  labelTags?: boolean
  /** see UNNOTED_EDIT_SLACK_MS (tests shorten it) */
  unnotedEditSlackMs?: number
}

const DEFAULT_LIST_LIMIT = 50
const MAX_LIST_LIMIT = 200
const MAX_LABEL_LENGTH = 200
/** project ids reach the filesystem: be strict (db ids are 16 url-safe chars) */
const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
/** git lock files older than this are left over from a crashed process */
const STALE_LOCK_MS = 5 * 60_000
/** when this process started: a lock file older than that belongs to a git process of an earlier run */
const PROCESS_STARTED_AT = Date.now() - process.uptime() * 1000
/** lock files git may leave behind in a repository */
const LOCK_FILES = ['index.lock', 'HEAD.lock', 'refs/heads/main.lock', 'packed-refs.lock', 'config.lock', 'shallow.lock']
/** users of the pending snapshot window, kept in the git dir across crashes */
const PENDING_FILE = 'folio-pending.json'
/** gc bookkeeping of the repository (commits since the last check, when it was), kept across restarts */
const GC_FILE = 'folio-gc.json'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** bytes per `git cat-file --batch` call */
const BATCH_BYTES = 32 * 1024 * 1024
/**
 * After a snapshot took a project's pending window, a pre-delete check looks at the work tree
 * for this long instead of trusting "no activity noted": defence in depth for writers that
 * report their changes late (collab reports an edit made inside its 1 s throttle window at the
 * end of that window; its edit counter is checked as well — see quietSinceLastSnapshot).
 */
const UNNOTED_EDIT_SLACK_MS = 5_000

/** Reserved names (shared/paths.ts) never enter history, at any depth. */
const ADD_EXCLUDES = [
  ':(exclude,glob,icase)**/.git*',
  ':(exclude,glob,icase)**/.git*/**',
  ':(exclude,glob,icase)**/.folio*',
  ':(exclude,glob,icase)**/.folio*/**',
]

/** Persisted repository config (the runner adds the same hardening on every call). */
const REPO_CONFIG: [string, string][] = [
  ['core.bare', 'false'],
  ['core.filemode', 'false'],
  ['core.autocrlf', 'false'],
  ['core.quotepath', 'false'],
  ['core.hooksPath', '/dev/null'],
  ['core.fsmonitor', 'false'],
  ['gc.auto', '0'],
  ['user.name', 'Folio'],
  ['user.email', 'folio@localhost'],
]

/** Highest-precedence attributes: in-tree .gitattributes can never convert or filter content. */
const INFO_ATTRIBUTES = '# Folio: neutralise any .gitattributes in the work tree\n' +
  '* -text !eol !filter !diff !merge !ident !working-tree-encoding !export-ignore !export-subst\n'
const INFO_EXCLUDE = '# Folio: the project directory holds only user files — nothing is ignored.\n'

const DEFAULT_SUMMARY: Record<HistoryReason, string> = {
  import: 'Initial import',
  auto: 'Auto-save',
  restore: 'Restore',
  label: 'Label',
  upload: 'Upload',
  'file-op': 'File changes',
  manual: 'Manual snapshot',
  shutdown: 'Auto-save (server shutdown)',
}

interface CommitOptions {
  /** explicit user credited first (restore/label/manual/import) */
  user?: UserPublic | null
  /** first line of the commit message */
  summary?: string
  /** extra user ids to credit (e.g. from a scheduler window already taken) */
  extraUsers?: string[]
  /** restore commits: the version (and file) restored */
  restoredFrom?: { sha: string; time: number | null; path?: string }
}

/** HistoryService plus the crash recovery main.ts runs after start-up. */
export type FolioHistoryService = HistoryService & {
  /**
   * Read the users of every window that was pending when the previous process ended
   * (`folio-pending.json`), before anyone can join a new window (main.ts: before listening).
   * Idempotent; every snapshot and recoverAfterRestart wait for it.
   */
  loadPendingAuthors(): Promise<void>
  /**
   * Commit every project whose work tree differs from HEAD (edits saved to disk before a crash
   * but never snapshotted), crediting the users of the window that was pending. Sequential;
   * returns the number of projects committed.
   */
  recoverAfterRestart(): Promise<number>
}

/** '21 Sep 14:02' (server time; the year only when it is not the current one) */
function formatWhen(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const year = d.getFullYear() !== new Date().getFullYear() ? ` ${d.getFullYear()}` : ''
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** git could not take one of its lock files: someone else holds it (or a crash left it) */
function isLockError(err: unknown): boolean {
  return err instanceof GitError && /\.lock['’]?: File exists|Unable to create '[^']*\.lock'|could not lock|cannot lock ref/i.test(err.stderr + err.message)
}

function busyError(): HttpError {
  return new HttpError(503, 'unavailable', 'The project history is busy. Please try again in a moment.')
}

export function createHistoryService(s: Services, options: HistoryServiceOptions = {}): FolioHistoryService {
  const idleMs = options.idleMs ?? 30_000
  const maxMs = options.maxMs ?? 5 * 60_000
  const gcEvery = options.gcEveryCommits ?? 200
  const gcIntervalMs = options.gcIntervalMs ?? 24 * 60 * 60_000
  const gcMinLoose = options.gcMinLooseObjects ?? 100
  const labelTags = options.labelTags ?? true
  const unnotedEditSlackMs = options.unnotedEditSlackMs ?? UNNOTED_EDIT_SLACK_MS
  const logger = moduleLog('history')

  const ops = new KeyedMutex()
  /** projects whose `ops` lock the current async context holds (see locked()) */
  const holding = new AsyncLocalStorage<ReadonlySet<string>>()
  /** when a snapshot last took each project's pending window (this process) */
  const lastTaken = new Map<string, number>()
  /** collab.editCount(pid) when that window was taken (null: unknown) */
  const editCountAtTake = new Map<string, number | null>()
  const knownRepos = new Set<string>()
  /** projects deleted in this process: never snapshot (and so never re-create) them again */
  const deleted = new Set<string>()
  const gcState = new Map<string, { commits: number; lastAt: number }>()
  /** per project: the gc bookkeeping / gc run in progress (serialised) */
  const gcChains = new Map<string, Promise<void>>()
  /** users of windows pending when the previous process ended, until a version credits them */
  const recoveredUsers = new Map<string, string[]>()
  let pendingLoaded: Promise<void> | null = null
  const inflight = new Set<Promise<unknown>>()
  let closed = false
  let runner: GitRunner | null = null
  let tempSwept = false

  const scheduler = new SnapshotScheduler({ idleMs, maxMs }, (pid, users) => {
    track(locked(pid, () => commitLocked(pid, 'auto', { extraUsers: users })).catch(err => {
      logger.warn({ err, projectId: pid }, 'automatic history snapshot failed')
    }))
  })

  // -------------------------------------------------------------------------
  // plumbing
  // -------------------------------------------------------------------------

  /**
   * Run `fn` holding the project's `ops` lock. The async context remembers that it holds it, so
   * code called from inside (a restore removing files through FileService, which snapshots
   * before deleting) can tell that it must not wait for the lock again (KeyedMutex is not
   * re-entrant: that would deadlock).
   */
  function locked<T>(pid: string, fn: () => Promise<T>): Promise<T> {
    return ops.run(pid, () => holding.run(new Set([...(holding.getStore() ?? []), pid]), fn))
  }

  function holdsLock(pid: string): boolean {
    return holding.getStore()?.has(pid) ?? false
  }

  function git(): GitRunner {
    runner ??= createGitRunner({ home: path.join(s.config.dirs.history, '.home'), binary: options.gitBinary })
    return runner
  }

  function track<T>(p: Promise<T>): Promise<T> {
    inflight.add(p)
    const done = () => { inflight.delete(p) }
    p.then(done, done)
    return p
  }

  function checkProjectId(pid: string): void {
    if (typeof pid !== 'string' || !PROJECT_ID_RE.test(pid)) throw notFound('Project not found')
  }

  function gitDirOf(pid: string): string {
    checkProjectId(pid)
    return path.join(s.config.dirs.history, `${pid}.git`)
  }

  function repoOf(pid: string): GitRepo {
    return { gitDir: gitDirOf(pid), workTree: s.files.projectDir(pid) }
  }

  function tempDir(): string {
    return path.join(s.config.dirs.history, '.tmp')
  }

  async function exists(p: string): Promise<boolean> {
    try {
      await fs.promises.access(p)
      return true
    } catch {
      return false
    }
  }

  async function isDir(p: string): Promise<boolean> {
    try {
      return (await fs.promises.stat(p)).isDirectory()
    } catch {
      return false
    }
  }

  async function hasRepo(pid: string): Promise<boolean> {
    if (knownRepos.has(pid)) return true
    const gd = gitDirOf(pid)
    const ok = (await exists(path.join(gd, 'HEAD'))) && (await isDir(path.join(gd, 'objects')))
    if (ok) knownRepos.add(pid)
    return ok
  }

  /** Remove stale temp files/dirs left by a crash (once per process). */
  async function sweepTemp(): Promise<void> {
    if (tempSwept) return
    tempSwept = true
    const cutoff = Date.now() - 60 * 60_000
    try {
      for (const name of await fs.promises.readdir(tempDir())) {
        const p = path.join(tempDir(), name)
        const st = await fs.promises.stat(p).catch(() => null)
        if (st && st.mtimeMs < cutoff) await fs.promises.rm(p, { recursive: true, force: true })
      }
    } catch { /* no temp dir yet */ }
    try {
      for (const name of await fs.promises.readdir(s.config.dirs.history)) {
        if (!/\.git\.tmp-[0-9a-f]+$/.test(name)) continue
        const p = path.join(s.config.dirs.history, name)
        const st = await fs.promises.stat(p).catch(() => null)
        if (st && st.mtimeMs < cutoff) await fs.promises.rm(p, { recursive: true, force: true })
      }
    } catch { /* no history dir yet */ }
  }

  /** Create the git dir if missing (atomically: init in a temp dir, then rename). Caller holds `ops`. */
  async function ensureRepo(pid: string): Promise<boolean> {
    if (await hasRepo(pid)) return false
    await sweepTemp()
    const gd = gitDirOf(pid)
    await fs.promises.mkdir(s.config.dirs.history, { recursive: true })
    if (await exists(gd)) {
      // Something that is not a usable repository: keep it for inspection, never delete history.
      const aside = `${gd}.invalid-${Date.now()}`
      await fs.promises.rename(gd, aside)
      logger.error({ projectId: pid, movedTo: aside }, 'history git dir was invalid; moved aside and starting a new history')
    }
    const tmp = `${gd}.tmp-${randomBytes(6).toString('hex')}`
    try {
      await git().runBare(['init', '--quiet', '--bare', '--template=', '--initial-branch=main', tmp])
      for (const [k, v] of REPO_CONFIG) await git().runBare(['config', '--file', path.join(tmp, 'config'), k, v])
      await fs.promises.mkdir(path.join(tmp, 'info'), { recursive: true })
      await fs.promises.writeFile(path.join(tmp, 'info', 'exclude'), INFO_EXCLUDE)
      await fs.promises.writeFile(path.join(tmp, 'info', 'attributes'), INFO_ATTRIBUTES)
      await fs.promises.rename(tmp, gd)
    } catch (err) {
      await fs.promises.rm(tmp, { recursive: true, force: true }).catch(() => {})
      throw err
    }
    knownRepos.add(pid)
    return true
  }

  /**
   * A git process killed mid-write (server crash, SIGKILL, power loss) leaves its lock file
   * behind and every later snapshot would fail. All git commands of a repository run one at a
   * time in this process, so a lock older than the process is left over from an earlier run;
   * our own commands never hold a lock for minutes either.
   */
  async function clearStaleLocks(pid: string): Promise<void> {
    const gd = gitDirOf(pid)
    for (const rel of LOCK_FILES) {
      const p = path.join(gd, rel)
      const st = await fs.promises.stat(p).catch(() => null)
      if (st && (st.mtimeMs < PROCESS_STARTED_AT || Date.now() - st.mtimeMs > STALE_LOCK_MS)) {
        await fs.promises.rm(p, { force: true })
        logger.warn({ projectId: pid, lock: rel }, 'removed a stale git lock file')
      }
    }
  }

  // -------------------------------------------------------------------------
  // pending authors (crash safety)
  // -------------------------------------------------------------------------

  const pendingWrites = new Map<string, Promise<void>>()

  /** Persist the users of the project's pending window (or remove the file when there are none). */
  function persistPending(pid: string): Promise<void> {
    const prev = pendingWrites.get(pid) ?? Promise.resolve()
    const next = prev.then(async () => {
      // the file may still hold users of the previous process: read them before replacing it
      await loadPendingAuthors()
      if (deleted.has(pid) || !(await hasRepo(pid))) return
      const file = path.join(gitDirOf(pid), PENDING_FILE)
      const users = [...new Set([...(recoveredUsers.get(pid) ?? []), ...scheduler.users(pid)])]
      if (users.length === 0) {
        await fs.promises.rm(file, { force: true })
        return
      }
      const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`
      await fs.promises.writeFile(tmp, JSON.stringify(users))
      await fs.promises.rename(tmp, file)
    }).catch(err => {
      logger.debug({ err, projectId: pid }, 'could not persist the pending history authors')
    })
    pendingWrites.set(pid, next)
    void next.then(() => { if (pendingWrites.get(pid) === next) pendingWrites.delete(pid) })
    return next
  }

  function loadPendingAuthors(): Promise<void> {
    pendingLoaded ??= (async () => {
      let names: string[]
      try {
        names = await fs.promises.readdir(s.config.dirs.history)
      } catch {
        return
      }
      for (const name of names) {
        const m = /^([A-Za-z0-9_-]{1,64})\.git$/.exec(name)
        if (!m || recoveredUsers.has(m[1])) continue
        const users = await readPending(m[1])
        if (users.length > 0) recoveredUsers.set(m[1], users)
      }
    })()
    return pendingLoaded
  }

  async function readPending(pid: string): Promise<string[]> {
    try {
      const raw = JSON.parse(await fs.promises.readFile(path.join(gitDirOf(pid), PENDING_FILE), 'utf8')) as unknown
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && PROJECT_ID_RE.test(x)).slice(0, 200) : []
    } catch {
      return []
    }
  }

  async function revParse(pid: string, rev: string): Promise<string | null> {
    const r = await git().run(repoOf(pid), ['rev-parse', '--verify', '--quiet', rev], { okCodes: [0, 1, 128] })
    if (r.code !== 0) return null
    const out = r.stdout.toString('utf8').trim()
    return FULL_SHA_RE.test(out) ? out : null
  }

  async function headOf(pid: string): Promise<string | null> {
    if (!(await hasRepo(pid))) return null
    return revParse(pid, 'HEAD^{commit}')
  }

  /** Validate and resolve a version id (full/abbreviated sha or HEAD) to a full commit sha. */
  async function resolveVersion(pid: string, versionId: string): Promise<string> {
    if (typeof versionId !== 'string' || !REV_RE.test(versionId)) throw badRequest('Invalid version id')
    if (!(await hasRepo(pid))) throw notFound('Version not found')
    const sha = await revParse(pid, `${versionId}^{commit}`)
    if (!sha) throw notFound('Version not found')
    return sha
  }

  function checkPath(p: unknown): string {
    if (typeof p !== 'string') throw badRequest('Missing path')
    const n = normalizePath(p)
    const err = validatePath(n)
    if (err) throw badRequest(`Invalid path: ${err}`)
    return n
  }

  async function lsTree(pid: string, sha: string): Promise<TreeEntry[]> {
    const r = await git().run(repoOf(pid), ['ls-tree', '-r', '-z', '--long', '--full-tree', sha])
    return parseLsTree(r.stdout.toString('utf8'))
  }

  /** Blob id/size of `path` at commit `sha`, or null when absent (or not a regular file). */
  async function blobAt(pid: string, sha: string, p: string): Promise<{ oid: string; size: number } | null> {
    const r = await git().run(repoOf(pid), ['cat-file', '--batch-check'], { input: `${sha}:${p}\n` })
    const info = parseBatchCheckLine(r.stdout.toString('utf8'))
    return info && info.type === 'blob' ? { oid: info.oid, size: info.size } : null
  }

  async function readBlob(pid: string, oid: string): Promise<Buffer> {
    const r = await git().run(repoOf(pid), ['cat-file', 'blob', oid], { maxBuffer: BLOB_MAX_BUFFER })
    return r.stdout
  }

  /** Read many blobs with `git cat-file --batch`, in chunks of ≈ BATCH_BYTES. */
  async function readBlobs(pid: string, objs: { oid: string; size: number }[]): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>()
    let chunk: string[] = []
    let bytes = 0
    const flush = async () => {
      if (chunk.length === 0) return
      const r = await git().run(repoOf(pid), ['cat-file', '--batch'], { input: chunk.join('\n') + '\n', maxBuffer: BLOB_MAX_BUFFER })
      for (const o of parseCatFileBatch(r.stdout)) out.set(o.oid, Buffer.from(o.data))
      chunk = []
      bytes = 0
    }
    for (const o of objs) {
      if (out.has(o.oid) || chunk.includes(o.oid)) continue
      if (bytes > 0 && bytes + o.size > BATCH_BYTES) await flush()
      chunk.push(o.oid)
      bytes += o.size
    }
    await flush()
    return out
  }

  function broadcast(pid: string, versionId: string | null): void {
    try {
      s.meta.broadcast(pid, { type: 'history:changed', versionId })
    } catch (err) {
      logger.debug({ err, projectId: pid }, 'history:changed broadcast failed')
    }
  }

  // -------------------------------------------------------------------------
  // authors
  // -------------------------------------------------------------------------

  function colorFor(id: string): string {
    const h = createHash('sha1').update(id).digest()
    return USER_COLORS[h[0] % USER_COLORS.length]
  }

  function syntheticId(ident: Ident): string {
    return 'git-' + createHash('sha256').update((ident.email || ident.name).toLowerCase()).digest('base64url').slice(0, 12)
  }

  function isSystemIdent(ident: Ident): boolean {
    return ident.name === 'Folio' && ident.email === 'folio@localhost'
  }

  /** Credited users of a new commit, in order: explicit user, collab editors, noted users. */
  function commitAuthors(pid: string, opts: CommitOptions, pendingUsers: string[]): UserPublic[] {
    const out: UserPublic[] = []
    const seen = new Set<string>()
    const add = (u: UserPublic | null | undefined) => {
      if (!u || seen.has(u.id)) return
      seen.add(u.id)
      out.push(u)
    }
    add(opts.user ?? null)
    let editors: string[] = []
    try {
      editors = s.collab.takeEditors(pid)
    } catch (err) {
      logger.debug({ err, projectId: pid }, 'collab.takeEditors failed')
    }
    for (const id of [...editors, ...pendingUsers, ...(opts.extraUsers ?? [])]) {
      if (seen.has(id)) continue
      const rec = s.db.users.get(id)
      if (rec) add(toPublic(rec))
    }
    return out
  }

  function versionAuthors(rec: LogRecord, cache: Map<string, UserPublic | null>): UserPublic[] {
    const m = rec.message
    const idents: Ident[] = [{ name: rec.authorName, email: rec.authorEmail }, ...m.coAuthors]
    const out: UserPublic[] = []
    const seen = new Set<string>()
    m.userIds.forEach((id, i) => {
      if (seen.has(id)) return
      seen.add(id)
      let u = cache.get(id)
      if (u === undefined) {
        const r = s.db.users.get(id)
        u = r ? toPublic(r) : null
        cache.set(id, u)
      }
      if (u) {
        out.push(u)
      } else {
        // deleted user: keep the id, fall back to the identity recorded in the commit
        const ident = idents[i]
        out.push({ id, name: ident?.name || 'Deleted user', email: ident?.email ?? '', color: colorFor(id) })
      }
    })
    // identities without an id (commits not written by Folio)
    for (let i = m.userIds.length; i < idents.length; i++) {
      const ident = idents[i]
      if (i === 0 && isSystemIdent(ident)) continue
      if (!ident.name && !ident.email) continue
      const id = syntheticId(ident)
      if (seen.has(id)) continue
      seen.add(id)
      out.push({ id, name: ident.name || ident.email, email: ident.email, color: colorFor(id) })
    }
    return out
  }

  function labelToApi(l: { id: string; name: string; versionId: string; createdAt: number; userId: string | null }, cache?: Map<string, UserPublic | null>): Label {
    let user: UserPublic | null = null
    if (l.userId) {
      if (cache?.has(l.userId)) user = cache.get(l.userId) ?? null
      else {
        const r = s.db.users.get(l.userId)
        user = r ? toPublic(r) : null
        cache?.set(l.userId, user)
      }
    }
    return { id: l.id, name: l.name, versionId: l.versionId, createdAt: l.createdAt, user }
  }

  // -------------------------------------------------------------------------
  // snapshot
  // -------------------------------------------------------------------------

  /** Flush live docs, stage everything, commit when something changed. Caller holds `ops` for pid. */
  async function commitLocked(pid: string, reason: HistoryReason, opts: CommitOptions = {}): Promise<string | null> {
    checkProjectId(pid)
    await loadPendingAuthors()
    // Take the pending window first: activity noted from here on schedules a new snapshot.
    const pendingUsers = scheduler.take(pid) ?? []
    lastTaken.set(pid, Date.now())
    editCountAtTake.set(pid, collabEditCount(pid))
    if (deleted.has(pid)) return null
    const workTree = s.files.projectDir(pid)
    if (!(await isDir(workTree))) return null
    // the users of the window that was pending when the previous process ended are credited by
    // whichever version comes first (the recovery, or a snapshot of an edit made since)
    const recovered = recoveredUsers.get(pid) ?? []
    const extraUsers = [...recovered, ...(opts.extraUsers ?? [])]
    // users to credit again when this snapshot fails (they would be lost with the window)
    let credited = [...pendingUsers, ...extraUsers]
    try {
      const sha = await commitNow(pid, reason, { ...opts, extraUsers }, pendingUsers, ids => { credited = ids })
      // credited now — or the work tree equals HEAD: nothing is left to credit them for
      if (recovered.length > 0 && recoveredUsers.get(pid) === recovered) recoveredUsers.delete(pid)
      if (pendingUsers.length > 0 || extraUsers.length > 0) void persistPending(pid)
      return sha
    } catch (err) {
      // whatever was pending is still uncommitted: a pre-delete check must look at the work tree
      lastTaken.delete(pid)
      editCountAtTake.delete(pid)
      if (!closed && !deleted.has(pid)) {
        for (const id of credited) scheduler.note(pid, id)
        if (credited.length > 0) void persistPending(pid)
      }
      if (isLockError(err)) {
        logger.warn({ err, projectId: pid }, 'history snapshot failed: a git lock is held')
        throw busyError()
      }
      throw err
    }
  }

  async function commitNow(pid: string, reason: HistoryReason, opts: CommitOptions, pendingUsers: string[], onAuthors: (ids: string[]) => void): Promise<string | null> {
    const workTree = s.files.projectDir(pid)
    try {
      await s.collab.flushProject(pid)
    } catch (err) {
      // e.g. collab already shut down — commit what is on disk
      logger.warn({ err, projectId: pid }, 'collab.flushProject failed before snapshot; committing disk state')
    }

    await ensureRepo(pid)
    await clearStaleLocks(pid)
    const repo = repoOf(pid)
    await git().run(repo, ['add', '--all', '--force', '--', '.', ...ADD_EXCLUDES], { cwd: workTree })

    const head = await revParse(pid, 'HEAD^{commit}')
    if (head) {
      const d = await git().run(repo, ['diff-index', '--cached', '--quiet', '--no-ext-diff', head, '--'], { okCodes: [0, 1] })
      if (d.code === 0) return null
    }

    const authors = commitAuthors(pid, opts, pendingUsers)
    onAuthors(authors.map(a => a.id))
    const identOf = (u: UserPublic): Ident => sanitizeIdent(u.name, u.email, u.id)
    const message = buildCommitMessage({
      summary: opts.summary ?? DEFAULT_SUMMARY[reason],
      reason,
      userIds: authors.map(a => a.id),
      coAuthors: authors.slice(1).map(identOf),
      ...(opts.restoredFrom ? { restoredFrom: opts.restoredFrom } : {}),
    })
    const env: Record<string, string> = {}
    if (authors.length > 0) {
      const a = identOf(authors[0])
      env.GIT_AUTHOR_NAME = a.name
      env.GIT_AUTHOR_EMAIL = a.email
    }
    const args = ['commit', '--quiet', '--no-verify', '--no-gpg-sign', '--cleanup=whitespace', '-F', '-']
    if (!head) args.push('--allow-empty') // the first commit always exists, even for an empty project
    await git().run(repo, args, { input: message, env, cwd: workTree })

    const sha = await revParse(pid, 'HEAD^{commit}')
    if (!sha) throw new HttpError(500, 'internal', 'History commit did not produce a version')
    afterCommit(pid)
    broadcast(pid, sha)
    return sha
  }

  function afterCommit(pid: string): void {
    const prev = gcChains.get(pid) ?? Promise.resolve()
    const next = prev.then(() => maintainRepo(pid)).catch(err => {
      logger.warn({ err, projectId: pid }, 'git gc failed')
    })
    gcChains.set(pid, next)
    void next.then(() => { if (gcChains.get(pid) === next) gcChains.delete(pid) })
    track(next)
  }

  async function readGcState(pid: string): Promise<{ commits: number; lastAt: number }> {
    try {
      const raw = JSON.parse(await fs.promises.readFile(path.join(gitDirOf(pid), GC_FILE), 'utf8')) as { commits?: unknown; lastAt?: unknown }
      const commits = Number(raw.commits)
      const lastAt = Number(raw.lastAt)
      if (Number.isSafeInteger(commits) && commits >= 0 && Number.isFinite(lastAt)) return { commits, lastAt }
    } catch {
      // none yet (a new repository, or one from before the file existed): check it now
    }
    return { commits: 0, lastAt: 0 }
  }

  async function writeGcState(pid: string, st: { commits: number; lastAt: number }): Promise<void> {
    if (deleted.has(pid)) return
    const file = path.join(gitDirOf(pid), GC_FILE)
    const tmp = `${file}.tmp-${randomBytes(4).toString('hex')}`
    await fs.promises.writeFile(tmp, JSON.stringify(st))
    await fs.promises.rename(tmp, file)
  }

  /** loose objects of the repository (`git count-objects -v`) */
  async function looseObjects(pid: string): Promise<number> {
    const r = await git().run(repoOf(pid), ['count-objects', '-v'])
    const m = /^count: (\d+)$/m.exec(r.stdout.toString('utf8'))
    return m ? Number(m[1]) : 0
  }

  /**
   * Count the commit; when due (gcEvery commits, or gcIntervalMs since the last check with at
   * least gcMinLoose loose objects), pack the repository with `git gc`. The bookkeeping is
   * persisted in the git dir, so frequent restarts never postpone it forever.
   */
  async function maintainRepo(pid: string): Promise<void> {
    if (deleted.has(pid)) return
    let st = gcState.get(pid)
    if (!st) {
      st = await readGcState(pid)
      gcState.set(pid, st)
    }
    st.commits++
    const now = Date.now()
    if (st.commits >= gcEvery || now - st.lastAt >= gcIntervalMs) {
      const run = st.commits >= gcEvery || await looseObjects(pid) >= gcMinLoose
      st.commits = 0
      st.lastAt = now
      if (run && !deleted.has(pid)) {
        await writeGcState(pid, st)
        await git().run(repoOf(pid), ['gc', '--quiet'], { timeoutMs: 10 * 60_000 })
        logger.debug({ projectId: pid }, 'packed the history repository')
        return
      }
    }
    await writeGcState(pid, st)
  }

  /**
   * Does the work tree differ from HEAD at or below any of `targets`? One `git status` (stat
   * based, no index write: GIT_OPTIONAL_LOCKS=0); the paths are matched here, never passed to
   * git as pathspecs.
   */
  async function changedWithin(pid: string, targets: string[]): Promise<boolean> {
    const r = await git().run(repoOf(pid), [
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames', '--ignored=no',
    ], { cwd: s.files.projectDir(pid) })
    for (const rec of r.stdout.toString('utf8').split('\0')) {
      // "XY <path>" (porcelain paths are relative to the work tree root)
      if (rec.length < 4) continue
      const p = rec.slice(3)
      if (targets.some(t => isWithin(p, t))) return true
    }
    return false
  }

  /** collab's count of document changes applied to the project so far (null: unavailable) */
  function collabEditCount(pid: string): number | null {
    try {
      const n = s.collab.editCount(pid)
      return Number.isSafeInteger(n) ? n : null
    } catch (err) {
      logger.debug({ err, projectId: pid }, 'collab.editCount failed')
      return null
    }
  }

  /**
   * Nothing can have changed in the project since its last snapshot. All of:
   *   - a snapshot of this process took the pending window (unknown — e.g. right after a
   *     restart, before the recovery snapshot — counts as "may have changed");
   *   - no activity was noted since (collab reports every edit, the ones inside its throttle
   *     window at the end of that window; file operations report at once);
   *   - collab applied no document change since, by its own counter — this does not depend on
   *     the throttled reports at all;
   *   - the window was taken more than `unnotedEditSlackMs` ago (defence in depth).
   */
  function quietSinceLastSnapshot(pid: string): boolean {
    const at = lastTaken.get(pid)
    if (at === undefined || scheduler.has(pid) || Date.now() - at <= unnotedEditSlackMs) return false
    const then = editCountAtTake.get(pid)
    if (then === undefined || then === null) return false
    return collabEditCount(pid) === then
  }

  /** The pre-delete snapshot (see HistoryService.snapshotBeforeDelete). Caller holds `ops` for pid. */
  async function commitBeforeDeleteLocked(pid: string, targets: string[], replace: boolean): Promise<string | null> {
    if (deleted.has(pid) || quietSinceLastSnapshot(pid)) return null
    const workTree = s.files.projectDir(pid)
    if (!(await isDir(workTree))) return null
    if (await hasRepo(pid)) {
      // live documents first: their latest text must be on disk for git to see it
      try {
        await s.collab.flushProject(pid)
      } catch (err) {
        logger.warn({ err, projectId: pid }, 'collab.flushProject failed before a pre-delete snapshot; checking the disk state')
      }
      await clearStaleLocks(pid)
      if (!(await changedWithin(pid, targets))) return null
    }
    // no repository yet (a project from before history existed): its first snapshot records everything
    const what = targets.length === 1 ? targets[0] : `${targets[0]} and ${targets.length - 1} more`
    return commitLocked(pid, 'file-op', { summary: `Before ${replace ? 'replacing' : 'deleting'} ${what}` })
  }

  async function initLocked(pid: string, author: UserPublic | null, summary?: string): Promise<void> {
    deleted.delete(pid)
    // The project directory normally exists already (importer/templates wrote the files).
    await fs.promises.mkdir(s.files.projectDir(pid), { recursive: true })
    await ensureRepo(pid)
    await commitLocked(pid, 'import', { user: author, summary })
  }

  // -------------------------------------------------------------------------
  // restore
  // -------------------------------------------------------------------------

  /** A restore racing "Delete forever" of its project stops (the project is going away). */
  function assertNotDeleted(pid: string): void {
    if (deleted.has(pid)) throw notFound('Project not found')
  }

  async function restoreLocked(pid: string, user: UserPublic, sha: string, only?: string): Promise<RestoreResponse> {
    const short = sha.slice(0, 7)
    assertNotDeleted(pid)
    await commitLocked(pid, 'auto', { summary: 'Auto-save before restore' })
    assertNotDeleted(pid)
    const shown = await git().run(repoOf(pid), ['show', '-s', '--format=%ct', sha], { okCodes: [0, 128] })
    const secs = Number(shown.stdout.toString('utf8').trim())
    const time = shown.code === 0 && Number.isFinite(secs) && secs > 0 ? secs * 1000 : null

    const blobs = (await lsTree(pid, sha)).filter(e => e.type === 'blob' && e.mode !== '120000' && validatePath(e.path) === null)
    const targets = only ? blobs.filter(e => isWithin(e.path, only)) : blobs
    if (only && targets.length === 0) throw notFound('File not found in this version')

    const restored = new Set<string>()
    const skipped: string[] = []

    if (!only) {
      // Remove what did not exist at the version (shallowest first; a folder removal takes its subtree).
      const targetPaths = new Set(targets.map(t => t.path))
      const current = s.files.list(pid).slice().sort((a, b) => depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : 1))
      const removed: string[] = []
      for (const f of current) {
        if (removed.some(r => isWithin(f.path, r))) continue
        // A folder the version has files in stays. A folder without files cannot differ from the
        // version (git records no folders): it stays too — unless the version has a FILE at its
        // path, which it would block. (A file of the version at an ancestor path removes that
        // ancestor folder first: the list is sorted shallowest first.)
        const keep = f.kind === 'folder'
          ? targets.some(t => t.path.startsWith(f.path + '/')) ||
            (!targetPaths.has(f.path) && !current.some(c => c.kind !== 'folder' && c.path.startsWith(f.path + '/')))
          : targetPaths.has(f.path)
        if (keep) continue
        const doomed = f.kind === 'folder' ? current.filter(c => c.kind !== 'folder' && isWithin(c.path, f.path)) : [f]
        assertNotDeleted(pid)
        await s.files.remove(pid, user, f.id)
        removed.push(f.path)
        for (const d of doomed) restored.add(d.path)
      }
    }

    // Write the version's files, in chunks so memory stays bounded.
    const ordered = targets.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    for (let i = 0; i < ordered.length;) {
      const chunk: TreeEntry[] = []
      let bytes = 0
      while (i < ordered.length && (chunk.length === 0 || bytes + ordered[i].size <= BATCH_BYTES)) {
        bytes += ordered[i].size
        chunk.push(ordered[i++])
      }
      const contents = await readBlobs(pid, chunk.map(t => ({ oid: t.oid, size: t.size })))
      for (const t of chunk) {
        const bytesAt = contents.get(t.oid) ?? await readBlob(pid, t.oid)
        assertNotDeleted(pid)
        const r = await restoreFile(pid, user, t.path, bytesAt, !!only)
        if (r === 'changed') restored.add(t.path)
        else if (r === 'skipped') skipped.push(t.path)
      }
    }
    if (skipped.length > 0) logger.warn({ projectId: pid, versionId: sha, skipped: skipped.slice(0, 20) }, 'restore could not write some files of the version')

    const when = time !== null ? ` (${formatWhen(time)})` : ''
    const summary = only ? `Restored ${only} to ${short}${when}` : `Restored to ${short}${when}`
    const versionId = await commitLocked(pid, 'restore', { user, summary, restoredFrom: { sha, time, ...(only ? { path: only } : {}) } })
    return { restored: [...restored].sort(), versionId, ...(skipped.length > 0 ? { skipped: skipped.sort() } : {}) }
  }

  /**
   * Apply one file of a version to the live project: 'changed', 'same' (nothing to do) or
   * 'skipped' (a folder holding files is in the way — a project restore removes empty ones and
   * folders the version does not have first, so this is exceptional).
   */
  async function restoreFile(pid: string, user: UserPublic, p: string, bytes: Buffer, single: boolean): Promise<'changed' | 'same' | 'skipped'> {
    const cur = s.files.getByPath(pid, p)
    if (cur && cur.kind === 'folder') {
      if (single) throw conflict(`"${p}" is a folder in the current project`)
      return 'skipped'
    }
    if (cur && cur.kind === 'text' && classifyFile(p, bytes) === 'text') {
      // Never write behind a live Y.Doc: text goes through the collaboration service.
      const text = normalizeText(bytes.toString('utf8'))
      const live = await s.collab.getText(pid, cur.id)
      if (live === text) return 'same'
      await s.collab.setText(pid, cur.id, text, { userId: user.id, reason: 'restore' })
      return 'changed'
    }
    if (cur) {
      const now = await s.files.read(pid, cur.id).catch(() => null)
      if (now && now.equals(bytes)) return 'same'
      await s.files.writeFile(pid, user, p, bytes, { replace: true })
      return 'changed'
    }
    await s.files.writeFile(pid, user, p, bytes, { replace: false })
    return 'changed'
  }

  // -------------------------------------------------------------------------
  // service
  // -------------------------------------------------------------------------

  const service: FolioHistoryService = {
    async init(projectId, author) {
      checkProjectId(projectId)
      await locked(projectId, () => initLocked(projectId, author))
    },

    noteActivity(projectId, userId) {
      if (closed || deleted.has(projectId) || typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) return
      if (scheduler.note(projectId, userId)) void persistPending(projectId)
    },

    async snapshot(projectId, reason, user) {
      checkProjectId(projectId)
      return locked(projectId, () => commitLocked(projectId, reason, { user: user ?? null }))
    },

    async snapshotBeforeDelete(projectId, paths, opts) {
      checkProjectId(projectId)
      const targets = [...new Set(paths.map(p => normalizePath(String(p))).filter(p => p && validatePath(p) === null))]
      if (targets.length === 0 || deleted.has(projectId)) return null
      // A restore removing or overwriting files: it holds the lock already (waiting for it here
      // would deadlock) and committed everything pending right before it started.
      if (holdsLock(projectId)) return null
      // the common case costs nothing: no git process, no lock
      if (!ops.busy(projectId) && quietSinceLastSnapshot(projectId)) return null
      // Under the lock: a snapshot already running finishes first (it may be the one committing
      // these files), and none can start between the check and the commit.
      return locked(projectId, () => commitBeforeDeleteLocked(projectId, targets, opts?.replace === true))
    },

    async list(projectId, opts) {
      checkProjectId(projectId)
      const limit = clampLimit(opts.limit)
      if (!(await hasRepo(projectId))) {
        // Projects created before history existed (or whose git dir was lost) start one now.
        if (deleted.has(projectId) || !(await isDir(s.files.projectDir(projectId)))) return { versions: [], hasMore: false }
        await locked(projectId, async () => { if (!(await hasRepo(projectId))) await initLocked(projectId, null) })
      }
      let start: string
      const extra: string[] = []
      if (opts.before) {
        start = await resolveVersion(projectId, opts.before)
        extra.push('--skip=1')
      } else {
        const head = await headOf(projectId)
        if (!head) return { versions: [], hasMore: false }
        start = head
      }
      const r = await git().run(repoOf(projectId), [
        'log', '-z', '--no-color', '--no-ext-diff', '--no-textconv', '--name-status', '-M',
        `--format=${LOG_FORMAT}`, `--max-count=${limit + 1}`, ...extra, '--end-of-options', start,
      ])
      const records = parseLog(r.stdout.toString('utf8'))
      const hasMore = records.length > limit
      const page = records.slice(0, limit)

      const cache = new Map<string, UserPublic | null>()
      const labelsBySha = new Map<string, Label[]>()
      for (const l of s.db.labels.list(projectId)) {
        const arr = labelsBySha.get(l.versionId) ?? []
        arr.push(labelToApi(l, cache))
        labelsBySha.set(l.versionId, arr)
      }
      const versions: HistoryVersion[] = page.map(rec => {
        const v: HistoryVersion = {
          id: rec.sha,
          parentId: rec.parents[0] ?? null,
          createdAt: rec.time,
          authors: versionAuthors(rec, cache),
          reason: rec.message.reason,
          labels: labelsBySha.get(rec.sha) ?? [],
          changes: rec.changes,
        }
        if (rec.message.summary) v.summary = rec.message.summary
        const from = rec.message.restoredFrom
        if (from) v.restoredFrom = { versionId: from.sha, createdAt: from.time, ...(from.path ? { path: from.path } : {}) }
        return v
      })
      return { versions, hasMore }
    },

    async files(projectId, versionId): Promise<HistoryFilesResponse> {
      checkProjectId(projectId)
      const sha = await resolveVersion(projectId, versionId)
      const blobs = (await lsTree(projectId, sha)).filter(e => e.type === 'blob' && e.mode !== '120000')
      // Sniffed (NUL / UTF-8 / length in UTF-16 units, like classifyFile): files whose extension
      // does not decide, and text files too large to be sure from their byte size alone.
      const needsSniff = (e: TreeEntry) => {
        const byName = classifyByName(e.path)
        return byName !== 'binary' && e.size <= MAX_TEXT_FILE_BYTES && (byName === 'unknown' || e.size > MAX_TEXT_LENGTH)
      }
      const sniff = blobs.filter(needsSniff)
      const contents = sniff.length > 0 ? await readBlobs(projectId, sniff) : new Map<string, Buffer>()
      return {
        versionId: sha,
        files: blobs.map(e => {
          const byName = classifyByName(e.path)
          let binary: boolean
          if (byName === 'binary' || e.size > MAX_TEXT_FILE_BYTES) binary = true
          else if (!needsSniff(e)) binary = false
          else {
            const data = contents.get(e.oid)
            binary = data ? classifyFile(e.path, data) === 'binary' : true
          }
          return { path: e.path, size: e.size, binary }
        }),
      }
    },

    async fileAt(projectId, versionId, filePath) {
      checkProjectId(projectId)
      const sha = await resolveVersion(projectId, versionId)
      const p = checkPath(filePath)
      const blob = await blobAt(projectId, sha, p)
      if (!blob) return null
      return readBlob(projectId, blob.oid)
    },

    async diff(projectId, opts): Promise<HistoryDiffResponse> {
      checkProjectId(projectId)
      const to = await resolveVersion(projectId, opts.to)
      const from = opts.from ? await resolveVersion(projectId, opts.from) : await revParse(projectId, `${to}^1`)
      const p = checkPath(opts.path)

      const newBlob = await blobAt(projectId, to, p)
      let oldPath = p
      let oldBlob = from ? await blobAt(projectId, from, p) : null
      if (from && !oldBlob && newBlob) {
        // Renamed between the versions? Show the old content instead of "added".
        const r = await git().run(repoOf(projectId), ['diff-tree', '-r', '-z', '-M', '--name-status', '--no-ext-diff', '--no-textconv', from, to])
        const ren = parseNameStatus(r.stdout.toString('utf8')).find(c => c.op === 'renamed' && c.path === p)
        if (ren?.oldPath) {
          oldPath = ren.oldPath
          oldBlob = await blobAt(projectId, from, oldPath)
        }
      }
      if (!oldBlob && !newBlob) throw notFound('File not found in either version')

      const side = async (blob: { oid: string; size: number } | null, sidePath: string): Promise<{ binary: boolean; text: string | null }> => {
        if (!blob) return { binary: false, text: null }
        if (classifyByName(sidePath) === 'binary' || blob.size > MAX_TEXT_FILE_BYTES) return { binary: true, text: '' }
        const text = decodeUtf8Text(await readBlob(projectId, blob.oid))
        // the same limit as an editable document: characters (UTF-16 units), not bytes
        if (text === null || !textLengthFits(text)) return { binary: true, text: '' }
        return { binary: false, text }
      }
      const [a, b] = await Promise.all([side(oldBlob, oldPath), side(newBlob, p)])
      const binary = a.binary || b.binary
      // Binary: texts are '' for a side that exists and null for an absent side (bytes via historyFile).
      return {
        path: p,
        from,
        to,
        binary,
        oldText: a.text === null ? null : binary ? '' : a.text,
        newText: b.text === null ? null : binary ? '' : b.text,
      }
    },

    async restore(projectId, user, versionId, filePath) {
      checkProjectId(projectId)
      const only = filePath === undefined || filePath === null || filePath === '' ? undefined : checkPath(filePath)
      const sha = await resolveVersion(projectId, versionId)
      return locked(projectId, () => restoreLocked(projectId, user, sha, only))
    },

    async createLabel(projectId, user, name, versionId) {
      checkProjectId(projectId)
      const clean = sanitizeLine(typeof name === 'string' ? name : '', MAX_LABEL_LENGTH + 1)
      if (!clean) throw badRequest('Label name must not be empty')
      if (clean.length > MAX_LABEL_LENGTH) throw badRequest(`Label name must be at most ${MAX_LABEL_LENGTH} characters`)
      return locked(projectId, async () => {
        let sha: string
        if (versionId === undefined || versionId === null || versionId === '' || versionId === 'HEAD') {
          // Label the current state: snapshot first so the label points at the latest edits.
          const committed = await commitLocked(projectId, 'label', { user, summary: clean })
          const head = committed ?? await headOf(projectId)
          if (!head) throw notFound('Project not found')
          sha = head
        } else {
          sha = await resolveVersion(projectId, versionId)
        }
        const rec = s.db.labels.create({ projectId, versionId: sha, name: clean, userId: s.db.users.get(user.id) ? user.id : null })
        if (labelTags) {
          await git().run(repoOf(projectId), ['update-ref', `refs/tags/folio-${rec.id}`, sha]).catch(err => {
            logger.warn({ err, projectId }, 'could not create the label tag')
          })
        }
        broadcast(projectId, sha)
        return { id: rec.id, name: rec.name, versionId: sha, createdAt: rec.createdAt, user: s.db.users.get(user.id) ? user : null }
      })
    },

    async deleteLabel(projectId, labelId) {
      checkProjectId(projectId)
      const label = s.db.labels.get(labelId)
      if (!label || label.projectId !== projectId) throw notFound('Label not found')
      s.db.labels.delete(labelId)
      if (labelTags && await hasRepo(projectId)) {
        await git().run(repoOf(projectId), ['update-ref', '-d', `refs/tags/folio-${labelId}`], { okCodes: [0, 1] }).catch(err => {
          logger.warn({ err, projectId }, 'could not delete the label tag')
        })
      }
      broadcast(projectId, label.versionId)
    },

    async archive(projectId, versionId) {
      checkProjectId(projectId)
      if (versionId === 'HEAD') await service.snapshot(projectId, 'auto')
      const sha = await resolveVersion(projectId, versionId)
      await fs.promises.mkdir(tempDir(), { recursive: true })
      const file = path.join(tempDir(), `archive-${randomBytes(8).toString('hex')}.zip`)
      try {
        await git().run(repoOf(projectId), ['archive', '--format=zip', `--output=${file}`, '--end-of-options', sha], { timeoutMs: 10 * 60_000 })
      } catch (err) {
        await fs.promises.rm(file, { force: true }).catch(() => {})
        throw err
      }
      const handle = await fs.promises.open(file, 'r')
      let unlinked = true
      try {
        await fs.promises.unlink(file)
      } catch {
        unlinked = false
      }
      const stream = handle.createReadStream()
      if (!unlinked) stream.once('close', () => { fs.promises.rm(file, { force: true }).catch(() => {}) })
      // the commit time names the download (routes.ts versionZipName)
      let createdAt: number | null = null
      try {
        const shown = await git().run(repoOf(projectId), ['show', '-s', '--format=%ct', sha], { okCodes: [0, 128] })
        const secs = Number(shown.stdout.toString('utf8').trim())
        if (shown.code === 0 && Number.isFinite(secs) && secs > 0) createdAt = secs * 1000
      } catch {
        /* the name falls back to the hash */
      }
      return Object.assign(stream, { versionId: sha, createdAt })
    },

    async deleteProject(projectId) {
      checkProjectId(projectId)
      // from here on nothing snapshots the project and a running restore stops at its next step;
      // callers must not hold the project lock (files/lock.ts): a restore takes `ops` first
      deleted.add(projectId)
      scheduler.cancel(projectId)
      recoveredUsers.delete(projectId)
      await pendingWrites.get(projectId)
      await gcChains.get(projectId)
      await locked(projectId, async () => {
        knownRepos.delete(projectId)
        lastTaken.delete(projectId)
        editCountAtTake.delete(projectId)
        gcState.delete(projectId)
        await fs.promises.rm(gitDirOf(projectId), { recursive: true, force: true })
      })
    },

    async copyProject(fromProjectId, toProjectId, author) {
      checkProjectId(fromProjectId)
      checkProjectId(toProjectId)
      // Fresh history for the copy (Overleaf semantics); labels stay with the source project.
      const src = s.db.projects.get(fromProjectId)
      const summary = src ? `Copied from ${sanitizeLine(src.name, 150)}` : 'Copied project'
      await locked(toProjectId, () => initLocked(toProjectId, author, summary))
    },

    loadPendingAuthors,

    async recoverAfterRestart() {
      await loadPendingAuthors()
      let names: string[]
      try {
        names = await fs.promises.readdir(s.config.dirs.history)
      } catch {
        return 0
      }
      let committed = 0
      for (const name of names) {
        if (closed) break
        const m = /^([A-Za-z0-9_-]{1,64})\.git$/.exec(name)
        if (!m) continue
        const pid = m[1]
        if (deleted.has(pid) || !s.db.projects.get(pid) || !(await hasRepo(pid))) continue
        try {
          // the users loaded before listening (a snapshot since the restart may have credited them already)
          const users = recoveredUsers.get(pid) ?? []
          const sha = await locked(pid, () => commitLocked(pid, 'auto', { summary: 'Recovered after restart' }))
          if (sha) {
            committed++
            logger.info({ projectId: pid, versionId: sha, users }, 'committed edits left from before the restart')
          }
          if (users.length > 0) await persistPending(pid)
        } catch (err) {
          logger.warn({ err, projectId: pid }, 'recovery snapshot failed')
        }
      }
      return committed
    },

    async shutdown() {
      closed = true
      const pids = scheduler.pendingProjects()
      const results = await Promise.allSettled(pids.map(pid => locked(pid, () => commitLocked(pid, 'shutdown'))))
      results.forEach((r, i) => {
        if (r.status === 'rejected') logger.warn({ err: r.reason, projectId: pids[i] }, 'shutdown snapshot failed')
      })
      scheduler.cancelAll()
      await Promise.allSettled([...inflight, ...pendingWrites.values()])
      await ops.drain()
    },
  }

  return service
}

function clampLimit(limit: number | undefined): number {
  const n = Number(limit)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIST_LIMIT
  return Math.min(MAX_LIST_LIMIT, Math.max(1, Math.floor(n)))
}

function depth(p: string): number {
  let d = 0
  for (let i = 0; i < p.length; i++) if (p.charCodeAt(i) === 47) d++
  return d
}
