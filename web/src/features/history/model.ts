/** Pure helpers for the history view: selection ranges, net file changes, authors, labels and wording. */
import type { FileChange, HistoryReason, HistoryVersion, UserPublic } from '@folio/shared/api'
import { basename } from '@folio/shared/paths'
import { safeFilename } from '../../lib/download'
import { formatDateTime } from '../../lib/time'

/**
 * What the diff shows.
 *  - single: one version's own changes (its parent → the version)
 *  - range:  "compare from X to Y": the state at X → the state at Y (changes of the versions after X up to Y)
 */
export type HistorySelection =
  | { kind: 'single'; id: string }
  | { kind: 'range'; fromId: string; toId: string }

export const REASON_LABEL: Record<HistoryReason, string> = {
  auto: 'Auto-save',
  shutdown: 'Auto-save',
  manual: 'Auto-save',
  restore: 'Restore',
  import: 'Import',
  label: 'Label',
  upload: 'Upload',
  'file-op': 'File changes',
}

export const REASON_TONE: Record<HistoryReason, 'neutral' | 'accent' | 'info' | 'warning'> = {
  auto: 'neutral',
  shutdown: 'neutral',
  manual: 'neutral',
  restore: 'info',
  import: 'accent',
  label: 'accent',
  upload: 'neutral',
  'file-op': 'neutral',
}

/** The server's default commit summaries: they only repeat the reason chip. */
const PLAIN_SUMMARIES = new Set(['Snapshot', 'Initial import', 'Auto-save', 'Restore', 'Label', 'Upload', 'File changes', 'Manual snapshot', 'Auto-save (server shutdown)'])

/**
 * What the version did, in one line, when that says more than the reason chip: for a restore
 * "Restored main.tex from 21 Sep 2026, 14:02" / "Restored the project from …", otherwise the
 * commit's summary line (e.g. "Auto-save before restore", "Copied from Paper"); null when the
 * server sends nothing better than the chip (the card then shows the chip alone).
 */
export function versionSummary(v: HistoryVersion): string | null {
  const from = v.restoredFrom
  if (v.reason === 'restore' && from && from.createdAt !== null) {
    const when = formatDateTime(from.createdAt)
    return from.path ? `Restored ${basename(from.path)} from ${when}` : `Restored the project from ${when}`
  }
  const text = v.summary?.trim()
  if (!text || PLAIN_SUMMARIES.has(text) || text === REASON_LABEL[v.reason]) return null
  // a label version is summarised by its label, shown on the card anyway
  if (v.reason === 'label' && v.labels.some(l => l.name === text)) return null
  return text
}

export interface NetChange extends FileChange {
  /** number of versions in the range that touched this path */
  touches: number
}

/**
 * Net changes of `versions` (given newest first, as the list is), applied oldest → newest.
 * Added-then-deleted files disappear; renames chain (a → b → c shows a → c).
 */
export function netChanges(versions: HistoryVersion[]): NetChange[] {
  const map = new Map<string, NetChange>()
  for (let i = versions.length - 1; i >= 0; i--) {
    for (const c of versions[i].changes) {
      const prev = map.get(c.path)
      switch (c.op) {
        case 'added':
          map.set(c.path, { path: c.path, op: prev?.op === 'deleted' ? 'modified' : 'added', touches: (prev?.touches ?? 0) + 1 })
          break
        case 'modified':
          map.set(c.path, prev && prev.op !== 'deleted' ? { ...prev, touches: prev.touches + 1 } : { path: c.path, op: 'modified', touches: (prev?.touches ?? 0) + 1 })
          break
        case 'deleted':
          if (prev?.op === 'added') map.delete(c.path)
          else if (prev?.op === 'renamed' && prev.oldPath) {
            map.delete(c.path)
            map.set(prev.oldPath, { path: prev.oldPath, op: 'deleted', touches: prev.touches + 1 })
          } else map.set(c.path, { path: c.path, op: 'deleted', touches: (prev?.touches ?? 0) + 1 })
          break
        case 'renamed': {
          const from = c.oldPath ?? ''
          const before = from ? map.get(from) : undefined
          if (from) map.delete(from)
          if (before?.op === 'added') map.set(c.path, { path: c.path, op: 'added', touches: before.touches + 1 })
          else if (before?.op === 'renamed' && before.oldPath) {
            if (before.oldPath === c.path) map.set(c.path, { path: c.path, op: 'modified', touches: before.touches + 1 })
            else map.set(c.path, { path: c.path, op: 'renamed', oldPath: before.oldPath, touches: before.touches + 1 })
          } else map.set(c.path, { path: c.path, op: 'renamed', oldPath: from || undefined, touches: (before?.touches ?? 0) + 1 })
          break
        }
      }
    }
  }
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }))
}

