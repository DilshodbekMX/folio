/**
 * WebSocket upgrade routing (SPEC §4.3):
 *   Origin check (same rule as CSRF; mismatch → socket.destroy()) →
 *   `folio_session` cookie → user + session (may be null) → role via resolveRole →
 *   /ws/doc/:projectId/:fileId?epoch=N → collab.handleUpgrade
 *   /ws/project/:projectId             → meta.handleUpgrade
 *   anything else                      → socket.destroy()
 * The services accept the socket and close it with 4401/4403/4404 when user/role is missing,
 * so y-websocket clients stop reconnecting.
 *
 * One account holds at most MAX_SOCKETS_PER_USER open doc + project sockets (every tab keeps one
 * project socket and up to ~9 doc sockets): a runaway or hostile client cannot exhaust the
 * server's file descriptors and memory for everybody. Beyond the cap the socket is accepted and
 * closed with 1013 "try again later" (y-websocket backs off and retries).
 */
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer } from 'ws'
import { WS_CLOSE } from '@folio/shared/protocol'
import { toPublic } from '../db/index.ts'
import { resolveRole } from '../access/roles.ts'
import { sessionFromCookieHeader } from '../auth/sessions.ts'
import { moduleLog } from '../log.ts'
import type { Services } from '../services.ts'
import { isAllowedOrigin, requestHost, requestProto } from './origin.ts'

const log = moduleLog('upgrade')

const SEGMENT = /^[A-Za-z0-9_-]{1,64}$/

function decodeSegment(seg: string): string | null {
  try {
    const d = decodeURIComponent(seg)
    return SEGMENT.test(d) ? d : null
  } catch {
    return null
  }
}

export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => void

/** open WebSockets (doc + project, all tabs and devices) one account may hold */
export const MAX_SOCKETS_PER_USER = 200

export interface UpgradeOptions {
  maxSocketsPerUser?: number
}

export function createUpgradeHandler(services: Services, opts: UpgradeOptions = {}): UpgradeHandler {
  const maxPerUser = opts.maxSocketsPerUser ?? MAX_SOCKETS_PER_USER
  const openSockets = new Map<string, number>()
  // completes the handshake of refused sockets so the close code reaches the client
  const refuser = new WebSocketServer({ noServer: true, clientTracking: false, perMessageDeflate: false, maxPayload: 1024 })

  /** Count the socket against the user (released when it closes); false when the user is at the cap. */
  function admit(userId: string, socket: Duplex): boolean {
    const n = openSockets.get(userId) ?? 0
    if (n >= maxPerUser) return false
    openSockets.set(userId, n + 1)
    socket.once('close', () => {
      const left = (openSockets.get(userId) ?? 1) - 1
      if (left <= 0) openSockets.delete(userId)
      else openSockets.set(userId, left)
    })
    return true
  }

  function refuse(req: IncomingMessage, socket: Duplex, head: Buffer, userId: string): void {
    log.warn({ userId, max: maxPerUser }, 'websocket refused: too many open connections for this account')
    refuser.handleUpgrade(req, socket, head, ws => ws.close(WS_CLOSE.TRY_AGAIN, 'too many connections'))
  }

  return (req, socket, head) => {
    socket.on('error', err => log.debug({ err }, 'upgrade socket error'))
    try {
      const origin = req.headers.origin
      // browsers always send Origin on WebSocket handshakes; its absence means a non-browser client
      if (origin !== undefined && !isAllowedOrigin(services.config, origin, requestProto(req), requestHost(req))) {
        log.warn({ origin, host: req.headers.host }, 'websocket upgrade rejected: cross-origin')
        socket.destroy()
        return
      }
      const url = new URL(req.url ?? '/', 'http://localhost')
      const parts = url.pathname.split('/').filter(Boolean)
      if (parts[0] !== 'ws') {
        socket.destroy()
        return
      }
      const session = sessionFromCookieHeader(services.db, req.headers.cookie)
      const user = session ? toPublic(session.user) : null
      // sockets remember their session: logout / password change / expiry close exactly these
      const sessionTokenHash = session?.tokenHash ?? null

      if (parts[1] === 'doc' && parts.length === 4) {
        const projectId = decodeSegment(parts[2])
        const fileId = decodeSegment(parts[3])
        if (!projectId || !fileId) {
          socket.destroy()
          return
        }
        const epochRaw = url.searchParams.get('epoch')
        const epoch = epochRaw !== null && /^\d{1,9}$/.test(epochRaw) ? Number(epochRaw) : -1
        const role = user ? resolveRole(services.db, projectId, user.id) : null
        if (user && !admit(user.id, socket)) return refuse(req, socket, head, user.id)
        services.collab.handleUpgrade(req, socket, head, { user, role, projectId, fileId, epoch, sessionTokenHash })
        return
      }
      if (parts[1] === 'project' && parts.length === 3) {
        const projectId = decodeSegment(parts[2])
        if (!projectId) {
          socket.destroy()
          return
        }
        const role = user ? resolveRole(services.db, projectId, user.id) : null
        if (user && !admit(user.id, socket)) return refuse(req, socket, head, user.id)
        services.meta.handleUpgrade(req, socket, head, { user, role, projectId, sessionTokenHash })
        return
      }
      socket.destroy()
    } catch (err) {
      log.error({ err, url: req.url }, 'websocket upgrade failed')
      socket.destroy()
    }
  }
}
