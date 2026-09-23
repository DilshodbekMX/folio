/**
 * Project operations behind the dashboard and the editor's project menu (SPEC §4.7):
 * create from template, zip import, copy, rename, settings (validated), per-user trash/archive,
 * delete forever (owner) / leave (non-owner), dashboard list, project detail.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type {
  Member, ProjectDetail, ProjectSettings, ProjectSummary, ProjectTemplate, Role, UpdateProjectRequest, UserPublic,
} from '@folio/shared/api'
import { normalizePath, validatePath } from '@folio/shared/paths'
import { WS_CLOSE } from '@folio/shared/protocol'
import { toPublic, type MembershipRecord, type ProjectRecord } from '../db/index.ts'
import { badRequest, forbidden, notFound } from '../http/errors.ts'
import { hasRole } from '../access/roles.ts'
import { moduleLog } from '../log.ts'
import type { Services } from '../services.ts'
import { withProjectLock } from '../files/lock.ts'
import { projectDirOf, safely } from '../files/service.ts'
import { openReadStreamNoFollow } from '../files/storage.ts'
import { collectMemory, collectZip, importProject, type CollectedSource, type ImportCandidate, type ImportResult } from './importer.ts'
import { buildTemplate } from './templates.ts'

const log = moduleLog('projects')

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

export const projectNameSchema = z.string().trim().min(1, 'Project name is required').max(150, 'Project name is too long')
  .refine(v => !CONTROL.test(v), 'Project name contains control characters')

const COMPILER_IDS = ['pdflatex', 'latex', 'xelatex', 'lualatex'] as const

export const updateProjectSchema = z.object({
  name: projectNameSchema.optional(),
  settings: z.object({
    compiler: z.enum(COMPILER_IDS),
    rootFileId: z.string().max(64).nullable(),
    externalDocs: z.array(z.string().max(1024)).max(20),
    timeoutSec: z.number().int().min(30).max(600),
    spellLang: z.string().max(35).regex(/^([A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})*)?$/, 'Invalid language tag'),
  }).partial().strict().optional(),
  trashed: z.boolean().optional(),
  archived: z.boolean().optional(),
}).strict()

function userPublic(s: Services, id: string | null): UserPublic | null {
  if (!id) return null
  const u = s.db.users.get(id)
  return u ? toPublic(u) : null
}

/** Placeholder for a missing account (e.g. owner row deleted out of band). */
function unknownUser(id: string): UserPublic {
  return { id, name: 'Unknown user', email: '', color: '#888888' }
}

export function listMembers(s: Services, projectId: string): Member[] {
  const out: Member[] = []
  for (const m of s.db.members.list(projectId)) {
    const u = s.db.users.get(m.userId)
    if (u) out.push({ user: toPublic(u), role: m.role, addedAt: m.addedAt })
  }
  return out
}

export function projectSummary(s: Services, project: ProjectRecord, membership: MembershipRecord): ProjectSummary {
  const role: Role = project.ownerId === membership.userId ? 'owner' : membership.role
  return {
    id: project.id,
    name: project.name,
    owner: userPublic(s, project.ownerId) ?? unknownUser(project.ownerId),
    role,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    lastOpenedAt: membership.lastOpenedAt,
    lastUpdatedBy: userPublic(s, project.lastUpdatedBy),
    trashed: membership.trashedAt !== null,
    archived: membership.archived,
  }
}

export function listProjects(s: Services, userId: string): ProjectSummary[] {
  return s.db.projects.listForUser(userId).map(({ project, membership }) => projectSummary(s, project, membership))
}

