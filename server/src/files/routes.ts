/**
 * File routes: createEntry, uploadFiles (multipart), moveEntry, deleteEntry, rawFile.
 * (GET …/files/:fileId/preview belongs to the compile module.)
 */
import fsp from 'node:fs/promises'
import express from 'express'
import { z } from 'zod'
import type { DeleteEntryResponse, FileEntry, MoveEntryResponse, UploadResponse } from '@folio/shared/api'
import { joinPath, normalizePath, validatePath } from '@folio/shared/paths'
import { badRequest, conflict, notFound } from '../http/errors.ts'
import { getPublicUser, param } from '../http/request.ts'
import { cleanupUploads, createUploader, limitUploadRequest, maxUploadRequestBytes, uploadedFiles } from '../http/multipart.ts'
import { sendUserFile, streamUserFile } from '../http/serve-file.ts'
import { requireProjectRole } from '../auth/middleware.ts'
import type { Services } from '../services.ts'
import { MAX_PROJECT_ENTRIES } from './service.ts'
import { checkProjectPath, openReadStreamNoFollow } from './storage.ts'

/** Files accepted in one upload request (Overleaf allows 180). */
export const MAX_UPLOAD_FILES = 200

const createSchema = z.object({
  path: z.string().min(1).max(1024),
  kind: z.enum(['text', 'folder']),
  content: z.string().max(4 * 1024 * 1024).optional(),
}).strict()
const moveSchema = z.object({ path: z.string().min(1).max(1024) }).strict()

export function fileRoutes(s: Services): express.Router {
  const r = express.Router()
  const upload = createUploader(s.config, MAX_UPLOAD_FILES)

  r.post('/api/projects/:pid/files', requireProjectRole('editor'), async (req, res) => {
    const body = createSchema.parse(req.body ?? {})
    const entry = await s.files.create(param(req, 'pid'), getPublicUser(req), body.path, body.kind, body.content)
    res.status(201).json(entry)
  })

  r.post('/api/projects/:pid/upload', requireProjectRole('editor'), limitUploadRequest(maxUploadRequestBytes(s.config)), upload.array('files', MAX_UPLOAD_FILES), async (req, res) => {
    const pid = param(req, 'pid')
    try {
      const parts = uploadedFiles(req)
      if (!parts.length) throw badRequest('No files were uploaded (field "files")')
      const folderRaw = typeof req.body?.folder === 'string' ? req.body.folder : ''
      const folder = normalizePath(folderRaw) ? checkProjectPath(folderRaw) : ''
      if (folder) {
        const f = s.files.getByPath(pid, folder)
        if (f && f.kind !== 'folder') throw conflict(`"${folder}" is a file, not a folder`)
      }
      const replace = req.body?.replace === 'true' || req.body?.replace === '1'
      // resolve every target path before writing anything
      const targets: { path: string; tmp: string }[] = []
      const seen = new Set<string>()
      for (const part of parts) {
        const rel = normalizePath(part.originalname)
        const target = joinPath(folder, rel)
        const err = rel ? validatePath(target) : 'File name is empty'
        if (err) throw badRequest(`Invalid file name "${part.originalname}": ${err}`, { path: part.originalname })
        if (seen.has(target)) throw badRequest(`"${target}" appears twice in the upload`)
        seen.add(target)
        targets.push({ path: target, tmp: part.path })
      }
      const existing = targets.map(t => s.files.getByPath(pid, t.path)).filter((e): e is FileEntry => !!e)
      const folders = existing.filter(e => e.kind === 'folder')
      if (folders.length) throw conflict(`"${folders[0].path}" is a folder`, { existing: folders.map(e => e.path) })
      if (existing.length && !replace) {
        throw conflict(existing.length === 1 ? `"${existing[0].path}" already exists` : `${existing.length} files already exist`, { existing: existing.map(e => e.path) })
      }
      if (s.files.list(pid).length + targets.length - existing.length > MAX_PROJECT_ENTRIES) {
        throw badRequest(`A project can contain at most ${MAX_PROJECT_ENTRIES} files and folders`)
      }
      const user = getPublicUser(req)
      const out: UploadResponse = { files: [] }
      for (const t of targets) {
        const bytes = await fsp.readFile(t.tmp)
        out.files.push(await s.files.writeFile(pid, user, t.path, bytes, { replace }))
      }
      res.json(out)
    } finally {
      await cleanupUploads(req)
    }
  })

  r.patch('/api/projects/:pid/files/:fileId', requireProjectRole('editor'), async (req, res) => {
    const body = moveSchema.parse(req.body ?? {})
    const files = await s.files.move(param(req, 'pid'), getPublicUser(req), param(req, 'fileId'), body.path)
    const out: MoveEntryResponse = { files }
    res.json(out)
  })

  r.delete('/api/projects/:pid/files/:fileId', requireProjectRole('editor'), async (req, res) => {
    const deletedIds = await s.files.remove(param(req, 'pid'), getPublicUser(req), param(req, 'fileId'))
    const out: DeleteEntryResponse = { deletedIds }
    res.json(out)
  })

  r.get('/api/projects/:pid/files/:fileId/raw', requireProjectRole('viewer'), async (req, res) => {
    const pid = param(req, 'pid')
    const entry = s.files.get(pid, param(req, 'fileId'))
    if (!entry) throw notFound('File not found')
    if (entry.kind === 'folder') throw badRequest('Folders cannot be downloaded')
    const download = req.query.download === '1' || req.query.download === 'true'
    if (entry.kind === 'text') {
      const text = await s.collab.getText(pid, entry.id)
      sendUserFile(res, { path: entry.path, isText: true, download }, Buffer.from(text, 'utf8'))
      return
    }
    let opened: Awaited<ReturnType<typeof openReadStreamNoFollow>>
    try {
      opened = await openReadStreamNoFollow(s.files.absPath(pid, entry.path))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ELOOP') throw notFound('File content is missing')
      throw err
    }
    streamUserFile(res, { path: entry.path, isText: false, download }, opened.stream, opened.size)
  })

  return r
}
