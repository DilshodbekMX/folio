import { useMemo } from 'react'
import clsx from 'clsx'
import { Archive, FileText, FlaskConical, FolderOpen, Plus, Trash, Upload, User, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '../../stores/auth'
import { Button, DropdownMenu, type MenuItem } from '../../ui'
import { FILTER_LABELS, matchesFilter, useDashboard, type DashFilter } from './store'
import { ThemeToggle } from './ThemeToggle'

const NAV: { id: DashFilter; icon: LucideIcon }[] = [
  { id: 'all', icon: FolderOpen },
  { id: 'owned', icon: User },
  { id: 'shared', icon: Users },
  { id: 'archived', icon: Archive },
  { id: 'trashed', icon: Trash },
]

export function NewProjectButton({ onNew, onUpload, block = true }: { onNew: (t: 'blank' | 'example') => void; onUpload: () => void; block?: boolean }) {
  const items: MenuItem[] = [
    { label: 'Blank project', icon: FileText, description: 'An empty article with a title', onSelect: () => onNew('blank') },
    { label: 'Example project', icon: FlaskConical, description: 'Sections, maths, a figure and citations', onSelect: () => onNew('example') },
    { type: 'separator' },
    { type: 'header', label: 'Import' },
    { label: 'Upload a .zip', icon: Upload, description: 'An existing project archive', onSelect: onUpload },
  ]
  return (
    <DropdownMenu
      items={items}
      minWidth={250}
      trigger={
        <Button variant="primary" icon={Plus} block={block} className="dash-new">
          New project
        </Button>
      }
    />
  )
}

export function DashboardSidebar({ onNew, onUpload }: { onNew: (t: 'blank' | 'example') => void; onUpload: () => void }) {
  const projects = useDashboard(s => s.projects)
  const filter = useDashboard(s => s.filter)
  const setFilter = useDashboard(s => s.setFilter)
  const version = useAuth(s => s.setup?.version)

  const counts = useMemo(() => {
    const c = {} as Record<DashFilter, number>
    for (const n of NAV) c[n.id] = projects.filter(p => matchesFilter(p, n.id)).length
    return c
  }, [projects])

  return (
    <aside className="dash-side" aria-label="Project navigation">
      <NewProjectButton onNew={onNew} onUpload={onUpload} />
      <nav className="dash-nav">
        <ul>
          {NAV.map(n => {
            const Icon = n.icon
            const active = filter === n.id
            return (
              <li key={n.id}>
                <button
                  type="button"
                  className={clsx('dash-nav__item', active && 'is-active')}
                  aria-current={active ? 'page' : undefined}
                  onClick={() => setFilter(n.id)}
                >
                  <Icon size={16} aria-hidden="true" />
                  <span className="dash-nav__label">{FILTER_LABELS[n.id]}</span>
                  {counts[n.id] > 0 && <span className="dash-nav__count">{counts[n.id]}</span>}
                </button>
              </li>
            )
          })}
        </ul>
      </nav>
      <div className="dash-side__foot">
        <ThemeToggle />
        {version && <span className="dash-side__version">Folio {version}</span>}
      </div>
    </aside>
  )
}
