/**
 * Project chat (SPEC §4.7): paginated history (ascending, `before` = message id exclusive) and
 * posting (≤ 5000 chars; stored, then broadcast as 'chat:message' through the meta room).
 */
import express from 'express'
import { z } from 'zod'
import type { ChatListResponse, ChatMessage, UserPublic } from '@folio/shared/api'
import { toPublic, type ChatRecord } from '../db/index.ts'
import { getProject, getUser } from '../http/request.ts'
import { requireProjectRole } from '../auth/middleware.ts'
import { safely } from '../files/service.ts'
import type { Services } from '../services.ts'

export const MAX_CHAT_LENGTH = 5000
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200

const listQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
})
const postSchema = z.object({
  content: z.string().trim().min(1, 'Message is empty').max(MAX_CHAT_LENGTH, `Messages are limited to ${MAX_CHAT_LENGTH} characters`),
}).strict()

export function chatRoutes(s: Services): express.Router {
  const r = express.Router()

  function toMessage(rec: ChatRecord, cache: Map<string, UserPublic>): ChatMessage {
    let user = cache.get(rec.userId)
    if (!user) {
      const u = s.db.users.get(rec.userId)
      user = u ? toPublic(u) : { id: rec.userId, name: 'Deleted user', email: '', color: '#888888' }
      cache.set(rec.userId, user)
    }
    return { id: rec.id, user, content: rec.content, createdAt: rec.createdAt }
  }

  r.get('/api/projects/:pid/chat', requireProjectRole('viewer'), (req, res) => {
    const { project } = getProject(req)
    const q = listQuery.parse(req.query)
    const limit = q.limit ?? DEFAULT_LIMIT
    const rows = s.db.chat.list(project.id, q.before ?? null, limit + 1)
    const hasMore = rows.length > limit
    const cache = new Map<string, UserPublic>()
    const out: ChatListResponse = { messages: (hasMore ? rows.slice(1) : rows).map(m => toMessage(m, cache)), hasMore }
    res.setHeader('Cache-Control', 'no-store')
    res.json(out)
  })

  r.post('/api/projects/:pid/chat', requireProjectRole('viewer'), (req, res) => {
    const { project } = getProject(req)
    const body = postSchema.parse(req.body ?? {})
    const rec = s.db.chat.create(project.id, getUser(req).id, body.content)
    const message = toMessage(rec, new Map())
    safely('meta.broadcast', () => s.meta.broadcast(project.id, { type: 'chat:message', message }))
    res.status(201).json(message)
  })

  return r
}
