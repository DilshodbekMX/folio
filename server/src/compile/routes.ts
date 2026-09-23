/**
 * Compile routes (SPEC §4.5, ROUTES in shared/src/api.ts):
 *
 *   POST   /api/projects/:pid/compile                 viewer+  CompileRequest → CompileResponse
 *   POST   /api/projects/:pid/compile/stop            editor+  → 204
 *   DELETE /api/projects/:pid/compile/cache           editor+  → 204 (409 while a compile runs)
 *   GET    /api/projects/:pid/compile/last            viewer+  → CompileResponse | 204
 *          ?rootFileId=<id>  the newest build of that root document (204 when none / unknown)
 *          ?main=1           the newest build of the main document (settings, else auto-detected)
 *   GET    /api/projects/:pid/builds/:buildId/:file   viewer+  → bytes (Range, immutable caching)
 *   GET    /api/projects/:pid/wordcount?rootFileId    viewer+  → WordCountResponse
 *   GET    /api/projects/:pid/files/:fileId/preview   viewer+  → image/png (EPS/PS via Ghostscript)
 *
 * Handlers reach the CompileService through the container (`s.compile`) at request time.
 *
 * Deviation from SPEC §4.5 ("compile (editor+)"): like Overleaf, read-only members may compile
 * (a compile only writes the build cache; it compiles the server's copy, and viewers have no
 * edits of their own). "Recompile from scratch", stop and "Clear cached files" stay editor+.
 */
import path from 'node:path'
import { Router, type Response } from 'express'
import { z } from 'zod'
import { requireProjectRole } from '../auth/middleware.ts'
import { forbidden, notFound } from '../http/errors.ts'
import { getProject, getPublicUser, param } from '../http/request.ts'
import type { Services } from '../services.ts'
import { outputType } from './outputs.ts'

const compileBody = z.object({
  rootFileId: z.string().min(1).max(64).optional(),
  draft: z.boolean().optional(),
  stopOnFirstError: z.boolean().optional(),
  auto: z.boolean().optional(),
  fromScratch: z.boolean().optional(),
})

const wordCountQuery = z.object({
  rootFileId: z.string().min(1).max(64).optional(),
})

const lastQuery = z.object({
  rootFileId: z.string().min(1).max(64).optional(),
  main: z.enum(['1', 'true', '0', 'false']).optional(),
})

const TEXT_OUTPUTS = new Set(['log', 'blg', 'aux', 'bbl', 'out', 'toc', 'fls', 'lof', 'lot', 'bcf', 'xml', 'txt', 'stdout'])

function contentTypeOf(file: string): string {
  const type = outputType(file)
  if (type === 'pdf') return 'application/pdf'
  if (type === 'synctex.gz' || type === 'gz') return 'application/gzip'
  if (type === 'json') return 'application/json; charset=utf-8'
  if (TEXT_OUTPUTS.has(type)) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

function sendFile(res: Response, abs: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // root = the build dir, so the dot-file rule applies to the file name only (not the data dir)
    const opts = { root: path.dirname(abs), dotfiles: 'deny' as const, acceptRanges: true, cacheControl: false, lastModified: true }
    res.sendFile(path.basename(abs), opts, err => {
      if (!err) return resolve()
      // client went away mid-transfer: nothing left to answer
      if (res.headersSent) return resolve()
      reject(err)
    })
  })
}

export function compileRoutes(s: Services): Router {
  const r = Router()

  r.post('/api/projects/:pid/compile', requireProjectRole('viewer'), async (req, res) => {
    const body = compileBody.parse(req.body ?? {})
    const { project, role } = getProject(req)
    if (role === 'viewer' && body.fromScratch) throw forbidden('Only editors can recompile from scratch')
    const result = await s.compile.compile(project.id, getPublicUser(req), body)
    res.json(result)
  })

  r.post('/api/projects/:pid/compile/stop', requireProjectRole('editor'), async (req, res) => {
    await s.compile.stop(getProject(req).project.id)
    res.status(204).end()
  })

  r.delete('/api/projects/:pid/compile/cache', requireProjectRole('editor'), async (req, res) => {
    await s.compile.clearCache(getProject(req).project.id)
    res.status(204).end()
  })

  r.get('/api/projects/:pid/compile/last', requireProjectRole('viewer'), async (req, res) => {
    const q = lastQuery.parse(req.query)
    const pid = getProject(req).project.id
    let last: Awaited<ReturnType<typeof s.compile.lastBuild>> = null
    if (q.rootFileId) {
      // a document that no longer exists (or is not a text file) has no builds
      const f = s.files.get(pid, q.rootFileId)
      last = f && f.kind === 'text' ? await s.compile.lastBuild(pid, { rootPath: f.path }) : null
    } else {
      last = await s.compile.lastBuild(pid, q.main === '1' || q.main === 'true' ? { main: true } : {})
    }
    res.set('Cache-Control', 'no-store')
    if (!last) {
      res.status(204).end()
      return
    }
    res.json(last)
  })

  r.get('/api/projects/:pid/builds/:buildId/:file', requireProjectRole('viewer'), async (req, res) => {
    const { project } = getProject(req)
    const file = param(req, 'file')
    const abs = s.compile.resolveBuildFile(project.id, param(req, 'buildId'), file)
    if (!abs) throw notFound('Output file not found')
    res.set({
      'Content-Type': contentTypeOf(file),
      'Cache-Control': 'private, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Disposition': `inline; filename="${file}"`,
    })
    await sendFile(res, abs)
  })

  r.get('/api/projects/:pid/wordcount', requireProjectRole('viewer'), async (req, res) => {
    const q = wordCountQuery.parse(req.query)
    const result = await s.compile.wordCount(getProject(req).project.id, q.rootFileId)
    res.set('Cache-Control', 'no-store')
    res.json(result)
  })

  r.get('/api/projects/:pid/files/:fileId/preview', requireProjectRole('viewer'), async (req, res) => {
    const png = await s.compile.renderPreview(getProject(req).project.id, param(req, 'fileId'))
    res.set({
      'Content-Type': 'image/png',
      'Cache-Control': 'private, no-cache',
      'X-Content-Type-Options': 'nosniff',
    })
    // Express derives an ETag from the body and answers 304 for a fresh If-None-Match
    res.send(png)
  })

  return r
}
