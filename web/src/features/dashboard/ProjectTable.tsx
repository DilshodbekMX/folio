import { useEffect, useState, type MouseEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import clsx from 'clsx'
import {
  Archive, ArchiveRestore, ArrowDown, ArrowUp, Copy, Download, Ellipsis, ExternalLink, FileDown, LogOut, Pencil,
  RotateCcw, Trash,
} from 'lucide-react'
import type { ProjectSummary } from '@folio/shared/api'
import { formatDateTime, formatRelative } from '../../lib/time'
import { Avatar, Checkbox, DropdownMenu, IconButton, Spinner, showContextMenu, type MenuItem } from '../../ui'
import {
  archiveProjects, copyProject, deleteOrLeaveProjects, downloadPdf, downloadZips, renameProject, restoreProjects,
  trashProjects, unarchiveProjects, usePdfDownloads,
} from './actions'
import { useDashboard, type SortKey } from './store'

/** Re-render every `ms` so relative times stay fresh. */
function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), ms)
    return () => window.clearInterval(t)
  }, [ms])
  return now
}

/** Menu items for one project (row "more" menu and right-click menu). */
export function projectMenuItems(p: ProjectSummary, meId: string, navigate: (to: string) => void, withOpen: boolean): MenuItem[] {
  const owner = p.role === 'owner'
  const items: MenuItem[] = [
    { label: 'Open', icon: ExternalLink, hidden: !withOpen, onSelect: () => navigate(`/project/${p.id}`) },
    { type: 'separator', hidden: !withOpen },
    { label: 'Rename…', icon: Pencil, hidden: !owner || p.trashed, onSelect: () => void renameProject(p) },
    { label: 'Make a copy…', icon: Copy, hidden: p.trashed, onSelect: () => void copyProject(p, navigate) },
    { label: 'Download source (.zip)', icon: Download, onSelect: () => downloadZips([p]) },
    { label: 'Download PDF', icon: FileDown, onSelect: () => void downloadPdf(p, navigate) },
    { type: 'separator' },
    { label: 'Archive', icon: Archive, hidden: p.archived || p.trashed, onSelect: () => void archiveProjects([p]) },
    { label: 'Unarchive', icon: ArchiveRestore, hidden: !p.archived || p.trashed, onSelect: () => void unarchiveProjects([p]) },
    { label: 'Move to trash', icon: Trash, hidden: p.trashed, onSelect: () => void trashProjects([p]) },
    { label: 'Restore', icon: RotateCcw, hidden: !p.trashed, onSelect: () => void restoreProjects([p]) },
    { label: 'Delete forever…', icon: Trash, danger: true, hidden: !p.trashed || !owner, onSelect: () => void deleteOrLeaveProjects([p], meId) },
    { label: 'Leave project…', icon: LogOut, danger: true, hidden: !p.trashed || owner, onSelect: () => void deleteOrLeaveProjects([p], meId) },
  ]
  return items
}

function SortHeader({ label, k, className }: { label: string; k: SortKey; className?: string }) {
  const sort = useDashboard(s => s.sort)
  const toggleSort = useDashboard(s => s.toggleSort)
  const active = sort.key === k
  return (
    <th scope="col" className={className} aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button type="button" className={clsx('dash-sort', active && 'is-active')} onClick={() => toggleSort(k)}>
        {label}
        <span className="dash-sort__icon" aria-hidden="true">
          {active ? sort.dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} /> : <ArrowDown size={12} />}
        </span>
      </button>
    </th>
  )
}

