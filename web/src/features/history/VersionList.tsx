/**
 * Right column of the history view: versions grouped by day (newest first) with time, reason
 * chip, the commit summary when it says more (e.g. "Restored main.tex to a1171bf"), authors,
 * changed files and labels; "All history | Labels" filter; click selects,
 * Shift-click (or Shift+↑/↓) selects a range to compare; ↑/↓ move between versions; infinite
 * scroll loads older pages; each card has a "…" menu (label, compare, download, restore).
 */
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent } from 'react'
import clsx from 'clsx'
import {
  ArrowRightLeft, Download, Ellipsis, FileMinus, FilePen, FilePlus, History, RotateCcw, Tag, X,
} from 'lucide-react'
import type { FileChange, HistoryVersion, Label, UserPublic } from '@folio/shared/api'
import { basename } from '@folio/shared/paths'
import { formatTime, groupByDay } from '../../lib/time'
import { Avatar, Button, EmptyState, Spinner, Tabs, Tooltip, showContextMenu, type MenuItem } from '../../ui'
import { REASON_LABEL, REASON_TONE, versionSummary, type HistorySelection } from './model'

export type VersionFilter = 'all' | 'labels'

export interface VersionActions {
  addLabel(v: HistoryVersion): void
  deleteLabel(l: Label): void
  download(v: HistoryVersion): void
  restoreProject(v: HistoryVersion): void
  compareFrom(v: HistoryVersion): void
  compareTo(v: HistoryVersion): void
}

interface Props {
  versions: HistoryVersion[]
  state: 'loading' | 'ready' | 'error'
  error: string | null
  hasMore: boolean
  loadingMore: boolean
  onLoadMore: () => void
  onRetry: () => void
  filter: VersionFilter
  onFilter: (f: VersionFilter) => void
  selection: HistorySelection | null
  onSelect: (id: string, extend: boolean) => void
  canEdit: boolean
  meId: string | null
  actions: VersionActions
}

const MAX_FILES_SHOWN = 3

function opIcon(op: FileChange['op']) {
  switch (op) {
    case 'added': return FilePlus
    case 'deleted': return FileMinus
    case 'renamed': return ArrowRightLeft
    default: return FilePen
  }
}

export const OP_LABEL: Record<FileChange['op'], string> = {
  added: 'Created',
  modified: 'Edited',
  deleted: 'Deleted',
  renamed: 'Renamed',
}

export function OpIcon({ op, size = 14 }: { op: FileChange['op']; size?: number }) {
  const Icon = opIcon(op)
  return <Icon size={size} aria-hidden="true" className={clsx('hist-op', `hist-op--${op}`)} />
}

