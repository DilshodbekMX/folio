/**
 * Serving user-controlled bytes (project files, history blobs) from the app origin safely
 * (SPEC §4.2 "Uploaded/raw files"):
 *  - `X-Content-Type-Options: nosniff`, Content-Type from the extension (never from the upload);
 *  - `Content-Disposition: attachment` for everything except PDFs and raster browser images
 *    (SVG and HTML are always attachments);
 *  - a locked-down sandbox CSP on everything but PDFs (always on SVG), so even a direct
 *    navigation can't run script with the user's session.
 */
import type { Response } from 'express'
import type { Readable } from 'node:stream'
import mime from 'mime'
import { basename, extname } from '@folio/shared/paths'

const INLINE_EXT = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])
/** Types we never label as such: they would render as active content if opened. */
const NEUTRALISE = new Set([
  'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'application/javascript', 'text/javascript',
  'application/x-javascript', 'image/svg+xml', 'application/ecmascript', 'text/ecmascript',
])
export const SANDBOX_CSP = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox"

export interface UserFileOptions {
  /** project-relative path (used for the extension and the download file name) */
  path: string
  /** text files are served as UTF-8 text/plain */
  isText: boolean
  download?: boolean
}

export function contentTypeFor(p: string, isText: boolean): string {
  const ext = extname(p)
  if (ext === 'svg') return 'image/svg+xml'
  if (isText) return 'text/plain; charset=utf-8'
  const t = mime.getType(p) ?? 'application/octet-stream'
  if (NEUTRALISE.has(t)) return 'application/octet-stream'
  return t
}

/** Set the safe-serving headers for a user file (does not send the body). */
export function setUserFileHeaders(res: Response, opts: UserFileOptions): void {
  const ext = extname(opts.path)
  const name = basename(opts.path) || 'file'
  // res.attachment() also sets Content-Type from the extension, so it must come first
  if (opts.download || !INLINE_EXT.has(ext)) res.attachment(name)
  else res.setHeader('Content-Disposition', contentDispositionInline(name))
  res.setHeader('Content-Type', contentTypeFor(opts.path, opts.isText))
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
  res.setHeader('Cache-Control', 'private, no-cache')
  if (ext !== 'pdf') res.setHeader('Content-Security-Policy', SANDBOX_CSP)
}

function contentDispositionInline(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_')
  return `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`
}

export function sendUserFile(res: Response, opts: UserFileOptions, body: Buffer): void {
  setUserFileHeaders(res, opts)
  res.setHeader('Content-Length', String(body.length))
  res.end(body)
}

export function streamUserFile(res: Response, opts: UserFileOptions, stream: Readable, size: number | null): void {
  setUserFileHeaders(res, opts)
  if (size !== null) res.setHeader('Content-Length', String(size))
  stream.on('error', err => res.destroy(err))
  res.on('close', () => stream.destroy())
  stream.pipe(res)
}
