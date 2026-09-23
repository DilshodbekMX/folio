/**
 * Sync state of the document sessions, published by ./docs.ts. It lives in this small module
 * (no Yjs, no CodeMirror) so the dashboard and the app shell can read it without loading the
 * editor code: while no project was opened in this tab it simply stays empty.
 */
import { create } from 'zustand'

/** Sync state of the document sessions (for the connection banner, the leave guard and tests). */
export interface DocSyncState {
  /** live sessions with local edits the server has not confirmed yet, any project */
  pending: { fileId: string; projectId: string }[]
  /** of those, the ones that cannot be sent right now (socket down or not synced yet) */
  unsynced: { fileId: string; projectId: string }[]
  /** per project: sessions closed for good (access lost, file deleted…) before the server confirmed their edits */
  lost: Record<string, number>
}

export const useDocSync = create<DocSyncState>()(() => ({ pending: [], unsynced: [], lost: {} }))

/** True while some document session (any project) holds edits the server has not confirmed. */
export function hasPendingDocChanges(): boolean {
  return useDocSync.getState().pending.length > 0
}
