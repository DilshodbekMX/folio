/**
 * Editor focus state (SPEC §6.3): which file is open, pending jump requests (logs, SyncTeX,
 * search, outline), the cursor position and the live CodeMirror view.
 * The last open file is remembered per project in localStorage ('folio:openFile:<pid>').
 * When the open file is deleted (or becomes a folder) the editor switches to a file now at the
 * same path, else the remembered/main document, and `onOpenFileLost` listeners are told (the
 * layout shows a notice: the switch is never silent).
 */
import { create } from 'zustand'
import type { EditorView } from '@codemirror/view'
import { readString, writeString } from '../lib/storage'
import { registerTestHook } from './testHooks'
import { defaultOpenFile, useProject } from './project'

export interface JumpTarget { fileId?: string; path?: string; line: number; column?: number }
export interface JumpRequest { fileId: string; line: number; column?: number; nonce: number }
export interface CursorPosition { fileId: string; line: number; column: number }

export interface EditorStoreState {
  openFileId: string | null
  openFile(fileId: string): void
  /** close the editor (nothing open) */
  closeFile(): void
  jumpRequest: JumpRequest | null
  /** opens the file (by id or project path), then the editor scrolls to/selects the line; false if the file is unknown */
  jumpTo(t: JumpTarget): boolean
  /** 1-based line, 0-based column */
  cursor: CursorPosition | null
  setCursor(c: CursorPosition | null): void
  view: EditorView | null
  setView(v: EditorView | null): void
  reset(): void
}

const openFileKey = (pid: string) => `folio:openFile:${pid}`

function persistOpenFile(fileId: string | null): void {
  const pid = useProject.getState().projectId
  if (pid && fileId) writeString(openFileKey(pid), fileId)
}

let jumpNonce = 0

/** The open file disappeared from the project (deleted, or replaced by a folder). */
export interface OpenFileLost {
  fileId: string
  path: string
  /** what the editor shows now (null: nothing) */
  nextFileId: string | null
}
const lostListeners = new Set<(e: OpenFileLost) => void>()

export function onOpenFileLost(fn: (e: OpenFileLost) => void): () => void {
  lostListeners.add(fn)
  return () => {
    lostListeners.delete(fn)
  }
}

export const useEditor = create<EditorStoreState>()((set, get) => ({
  openFileId: null,
  openFile(fileId) {
    if (get().openFileId === fileId) return
    persistOpenFile(fileId)
    set({ openFileId: fileId, cursor: null })
  },
  closeFile() {
    set({ openFileId: null, cursor: null })
  },
  jumpRequest: null,
  jumpTo(t) {
    const project = useProject.getState()
    let fileId: string | undefined
    if (t.fileId && project.files[t.fileId]) fileId = t.fileId
    else if (t.path) fileId = project.fileByPath(t.path)?.id
    else if (t.fileId && project.loadState !== 'ready') fileId = t.fileId // files not loaded yet — trust the caller
    if (!fileId) return false
    const file = project.files[fileId]
    if (file && file.kind === 'folder') return false
    const line = Math.max(1, Math.floor(Number.isFinite(t.line) ? t.line : 1))
    const column = t.column !== undefined && Number.isFinite(t.column) ? Math.max(0, Math.floor(t.column)) : undefined
    if (get().openFileId !== fileId) persistOpenFile(fileId)
    set(s => ({
      openFileId: fileId,
      cursor: s.openFileId === fileId ? s.cursor : null,
      jumpRequest: { fileId, line, column, nonce: ++jumpNonce },
    }))
    return true
  },
  cursor: null,
  setCursor(c) {
    const cur = get().cursor
    if (c === cur || (c && cur && c.fileId === cur.fileId && c.line === cur.line && c.column === cur.column)) return
    set({ cursor: c })
  },
  view: null,
  setView(v) {
    if (get().view !== v) set({ view: v })
  },
  reset() {
    set({ openFileId: null, jumpRequest: null, cursor: null, view: null })
  },
}))

registerTestHook('useEditor', useEditor)

/** Open the remembered file of this project, or its main document. */
function restoreOpenFile(): void {
  const project = useProject.getState()
  if (!project.projectId || project.loadState !== 'ready') return
  const current = useEditor.getState().openFileId
  if (current && project.files[current] && project.files[current].kind !== 'folder') return
  const remembered = readString(openFileKey(project.projectId))
  const rememberedFile = remembered ? project.files[remembered] : undefined
  const next = rememberedFile && rememberedFile.kind !== 'folder' ? rememberedFile : defaultOpenFile()
  useEditor.setState({ openFileId: next?.id ?? null, cursor: null })
}

let wired = false
export function wireEditor(): void {
  if (wired) return
  wired = true
  useProject.subscribe((s, prev) => {
    if (s.projectId !== prev.projectId) {
      useEditor.getState().reset()
      if (s.loadState === 'ready') restoreOpenFile()
      return
    }
    if (s.loadState !== 'ready') return
    if (prev.loadState !== 'ready') {
      restoreOpenFile()
      return
    }
    if (s.files === prev.files) return
    const cur = useEditor.getState().openFileId
    // the file list arrived after the project became ready (meta room): open the remembered or main document
    if (!cur && Object.keys(prev.files).length === 0) {
      restoreOpenFile()
      return
    }
    if (!cur || (s.files[cur] && s.files[cur].kind !== 'folder')) return
    // the open file was deleted or replaced by a folder: prefer a file now at the same path
    const lost = prev.files[cur]
    const same = lost ? useProject.getState().fileByPath(lost.path) : undefined
    if (same && same.id !== cur && same.kind !== 'folder') {
      persistOpenFile(same.id)
      useEditor.setState({ openFileId: same.id, cursor: null })
    } else {
      restoreOpenFile()
    }
    if (!lost) return
    const event: OpenFileLost = { fileId: cur, path: lost.path, nextFileId: useEditor.getState().openFileId }
    for (const fn of [...lostListeners]) {
      try {
        fn(event)
      } catch (e) {
        console.error('[editor] open-file-lost listener failed', e)
      }
    }
  })
}
queueMicrotask(wireEditor)
