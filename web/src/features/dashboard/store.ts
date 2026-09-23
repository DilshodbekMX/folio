/**
 * Dashboard state: the project list plus view state (filter, search, sort, selection). Emptied
 * when the user signs out, so the next account never sees this one's projects — not even for
 * the moment its own list takes to load.
 */
import { create } from 'zustand'
import type { ProjectSummary } from '@folio/shared/api'
import { api } from '../../api/endpoints'
import { errorMessage } from '../../api/client'
import { readJSON, writeJSON } from '../../lib/storage'
import { onSignOut } from '../../stores/auth'

export type DashFilter = 'all' | 'owned' | 'shared' | 'archived' | 'trashed'
export type SortKey = 'name' | 'owner' | 'updatedAt'
export interface SortState { key: SortKey; dir: 'asc' | 'desc' }

const SORT_KEY = 'folio:dashboard:sort'
const DEFAULT_SORT: SortState = { key: 'updatedAt', dir: 'desc' }

function readSort(): SortState {
  return readJSON<SortState>(SORT_KEY, DEFAULT_SORT, v => {
    const o = v as Partial<SortState> | null
    if (!o || !['name', 'owner', 'updatedAt'].includes(o.key as string) || !['asc', 'desc'].includes(o.dir as string)) return undefined
    return { key: o.key as SortKey, dir: o.dir as 'asc' | 'desc' }
  })
}

export interface DashboardState {
  projects: ProjectSummary[]
  loadState: 'idle' | 'loading' | 'ready' | 'error'
  error: string | null
  filter: DashFilter
  query: string
  sort: SortState
  selected: Set<string>
  load(opts?: { quiet?: boolean }): Promise<void>
  setFilter(f: DashFilter): void
  setQuery(q: string): void
  toggleSort(key: SortKey): void
  setSelected(ids: Iterable<string>): void
  toggleSelected(id: string, on?: boolean): void
  clearSelection(): void
  /** apply a local change immediately (the next load reconciles) */
  patch(id: string, patch: Partial<ProjectSummary>): void
  remove(ids: string[]): void
  /** forget everything of the signed-out account (answers of requests still running are dropped) */
  reset(): void
}

let loadSeq = 0

export const useDashboard = create<DashboardState>()((set, get) => ({
  projects: [],
  loadState: 'idle',
  error: null,
  filter: 'all',
  query: '',
  sort: readSort(),
  selected: new Set(),

  async load(opts) {
    const seq = ++loadSeq
    if (!opts?.quiet) set({ loadState: get().loadState === 'ready' ? 'ready' : 'loading', error: null })
    try {
      const projects = await api.listProjects()
      if (seq !== loadSeq) return
      const ids = new Set(projects.map(p => p.id))
      const selected = new Set([...get().selected].filter(id => ids.has(id)))
      set({ projects, loadState: 'ready', error: null, selected })
    } catch (e) {
      if (seq !== loadSeq) return
      set({ loadState: get().loadState === 'ready' ? 'ready' : 'error', error: errorMessage(e, 'Could not load your projects.') })
      throw e
    }
  },

  setFilter(filter) {
    set({ filter, selected: new Set() })
  },
  setQuery(query) {
    set({ query })
  },
  toggleSort(key) {
    const cur = get().sort
    const sort: SortState = cur.key === key
      ? { key, dir: cur.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: key === 'updatedAt' ? 'desc' : 'asc' }
    writeJSON(SORT_KEY, sort)
    set({ sort })
  },
  setSelected(ids) {
    set({ selected: new Set(ids) })
  },
  toggleSelected(id, on) {
    const selected = new Set(get().selected)
    const want = on ?? !selected.has(id)
    if (want) selected.add(id)
    else selected.delete(id)
    set({ selected })
  },
  clearSelection() {
    if (get().selected.size) set({ selected: new Set() })
  },
  patch(id, patch) {
    set({ projects: get().projects.map(p => (p.id === id ? { ...p, ...patch } : p)) })
  },
  remove(ids) {
    const drop = new Set(ids)
    const selected = new Set([...get().selected].filter(id => !drop.has(id)))
    set({ projects: get().projects.filter(p => !drop.has(p.id)), selected })
  },
  reset() {
    loadSeq++
    set({ projects: [], loadState: 'idle', error: null, filter: 'all', query: '', selected: new Set() })
  },
}))

onSignOut(() => useDashboard.getState().reset())

export function matchesFilter(p: ProjectSummary, filter: DashFilter): boolean {
  switch (filter) {
    case 'all':
      return !p.trashed && !p.archived
    case 'owned':
      return !p.trashed && !p.archived && p.role === 'owner'
    case 'shared':
      return !p.trashed && !p.archived && p.role !== 'owner'
    case 'archived':
      return p.archived && !p.trashed
    case 'trashed':
      return p.trashed
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function visibleProjects(
  projects: ProjectSummary[], filter: DashFilter, query: string, sort: SortState, meId: string | null,
): ProjectSummary[] {
  const q = query.trim().toLocaleLowerCase()
  const list = projects.filter(p => matchesFilter(p, filter) && (!q || p.name.toLocaleLowerCase().includes(q)))
  const ownerLabel = (p: ProjectSummary) => (p.owner.id === meId ? '' : p.owner.name) // "You" sorts first
  const cmp = (a: ProjectSummary, b: ProjectSummary): number => {
    switch (sort.key) {
      case 'name':
        return collator.compare(a.name, b.name)
      case 'owner':
        return collator.compare(ownerLabel(a), ownerLabel(b)) || collator.compare(a.name, b.name)
      case 'updatedAt':
        return a.updatedAt - b.updatedAt
    }
  }
  list.sort((a, b) => (sort.dir === 'asc' ? cmp(a, b) : -cmp(a, b)))
  return list
}

export const FILTER_LABELS: Record<DashFilter, string> = {
  all: 'All projects',
  owned: 'Your projects',
  shared: 'Shared with you',
  archived: 'Archived projects',
  trashed: 'Trashed projects',
}

export const SEARCH_PLACEHOLDERS: Record<DashFilter, string> = {
  all: 'Search in all projects…',
  owned: 'Search in your projects…',
  shared: 'Search in projects shared with you…',
  archived: 'Search in archived projects…',
  trashed: 'Search in trashed projects…',
}
