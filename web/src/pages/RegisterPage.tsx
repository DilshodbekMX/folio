import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useAuth } from '../stores/auth'
import { errorMessage } from '../api/client'
import { Button, Field, TextField } from '../ui'
import { AuthShell } from './AuthShell'
import { MIN_PASSWORD, emailError, nameError, newPasswordError } from './authForm'
import { safeNext, useDocumentTitle } from './nav'

export function RegisterPage() {
  useDocumentTitle('Create an account')
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const nextRaw = params.get('next')
  const next = safeNext(nextRaw)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ name?: string | null; email?: string | null; password?: string | null; form?: string | null }>({})
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const errs = { name: nameError(name), email: emailError(email), password: newPasswordError(password) }
    if (errs.name || errs.email || errs.password) {
      setErrors(errs)
      return
    }
    setBusy(true)
    setErrors({})
    try {
      await useAuth.getState().register({ name: name.trim(), email: email.trim(), password })
      navigate(next, { replace: true })
    } catch (err) {
      setErrors({ form: errorMessage(err, 'Couldn’t create the account.') })
      setBusy(false)
    }
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Your name is shown to collaborators next to your cursor and in chat."
      footer={
        <p>
          Already have an account? <Link to={nextRaw ? `/login?next=${encodeURIComponent(next)}` : '/login'}>Log in</Link>
        </p>
      }
    >
      <form className="pg-form" onSubmit={submit} noValidate>
        {errors.form && (
          <div className="pg-form__error" role="alert">
            {errors.form}
          </div>
        )}
        <Field label="Name" error={errors.name}>
          <TextField autoComplete="name" autoFocus value={name} onChange={e => setName(e.target.value)} maxLength={100} />
        </Field>
        <Field label="Email" error={errors.email}>
          <TextField type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="name@example.com" />
        </Field>
        <Field label="Password" error={errors.password} hint={`At least ${MIN_PASSWORD} characters.`}>
          <TextField type="password" autoComplete="new-password" value={password} onChange={e => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" block loading={busy} className="pg-form__submit">
          Create account
        </Button>
      </form>
    </AuthShell>
  )
}
