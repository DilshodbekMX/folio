/**
 * Collaborators' compiles, seen through project events:
 *   - while someone else's compile runs, the PDF pane shows a progress bar ("Bob is compiling…");
 *   - when a collaborator's compile refreshes the PDF on screen, a short "PDF updated by Bob"
 *     notice in the PDF pane (only once the new PDF is actually shown, never for our own
 *     compiles; the compile store fetches the new build itself).
 *
 * The notice is quiet on purpose (J-4): it sits in the PDF pane, not over the editor; it is
 * shown once per burst of a collaborator's compiles (their auto-compile runs every few seconds
 * while they type — later builds of the burst refresh the PDF silently until they pause for
 * BURST_MS); and not while this user is typing. Builds of another root document than the one
 * shown here are not shown at all (stores/compile.ts), so they never announce themselves.
 */
import { useEffect, useState } from 'react'
import type { UserPublic } from '@folio/shared/api'
import { docSessions } from '../../realtime/docs'
import { projectEvents } from '../../realtime/meta'
import { useAuth } from '../../stores/auth'
import { useCompile } from '../../stores/compile'
import { usePdfView } from './viewer/store'

const REMOTE_COMPILE_MAX_MS = 10 * 60_000
const SHOW_WAIT_MS = 30_000
/** how long "PDF updated by X" stays */
export const UPDATED_NOTICE_MS = 3500
/** a collaborator's builds closer together than this are one burst: one notice */
export const BURST_MS = 60_000
/** no notice while this user typed within this time */
const TYPING_MS = 4000

export interface RemoteCompiles {
  /** a collaborator whose compile is running */
  compilingBy: UserPublic | null
  /** a collaborator whose build was just shown (cleared after UPDATED_NOTICE_MS) */
  updatedBy: UserPublic | null
}

/** A compile event is of the root document shown here (true when the server does not name it). */
function shownHere(e: object): boolean {
  const root = (e as { rootPath?: unknown }).rootPath
  if (typeof root !== 'string' || !root) return true
  const st = useCompile.getState()
  const shown = st.lastWithPdf ?? st.last
  return st.root === null || !shown || root === st.root || root === shown.rootPath
}

export function useRemoteCompiles(): RemoteCompiles {
  const [compilingBy, setCompilingBy] = useState<UserPublic | null>(null)
  const [updatedBy, setUpdatedBy] = useState<UserPublic | null>(null)

  useEffect(() => {
    let clearTimer: ReturnType<typeof setTimeout> | null = null
    let noticeTimer: ReturnType<typeof setTimeout> | null = null
    const waits = new Set<() => void>()
    /** when each collaborator's last build was shown here */
    const lastShown = new Map<string, number>()
    let lastTyped = -Infinity
    const meId = () => useAuth.getState().me?.id

    const offTyping = docSessions.onChange((_fileId, local) => {
      if (local) lastTyped = Date.now()
    })

    const offStarted = projectEvents.on('compile:started', e => {
      if (e.by.id === meId() || !shownHere(e)) return
      setCompilingBy(e.by)
      if (clearTimer !== null) clearTimeout(clearTimer)
      clearTimer = setTimeout(() => setCompilingBy(null), REMOTE_COMPILE_MAX_MS)
    })

    const notice = (by: UserPublic) => {
      const now = Date.now()
      const prev = lastShown.get(by.id) ?? -Infinity
      lastShown.set(by.id, now)
      if (now - prev < BURST_MS || now - lastTyped < TYPING_MS) return
      setUpdatedBy(by)
      if (noticeTimer !== null) clearTimeout(noticeTimer)
      noticeTimer = setTimeout(() => setUpdatedBy(null), UPDATED_NOTICE_MS)
    }

    const offDone = projectEvents.on('compile:done', e => {
      // another root document's compile (its "is compiling" was not shown either)
      if (!shownHere(e)) return
      if (clearTimer !== null) clearTimeout(clearTimer)
      clearTimer = null
      setCompilingBy(null)
      const by = e.by
      const buildId = e.buildId
      if (!by || by.id === meId() || !buildId || e.status !== 'success') return
      // wait until this build's PDF is the one on screen
      let timer: ReturnType<typeof setTimeout> | null = null
      const unsub = usePdfView.subscribe(s => {
        if (s.buildId === buildId && s.status === 'ready') finish(true)
      })
      const finish = (shown: boolean) => {
        unsub()
        if (timer !== null) clearTimeout(timer)
        waits.delete(cancel)
        if (shown && useCompile.getState().lastWithPdf?.buildId === buildId) notice(by)
      }
      const cancel = () => finish(false)
      waits.add(cancel)
      timer = setTimeout(cancel, SHOW_WAIT_MS)
      if (usePdfView.getState().buildId === buildId && usePdfView.getState().status === 'ready') finish(true)
    })

    return () => {
      offTyping()
      offStarted()
      offDone()
      if (clearTimer !== null) clearTimeout(clearTimer)
      if (noticeTimer !== null) clearTimeout(noticeTimer)
      for (const cancel of [...waits]) cancel()
    }
  }, [])

  return { compilingBy, updatedBy }
}
