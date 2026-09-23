/**
 * The single role resolution used by REST middleware and the WebSocket upgrade handler.
 */
import { ROLE_RANK, type Role } from '@folio/shared/api'
import type { Db } from '../db/index.ts'

/** Project ids are 16 url-safe characters (db newId()). */
export const ID_RE = /^[A-Za-z0-9_-]{16}$/

export function isValidId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

/** Role of `userId` in the project, or null when the project does not exist or the user is not a member. */
export function resolveRole(db: Db, projectId: string, userId: string): Role | null {
  if (!isValidId(projectId) || !userId) return null
  const project = db.projects.get(projectId)
  if (!project) return null
  if (project.ownerId === userId) return 'owner'
  return db.members.roleOf(projectId, userId)
}

/** true when `role` is at least `min` */
export function hasRole(role: Role | null | undefined, min: Role): boolean {
  return !!role && ROLE_RANK[role] >= ROLE_RANK[min]
}
