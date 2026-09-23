/**
 * The open project (SPEC §6.3): populated by the REST load, then kept live by realtime/meta.ts
 * (files, name, settings, presence, connection).
 *
 * Import-cycle rule for stores/ and realtime/: module top-level code only touches external
 * packages, lib/, api/ and its own bindings; cross-module wiring runs in functions (after the
 * whole module graph has been evaluated), so any import order is safe.
 */
import { create } from 'zustand'
import type { FileEntry, Member, ProjectDetail, ProjectSettings, Role, UserPublic } from '@folio/shared/api'
import type { PresenceUser } from '@folio/shared/protocol'
import { comparePaths, extname, normalizePath } from '@folio/shared/paths'
import { api } from '../api/endpoints'
import { ApiError, errorMessage } from '../api/client'
import { registerTestHook } from './testHooks'
import { connectMeta, isMetaSynced, refreshFromMeta } from '../realtime/meta'
import { docSessions } from '../realtime/docs'
import { wireEditor } from './editor'
import { wireCompile } from './compile'
import { wireLayout } from './layout'

export type ProjectLoadState = 'idle' | 'loading' | 'ready' | 'error'
export type ConnectionState = 'connecting' | 'connected' | 'disconnected'
export interface PresenceEntry { clientId: number; user: PresenceUser; openFileId: string | null }

export interface ProjectState {
  projectId: string | null
  loadState: ProjectLoadState
  error: string | null
  name: string
  role: Role | null
  owner: UserPublic | null
  settings: ProjectSettings | null
  files: Record<string, FileEntry>
  members: Member[]
  /** other users' clients only (our own other tabs are left out) */
  presence: PresenceEntry[]
  /** meta (project) WebSocket: 'connecting' until the first sync, 'disconnected' while reconnecting */
  connection: ConnectionState
  /** incremented after every successful load()/reload() — lets realtime re-check access */
  accessVersion: number
  load(projectId: string): Promise<void>
  unload(): void
  /** re-fetch the project (role/members/settings) without tearing anything down */
  reload(): Promise<void>
  reloadMembers(): Promise<void>
  rename(name: string): Promise<void>
  updateSettings(patch: Partial<ProjectSettings>): Promise<void>
  canEdit(): boolean
  fileByPath(path: string): FileEntry | undefined
  rootFile(): FileEntry | undefined
  textFiles(): FileEntry[]
}

type ProjectData = Pick<ProjectState,
  'projectId' | 'loadState' | 'error' | 'name' | 'role' | 'owner' | 'settings' | 'files' | 'members' | 'presence' | 'connection'>

const EMPTY: ProjectData = {
  projectId: null,
  loadState: 'idle',
  error: null,
  name: '',
  role: null,
  owner: null,
  settings: null,
  files: {},
  members: [],
  presence: [],
  connection: 'connecting',
}

export function filesToRecord(files: readonly FileEntry[]): Record<string, FileEntry> {
  const out: Record<string, FileEntry> = {}
  for (const f of files) out[f.id] = f
  return out
}

export function loadErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404 || e.status === 403) return 'This project does not exist or you do not have access to it.'
    if (e.status === 401) return 'Your session has expired. Please sign in again.'
  }
  return errorMessage(e, 'The project could not be loaded.')
}

// module-private lifecycle bookkeeping
let loadGen = 0
let loadPromise: Promise<void> | null = null
let reloadPromise: Promise<void> | null = null
let metaRelease: (() => void) | null = null
let teardownTimer: ReturnType<typeof setTimeout> | null = null

// memoised derived data (recomputed when `files` changes identity)
let pathIndexFor: Record<string, FileEntry> | null = null
let pathIndex = new Map<string, FileEntry>()
let textFilesFor: Record<string, FileEntry> | null = null
let textFilesCache: FileEntry[] = []

function wireAll(): void {
  wireEditor()
  wireCompile()
  wireLayout()
}