export function projectDetail(s: Services, projectId: string, role: Role): ProjectDetail {
  const project = s.db.projects.get(projectId)
  if (!project) throw notFound('Project not found')
  return {
    id: project.id,
    name: project.name,
    owner: userPublic(s, project.ownerId) ?? unknownUser(project.ownerId),
    role,
    settings: project.settings,
    files: s.files.list(projectId),
    members: listMembers(s, projectId),
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

export async function createFromTemplate(s: Services, owner: UserPublic, name: string, template: ProjectTemplate): Promise<ImportResult> {
  const t = buildTemplate(template, { projectName: name, authorName: owner.name })
  return importProject(s, collectMemory(t.files.map(f => ({ path: f.path, data: f.content }))), { owner, name, rootPath: t.rootPath, compiler: t.compiler })
}

export async function importZip(s: Services, owner: UserPublic, zipPath: string, name: string): Promise<ImportResult> {
  const src = await collectZip(zipPath, { maxEntryBytes: Math.max(s.config.maxUploadBytes, 50 * 1024 * 1024) })
  return importProject(s, src, { owner, name })
}

/**
 * Copy a project (current live state) into a new project owned by `owner`. Collaborators,
 * share links and chat are not copied; history is copied by HistoryService.copyProject when
 * it supports it, otherwise initialised fresh.
 */
export async function copyProject(s: Services, owner: UserPublic, projectId: string, name: string): Promise<ImportResult> {
  const project = s.db.projects.get(projectId)
  if (!project) throw notFound('Project not found')
  await s.collab.flushProject(projectId)
  const entries = s.files.list(projectId)
  const candidates: ImportCandidate[] = []
  for (const e of entries) {
    if (e.kind === 'folder') candidates.push({ path: e.path, isDir: true, size: 0 })
    else if (e.kind === 'text') {
      const data = Buffer.from(await s.collab.getText(projectId, e.id), 'utf8')
      candidates.push({ path: e.path, size: data.length, data })
    } else {
      const abs = s.files.absPath(projectId, e.path)
      candidates.push({ path: e.path, size: e.size, open: async () => (await openReadStreamNoFollow(abs)).stream })
    }
  }
  const src: CollectedSource = { candidates, skipped: [], stripTopFolder: false }
  const rootEntry = project.settings.rootFileId ? s.files.get(projectId, project.settings.rootFileId) : null
  const result = await importProject(s, src, {
    owner,
    name,
    rootPath: rootEntry?.path ?? null,
    strictRoot: false,
    compiler: project.settings.compiler,
    externalDocs: project.settings.externalDocs,
    timeoutSec: project.settings.timeoutSec,
    spellLang: project.settings.spellLang,
    skipHistory: true,
    applyIgnoreList: false,
  })
  try {
    await s.history.copyProject(projectId, result.projectId, owner)
  } catch (err) {
    log.warn({ err, projectId, copy: result.projectId }, 'history.copyProject failed; initialising fresh history')
    try {
      await s.history.init(result.projectId, owner)
    } catch (err2) {
      log.warn({ err: err2, projectId: result.projectId }, 'history.init failed for project copy')
    }
  }
  return result
}

/** Validate a settings patch against the project (rootFileId must be one of its text files, …). */
export function validateSettingsPatch(s: Services, projectId: string, patch: NonNullable<z.infer<typeof updateProjectSchema>['settings']>): Partial<ProjectSettings> {
  const out: Partial<ProjectSettings> = {}
  if (patch.compiler !== undefined) out.compiler = patch.compiler
  if (patch.rootFileId !== undefined) {
    if (patch.rootFileId !== null) {
      const f = s.files.get(projectId, patch.rootFileId)
      if (!f) throw badRequest('The main document must be a file of this project', { field: 'rootFileId' })
      if (f.kind !== 'text') throw badRequest('The main document must be a text (.tex) file', { field: 'rootFileId' })
    }
    out.rootFileId = patch.rootFileId
  }
  if (patch.externalDocs !== undefined) {
    const docs: string[] = []
    for (const raw of patch.externalDocs) {
      const p = normalizePath(raw)
      const err = validatePath(p)
      if (err) throw badRequest(`Invalid external document path "${raw}": ${err}`, { field: 'externalDocs' })
      if (!p.toLowerCase().endsWith('.tex')) throw badRequest(`External documents must be .tex files ("${raw}")`, { field: 'externalDocs' })
      if (!docs.includes(p)) docs.push(p)
    }
    out.externalDocs = docs
  }
  if (patch.timeoutSec !== undefined) {
    if (patch.timeoutSec > s.config.compile.maxTimeoutSec) throw badRequest(`The timeout can be at most ${s.config.compile.maxTimeoutSec} s`, { field: 'timeoutSec' })
    out.timeoutSec = patch.timeoutSec
  }
  if (patch.spellLang !== undefined) out.spellLang = patch.spellLang
  return out
}

export function updateProject(s: Services, projectId: string, user: UserPublic, role: Role, body: UpdateProjectRequest): ProjectDetail {
  const req = updateProjectSchema.parse(body ?? {})
  const project = s.db.projects.get(projectId)
  if (!project) throw notFound('Project not found')
  if (req.name !== undefined && req.name !== project.name && role !== 'owner') throw forbidden('Only the project owner can rename it')
  if (req.settings && !hasRole(role, 'editor')) throw forbidden('You have read-only access to this project')
  const settingsPatch = req.settings ? validateSettingsPatch(s, projectId, req.settings) : null

  if (req.name !== undefined && req.name !== project.name) {
    s.db.projects.rename(projectId, req.name)
    safely('meta.syncProject', () => s.meta.syncProject(projectId))
    safely('meta.broadcast', () => s.meta.broadcast(projectId, { type: 'project:renamed', name: req.name! }))
  }
  if (settingsPatch && Object.keys(settingsPatch).length) {
    const updated = s.db.projects.updateSettings(projectId, settingsPatch)
    s.db.projects.touchUpdated(projectId, user.id)
    safely('meta.syncProject', () => s.meta.syncProject(projectId))
    if (updated) safely('meta.broadcast', () => s.meta.broadcast(projectId, { type: 'project:settings', settings: updated.settings }))
  }
  if (req.trashed !== undefined) s.db.members.setTrashed(projectId, user.id, req.trashed)
  if (req.archived !== undefined) s.db.members.setArchived(projectId, user.id, req.archived)
  return projectDetail(s, projectId, role)
}

/**
 * Permanently delete a project (owner only; callers check the role).
 * Lock order: the history first, OUTSIDE the project lock. A history restore holds the history
 * lock while it writes files through FileService (which takes the project lock); waiting for the
 * history lock inside the project lock would deadlock with it. history.deleteProject marks the
 * project deleted (a running restore stops at its next step), waits for the history lock and
 * removes the git dir.
 */
export async function deleteProjectForever(s: Services, projectId: string): Promise<void> {
  try {
    await s.history.deleteProject(projectId)
  } catch (err) {
    log.warn({ err, projectId }, 'history.deleteProject failed')
  }
  await withProjectLock(projectId, async () => {
    safely('meta.broadcast', () => s.meta.broadcast(projectId, { type: 'project:deleted' }))
    try {
      await s.collab.discardProject(projectId)
    } catch (err) {
      log.warn({ err, projectId }, 'collab.discardProject failed')
    }
    safely('meta.closeProject', () => s.meta.closeProject(projectId, WS_CLOSE.GONE))
    try {
      await s.compile.deleteProject(projectId)
    } catch (err) {
      log.warn({ err, projectId }, 'compile.deleteProject failed')
    }
    await fsp.rm(projectDirOf(s, projectId), { recursive: true, force: true })
    s.db.projects.delete(projectId)
  })
}

/** Revoke a member's live access (sockets closed with 4403) and tell the project. */
export function revokeLiveAccess(s: Services, projectId: string, userId: string): void {
  safely('collab.disconnectUser', () => s.collab.disconnectUser(projectId, userId, WS_CLOSE.FORBIDDEN))
  safely('meta.disconnectUser', () => s.meta.disconnectUser(projectId, userId, WS_CLOSE.FORBIDDEN))
  safely('meta.broadcast', () => s.meta.broadcast(projectId, { type: 'access:changed', userId }))
}

/** A non-owner removes their own membership ("delete" from a collaborator's dashboard). */
export function leaveProject(s: Services, projectId: string, userId: string): void {
  const project = s.db.projects.get(projectId)
  if (!project) throw notFound('Project not found')
  if (project.ownerId === userId) throw badRequest('The owner cannot leave the project; delete it instead')
  s.db.members.remove(projectId, userId)
  revokeLiveAccess(s, projectId, userId)
  safely('meta.broadcast', () => s.meta.broadcast(projectId, { type: 'members:changed' }))
}

/** Directory of the project's files (exported for tests/CLI). */
export function projectPath(s: Services, projectId: string): string {
  return path.join(s.config.dirs.projects, projectId)
}