/** Versions of the list covered by a selection (newest first) and the diff endpoints. */
export function resolveSelection(list: HistoryVersion[], sel: HistorySelection | null): {
  versions: HistoryVersion[]
  /** diff 'to' version */
  to: HistoryVersion | null
  /** diff 'from' version id; undefined = the parent of `to` (single selection) */
  fromId: string | undefined
  from: HistoryVersion | null
} {
  if (!sel) return { versions: [], to: null, fromId: undefined, from: null }
  if (sel.kind === 'single') {
    const v = list.find(x => x.id === sel.id) ?? null
    return { versions: v ? [v] : [], to: v, fromId: undefined, from: null }
  }
  const a = list.findIndex(x => x.id === sel.toId)
  const b = list.findIndex(x => x.id === sel.fromId)
  if (a < 0 || b < 0) return { versions: [], to: null, fromId: undefined, from: null }
  // versions strictly after `from` up to and including `to`
  return { versions: list.slice(a, b), to: list[a], fromId: list[b].id, from: list[b] }
}

/** Range selection between two versions in either order (newer one becomes `to`). */
export function makeRange(list: HistoryVersion[], x: string, y: string): HistorySelection {
  if (x === y) return { kind: 'single', id: x }
  const ix = list.findIndex(v => v.id === x)
  const iy = list.findIndex(v => v.id === y)
  if (ix < 0 || iy < 0) return { kind: 'single', id: y }
  return ix < iy ? { kind: 'range', fromId: y, toId: x } : { kind: 'range', fromId: x, toId: y }
}

export interface FileAuthor {
  user: UserPublic
  /** time of the newest selected version this person made that touched the file */
  at: number
}

/**
 * Who changed `path` in the selected versions (given newest first), most recent first — renames
 * are followed back, so edits made under the file's old name count. Folio records the people who
 * edited during each snapshot, not who wrote each line: with one person the attribution of every
 * change is exact, with several it says who could have made them.
 */
export function fileAuthors(versions: HistoryVersion[], path: string): FileAuthor[] {
  const names = new Set([path])
  const out = new Map<string, FileAuthor>()
  for (const v of versions) {
    let touched = false
    for (const c of v.changes) {
      if (!names.has(c.path)) continue
      touched = true
      if (c.op === 'renamed' && c.oldPath) names.add(c.oldPath)
    }
    if (!touched) continue
    for (const a of v.authors) if (!out.has(a.id)) out.set(a.id, { user: a, at: v.createdAt })
  }
  return [...out.values()]
}

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n))

/**
 * File name for a version's .zip: "<project> - <label>.zip" for a labelled version (its newest
 * label), else "<project> - 2026-09-22 14.05.zip" (local time) — never the commit hash.
 */
export function versionZipName(project: string, v: Pick<HistoryVersion, 'createdAt' | 'labels'>): string {
  const stem = safeFilename(project, 'project')
  const d = new Date(v.createdAt)
  const when = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}.${pad2(d.getMinutes())}`
  const label = [...v.labels].sort((a, b) => b.createdAt - a.createdAt)[0]?.name
  return `${stem} - ${label ? safeFilename(label, when) : when}.zip`
}

export function versionTime(v: HistoryVersion): string {
  return formatDateTime(v.createdAt)
}

export function selectionIds(sel: HistorySelection | null): string[] {
  if (!sel) return []
  return sel.kind === 'single' ? [sel.id] : [sel.fromId, sel.toId]
}
