/** Settings → Account: display name, email (read-only) and password. */
import { useEffect, useId, useState, type FormEvent } from 'react'
import { ShieldCheck } from 'lucide-react'
import { errorMessage } from '../../api/client'
import { formatDate } from '../../lib/time'
import { useAuth } from '../../stores/auth'
import { Avatar, Button, Field, TextField, toast } from '../../ui'
import { SettingsGroup } from './controls'

const MAX_NAME = 100
const MIN_PASSWORD = 8

export function AccountTab() {
  const me = useAuth(s => s.me)
  const [name, setName] = useState(me?.name ?? '')
  const [nameError, setNameError] = useState<string | null>(null)
  const [savingName, setSavingName] = useState(false)

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)
  const [savingPw, setSavingPw] = useState(false)
  const formId = useId()

  // keep the field in sync when the name changes elsewhere (another tab, the dashboard)
  const serverName = me?.name ?? ''
  useEffect(() => {
    setName(serverName)
  }, [serverName])

  if (!me) return null

  const saveName = async (e: FormEvent) => {
    e.preventDefault()
    const v = name.trim()
    if (!v) return setNameError('Enter your name.')
    if (v.length > MAX_NAME) return setNameError(`Names can be at most ${MAX_NAME} characters.`)
    setSavingName(true)
    setNameError(null)
    try {
      await useAuth.getState().updateMe({ name: v })
      toast('Name updated.', { tone: 'success' })
    } catch (err) {
      setNameError(errorMessage(err))
    } finally {
      setSavingName(false)
    }
  }

  const savePassword = async (e: FormEvent) => {
    e.preventDefault()
    if (!current) return setPwError('Enter your current password.')
    if (next.length < MIN_PASSWORD) return setPwError(`The new password must be at least ${MIN_PASSWORD} characters.`)
    if (next !== confirm) return setPwError('The new passwords don’t match.')
    if (next === current) return setPwError('The new password must be different from the current one.')
    setSavingPw(true)
    setPwError(null)
    try {
      await useAuth.getState().updateMe({ password: next, currentPassword: current })
      setCurrent('')
      setNext('')
      setConfirm('')
      toast('Password changed.', { tone: 'success' })
    } catch (err) {
      setPwError(errorMessage(err))
    } finally {
      setSavingPw(false)
    }
  }

  return (
    <div className="set-tab">
      <div className="set-account">
        <Avatar user={me} size={44} decorative />
        <div className="set-account__who">
          <div className="set-account__name">
            {me.name}
            {me.isAdmin && (
              <span className="set-account__badge">
                <ShieldCheck size={12} aria-hidden="true" />
                Admin
              </span>
            )}
          </div>
          <div className="set-account__meta">
            {me.email} · member since {formatDate(me.createdAt)}
          </div>
        </div>
      </div>

      <SettingsGroup title="Profile">
        <form className="set-form" onSubmit={saveName} noValidate aria-label="Profile">
          <div className="set-form__row">
            <Field label="Name" error={nameError} hint="Shown to collaborators next to your cursor and in chat.">
              <TextField value={name} onChange={e => setName(e.target.value)} autoComplete="name" maxLength={MAX_NAME + 20} data-setting="name" />
            </Field>
            <Button type="submit" variant="secondary" loading={savingName} disabled={!name.trim() || name.trim() === me.name}>
              Save
            </Button>
          </div>
          <Field label="Email" hint="Ask an administrator if your email address needs to change.">
            <TextField value={me.email} readOnly disabled aria-readonly="true" />
          </Field>
        </form>
      </SettingsGroup>

      <SettingsGroup title="Password">
        <form id={formId} className="set-form" onSubmit={savePassword} noValidate aria-label="Change password">
          {/* lets password managers associate the new password with this account */}
          <input type="text" name="username" autoComplete="username" value={me.email} readOnly hidden />
          <Field label="Current password">
            <TextField type="password" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" />
          </Field>
          <div className="set-form__pair">
            <Field label="New password" hint={`At least ${MIN_PASSWORD} characters.`}>
              <TextField type="password" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" />
            </Field>
            <Field label="Confirm new password">
              <TextField type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
            </Field>
          </div>
          {pwError && (
            <p className="set-form__error" role="alert">
              {pwError}
            </p>
          )}
          <div>
            <Button type="submit" variant="secondary" loading={savingPw} disabled={!current || !next || !confirm}>
              Change password
            </Button>
          </div>
        </form>
      </SettingsGroup>
    </div>
  )
}
