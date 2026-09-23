/**
 * /admin (SPEC §6.7): user administration for admins — users table (name, email, role, created,
 * owned projects), create user (name, email, password, admin), delete user (with a warning that
 * the projects they own are deleted too), plus a short summary of the server.
 *
 * App.tsx already routes non-admins to NotFound; the page guards itself as well and handles a
 * 403 from the API (e.g. admin rights removed meanwhile).
 *
 * Deviation (documented): the page's styles live in features/settings/admin.css (prefix adm-)
 * because only this file of pages/ is owned by web-collab-ui; the top bar reuses the dashboard
 * header (dashboard.css) and UserMenu.
 */
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { Link } from 'react-router'
import clsx from 'clsx'
import {
  ArrowDown, ArrowLeft, ArrowUp, Check, Copy, Dices, Eye, EyeOff, RefreshCw, Search, SearchX, ShieldCheck, Trash, UserPlus, X,
} from 'lucide-react'
import type { AdminUser, SystemInfo } from '@folio/shared/api'
import { api } from '../api/endpoints'
import { errorMessage, isApiError } from '../api/client'
import { formatDate, formatDateTime } from '../lib/time'
import { useAuth } from '../stores/auth'
import {
  Avatar, Button, Checkbox, EmptyState, Field, FolioLogo, IconButton, Modal, Spinner, TextField, Tooltip, confirmDialog, toast,
} from '../ui'
import { UserMenu } from '../features/dashboard/UserMenu'
import { copyText } from '../features/share/clipboard'
import { useDocumentTitle } from './nav'
import '../features/dashboard/dashboard.css'
import '../features/settings/admin.css'

type SortKey = 'name' | 'email' | 'role' | 'createdAt' | 'projectCount'
interface SortState { key: SortKey; dir: 1 | -1 }

const MIN_PASSWORD = 8
const EMAIL_RE = /^[^\s@]+@[^\s@]+$/

function compareUsers(a: AdminUser, b: AdminUser, s: SortState): number {
  let r = 0
  switch (s.key) {
    case 'name': r = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }); break
    case 'email': r = a.email.localeCompare(b.email); break
    case 'role': r = Number(b.isAdmin) - Number(a.isAdmin); break
    case 'createdAt': r = a.createdAt - b.createdAt; break
    case 'projectCount': r = a.projectCount - b.projectCount; break
  }
  return (r || a.name.localeCompare(b.name)) * s.dir
}

