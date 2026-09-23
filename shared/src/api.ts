/**
 * Folio REST API contract — the single source of truth for request/response shapes
 * shared by server/ and web/. Every route is listed in the ROUTES table at the bottom.
 *
 * Conventions
 *  - All timestamps are milliseconds since the epoch (number).
 *  - All ids are opaque url-safe strings (16 chars, [A-Za-z0-9_-]).
 *  - Project file paths are POSIX, relative to the project root, NFC-normalised,
 *    no leading or trailing slash (e.g. "figures/plot.tikz"). See ./paths.ts.
 *  - Errors: non-2xx responses carry `ApiErrorBody`.
 *  - Every non-GET request must send header `X-Folio-Csrf: 1` (see CSRF_HEADER) and a
 *    same-origin `Origin`; the server rejects it otherwise.
 */

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export type Role = 'owner' | 'editor' | 'viewer'
export const ROLE_RANK: Record<Role, number> = { viewer: 1, editor: 2, owner: 3 }

export type Compiler = 'pdflatex' | 'xelatex' | 'lualatex' | 'latex'
export const COMPILERS: { id: Compiler; label: string }[] = [
  { id: 'pdflatex', label: 'pdfLaTeX' },
  { id: 'latex', label: 'LaTeX' },
  { id: 'xelatex', label: 'XeLaTeX' },
  { id: 'lualatex', label: 'LuaLaTeX' },
]

/** 'text' files are edited collaboratively through Yjs; 'binary' files are opaque blobs. */
export type FileKind = 'text' | 'binary' | 'folder'

export const CSRF_HEADER = 'X-Folio-Csrf'

export interface ApiErrorBody {
  error: {
    /** machine-readable, e.g. 'not_found', 'forbidden', 'validation', 'conflict', 'unauthorized', 'too_large', 'rate_limited' */
    code: string
    message: string
    details?: unknown
  }
}

// ---------------------------------------------------------------------------
// Users, auth, settings
// ---------------------------------------------------------------------------

export interface UserPublic {
  id: string
  name: string
  email: string
  /** hex colour used for cursors/avatars, e.g. '#e6194b' */
  color: string
}

export type EditorFontFamily = 'monospace' | 'dejavu' | 'source-code' | 'fira-code' | 'jetbrains-mono'

export interface UserSettings {
  /** UI theme */
  theme: 'light' | 'dark' | 'system'
  /** CodeMirror theme; 'auto' follows the UI theme */
  editorTheme: 'auto' | 'light' | 'one-dark'
  fontSize: number // 10..24
  fontFamily: EditorFontFamily
  lineHeight: 'compact' | 'normal' | 'wide'
  keybindings: 'default' | 'vim' | 'emacs'
  autoComplete: boolean
  autoCloseBrackets: boolean
  spellCheck: boolean
  lineWrapping: boolean
  /** show inline KaTeX equation preview on hover */
  equationPreview: boolean
  /** PDF viewer zoom persisted by the viewer ('page-width' | 'page-fit' | 'auto' | number as string, e.g. '1.25') */
  pdfZoom: string
}

export const DEFAULT_USER_SETTINGS: UserSettings = {
  theme: 'system',
  editorTheme: 'auto',
  fontSize: 14,
  fontFamily: 'monospace',
  lineHeight: 'normal',
  keybindings: 'default',
  autoComplete: true,
  autoCloseBrackets: true,
  spellCheck: false,
  lineWrapping: true,
  equationPreview: true,
  pdfZoom: 'page-width',
}

export interface Me extends UserPublic {
  isAdmin: boolean
  settings: UserSettings
  createdAt: number
}

export interface SetupStatus {
  /** true while no user exists: the web app shows the first-run /setup page */
  needsSetup: boolean
  /** self-registration allowed (ALLOW_SIGNUP) */
  allowSignup: boolean
  version: string
}

