/**
 * What the editor does when its open file disappears (INT-1): deleted by a collaborator, by a
 * project restore, or by this user from the file tree.
 *
 * The editor store falls back to the remembered / main document when the open file vanishes
 * from useProject.files. That fallback editor used to take the focus with the cursor at position
 * 0, so the keystrokes meant for the deleted file went to the top of main.tex. Instead:
 *  - the editor closes to its empty state, which says what happened and offers the file's
 *    history and its last text; a toast says who deleted it (unless this tab did). The switch
 *    is undone within the same store update, before anything renders;
 *  - when the store switches to a new file at the same path (the file was replaced), that file
 *    is shown but does not take the keyboard focus. Edits of the old file the server never got
 *    (typically made offline) are not lost with it: realtime/docs.ts keeps its session's text
 *    when the session is invalidated, and the layout shows a persistent notice to copy it, save
 *    it as a new file or compare it with the new file (realtime/recovered.ts);
 *  - the toast names who deleted the file: the 'files:changed' event right behind the file-list
 *    update carries `by`; the toast waits a moment for it rather than flash "a collaborator".
 *
 * Works whatever the store does on a deletion (switch to another file, close, or keep the stale
 * id). Installed once by EditorPane.
 */
import { create } from 'zustand'
import type { FileEntry } from '@folio/shared/api'
import type { ProjectEvent } from '@folio/shared/protocol'
import { basename } from '@folio/shared/paths'
import { projectEvents } from '../../realtime/meta'
import { recoveredFor, setLocalDeletionCheck } from '../../realtime/recovered'
import { onSignOut, useAuth } from '../../stores/auth'
import { useEditor } from '../../stores/editor'
import { useLayout } from '../../stores/layout'
import { useProject } from '../../stores/project'
import { registerTestHook } from '../../stores/testHooks'
import { toast } from '../../ui'
import { suppressAutoFocus } from './reveal'

export interface ClosedFileNotice {
  fileId: string
  path: string
  /** this tab deleted it (file tree, history restore) */
  byMe: boolean
  /** who deleted it, when known */
  byName: string | null
  /** the editor text at the moment the file disappeared (may hold edits the server never got) */
  lastText: string | null
}

export const useClosedFile = create<{ notice: ClosedFileNotice | null }>(() => ({ notice: null }))

/** Deletions started in this tab (by id, or everything below a folder path). */
const expected: { ids: Set<string>; folders: string[]; all: boolean; until: number } = { ids: new Set(), folders: [], all: false, until: 0 }
const EXPECT_MS = 15_000

/**
 * This tab is about to delete these entries (file tree) — or, with `all`, is about to change the
 * whole project (history restore): their disappearance is not reported as someone else's action.
 */
export function expectLocalDeletion(entries: { id: string; path: string; kind: FileEntry['kind'] }[] | 'all'): void {
  const now = Date.now()
  if (now > expected.until) {
    expected.ids.clear()
    expected.folders = []
    expected.all = false
  }
  expected.until = now + EXPECT_MS
  if (entries === 'all') {
    expected.all = true
    return
  }
  for (const e of entries) {
    expected.ids.add(e.id)
    if (e.kind === 'folder') expected.folders.push(e.path + '/')
  }
}

function deletedHere(file: Pick<FileEntry, 'id' | 'path'>): boolean {
  if (Date.now() > expected.until) return false
  return expected.all || expected.ids.has(file.id) || expected.folders.some(f => file.path.startsWith(f))
}

function gone(files: Record<string, FileEntry>, id: string): boolean {
  const f = files[id]
  return !f || f.kind === 'folder'
}

/** Who made the change ('files:changed' `by`; older servers leave it out, the server itself sends null). */
function changedBy(e: Extract<ProjectEvent, { type: 'files:changed' }>): { id: string; name: string } | null {
  const by = e.by
  if (!by || typeof by !== 'object') return null
  return typeof by.id === 'string' && typeof by.name === 'string' ? { id: by.id, name: by.name } : null
}

/** how long a deletion toast waits for the event naming who deleted the file */
const BY_WAIT_MS = 400

/** the id the layout's own "open file lost" notice uses: ours replaces it rather than stacking */
const toastId = (fileId: string) => `file-lost-${fileId}`

let announceTimer: ReturnType<typeof setTimeout> | null = null

function announce(n: ClosedFileNotice): void {
  if (announceTimer !== null) clearTimeout(announceTimer)
  announceTimer = null
  if (n.byMe) return
  const pid = useProject.getState().projectId
  const kept = pid && recoveredFor(pid, n.fileId) ? ' Your unsaved changes to it were kept (see the notice at the top).' : ''
  toast(`“${basename(n.path)}” was deleted by ${n.byName ?? 'a collaborator'} while you had it open. You can restore it from the project history.${kept}`, {
    tone: 'warning',
    id: toastId(n.fileId),
    duration: 10_000,
    action: { label: 'History', onClick: () => useLayout.getState().setHistoryOpen(true) },
  })
}

