/**
 * Sharing (SPEC §4.7): members (owner manages; a member may remove self), link sharing
 * (editor / view-only tokens, 18 random bytes base64url, regenerate/disable), token info and
 * join (adds membership with the link's role, never downgrades).
 * Role change / removal → sockets of that user closed with 4403 + 'access:changed' and
 * 'members:changed' broadcasts.
 */
import { randomBytes } from 'node:crypto'
import express from 'express'
import { z } from 'zod'
import { ROLE_RANK, type JoinResponse, type Member, type Role, type ShareInfo, type ShareLinks, type ShareTokenInfo } from '@folio/shared/api'
import { toPublic } from '../db/index.ts'
import { badRequest, forbidden, notFound } from '../http/errors.ts'
import { getProject, getUser, param } from '../http/request.ts'
import { joinRateLimiter } from '../http/rate-limit.ts'
import { requireProjectRole, requireUser } from '../auth/middleware.ts'
import { resolveRole } from '../access/roles.ts'
import { safely } from '../files/service.ts'
import { leaveProject, listMembers, revokeLiveAccess } from '../projects/service.ts'
import type { Services } from '../services.ts'

const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/

const addMemberSchema = z.object({ email: z.string().trim().min(3).max(254), role: z.enum(['editor', 'viewer']) }).strict()
const roleSchema = z.object({ role: z.enum(['editor', 'viewer']) }).strict()

export function newShareToken(): string {
  return randomBytes(18).toString('base64url')
}

function memberOf(s: Services, projectId: string, userId: string): Member {
  const m = s.db.members.get(projectId, userId)
  const u = s.db.users.get(userId)
  if (!m || !u) throw notFound('Member not found')
  return { user: toPublic(u), role: m.role, addedAt: m.addedAt }
}

function linksOf(s: Services, projectId: string): ShareLinks {
  return s.db.shareLinks.get(projectId)
}

function membersChanged(s: Services, projectId: string): void {
  safely('meta.broadcast', () => s.meta.broadcast(projectId, { type: 'members:changed' }))
}

export function shareRoutes(s: Services): express.Router {
  const r = express.Router()
  const joinLimiter = joinRateLimiter()

  r.get('/api/projects/:pid/share', requireProjectRole('viewer'), (req, res) => {
    const { project, role } = getProject(req)
    const info: ShareInfo = { members: listMembers(s, project.id), links: role === 'owner' ? linksOf(s, project.id) : null }
    res.setHeader('Cache-Control', 'no-store')
    res.json(info)
  })

  r.post('/api/projects/:pid/members', requireProjectRole('owner'), (req, res) => {
    const { project } = getProject(req)
    const body = addMemberSchema.parse(req.body ?? {})
    const user = s.db.users.getByEmail(body.email)
    if (!user) throw notFound(`No user with the email address ${body.email}`)
    if (user.id === project.ownerId) throw badRequest('The owner already has full access')
    const before = s.db.members.roleOf(project.id, user.id)
    s.db.members.upsert(project.id, user.id, body.role)
    if (before && before !== body.role) revokeLiveAccess(s, project.id, user.id)
    membersChanged(s, project.id)
    res.status(before ? 200 : 201).json(memberOf(s, project.id, user.id))
  })

  r.patch('/api/projects/:pid/members/:userId', requireProjectRole('owner'), (req, res) => {
    const { project } = getProject(req)
    const userId = param(req, 'userId')
    const body = roleSchema.parse(req.body ?? {})
    if (userId === project.ownerId) throw badRequest("The owner's role cannot be changed")
    const before = s.db.members.roleOf(project.id, userId)
    if (!before) throw notFound('Member not found')
    if (before !== body.role) {
      s.db.members.upsert(project.id, userId, body.role)
      revokeLiveAccess(s, project.id, userId)
      membersChanged(s, project.id)
    }
    res.json(memberOf(s, project.id, userId))
  })

  r.delete('/api/projects/:pid/members/:userId', requireProjectRole('viewer'), (req, res) => {
    const { project, role } = getProject(req)
    const me = getUser(req)
    const userId = param(req, 'userId')
    if (userId === project.ownerId) throw badRequest('The owner cannot be removed from the project')
    if (userId !== me.id && role !== 'owner') throw forbidden('Only the project owner can remove other members')
    if (!s.db.members.roleOf(project.id, userId)) throw notFound('Member not found')
    leaveProject(s, project.id, userId)
    res.status(204).end()
  })

  r.post('/api/projects/:pid/share-links', requireProjectRole('owner'), (req, res) => {
    const { project } = getProject(req)
    const body = roleSchema.parse(req.body ?? {})
    s.db.shareLinks.set(project.id, body.role, newShareToken())
    res.json(linksOf(s, project.id))
  })

  r.delete('/api/projects/:pid/share-links/:role', requireProjectRole('owner'), (req, res) => {
    const { project } = getProject(req)
    const role = roleSchema.shape.role.parse(param(req, 'role'))
    s.db.shareLinks.delete(project.id, role)
    res.json(linksOf(s, project.id))
  })

  r.get('/api/share/:token', requireUser, (req, res) => {
    const token = param(req, 'token')
    const link = TOKEN_RE.test(token) ? s.db.shareLinks.byToken(token) : null
    const project = link ? s.db.projects.get(link.projectId) : null
    if (!link || !project) throw notFound('This link is invalid or has been disabled')
    const owner = s.db.users.get(project.ownerId)
    const current = resolveRole(s.db, project.id, getUser(req).id)
    const info: ShareTokenInfo = {
      projectId: project.id,
      projectName: project.name,
      owner: owner ? toPublic(owner) : { id: project.ownerId, name: 'Unknown user', email: '', color: '#888888' },
      role: link.role,
      alreadyMember: !!current && ROLE_RANK[current] >= ROLE_RANK[link.role],
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json(info)
  })

  r.post('/api/share/:token/join', joinLimiter, requireUser, (req, res) => {
    const token = param(req, 'token')
    const link = TOKEN_RE.test(token) ? s.db.shareLinks.byToken(token) : null
    const project = link ? s.db.projects.get(link.projectId) : null
    if (!link || !project) throw notFound('This link is invalid or has been disabled')
    const user = getUser(req)
    const current = resolveRole(s.db, project.id, user.id)
    let role: Role = current ?? link.role
    if (!current || ROLE_RANK[current] < ROLE_RANK[link.role]) {
      s.db.members.upsert(project.id, user.id, link.role)
      role = link.role
      // an upgraded viewer's open sockets are read-only: make them reconnect with the new role
      if (current) revokeLiveAccess(s, project.id, user.id)
      membersChanged(s, project.id)
    }
    const out: JoinResponse = { projectId: project.id, role }
    res.json(out)
  })

  return r
}
