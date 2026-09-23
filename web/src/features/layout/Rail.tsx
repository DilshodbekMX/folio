import { useEffect, useState } from 'react'
import { BookOpen, CircleHelp, CloudOff, Eye, Files, Info, Keyboard, MessageSquare, Search, Settings } from 'lucide-react'
import { openInNewTab } from '../../lib/download'
import { useLayout, type RailPanel } from '../../stores/layout'
import { useProject } from '../../stores/project'
import { DropdownMenu, IconButton, Spinner, Tooltip, type MenuItem } from '../../ui'
import { HELP_URL, useChrome } from './uiState'

const TABS: { id: RailPanel; label: string; icon: typeof Files }[] = [
  { id: 'files', label: 'File tree', icon: Files },
  { id: 'search', label: 'Project search', icon: Search },
  { id: 'chat', label: 'Chat', icon: MessageSquare },
]

/** Connection indicator: nothing while connected, a spinner/cloud icon otherwise. */
function ConnectionIndicator() {
  const connection = useProject(s => s.connection)
  // Don't flash "connecting" during a normal page load.
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (connection !== 'connecting') {
      setSlow(false)
      return
    }
    const t = window.setTimeout(() => setSlow(true), 3000)
    return () => window.clearTimeout(t)
  }, [connection])

  if (connection === 'connected' || (connection === 'connecting' && !slow)) return null
  const text = connection === 'disconnected'
    ? 'Connection lost. Reconnecting… Changes you make are kept in this tab and sent when the connection is back.'
    : 'Connecting to the project…'
  return (
    <Tooltip content={text} side="right">
      <span className="lay-rail__status is-warning" tabIndex={0} role="status" aria-label={text}>
        {connection === 'disconnected' ? <CloudOff size={16} aria-hidden="true" /> : <Spinner size={14} label={null} />}
      </span>
    </Tooltip>
  )
}

export function Rail() {
  const railPanel = useLayout(s => s.railPanel)
  const toggleRailPanel = useLayout(s => s.toggleRailPanel)
  const openModal = useLayout(s => s.openModal)
  const unread = useLayout(s => s.unreadChat)
  const viewer = useProject(s => s.role === 'viewer')
  const setAboutOpen = useChrome(s => s.setAboutOpen)

  const help: MenuItem[] = [
    { label: 'Keyboard shortcuts', icon: Keyboard, onSelect: () => openModal('shortcuts') },
    { label: 'Documentation', icon: BookOpen, onSelect: () => openInNewTab(HELP_URL) },
    { type: 'separator' },
    { label: 'About Folio', icon: Info, onSelect: () => setAboutOpen(true) },
  ]

  return (
    <nav className="lay-rail" aria-label="Side panels">
      <div className="lay-rail__group">
        {TABS.map(t => (
          <IconButton
            key={t.id}
            icon={t.icon}
            label={t.label}
            tooltip={railPanel === t.id ? `Hide ${t.label.toLowerCase()}` : t.label}
            size="lg"
            tooltipSide="right"
            active={railPanel === t.id}
            className="lay-rail__btn"
            badge={t.id === 'chat' && railPanel !== 'chat' ? unread : null}
            badgeTone="danger"
            onClick={() => toggleRailPanel(t.id)}
          />
        ))}
      </div>
      <div className="lay-rail__group lay-rail__group--bottom">
        <ConnectionIndicator />
        {viewer && (
          <Tooltip content="View only: you can’t edit this project" side="right">
            <span className="lay-rail__status" tabIndex={0} aria-label="View only">
              <Eye size={16} aria-hidden="true" />
            </span>
          </Tooltip>
        )}
        <DropdownMenu
          side="right"
          items={help}
          trigger={<IconButton icon={CircleHelp} label="Help" size="lg" tooltipSide="right" className="lay-rail__btn" />}
        />
        <IconButton icon={Settings} label="Settings" size="lg" tooltipSide="right" className="lay-rail__btn" onClick={() => openModal('settings')} />
      </div>
    </nav>
  )
}
