/**
 * Text kept from document sessions that were closed for good while they still held local edits
 * the server never confirmed (INT-1 residual): typically edits made offline to a file that a
 * collaborator deleted, deleted and created again at the same path, or replaced (new epoch, e.g.
 * text → binary) in the meantime; also a reset server copy (stale lineage) or a changed role.
 *
 * docs.ts calls keepRecoveredText() the moment such a session is invalidated, with the session's
 * whole text (the server's copy plus the unconfirmed edits). Nothing is merged into whatever
 * file is at that path now; the text stays here — in memory, mirrored to sessionStorage so a
 * reload of the tab keeps it — until the user dismisses it. The editor layout shows a persistent
 * notice per entry of the open project (features/layout/RecoveredTexts.tsx) with "Copy my text",
 * "Save as new file" (editors; viewers get "Download as file") and "Compare with current";
 * closing the tab asks first while an entry was neither saved nor dismissed (docs.ts
 * beforeunload). A role changed to viewer while the user edited offline is one such close: the
 * server refuses the read-only socket's edits with 4403 (never confirming them), or the reconnect
 * catch-up finds the new role first; either way the text is kept here with that code.
 *
 * Who deleted/replaced the file comes from the 'files:changed' event (`by`), when this tab was
 * online to receive it — events missed while offline are not replayed.
 *
 * Each kept text belongs to the user whose session kept it; the store, its sessionStorage mirror
 * and the per-user rules (another account in the same tab never sees it; a logout discards it)
 * live in ./recoveredStore.ts.
 */
import type { FileEntry } from '@folio/shared/api'
import { WS_CLOSE } from '@folio/shared/protocol'
import { randomId } from '../lib/format'
import { registerTestHook } from '../stores/testHooks'
import { onSignOut, useAuth } from '../stores/auth'
import { useProject } from '../stores/project'
import { projectEvents } from './meta'
import { MAX_RECOVERED, dismissRecovered, ownRecovered, useRecovered, type RecoveredText } from './recoveredStore'

export {
  dismissRecovered, hasUnsavedRecovered, markRecoveredSaved, ownRecovered, useRecovered, type RecoveredText,
} from './recoveredStore'

export type RecoveredCause = 'deleted' | 'recreated' | 'replaced' | 'reset' | 'access' | 'closed'

/** a 'files:changed' event this recent can name who removed a file whose session closed later */
const EVENT_MEMORY_MS = 60_000
const ACCESS_CODES: ReadonlySet<number> = new Set([WS_CLOSE.UNAUTHORIZED, WS_CLOSE.FORBIDDEN, WS_CLOSE.NOT_FOUND])

// -- who changed the file ------------------------------------------------------------------------

interface SeenFile { id: string; kind: FileEntry['kind']; epoch: number }
interface SeenChange { projectId: string; at: number; deletedIds: string[]; changed: SeenFile[]; by: { id: string; name: string } }
let recentChanges: SeenChange[] = []

/**
 * The change deleted the file, or replaced it (the same id, no longer text or at a newer epoch).
 * Its creation, a rename or a text upload into it (same epoch) did not close the session, and a
 * file created later at the same path is someone else's doing: none of them say who removed it.
 */
function concerns(c: { deletedIds: string[]; changed: SeenFile[] }, item: Pick<RecoveredText, 'fileId' | 'epoch'>): boolean {
  return c.deletedIds.includes(item.fileId) || c.changed.some(f => f.id === item.fileId && (f.kind !== 'text' || f.epoch > item.epoch))
}

function whoChanged(projectId: string, item: Pick<RecoveredText, 'fileId' | 'epoch'>): { id: string; name: string } | null {
  const now = Date.now()
  recentChanges = recentChanges.filter(c => now - c.at < EVENT_MEMORY_MS)
  for (let i = recentChanges.length - 1; i >= 0; i--) {
    const c = recentChanges[i]
    if (c.projectId === projectId && concerns(c, item)) return c.by
  }
  return null
}

let wired = false
export function wireRecovered(): void {
  if (wired) return
  wired = true
  // what this account's project rooms reported is not the next account's business
  onSignOut(() => {
    recentChanges = []
  })
  projectEvents.on('files:changed', e => {
    const projectId = useProject.getState().projectId
    const by = e.by && typeof e.by.id === 'string' && typeof e.by.name === 'string' ? { id: e.by.id, name: e.by.name } : null
    if (!projectId || !by) return
    const change: SeenChange = {
      projectId,
      at: Date.now(),
      deletedIds: Array.isArray(e.deletedIds) ? e.deletedIds : [],
      changed: Array.isArray(e.changed) ? e.changed.map(f => ({ id: f.id, kind: f.kind, epoch: f.epoch })) : [],
      by,
    }
    recentChanges = [...recentChanges.slice(-19), change]
    const { items } = useRecovered.getState()
    if (!items.some(i => i.projectId === projectId && !i.by && concerns(change, i))) return
    useRecovered.setState({ items: items.map(i => (i.projectId === projectId && !i.by && concerns(change, i) ? { ...i, by } : i)) })
  })
}
queueMicrotask(wireRecovered)

