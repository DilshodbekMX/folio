/**
 * Server service contracts. Every server module is written against these interfaces and
 * receives its collaborators through the `Services` container built in main.ts. This keeps
 * modules independently testable (tests inject fakes) and lets them be built in parallel.
 *
 * Ownership (see docs/SPEC.md §4):
 *   config.ts, log.ts, db/**, http/**, auth/**, access/**, projects/**, files/**, share/**,
 *   chat/**, search/**, admin/**, cli/**, main.ts            → server-foundation
 *   collab/** (CollabService + MetaService)                   → server-collab
 *   compile/**, synctex/** (CompileService, SynctexService)   → server-compile
 *   history/** (HistoryService)                               → server-history
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import type {
  CompileRequest, CompileResponse, FileEntry, HistoryDiffResponse, HistoryFilesResponse,
  HistoryListResponse, HistoryReason, Label, ProjectSettings, RestoreResponse, Role,
  SyncCodeToPdfResponse, SyncPdfToCodeResponse, UserPublic, WordCountResponse,
} from '@folio/shared/api'
import type { ProjectEvent } from '@folio/shared/protocol'
import type { Config } from './config.ts'
import type { Db } from './db/index.ts'

// ---------------------------------------------------------------------------
// Collaboration (Yjs doc rooms)
// ---------------------------------------------------------------------------

export interface CollabService {
  /**
   * Handle an HTTP upgrade for `/ws/doc/:projectId/:fileId?epoch=N`. The caller (main.ts)
   * has already checked Origin and resolved the session user and role (null role → the
   * service accepts then closes with WS_CLOSE.FORBIDDEN / NOT_FOUND so y-websocket stops
   * reconnecting). Viewers get a read-only connection: their content is never applied, and an
   * update holding changes the server does not have (edits made as an editor before a role
   * change, typically offline) closes the socket with WS_CLOSE.FORBIDDEN so the client re-checks
   * its role instead of believing the edits were saved.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: {
    user: UserPublic | null
    role: Role | null
    projectId: string
    fileId: string
    epoch: number
    /** sha256 of the session token the socket was opened with (see disconnectSessions) */
    sessionTokenHash?: string | null
  }): void

  /** Live text of a text file: the loaded Y.Text if the room is open, else the file on disk. */
  getText(projectId: string, fileId: string): Promise<string>

  /**
   * Replace a text file's content by applying a minimal diff to its Y.Text (loading the room
   * from sidecar+disk if necessary), then scheduling the usual debounced disk + sidecar save.
   * Used by history restore, uploads over existing docs and REST writes. Input is normalised
   * (normalizeText) by the implementation. Never swaps the Y.Doc.
   */
  setText(projectId: string, fileId: string, text: string, origin?: { userId: string | null; reason: string }): Promise<void>

  /** Write every loaded room of the project to disk (file + sidecar) and await completion. */
  flushProject(projectId: string): Promise<void>

  /**
   * Discard server Y state for a file: close its sockets with `code` (WS_CLOSE.STALE_EPOCH or
   * WS_CLOSE.GONE), drop the room and delete its sidecar(s). The caller bumps the epoch in the
   * db for STALE_EPOCH (e.g. binary↔text change, file re-created at same path).
   */
  discardFile(projectId: string, fileId: string, code: number): Promise<void>

  /** Close every doc socket of the project (project deleted) and drop rooms + sidecars. */
  discardProject(projectId: string): Promise<void>

  /** Close the given user's doc sockets in a project (access revoked / role changed). */
  disconnectUser(projectId: string, userId: string, code: number): void

  /**
   * Close every doc socket (any project) opened with one of the given session token hashes
   * (logout, password change, expired or deleted session). Returns the number of sockets closed.
   */
  disconnectSessions(tokenHashes: readonly string[], code: number): number

  /** Distinct session token hashes of the open doc sockets (periodic session sweep). */
  openSessions(): string[]

  /**
   * Subscribe to "a text file changed through collaboration" notifications (fired at most once
   * per second per file). History uses it for idle snapshots; meta uses it for 'doc:changed'.
   */
  onDocChanged(listener: (e: { projectId: string; fileId: string; userId: string | null }) => void): () => void

  /** Users who edited each project since the last call (for history commit authors); clears the set. */
  takeEditors(projectId: string): string[]

  /**
   * How many document changes (client edits and setText) collab has applied to the project's
   * text files in this process so far. It grows with every change, however the activity reports
   * to history are throttled: history compares it with the value at its last snapshot before it
   * trusts "nothing changed since" (HistoryService.snapshotBeforeDelete).
   */
  editCount(projectId: string): number

  /** Flush everything and close all sockets with WS_CLOSE.SERVICE_RESTART. */
  shutdown(): Promise<void>
}

