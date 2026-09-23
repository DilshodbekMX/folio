/**
 * Folio realtime protocol (WebSocket, y-websocket compatible framing).
 *
 * Two kinds of rooms, both spoken with the y-websocket wire format
 * (varUint messageType, then payload) on a same-origin WebSocket authenticated by the
 * session cookie:
 *
 *   Doc room   ws(s)://<host>/ws/doc/<projectId>/<fileId>?epoch=<n>
 *              Client: new WebsocketProvider(`${wsBase}/ws/doc/${projectId}`, fileId, ydoc,
 *                                            { params: { epoch: String(epoch) }, disableBc: true })
 *              Y.Doc layout: ydoc.getText(DOC_TEXT_KEY)  — LF-only text.
 *              Awareness state: { user: { id, name, color, colorLight }, cursor?: ... }  (y-codemirror.next fields)
 *
 *   Meta room  ws(s)://<host>/ws/project/<projectId>
 *              Client: new WebsocketProvider(`${wsBase}/ws/project`, projectId, metaDoc, { disableBc: true })
 *              Server-authoritative Y.Doc (client updates are DROPPED):
 *                metaDoc.getMap(META_FILES_KEY)   fileId → FileEntry (plain JSON object)
 *                metaDoc.getMap(META_PROJECT_KEY) 'name' → string, 'settings' → ProjectSettings,
 *                                                  'updatedAt' → number
 *              Awareness state: MetaPresence (below) — drives avatars and "who is in which file".
 *              Server → client JSON events via MSG_EVENT (ProjectEvent).
 *
 * Message types:
 *   0 MSG_SYNC        y-protocols/sync (step1/step2/update). Viewers' step2/update are dropped.
 *   1 MSG_AWARENESS   y-protocols/awareness update. The server rebroadcasts to ALL connections
 *                     of the room including the sender, and sends an empty awareness keepalive
 *                     every KEEPALIVE_MS (y-websocket reconnects after 30 s of silence).
 *   3 MSG_QUERY_AWARENESS
 *   100 MSG_BARRIER   client → server: [100, varString nonce]; the server echoes [100, nonce]
 *                     only after it has applied every message received before it on that socket.
 *                     Used before compiling so the server copy contains the last keystroke.
 *   101 MSG_EVENT     server → client: [101, varString JSON.stringify(ProjectEvent)] (meta room only).
 *
 * Close codes (see WS_CLOSE): 4400–4499 stop y-websocket's automatic reconnect; 1011, 1012 and
 * 1013 are standard codes after which the client reconnects on its own.
 */

import type { ChatMessage, CompileStatus, FileEntry, ProjectSettings, UserPublic } from './api.ts'

export const MSG_SYNC = 0
export const MSG_AWARENESS = 1
export const MSG_QUERY_AWARENESS = 3
export const MSG_BARRIER = 100
export const MSG_EVENT = 101

export const DOC_TEXT_KEY = 'content'
export const META_FILES_KEY = 'files'
export const META_PROJECT_KEY = 'project'

export const KEEPALIVE_MS = 10_000
/** max accepted WebSocket frame */
export const MAX_WS_PAYLOAD = 8 * 1024 * 1024
/** max length (UTF-16 units) of a collaborative text document */
export const MAX_DOC_LENGTH = 2 * 1024 * 1024

export const WS_CLOSE = {
  /** the server failed to set up the connection (e.g. the document could not be loaded) — clients reconnect */
  INTERNAL: 1011,
  /** normal server restart — clients reconnect */
  SERVICE_RESTART: 1012,
  /** "try again later": the account holds too many open connections — clients reconnect (with back-off) */
  TRY_AGAIN: 1013,
  UNAUTHORIZED: 4401,
  FORBIDDEN: 4403,
  NOT_FOUND: 4404,
  /** the file's room epoch changed (Y state discarded) — refetch metadata, open a new Y.Doc */
  STALE_EPOCH: 4409,
  /** file or project deleted */
  GONE: 4410,
  /** document exceeds MAX_DOC_LENGTH */
  TOO_LARGE: 4413,
} as const

export interface PresenceUser {
  id: string
  name: string
  color: string
  /** translucent variant for selection backgrounds, e.g. color + '33' */
  colorLight: string
}

/** Awareness state published by each client in the meta room. */
export interface MetaPresence {
  user: PresenceUser
  /** file currently open in the editor, if any */
  openFileId: string | null
}

export type ProjectEvent =
  /** `rootPath`: the document being compiled (project path); older servers leave it out */
  | { type: 'compile:started'; by: UserPublic; auto: boolean; rootPath?: string | null }
  /**
   * `rootPath` / `jobname`: the document that was compiled (null when the compile never started,
   * e.g. no main document); older servers leave them out. A client showing another root
   * document's PDF should ignore the build (GET /compile/last?rootFileId= gives its own).
   */
  | { type: 'compile:done'; by: UserPublic | null; status: CompileStatus; buildId: string | null; rootPath?: string | null; jobname?: string | null }
  | { type: 'chat:message'; message: ChatMessage }
  | { type: 'history:changed'; versionId: string | null }
  | { type: 'members:changed' }
  | { type: 'project:renamed'; name: string }
  | { type: 'project:settings'; settings: ProjectSettings }
  | { type: 'project:deleted' }
  /** debounced (≥1 s) notification that a text file changed — lets clients auto-compile on edits to files they do not have open */
  | { type: 'doc:changed'; fileId: string; userId: string | null }
  /** the given user's access was revoked or downgraded; that client should reload the project */
  | { type: 'access:changed'; userId: string }
  /**
   * file tree changed (the meta Y.Map is authoritative; this is a hint for toasts). `by` is the
   * user whose operation it was (null: the server itself); older servers leave it out.
   */
  | { type: 'files:changed'; changed: FileEntry[]; deletedIds: string[]; by?: UserPublic | null }

/** y-websocket provider URL helpers */
export function docServerUrl(wsBase: string, projectId: string): string {
  return `${wsBase}/ws/doc/${encodeURIComponent(projectId)}`
}
export function metaServerUrl(wsBase: string): string {
  return `${wsBase}/ws/project`
}
