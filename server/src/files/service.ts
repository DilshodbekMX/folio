/**
 * FileService (SPEC §4.7): the canonical file-tree operations of a project.
 *
 *  - every disk write goes under projectDir with symlink/realpath checks (storage.ts);
 *  - a text write to an existing text file goes through CollabService.setText (never behind a
 *    live Y.Doc); a text↔binary kind change bumps the epoch and discards the Y state
 *    (STALE_EPOCH); deletes discard it with GONE;
 *  - moves: flush live docs, prepare asynchronously, then rename on disk + update the db (every
 *    descendant of a folder) in one synchronous block, so collab saves never see them disagree;
 *  - after any tree change: db.projects.touchUpdated, meta.syncFiles, meta.broadcast
 *    'files:changed' (with `by`, the acting user), history.noteActivity;
 *  - deletes: history.snapshotBeforeDelete first (pending edits of what is deleted are committed,
 *    so it can be restored), then the Y state is discarded (GONE) and the entries removed;
 *  - deleting the root document clears settings.rootFileId.
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { FileEntry, UserPublic } from '@folio/shared/api'
import { classifyFile, normalizeText, textLengthFits } from '@folio/shared/filetypes'
import { dirname, isWithin, normalizePath } from '@folio/shared/paths'
import { WS_CLOSE } from '@folio/shared/protocol'
import type { FileRecord } from '../db/index.ts'
import { badRequest, conflict, HttpError, notFound } from '../http/errors.ts'
import { isValidId } from '../access/roles.ts'
import { moduleLog } from '../log.ts'
import type { FileService, Services } from '../services.ts'
import { withProjectLock } from './lock.ts'
import {
  assertNoSymlinksSync, checkProjectPath, ensureDir, joinInside, prepareMove, readFileNoFollow, removeTree, writeFileAtomic,
} from './storage.ts'

const log = moduleLog('files')

/** Overleaf-compatible cap on entities (files + folders) per project. */
export const MAX_PROJECT_ENTRIES = 2000

export function toEntry(r: FileRecord | FileEntry): FileEntry {
  return { id: r.id, path: r.path, kind: r.kind, size: r.size, epoch: r.epoch, updatedAt: r.updatedAt }
}

/** Run a side effect on another service without letting its failure undo a completed operation. */
export function safely(what: string, fn: () => unknown): void {
  try {
    const r = fn()
    if (r && typeof (r as Promise<unknown>).catch === 'function') {
      (r as Promise<unknown>).catch(err => log.warn({ err }, `${what} failed`))
    }
  } catch (err) {
    log.warn({ err }, `${what} failed`)
  }
}

/**
 * Notify the rest of the system that the project's file tree changed. The 'files:changed' event
 * names the user whose operation it was (`by`), so collaborators' notices can say who deleted or
 * replaced a file they have open.
 */
export function afterTreeChange(s: Services, projectId: string, user: UserPublic | null, changed: FileEntry[], deletedIds: string[]): void {
  const userId = user?.id ?? null
  const by: UserPublic | null = user ? { id: user.id, name: user.name, email: user.email, color: user.color } : null
  safely('touchUpdated', () => s.db.projects.touchUpdated(projectId, userId))
  safely('meta.syncFiles', () => s.meta.syncFiles(projectId))
  safely('meta.broadcast', () => s.meta.broadcast(projectId, { type: 'files:changed', changed, deletedIds, by }))
  safely('history.noteActivity', () => s.history.noteActivity(projectId, userId))
}

export function projectDirOf(s: Pick<Services, 'config'>, projectId: string): string {
  if (!isValidId(projectId)) throw notFound('Project not found')
  return path.join(s.config.dirs.projects, projectId)
}

function tooManyEntries(): HttpError {
  return new HttpError(413, 'too_large', `A project can contain at most ${MAX_PROJECT_ENTRIES} files and folders`)
}

