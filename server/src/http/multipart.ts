/**
 * multer 2 factory for multipart uploads: disk storage in DATA_DIR/tmp with random names,
 * UTF-8 file names, relative paths preserved (folder uploads), strict limits.
 * Callers must unlink the temp files when done (`cleanupUploads`).
 */
import { randomUUID } from 'node:crypto'
import fsp from 'node:fs/promises'
import type { Request, RequestHandler } from 'express'
import multer from 'multer'
import type { Config } from '../config.ts'
import { badRequest, HttpError } from './errors.ts'

/** Multipart framing overhead allowed on top of the file bytes of one request. */
const MULTIPART_OVERHEAD = 1024 * 1024

/**
 * Cap the size of a whole upload request before multer stores anything. multer only limits each
 * file, so without this a request of 200 × 50 MB files could fill the disk with temp files. The
 * size must be declared (every browser sends Content-Length for FormData); Node refuses bodies
 * longer than the declared length, so the cap is exact.
 */
export function limitUploadRequest(maxFileBytes: number): RequestHandler {
  const max = maxFileBytes + MULTIPART_OVERHEAD
  return (req, res, next) => {
    const declared = req.headers['content-length']
    if (declared === undefined) {
      res.setHeader('Connection', 'close')
      return next(new HttpError(411, 'length_required', 'Uploads must declare their size (Content-Length)'))
    }
    const n = Number(declared)
    if (!Number.isSafeInteger(n) || n < 0) return next(badRequest('Invalid Content-Length'))
    if (n > max) {
      // the body is not read: close the connection once the error has been sent
      res.setHeader('Connection', 'close')
      return next(new HttpError(413, 'too_large', `The upload is too large (at most ${Math.floor(maxFileBytes / 1024 / 1024)} MB per request)`))
    }
    next()
  }
}

/** Largest total of file bytes in one multi-file upload request (the zip import limit). */
export function maxUploadRequestBytes(config: Config): number {
  return Math.max(config.maxUploadBytes, 300 * 1024 * 1024)
}

export function createUploader(config: Config, maxFiles: number): multer.Multer {
  return multer({
    storage: multer.diskStorage({
      destination: config.dirs.tmp,
      filename: (_req, _file, cb) => cb(null, `upload-${randomUUID()}`),
    }),
    defParamCharset: 'utf8',
    preservePath: true,
    limits: {
      fileSize: config.maxUploadBytes,
      files: maxFiles,
      fields: 20,
      fieldSize: 64 * 1024,
      fieldNameSize: 100,
      parts: maxFiles + 20,
      headerPairs: 200,
    },
  })
}

/** Every file part multer stored for this request. */
export function uploadedFiles(req: Request): Express.Multer.File[] {
  const out: Express.Multer.File[] = []
  if (req.file) out.push(req.file)
  const files = req.files
  if (Array.isArray(files)) out.push(...files)
  else if (files) for (const list of Object.values(files)) out.push(...list)
  return out
}

export async function cleanupUploads(req: Request): Promise<void> {
  await Promise.all(uploadedFiles(req).map(f => (f.path ? fsp.unlink(f.path).catch(() => {}) : undefined)))
}
