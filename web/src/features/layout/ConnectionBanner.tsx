import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { WifiOff } from 'lucide-react'
import { useDocSync } from '../../realtime/docs'
import { useProject } from '../../stores/project'
import { Spinner } from '../../ui'

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine))
  useEffect(() => {
    const on = () => setOnline(true)
    const off = () => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
}

/** “main.tex”, “a.tex” and “b.tex”, “a.tex” and 3 other files */
function describeFiles(paths: readonly string[]): string {
  if (paths.length === 0) return 'your documents'
  if (paths.length <= 2) return paths.map(p => `“${p}”`).join(' and ')
  return `“${paths[0]}” and ${paths.length - 1} other files`
}

/**
 * Strip under the top bar while the project connection is lost, the browser is offline, or some
 * of the open project's edits cannot reach the server (a document socket is down). It only
 * promises what holds: unsent edits live in this tab until they are sent (closing or reloading
 * the tab asks first).
 */
export function ConnectionBanner() {
  const connection = useProject(s => s.connection)
  const projectId = useProject(s => s.projectId)
  const files = useProject(s => s.files)
  const unsyncedIds = useDocSync(useShallow(s => s.unsynced.filter(x => x.projectId === projectId).map(x => x.fileId)))
  const online = useOnline()
  if (connection !== 'disconnected' && online && unsyncedIds.length === 0) return null
  const paths = unsyncedIds.map(id => files[id]?.path).filter((p): p is string => !!p)
  const unsynced = unsyncedIds.length > 0
  return (
    <div className="lay-banner" role="status" aria-live="polite" data-unsynced={unsynced || undefined}>
      {online ? <Spinner size={14} label={null} /> : <WifiOff size={15} aria-hidden="true" />}
      <span>
        <strong>{online ? 'Reconnecting…' : 'You’re offline.'}</strong>{' '}
        {unsynced ? (
          <>
            Your latest changes to {describeFiles(paths)} haven’t been saved yet. Keep this tab open: they are sent as soon as the
            connection is back.
          </>
        ) : online ? (
          <>The connection to the server was lost. Edits you make are kept in this tab and sent when it’s back.</>
        ) : (
          <>Folio reconnects when your network is back. Edits you make are kept in this tab until then.</>
        )}
      </span>
    </div>
  )
}