export function authorNames(authors: UserPublic[], meId: string | null): string {
  if (authors.length === 0) return 'Folio'
  const names = authors.map(a => (a.id === meId ? 'You' : a.name))
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

export function VersionList({
  versions, state, error, hasMore, loadingMore, onLoadMore, onRetry, filter, onFilter, selection, onSelect, canEdit, meId, actions,
}: Props) {
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const sentinelRef = useRef<HTMLDivElement | null>(null)
  const shown = filter === 'labels' ? versions.filter(v => v.labels.length > 0) : versions
  const newestId = versions[0]?.id ?? null
  const groups = groupByDay(shown, v => v.createdAt)

  // selection geometry
  const index = new Map(versions.map((v, i) => [v.id, i]))
  let lo = -1
  let hi = -1
  if (selection?.kind === 'range') {
    const a = index.get(selection.toId) ?? -1
    const b = index.get(selection.fromId) ?? -1
    lo = Math.min(a, b)
    hi = Math.max(a, b)
  }
  const focusId = selection ? (selection.kind === 'single' ? selection.id : selection.toId) : shown[0]?.id ?? null

  // infinite scroll: load older versions when the sentinel becomes visible
  useEffect(() => {
    const root = scrollRef.current
    const el = sentinelRef.current
    if (!root || !el || !hasMore) return
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) onLoadMore()
    }, { root, rootMargin: '0px 0px 400px 0px' })
    io.observe(el)
    return () => io.disconnect()
  }, [hasMore, onLoadMore])

  // the observer only fires on changes: keep loading while the sentinel stays in view (Labels filter)
  useEffect(() => {
    const root = scrollRef.current
    const el = sentinelRef.current
    if (!root || !el || !hasMore || loadingMore || state !== 'ready') return
    const r = el.getBoundingClientRect()
    const rr = root.getBoundingClientRect()
    if (r.top < rr.bottom + 400) onLoadMore()
  }, [versions, filter, hasMore, loadingMore, state, onLoadMore])

  // keep the focused card visible
  useLayoutEffect(() => {
    if (!focusId) return
    const el = scrollRef.current?.querySelector<HTMLElement>(`[data-version="${CSS.escape(focusId)}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusId])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLElement) || !e.target.matches('.hist-card__select')) return
    const id = e.target.closest<HTMLElement>('[data-version]')?.dataset.version
    const i = shown.findIndex(v => v.id === id)
    if (i < 0) return
    let j = -1
    if (e.key === 'ArrowDown') j = Math.min(shown.length - 1, i + 1)
    else if (e.key === 'ArrowUp') j = Math.max(0, i - 1)
    else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = shown.length - 1
    else return
    e.preventDefault()
    const next = shown[j]
    if (!next) return
    onSelect(next.id, e.shiftKey)
    requestAnimationFrame(() => {
      scrollRef.current?.querySelector<HTMLElement>(`[data-version="${CSS.escape(next.id)}"] .hist-card__select`)?.focus()
    })
  }

  const menuFor = (v: HistoryVersion): MenuItem[] => {
    const items: MenuItem[] = []
    if (canEdit) items.push({ label: 'Label this version…', icon: Tag, onSelect: () => actions.addLabel(v) })
    items.push(
      { label: 'Compare from this version', icon: ArrowRightLeft, onSelect: () => actions.compareFrom(v), description: 'Changes made after this version' },
      { label: 'Compare up to this version', icon: ArrowRightLeft, onSelect: () => actions.compareTo(v) },
      { type: 'separator' },
      { label: 'Download this version (.zip)', icon: Download, onSelect: () => actions.download(v) },
    )
    if (canEdit) {
      if (v.labels.length) {
        items.push({ type: 'separator' })
        for (const l of v.labels) items.push({ label: `Delete label “${l.name}”…`, icon: X, onSelect: () => actions.deleteLabel(l) })
      }
      items.push({ type: 'separator' }, { label: 'Restore project to this version…', icon: RotateCcw, onSelect: () => actions.restoreProject(v) })
    }
    return items
  }

  const openMenu = (e: MouseEvent<HTMLButtonElement>, v: HistoryVersion) => {
    e.stopPropagation()
    const r = e.currentTarget.getBoundingClientRect()
    showContextMenu({ preventDefault: () => e.preventDefault(), clientX: r.right - 220, clientY: r.bottom + 2, currentTarget: e.currentTarget }, menuFor(v))
  }

  let body
  if (state === 'loading') {
    body = (
      <div className="hist-list__skeleton" aria-busy="true" aria-label="Loading history">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="hist-skel">
            <span className="hist-skel__line hist-skel__line--short" />
            <span className="hist-skel__line" />
            <span className="hist-skel__line hist-skel__line--mid" />
          </div>
        ))}
      </div>
    )
  } else if (state === 'error') {
    body = (
      <EmptyState size="sm" icon={History} title="History could not be loaded" actions={<Button size="sm" onClick={onRetry}>Try again</Button>}>
        {error}
      </EmptyState>
    )
  } else if (shown.length === 0 && !hasMore) {
    body = filter === 'labels' ? (
      <EmptyState size="sm" icon={Tag} title="No labels yet">
        {canEdit ? 'Label important versions (for example “Submitted”) from a version’s menu.' : 'Nobody has labelled a version of this project yet.'}
      </EmptyState>
    ) : (
      <EmptyState size="sm" icon={History} title="No history yet">Versions are saved automatically as you edit.</EmptyState>
    )
  } else {
    body = (
      <div className="hist-list__groups" role="list" aria-label="Versions" onKeyDown={onKeyDown}>
        {groups.map(g => (
          <section key={g.key} className="hist-day" aria-label={g.label}>
            <h3 className="hist-day__label">{g.label}</h3>
            {g.items.map(v => {
              const i = index.get(v.id) ?? -1
              const isSingle = selection?.kind === 'single' && selection.id === v.id
              const inRange = selection?.kind === 'range' && i >= lo && i <= hi
              const isFrom = selection?.kind === 'range' && selection.fromId === v.id
              const isTo = selection?.kind === 'range' && selection.toId === v.id
              const selected = isSingle || isTo || isFrom
              const tabbable = v.id === focusId || (!shown.some(x => x.id === focusId) && v === shown[0])
              return (
                <VersionCard
                  key={v.id}
                  v={v}
                  current={v.id === newestId && filter === 'all'}
                  selected={selected}
                  inRange={!!inRange}
                  rangeEdge={isFrom ? 'from' : isTo ? 'to' : null}
                  tabbable={tabbable}
                  canEdit={canEdit}
                  meId={meId}
                  onSelect={extend => onSelect(v.id, extend)}
                  onMenu={e => openMenu(e, v)}
                  onDeleteLabel={actions.deleteLabel}
                  onContextMenu={e => showContextMenu(e, menuFor(v))}
                />
              )
            })}
          </section>
        ))}
      </div>
    )
  }

  return (
    <aside className="hist-list" aria-label="Project history and labels">
      <div className="hist-list__head">
        <Tabs
          variant="pill"
          label="Show"
          active={filter}
          onChange={id => onFilter(id as VersionFilter)}
          tabs={[
            { id: 'all', label: 'All history' },
            { id: 'labels', label: 'Labels' },
          ]}
        />
      </div>
      <div ref={scrollRef} className="hist-list__scroll">
        {body}
        {state === 'ready' && (hasMore || loadingMore) && (
          <div ref={sentinelRef} className="hist-list__more">
            {loadingMore ? <Spinner size={14} label="Loading older versions" /> : <Button size="sm" variant="ghost" onClick={onLoadMore}>Load older versions</Button>}
          </div>
        )}
        {state === 'ready' && !hasMore && shown.length > 0 && (
          <div className="hist-list__end">
            {filter === 'labels' ? `${shown.length} labelled ${shown.length === 1 ? 'version' : 'versions'}` : 'This is the first version of the project.'}
          </div>
        )}
      </div>
    </aside>
  )
}

function VersionCard({
  v, current, selected, inRange, rangeEdge, tabbable, canEdit, meId, onSelect, onMenu, onDeleteLabel, onContextMenu,
}: {
  v: HistoryVersion
  current: boolean
  selected: boolean
  inRange: boolean
  rangeEdge: 'from' | 'to' | null
  tabbable: boolean
  canEdit: boolean
  meId: string | null
  onSelect: (extend: boolean) => void
  onMenu: (e: MouseEvent<HTMLButtonElement>) => void
  onDeleteLabel: (l: Label) => void
  onContextMenu: (e: MouseEvent<HTMLDivElement>) => void
}) {
  const files = v.changes.slice(0, MAX_FILES_SHOWN)
  const more = v.changes.length - files.length
  const who = authorNames(v.authors, meId)
  const time = formatTime(v.createdAt)
  const what = versionSummary(v)
  const summary = `${time}, ${REASON_LABEL[v.reason]}${what ? `: ${what}` : ''}, by ${who}, ${v.changes.length} ${v.changes.length === 1 ? 'file' : 'files'} changed${v.labels.length ? `, labels: ${v.labels.map(l => l.name).join(', ')}` : ''}`
  return (
    <div
      role="listitem"
      data-version={v.id}
      className={clsx(
        'hist-card',
        selected && 'is-selected',
        inRange && 'is-in-range',
        rangeEdge && `is-range-${rangeEdge}`,
      )}
      onContextMenu={onContextMenu}
    >
      <button
        type="button"
        className="hist-card__select"
        aria-pressed={selected}
        aria-label={summary}
        tabIndex={tabbable ? 0 : -1}
        onClick={e => onSelect(e.shiftKey)}
      />
      <div className="hist-card__body">
        <div className="hist-card__top">
          <span className="hist-card__time">{time}</span>
          <span className={clsx('hist-chip', `hist-chip--${REASON_TONE[v.reason]}`)}>{REASON_LABEL[v.reason]}</span>
          {rangeEdge === 'from' && <span className="hist-chip hist-chip--range">Compare from</span>}
          {rangeEdge === 'to' && <span className="hist-chip hist-chip--range">Compare to</span>}
          <button
            type="button"
            className="hist-card__more"
            aria-label={`More actions for the version from ${time}`}
            tabIndex={selected ? 0 : -1}
            onClick={onMenu}
          >
            <Ellipsis size={16} aria-hidden="true" />
          </button>
        </div>
        {what && (
          <div className="hist-card__summary" title={what}>
            {what}
          </div>
        )}
        <div className="hist-card__authors">
          <span className="hist-card__avatars" aria-hidden="true">
            {v.authors.slice(0, 3).map(a => (
              <Avatar key={a.id} user={a} size={18} decorative />
            ))}
          </span>
          <span className="hist-card__names">
            {v.authors.length === 0 ? <span className="hist-card__system">Folio</span> : v.authors.map((a, i) => (
              <span key={a.id}>
                {i > 0 && (i === v.authors.length - 1 ? ' and ' : ', ')}
                <span className="hist-card__name" style={{ ['--hist-author' as string]: a.color }}>{a.id === meId ? 'You' : a.name}</span>
              </span>
            ))}
          </span>
        </div>
        {files.length > 0 && (
          <ul className="hist-card__files">
            {files.map(c => (
              <li key={`${c.op}:${c.path}`} className={clsx('hist-card__file', c.op === 'deleted' && 'is-deleted')}>
                <OpIcon op={c.op} size={13} />
                <span className="hist-card__path" title={c.oldPath ? `${c.oldPath} → ${c.path}` : c.path}>
                  {c.op === 'renamed' && c.oldPath ? <>{basename(c.oldPath)} → {basename(c.path)}</> : basename(c.path)}
                </span>
              </li>
            ))}
            {more > 0 && <li className="hist-card__morefiles">+{more} more {more === 1 ? 'file' : 'files'}</li>}
          </ul>
        )}
        {(current || v.labels.length > 0) && (
          <div className="hist-card__labels">
            {current && <span className="hist-label hist-label--current">Current state</span>}
            {v.labels.map(l => (
              <span key={l.id} className="hist-label" title={l.user ? `Added by ${l.user.name}` : undefined}>
                <Tag size={11} aria-hidden="true" />
                <span className="hist-label__name">{l.name}</span>
                {canEdit && (
                  <Tooltip content="Delete label" side="top">
                    <button
                      type="button"
                      className="hist-label__delete"
                      aria-label={`Delete label ${l.name}`}
                      tabIndex={selected ? 0 : -1}
                      onClick={e => {
                        e.stopPropagation()
                        onDeleteLabel(l)
                      }}
                    >
                      <X size={11} aria-hidden="true" />
                    </button>
                  </Tooltip>
                )}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