export const useProject = create<ProjectState>()((set, get) => {
  const applyDetail = (d: ProjectDetail) => {
    const patch: Partial<ProjectState> = { name: d.name, role: d.role, owner: d.owner, settings: d.settings, members: d.members }
    // a synced meta room is newer than (or as new as) this REST snapshot: keep its file list
    if (!isMetaSynced(d.id)) patch.files = filesToRecord(d.files)
    set(patch)
  }

  const teardown = () => {
    if (teardownTimer !== null) {
      clearTimeout(teardownTimer)
      teardownTimer = null
    }
    loadGen++
    loadPromise = null
    reloadPromise = null
    const release = metaRelease
    metaRelease = null
    release?.()
    docSessions.closeAll()
    set({ ...EMPTY })
  }

  return {
    ...EMPTY,
    accessVersion: 0,

    load(projectId) {
      wireAll()
      const s = get()
      if (s.projectId === projectId && teardownTimer !== null) {
        // StrictMode / quick remount: cancel the pending unload and keep everything alive
        clearTimeout(teardownTimer)
        teardownTimer = null
      }
      if (s.projectId === projectId && (s.loadState === 'loading' || s.loadState === 'ready')) {
        return loadPromise ?? Promise.resolve()
      }
      if (s.projectId !== null) teardown()
      const gen = ++loadGen
      set({ ...EMPTY, projectId, loadState: 'loading' })
      const p = (async () => {
        try {
          const detail = await api.getProject(projectId)
          if (gen !== loadGen) return
          applyDetail(detail)
          // meta may have synced before the REST answer arrived: its state is newer
          refreshFromMeta(projectId)
          set(st => ({ loadState: 'ready', error: null, accessVersion: st.accessVersion + 1 }))
          if (!metaRelease) metaRelease = connectMeta(projectId)
        } catch (e) {
          if (gen !== loadGen) return
          set({ loadState: 'error', error: loadErrorMessage(e) })
        }
      })()
      loadPromise = p
      return p
    },

    unload() {
      if (get().projectId === null || teardownTimer !== null) return
      // deferred so a synchronous unmount/remount (React StrictMode) keeps the connections
      teardownTimer = setTimeout(teardown, 0)
    },

    reload() {
      const projectId = get().projectId
      if (!projectId) return Promise.resolve()
      if (reloadPromise) return reloadPromise
      const gen = loadGen
      const p = (async () => {
        try {
          const detail = await api.getProject(projectId)
          if (gen !== loadGen) return
          applyDetail(detail)
          refreshFromMeta(projectId)
          set(st => ({ loadState: 'ready', error: null, accessVersion: st.accessVersion + 1 }))
          if (!metaRelease) metaRelease = connectMeta(projectId)
        } catch (e) {
          if (gen !== loadGen) return
          if (e instanceof ApiError && (e.status === 403 || e.status === 404)) {
            set({ loadState: 'error', error: 'You no longer have access to this project.', connection: 'disconnected' })
          } else if (e instanceof ApiError && e.status === 401) {
            set({ loadState: 'error', error: loadErrorMessage(e), connection: 'disconnected' })
          } else {
            throw e
          }
        } finally {
          reloadPromise = null
        }
      })()
      reloadPromise = p
      return p
    },

    async reloadMembers() {
      const projectId = get().projectId
      if (!projectId) return
      const info = await api.shareInfo(projectId)
      if (get().projectId === projectId) set({ members: info.members })
    },

    async rename(name) {
      const projectId = get().projectId
      if (!projectId) return
      const clean = name.trim()
      if (!clean) throw new ApiError(400, 'validation', 'The project name must not be empty.')
      const detail = await api.updateProject(projectId, { name: clean })
      if (get().projectId === projectId) set({ name: detail.name, settings: detail.settings })
    },

    async updateSettings(patch) {
      const projectId = get().projectId
      const before = get().settings
      if (!projectId || !before) return
      const { image: _image, ...rest } = patch
      void _image // server-controlled
      set({ settings: { ...before, ...rest } })
      try {
        const detail = await api.updateProject(projectId, { settings: rest })
        if (get().projectId === projectId) set({ settings: detail.settings, name: detail.name })
      } catch (e) {
        // revert only the keys we changed, keeping updates that arrived meanwhile
        const cur = get().settings
        if (get().projectId === projectId && cur) {
          const reverted = { ...cur }
          for (const k of Object.keys(rest) as (keyof typeof rest)[]) {
            (reverted as Record<string, unknown>)[k] = before[k]
          }
          set({ settings: reverted })
        }
        throw e
      }
    },

    canEdit() {
      const role = get().role
      return role === 'owner' || role === 'editor'
    },

    fileByPath(path) {
      const files = get().files
      if (pathIndexFor !== files) {
        pathIndex = new Map()
        for (const f of Object.values(files)) pathIndex.set(f.path, f)
        pathIndexFor = files
      }
      const direct = pathIndex.get(path)
      if (direct) return direct
      const normalized = normalizePath(path.replace(/^(\.\/)+/, ''))
      return pathIndex.get(normalized)
    },

    rootFile() {
      const id = get().settings?.rootFileId
      return id ? get().files[id] : undefined
    },

    textFiles() {
      const files = get().files
      if (textFilesFor !== files) {
        textFilesCache = Object.values(files)
          .filter(f => f.kind === 'text')
          .sort((a, b) => comparePaths(a.path, b.path))
        textFilesFor = files
      }
      return textFilesCache
    },
  }
})

registerTestHook('useProject', useProject)

/**
 * Best guess of the document to open first: the root document, else main.tex, else the first
 * .tex file, else the first text file.
 */
export function defaultOpenFile(): FileEntry | undefined {
  const st = useProject.getState()
  const root = st.rootFile()
  if (root && root.kind === 'text') return root
  const texts = st.textFiles()
  return texts.find(f => f.path === 'main.tex')
    ?? texts.find(f => extname(f.path) === 'tex' && !f.path.includes('/'))
    ?? texts.find(f => extname(f.path) === 'tex')
    ?? texts[0]
}