function noteGone(file: FileEntry, lastText: string | null): void {
  if (useClosedFile.getState().notice?.fileId === file.id) return
  const text = lastText ?? goneTexts.get(file.id) ?? null
  goneTexts.delete(file.id)
  const notice: ClosedFileNotice = { fileId: file.id, path: file.path, byMe: deletedHere(file), byName: null, lastText: text }
  useClosedFile.setState({ notice })
  if (notice.byMe) return
  // the 'files:changed' event naming who did it follows the file-list update on the same socket
  if (announceTimer !== null) clearTimeout(announceTimer)
  announceTimer = setTimeout(() => {
    announceTimer = null
    if (useClosedFile.getState().notice === notice) announce(notice)
  }, BY_WAIT_MS)
}

/**
 * The last text of documents whose session was closed because the file was deleted (4410): the
 * server usually closes the document before the file list says it is gone, and the editor is
 * torn down by then.
 */
const goneTexts = new Map<string, string>()
// the previous account's texts never outlive its session
onSignOut(() => goneTexts.clear())

export function rememberDeletedText(fileId: string, text: string): void {
  goneTexts.delete(fileId)
  goneTexts.set(fileId, text)
  while (goneTexts.size > 4) goneTexts.delete(goneTexts.keys().next().value!)
}

/** the file list as of the previous update (while the store reacts to the current one) */
let knownFiles: Record<string, FileEntry> = {}
let installed = false

export function installOpenFileGuard(): void {
  if (installed) return
  installed = true
  knownFiles = useProject.getState().files
  // a document this tab deleted itself (typed online, then deleted): no "kept changes" notice
  setLocalDeletionCheck((fileId, path) => deletedHere({ id: fileId, path }))

  // the store reacting to a deletion: it runs inside the file-list update, before our own
  // file-list listener below, and before anything renders
  useEditor.subscribe((s, prev) => {
    if (s.openFileId === prev.openFileId) return
    const from = prev.openFileId
    const files = useProject.getState().files
    const lost = from ? knownFiles[from] : undefined
    if (from && lost && lost.kind !== 'folder' && gone(files, from)) {
      const next = s.openFileId ? files[s.openFileId] : undefined
      if (next && next.path === lost.path) {
        // replaced by a new file at the same path: show it, but typing must not continue in it.
        // Unsaved edits of the old file are kept by realtime/docs.ts (persistent notice).
        suppressAutoFocus(next.id)
        return
      }
      const text = prev.view ? safeText(prev.view) : null
      if (s.openFileId !== null) useEditor.getState().closeFile()
      noteGone(lost, text)
      return
    }
    if (s.openFileId !== null && useClosedFile.getState().notice) useClosedFile.setState({ notice: null })
  })

  useProject.subscribe((s, prev) => {
    if (s.projectId !== prev.projectId) {
      knownFiles = s.files
      goneTexts.clear()
      useClosedFile.setState({ notice: null })
      return
    }
    if (s.files === prev.files) return
    const before = knownFiles
    knownFiles = s.files
    if (s.loadState !== 'ready') return
    // the store kept the vanished file open (or nothing reacted): close it here
    const ed = useEditor.getState()
    const cur = ed.openFileId
    if (!cur || !before[cur] || before[cur].kind === 'folder' || !gone(s.files, cur)) return
    const text = ed.view ? safeText(ed.view) : null
    ed.closeFile()
    noteGone(before[cur], text)
  })

  // the event that follows the file-list update says who deleted the file
  projectEvents.on('files:changed', e => {
    const n = useClosedFile.getState().notice
    if (!n || !e.deletedIds.includes(n.fileId) || n.byMe || n.byName) return
    const by = changedBy(e)
    if (!by) return
    if (by.id === useAuth.getState().me?.id) {
      // deleted by this user in another tab: no toast about a collaborator; the empty state says so
      useClosedFile.setState({ notice: { ...n, byName: 'You (in another tab)' } })
      if (announceTimer !== null) clearTimeout(announceTimer)
      announceTimer = null
      return
    }
    const next = { ...n, byName: by.name }
    useClosedFile.setState({ notice: next })
    announce(next)
  })
}

function safeText(view: { state: { doc: { toString(): string } } }): string | null {
  try {
    return view.state.doc.toString()
  } catch {
    return null
  }
}

registerTestHook('closedFileNotice', () => useClosedFile.getState().notice)
