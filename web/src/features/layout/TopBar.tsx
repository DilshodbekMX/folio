import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import clsx from 'clsx'
import { ChevronDown, Eye, History, Share2 } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { useCompile } from '../../stores/compile'
import { useEditor } from '../../stores/editor'
import { useLayout } from '../../stores/layout'
import { useProject } from '../../stores/project'
import { AvatarStack, Button, DropdownMenu, FolioMark, Tooltip, toast, type AvatarStackUser } from '../../ui'
import { LAYOUT_OPTIONS, MenuBar, layoutMenuItems } from './menus'
import { confirmLeaveProject } from './unsynced'

const MAX_NAME = 150

/** Project title; click to rename (owner/editor). */
function ProjectTitle() {
  const name = useProject(s => s.name)
  const canRename = useProject(s => s.role === 'owner' || s.role === 'editor')
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const cancelled = useRef(false)
  const committing = useRef(false)

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const start = () => {
    if (!canRename) return
    cancelled.current = false
    setDraft(name)
    setEditing(true)
  }

  const commit = async () => {
    // Enter disables the input while saving, which blurs it: never submit twice.
    if (cancelled.current || committing.current) return
    const v = draft.trim()
    if (!v || v === name) {
      setEditing(false)
      return
    }
    if (v.length > MAX_NAME) {
      toast(`Project names can be at most ${MAX_NAME} characters.`, { tone: 'error' })
      return
    }
    committing.current = true
    setSaving(true)
    try {
      await useProject.getState().rename(v)
      setEditing(false)
    } catch (e) {
      toast(`Couldn’t rename the project: ${errorMessage(e)}`, { tone: 'error' })
      window.setTimeout(() => inputRef.current?.focus(), 0)
    } finally {
      committing.current = false
      setSaving(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      void commit()
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      cancelled.current = true
      setEditing(false)
    }
  }

  if (editing) {
    return (
      <input
        ref={inputRef}
        className="lay-title__input"
        value={draft}
        disabled={saving}
        aria-label="Project name"
        maxLength={MAX_NAME + 20}
        size={Math.min(60, Math.max(12, draft.length + 1))}
        onChange={e => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => void commit()}
      />
    )
  }
  if (!canRename) {
    return (
      <h1 className="lay-title__heading" title={name}>
        <span className="lay-title__text lay-title__static">{name}</span>
      </h1>
    )
  }
  return (
    <h1 className="lay-title__heading">
      <Tooltip content="Rename project" side="bottom">
        <button type="button" className="lay-title__btn" onClick={start}>
          <span className="lay-title__text">{name}</span>
        </button>
      </Tooltip>
    </h1>
  )
}

/** True while the media query matches (re-renders on change). */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const on = () => setMatches(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return matches
}

/**
 * Other people in the project; clicking an avatar opens the file they are in. On narrow windows
 * one avatar plus a "+N" chip (the full list is in its menu).
 */
function Presence() {
  const presence = useProject(s => s.presence)
  const files = useProject(s => s.files)
  const narrow = useMediaQuery('(max-width: 860px)')
  const users = useMemo(() => {
    const seen = new Map<string, AvatarStackUser & { openFileId: string | null }>()
    for (const p of presence) {
      const existing = seen.get(p.user.id)
      // Prefer an entry that has a file open when the same person has several tabs.
      if (existing && (existing.openFileId || !p.openFileId)) continue
      const file = p.openFileId ? files[p.openFileId] : undefined
      seen.set(p.user.id, {
        id: p.user.id,
        name: p.user.name,
        color: p.user.color,
        openFileId: p.openFileId,
        detail: file ? file.path : 'No file open',
      })
    }
    return [...seen.values()]
  }, [presence, files])

  if (users.length === 0) return null
  return (
    <AvatarStack
      users={users}
      max={narrow ? 2 : 5}
      size={26}
      className="lay-presence"
      onSelect={u => {
        const entry = users.find(x => x.id === u.id)
        const fileId = entry?.openFileId
        if (fileId && useProject.getState().files[fileId]) useEditor.getState().openFile(fileId)
        else toast(`${u.name} doesn’t have a file open.`, { tone: 'info' })
      }}
    />
  )
}

/** Back to the dashboard; asks first while edits of this project cannot be sent. */
function HomeLink() {
  const navigate = useNavigate()
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    // let the browser handle new-tab/window clicks
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
    e.preventDefault()
    void confirmLeaveProject().then(ok => {
      if (ok) navigate('/')
    })
  }
  return (
    <Tooltip content="Back to your projects" side="bottom">
      <Link to="/" className="lay-home" aria-label="Back to your projects" onClick={onClick}>
        <FolioMark size={22} />
      </Link>
    </Tooltip>
  )
}

export function TopBar() {
  const role = useProject(s => s.role)
  const historyOpen = useLayout(s => s.historyOpen)
  const setHistoryOpen = useLayout(s => s.setHistoryOpen)
  const openModal = useLayout(s => s.openModal)
  const view = useLayout(s => s.view)
  const setView = useLayout(s => s.setView)
  const pdfUrl = useCompile(s => s.lastWithPdf?.pdfUrl ?? null)
  const focusMode = useLayout(s => s.focusMode)
  const CurrentLayoutIcon = LAYOUT_OPTIONS.find(o => o.id === view)?.icon ?? LAYOUT_OPTIONS[0].icon

  return (
    <header className="lay-topbar">
      <div className="lay-topbar__left">
        <HomeLink />
        <MenuBar />
      </div>
      <div className="lay-topbar__center">
        <div className="lay-title">
          <ProjectTitle />
          {role === 'viewer' && (
            <Tooltip content="You can read this project, view and download its PDF and follow its history, but not change it." side="bottom">
              <span className="lay-badge" tabIndex={0}>
                <Eye size={13} aria-hidden="true" />
                View only
              </span>
            </Tooltip>
          )}
        </div>
      </div>
      <div className="lay-topbar__right">
        <Presence />
        <Button
          size="sm"
          variant="ghost"
          icon={History}
          className={clsx('lay-topbtn', historyOpen && 'is-active')}
          aria-pressed={historyOpen}
          aria-label="History"
          onClick={() => setHistoryOpen(!historyOpen)}
        >
          <span className="lay-topbtn__label">History</span>
        </Button>
        <Button size="sm" variant="ghost" icon={Share2} className="lay-topbtn" aria-label="Share" onClick={() => openModal('share')}>
          <span className="lay-topbtn__label">Share</span>
        </Button>
        <DropdownMenu
          align="end"
          items={layoutMenuItems(view, setView, pdfUrl, focusMode)}
          trigger={
            <Button size="sm" variant="ghost" icon={CurrentLayoutIcon} iconRight={ChevronDown} className="lay-topbtn" aria-label="Layout options">
              <span className="lay-topbtn__label">Layout</span>
            </Button>
          }
        />
      </div>
    </header>
  )
}
