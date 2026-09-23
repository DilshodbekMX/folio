/**
 * Final Express error handler: renders ApiErrorBody for every error.
 *   HttpError → its status/code · ZodError → 400 'validation' · MulterError → 413/400 ·
 *   body-parser errors → 413/400 · other 4xx errors with a status → that status ·
 *   anything else → 500 (logged, message hidden).
 */
import type { ErrorRequestHandler } from 'express'
import multer from 'multer'
import { ZodError } from 'zod'
import type { ApiErrorBody } from '@folio/shared/api'
import { log } from '../log.ts'
import { HttpError } from './errors.ts'

function describeZod(err: ZodError): string {
  const first = err.issues[0]
  if (!first) return 'Invalid request'
  const where = first.path.length ? `${first.path.join('.')}: ` : ''
  return `${where}${first.message}`
}

export function toErrorBody(err: unknown): { status: number; body: ApiErrorBody; internal: boolean } {
  if (err instanceof HttpError) {
    return { status: err.status, body: { error: { code: err.code, message: err.message, ...(err.details !== undefined ? { details: err.details } : {}) } }, internal: err.status >= 500 }
  }
  if (err instanceof ZodError) {
    return { status: 400, body: { error: { code: 'validation', message: describeZod(err), details: err.issues } }, internal: false }
  }
  if (err instanceof multer.MulterError) {
    const tooLarge = err.code === 'LIMIT_FILE_SIZE' || err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_PART_COUNT' || err.code === 'LIMIT_FIELD_VALUE'
    return {
      status: tooLarge ? 413 : 400,
      body: { error: { code: tooLarge ? 'too_large' : 'validation', message: err.code === 'LIMIT_FILE_SIZE' ? 'File is too large' : err.message, details: { multer: err.code, field: err.field } } },
      internal: false,
    }
  }
  const e = err as { type?: string; status?: number; statusCode?: number; expose?: boolean; message?: string }
  if (e && e.type === 'entity.too.large') return { status: 413, body: { error: { code: 'too_large', message: 'Request body is too large' } }, internal: false }
  if (e && e.type === 'entity.parse.failed') return { status: 400, body: { error: { code: 'validation', message: 'Malformed JSON body' } }, internal: false }
  const status = e?.status ?? e?.statusCode
  if (typeof status === 'number' && status >= 400 && status < 500) {
    const code = status === 404 ? 'not_found' : status === 403 ? 'forbidden' : status === 401 ? 'unauthorized' : status === 413 ? 'too_large' : 'validation'
    return { status, body: { error: { code, message: e.expose && e.message ? e.message : 'Bad request' } }, internal: false }
  }
  return { status: 500, body: { error: { code: 'internal', message: 'Internal server error' } }, internal: true }
}

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  const { status, body, internal } = toErrorBody(err)
  if (internal) log.error({ err, method: req.method, url: req.originalUrl }, 'request failed')
  if (res.headersSent) {
    next(err)
    return
  }
  res.status(status).json(body)
}