export function createFileService(s: Services): FileService {
  const db = () => s.db

  function projectDir(projectId: string): string {
    return projectDirOf(s, projectId)
  }

  function absPath(projectId: string, p: string): string {
    const root = projectDir(projectId)
    const abs = joinInside(root, p)
    assertNoSymlinksSync(root, abs)
    return abs
  }

  function get(projectId: string, fileId: string): FileEntry | null {
    const r = db().files.get(fileId)
    return r && r.projectId === projectId ? toEntry(r) : null
  }

  function getByPath(projectId: string, p: string): FileEntry | null {
    const r = db().files.getByPath(projectId, normalizePath(p))
    return r ? toEntry(r) : null
  }

  function list(projectId: string): FileEntry[] {
    return db().files.list(projectId).map(toEntry)
  }

  function checkCapacity(projectId: string, adding: number): void {
    if (adding > 0 && db().files.list(projectId).length + adding > MAX_PROJECT_ENTRIES) throw tooManyEntries()
  }

  /** Paths of the missing ancestor folders of `p` (top-down); 409 when an ancestor is a file. */
  function missingParents(projectId: string, p: string): string[] {
    const out: string[] = []
    let dir = dirname(p)
    while (dir) {
      const e = db().files.getByPath(projectId, dir)
      if (e) {
        if (e.kind !== 'folder') throw conflict(`"${dir}" is a file, not a folder`)
        break
      }
      out.unshift(dir)
      dir = dirname(dir)
    }
    return out
  }

  async function createParents(projectId: string, root: string, parents: string[]): Promise<FileEntry[]> {
    const created: FileEntry[] = []
    for (const dir of parents) {
      await ensureDir(root, joinInside(root, dir))
      created.push(toEntry(db().files.create({ projectId, path: dir, kind: 'folder' })))
    }
    return created
  }

  async function create(projectId: string, user: UserPublic | null, rawPath: string, kind: 'text' | 'folder', content?: string): Promise<FileEntry> {
    if (kind !== 'text' && kind !== 'folder') throw badRequest('kind must be "text" or "folder"')
    const p = checkProjectPath(rawPath)
    let data: Buffer | null = null
    if (kind === 'text') {
      const text = normalizeText(content ?? '')
      // the collaborative document limit counts UTF-16 code units, not bytes
      if (!textLengthFits(text)) throw new HttpError(413, 'too_large', 'Text documents are limited to about 2 million characters')
      data = Buffer.from(text, 'utf8')
    }
    return withProjectLock(projectId, async () => {
      if (db().files.getByPath(projectId, p)) throw conflict(`A file or folder named "${p}" already exists`, { path: p })
      const root = projectDir(projectId)
      await fsp.mkdir(root, { recursive: true })
      const parents = missingParents(projectId, p)
      checkCapacity(projectId, parents.length + 1)
      const created = await createParents(projectId, root, parents)
      const abs = joinInside(root, p)
      let rec: FileRecord
      if (kind === 'folder') {
        await ensureDir(root, abs)
        rec = db().files.create({ projectId, path: p, kind: 'folder' })
      } else {
        await writeFileAtomic(root, abs, data!, s.config.dirs.tmp)
        rec = db().files.create({ projectId, path: p, kind: 'text', size: data!.length })
      }
      const entry = toEntry(rec)
      afterTreeChange(s, projectId, user, [...created, entry], [])
      return entry
    })
  }

  async function writeFile(projectId: string, user: UserPublic | null, rawPath: string, bytes: Buffer, opts: { replace?: boolean } = {}): Promise<FileEntry> {
    const p = checkProjectPath(rawPath)
    const kind = classifyFile(p, bytes)
    const userId = user?.id ?? null
    // text content entering the system is always LF-only UTF-8 without BOM
    const text = kind === 'text' ? normalizeText(bytes.toString('utf8')) : null
    const data = text !== null ? Buffer.from(text, 'utf8') : bytes
    // overwriting a file: its edits since the last history version are committed first (see remove)
    const overwritten = opts.replace ? getByPath(projectId, p) : null
    if (overwritten && overwritten.kind !== 'folder') await s.history.snapshotBeforeDelete(projectId, [p], { replace: true })
    return withProjectLock(projectId, async () => {
      const root = projectDir(projectId)
      await fsp.mkdir(root, { recursive: true })
      const existing = db().files.getByPath(projectId, p)
      let entry: FileEntry
      let created: FileEntry[] = []
      if (existing) {
        if (existing.kind === 'folder') throw conflict(`"${p}" is a folder`, { path: p })
        if (!opts.replace) throw conflict(`"${p}" already exists`, { path: p })
        const abs = joinInside(root, p)
        if (existing.kind === 'text' && text !== null) {
          await s.collab.setText(projectId, existing.id, text, { userId, reason: 'upload' })
          entry = toEntry(db().files.update(existing.id, { size: data.length })!)
        } else if (existing.kind === kind) {
          await writeFileAtomic(root, abs, data, s.config.dirs.tmp)
          entry = toEntry(db().files.update(existing.id, { size: data.length })!)
        } else {
          // text ↔ binary: new epoch first so no client can re-open the old Y state, then drop it
          db().transaction(() => {
            db().files.update(existing.id, { kind })
            db().files.bumpEpoch(existing.id)
          })
          await s.collab.discardFile(projectId, existing.id, WS_CLOSE.STALE_EPOCH)
          await writeFileAtomic(root, abs, data, s.config.dirs.tmp)
          entry = toEntry(db().files.update(existing.id, { size: data.length })!)
        }
      } else {
        const parents = missingParents(projectId, p)
        checkCapacity(projectId, parents.length + 1)
        created = await createParents(projectId, root, parents)
        await writeFileAtomic(root, joinInside(root, p), data, s.config.dirs.tmp)
        entry = toEntry(db().files.create({ projectId, path: p, kind, size: data.length }))
      }
      afterTreeChange(s, projectId, user, [...created, entry], [])
      return entry
    })
  }

  async function move(projectId: string, user: UserPublic | null, fileId: string, newPath: string): Promise<FileEntry[]> {
    const to = checkProjectPath(newPath)
    return withProjectLock(projectId, async () => {
      const entry = get(projectId, fileId)
      if (!entry) throw notFound('File not found')
      if (to === entry.path) return [entry]
      if (entry.kind === 'folder' && isWithin(to, entry.path)) throw badRequest('A folder cannot be moved into itself')
      if (db().files.getByPath(projectId, to)) throw conflict(`A file or folder named "${to}" already exists`, { path: to })
      const root = projectDir(projectId)
      const parents = missingParents(projectId, to)
      checkCapacity(projectId, parents.length)
      // pending debounced saves must land before the path changes under them
      await s.collab.flushProject(projectId)
      const fromAbs = joinInside(root, entry.path)
      const toAbs = joinInside(root, to)
      // all asynchronous preparation first (symlink checks, destination parents on disk)…
      const onDisk = await prepareMove(root, fromAbs, toAbs)
      const descendants = entry.kind === 'folder'
        ? db().files.list(projectId).filter(f => f.path.startsWith(entry.path + '/'))
        : []
      // …then the rename and the db update in ONE synchronous block. A collab save resolves its
      // target from the db synchronously right before its own rename, so no save can ever see
      // the disk and the db disagree (which used to re-create the file at its old path).
      const moved: FileEntry[] = []
      const created: FileEntry[] = []
      if (onDisk) fs.renameSync(fromAbs, toAbs)
      try {
        db().transaction(() => {
          for (const dir of parents) created.push(toEntry(db().files.create({ projectId, path: dir, kind: 'folder' })))
          moved.push(toEntry(db().files.update(entry.id, { path: to })!))
          for (const d of descendants) moved.push(toEntry(db().files.update(d.id, { path: to + d.path.slice(entry.path.length) })!))
        })
      } catch (e) {
        if (onDisk) {
          try {
            fs.renameSync(toAbs, fromAbs)
          } catch (err) {
            log.error({ err, projectId, from: entry.path, to }, 'could not undo a failed move on disk')
          }
        }
        throw e
      }
      // a folder that was never materialised on disk is created at its new place
      if (entry.kind === 'folder' && !onDisk) await ensureDir(root, toAbs)
      afterTreeChange(s, projectId, user, [...created, ...moved], [])
      return [...moved, ...created]
    })
  }

  async function remove(projectId: string, user: UserPublic | null, fileId: string): Promise<string[]> {
    // What is about to be deleted must stay restorable: edits since the last history version
    // (typed, uploaded, or only in a live Y.Doc — discardFile drops those without saving) are
    // committed first. Outside the project lock on purpose: a history restore holds the history
    // lock while it calls into this service, so taking them the other way round could deadlock.
    // A snapshot that fails refuses the delete (e.g. 503 while git is busy) rather than lose data.
    const doomed = get(projectId, fileId)
    if (doomed) await s.history.snapshotBeforeDelete(projectId, [doomed.path])
    return withProjectLock(projectId, async () => {
      const entry = get(projectId, fileId)
      if (!entry) throw notFound('File not found')
      const targets = entry.kind === 'folder'
        ? [entry, ...db().files.list(projectId).filter(f => f.path.startsWith(entry.path + '/')).map(toEntry)]
        : [entry]
      for (const t of targets) {
        if (t.kind === 'text') {
          try {
            await s.collab.discardFile(projectId, t.id, WS_CLOSE.GONE)
          } catch (err) {
            log.warn({ err, projectId, fileId: t.id }, 'collab.discardFile failed')
          }
        }
      }
      const root = projectDir(projectId)
      await removeTree(joinInside(root, entry.path))
      const deletedIds = targets.map(t => t.id)
      db().transaction(() => {
        for (const id of deletedIds) db().files.delete(id)
      })
      const project = db().projects.get(projectId)
      if (project?.settings.rootFileId && deletedIds.includes(project.settings.rootFileId)) {
        const updated = db().projects.updateSettings(projectId, { rootFileId: null })
        safely('meta.syncProject', () => s.meta.syncProject(projectId))
        if (updated) safely('meta.broadcast', () => s.meta.broadcast(projectId, { type: 'project:settings', settings: updated.settings }))
      }
      afterTreeChange(s, projectId, user, [], deletedIds)
      return deletedIds
    })
  }

  async function read(projectId: string, fileId: string): Promise<Buffer> {
    const entry = get(projectId, fileId)
    if (!entry) throw notFound('File not found')
    if (entry.kind === 'folder') throw badRequest('Folders have no content')
    if (entry.kind === 'text') return Buffer.from(await s.collab.getText(projectId, fileId), 'utf8')
    return readFileNoFollow(absPath(projectId, entry.path))
  }

  return { projectDir, absPath, list, get, getByPath, create, writeFile, move, remove, read }
}
