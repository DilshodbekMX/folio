/**
 * Typed REST API: one method per ROUTES key with the same name (SPEC §6.2).
 * Signature rule: path params positionally in path order, then the JSON body (or a query
 * object for GETs with query params), then RequestOptions. Byte/stream routes are exposed as
 * URL builders `<key>Url(...)`. Methods and paths are derived from the ROUTES table itself.
 */
import {
  ROUTES,
  type AddMemberRequest, type AdminUser, type ChatListResponse, type ChatMessage, type CompileRequest,
  type CompileResponse, type CopyProjectRequest, type CreateEntryRequest, type CreateLabelRequest,
  type CreateProjectRequest, type CreateProjectResponse, type CreateShareLinkRequest, type CreateUserRequest,
  type DeleteEntryResponse, type FileEntry, type HistoryDiffResponse, type HistoryFilesResponse,
  type HistoryListResponse, type JoinResponse, type Label, type LoginRequest, type Me, type Member,
  type MoveEntryRequest, type MoveEntryResponse, type PostChatRequest, type ProjectDetail,
  type ProjectSummary, type RegisterRequest, type RestoreRequest, type RestoreResponse, type SearchResponse,
  type SetupStatus, type ShareInfo, type ShareLinks, type ShareTokenInfo, type SyncCodeToPdfResponse,
  type SyncPdfToCodeResponse, type SystemInfo, type UpdateMeRequest, type UpdateMemberRequest,
  type UpdateProjectRequest, type UploadResponse, type WordCountResponse,
} from '@folio/shared/api'
import { buildUrl, getText, request, upload, type HttpMethod, type Query, type RequestOptions, type UploadProgress } from './client'

export type RouteKey = keyof typeof ROUTES

/** Resolve a ROUTES pattern ('GET /api/projects/:pid') with URL-encoded params. */
export function routePath(key: RouteKey, params: Record<string, string> = {}): string {
  const pattern = ROUTES[key].slice(ROUTES[key].indexOf(' ') + 1)
  return pattern.replace(/:(\w+)/g, (_m, name: string) => {
    const v = params[name]
    if (typeof v !== 'string' || v.length === 0) throw new Error(`api.${key}: missing path parameter "${name}"`)
    return encodeURIComponent(v)
  })
}

export function routeMethod(key: RouteKey): HttpMethod {
  return ROUTES[key].slice(0, ROUTES[key].indexOf(' ')) as HttpMethod
}

function call<T>(key: RouteKey, params: Record<string, string>, body?: unknown, opts?: RequestOptions): Promise<T> {
  return request<T>(routeMethod(key), routePath(key, params), body, opts)
}

function get<T>(key: RouteKey, params: Record<string, string>, query?: Query, opts?: RequestOptions): Promise<T> {
  return request<T>('GET', routePath(key, params), undefined, { ...opts, query: { ...query, ...opts?.query } })
}

export interface UploadItem {
  file: File
  /** path relative to the upload folder, e.g. from webkitRelativePath ('figs/a.png'); defaults to file.name */
  relativePath?: string
}

export interface SearchQuery { q: string; regex?: boolean; caseSensitive?: boolean; wholeWord?: boolean }
export interface SyncCodeQuery { buildId: string; path: string; line: number; column?: number }
export interface SyncPdfQuery { buildId: string; page: number; x: number; y: number }
export interface HistoryDiffQuery { to: string; from?: string; path: string }

