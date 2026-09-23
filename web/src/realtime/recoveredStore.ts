/**
 * Kept texts (./recovered.ts explains what they are): the store, its sessionStorage mirror and
 * who may see them. Kept small on purpose (no Yjs, no project store) so the dashboard's logout
 * can discard them without loading the editor code.
 *
 * Every entry belongs to the user whose document session kept it (`userId`). Only that user
 * sees it, can act on it, or is asked about it when closing the tab; another account signed in
 * later in the same tab never does (REG-4). A logout in this tab discards the user's entries —
 * the logout dialog says so. When the session ended otherwise (expired, revoked, logged out in
 * another tab) they stay, hidden, and come back when that user signs in again in this tab.
 */
import { create } from 'zustand'
import { isRecord } from '../lib/storage'
import { onSignOut, useAuth } from '../stores/auth'

export interface RecoveredText {
  id: string
  /** the user whose unsaved edits these are (the only one who ever sees them) */
  userId: string
  projectId: string
  /** project name when the text was kept (for notices outside the project) */
  projectName: string | null
  fileId: string
  /** epoch of the closed session */
  epoch: number
  /** path of the file when its session was closed */
  path: string
  /** the session's whole text: the server copy plus the edits it never confirmed */
  text: string
  /** close code that invalidated the session (null: destroyed without one) */
  code: number | null
  /** some of the unconfirmed edits were made while the connection was down */
  offline: boolean
  /** who deleted / replaced the file, when a 'files:changed' event said so */
  by: { id: string; name: string } | null
  at: number
  /** "Save as new file" wrote it here */
  savedAs: { fileId: string; path: string } | null
}

interface RecoveredState {
  items: RecoveredText[]
}

const STORAGE_KEY = 'folio:recovered:v1'
export const MAX_RECOVERED = 20

// -- persistence (sessionStorage: survives a reload of this tab, never shared) ---------------------

function session(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage
  } catch {
    return null
  }
}

function sanitize(v: unknown): RecoveredText | null {
  if (!isRecord(v)) return null
  const str = (k: string) => (typeof v[k] === 'string' ? (v[k] as string) : null)
  const id = str('id')
  const userId = str('userId')
  const projectId = str('projectId')
  const fileId = str('fileId')
  const path = str('path')
  const text = str('text')
  // entries without an owner (older format) are dropped: nobody could be told they are theirs
  if (!id || !userId || !projectId || !fileId || !path || text === null) return null
  const by = isRecord(v.by) && typeof v.by.id === 'string' && typeof v.by.name === 'string' ? { id: v.by.id, name: v.by.name } : null
  const savedAs = isRecord(v.savedAs) && typeof v.savedAs.fileId === 'string' && typeof v.savedAs.path === 'string'
    ? { fileId: v.savedAs.fileId, path: v.savedAs.path }
    : null
  return {
    id, userId, projectId, fileId, path, text, by, savedAs,
    projectName: str('projectName'),
    epoch: typeof v.epoch === 'number' ? v.epoch : 0,
    code: typeof v.code === 'number' ? v.code : null,
    offline: v.offline === true,
    at: typeof v.at === 'number' ? v.at : Date.now(),
  }
}

function load(): RecoveredText[] {
  try {
    const raw = session()?.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map(sanitize).filter((x): x is RecoveredText => x !== null).slice(-MAX_RECOVERED) : []
  } catch {
    return []
  }
}

function persist(items: RecoveredText[]): void {
  const s = session()
  if (!s) return
  try {
    if (items.length === 0) s.removeItem(STORAGE_KEY)
    else s.setItem(STORAGE_KEY, JSON.stringify(items))
  } catch {
    // quota exceeded: keep them in memory only — and never let an older list come back on reload
    try {
      s.removeItem(STORAGE_KEY)
    } catch {
      // storage unusable
    }
  }
}

export const useRecovered = create<RecoveredState>()(() => ({ items: load() }))
useRecovered.subscribe((s, prev) => {
  if (s.items !== prev.items) persist(s.items)
})

// -- whose entries -----------------------------------------------------------------------------------

/** the last user signed in in this tab: while nobody is, closing the tab asks about their entries */
let lastUserId: string | null = useAuth.getState().me?.id ?? null
useAuth.subscribe(s => {
  if (s.me) lastUserId = s.me.id
})

/** Entries of `userId` (the signed-in user by default; none while nobody is signed in). */
export function ownRecovered(items: readonly RecoveredText[], userId: string | null = useAuth.getState().me?.id ?? null): RecoveredText[] {
  return userId ? items.filter(i => i.userId === userId) : []
}

/**
 * Kept texts of the signed-in user — or, while nobody is, of the last one — that were neither
 * saved as a file nor dismissed (closing the tab asks first).
 */
export function hasUnsavedRecovered(): boolean {
  const userId = useAuth.getState().me?.id ?? lastUserId
  return !!userId && useRecovered.getState().items.some(i => i.userId === userId && !i.savedAs)
}

export function dismissRecovered(id: string): void {
  const { items } = useRecovered.getState()
  if (items.some(i => i.id === id)) useRecovered.setState({ items: items.filter(i => i.id !== id) })
}

export function markRecoveredSaved(id: string, savedAs: { fileId: string; path: string }): void {
  const { items } = useRecovered.getState()
  useRecovered.setState({ items: items.map(i => (i.id === id ? { ...i, savedAs } : i)) })
}

// A logout in this tab discards the user's kept texts (the logout dialog asked first); any other
// end of the session keeps them for that user only.
onSignOut(({ userId, reason }) => {
  if (reason !== 'logout') return
  const { items } = useRecovered.getState()
  if (items.some(i => i.userId === userId)) useRecovered.setState({ items: items.filter(i => i.userId !== userId) })
})
