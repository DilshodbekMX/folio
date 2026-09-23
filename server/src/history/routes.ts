/**
 * History REST routes (SPEC §4.6, api.ts ROUTES history*):
 *   viewer+: historyVersions, historyFiles, historyFile, historyDownload, historyDiff
 *   editor+: historyRestore, historySnapshot, createLabel, deleteLabel
 */
import { Router, type Request, type Response } from 'express'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { z } from 'zod'
import type { CreateLabelRequest, HistoryListResponse, Label, RestoreRequest, RestoreResponse } from '@folio/shared/api'
import { classifyByName, isBrowserImage, mimeFor } from '@folio/shared/filetypes'
import { basename, extname } from '@folio/shared/paths'
import type { Services } from '../services.ts'
import { requireProjectRole } from '../auth/middleware.ts'
import { notFound } from '../http/errors.ts'
import { getProject, getPublicUser, param } from '../http/request.ts'
import { FULL_SHA_RE, REV_RE } from './git.ts'

const BASE = '/api/projects/:pid/history'

const versionId = z.string().regex(REV_RE, 'Invalid version id')
const pathString = z.string().min(1).max(1024)
const flag = z.enum(['0', '1', 'true', 'false']).optional()

const listQuery = z.object({
  before: versionId.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
const fileQuery = z.object({ path: pathString, download: flag })
const diffQuery = z.object({ to: versionId, from: versionId.optional(), path: pathString })
const restoreBody = z.object({ versionId, path: pathString.optional() }) satisfies z.ZodType<RestoreRequest>
const labelBody = z.object({ name: z.string().trim().min(1).max(200), versionId: versionId.optional() }) satisfies z.ZodType<CreateLabelRequest>

export function historyRoutes(s: Services): Router {
  const r = Router()
  const viewer = requireProjectRole('viewer')
  const editor = requireProjectRole('editor')

  r.get(`${BASE}/versions`, viewer, async (req: Request, res: Response) => {
    const { project } = getProject(req)
    const q = listQuery.parse(req.query)
    const out: HistoryListResponse = await s.history.list(project.id, { before: q.before, limit: q.limit })
    res.set('Cache-Control', 'no-store').json(out)
  })

  r.get(`${BASE}/versions/:versionId/files`, viewer, async (req, res) => {
    const { project } = getProject(req)
    const v = versionId.parse(param(req, 'versionId'))
    res.set('Cache-Control', 'no-store').json(await s.history.files(project.id, v))
  })

  r.get(`${BASE}/versions/:versionId/file`, viewer, async (req, res) => {
    const { project } = getProject(req)
    const v = versionId.parse(param(req, 'versionId'))
    const q = fileQuery.parse(req.query)
    const bytes = await s.history.fileAt(project.id, v, q.path)
    if (!bytes) throw notFound('File not found in this version')
    const name = basename(q.path)
    const download = q.download === '1' || q.download === 'true'
    // Attacker-controlled bytes: inline only for PDFs and raster images; everything else
    // (including SVG and HTML) is an attachment, never sniffed, SVG additionally sandboxed.
    const isSvg = extname(q.path) === 'svg'
    const inline = !download && !isSvg && (extname(q.path) === 'pdf' || isBrowserImage(q.path))
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('Content-Type', classifyByName(q.path) === 'text' ? 'text/plain; charset=utf-8' : mimeFor(q.path))
    res.set('Content-Disposition', contentDisposition(inline ? 'inline' : 'attachment', name))
    if (isSvg) res.set('Content-Security-Policy', 'sandbox')
    // A full sha names immutable content; HEAD / abbreviations may move.
    res.set('Cache-Control', FULL_SHA_RE.test(v) ? 'private, max-age=31536000, immutable' : 'private, no-cache')
    res.send(bytes)
  })

  r.get(`${BASE}/versions/:versionId/download.zip`, viewer, async (req, res) => {
    const { project } = getProject(req)
    const v = versionId.parse(param(req, 'versionId'))
    const archive = await s.history.archive(project.id, v)
    const stream = archive as Readable
    const labels = archive.versionId ? s.db.labels.list(project.id).filter(l => l.versionId === archive.versionId) : []
    res.set('Content-Type', 'application/zip')
    res.set('X-Content-Type-Options', 'nosniff')
    res.set('Content-Disposition', contentDisposition('attachment', versionZipName(project.name, {
      labels, createdAt: archive.createdAt ?? null, fallback: v === 'HEAD' ? 'current' : v.slice(0, 7),
    })))
    res.set('Cache-Control', 'no-store')
    try {
      await pipeline(stream, res)
    } catch (err) {
      stream.destroy()
      // Client went away mid-download: nothing to report. Anything before the first byte is a real error.
      if (!res.headersSent) throw err
      res.destroy()
    }
  })

  r.get(`${BASE}/diff`, viewer, async (req, res) => {
    const { project } = getProject(req)
    const q = diffQuery.parse(req.query)
    res.set('Cache-Control', 'no-store').json(await s.history.diff(project.id, { to: q.to, from: q.from, path: q.path }))
  })

  r.post(`${BASE}/restore`, editor, async (req, res) => {
    const { project } = getProject(req)
    const body = restoreBody.parse(req.body ?? {})
    const out: RestoreResponse = await s.history.restore(project.id, getPublicUser(req), body.versionId, body.path)
    res.json(out)
  })

  r.post(`${BASE}/snapshot`, editor, async (req, res) => {
    const { project } = getProject(req)
    const versionId = await s.history.snapshot(project.id, 'manual', getPublicUser(req))
    res.json({ versionId })
  })

  r.post(`${BASE}/labels`, editor, async (req, res) => {
    const { project } = getProject(req)
    const body = labelBody.parse(req.body ?? {})
    const label: Label = await s.history.createLabel(project.id, getPublicUser(req), body.name, body.versionId)
    res.status(201).json(label)
  })

  r.delete(`${BASE}/labels/:labelId`, editor, async (req, res) => {
    const { project } = getProject(req)
    await s.history.deleteLabel(project.id, param(req, 'labelId'))
    res.status(204).end()
  })

  return r
}

/** RFC 6266 Content-Disposition with an ASCII fallback and a UTF-8 filename*. */
export function contentDisposition(type: 'inline' | 'attachment', filename: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = filename.replace(/[\u0000-\u001f\u007f"\\/]/g, '_')
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_')
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  return ascii === clean
    ? `${type}; filename="${ascii}"`
    : `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

/** Project name → a safe file name stem (keeps Unicode letters, drops separators/control chars). */
export function safeFileStem(name: string, fallback = 'project'): string {
  // eslint-disable-next-line no-control-regex
  const stem = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').replace(/^[.\s]+/, '').slice(0, 100).trim()
  return stem || fallback
}

const pad2 = (n: number) => String(n).padStart(2, '0')

/**
 * File name of a version's .zip, like the web app's (features/history/model.ts versionZipName):
 * "<project> - <label>.zip" for a labelled version (its newest label), else
 * "<project> - 2026-09-22 14.05.zip" (the commit time, in the server's time zone); the short
 * hash (or "current") only when the time is unknown.
 */
export function versionZipName(project: string, v: { labels: { name: string; createdAt: number }[]; createdAt: number | null; fallback: string }): string {
  const d = v.createdAt !== null ? new Date(v.createdAt) : null
  const when = d && !Number.isNaN(d.getTime())
    ? `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}.${pad2(d.getMinutes())}`
    : v.fallback
  const label = [...v.labels].sort((a, b) => b.createdAt - a.createdAt)[0]?.name
  return `${safeFileStem(project)} - ${label ? safeFileStem(label, when) : when}.zip`
}