export const api = {
  // -- health & system -------------------------------------------------------------------------
  health: (opts?: RequestOptions) => call<{ ok: true }>('health', {}, undefined, opts),
  system: (opts?: RequestOptions) => call<SystemInfo>('system', {}, undefined, opts),

  // -- auth ------------------------------------------------------------------------------------
  setupStatus: (opts?: RequestOptions) => call<SetupStatus>('setupStatus', {}, undefined, opts),
  setup: (req: RegisterRequest, opts?: RequestOptions) => call<Me>('setup', {}, req, opts),
  register: (req: RegisterRequest, opts?: RequestOptions) => call<Me>('register', {}, req, opts),
  login: (req: LoginRequest, opts?: RequestOptions) => call<Me>('login', {}, req, opts),
  logout: (opts?: RequestOptions) => call<void>('logout', {}, undefined, opts),
  me: (opts?: RequestOptions) => call<Me>('me', {}, undefined, opts),
  updateMe: (req: UpdateMeRequest, opts?: RequestOptions) => call<Me>('updateMe', {}, req, opts),

  // -- projects --------------------------------------------------------------------------------
  listProjects: (opts?: RequestOptions) => call<ProjectSummary[]>('listProjects', {}, undefined, opts),
  createProject: (req: CreateProjectRequest, opts?: RequestOptions) => call<CreateProjectResponse>('createProject', {}, req, opts),
  /** multipart {name?, file: .zip} */
  uploadProject: (file: File, name?: string, onProgress?: UploadProgress, opts?: { signal?: AbortSignal }) => {
    const fd = new FormData()
    // text fields first so they are parsed before the file part
    if (name !== undefined && name.trim() !== '') fd.append('name', name.trim())
    fd.append('file', file, file.name)
    return upload<CreateProjectResponse>(routePath('uploadProject'), fd, onProgress, opts)
  },
  getProject: (pid: string, opts?: RequestOptions) => call<ProjectDetail>('getProject', { pid }, undefined, opts),
  updateProject: (pid: string, req: UpdateProjectRequest, opts?: RequestOptions) => call<ProjectDetail>('updateProject', { pid }, req, opts),
  deleteProject: (pid: string, opts?: RequestOptions) => call<void>('deleteProject', { pid }, undefined, opts),
  copyProject: (pid: string, req: CopyProjectRequest, opts?: RequestOptions) => call<CreateProjectResponse>('copyProject', { pid }, req, opts),
  downloadProjectUrl: (pid: string) => routePath('downloadProject', { pid }),

  // -- files -----------------------------------------------------------------------------------
  createEntry: (pid: string, req: CreateEntryRequest, opts?: RequestOptions) => call<FileEntry>('createEntry', { pid }, req, opts),
  /**
   * multipart {folder, replace, files[]}; each part's filename is the item's relative path so
   * folder structure is preserved under `folder`.
   */
  uploadFiles: (pid: string, items: UploadItem[], folder: string, replace: boolean, onProgress?: UploadProgress, opts?: { signal?: AbortSignal }) => {
    const fd = new FormData()
    fd.append('folder', folder)
    fd.append('replace', replace ? 'true' : 'false')
    for (const item of items) {
      const rel = (item.relativePath ?? '').replace(/^\/+/, '')
      fd.append('files', item.file, rel || item.file.name)
    }
    return upload<UploadResponse>(routePath('uploadFiles', { pid }), fd, onProgress, opts)
  },
  moveEntry: (pid: string, fileId: string, req: MoveEntryRequest, opts?: RequestOptions) => call<MoveEntryResponse>('moveEntry', { pid, fileId }, req, opts),
  deleteEntry: (pid: string, fileId: string, opts?: RequestOptions) => call<DeleteEntryResponse>('deleteEntry', { pid, fileId }, undefined, opts),
  /** `download` forces Content-Disposition: attachment; `v` is an optional cache-buster (e.g. file.updatedAt) */
  rawFileUrl: (pid: string, fileId: string, o: { download?: boolean; v?: string | number } = {}) =>
    buildUrl(routePath('rawFile', { pid, fileId }), { download: o.download ? 1 : undefined, v: o.v }),
  /** Current content of a file as text (text files: live Yjs content). */
  rawFile: (pid: string, fileId: string, opts?: RequestOptions) => getText(routePath('rawFile', { pid, fileId }), opts),
  /** PNG preview (EPS/PS rendered server-side); `v` is an optional cache-buster */
  previewFileUrl: (pid: string, fileId: string, o: { v?: string | number } = {}) =>
    buildUrl(routePath('previewFile', { pid, fileId }), { v: o.v }),
  search: (pid: string, query: SearchQuery, opts?: RequestOptions) =>
    get<SearchResponse>('search', { pid }, { q: query.q, regex: query.regex ?? false, caseSensitive: query.caseSensitive ?? false, wholeWord: query.wholeWord ?? false }, opts),

  // -- compile ---------------------------------------------------------------------------------
  compile: (pid: string, req: CompileRequest, opts?: RequestOptions) => call<CompileResponse>('compile', { pid }, req, opts),
  stopCompile: (pid: string, opts?: RequestOptions) => call<void>('stopCompile', { pid }, undefined, opts),
  clearCache: (pid: string, opts?: RequestOptions) => call<void>('clearCache', { pid }, undefined, opts),
  /**
   * null when the project (or the requested document) has never been compiled (HTTP 204).
   * Without a query: the newest build of any root document. `rootFileId`: the newest build of
   * that root document; `main`: of the main document (settings, else auto-detected). A server
   * that keeps a single last build per project ignores both, so callers check the rootPath.
   */
  lastCompile: async (pid: string, query: { rootFileId?: string; main?: boolean } = {}, opts?: RequestOptions): Promise<CompileResponse | null> =>
    (await get<CompileResponse | undefined>('lastCompile', { pid }, { rootFileId: query.rootFileId, main: query.main || undefined }, opts)) ?? null,
  buildFileUrl: (pid: string, buildId: string, file: string) => routePath('buildFile', { pid, buildId, file }),
  wordCount: (pid: string, query: { rootFileId?: string } = {}, opts?: RequestOptions) =>
    get<WordCountResponse>('wordCount', { pid }, { rootFileId: query.rootFileId }, opts),
  syncCode: (pid: string, query: SyncCodeQuery, opts?: RequestOptions) =>
    get<SyncCodeToPdfResponse>('syncCode', { pid }, { buildId: query.buildId, path: query.path, line: query.line, column: query.column ?? 0 }, opts),
  syncPdf: (pid: string, query: SyncPdfQuery, opts?: RequestOptions) =>
    get<SyncPdfToCodeResponse>('syncPdf', { pid }, { buildId: query.buildId, page: query.page, x: query.x, y: query.y }, opts),

  // -- history ---------------------------------------------------------------------------------
  historyVersions: (pid: string, query: { before?: string; limit?: number } = {}, opts?: RequestOptions) =>
    get<HistoryListResponse>('historyVersions', { pid }, { before: query.before, limit: query.limit }, opts),
  historyFiles: (pid: string, versionId: string, opts?: RequestOptions) => call<HistoryFilesResponse>('historyFiles', { pid, versionId }, undefined, opts),
  historyFileUrl: (pid: string, versionId: string, path: string) => buildUrl(routePath('historyFile', { pid, versionId }), { path }),
  historyDownloadUrl: (pid: string, versionId: string) => routePath('historyDownload', { pid, versionId }),
  historyDiff: (pid: string, query: HistoryDiffQuery, opts?: RequestOptions) =>
    get<HistoryDiffResponse>('historyDiff', { pid }, { to: query.to, from: query.from, path: query.path }, opts),
  historyRestore: (pid: string, req: RestoreRequest, opts?: RequestOptions) => call<RestoreResponse>('historyRestore', { pid }, req, opts),
  historySnapshot: (pid: string, opts?: RequestOptions) => call<{ versionId: string | null }>('historySnapshot', { pid }, undefined, opts),
  createLabel: (pid: string, req: CreateLabelRequest, opts?: RequestOptions) => call<Label>('createLabel', { pid }, req, opts),
  deleteLabel: (pid: string, labelId: string, opts?: RequestOptions) => call<void>('deleteLabel', { pid, labelId }, undefined, opts),

  // -- sharing ---------------------------------------------------------------------------------
  shareInfo: (pid: string, opts?: RequestOptions) => call<ShareInfo>('shareInfo', { pid }, undefined, opts),
  addMember: (pid: string, req: AddMemberRequest, opts?: RequestOptions) => call<Member>('addMember', { pid }, req, opts),
  updateMember: (pid: string, userId: string, req: UpdateMemberRequest, opts?: RequestOptions) => call<Member>('updateMember', { pid, userId }, req, opts),
  removeMember: (pid: string, userId: string, opts?: RequestOptions) => call<void>('removeMember', { pid, userId }, undefined, opts),
  createShareLink: (pid: string, req: CreateShareLinkRequest, opts?: RequestOptions) => call<ShareLinks>('createShareLink', { pid }, req, opts),
  deleteShareLink: (pid: string, role: 'editor' | 'viewer', opts?: RequestOptions) => call<ShareLinks>('deleteShareLink', { pid, role }, undefined, opts),
  shareTokenInfo: (token: string, opts?: RequestOptions) => call<ShareTokenInfo>('shareTokenInfo', { token }, undefined, opts),
  joinShareToken: (token: string, opts?: RequestOptions) => call<JoinResponse>('joinShareToken', { token }, undefined, opts),

  // -- chat ------------------------------------------------------------------------------------
  chatList: (pid: string, query: { before?: number; limit?: number } = {}, opts?: RequestOptions) =>
    get<ChatListResponse>('chatList', { pid }, { before: query.before, limit: query.limit }, opts),
  chatPost: (pid: string, req: PostChatRequest, opts?: RequestOptions) => call<ChatMessage>('chatPost', { pid }, req, opts),

  // -- admin -----------------------------------------------------------------------------------
  adminUsers: (opts?: RequestOptions) => call<AdminUser[]>('adminUsers', {}, undefined, opts),
  adminCreateUser: (req: CreateUserRequest, opts?: RequestOptions) => call<AdminUser>('adminCreateUser', {}, req, opts),
  adminDeleteUser: (userId: string, opts?: RequestOptions) => call<void>('adminDeleteUser', { userId }, undefined, opts),
}

export type Api = typeof api

// Compile-time guarantee that every ROUTES key has its method (or `<key>Url` builder for byte routes).
type ByteRoute = 'downloadProject' | 'rawFile' | 'previewFile' | 'buildFile' | 'historyFile' | 'historyDownload'
type RequiredApiKeys = Exclude<RouteKey, ByteRoute> | `${ByteRoute}Url`
const routeCoverage: { [K in RequiredApiKeys]: (...args: never[]) => unknown } = api
void routeCoverage
