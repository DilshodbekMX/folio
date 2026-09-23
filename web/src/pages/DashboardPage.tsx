import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useShallow } from 'zustand/react/shallow'
import { FilePlus, RefreshCw, Search, SearchX, Upload, X } from 'lucide-react'
import { useAuth } from '../stores/auth'
import { Button, EmptyState, FolioLogo, IconButton, Select, TextField } from '../ui'
import { pluralize } from '../lib/format'
import { createProject } from '../features/dashboard/actions'
import { BulkToolbar } from '../features/dashboard/BulkToolbar'
import { DashboardSidebar, NewProjectButton } from '../features/dashboard/DashboardSidebar'
import { ProjectTable } from '../features/dashboard/ProjectTable'
import { UploadProjectModal } from '../features/dashboard/UploadProjectModal'
import { UserMenu } from '../features/dashboard/UserMenu'
import {
  FILTER_LABELS, SEARCH_PLACEHOLDERS, useDashboard, visibleProjects, type DashFilter,
} from '../features/dashboard/store'
import '../features/dashboard/dashboard.css'
import { useDocumentTitle } from './nav'
import { prefetchProjectPage } from './lazy'

const EMPTY_COPY: Record<DashFilter, { title: string; body: string }> = {
  all: { title: 'No projects yet', body: 'Create your first project, or import an existing one from a .zip archive.' },
  owned: { title: 'You haven’t created any projects', body: 'Projects you create or import appear here.' },
  shared: { title: 'Nothing shared with you yet', body: 'When someone adds you to a project, or you join one with a share link, it appears here.' },
  archived: { title: 'No archived projects', body: 'Archive projects you’re done with to keep your list tidy. Archiving only affects your own list.' },
  trashed: { title: 'The trash is empty', body: 'Trashed projects stay here until you restore them or delete them for good.' },
}

export function DashboardPage() {
  useDocumentTitle('Your projects')
  const navigate = useNavigate()
  const meId = useAuth(s => s.me?.id ?? '')
  const { projects, loadState, error, filter, query, sort, selected } = useDashboard(
    useShallow(s => ({ projects: s.projects, loadState: s.loadState, error: s.error, filter: s.filter, query: s.query, sort: s.sort, selected: s.selected })),
  )
  const { setQuery, setFilter } = useDashboard(useShallow(s => ({ setQuery: s.setQuery, setFilter: s.setFilter })))
  const [uploadOpen, setUploadOpen] = useState(false)

  useEffect(() => {
    useDashboard.getState().load().catch(() => {})
    // Pick up collaborators' changes when the tab becomes visible again.
    const onVisible = () => {
      if (document.visibilityState === 'visible') useDashboard.getState().load({ quiet: true }).catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // the editor's code, fetched while the list is looked at: opening a project does not wait for it
  useEffect(() => prefetchProjectPage(), [])

  const rows = useMemo(() => visibleProjects(projects, filter, query, sort, meId), [projects, filter, query, sort, meId])
  const selection = useMemo(() => rows.filter(r => selected.has(r.id)), [rows, selected])
  const inFilter = useMemo(() => visibleProjects(projects, filter, '', sort, meId).length, [projects, filter, sort, meId])

  const onNew = (t: 'blank' | 'example') => void createProject(t, navigate)
  const onUpload = () => setUploadOpen(true)

  let body
  if (loadState === 'loading' || loadState === 'idle') {
    body = <TableSkeleton />
  } else if (loadState === 'error') {
    body = (
      <EmptyState
        icon={RefreshCw}
        title="Couldn’t load your projects"
        actions={<Button variant="secondary" icon={RefreshCw} onClick={() => useDashboard.getState().load().catch(() => {})}>Try again</Button>}
      >
        {error}
      </EmptyState>
    )
  } else if (rows.length === 0 && query.trim() && inFilter > 0) {
    body = (
      <EmptyState icon={SearchX} title={`No projects match “${query.trim()}”`} actions={<Button variant="secondary" onClick={() => setQuery('')}>Clear search</Button>}>
        Try a different search, or look in another list.
      </EmptyState>
    )
  } else if (rows.length === 0) {
    const copy = EMPTY_COPY[filter]
    body = (
      <EmptyState
        icon={filter === 'all' || filter === 'owned' ? FilePlus : undefined}
        title={copy.title}
        actions={
          filter === 'all' || filter === 'owned' ? (
            <>
              <NewProjectButton onNew={onNew} onUpload={onUpload} block={false} />
              <Button variant="secondary" icon={Upload} onClick={onUpload}>
                Upload a .zip
              </Button>
            </>
          ) : undefined
        }
      >
        {copy.body}
      </EmptyState>
    )
  } else {
    body = (
      <div className="dash-tablewrap">
        <ProjectTable rows={rows} meId={meId} />
      </div>
    )
  }

  return (
    <div className="dash">
      <header className="dash-header">
        <Link to="/" className="dash-brand" aria-label="Folio — your projects">
          <FolioLogo size={22} />
        </Link>
        <div className="dash-header__right">
          <UserMenu />
        </div>
      </header>
      <div className="dash-body">
        <DashboardSidebar onNew={onNew} onUpload={onUpload} />
        <main className="dash-main" id="main">
          <div className="dash-main__inner">
            <div className="dash-mobilebar">
              <Select
                aria-label="Show"
                value={filter}
                onChange={e => setFilter(e.target.value as DashFilter)}
                options={(Object.keys(FILTER_LABELS) as DashFilter[]).map(f => ({ value: f, label: FILTER_LABELS[f] }))}
              />
              <NewProjectButton onNew={onNew} onUpload={onUpload} block={false} />
            </div>
            <div className="dash-titlebar">
              <h1 className="dash-title">{FILTER_LABELS[filter]}</h1>
              <TextField
                wrapperClassName="dash-search"
                icon={Search}
                placeholder={SEARCH_PLACEHOLDERS[filter]}
                aria-label={SEARCH_PLACEHOLDERS[filter].replace('…', '')}
                value={query}
                onChange={e => setQuery(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape' && query) {
                    e.preventDefault()
                    setQuery('')
                  }
                }}
                trailing={query ? <IconButton icon={X} label="Clear search" size="sm" tooltip={false} onClick={() => setQuery('')} /> : undefined}
              />
            </div>
            <div className="dash-toolbar">
              {selection.length > 0 ? (
                <BulkToolbar selection={selection} filter={filter} meId={meId} />
              ) : (
                loadState === 'ready' && rows.length > 0 && (
                  <p className="dash-count" aria-live="polite">
                    {query.trim() ? `Showing ${rows.length} of ${pluralize(inFilter, 'project')}` : pluralize(rows.length, 'project')}
                  </p>
                )
              )}
            </div>
            {body}
          </div>
        </main>
      </div>
      <UploadProjectModal
        open={uploadOpen}
        onClose={() => {
          setUploadOpen(false)
          // the import may have finished (closed from its report instead of opening the project)
          useDashboard.getState().load({ quiet: true }).catch(() => {})
        }}
        onUploaded={id => {
          setUploadOpen(false)
          navigate(`/project/${id}`)
        }}
      />
    </div>
  )
}

function TableSkeleton() {
  return (
    <div className="dash-skeleton" aria-busy="true" aria-label="Loading projects">
      {[68, 52, 74, 45, 60].map((w, i) => (
        <div key={i} className="dash-skeleton__row">
          <span className="dash-skeleton__box" />
          <span className="dash-skeleton__bar" style={{ width: `${w}%` }} />
          <span className="dash-skeleton__bar dash-skeleton__bar--short" />
        </div>
      ))}
    </div>
  )
}
