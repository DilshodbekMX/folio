import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from '../../stores/auth'
import { errorMessage } from '../../api/client'
import { Avatar, Button, Field, Modal, TextField, toast } from '../../ui'
import { ThemeToggle } from './ThemeToggle'

/** Account settings: display name, password, theme. */
export function AccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const me = useAuth(s => s.me)
  const [name, setName] = useState(me?.name ?? '')
  const [savingName, setSavingName] = useState(false)
  const [nameError, setNameError] = useState<string | null>(null)

  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [pwError, setPwError] = useState<string | null>(null)
  const [savingPw, setSavingPw] = useState(false)

  useEffect(() => {
    if (open) {
      setName(useAuth.getState().me?.name ?? '')
      setNameError(null)
      setCurrent('')
      setNext('')
      setConfirm('')
      setPwError(null)
    }
  }, [open])

  if (!me) return null

  const saveName = async (e: FormEvent) => {
    e.preventDefault()
    const v = name.trim()
    if (!v) {
      setNameError('Enter your name.')
      return
    }
    if (v.length > 100) {
      setNameError('Names can be at most 100 characters.')
      return
    }
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
    if (next.length < 8) return setPwError('The new password must be at least 8 characters.')
    if (next !== confirm) return setPwError('The new passwords don’t match.')
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
    <Modal open={open} onClose={onClose} title="Account settings" size="md">
      <div className="dash-account">
        <div className="dash-account__who">
          <Avatar user={me} size={40} decorative />
          <div>
            <div className="dash-account__name">{me.name}</div>
            <div className="dash-account__email">{me.email}</div>
          </div>
        </div>

        <section className="dash-account__section" aria-labelledby="acct-profile">
          <h3 id="acct-profile" className="dash-account__heading">Profile</h3>
          <form className="dash-account__row" onSubmit={saveName} noValidate>
            <Field label="Name" error={nameError} hint="Shown to collaborators next to your cursor and in chat.">
              <TextField value={name} onChange={e => setName(e.target.value)} autoComplete="name" maxLength={100} />
            </Field>
            <Button type="submit" variant="secondary" loading={savingName} disabled={name.trim() === me.name}>
              Save name
            </Button>
          </form>
        </section>

        <section className="dash-account__section" aria-labelledby="acct-password">
          <h3 id="acct-password" className="dash-account__heading">Password</h3>
          <form className="dash-account__stack" onSubmit={savePassword} noValidate>
            <Field label="Current password">
              <TextField type="password" value={current} onChange={e => setCurrent(e.target.value)} autoComplete="current-password" />
            </Field>
            <div className="dash-account__pair">
              <Field label="New password" hint="At least 8 characters.">
                <TextField type="password" value={next} onChange={e => setNext(e.target.value)} autoComplete="new-password" />
              </Field>
              <Field label="Confirm new password">
                <TextField type="password" value={confirm} onChange={e => setConfirm(e.target.value)} autoComplete="new-password" />
              </Field>
            </div>
            {pwError && (
              <p className="dash-form-error" role="alert">
                {pwError}
              </p>
            )}
            <div>
              <Button type="submit" variant="secondary" loading={savingPw}>
                Change password
              </Button>
            </div>
          </form>
        </section>

        <section className="dash-account__section" aria-labelledby="acct-theme">
          <h3 id="acct-theme" className="dash-account__heading">Appearance</h3>
          <div className="dash-account__theme">
            <span className="dash-account__label">Theme</span>
            <ThemeToggle labelled />
          </div>
        </section>
      </div>
    </Modal>
  )
}
