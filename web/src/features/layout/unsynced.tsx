/**
 * Local edits the server has not confirmed yet (realtime/docs.ts tracks them per session):
 *
 * - confirmLeaveProject(): in-app navigation away from the editor asks first while some of the
 *   open project's edits cannot be sent (the sessions keep syncing in the background anyway).
 * - useBackgroundSyncNotice() / <BackgroundSyncNotice/>: mounted once by App (lazily, once the
 *   editor code is loaded: before that no document session can exist) — while sessions of a
 *   project that is no longer open are still sending their edits, a persistent toast says so
 *   ("keep this tab open"), and it reports when they are saved — or could not be (the server
 *   closed the document; their text is kept by realtime/recovered.ts and shown when the project
 *   is opened again). Signing out ends all of that silently: the sessions are destroyed with the
 *   account's session (realtime/docs.ts), and nothing about its projects stays on screen.
 *
 * Closing or reloading the tab is guarded by docs.ts itself (beforeunload).
 */
import { useEffect } from 'react'
import { docSessions, useDocSync } from '../../realtime/docs'
import { isSigningOut, useAuth } from '../../stores/auth'
import { useProject } from '../../stores/project'
import { confirmDialog, dismissToast, toast } from '../../ui'

const BG_TOAST_ID = 'folio-background-sync'

function fileList(ids: readonly string[]): string {
  const files = useProject.getState().files
  const paths = ids.map(id => files[id]?.path).filter((p): p is string => !!p)
  if (paths.length === 0) return 'this project'
  if (paths.length <= 2) return paths.map(p => `“${p}”`).join(' and ')
  return `“${paths[0]}” and ${paths.length - 1} other files`
}

/**
 * Before navigating away from the open project: true to go ahead. Asks only while some of its
 * edits cannot be sent right now (connection lost); those keep syncing after leaving as long as
 * this tab stays open.
 */
export async function confirmLeaveProject(): Promise<boolean> {
  const pid = useProject.getState().projectId
  if (!pid) return true
  const unsynced = docSessions.unsyncedFileIds(pid)
  if (unsynced.length === 0) return true
  return confirmDialog({
    title: 'Leave with unsaved changes?',
    message: (
      <>
        <p>
          Your latest changes to {fileList(unsynced)} haven’t reached the server yet, because the connection is lost.
        </p>
        <p>
          If you leave, Folio keeps trying to send them while this tab stays open. Closing or reloading the tab before
          they are sent loses them.
        </p>
      </>
    ),
    confirmLabel: 'Leave anyway',
    cancelLabel: 'Stay',
  })
}

// project names, remembered while a project is open (the store is reset when it is left)
const projectNames = new Map<string, string>()

function drainingProjects(): string[] {
  const open = useProject.getState().projectId
  const ids = new Set<string>()
  for (const p of useDocSync.getState().pending) if (p.projectId !== open) ids.add(p.projectId)
  return [...ids]
}

function projectLabel(ids: readonly string[]): string {
  if (ids.length !== 1) return `${ids.length} projects`
  const name = projectNames.get(ids[0])
  return name ? `“${name}”` : 'a project you left'
}

/** Persistent notice while edits of projects that are no longer open are still being sent. */
export function useBackgroundSyncNotice(): void {
  useEffect(() => {
    let shown: string[] = []
    let lostBefore: Record<string, number> = { ...useDocSync.getState().lost }
    const remember = () => {
      const { projectId, name } = useProject.getState()
      if (projectId && name) projectNames.set(projectId, name)
    }
    const update = () => {
      if (isSigningOut() || !useAuth.getState().me) {
        // the account's sessions are gone with it: no "saved" / "could not be saved" news
        if (shown.length > 0) dismissToast(BG_TOAST_ID)
        shown = []
        lostBefore = { ...useDocSync.getState().lost }
        projectNames.clear()
        return
      }
      const ids = drainingProjects()
      if (ids.length > 0) {
        toast(
          <>
            <strong>Still saving your changes</strong> to {projectLabel(ids)}. They are sent as soon as the connection is back — keep
            this tab open until then.
          </>,
          { id: BG_TOAST_ID, tone: 'warning', duration: 0 },
        )
      } else if (shown.length > 0) {
        dismissToast(BG_TOAST_ID)
        // left because it was sent — or given up (access lost, file deleted); a project reopened
        // takes its sessions back: no message then
        const { lost } = useDocSync.getState()
        const failed = shown.filter(id => (lost[id] ?? 0) > (lostBefore[id] ?? 0))
        const reopened = shown.includes(useProject.getState().projectId ?? '')
        if (failed.length > 0) {
          toast(`Some of your changes to ${projectLabel(failed)} could not be saved: the server closed the document (the file was deleted or your access changed). Their text is kept in this tab: open the project to copy it or save it as a new file.`, {
            tone: 'error',
            duration: 0,
          })
        } else if (!reopened) {
          toast(`Your changes to ${projectLabel(shown)} were saved.`, { tone: 'success' })
        }
      }
      if (ids.length === 0) lostBefore = { ...useDocSync.getState().lost }
      shown = ids
    }
    remember()
    update()
    const offProject = useProject.subscribe((s, prev) => {
      if (s.name !== prev.name || s.projectId !== prev.projectId) remember()
      if (s.projectId !== prev.projectId) update()
    })
    const offSync = useDocSync.subscribe(update)
    return () => {
      offProject()
      offSync()
    }
  }, [])
}

/** useBackgroundSyncNotice() as a component (App loads it together with the editor code). */
export function BackgroundSyncNotice(): null {
  useBackgroundSyncNotice()
  return null
}