export interface LoginRequest { email: string; password: string }
/** Used by /setup (first user becomes admin) and by /register when allowSignup. */
export interface RegisterRequest { email: string; password: string; name: string }
export interface UpdateMeRequest {
  name?: string
  settings?: Partial<UserSettings>
  /** changing password requires currentPassword */
  password?: string
  currentPassword?: string
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface ProjectSettings {
  compiler: Compiler
  /** file id of the root (main) document; null → server picks the first .tex with \documentclass */
  rootFileId: string | null
  /**
   * Paths of documents referenced through xr's \externaldocument that must be pre-built
   * (in the same compile directory) before the root document. Auto-detected on compile
   * when empty; explicit entries win.
   */
  externalDocs: string[]
  /** compile wall-clock timeout in seconds (30..600) */
  timeoutSec: number
  /** hunspell-style language tag used by spell checking, e.g. 'en' */
  spellLang: string
  /** TeX Live image tag/digest used for this project (informational; server-controlled) */
  image: string
}

export interface ProjectSummary {
  id: string
  name: string
  owner: UserPublic
  role: Role
  createdAt: number
  updatedAt: number
  lastOpenedAt: number | null
  lastUpdatedBy: UserPublic | null
  trashed: boolean
  archived: boolean
}

export interface FileEntry {
  id: string
  path: string
  kind: FileKind
  /** bytes on disk (0 for folders) */
  size: number
  /** Yjs room epoch; bumped when the server discards the file's Y state (see protocol.ts) */
  epoch: number
  updatedAt: number
}

export interface Member {
  user: UserPublic
  role: Role
  addedAt: number
}

export interface ProjectDetail {
  id: string
  name: string
  owner: UserPublic
  /** role of the requesting user */
  role: Role
  settings: ProjectSettings
  files: FileEntry[]
  members: Member[]
  createdAt: number
  updatedAt: number
}

export type ProjectTemplate = 'blank' | 'example'
export interface CreateProjectRequest { name: string; template: ProjectTemplate }
export interface SkippedImportEntry {
  /** path as it appeared in the upload (before normalisation / top-folder stripping) */
  path: string
  /** human-readable reason, e.g. "build artefact (.aux)", "invalid name: …", "duplicate path" */
  reason: string
}
export interface CreateProjectResponse {
  id: string
  /** entries of an uploaded .zip that were not imported (zip upload only; omitted when none) */
  skipped?: SkippedImportEntry[]
}
export interface CopyProjectRequest { name: string }
export interface UpdateProjectRequest {
  name?: string
  settings?: Partial<Omit<ProjectSettings, 'image'>>
  trashed?: boolean
  archived?: boolean
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** Create an empty text doc (optionally with content) or a folder. */
export interface CreateEntryRequest { path: string; kind: 'text' | 'folder'; content?: string }
/**
 * multipart/form-data upload. Fields:
 *   folder   — target folder path ('' = project root)
 *   replace  — 'true' to overwrite same-named files (text files are replaced through Yjs)
 *   files    — one or more file parts; a part's filename may contain a relative path
 *              (webkitRelativePath) which is preserved under `folder`.
 */
export interface UploadResponse { files: FileEntry[] }
/** Rename and/or move: `path` is the complete new path. Moving a folder moves its descendants. */
export interface MoveEntryRequest { path: string }
export interface MoveEntryResponse { files: FileEntry[] }
export interface DeleteEntryResponse { deletedIds: string[] }

// ---------------------------------------------------------------------------
// Compile
// ---------------------------------------------------------------------------

export interface CompileRequest {
  /** override the project root doc for this compile */
  rootFileId?: string
  /** Fast [draft] mode: graphicx draft option */
  draft?: boolean
  /** latexmk -halt-on-error (true) vs -f (false, default) */
  stopOnFirstError?: boolean
  /** true for auto-compile triggers (enables dedupe/backoff; never uses -gt) */
  auto?: boolean
  /** delete the compile directory first ("Recompile from scratch") */
  fromScratch?: boolean
}

export type CompileStatus =
  | 'success' // PDF produced (possibly with errors when not stopping on first error)
  | 'failure' // no PDF
  | 'stopped-on-first-error'
  | 'timedout'
  | 'terminated' // stopped by the user
  | 'error' // infrastructure error (docker missing, etc.)
  | 'too-recently-compiled'
  | 'unavailable' // compile queue full / auto-compile backoff
  | 'no-root' // no root document could be determined

export interface OutputFile {
  /** file name inside the build, e.g. 'antiddos_v2.pdf', 'antiddos_v2.log', 'antiddos_v2.blg' */
  path: string
  /** absolute URL path to fetch it, e.g. /api/projects/<pid>/builds/<buildId>/antiddos_v2.log */
  url: string
  size: number
  /** 'pdf' | 'log' | 'blg' | 'aux' | 'bbl' | ... (file extension without dot) */
  type: string
}

export type LogLevel = 'error' | 'warning' | 'typesetting' | 'info'

export interface LogEntry {
  level: LogLevel
  /** one-line summary, e.g. "Undefined control sequence." */
  message: string
  /** full message block (continuation lines, context, help text) */
  content: string
  /** project-relative path of the source file, or null when the location is outside the project/unknown */
  file: string | null
  /** 1-based line, null if unknown */
  line: number | null
  /** for badboxes spanning lines ("at lines 12--14") */
  lineEnd?: number | null
  source: 'latex' | 'bibtex' | 'biber' | 'latexmk'
  /** machine-readable classification, e.g. 'undefined-control-sequence', 'undefined-reference', 'overfull-hbox' */
  kind?: string
  /** human-readable hint (our own text) */
  hint?: string
  /**
   * 1-based line of the message in its raw log — the main `.log` for source 'latex', the `.blg`
   * for 'bibtex'/'biber'; absent when unknown. Reserved for a "show in raw log" action (the web
   * does not use it yet).
   */
  logLine?: number
  /**
   * PDF page being typeset when TeX reported it (source 'latex'; null when before the first
   * page). Reserved: the web does not use it yet.
   */
  page?: number | null
}

export interface ParsedLog {
  errors: LogEntry[]
  warnings: LogEntry[]
  /** bad boxes (overfull/underfull) */
  typesetting: LogEntry[]
  /** low-value informational entries (e.g. XeTeX invalid UTF-8 from an EPS read) */
  info: LogEntry[]
}

export interface CompileResponse {
  status: CompileStatus
  buildId: string | null
  /** jobname = basename of the root file without .tex */
  jobname: string | null
  /** project-relative path of the compiled root document */
  rootPath: string | null
  pdfUrl: string | null
  logUrl: string | null
  hasSynctex: boolean
  outputFiles: OutputFile[]
  /** parsed main log + .blg (merged), null when no log was produced */
  log: ParsedLog | null
  /** tail of latexmk stdout/stderr for error display (≤ 20 kB) */
  stdout: string
  /**
   * xr external documents that were (re)built for this compile. Every external document's PDF
   * and log are in `outputFiles` (`<jobname>.pdf`, or a path-derived name such as
   * `supp__main.pdf` when the jobname is taken by the main document or another external one).
   */
  externalBuilds: { path: string; status: CompileStatus }[]
  timings: { syncMs: number; compileMs: number; totalMs: number }
  /** true when the result was served from the content-hash cache without running TeX */
  cached: boolean
  compiledAt: number
  compiler: Compiler
  by: UserPublic | null
  /**
   * GET /compile/last only: when this build has no PDF (failed, stopped, timed out), the newest
   * build of the same root document that has one, so a reload or a viewer still shows the last
   * good PDF
   */
  lastWithPdf?: CompileResponse | null
}

export interface WordCountResponse {
  rootPath: string
  textWords: number
  headerWords: number
  captionWords: number
  headers: number
  floats: number
  mathInline: number
  mathDisplay: number
  /** raw texcount output */
  raw: string
}

// ---------------------------------------------------------------------------
// SyncTeX
// ---------------------------------------------------------------------------

/**
 * A rectangle on a PDF page in PDF points (1/72 in), origin at the page's TOP-LEFT,
 * y growing downwards. (x, y) is the top-left corner of the box.
 */
export interface PdfRect { page: number; x: number; y: number; width: number; height: number }

/** GET /api/projects/:pid/synctex/code?buildId&path&line&column  (line 1-based, column 0-based) */
export interface SyncCodeToPdfResponse { pdf: PdfRect[] }

/** GET /api/projects/:pid/synctex/pdf?buildId&page&x&y  (x, y in PDF points, top-left origin) */
export interface SyncPdfToCodeResponse {
  code: { path: string; fileId: string | null; line: number; column: number }[]
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/**
 * Why a version was recorded. 'upload' is reserved (not produced: an upload is recorded by the next
 * 'auto' version, or by a 'file-op' version when it replaces a file).
 */
export type HistoryReason = 'import' | 'auto' | 'restore' | 'label' | 'upload' | 'file-op' | 'manual' | 'shutdown'

export interface FileChange {
  path: string
  op: 'added' | 'modified' | 'deleted' | 'renamed'
  oldPath?: string
}

export interface Label {
  id: string
  name: string
  versionId: string
  createdAt: number
  user: UserPublic | null
}

export interface HistoryVersion {
  /** git commit sha */
  id: string
  parentId: string | null
  createdAt: number
  /** everyone who edited during this snapshot window (commit author + Co-authored-by) */
  authors: UserPublic[]
  reason: HistoryReason
  labels: Label[]
  changes: FileChange[]
  /**
   * first line of the commit message: 'Auto-save', the label name, 'Restored main.tex to a1b2c3d
   * (21 Sep 14:02)', 'Restored to a1b2c3d (…)', 'Copied from …', 'Initial import', …
   */
  summary?: string
  /** restore versions: the version that was restored (and the file, for a single-file restore) */
  restoredFrom?: { versionId: string; createdAt: number | null; path?: string }
}

/** GET /api/projects/:pid/history/versions?before=<sha>&limit=<n> (newest first) */
export interface HistoryListResponse { versions: HistoryVersion[]; hasMore: boolean }

/** GET /api/projects/:pid/history/versions/:versionId/files */
export interface HistoryFilesResponse {
  versionId: string
  files: { path: string; size: number; binary: boolean }[]
}

/** GET /api/projects/:pid/history/diff?to=<sha>&from=<sha?>&path=<path>  (from omitted → parent of `to`) */
export interface HistoryDiffResponse {
  path: string
  from: string | null
  to: string
  binary: boolean
  /** null when the file did not exist at `from` */
  oldText: string | null
  /** null when the file does not exist at `to` */
  newText: string | null
}

/** POST /api/projects/:pid/history/restore — path omitted restores the whole project */
export interface RestoreRequest { versionId: string; path?: string }
export interface RestoreResponse {
  restored: string[]
  versionId: string | null
  /** files of the version that could not be written (e.g. a folder of that name holds files); omitted when none */
  skipped?: string[]
}

/** POST /api/projects/:pid/history/labels — versionId omitted labels the current state (snapshot first) */
export interface CreateLabelRequest { name: string; versionId?: string }

// ---------------------------------------------------------------------------
// Sharing
// ---------------------------------------------------------------------------

export interface ShareLinks {
  /** tokens; the join URL is `${origin}/join/${token}` */
  editor: string | null
  viewer: string | null
}

export interface ShareInfo {
  members: Member[]
  /** only returned to the owner; null otherwise */
  links: ShareLinks | null
}

export interface AddMemberRequest { email: string; role: 'editor' | 'viewer' }
export interface UpdateMemberRequest { role: 'editor' | 'viewer' }
export interface CreateShareLinkRequest { role: 'editor' | 'viewer' }

export interface ShareTokenInfo {
  projectId: string
  projectName: string
  owner: UserPublic
  role: 'editor' | 'viewer'
  /** the current user already has at least this role */
  alreadyMember: boolean
}
export interface JoinResponse { projectId: string; role: Role }

// ---------------------------------------------------------------------------
// Chat, search, system, admin
// ---------------------------------------------------------------------------

export interface ChatMessage {
  id: number
  user: UserPublic
  content: string
  createdAt: number
}
export interface ChatListResponse { messages: ChatMessage[]; hasMore: boolean }
export interface PostChatRequest { content: string }

export interface SearchMatch { line: number; column: number; length: number; preview: string }
export interface SearchFileResult { fileId: string; path: string; matches: SearchMatch[] }
/** GET /api/projects/:pid/search?q=&regex=0|1&caseSensitive=0|1&wholeWord=0|1 */
export interface SearchResponse { results: SearchFileResult[]; truncated: boolean }

export interface SystemInfo {
  version: string
  compileRunner: 'docker' | 'local' | 'fake'
  compileImage: string
  /** e.g. 'TeX Live 2026' — null when unknown/unavailable */
  texLive: string | null
  dockerOk: boolean
  engines: Compiler[]
  allowSignup: boolean
}

export interface AdminUser extends UserPublic { isAdmin: boolean; createdAt: number; projectCount: number }
export interface CreateUserRequest { email: string; name: string; password: string; isAdmin?: boolean }

// ---------------------------------------------------------------------------
// Route table (method, path pattern, request → response). Paths are relative to origin.
// ---------------------------------------------------------------------------

export const ROUTES = {
  // health & system
  health: 'GET /healthz', // → { ok: true }
  system: 'GET /api/system', // → SystemInfo

  // auth
  setupStatus: 'GET /api/auth/setup-status', // → SetupStatus
  setup: 'POST /api/auth/setup', // RegisterRequest → Me (only while needsSetup; user becomes admin)
  register: 'POST /api/auth/register', // RegisterRequest → Me (only when allowSignup)
  login: 'POST /api/auth/login', // LoginRequest → Me
  logout: 'POST /api/auth/logout', // → 204
  me: 'GET /api/auth/me', // → Me (401 when logged out)
  updateMe: 'PATCH /api/auth/me', // UpdateMeRequest → Me

  // projects
  listProjects: 'GET /api/projects', // → ProjectSummary[]
  createProject: 'POST /api/projects', // CreateProjectRequest → CreateProjectResponse
  uploadProject: 'POST /api/projects/upload', // multipart {file: .zip, name?} → CreateProjectResponse
  getProject: 'GET /api/projects/:pid', // → ProjectDetail (also marks lastOpenedAt)
  updateProject: 'PATCH /api/projects/:pid', // UpdateProjectRequest → ProjectDetail
  deleteProject: 'DELETE /api/projects/:pid', // owner: deletes permanently; any other member: leaves the project → 204
  copyProject: 'POST /api/projects/:pid/copy', // CopyProjectRequest → CreateProjectResponse
  downloadProject: 'GET /api/projects/:pid/download.zip', // → application/zip (current live state)

  // files
  createEntry: 'POST /api/projects/:pid/files', // CreateEntryRequest → FileEntry
  uploadFiles: 'POST /api/projects/:pid/upload', // multipart → UploadResponse
  moveEntry: 'PATCH /api/projects/:pid/files/:fileId', // MoveEntryRequest → MoveEntryResponse
  deleteEntry: 'DELETE /api/projects/:pid/files/:fileId', // → DeleteEntryResponse
  rawFile: 'GET /api/projects/:pid/files/:fileId/raw', // → file bytes (text: live content). ?download=1 forces attachment
  previewFile: 'GET /api/projects/:pid/files/:fileId/preview', // → image/png (EPS/PS rendered with Ghostscript)
  search: 'GET /api/projects/:pid/search', // → SearchResponse

  // compile
  compile: 'POST /api/projects/:pid/compile', // CompileRequest → CompileResponse
  stopCompile: 'POST /api/projects/:pid/compile/stop', // → 204
  clearCache: 'DELETE /api/projects/:pid/compile/cache', // → 204
  // → CompileResponse | 204 (no build yet): the newest build of any root document;
  //   ?rootFileId=<id> → the newest build of that document; ?main=1 → of the main document
  //   (settings.rootFileId, else the auto-detected one). Builds are kept per root document.
  lastCompile: 'GET /api/projects/:pid/compile/last',
  buildFile: 'GET /api/projects/:pid/builds/:buildId/:file', // → output file bytes (Range supported)
  wordCount: 'GET /api/projects/:pid/wordcount', // ?rootFileId → WordCountResponse
  syncCode: 'GET /api/projects/:pid/synctex/code', // → SyncCodeToPdfResponse
  syncPdf: 'GET /api/projects/:pid/synctex/pdf', // → SyncPdfToCodeResponse

  // history
  historyVersions: 'GET /api/projects/:pid/history/versions', // → HistoryListResponse
  historyFiles: 'GET /api/projects/:pid/history/versions/:versionId/files', // → HistoryFilesResponse
  historyFile: 'GET /api/projects/:pid/history/versions/:versionId/file', // ?path → bytes
  historyDownload: 'GET /api/projects/:pid/history/versions/:versionId/download.zip', // → zip
  historyDiff: 'GET /api/projects/:pid/history/diff', // → HistoryDiffResponse
  historyRestore: 'POST /api/projects/:pid/history/restore', // RestoreRequest → RestoreResponse
  historySnapshot: 'POST /api/projects/:pid/history/snapshot', // → { versionId: string | null }
  createLabel: 'POST /api/projects/:pid/history/labels', // CreateLabelRequest → 201 Label
  deleteLabel: 'DELETE /api/projects/:pid/history/labels/:labelId', // → 204

  // sharing
  shareInfo: 'GET /api/projects/:pid/share', // → ShareInfo
  addMember: 'POST /api/projects/:pid/members', // AddMemberRequest → Member
  updateMember: 'PATCH /api/projects/:pid/members/:userId', // UpdateMemberRequest → Member
  removeMember: 'DELETE /api/projects/:pid/members/:userId', // owner removes anyone; a member may remove self → 204
  createShareLink: 'POST /api/projects/:pid/share-links', // CreateShareLinkRequest → 200 ShareLinks (creates or regenerates that role's link)
  deleteShareLink: 'DELETE /api/projects/:pid/share-links/:role', // → ShareLinks
  shareTokenInfo: 'GET /api/share/:token', // → ShareTokenInfo
  joinShareToken: 'POST /api/share/:token/join', // → JoinResponse

  // chat
  chatList: 'GET /api/projects/:pid/chat', // ?before=<id>&limit → ChatListResponse (ascending order)
  chatPost: 'POST /api/projects/:pid/chat', // PostChatRequest → ChatMessage

  // admin (isAdmin only)
  adminUsers: 'GET /api/admin/users', // → AdminUser[]
  adminCreateUser: 'POST /api/admin/users', // CreateUserRequest → AdminUser
  adminDeleteUser: 'DELETE /api/admin/users/:userId', // → 204
} as const

/** Web-side static assets served by the server (pdf.js cmaps, standard_fonts, wasm, iccs). */
export const PDFJS_ASSET_BASE = '/pdfjs/'
