/**
 * Share modal (SPEC §6.7 / §6.8, Overleaf-style).
 *
 *  - Owner: add people by email (comma-separated list) with a role, change a member's role or
 *    remove them (role menu per row), link sharing (edit link + view-only link, copy, regenerate,
 *    turn on/off).
 *  - Editors / viewers: read-only member list, "Leave project" on their own row.
 *
 * Members come from useProject.members, which realtime/meta.ts refreshes on every
 * 'members:changed' event, so the list updates live while the modal is open; the modal also
 * re-fetches the share info when it opens and after its own changes. Links are owner-only
 * data and are fetched here.
 *
 * Deviation (documented): no email is sent — people must already have a Folio account on this
 * server (there is no SMTP in v1); for everyone else the owner copies a share link.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react'
import { useNavigate } from 'react-router'
import clsx from 'clsx'
import { Check, ChevronDown, Copy, Eye, Info, Link2, LogOut, PencilLine, RefreshCw, UserMinus, UserPlus } from 'lucide-react'
import type { Member, Role, ShareLinks } from '@folio/shared/api'
import { api } from '../../api/endpoints'
import { errorMessage, isApiError } from '../../api/client'
import { useAuth } from '../../stores/auth'
import { useProject } from '../../stores/project'
import {
  Avatar, Button, DropdownMenu, IconButton, Modal, Select, Spinner, Switch, TextField, confirmDialog, toast,
  type MenuItem,
} from '../../ui'
import { copyText } from './clipboard'
import './share.css'

type MemberRole = 'editor' | 'viewer'

/** Error shown when an invited email has no account on this server. */
export const NO_ACCOUNT_MESSAGE = 'No Folio account with this email — ask an admin to create one'

const ROLE_LABEL: Record<Role, string> = { owner: 'Owner', editor: 'Can edit', viewer: 'Can view' }
const ROLE_VERB: Record<MemberRole, string> = { editor: 'edit', viewer: 'view' }
const ROLE_OPTIONS = [
  { value: 'editor', label: 'Can edit' },
  { value: 'viewer', label: 'Can view' },
]
const EMAIL_RE = /^[^\s@,;]+@[^\s@,;]+$/

/** Full join URL for a share token. */
export function joinUrl(token: string): string {
  return `${window.location.origin}/join/${token}`
}

function sortMembers(members: readonly Member[], owner: Member['user'] | null): Member[] {
  const list = [...members]
  if (owner && !list.some(m => m.user.id === owner.id)) list.push({ user: owner, role: 'owner', addedAt: 0 })
  return list.sort((a, b) => {
    if (a.role === 'owner' && b.role !== 'owner') return -1
    if (b.role === 'owner' && a.role !== 'owner') return 1
    return a.addedAt - b.addedAt || a.user.name.localeCompare(b.user.name)
  })
}

