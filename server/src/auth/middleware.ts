/**
 * Authentication / authorisation middleware (SPEC §4.2).
 *
 * The middleware find the Services container on `req.app.locals.services` (set by the app
 * factory in http/app.ts), so route modules can use `requireProjectRole('editor')` without
 * threading the container through.
 *
 *   loadSession              cookie → req.user / req.sessionTokenHash (never fails); slides the
 *                            session's expiry (≤ 1×/hour) and then re-sends the cookie
 *   requireUser              401 unless logged in
 *   requireAdmin             401 / 403 unless an admin
 *   requireProjectRole(min)  :pid → req.project + req.role; non-member → 404, insufficient role → 403
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express'
import type { Role } from '@folio/shared/api'
import type { Services } from '../services.ts'
import { forbidden, HttpError, notFound, unauthorized } from '../http/errors.ts'
import { hasRole, isValidId, resolveRole } from '../access/roles.ts'
import { lookupSession, readSessionToken, sessionCookie, sessionTtlMs } from './sessions.ts'

export function getServices(req: Request): Services {
  const s = req.app.locals.services as Services | undefined
  if (!s) throw new HttpError(500, 'internal', 'Services container missing (app.locals.services)')
  return s
}

export const loadSession: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
  const s = getServices(req)
  const token = readSessionToken(req.headers.cookie)
  const found = lookupSession(s.db, token, sessionTtlMs(s.config))
  if (found) {
    req.user = found.user
    req.sessionTokenHash = found.tokenHash
    // sliding session: keep the browser's cookie alive as long as the extended db row
    if (found.extended && token) res.append('Set-Cookie', sessionCookie(s.config, token, req.secure))
  }
  next()
}

export const requireUser: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized())
  next()
}

export const requireAdmin: RequestHandler = (req, _res, next) => {
  if (!req.user) return next(unauthorized())
  if (!req.user.isAdmin) return next(forbidden('Administrator access required'))
  next()
}

/** Resolve :pid and require at least `min`. Also requires a logged-in user. */
export function requireProjectRole(min: Role): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(unauthorized())
    const pid = (req.params as Record<string, unknown>).pid
    if (!isValidId(pid)) return next(notFound('Project not found'))
    const s = getServices(req)
    const project = s.db.projects.get(pid)
    const role = project ? resolveRole(s.db, pid, req.user.id) : null
    if (!project || !role) return next(notFound('Project not found'))
    if (!hasRole(role, min)) {
      return next(forbidden(min === 'owner' ? 'Only the project owner can do that' : min === 'editor' ? 'You have read-only access to this project' : undefined))
    }
    req.project = project
    req.role = role
    next()
  }
}
