import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { useAuth } from '../stores/auth'
import { errorMessage } from '../api/client'
import { Button, Field, TextField } from '../ui'
import { AuthShell } from './AuthShell'
import { MIN_PASSWORD, emailError, nameError, newPasswordError } from './authForm'
import { useDocumentTitle } from './nav'

/** First run: create the administrator account (only reachable while no user exists). */
export function SetupPage() {
  useDocumentTitle('Set up Folio')
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<{ name?: string | null; email?: string | null; password?: string | null; confirm?: string | null; form?: string | null }>({})
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const errs = {
      name: nameError(name),
      email: emailError(email),
      password: newPasswordError(password),
      confirm: confirm === password ? null : 'The passwords don’t match.',
    }
    if (errs.name || errs.email || errs.password || errs.confirm) {
      setErrors(errs)
      return
    }
    setBusy(true)
    setErrors({})
    try {
      await useAuth.getState().setupAdmin({ name: name.trim(), email: email.trim(), password })
      navigate('/', { replace: true })
    } catch (err) {
      setErrors({ form: errorMessage(err, 'Couldn’t create the administrator account.') })
      setBusy(false)
    }
  }

  return (
    <AuthShell
      title="Set up Folio"
      subtitle="Create the administrator account for this server. You can add people later from the admin page, or invite them with share links."
    >
      <form className="pg-form" onSubmit={submit} noValidate>
        {errors.form && (
          <div className="pg-form__error" role="alert">
            {errors.form}
          </div>
        )}
        <Field label="Your name" error={errors.name}>
          <TextField autoComplete="name" autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={100} />
        </Field>
        <Field label="Email" error={errors.email}>
          <TextField type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" />
        </Field>
        <div className="pg-form__pair">
          <Field label="Password" error={errors.password} hint={`At least ${MIN_PASSWORD} characters.`}>
            <TextField type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
          </Field>
          <Field label="Confirm password" error={errors.confirm}>
            <TextField type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" variant="primary" block loading={busy} className="pg-form__submit">
          Create administrator account
        </Button>
      </form>
    </AuthShell>
  )
}