// ---------------------------------------------------------------------------
// Project meta room (file tree, settings, presence, events)
// ---------------------------------------------------------------------------

export interface MetaService {
  /** Handle an HTTP upgrade for `/ws/project/:projectId` (same ctx conventions as CollabService). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, ctx: {
    user: UserPublic | null
    role: Role | null
    projectId: string
    sessionTokenHash?: string | null
  }): void
  /** Push a JSON event to every connection of the project's meta room. */
  broadcast(projectId: string, event: ProjectEvent): void
  /** Re-read the project's files from the db into the meta Y.Map (call after any file-tree change). */
  syncFiles(projectId: string): void
  /** Re-read name + settings from the db into the meta Y.Map. */
  syncProject(projectId: string): void
  /** Close a user's meta socket(s) for a project. */
  disconnectUser(projectId: string, userId: string, code: number): void
  /** Close every meta socket (any project) opened with one of these session token hashes. */
  disconnectSessions(tokenHashes: readonly string[], code: number): number
  /** Distinct session token hashes of the open meta sockets. */
  openSessions(): string[]
  /** Close all meta sockets of a project (project deleted). */
  closeProject(projectId: string, code: number): void
  shutdown(): Promise<void>
}

// ---------------------------------------------------------------------------
// Compile + SyncTeX
// ---------------------------------------------------------------------------

export interface CompileService {
  /**
   * Compile the project (single-flight per project with one queued follow-up per root document;
   * content-hash dedupe; 1 s per-user guard for auto compiles; global concurrency limit). Reads
   * text through CollabService.getText (never waits for disk saves) and binaries from disk.
   * Broadcasts 'compile:started' / 'compile:done' (with the root document) through MetaService.
   */
  compile(projectId: string, user: UserPublic, req: CompileRequest): Promise<CompileResponse>
  /** Kill the running compile of the project, if any. */
  stop(projectId: string): Promise<void>
  /** Stop, then delete the project's compile directory and cached builds. */
  clearCache(projectId: string): Promise<void>
  /**
   * Most recent finished build of the project (in memory or from builds/<pid>/<id>/meta.json):
   * of any root document, of the root at `rootPath`, or (`main`) of the document a compile
   * without an explicit root builds. Adds `lastWithPdf` (same root) when that build has no PDF.
   */
  lastBuild(projectId: string, opts?: { rootPath?: string; main?: boolean }): Promise<CompileResponse | null>
  /** Absolute path of a build's output file, or null if the build/file does not exist (validates names). */
  resolveBuildFile(projectId: string, buildId: string, file: string): string | null
  /** texcount on the (root) document. */
  wordCount(projectId: string, rootFileId?: string): Promise<WordCountResponse>
  /** Render an EPS/PS project file to PNG with Ghostscript in the sandbox; cached by content hash. */
  renderPreview(projectId: string, fileId: string): Promise<Buffer>
  /** Delete everything the compile module stores for a project (compile dir, builds). */
  deleteProject(projectId: string): Promise<void>
  /** Short description of the compile backend for /api/system. */
  info(): Promise<{ runner: 'docker' | 'local' | 'fake'; image: string; texLive: string | null; dockerOk: boolean }>
  shutdown(): Promise<void>
}

export interface SynctexService {
  /** Forward search (code → PDF). `path` is project-relative; line 1-based; column 0-based. */
  codeToPdf(projectId: string, buildId: string, path: string, line: number, column: number): Promise<SyncCodeToPdfResponse>
  /** Inverse search (PDF → code). x, y in PDF points from the page's top-left. */
  pdfToCode(projectId: string, buildId: string, page: number, x: number, y: number): Promise<SyncPdfToCodeResponse>
}

// ---------------------------------------------------------------------------
// History (git, separate git dir per project)
// ---------------------------------------------------------------------------

/**
 * A version's zip stream, plus the commit it was made from (full sha) and that commit's time
 * (ms; null when unknown): the route names the download after the version's label or time.
 */
export type HistoryArchive = NodeJS.ReadableStream & { versionId?: string; createdAt?: number | null }

