/**
 * Live sockets follow their session. Every doc/meta WebSocket remembers the session token hash it
 * was opened with (http/upgrade.ts), so when a session ends the matching sockets are closed with
 * WS_CLOSE.UNAUTHORIZED (4401) — y-websocket stops reconnecting and the web app returns to the
 * login page — while the same user's other sessions (another browser) stay connected:
 *
 *   logout                       → that session's sockets
 *   password change              → the sockets of every *other* session of the account
 *   admin deletes the user       → all of the user's sessions
 *   expiry, CLI reset-password,  → sweepSessionSockets() (main.ts runs it every minute): sockets
 *   deleted rows                   whose session no longer resolves to a user are closed
 *
 * Belt and braces for the socket a close never reached: a doc room re-checks the session of a
 * connection that sends document updates and closes it when the session is gone (collab/doc-room.ts).
 */
import { WS_CLOSE } from '@folio/shared/protocol'
import type { Services } from '../services.ts'
import { moduleLog } from '../log.ts'

const log = moduleLog('auth.live')

/** Close every doc + meta socket opened with one of these sessions. Returns the number closed. */
export function closeSessionSockets(s: Services, tokenHashes: readonly string[], code: number = WS_CLOSE.UNAUTHORIZED): number {
  if (tokenHashes.length === 0) return 0
  let n = 0
  try {
    n += s.collab.disconnectSessions(tokenHashes, code)
  } catch (err) {
    log.warn({ err }, 'collab.disconnectSessions failed')
  }
  try {
    n += s.meta.disconnectSessions(tokenHashes, code)
  } catch (err) {
    log.warn({ err }, 'meta.disconnectSessions failed')
  }
  return n
}

/**
 * Close the sockets of sessions that have ended (expired, deleted, or whose user is gone).
 * Cheap: one indexed lookup per distinct open session.
 */
export function sweepSessionSockets(s: Services): number {
  const open = new Set<string>([...s.collab.openSessions(), ...s.meta.openSessions()])
  const ended: string[] = []
  for (const hash of open) {
    const session = s.db.sessions.get(hash) // deletes the row when it has expired
    if (!session || !s.db.users.get(session.userId)) ended.push(hash)
  }
  const n = closeSessionSockets(s, ended)
  if (n > 0) log.info({ sessions: ended.length, sockets: n }, 'closed sockets of ended sessions')
  return n
}
