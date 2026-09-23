/**
 * SyncTeX routes (ROUTES.syncCode / ROUTES.syncPdf in shared/src/api.ts), viewer+:
 *
 *   GET /api/projects/:pid/synctex/code?buildId&path&line&column   → SyncCodeToPdfResponse
 *   GET /api/projects/:pid/synctex/pdf?buildId&page&x&y            → SyncPdfToCodeResponse
 *
 * Query parameters are validated strictly (single values; integers as digits only, coordinates
 * as plain decimals); handlers reach the SynctexService through the container at request time.
 */
import { Router, type Request } from 'express'
import { normalizePath, validatePath } from '@folio/shared/paths'
import { requireProjectRole } from '../auth/middleware.ts'
import { badRequest } from '../http/errors.ts'
import { getProject } from '../http/request.ts'
import type { Services } from '../services.ts'

const BUILD_ID_RE = /^[0-9a-f]{8,}-[0-9a-f]{16}$/
const INT_RE = /^\d{1,9}$/
const FLOAT_RE = /^-?\d{1,7}(?:\.\d{1,12})?$/
/** coordinates are PDF points; the largest PDF page is 14400 pt */
const MAX_COORD = 100_000

function single(req: Request, name: string, required: boolean): string | undefined {
  const v = (req.query as Record<string, unknown>)[name]
  if (v === undefined || v === '') {
    if (required) throw badRequest(`Missing query parameter ${name}`)
    return undefined
  }
  if (typeof v !== 'string') throw badRequest(`Query parameter ${name} must be given once`)
  return v
}

function intParam(req: Request, name: string, min: number, max: number, def?: number): number {
  const v = single(req, name, def === undefined)
  if (v === undefined) return def!
  if (!INT_RE.test(v)) throw badRequest(`${name} must be an integer`)
  const n = Number(v)
  if (n < min || n > max) throw badRequest(`${name} must be between ${min} and ${max}`)
  return n
}

function floatParam(req: Request, name: string): number {
  const v = single(req, name, true)!
  if (!FLOAT_RE.test(v)) throw badRequest(`${name} must be a number`)
  const n = Number(v)
  if (!Number.isFinite(n) || Math.abs(n) > MAX_COORD) throw badRequest(`${name} is out of range`)
  return n
}

function buildIdParam(req: Request): string {
  const v = single(req, 'buildId', true)!
  if (!BUILD_ID_RE.test(v)) throw badRequest('Invalid buildId')
  return v
}

function pathParam(req: Request): string {
  const raw = single(req, 'path', true)!
  if (raw.length > 1024) throw badRequest('path is too long')
  const p = normalizePath(raw)
  const err = validatePath(p)
  if (err) throw badRequest(`Invalid path: ${err}`)
  return p
}

export function synctexRoutes(s: Services): Router {
  const r = Router()

  r.get('/api/projects/:pid/synctex/code', requireProjectRole('viewer'), async (req, res) => {
    const { project } = getProject(req)
    const buildId = buildIdParam(req)
    const path = pathParam(req)
    const line = intParam(req, 'line', 1, 10_000_000)
    const column = intParam(req, 'column', 0, 1_000_000, 0)
    const out = await s.synctex.codeToPdf(project.id, buildId, path, line, column)
    res.setHeader('Cache-Control', 'private, no-store')
    res.json(out)
  })

  r.get('/api/projects/:pid/synctex/pdf', requireProjectRole('viewer'), async (req, res) => {
    const { project } = getProject(req)
    const buildId = buildIdParam(req)
    const page = intParam(req, 'page', 1, 100_000)
    const x = floatParam(req, 'x')
    const y = floatParam(req, 'y')
    const out = await s.synctex.pdfToCode(project.id, buildId, page, x, y)
    res.setHeader('Cache-Control', 'private, no-store')
    res.json(out)
  })

  return r
}
