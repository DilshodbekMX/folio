/**
 * Auth routes: setup-status, first-run setup (first user = admin), register (ALLOW_SIGNUP),
 * login, logout, me, updateMe (name, settings merge, password change with currentPassword).
 */
import express, { type Request, type Response } from 'express'
import { z } from 'zod'
import type { Me, SetupStatus, UserSettings } from '@folio/shared/api'
import { toPublic, type UserRecord } from '../db/index.ts'
import { badRequest, conflict, forbidden, unauthorized } from '../http/errors.ts'
import { getUser } from '../http/request.ts'
import { moduleLog } from '../log.ts'
import { authRateLimiter } from '../http/rate-limit.ts'
import type { Services } from '../services.ts'
import { requireUser } from './middleware.ts'
import { burnVerification, hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, needsRehash, verifyPassword } from './passwords.ts'
import { clearSessionCookie, createSession, destroySession, sessionCookie } from './sessions.ts'
import { closeSessionSockets } from './live.ts'

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

const log = moduleLog('auth')

export const emailSchema = z.string().trim().min(3).max(254)
  .regex(/^[^\s@]+@[^\s@]+$/, 'Invalid email address')
export const displayNameSchema = z.string().trim().min(1, 'Name is required').max(100)
  .refine(v => !CONTROL.test(v), 'Name contains control characters')