export function ProjectTable({ rows, meId }: { rows: ProjectSummary[]; meId: string }) {
  const navigate = useNavigate()
  const filter = useDashboard(s => s.filter)
  const selected = useDashboard(s => s.selected)
  const setSelected = useDashboard(s => s.setSelected)
  const toggleSelected = useDashboard(s => s.toggleSelected)
  const pdfBusy = usePdfDownloads(s => s.busy)
  const now = useNow(60_000)

  const selectedVisible = rows.filter(r => selected.has(r.id)).length
  const allChecked = rows.length > 0 && selectedVisible === rows.length
  const someChecked = selectedVisible > 0 && !allChecked

  const who = (u: { id: string; name: string } | null) => (u ? (u.id === meId ? 'You' : u.name) : null)

  const onRowContext = (e: MouseEvent, p: ProjectSummary) => {
    showContextMenu(e, projectMenuItems(p, meId, navigate, true))
  }

  return (
    <table className="dash-table">
      <colgroup>
        <col className="dash-col-check" />
        <col className="dash-col-title" />
        <col className="dash-col-owner" />
        <col className="dash-col-date" />
        <col className="dash-col-actions" />
      </colgroup>
      <thead>
        <tr>
          <th scope="col" className="dash-cell-check">
            <Checkbox
              checked={allChecked}
              indeterminate={someChecked}
              aria-label={allChecked ? 'Deselect all projects' : 'Select all projects'}
              onChange={on => setSelected(on ? rows.map(r => r.id) : [])}
            />
          </th>
          <SortHeader label="Title" k="name" />
          <SortHeader label="Owner" k="owner" className="dash-cell-owner" />
          <SortHeader label="Last modified" k="updatedAt" className="dash-cell-date" />
          <th scope="col" className="dash-cell-actions">
            <span className="visually-hidden">Actions</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map(p => {
          const isSel = selected.has(p.id)
          const editor = who(p.lastUpdatedBy)
          const owner = p.role === 'owner'
          return (
            <tr key={p.id} className={clsx('dash-row', isSel && 'is-selected')} onContextMenu={e => onRowContext(e, p)}>
              <td className="dash-cell-check">
                <Checkbox checked={isSel} aria-label={`Select ${p.name}`} onChange={on => toggleSelected(p.id, on)} />
              </td>
              <td className="dash-cell-title">
                <Link to={`/project/${p.id}`} className="dash-row__title" title={p.name}>
                  {p.name}
                </Link>
              </td>
              <td className="dash-cell-owner">
                <span className="dash-owner">
                  <Avatar user={p.owner} size={18} decorative />
                  <span className="dash-owner__name">{owner ? 'You' : p.owner.name}</span>
                </span>
              </td>
              <td className="dash-cell-date" title={formatDateTime(p.updatedAt)}>
                <span className="dash-date">{formatRelative(p.updatedAt, now)}</span>
                {editor && <span className="dash-date__by"> by {editor}</span>}
              </td>
              <td className="dash-cell-actions">
                <div className="dash-actions">
                  {filter === 'trashed' ? (
                    <>
                      <IconButton icon={RotateCcw} label="Restore" size="sm" onClick={() => void restoreProjects([p])} />
                      {owner ? (
                        <IconButton icon={Trash} label="Delete forever" size="sm" variant="danger" onClick={() => void deleteOrLeaveProjects([p], meId)} />
                      ) : (
                        <IconButton icon={LogOut} label="Leave project" size="sm" variant="danger" onClick={() => void deleteOrLeaveProjects([p], meId)} />
                      )}
                    </>
                  ) : (
                    <>
                      <IconButton icon={Copy} label="Make a copy" size="sm" onClick={() => void copyProject(p, navigate)} />
                      <IconButton icon={Download} label="Download .zip" size="sm" onClick={() => downloadZips([p])} />
                      <IconButton
                        icon={pdfBusy.has(p.id) ? <Spinner size={12} label={null} /> : FileDown}
                        label="Download PDF"
                        size="sm"
                        aria-busy={pdfBusy.has(p.id) || undefined}
                        onClick={() => void downloadPdf(p, navigate)}
                      />
                      {p.archived ? (
                        <IconButton icon={ArchiveRestore} label="Unarchive" size="sm" onClick={() => void unarchiveProjects([p])} />
                      ) : (
                        <IconButton icon={Archive} label="Archive" size="sm" onClick={() => void archiveProjects([p])} />
                      )}
                      <IconButton icon={Trash} label="Move to trash" size="sm" onClick={() => void trashProjects([p])} />
                    </>
                  )}
                  <DropdownMenu
                    align="end"
                    items={projectMenuItems(p, meId, navigate, false)}
                    trigger={<IconButton icon={Ellipsis} label="More actions" size="sm" />}
                  />
                </div>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
