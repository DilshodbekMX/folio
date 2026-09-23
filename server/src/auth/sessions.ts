/**
 * Cookie sessions (SPEC §4.2): an opaque 256-bit random token in the `folio_session` cookie;
 * only sha256(token) is stored in the `sessions` table, so a leaked database does not leak
 * live sessions. The same lookup serves REST requests and WebSocket upgrades.
 *
 * Sessions slide: a session that is used is extended to `sessionTtlDays` from now, at most once
 * per EXTEND_INTERVAL_MS (one db write per hour and session); REST responses then re-send the
 * cookie with a fresh Max-Age (see loadSession). Open WebSockets remember the session they were
 * opened with, so logout / password change / expiry close exactly that session's sockets
 * (auth/live.ts).
 */
import { createHash, randomBytes } from 'node:crypto'
import { parseCookie, stringifySetCookie } from 'cookie'
import type { Config } from '../config.ts'
import type { Db, UserRecord } from '../db/index.ts'

export const SESSION_COOKIE = 'folio_session'

/** Sessions are touched (last_seen_at) and their expiry extended at most this often. */
export const EXTEND_INTERVAL_MS = 60 * 60 * 1000

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export function sessionTtlMs(config: Config): number {
  return Math.max(1, config.sessionTtlDays) * 24 * 60 * 60 * 1000
}

function isHttps(config: Config): boolean {
  return !!config.publicOrigin && config.publicOrigin.startsWith('https:')
}

export interface SessionLookup {
  user: UserRecord
  tokenHash: string
  /** the session's expiry was just extended: re-send the cookie so the browser keeps it as long */
  extended: boolean
}

/** Create a session row and return the raw token (to be put in the cookie) and its hash. */
export function createSession(db: Db, config: Config, userId: string): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString('base64url')
  const tokenHash = hashToken(token)
  db.sessions.create(tokenHash, userId, sessionTtlMs(config))
  return { token, tokenHash }
}

/**
 * Resolve a raw token to its user; null when unknown/expired or the user no longer exists.
 * With `ttlMs` a session last seen more than EXTEND_INTERVAL_MS ago is extended (sliding expiry);
 * without it (WebSocket upgrades, which cannot re-send the cookie) it is only touched.
 */
export function lookupSession(db: Db, token: string | undefined | null, ttlMs?: number): SessionLookup | null {
  if (!token || token.length > 128 || !/^[A-Za-z0-9_-]+$/.test(token)) return null
  const tokenHash = hashToken(token)
  const session = db.sessions.get(tokenHash)
  if (!session) return null
  const user = db.users.get(session.userId)
  if (!user) {
    db.sessions.delete(tokenHash)
    return null
  }
  let extended = false
  if (Date.now() - session.lastSeenAt > EXTEND_INTERVAL_MS) {
    if (ttlMs !== undefined) {
      db.sessions.extend(tokenHash, ttlMs)
      extended = true
    } else {
      db.sessions.touch(tokenHash)
    }
  }
  return { user, tokenHash, extended }
}

/** Resolve the session of a raw `Cookie` header (WebSocket upgrades). */
export function sessionFromCookieHeader(db: Db, cookieHeader: string | undefined | null): SessionLookup | null {
  return lookupSession(db, readSessionToken(cookieHeader))
}

export function destroySession(db: Db, tokenHash: string): void {
  db.sessions.delete(tokenHash)
}

/** Read the session token from a raw `Cookie` header. */
export function readSessionToken(cookieHeader: string | undefined | null): string | null {
  if (!cookieHeader) return null
  try {
    return parseCookie(cookieHeader)[SESSION_COOKIE] ?? null
  } catch {
    return null
  }
}

/** Resolve the user of a raw `Cookie` header (WebSocket upgrades). */
export function userFromCookieHeader(db: Db, cookieHeader: string | undefined | null): UserRecord | null {
  return lookupSession(db, readSessionToken(cookieHeader))?.user ?? null
}

/**
 * `Set-Cookie` value that stores the session token. The cookie is `Secure` when PUBLIC_ORIGIN is
 * https or the request itself arrived over TLS (directly or through a loopback reverse proxy).
 */
export function sessionCookie(config: Config, token: string, secureRequest = false): string {
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isHttps(config) || secureRequest,
    maxAge: Math.floor(sessionTtlMs(config) / 1000),
  })
}

/** `Set-Cookie` value that removes the session cookie. */
export function clearSessionCookie(config: Config, secureRequest = false): string {
  return stringifySetCookie({
    name: SESSION_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: isHttps(config) || secureRequest,
    maxAge: 0,
    expires: new Date(0),
  })
}