export const passwordSchema = z.string()
  .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`)
  .max(MAX_PASSWORD_LENGTH, `Password must be at most ${MAX_PASSWORD_LENGTH} characters`)

const registerSchema = z.object({ email: emailSchema, password: passwordSchema, name: displayNameSchema })
const loginSchema = z.object({ email: z.string().trim().max(254), password: z.string().max(MAX_PASSWORD_LENGTH) })

export const userSettingsSchema = z.object({
  theme: z.enum(['light', 'dark', 'system']),
  editorTheme: z.enum(['auto', 'light', 'one-dark']),
  fontSize: z.number().int().min(10).max(24),
  fontFamily: z.enum(['monospace', 'dejavu', 'source-code', 'fira-code', 'jetbrains-mono']),
  lineHeight: z.enum(['compact', 'normal', 'wide']),
  keybindings: z.enum(['default', 'vim', 'emacs']),
  autoComplete: z.boolean(),
  autoCloseBrackets: z.boolean(),
  spellCheck: z.boolean(),
  lineWrapping: z.boolean(),
  equationPreview: z.boolean(),
  pdfZoom: z.string().max(16).regex(/^(page-width|page-fit|page-height|page-actual|auto|\d{1,2}(\.\d{1,3})?)$/, 'Invalid zoom value'),
}).partial().strict()

const updateMeSchema = z.object({
  name: displayNameSchema.optional(),
  settings: userSettingsSchema.optional(),
  password: passwordSchema.optional(),
  currentPassword: z.string().max(MAX_PASSWORD_LENGTH).optional(),
}).strict()

export function toMe(u: UserRecord): Me {
  return { ...toPublic(u), isAdmin: u.isAdmin, settings: u.settings, createdAt: u.createdAt }
}

/** Start a fresh session for `user` (rotating away the request's current one). */
function startSession(s: Services, req: Request, res: Response, user: UserRecord): void {
  if (req.sessionTokenHash) destroySession(s.db, req.sessionTokenHash)
  const { token, tokenHash } = createSession(s.db, s.config, user.id)
  req.user = user
  req.sessionTokenHash = tokenHash
  res.append('Set-Cookie', sessionCookie(s.config, token, req.secure))
}

function isUniqueViolation(err: unknown): boolean {
  return !!err && typeof err === 'object' && String((err as { code?: string }).code).startsWith('SQLITE_CONSTRAINT')
}

export function authRoutes(s: Services): express.Router {
  const r = express.Router()
  const limiter = authRateLimiter()

  r.get('/api/auth/setup-status', (_req, res) => {
    const body: SetupStatus = { needsSetup: s.db.users.count() === 0, allowSignup: s.config.allowSignup, version: s.config.version }
    res.setHeader('Cache-Control', 'no-store')
    res.json(body)
  })

  r.post('/api/auth/setup', limiter, async (req, res) => {
    const body = registerSchema.parse(req.body)
    if (s.db.users.count() > 0) throw forbidden('Setup has already been completed')
    const passwordHash = await hashPassword(body.password)
    // re-check inside a transaction: two concurrent setup requests must not both create an admin
    const user = s.db.transaction(() => {
      if (s.db.users.count() > 0) throw forbidden('Setup has already been completed')
      return s.db.users.create({ email: body.email, name: body.name, passwordHash, isAdmin: true })
    })
    startSession(s, req, res, user)
    res.json(toMe(user))
  })

  r.post('/api/auth/register', limiter, async (req, res) => {
    if (s.db.users.count() === 0) throw forbidden('Complete the first-run setup first')
    if (!s.config.allowSignup) throw forbidden('Self-registration is disabled on this server')
    const body = registerSchema.parse(req.body)
    if (s.db.users.getByEmail(body.email)) throw conflict('An account with this email already exists')
    const passwordHash = await hashPassword(body.password)
    let user: UserRecord
    try {
      user = s.db.users.create({ email: body.email, name: body.name, passwordHash })
    } catch (err) {
      if (isUniqueViolation(err)) throw conflict('An account with this email already exists')
      throw err
    }
    startSession(s, req, res, user)
    res.json(toMe(user))
  })

  r.post('/api/auth/login', limiter, async (req, res) => {
    const body = loginSchema.parse(req.body)
    const user = s.db.users.getByEmail(body.email)
    const ok = user ? await verifyPassword(body.password, user.passwordHash) : await burnVerification(body.password)
    if (!user || !ok) {
      log.info({ ip: req.ip, email: body.email, knownAccount: !!user }, 'login failed')
      throw unauthorized('Invalid email or password')
    }
    let current = user
    if (needsRehash(user.passwordHash)) current = s.db.users.update(user.id, { passwordHash: await hashPassword(body.password) }) ?? user
    startSession(s, req, res, current)
    res.json(toMe(current))
  })

  r.post('/api/auth/logout', (req, res) => {
    if (req.sessionTokenHash) {
      destroySession(s.db, req.sessionTokenHash)
      // the editor tabs of this browser session lose their realtime connections too
      closeSessionSockets(s, [req.sessionTokenHash])
    }
    req.user = undefined
    req.sessionTokenHash = undefined
    res.append('Set-Cookie', clearSessionCookie(s.config, req.secure))
    // build files (PDFs, logs) are served `private, immutable`: drop them from this browser's HTTP
    // cache, so the next person on a shared computer cannot open them from it
    res.set('Clear-Site-Data', '"cache"')
    res.status(204).end()
  })

  r.get('/api/auth/me', requireUser, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(toMe(getUser(req)))
  })

  r.patch('/api/auth/me', requireUser, async (req, res) => {
    const user = getUser(req)
    const body = updateMeSchema.parse(req.body ?? {})
    const patch: Partial<Pick<UserRecord, 'name' | 'settings' | 'passwordHash'>> = {}
    if (body.name !== undefined) patch.name = body.name
    if (body.settings) patch.settings = { ...user.settings, ...(body.settings as Partial<UserSettings>) }
    if (body.password !== undefined) {
      if (!body.currentPassword) throw badRequest('Enter your current password to set a new one')
      if (!(await verifyPassword(body.currentPassword, user.passwordHash))) throw badRequest('Current password is incorrect', { field: 'currentPassword' })
      patch.passwordHash = await hashPassword(body.password)
    }
    const updated = Object.keys(patch).length ? s.db.users.update(user.id, patch) ?? user : user
    // a password change signs out every other session of the account (and closes their sockets)
    if (patch.passwordHash) {
      const others = s.db.sessions.hashesForUser(user.id).filter(h => h !== req.sessionTokenHash)
      s.db.sessions.deleteForUser(user.id, req.sessionTokenHash)
      closeSessionSockets(s, others)
    }
    req.user = updated
    res.json(toMe(updated))
  })

  return r
}
