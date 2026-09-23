/**
 * Notices about changes made elsewhere that affect what this user sees in the editor
 * (mounted once by EditorLayout):
 *   - the open file was deleted (or became a folder) and the editor now shows another file (a
 *     new file at the same path, or the main document). When the editor closes instead, its own
 *     closed-file state and notice explain it (features/editor/openFileGuard.ts). The toast
 *     names who did it once the 'files:changed' event (`by`) arrives — events missed while
 *     offline are not replayed, so after a reconnect it may not know. When the old file's
 *     session held edits the server never got, realtime/docs.ts kept its text and the
 *     persistent "kept changes" notice (RecoveredTexts) says everything: no toast then;
 *   - this user's role in the project changed (edit ↔ view-only, ownership).
 */
import { useEffect } from 'react'
import { docSessions } from '../../realtime/docs'
import { projectEvents } from '../../realtime/meta'
import { recoveredFor } from '../../realtime/recovered'
import { useAuth } from '../../stores/auth'
import { onOpenFileLost, type OpenFileLost } from '../../stores/editor'
import { useLayout } from '../../stores/layout'
import { useProject } from '../../stores/project'
import { toast } from '../../ui'

/** how long a "file lost" toast can still be completed with who made the change */
const BY_MEMORY_MS = 15_000

function showLost(e: OpenFileLost, nextPath: string, byName: string | null): void {
  const replaced = nextPath === e.path
  const by = byName ? ` by ${byName}` : ''
  toast(
    replaced ? (
      <>
        “{e.path}” was replaced{by}. The editor now shows the new version.
      </>
    ) : (
      <>
        “{e.path}” was deleted{by}, so the editor switched to “{nextPath}”. You can restore it from the project history.
      </>
    ),
    {
      id: `file-lost-${e.fileId}`,
      tone: 'warning',
      duration: 10_000,
      action: replaced ? undefined : { label: 'History', onClick: () => useLayout.getState().setHistoryOpen(true) },
    },
  )
}

export function useProjectNotices(): void {
  useEffect(() => {
    let shown: { e: OpenFileLost; nextPath: string; at: number } | null = null
    const offLost = onOpenFileLost(e => {
      const files = useProject.getState().files
      const next = e.nextFileId ? files[e.nextFileId] : undefined
      if (!next) return
      const pid = useProject.getState().projectId
      // after every listener of this store update: docs.ts may be keeping the old session's text
      queueMicrotask(() => {
        if (pid && recoveredFor(pid, e.fileId)) return
        shown = { e, nextPath: next.path, at: Date.now() }
        showLost(e, next.path, null)
      })
    })
    // the event right behind the file-list update names who deleted / replaced the file
    const offChanged = projectEvents.on('files:changed', ev => {
      const cur = shown
      if (!cur || Date.now() - cur.at > BY_MEMORY_MS) return
      if (!ev.deletedIds.includes(cur.e.fileId) && !ev.changed.some(f => f.path === cur.e.path)) return
      shown = null
      const by = ev.by
      if (!by || by.id === useAuth.getState().me?.id) return
      if (useProject.getState().projectId && recoveredFor(useProject.getState().projectId!, cur.e.fileId)) return
      showLost(cur.e, cur.nextPath, by.name)
    })

    const offRole = useProject.subscribe((s, prev) => {
      if (s.projectId !== prev.projectId || !s.projectId || !prev.role || !s.role || s.role === prev.role) return
      if (s.role === 'viewer') {
        // the server drops a viewer's edits: say so when some had not been confirmed yet (their
        // text is kept: docs.ts hands it to the "kept changes" notice)
        const lost = docSessions.list().some(x => x.projectId === s.projectId && x.hasPendingChanges())
        toast(`Your access to this project changed to view-only.${lost ? ' Your latest changes could not be saved; their text is kept at the top of the page.' : ''}`, {
          id: 'role-changed',
          tone: 'warning',
          duration: 12_000,
        })
      } else if (prev.role === 'viewer') {
        toast(s.role === 'owner' ? 'You are now the owner of this project.' : 'You can now edit this project.', { id: 'role-changed', tone: 'success' })
      } else if (s.role === 'owner') {
        toast('You are now the owner of this project.', { id: 'role-changed', tone: 'success' })
      } else {
        toast('You are no longer the owner of this project; you can still edit it.', { id: 'role-changed', tone: 'info' })
      }
    })

    return () => {
      offLost()
      offChanged()
      offRole()
    }
  }, [])
}