// -- API -------------------------------------------------------------------------------------------

export interface KeepInput {
  /** the user the session belonged to (DocSession.userId) */
  userId: string | null
  projectId: string
  fileId: string
  epoch: number
  path: string
  text: string
  code: number | null
  offline: boolean
}

let deletedLocally: (fileId: string, path: string) => boolean = () => false

/**
 * Tell which deletions this tab made itself (the file tree, a history restore): edits typed
 * online just before are on the server already (and committed to history before the delete),
 * so their session closing is not news (features/editor/openFileGuard.ts registers it).
 */
export function setLocalDeletionCheck(fn: (fileId: string, path: string) => boolean): void {
  deletedLocally = fn
}

/**
 * Keep the text of a session closed with unconfirmed edits (docs.ts). Returns the entry, or
 * null when this tab deleted the file itself while online.
 */
export function keepRecoveredText(input: KeepInput): RecoveredText | null {
  wireRecovered()
  const userId = input.userId ?? useAuth.getState().me?.id ?? null
  if (!userId) {
    // no owner: showing it to whoever signs in next would hand them someone else's text
    console.warn('[recovered] a closed document had unsaved edits of an unknown user; they are not kept')
    return null
  }
  if (input.code === WS_CLOSE.GONE && !input.offline && deletedLocally(input.fileId, input.path)) return null
  const { items } = useRecovered.getState()
  // the same text of the same file kept twice (e.g. two sessions of one file): once is enough
  const dup = items.find(i => i.userId === userId && i.projectId === input.projectId && i.fileId === input.fileId && i.text === input.text && !i.savedAs)
  if (dup) return dup
  const project = useProject.getState()
  const item: RecoveredText = {
    ...input,
    userId,
    id: randomId(12),
    projectName: project.projectId === input.projectId ? project.name || null : null,
    by: whoChanged(input.projectId, input),
    at: Date.now(),
    savedAs: null,
  }
  let next = [...items, item]
  // bounded: the oldest saved ones go first, then the oldest
  while (next.length > MAX_RECOVERED) {
    const saved = next.findIndex(i => i.savedAs)
    next = next.filter((_, k) => k !== (saved >= 0 ? saved : 0))
  }
  useRecovered.setState({ items: next })
  return item
}

/** The signed-in user's kept text of a file (the newest), if any. */
export function recoveredFor(projectId: string, fileId: string): RecoveredText | undefined {
  const items = ownRecovered(useRecovered.getState().items)
  for (let i = items.length - 1; i >= 0; i--) if (items[i].projectId === projectId && items[i].fileId === fileId) return items[i]
  return undefined
}

/**
 * What happened to the file, judged from the project's files now (a file may be created again
 * at the same path later), and the text file that stands there now (for "Compare with current").
 */
export function recoveredCause(item: RecoveredText, files: Record<string, FileEntry>): { cause: RecoveredCause; current: FileEntry | null } {
  const same = files[item.fileId]
  let live = same && same.kind !== 'folder' ? same : undefined
  // closed as deleted (4410) while the file list has not caught up yet: it is gone all the same
  if (live && item.code === WS_CLOSE.GONE && live.kind === 'text' && live.epoch <= item.epoch) live = undefined
  let atPath: FileEntry | undefined
  if (!live) {
    for (const f of Object.values(files)) {
      if (f.path === item.path && f.kind !== 'folder' && f.id !== item.fileId) {
        atPath = f
        break
      }
    }
  }
  let cause: RecoveredCause
  if (item.code !== null && ACCESS_CODES.has(item.code)) cause = 'access'
  else if (!live) cause = atPath ? 'recreated' : 'deleted'
  else if (live.kind !== 'text' || live.epoch > item.epoch) cause = 'replaced'
  else if (item.code === WS_CLOSE.STALE_EPOCH) cause = 'reset'
  else cause = 'closed'
  const candidate = live ?? atPath
  return { cause, current: candidate && candidate.kind === 'text' ? candidate : null }
}

registerTestHook('recovered', {
  useRecovered,
  items: () => useRecovered.getState().items,
  dismiss: dismissRecovered,
})
