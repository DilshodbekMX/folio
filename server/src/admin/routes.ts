/**
 * Admin (isAdmin only): list / create / delete users. An admin cannot delete themself.
 * Deleting a user permanently deletes the projects they own (like Overleaf CE) and removes
 * them from shared projects (their sockets are closed with 4403).
 */
import express from 'express'
import { z } from 'zod'
import type { AdminUser } from '@folio/shared/api'
import { toPublic, type UserRecord } from '../db/index.ts'
import { badRequest, conflict, notFound } from '../http/errors.ts'
import { getUser, param } from '../http/request.ts'
import { requireAdmin } from '../auth/middleware.ts'
import { hashPassword } from '../auth/passwords.ts'
import { closeSessionSockets } from '../auth/live.ts'
import { displayNameSchema, emailSchema, passwordSchema } from '../auth/routes.ts'
import { safely } from '../files/service.ts'
import { deleteProjectForever, revokeLiveAccess } from '../projects/service.ts'
import type { Services } from '../services.ts'

const createUserSchema = z.object({
  email: emailSchema,
  name: displayNameSchema,
  password: passwordSchema,
  isAdmin: z.boolean().optional(),
}).strict()

export function toAdminUser(s: Services, u: UserRecord): AdminUser {
  const projectCount = s.db.projects.listForUser(u.id).filter(p => p.project.ownerId === u.id).length
  return { ...toPublic(u), isAdmin: u.isAdmin, createdAt: u.createdAt, projectCount }
}

/** Delete a user and everything they own (shared by the admin route and the CLI). */
export async function deleteUserCompletely(s: Services, userId: string): Promise<void> {
  // sign the user out everywhere first: their open editors get 4401 (session ended), not 4403
  const sessions = s.db.sessions.hashesForUser(userId)
  s.db.sessions.deleteForUser(userId)
  closeSessionSockets(s, sessions)
  const memberships = s.db.projects.listForUser(userId)
  for (const { project } of memberships) {
    if (project.ownerId === userId) {
      await deleteProjectForever(s, project.id)
    } else {
      s.db.members.remove(project.id, userId)
      revokeLiveAccess(s, project.id, userId)
      safely('meta.broadcast', () => s.meta.broadcast(project.id, { type: 'members:changed' }))
    }
  }
  s.db.users.delete(userId)
}

export function adminRoutes(s: Services): express.Router {
  const r = express.Router()

  r.get('/api/admin/users', requireAdmin, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(s.db.users.list().map(u => toAdminUser(s, u)))
  })

  r.post('/api/admin/users', requireAdmin, async (req, res) => {
    const body = createUserSchema.parse(req.body ?? {})
    if (s.db.users.getByEmail(body.email)) throw conflict('An account with this email already exists')
    const passwordHash = await hashPassword(body.password)
    let user: UserRecord
    try {
      user = s.db.users.create({ email: body.email, name: body.name, passwordHash, isAdmin: !!body.isAdmin })
    } catch (err) {
      if (String((err as { code?: string }).code).startsWith('SQLITE_CONSTRAINT')) throw conflict('An account with this email already exists')
      throw err
    }
    res.status(201).json(toAdminUser(s, user))
  })

  r.delete('/api/admin/users/:userId', requireAdmin, async (req, res) => {
    const userId = param(req, 'userId')
    if (userId === getUser(req).id) throw badRequest('You cannot delete your own account')
    if (!s.db.users.get(userId)) throw notFound('User not found')
    await deleteUserCompletely(s, userId)
    res.status(204).end()
  })

  return r
}
