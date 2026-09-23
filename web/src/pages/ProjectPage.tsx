/**
 * /project/:projectId — loads the project (REST), keeps the meta connection, loads the last
 * build, and renders the editor layout; shows the not-found / no-access / deleted states.
 *
 * Teardown on unmount goes through useProject.unload(), which is deferred by one tick so a
 * React StrictMode unmount/remount keeps the sockets; it releases the meta connection, closes
 * every doc session (docSessions.closeAll — sessions still holding unsynced edits keep sending
 * them in the background first) and resets the editor/compile/layout stores. The top bar's
 * "Back to your projects" asks first while edits cannot be sent (features/layout/unsynced.tsx).
 */
import { useEffect } from 'react'
import { Link, useParams } from 'react-router'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { connectMeta } from '../realtime/meta'
import { useCompile } from '../stores/compile'
import { useProject } from '../stores/project'
import { Button, FolioMark } from '../ui'
import { EditorLayout } from '../features/layout/EditorLayout'
import { useDocumentTitle } from './nav'
import { ProjectLoading } from './ProjectLoading'

type ErrorKind = 'deleted' | 'noaccess' | 'notfound' | 'other'

function classify(error: string | null): ErrorKind {
  const e = (error ?? '').toLowerCase()
  if (e.includes('deleted')) return 'deleted'
  if (e.includes('no longer have access')) return 'noaccess'
  if (e.includes('does not exist') || e.includes('do not have access') || e.includes('not found')) return 'notfound'
  return 'other'
}

const COPY: Record<Exclude<ErrorKind, 'other'>, { title: string; text: string }> = {
  deleted: {
    title: 'This project was deleted',
    text: 'The owner deleted it, so its files, history and chat are no longer available.',
  },
  noaccess: {
    title: 'You no longer have access',
    text: 'The owner removed you from this project or turned off the link you joined with. Ask them to share it again.',
  },
  notfound: {
    title: 'Project not found',
    text: 'It may have been deleted, or it hasn’t been shared with you. If someone sent you a link, ask them for a new one.',
  },
}

export function ProjectPage() {
  const { projectId = '' } = useParams()
  const current = useProject(s => s.projectId === projectId)
  const loadState = useProject(s => (s.projectId === projectId ? s.loadState : 'loading'))
  const error = useProject(s => s.error)
  const name = useProject(s => s.name)
  useDocumentTitle(current && loadState === 'ready' ? name : loadState === 'error' ? 'Project unavailable' : 'Opening project')

  useEffect(() => {
    if (!projectId) return
    let cancelled = false
    let release: (() => void) | null = null
    useProject
      .getState()
      .load(projectId)
      .then(() => {
        const st = useProject.getState()
        if (cancelled || st.projectId !== projectId || st.loadState !== 'ready') return
        release = connectMeta(projectId)
        void useCompile.getState().loadLast()
      })
      .catch(() => {
        // load() reports failures through loadState/error
      })
    return () => {
      cancelled = true
      release?.()
      useProject.getState().unload()
    }
  }, [projectId])

  if (loadState === 'error') return <ProjectError error={error} projectId={projectId} />
  if (loadState !== 'ready' || !current) return <ProjectLoading />
  return <EditorLayout />
}

function ProjectError({ error, projectId }: { error: string | null; projectId: string }) {
  const kind = classify(error)
  const copy = kind === 'other' ? { title: 'Couldn’t open this project', text: error ?? 'Something went wrong.' } : COPY[kind]
  return (
    <div className="pg-center">
      <div className="pg-card pg-state">
        <FolioMark size={32} tile className="pg-card__mark" />
        <h1 className="pg-state__title">{copy.title}</h1>
        <p className="pg-state__text">{copy.text}</p>
        <div className="pg-state__actions">
          {kind === 'other' && (
            <Button variant="secondary" icon={RefreshCw} onClick={() => void useProject.getState().load(projectId)}>
              Try again
            </Button>
          )}
          <Link to="/" className="pg-state__link">
            <ArrowLeft size={14} aria-hidden="true" /> Back to your projects
          </Link>
        </div>
      </div>
    </div>
  )
}
