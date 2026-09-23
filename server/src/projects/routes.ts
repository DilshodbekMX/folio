/**
 * Project routes: listProjects, createProject, uploadProject, getProject, updateProject,
 * deleteProject (owner: permanent; others: leave), copyProject, downloadProject.
 */
import express from 'express'
import { z } from 'zod'
import type { CreateProjectResponse } from '@folio/shared/api'
import { badRequest } from '../http/errors.ts'
import { getProject, getPublicUser, getUser, param } from '../http/request.ts'
import { cleanupUploads, createUploader, limitUploadRequest } from '../http/multipart.ts'
import { requireProjectRole, requireUser } from '../auth/middleware.ts'
import type { Services } from '../services.ts'
import { sendProjectZip } from './exporter.ts'
import { describeSkipped } from './importer.ts'
import {
  copyProject, createFromTemplate, deleteProjectForever, importZip, leaveProject, listProjects, projectDetail,
  projectNameSchema, updateProject,
} from './service.ts'

const createSchema = z.object({ name: projectNameSchema, template: z.enum(['blank', 'example']).default('blank') }).strict()
/** a zip has at most MAX_ZIP_ENTRIES entries; the report is capped at the same number */
const MAX_REPORTED_SKIPS = 2000
const copySchema = z.object({ name: projectNameSchema }).strict()

export function projectRoutes(s: Services): express.Router {
  const r = express.Router()
  const zipUpload = createUploader(s.config, 1)

  r.get('/api/projects', requireUser, (req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json(listProjects(s, getUser(req).id))
  })

  r.post('/api/projects', requireUser, async (req, res) => {
    const body = createSchema.parse(req.body ?? {})
    const result = await createFromTemplate(s, getPublicUser(req), body.name, body.template)
    const out: CreateProjectResponse = { id: result.projectId }
    res.status(201).json(out)
  })

  r.post('/api/projects/upload', requireUser, limitUploadRequest(s.config.maxUploadBytes), zipUpload.single('file'), async (req, res) => {
    try {
      const file = req.file
      if (!file) throw badRequest('Attach the .zip archive as the "file" field')
      const fromBody = typeof req.body?.name === 'string' ? req.body.name.trim() : ''
      const fromFile = file.originalname.replace(/^.*[\\/]/, '').replace(/\.zip$/i, '').trim()
      const name = projectNameSchema.parse(fromBody || fromFile || 'Untitled project')
      const result = await importZip(s, getPublicUser(req), file.path, name)
      const out: CreateProjectResponse = { id: result.projectId }
      if (result.skipped.length) {
        out.skipped = result.skipped.slice(0, MAX_REPORTED_SKIPS).map(e => ({ path: e.path, reason: describeSkipped(e) }))
      }
      res.status(201).json(out)
    } finally {
      await cleanupUploads(req)
    }
  })

  r.get('/api/projects/:pid', requireProjectRole('viewer'), (req, res) => {
    const { project, role } = getProject(req)
    s.db.members.markOpened(project.id, getUser(req).id)
    res.setHeader('Cache-Control', 'no-store')
    res.json(projectDetail(s, project.id, role))
  })

  r.patch('/api/projects/:pid', requireProjectRole('viewer'), (req, res) => {
    const { project, role } = getProject(req)
    res.json(updateProject(s, project.id, getPublicUser(req), role, req.body))
  })

  r.delete('/api/projects/:pid', requireProjectRole('viewer'), async (req, res) => {
    const { project, role } = getProject(req)
    if (role === 'owner') await deleteProjectForever(s, project.id)
    else leaveProject(s, project.id, getUser(req).id)
    res.status(204).end()
  })

  r.post('/api/projects/:pid/copy', requireProjectRole('viewer'), async (req, res) => {
    const body = copySchema.parse(req.body ?? {})
    const result = await copyProject(s, getPublicUser(req), param(req, 'pid'), body.name)
    const out: CreateProjectResponse = { id: result.projectId }
    res.status(201).json(out)
  })

  r.get('/api/projects/:pid/download.zip', requireProjectRole('viewer'), async (req, res) => {
    const { project } = getProject(req)
    await sendProjectZip(s, project.id, project.name, res)
  })

  return r
}
