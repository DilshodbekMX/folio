import { useNavigate } from 'react-router'
import { Archive, ArchiveRestore, ChevronDown, Copy, Download, LogOut, Pencil, RotateCcw, Trash, X } from 'lucide-react'
import type { ProjectSummary } from '@folio/shared/api'
import { Button, DropdownMenu, IconButton } from '../../ui'
import {
  archiveProjects, copyProject, deleteOrLeaveProjects, downloadZips, renameProject, restoreProjects, trashProjects,
  unarchiveProjects,
} from './actions'
import { useDashboard, type DashFilter } from './store'

/** Actions for the selected projects; replaces the search row while a selection exists. */
export function BulkToolbar({ selection, filter, meId }: { selection: ProjectSummary[]; filter: DashFilter; meId: string }) {
  const navigate = useNavigate()
  const clear = useDashboard(s => s.clearSelection)
  const single = selection.length === 1 ? selection[0] : null
  const anyOwned = selection.some(p => p.role === 'owner')
  const anyShared = selection.some(p => p.role !== 'owner')

  return (
    <div className="dash-bulk" role="toolbar" aria-label="Selected projects">
      <IconButton icon={X} label="Clear selection" size="sm" onClick={clear} />
      <span className="dash-bulk__count" aria-live="polite">
        {selection.length} selected
      </span>
      <span className="dash-bulk__sep" aria-hidden="true" />
      {filter === 'trashed' ? (
        <>
          <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => void restoreProjects(selection)}>
            Restore
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon={anyOwned ? Trash : LogOut}
            className="dash-bulk__danger"
            onClick={() => void deleteOrLeaveProjects(selection, meId)}
          >
            {anyOwned && anyShared ? 'Delete / Leave' : anyOwned ? 'Delete forever' : 'Leave'}
          </Button>
        </>
      ) : (
        <>
          <Button size="sm" variant="ghost" icon={Download} onClick={() => downloadZips(selection)}>
            Download
          </Button>
          {filter === 'archived' ? (
            <Button size="sm" variant="ghost" icon={ArchiveRestore} onClick={() => void unarchiveProjects(selection)}>
              Unarchive
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon={Archive} onClick={() => void archiveProjects(selection)}>
              Archive
            </Button>
          )}
          <Button size="sm" variant="ghost" icon={Trash} onClick={() => void trashProjects(selection)}>
            Trash
          </Button>
          {single && (
            <DropdownMenu
              items={[
                { label: 'Rename…', icon: Pencil, hidden: single.role !== 'owner', onSelect: () => void renameProject(single) },
                { label: 'Make a copy…', icon: Copy, onSelect: () => void copyProject(single, navigate) },
              ]}
              trigger={
                <Button size="sm" variant="ghost" iconRight={ChevronDown}>
                  More
                </Button>
              }
            />
          )}
        </>
      )}
    </div>
  )
}