export function AdminPage() {
  useDocumentTitle('Admin')
  const me = useAuth(s => s.me)
  const [users, setUsers] = useState<AdminUser[] | null>(null)
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'error' | 'forbidden'>('loading')
  const [loadError, setLoadError] = useState<string | null>(null)
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 1 })
  const [createOpen, setCreateOpen] = useState(false)
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = async () => {
    setLoadState(s => (s === 'ready' ? s : 'loading'))
    try {
      const list = await api.adminUsers()
      setUsers(list)
      setLoadState('ready')
    } catch (e) {
      if (isApiError(e, 403)) setLoadState('forbidden')
      else {
        setLoadError(errorMessage(e, 'Couldn’t load the users.'))
        setLoadState('error')
      }
    }
  }

  useEffect(() => {
    if (!me?.isAdmin) return
    void load()
    api.system({ silent: true }).then(setSystem, () => setSystem(null))
  }, [me?.isAdmin])

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const list = (users ?? []).filter(u => !q || u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q))
    return list.sort((a, b) => compareUsers(a, b, sort))
  }, [users, query, sort])

  const admins = users?.filter(u => u.isAdmin).length ?? 0

  const deleteUser = async (u: AdminUser) => {
    const ok = await confirmDialog({
      title: `Delete ${u.name}?`,
      danger: true,
      confirmLabel: u.projectCount > 0 ? `Delete user and ${u.projectCount} project${u.projectCount === 1 ? '' : 's'}` : 'Delete user',
      message: (
        <div className="adm-confirm">
          <p>
            This permanently deletes the account of <strong>{u.name}</strong> ({u.email}).
          </p>
          {u.projectCount > 0 ? (
            <p className="adm-confirm__warn">
              The {u.projectCount === 1 ? 'project' : `${u.projectCount} projects`} {u.name} owns {u.projectCount === 1 ? 'is' : 'are'} deleted
              too — with all files, history and chat — for every collaborator.
            </p>
          ) : (
            <p>{u.name} doesn’t own any projects.</p>
          )}
          <p>They are removed from projects that others shared with them. This can’t be undone.</p>
        </div>
      ),
    })
    if (!ok) return
    setDeleting(u.id)
    try {
      await api.adminDeleteUser(u.id)
      setUsers(list => (list ?? []).filter(x => x.id !== u.id))
      toast(`${u.name}’s account was deleted.`, { tone: 'success' })
    } catch (e) {
      toast(`Couldn’t delete ${u.name}: ${errorMessage(e)}`, { tone: 'error' })
    } finally {
      setDeleting(null)
    }
  }

  const header = (
    <header className="dash-header">
      <Link to="/" className="dash-brand" aria-label="Folio — your projects">
        <FolioLogo size={22} />
      </Link>
      <div className="dash-header__right">
        <UserMenu />
      </div>
    </header>
  )

  if (!me?.isAdmin || loadState === 'forbidden') {
    return (
      <div className="dash adm">
        {header}
        <main className="adm-main" id="main">
          <div className="adm-inner">
            <EmptyState icon={ShieldCheck} title="Admins only">
              You need administrator rights to manage users on this server.
            </EmptyState>
            <p className="adm-center">
              <Link to="/">Back to your projects</Link>
            </p>
          </div>
        </main>
      </div>
    )
  }

  const sortButton = (key: SortKey, label: string, className?: string) => {
    const active = sort.key === key
    const Icon = active && sort.dir === -1 ? ArrowDown : ArrowUp
    return (
      <th scope="col" className={className} aria-sort={active ? (sort.dir === 1 ? 'ascending' : 'descending') : 'none'}>
        <button
          type="button"
          className={clsx('adm-sort', active && 'is-active')}
          onClick={() => setSort(s => ({ key, dir: s.key === key ? (s.dir === 1 ? -1 : 1) : key === 'createdAt' || key === 'projectCount' ? -1 : 1 }))}
        >
          {label}
          <Icon size={12} aria-hidden="true" className="adm-sort__icon" />
        </button>
      </th>
    )
  }

  let body: ReactNode
  if (loadState === 'loading' && !users) {
    body = (
      <div className="adm-loading">
        <Spinner size={20} label="Loading users" />
      </div>
    )
  } else if (loadState === 'error' && !users) {
    body = (
      <EmptyState
        icon={RefreshCw}
        title="Couldn’t load the users"
        actions={<Button variant="secondary" icon={RefreshCw} onClick={() => void load()}>Try again</Button>}
      >
        {loadError}
      </EmptyState>
    )
  } else if (rows.length === 0) {
    body = (
      <EmptyState icon={SearchX} title={`No users match “${query.trim()}”`} actions={<Button variant="secondary" onClick={() => setQuery('')}>Clear search</Button>}>
        Search by name or email address.
      </EmptyState>
    )
  } else {
    body = (
      <div className="adm-tablewrap">
        <table className="adm-table">
          <caption className="visually-hidden">Users of this Folio server</caption>
          <colgroup>
            <col />
            <col className="adm-col-email" />
            <col className="adm-col-role" />
            <col className="adm-col-date" />
            <col className="adm-col-count" />
            <col className="adm-col-actions" />
          </colgroup>
          <thead>
            <tr>
              {sortButton('name', 'Name')}
              {sortButton('email', 'Email', 'adm-cell-email')}
              {sortButton('role', 'Role')}
              {sortButton('createdAt', 'Created', 'adm-cell-date')}
              {sortButton('projectCount', 'Projects', 'adm-cell-count')}
              <th scope="col">
                <span className="visually-hidden">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(u => {
              const isMe = u.id === me.id
              return (
                <tr key={u.id} data-user-email={u.email} className={clsx(deleting === u.id && 'is-busy')}>
                  <td>
                    <span className="adm-user">
                      <Avatar user={u} size={28} decorative />
                      <span className="adm-user__text">
                        <span className="adm-user__name">
                          {u.name}
                          {isMe && <span className="adm-you">You</span>}
                        </span>
                        <span className="adm-user__email-sm">{u.email}</span>
                      </span>
                    </span>
                  </td>
                  <td className="adm-cell-email">
                    <span className="adm-ellipsis" title={u.email}>{u.email}</span>
                  </td>
                  <td>
                    {u.isAdmin ? (
                      <span className="adm-badge">
                        <ShieldCheck size={12} aria-hidden="true" />
                        Admin
                      </span>
                    ) : (
                      <span className="adm-muted">User</span>
                    )}
                  </td>
                  <td className="adm-cell-date">
                    <span title={formatDateTime(u.createdAt)}>{formatDate(u.createdAt)}</span>
                  </td>
                  <td className="adm-cell-count">
                    <span className="adm-count" aria-label={`${u.projectCount} owned projects`}>{u.projectCount}</span>
                  </td>
                  <td className="adm-cell-actions">
                    {deleting === u.id ? (
                      <Spinner size={16} label="Deleting" />
                    ) : isMe ? (
                      <Tooltip content="You can’t delete your own account">
                        <span className="adm-disabled" tabIndex={0} aria-label="You can’t delete your own account">
                          <Trash size={16} aria-hidden="true" />
                        </span>
                      </Tooltip>
                    ) : (
                      <IconButton
                        icon={Trash}
                        label={`Delete ${u.name}`}
                        variant="danger"
                        disabled={deleting !== null}
                        onClick={() => void deleteUser(u)}
                      />
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <div className="dash adm">
      {header}
      <main className="adm-main" id="main">
        <div className="adm-inner">
          <Link to="/" className="adm-back">
            <ArrowLeft size={14} aria-hidden="true" />
            Your projects
          </Link>
          <div className="adm-titlebar">
            <div>
              <h1 className="adm-title">Users</h1>
              <p className="adm-subtitle">
                {users
                  ? `${users.length} account${users.length === 1 ? '' : 's'} · ${admins} admin${admins === 1 ? '' : 's'}`
                  : 'Manage who can sign in to this Folio server.'}
              </p>
            </div>
            <div className="adm-titlebar__actions">
              <TextField
                wrapperClassName="adm-search"
                icon={Search}
                placeholder="Search users…"
                aria-label="Search users"
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
              <Button variant="primary" icon={UserPlus} onClick={() => setCreateOpen(true)}>
                New user
              </Button>
            </div>
          </div>
          {body}
          {system && <SystemSummary info={system} />}
        </div>
      </main>
      <CreateUserModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        existingEmails={users?.map(u => u.email.toLowerCase()) ?? []}
        onCreated={u => setUsers(list => [...(list ?? []).filter(x => x.id !== u.id), u])}
      />
    </div>
  )
}

function SystemSummary({ info }: { info: SystemInfo }) {
  return (
    <section className="adm-system" aria-labelledby="adm-system-title">
      <h2 id="adm-system-title" className="adm-system__title">
        Server
      </h2>
      <dl className="adm-system__grid">
        <div>
          <dt>Folio version</dt>
          <dd>{info.version}</dd>
        </div>
        <div>
          <dt>TeX distribution</dt>
          <dd>{info.texLive ?? 'Unknown'}</dd>
        </div>
        <div>
          <dt>Compiler sandbox</dt>
          <dd>
            <span className={clsx('adm-dot', info.dockerOk || info.compileRunner !== 'docker' ? 'is-ok' : 'is-bad')} aria-hidden="true" />
            {info.compileRunner === 'docker' ? (info.dockerOk ? 'Docker, running' : 'Docker, not reachable') : info.compileRunner === 'local' ? 'Local TeX (not sandboxed)' : 'Test runner'}
          </dd>
        </div>
        <div>
          <dt>Image</dt>
          <dd className="adm-mono" title={info.compileImage}>{info.compileImage}</dd>
        </div>
        <div>
          <dt>Self-registration</dt>
          <dd title={info.allowSignup ? 'Anyone can create an account on the sign-in page' : 'Only admins can create accounts'}>
            {info.allowSignup ? 'Open to everyone' : 'Admins only'}
          </dd>
        </div>
      </dl>
    </section>
  )
}

// ---------------------------------------------------------------------------------------------
// Create user
// ---------------------------------------------------------------------------------------------

const PW_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'

function generatePassword(length = 16): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  let out = ''
  for (const b of bytes) out += PW_ALPHABET[b % PW_ALPHABET.length]
  return out
}

interface FieldErrors { name?: string; email?: string; password?: string; form?: string }

function CreateUserModal({ open, onClose, onCreated, existingEmails }: {
  open: boolean
  onClose: () => void
  onCreated: (u: AdminUser) => void
  existingEmails: string[]
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [isAdmin, setIsAdmin] = useState(false)
  const [errors, setErrors] = useState<FieldErrors>({})
  const [saving, setSaving] = useState(false)
  const [created, setCreated] = useState<{ user: AdminUser; password: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const nameRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    if (!open) return
    setName('')
    setEmail('')
    setPassword('')
    setShowPassword(false)
    setIsAdmin(false)
    setErrors({})
    setCreated(null)
    setCopied(false)
  }, [open])

  const validate = (): FieldErrors => {
    const e: FieldErrors = {}
    const n = name.trim()
    const m = email.trim()
    if (!n) e.name = 'Enter the person’s name.'
    else if (n.length > 100) e.name = 'Names can be at most 100 characters.'
    if (!m) e.email = 'Enter an email address.'
    else if (!EMAIL_RE.test(m)) e.email = 'Enter a valid email address.'
    else if (existingEmails.includes(m.toLowerCase())) e.email = 'An account with this email already exists.'
    if (password.length < MIN_PASSWORD) e.password = `Use at least ${MIN_PASSWORD} characters.`
    return e
  }

  const submit = async (ev: FormEvent) => {
    ev.preventDefault()
    const e = validate()
    setErrors(e)
    if (Object.keys(e).length > 0) return
    setSaving(true)
    try {
      const user = await api.adminCreateUser({ name: name.trim(), email: email.trim(), password, isAdmin })
      onCreated(user)
      setCreated({ user, password })
      toast(`Account created for ${user.name}.`, { tone: 'success' })
    } catch (err) {
      if (isApiError(err, 409)) setErrors({ email: 'An account with this email already exists.' })
      else setErrors({ form: errorMessage(err, 'Couldn’t create the account.') })
    } finally {
      setSaving(false)
    }
  }

  const credentials = created ? `Folio: ${window.location.origin}\nEmail: ${created.user.email}\nPassword: ${created.password}` : ''

  if (created) {
    return (
      <Modal
        open={open}
        onClose={onClose}
        title="Account created"
        size="sm"
        footer={
          <Button variant="primary" onClick={onClose} data-autofocus>
            Done
          </Button>
        }
      >
        <div className="adm-created">
          <p>
            <strong>{created.user.name}</strong> can now sign in{created.user.isAdmin ? ' as an administrator' : ''}. Send them these details
            — the password isn’t shown again.
          </p>
          <pre className="adm-created__creds">{credentials}</pre>
          <Button
            size="sm"
            variant="secondary"
            icon={copied ? Check : Copy}
            onClick={async () => {
              if (await copyText(credentials)) {
                setCopied(true)
                toast('Sign-in details copied', { tone: 'success', duration: 2000 })
              } else {
                toast('Couldn’t copy automatically — select the text and copy it.', { tone: 'warning' })
              }
            }}
          >
            {copied ? 'Copied' : 'Copy sign-in details'}
          </Button>
        </div>
      </Modal>
    )
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New user"
      description="Folio doesn’t send email: share the password with the person yourself."
      size="sm"
      initialFocus={nameRef}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="adm-create-form" loading={saving}>
            Create user
          </Button>
        </>
      }
    >
      <form id="adm-create-form" className="adm-form" onSubmit={submit} noValidate>
        <Field label="Name" error={errors.name}>
          <TextField
            ref={nameRef}
            value={name}
            autoComplete="off"
            maxLength={120}
            onChange={e => {
              setName(e.target.value)
              setErrors(x => ({ ...x, name: undefined, form: undefined }))
            }}
            data-field="name"
          />
        </Field>
        <Field label="Email" error={errors.email}>
          <TextField
            type="email"
            value={email}
            autoComplete="off"
            spellCheck={false}
            onChange={e => {
              setEmail(e.target.value)
              setErrors(x => ({ ...x, email: undefined, form: undefined }))
            }}
            data-field="email"
          />
        </Field>
        <Field
          label="Password"
          error={errors.password}
          hint={`At least ${MIN_PASSWORD} characters. They can change it later in their account settings.`}
          aside={
            <button
              type="button"
              className="adm-linkbtn"
              onClick={() => {
                setPassword(generatePassword())
                setShowPassword(true)
                setErrors(e => ({ ...e, password: undefined }))
              }}
            >
              <Dices size={13} aria-hidden="true" />
              Generate
            </button>
          }
        >
          <TextField
            type={showPassword ? 'text' : 'password'}
            value={password}
            autoComplete="new-password"
            spellCheck={false}
            className="adm-mono"
            onChange={e => {
              setPassword(e.target.value)
              setErrors(x => ({ ...x, password: undefined, form: undefined }))
            }}
            data-field="password"
            trailing={
              <IconButton
                icon={showPassword ? EyeOff : Eye}
                label={showPassword ? 'Hide password' : 'Show password'}
                size="sm"
                tooltip={false}
                onClick={() => setShowPassword(v => !v)}
              />
            }
          />
        </Field>
        <Checkbox
          checked={isAdmin}
          onChange={setIsAdmin}
          label="Administrator"
          description="Admins can create and delete users. Deleting a user deletes the projects they own."
        />
        {errors.form && (
          <p className="adm-form__error" role="alert">
            {errors.form}
          </p>
        )}
      </form>
    </Modal>
  )
}
