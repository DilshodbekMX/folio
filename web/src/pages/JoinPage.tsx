import { useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { Eye, LinkIcon, PencilLine } from 'lucide-react'
import type { ShareTokenInfo } from '@folio/shared/api'
import { api } from '../api/endpoints'
import { errorMessage, isAbortError, isApiError } from '../api/client'
import { useAuth } from '../stores/auth'
import { Avatar, Button, FolioMark, Spinner } from '../ui'
import { useDocumentTitle } from './nav'

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; info: ShareTokenInfo }
  | { kind: 'invalid' }
  | { kind: 'error'; message: string }

/** /join/:token — shows what the share link grants and joins on confirmation. */
export function JoinPage() {
  const { token = '' } = useParams()
  const navigate = useNavigate()
  const me = useAuth(s => s.me)
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [joining, setJoining] = useState(false)
  const [joinError, setJoinError] = useState<string | null>(null)
  useDocumentTitle(state.kind === 'ready' ? `Join ${state.info.projectName}` : 'Join project')

  useEffect(() => {
    const ctrl = new AbortController()
    setState({ kind: 'loading' })
    api.shareTokenInfo(token, { signal: ctrl.signal }).then(
      info => {
        if (info.alreadyMember) navigate(`/project/${info.projectId}`, { replace: true })
        else setState({ kind: 'ready', info })
      },
      e => {
        if (isAbortError(e)) return
        if (isApiError(e, 404) || isApiError(e, 400)) setState({ kind: 'invalid' })
        else setState({ kind: 'error', message: errorMessage(e) })
      },
    )
    return () => ctrl.abort()
  }, [token, navigate])

  const join = async () => {
    setJoining(true)
    setJoinError(null)
    try {
      const res = await api.joinShareToken(token)
      navigate(`/project/${res.projectId}`, { replace: true })
    } catch (e) {
      setJoinError(isApiError(e, 404) ? 'This link is no longer valid.' : errorMessage(e, 'Couldn’t join the project.'))
      setJoining(false)
    }
  }

  let body
  if (state.kind === 'loading') {
    body = (
      <div className="pg-join__loading">
        <Spinner size={20} label="Checking the link" />
      </div>
    )
  } else if (state.kind === 'invalid') {
    body = (
      <>
        <h1 className="pg-state__title">This link isn’t valid</h1>
        <p className="pg-state__text">
          The project owner may have turned link sharing off or created a new link. Ask them to share the project with you again.
        </p>
        <Link to="/" className="pg-state__link">Go to your projects</Link>
      </>
    )
  } else if (state.kind === 'error') {
    body = (
      <>
        <h1 className="pg-state__title">Couldn’t open this link</h1>
        <p className="pg-state__text">{state.message}</p>
        <Link to="/" className="pg-state__link">Go to your projects</Link>
      </>
    )
  } else {
    const { info } = state
    const editor = info.role === 'editor'
    body = (
      <>
        <p className="pg-join__eyebrow">
          <LinkIcon size={14} aria-hidden="true" /> Shared project
        </p>
        <h1 className="pg-join__name">{info.projectName}</h1>
        <p className="pg-join__owner">
          <Avatar user={info.owner} size={20} decorative />
          <span>
            Owned by <strong>{info.owner.name}</strong>
          </span>
        </p>
        <div className="pg-join__role">
          {editor ? <PencilLine size={18} aria-hidden="true" /> : <Eye size={18} aria-hidden="true" />}
          <div>
            <div className="pg-join__role-title">You’ll join as {editor ? 'an editor' : 'a viewer'}</div>
            <div className="pg-join__role-text">
              {editor
                ? 'You can edit files, compile, upload and chat with the other collaborators.'
                : 'You can read the files, view and download the PDF and follow the history, but not change anything.'}
            </div>
          </div>
        </div>
        {me && (
          <p className="pg-join__note">
            You’re joining as <strong>{me.email}</strong>. Your name and email address will be visible to the owner and the other collaborators.
          </p>
        )}
        {joinError && (
          <div className="pg-form__error" role="alert">
            {joinError}
          </div>
        )}
        <div className="pg-join__actions">
          <Button variant="ghost" onClick={() => navigate('/')}>
            Not now
          </Button>
          <Button variant="primary" loading={joining} onClick={join} autoFocus>
            Join project
          </Button>
        </div>
      </>
    )
  }

  return (
    <div className="pg-center">
      <div className="pg-card pg-join" aria-busy={state.kind === 'loading'}>
        <FolioMark size={32} tile className="pg-card__mark" />
        {body}
      </div>
    </div>
  )
}