export interface HistoryService {
  /** Create the project's git dir and commit the initial state (reason 'import'). */
  init(projectId: string, author: UserPublic | null): Promise<void>
  /**
   * Note that something changed (text edit or file op). Schedules a snapshot after 30 s idle,
   * but at most every 5 min of continuous activity.
   */
  noteActivity(projectId: string, userId: string | null): void
  /** Flush live docs, then commit if anything changed. Returns the new commit sha or null. */
  snapshot(projectId: string, reason: HistoryReason, user?: UserPublic | null): Promise<string | null>
  /**
   * Called by FileService before it deletes `paths` (files or folders) — or, with `replace`,
   * overwrites them: flush live docs and, when the work tree differs from the last version at or
   * below those paths, commit a snapshot (reason 'file-op'), so what is about to disappear can
   * be restored from history. No commit (and no git process while nothing was noted since the
   * last snapshot) when nothing there changed. Returns at once when called from inside a
   * history operation of the same project (a restore, which snapshots first itself).
   * Returns the new commit sha or null.
   */
  snapshotBeforeDelete(projectId: string, paths: string[], opts?: { replace?: boolean }): Promise<string | null>
  list(projectId: string, opts: { before?: string; limit?: number }): Promise<HistoryListResponse>
  files(projectId: string, versionId: string): Promise<HistoryFilesResponse>
  /** Raw bytes of a file at a version (null when absent). */
  fileAt(projectId: string, versionId: string, path: string): Promise<Buffer | null>
  diff(projectId: string, opts: { from?: string; to: string; path: string }): Promise<HistoryDiffResponse>
  /** Restore one file or the whole project (forward-only: snapshot, apply via CollabService/FileService, snapshot). */
  restore(projectId: string, user: UserPublic, versionId: string, path?: string): Promise<RestoreResponse>
  createLabel(projectId: string, user: UserPublic, name: string, versionId?: string): Promise<Label>
  deleteLabel(projectId: string, labelId: string): Promise<void>
  /** Stream a zip of the project at a version (git archive); says which commit it is. */
  archive(projectId: string, versionId: string): Promise<HistoryArchive>
  deleteProject(projectId: string): Promise<void>
  /** Copy history when a project is copied (optional: may just init fresh). */
  copyProject(fromProjectId: string, toProjectId: string, author: UserPublic): Promise<void>
  shutdown(): Promise<void>
}

// ---------------------------------------------------------------------------
// Files (foundation) — exposed so history/compile can reuse the canonical file operations
// ---------------------------------------------------------------------------

export interface FileService {
  /** Absolute path of the project's working directory (data/projects/<pid>). */
  projectDir(projectId: string): string
  /** Absolute on-disk path of a project file (validated, inside projectDir). */
  absPath(projectId: string, path: string): string
  list(projectId: string): FileEntry[]
  get(projectId: string, fileId: string): FileEntry | null
  getByPath(projectId: string, path: string): FileEntry | null
  /** Create a text doc or folder (parents created as needed). */
  create(projectId: string, user: UserPublic | null, path: string, kind: 'text' | 'folder', content?: string): Promise<FileEntry>
  /**
   * Write bytes at `path`, creating or replacing the entry. Text-classified content replacing an
   * existing text file goes through CollabService.setText; kind changes bump the epoch.
   */
  writeFile(projectId: string, user: UserPublic | null, path: string, bytes: Buffer, opts?: { replace?: boolean }): Promise<FileEntry>
  move(projectId: string, user: UserPublic | null, fileId: string, newPath: string): Promise<FileEntry[]>
  /**
   * Delete a file or folder (with its descendants). Pending changes of what is deleted are
   * committed to history first (HistoryService.snapshotBeforeDelete), so it stays restorable.
   */
  remove(projectId: string, user: UserPublic | null, fileId: string): Promise<string[]>
  /** Current bytes: live text for text files (via CollabService.getText), disk bytes otherwise. */
  read(projectId: string, fileId: string): Promise<Buffer>
}

// ---------------------------------------------------------------------------
// Container
// ---------------------------------------------------------------------------

export interface Services {
  config: Config
  db: Db
  files: FileService
  collab: CollabService
  meta: MetaService
  compile: CompileService
  synctex: SynctexService
  history: HistoryService
}

/** Settings stored per project in the db (mirrors ProjectSettings). */
export type StoredProjectSettings = ProjectSettings