export function ShareModal({ onClose }: { onClose: () => void }) {
  const projectId = useProject(s => s.projectId)
  const projectName = useProject(s => s.name)
  const role = useProject(s => s.role)
  const owner = useProject(s => s.owner)
  const storeMembers = useProject(s => s.members)
  const presence = useProject(s => s.presence)
  const me = useAuth(s => s.me)
  const navigate = useNavigate()
  const isOwner = role === 'owner'

  const [links, setLinks] = useState<ShareLinks | null>(null)
  const [linksState, setLinksState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [linksError, setLinksError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Record<string, boolean>>({})

  const members = useMemo(() => sortMembers(storeMembers, owner), [storeMembers, owner])
  const online = useMemo(() => new Set(presence.map(p => p.user.id)), [presence])

  /** Re-fetch members (into the project store) and, for the owner, the share links. */
  const refresh = useCallback(async () => {
    if (!projectId) return
    try {
      const info = await api.shareInfo(projectId)
      if (useProject.getState().projectId !== projectId) return
      useProject.setState({ members: info.members })
      setLinks(info.links)
      setLinksState('ready')
      setLinksError(null)
    } catch (e) {
      if (useProject.getState().projectId !== projectId) return
      setLinksState('error')
      setLinksError(errorMessage(e, 'Couldn’t load the sharing settings.'))
    }
  }, [projectId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const setMemberBusy = (id: string, on: boolean) => setBusy(b => ({ ...b, [id]: on }))

  const changeRole = async (m: Member, next: MemberRole) => {
    if (!projectId || m.role === next) return
    setMemberBusy(m.user.id, true)
    try {
      await api.updateMember(projectId, m.user.id, { role: next })
      await refresh()
      toast(`${m.user.name} can now ${ROLE_VERB[next]} this project.`, { tone: 'success' })
    } catch (e) {
      toast(`Couldn’t change ${m.user.name}’s access: ${errorMessage(e)}`, { tone: 'error' })
    } finally {
      setMemberBusy(m.user.id, false)
    }
  }

  const removeMember = async (m: Member) => {
    if (!projectId) return
    const ok = await confirmDialog({
      title: `Remove ${m.user.name}?`,
      message: `${m.user.name} (${m.user.email}) loses access to “${projectName}” right away. You can add them again later.`,
      confirmLabel: 'Remove access',
      danger: true,
    })
    if (!ok) return
    setMemberBusy(m.user.id, true)
    try {
      await api.removeMember(projectId, m.user.id)
      await refresh()
      toast(`${m.user.name} no longer has access.`, { tone: 'success' })
    } catch (e) {
      toast(`Couldn’t remove ${m.user.name}: ${errorMessage(e)}`, { tone: 'error' })
    } finally {
      setMemberBusy(m.user.id, false)
    }
  }

  const leave = async () => {
    if (!projectId || !me) return
    const ok = await confirmDialog({
      title: 'Leave this project?',
      message: `You’ll lose access to “${projectName}”. To get back in, the owner has to add you again or send you a share link.`,
      confirmLabel: 'Leave project',
      danger: true,
    })
    if (!ok) return
    setMemberBusy(me.id, true)
    try {
      await api.removeMember(projectId, me.id)
      onClose()
      navigate('/', { replace: true })
      toast(`You left “${projectName}”.`, { tone: 'success' })
    } catch (e) {
      setMemberBusy(me.id, false)
      toast(`Couldn’t leave the project: ${errorMessage(e)}`, { tone: 'error' })
    }
  }

  const ownerName = members.find(m => m.role === 'owner')?.user.name ?? owner?.name ?? 'the owner'

  return (
    <Modal
      open
      onClose={onClose}
      title="Share project"
      description={projectName || undefined}
      size="md"
      className="share-modal"
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      {isOwner && projectId && <InviteForm projectId={projectId} members={members} meId={me?.id ?? null} onChanged={refresh} />}

      <section className="share-section" aria-labelledby="share-people-title">
        <h3 id="share-people-title" className="share-heading">
          People with access
          <span className="share-heading__count">{members.length}</span>
        </h3>
        <ul className="share-members" aria-labelledby="share-people-title">
          {members.map(m => {
            const isMe = m.user.id === me?.id
            return (
              <li key={m.user.id} className="share-member" data-user-email={m.user.email}>
                <span className="share-member__avatar">
                  <Avatar user={m.user} size={32} decorative />
                  {(isMe || online.has(m.user.id)) && (
                    <span className="share-member__online" title={isMe ? 'You' : 'Online now'} aria-hidden="true" />
                  )}
                </span>
                <span className="share-member__who">
                  <span className="share-member__name">
                    {m.user.name}
                    {isMe && <span className="share-member__you">(you)</span>}
                  </span>
                  <span className="share-member__email">{m.user.email}</span>
                </span>
                <span className="share-member__role">
                  {busy[m.user.id] && <Spinner size={14} label="Updating" />}
                  <MemberRoleControl
                    member={m}
                    canManage={isOwner && m.role !== 'owner'}
                    canLeave={isMe && !isOwner && m.role !== 'owner'}
                    disabled={!!busy[m.user.id]}
                    onRole={r => void changeRole(m, r)}
                    onRemove={() => void removeMember(m)}
                    onLeave={() => void leave()}
                  />
                </span>
              </li>
            )
          })}
        </ul>
        {!isOwner && (
          <p className="share-note">
            <Info size={14} aria-hidden="true" />
            <span>
              Only the owner, {ownerName}, can add people, change access or share links.
              {role === 'viewer' && ' You can view this project.'}
              {role === 'editor' && ' You can edit this project.'}
            </span>
          </p>
        )}
      </section>

      {isOwner && projectId && (
        <LinkSharing
          projectId={projectId}
          links={links}
          state={linksState}
          error={linksError}
          onLinks={setLinks}
          onRetry={() => {
            setLinksState('loading')
            void refresh()
          }}
        />
      )}
    </Modal>
  )
}

// ---------------------------------------------------------------------------------------------
// Invite form (owner)
// ---------------------------------------------------------------------------------------------

interface Failure { email: string; message: string }

function InviteForm({ projectId, members, meId, onChanged }: {
  projectId: string
  members: Member[]
  meId: string | null
  onChanged: () => Promise<void>
}) {
  const [value, setValue] = useState('')
  const [role, setRole] = useState<MemberRole>('editor')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<ReactNode>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (sending) return
    const emails = [...new Map(value.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean).map(s => [s.toLowerCase(), s])).values()]
    if (emails.length === 0) {
      setError('Enter the email address of the person you want to add.')
      return
    }
    const invalid = emails.filter(x => !EMAIL_RE.test(x))
    if (invalid.length > 0) {
      setError(invalid.length === 1 ? `“${invalid[0]}” isn’t a valid email address.` : `These aren’t valid email addresses: ${invalid.join(', ')}`)
      return
    }
    setSending(true)
    setError(null)
    const failures: Failure[] = []
    const done: string[] = []
    const unchanged: string[] = []
    for (const email of emails) {
      const existing = members.find(m => m.user.email.toLowerCase() === email.toLowerCase())
      if (existing?.role === 'owner') {
        failures.push({ email, message: existing.user.id === meId ? 'You already own this project.' : `${existing.user.name} owns this project.` })
        continue
      }
      if (existing && existing.role === role) {
        unchanged.push(`${existing.user.name} can already ${ROLE_VERB[role]} this project.`)
        continue
      }
      try {
        const m = await api.addMember(projectId, { email, role })
        done.push(existing ? `${m.user.name} can now ${ROLE_VERB[role]} this project (was: ${ROLE_LABEL[existing.role].toLowerCase()}).` : `${m.user.name} can now ${ROLE_VERB[role]} this project.`)
      } catch (err) {
        failures.push({ email, message: isApiError(err, 404) ? NO_ACCOUNT_MESSAGE : errorMessage(err, 'Couldn’t add this person.') })
      }
    }
    if (done.length > 0) await onChanged()
    setSending(false)
    setValue(failures.map(f => f.email).join(', '))
    if (failures.length === 1) {
      setError(emails.length === 1 ? failures[0].message : `${failures[0].email}: ${failures[0].message}`)
    } else if (failures.length > 1) {
      setError(
        <ul className="share-invite__errors">
          {failures.map(f => (
            <li key={f.email}>
              <strong>{f.email}</strong>: {f.message}
            </li>
          ))}
        </ul>,
      )
    }
    if (done.length === 1) toast(done[0], { tone: 'success' })
    else if (done.length > 1) toast(`Added ${done.length} people.`, { tone: 'success' })
    for (const note of unchanged) toast(note, { tone: 'info' })
  }

  return (
    <form className="share-section share-invite" onSubmit={submit} noValidate aria-labelledby="share-invite-title">
      <h3 id="share-invite-title" className="share-heading">Add people</h3>
      <div className="share-invite__row">
        <TextField
          type="email"
          value={value}
          invalid={!!error}
          icon={UserPlus}
          placeholder="Email addresses, separated by commas"
          aria-label="Email addresses"
          aria-describedby="share-invite-hint"
          autoComplete="off"
          spellCheck={false}
          wrapperClassName="share-invite__email"
          onChange={e => {
            setValue(e.target.value)
            if (error) setError(null)
          }}
          data-autofocus
        />
        <Select
          aria-label="Access for the people you add"
          value={role}
          options={ROLE_OPTIONS}
          wrapperClassName="share-invite__role"
          onChange={e => setRole(e.target.value as MemberRole)}
        />
        <Button type="submit" variant="primary" loading={sending} disabled={!value.trim()}>
          Invite
        </Button>
      </div>
      {error ? (
        <div className="share-invite__error" role="alert">
          {error}
        </div>
      ) : (
        <p id="share-invite-hint" className="share-hint">
          People need an account on this Folio server. They see the project in their list right away.
        </p>
      )}
    </form>
  )
}

// ---------------------------------------------------------------------------------------------
// Member role control
// ---------------------------------------------------------------------------------------------

function MemberRoleControl({ member, canManage, canLeave, disabled, onRole, onRemove, onLeave }: {
  member: Member
  canManage: boolean
  canLeave: boolean
  disabled: boolean
  onRole: (r: MemberRole) => void
  onRemove: () => void
  onLeave: () => void
}) {
  if (canManage) {
    const items: MenuItem[] = [
      { type: 'radio', label: 'Can edit', description: 'Edit files, compile, chat', checked: member.role === 'editor', onSelect: () => onRole('editor') },
      { type: 'radio', label: 'Can view', description: 'Read, download and chat', checked: member.role === 'viewer', onSelect: () => onRole('viewer') },
      { type: 'separator' },
      { label: 'Remove access', icon: UserMinus, danger: true, onSelect: onRemove },
    ]
    return (
      <DropdownMenu
        align="end"
        items={items}
        minWidth={200}
        trigger={
          <button
            type="button"
            className="share-rolebtn"
            disabled={disabled}
            aria-label={`Access for ${member.user.name}: ${ROLE_LABEL[member.role]}`}
          >
            {ROLE_LABEL[member.role]}
            <ChevronDown size={14} aria-hidden="true" />
          </button>
        }
      />
    )
  }
  return (
    <>
      <span className={clsx('share-rolelabel', member.role === 'owner' && 'is-owner')}>{ROLE_LABEL[member.role]}</span>
      {canLeave && (
        <Button size="sm" variant="ghost" icon={LogOut} className="share-leave" disabled={disabled} onClick={onLeave}>
          Leave project
        </Button>
      )}
    </>
  )
}

// ---------------------------------------------------------------------------------------------
// Link sharing (owner)
// ---------------------------------------------------------------------------------------------

function LinkSharing({ projectId, links, state, error, onLinks, onRetry }: {
  projectId: string
  links: ShareLinks | null
  state: 'loading' | 'ready' | 'error'
  error: string | null
  onLinks: (l: ShareLinks) => void
  onRetry: () => void
}) {
  const [busy, setBusy] = useState<null | 'toggle' | MemberRole>(null)
  const enabled = !!(links?.editor || links?.viewer)

  const turnOn = async () => {
    setBusy('toggle')
    try {
      let next = links
      if (!next?.editor) next = await api.createShareLink(projectId, { role: 'editor' })
      if (!next?.viewer) next = await api.createShareLink(projectId, { role: 'viewer' })
      onLinks(next)
    } catch (e) {
      toast(`Couldn’t turn on link sharing: ${errorMessage(e)}`, { tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const turnOff = async () => {
    const ok = await confirmDialog({
      title: 'Turn off link sharing?',
      message: 'Both links stop working right away. People who already joined keep their access — remove them from the list above if needed.',
      confirmLabel: 'Turn off',
      danger: true,
    })
    if (!ok) return
    setBusy('toggle')
    try {
      let next: ShareLinks | null = links
      if (next?.editor) next = await api.deleteShareLink(projectId, 'editor')
      if (next?.viewer) next = await api.deleteShareLink(projectId, 'viewer')
      onLinks(next ?? { editor: null, viewer: null })
    } catch (e) {
      toast(`Couldn’t turn off link sharing: ${errorMessage(e)}`, { tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const create = async (role: MemberRole, regenerate: boolean) => {
    if (regenerate) {
      const ok = await confirmDialog({
        title: `Create a new ${role === 'editor' ? 'edit' : 'view-only'} link?`,
        message: 'The current link stops working. People who already joined keep their access. Share the new link with anyone who still needs to join.',
        confirmLabel: 'Create new link',
      })
      if (!ok) return
    }
    setBusy(role)
    try {
      onLinks(await api.createShareLink(projectId, { role }))
      if (regenerate) toast('New link created. The old link no longer works.', { tone: 'success' })
    } catch (e) {
      toast(`Couldn’t create the link: ${errorMessage(e)}`, { tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="share-section share-links" aria-labelledby="share-links-title">
      <div className="share-links__head">
        <div className="share-links__titles">
          <h3 id="share-links-title" className="share-heading">
            <Link2 size={16} aria-hidden="true" />
            Link sharing
          </h3>
          <p className="share-hint">
            {enabled
              ? 'Anyone with a Folio account who opens a link joins the project.'
              : 'Turn on to get links you can send to people. They join after signing in.'}
          </p>
        </div>
        {state === 'ready' && (
          <span className="share-links__toggle">
            {busy === 'toggle' && <Spinner size={14} label="Updating link sharing" />}
            <Switch
              checked={enabled}
              disabled={busy !== null}
              aria-label={enabled ? 'Turn off link sharing' : 'Turn on link sharing'}
              onChange={on => void (on ? turnOn() : turnOff())}
            />
          </span>
        )}
      </div>
      {state === 'loading' && (
        <div className="share-links__loading">
          <Spinner size={16} label="Loading links" />
        </div>
      )}
      {state === 'error' && (
        <div className="share-invite__error" role="alert">
          {error}{' '}
          <button type="button" className="share-linkbtn" onClick={onRetry}>
            Try again
          </button>
        </div>
      )}
      {state === 'ready' && enabled && links && (
        <div className="share-links__list">
          <LinkRow role="editor" token={links.editor} busy={busy === 'editor'} disabled={busy !== null} onCreate={regen => void create('editor', regen)} />
          <LinkRow role="viewer" token={links.viewer} busy={busy === 'viewer'} disabled={busy !== null} onCreate={regen => void create('viewer', regen)} />
        </div>
      )}
    </section>
  )
}

function LinkRow({ role, token, busy, disabled, onCreate }: {
  role: MemberRole
  token: string | null
  busy: boolean
  disabled: boolean
  onCreate: (regenerate: boolean) => void
}) {
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    if (!copied) return
    const t = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(t)
  }, [copied])

  const Icon = role === 'editor' ? PencilLine : Eye
  const title = role === 'editor' ? 'Anyone with this link can edit this project' : 'Anyone with this link can view this project'
  const url = token ? joinUrl(token) : ''
  const label = role === 'editor' ? 'Edit link' : 'View-only link'

  const copy = async () => {
    if (!url) return
    if (await copyText(url)) {
      setCopied(true)
      toast('Link copied', { tone: 'success', id: 'share-link-copied', duration: 2000 })
    } else {
      toast('Couldn’t copy automatically — select the link and copy it.', { tone: 'warning' })
    }
  }

  return (
    <div className={clsx('share-link', `share-link--${role}`)} data-role={role}>
      <div className="share-link__title">
        <Icon size={14} aria-hidden="true" />
        {title}
      </div>
      {token ? (
        <div className="share-link__row">
          <input
            className="share-link__url"
            readOnly
            value={url}
            aria-label={label}
            spellCheck={false}
            onFocus={e => e.currentTarget.select()}
          />
          <Button size="sm" variant={copied ? 'secondary' : 'primary'} icon={copied ? Check : Copy} onClick={() => void copy()} aria-label={`Copy ${label.toLowerCase()}`}>
            {copied ? 'Copied' : 'Copy'}
          </Button>
          <IconButton
            icon={busy ? <Spinner size={14} label={null} /> : RefreshCw}
            label={`Create a new ${label.toLowerCase()}`}
            tooltip="Regenerate: the current link stops working"
            size="md"
            disabled={disabled}
            onClick={() => onCreate(true)}
          />
        </div>
      ) : (
        <div className="share-link__row">
          <span className="share-link__none">No {label.toLowerCase()} yet.</span>
          <Button size="sm" variant="secondary" loading={busy} disabled={disabled} onClick={() => onCreate(false)}>
            Create link
          </Button>
        </div>
      )}
    </div>
  )
}
