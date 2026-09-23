import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router'
import { useAuth } from '../stores/auth'
import { ApiError, errorMessage } from '../api/client'
import { Button, Field, TextField } from '../ui'
import { AuthShell } from './AuthShell'
import { emailError } from './authForm'
import { safeNext, useDocumentTitle } from './nav'

export function LoginPage() {
  useDocumentTitle('Log in')
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const nextRaw = params.get('next')
  const next = safeNext(nextRaw)
  const allowSignup = useAuth(s => s.setup?.allowSignup ?? false)
  const logoutPending = useAuth(s => s.logoutPending)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errors, setErrors] = useState<{ email?: string | null; password?: string | null; form?: string | null }>({})
  const [busy, setBusy] = useState(false)

  const joining = next.startsWith('/join/')

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const eErr = emailError(email)
    const pErr = password ? null : 'Enter your password.'
    if (eErr || pErr) {
      setErrors({ email: eErr, password: pErr })
      return
    }
    setBusy(true)
    setErrors({})
    try {
      await useAuth.getState().login(email, password)
      navigate(next, { replace: true })
    } catch (err) {
      const msg = err instanceof ApiError && err.status === 401
        ? 'That email and password don’t match an account on this server.'
        : errorMessage(err, 'Couldn’t log in.')
      setErrors({ form: msg })
      setBusy(false)
    }
  }

  const registerHref = nextRaw ? `/register?next=${encodeURIComponent(next)}` : '/register'

  return (
    <AuthShell
      title="Log in to Folio"
      subtitle={joining ? 'Log in to open the project that was shared with you.' : 'Pick up where you and your co-authors left off.'}
      footer={
        <>
          {allowSignup && (
            <p>
              New here? <Link to={registerHref}>Create an account</Link>
            </p>
          )}
          <p className="pg-auth__muted">Forgot your password? Ask the person who runs this Folio server to reset it.</p>
        </>
      }
    >
      <form className="pg-form" onSubmit={submit} noValidate>
        {logoutPending && (
          <div className="pg-form__notice" role="status" data-testid="logout-pending">
            <strong>You’re signed out on this device,</strong> but the server couldn’t be reached to end the session yet.
            Folio keeps trying and finishes as soon as it can connect; until then nobody is signed in here.
          </div>
        )}
        {errors.form && (
          <div className="pg-form__error" role="alert">
            {errors.form}
          </div>
        )}
        <Field label="Email" error={errors.email}>
          <TextField
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={e => setEmail(e.target.value)}
            placeholder="name@example.com"
          />
        </Field>
        <Field label="Password" error={errors.password}>
          <TextField type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" variant="primary" block loading={busy} className="pg-form__submit">
          Log in
        </Button>
      </form>
    </AuthShell>
  )
}
