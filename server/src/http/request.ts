/**
 * Request context populated by the auth middleware (auth/middleware.ts):
 *   requireUser                 → req.user
 *   requireProjectRole(min)     → req.user, req.project, req.role
 * Route modules read it through these getters (they throw 401/500 when misused).
 */
import type { Request } from 'express'
import type { Role, UserPublic } from '@folio/shared/api'
import { toPublic, type ProjectRecord, type UserRecord } from '../db/index.ts'
import { HttpError, unauthorized } from './errors.ts'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: UserRecord
      /** sha256 hex of the session token of this request */
      sessionTokenHash?: string
      project?: ProjectRecord
      role?: Role
    }
  }
}

export function getUser(req: Request): UserRecord {
  if (!req.user) throw unauthorized()
  return req.user
}

export function getPublicUser(req: Request): UserPublic {
  return toPublic(getUser(req))
}

export function getProject(req: Request): { project: ProjectRecord; role: Role } {
  if (!req.project || !req.role) throw new HttpError(500, 'internal', 'requireProjectRole middleware missing')
  return { project: req.project, role: req.role }
}

/** Express 5 params may be string | string[] (wildcards); always read single params through this. */
export function param(req: Request, name: string): string {
  const v = (req.params as Record<string, string | string[] | undefined>)[name]
  if (typeof v !== 'string' || v.length === 0) throw new HttpError(400, 'validation', `Missing parameter ${name}`)
  return v
}
