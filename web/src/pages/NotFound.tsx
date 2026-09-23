import { Link } from 'react-router'
import { FolioMark } from '../ui'
import { useDocumentTitle } from './nav'

export function NotFound({ title = 'Page not found', message }: { title?: string; message?: string }) {
  useDocumentTitle(title)
  return (
    <div className="pg-center">
      <div className="pg-card pg-state">
        <FolioMark size={32} tile className="pg-card__mark" />
        <p className="pg-state__code">404</p>
        <h1 className="pg-state__title">{title}</h1>
        <p className="pg-state__text">{message ?? 'The address may be mistyped, or the page may have moved.'}</p>
        <Link to="/" className="pg-state__link">Go to your projects</Link>
      </div>
    </div>
  )
}
