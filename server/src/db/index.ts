/**
 * Metadata store (better-sqlite3, synchronous). Repositories return camelCase domain
 * records; nothing outside this module touches SQL.
 */
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_USER_SETTINGS, type Compiler, type FileEntry, type FileKind, type ProjectSettings,
  type Role, type UserPublic, type UserSettings,
} from '@folio/shared/api'

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export interface UserRecord {
  id: string
  email: string
  name: string
  passwordHash: string
  isAdmin: boolean
  color: string
  settings: UserSettings
  createdAt: number
}

export interface ProjectRecord {
  id: string
  name: string
  ownerId: string
  createdAt: number
  updatedAt: number
  lastUpdatedBy: string | null
  settings: ProjectSettings
}

export interface MembershipRecord {
  projectId: string
  userId: string
  role: Role
  addedAt: number
  lastOpenedAt: number | null
  trashedAt: number | null
  archived: boolean
}

export interface LabelRecord { id: string; projectId: string; versionId: string; name: string; userId: string | null; createdAt: number }
export interface ChatRecord { id: number; projectId: string; userId: string; content: string; createdAt: number }
export interface SessionRecord { tokenHash: string; userId: string; createdAt: number; expiresAt: number; lastSeenAt: number }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** 16-char url-safe random id */
export function newId(): string {
  return randomBytes(12).toString('base64url')
}

/** Distinct, readable cursor colours (Okabe–Ito + extras). */
export const USER_COLORS = ['#0072B2', '#D55E00', '#009E73', '#CC79A7', '#E69F00', '#56B4E9', '#8E44AD', '#C0392B', '#16A085', '#2C3E50']

export function toPublic(u: UserRecord): UserPublic {
  return { id: u.id, name: u.name, email: u.email, color: u.color }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0,
  color TEXT NOT NULL,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_updated_by TEXT,
  compiler TEXT NOT NULL DEFAULT 'pdflatex',
  root_file_id TEXT,
  external_docs_json TEXT NOT NULL DEFAULT '[]',
  timeout_sec INTEGER NOT NULL DEFAULT 240,
  spell_lang TEXT NOT NULL DEFAULT 'en',
  image TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  added_at INTEGER NOT NULL,
  last_opened_at INTEGER,
  trashed_at INTEGER,
  archived INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON project_members(user_id);
CREATE TABLE IF NOT EXISTS share_links (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('editor','viewer')),
  token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (project_id, role)
);
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('text','binary','folder')),
  size INTEGER NOT NULL DEFAULT 0,
  epoch INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (project_id, path)
);
CREATE INDEX IF NOT EXISTS files_project ON files(project_id);
CREATE TABLE IF NOT EXISTS labels (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_id TEXT NOT NULL,
  name TEXT NOT NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS labels_project ON labels(project_id);
CREATE TABLE IF NOT EXISTS chat_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_project ON chat_messages(project_id, id);
`

type Row = Record<string, any>

function userFromRow(r: Row): UserRecord {
  let settings: Partial<UserSettings> = {}
  try { settings = JSON.parse(r.settings_json) } catch { /* ignore */ }
  return {
    id: r.id, email: r.email, name: r.name, passwordHash: r.password_hash, isAdmin: !!r.is_admin,
    color: r.color, settings: { ...DEFAULT_USER_SETTINGS, ...settings }, createdAt: r.created_at,
  }
}

function projectFromRow(r: Row): ProjectRecord {
  let externalDocs: string[] = []
  try { externalDocs = JSON.parse(r.external_docs_json) } catch { /* ignore */ }
  return {
    id: r.id, name: r.name, ownerId: r.owner_id, createdAt: r.created_at, updatedAt: r.updated_at,
    lastUpdatedBy: r.last_updated_by ?? null,
    settings: {
      compiler: r.compiler as Compiler, rootFileId: r.root_file_id ?? null, externalDocs,
      timeoutSec: r.timeout_sec, spellLang: r.spell_lang, image: r.image,
    },
  }
}

function memberFromRow(r: Row): MembershipRecord {
  return {
    projectId: r.project_id, userId: r.user_id, role: r.role as Role, addedAt: r.added_at,
    lastOpenedAt: r.last_opened_at ?? null, trashedAt: r.trashed_at ?? null, archived: !!r.archived,
  }
}

function fileFromRow(r: Row): FileEntry & { projectId: string; createdAt: number } {
  return {
    id: r.id, projectId: r.project_id, path: r.path, kind: r.kind as FileKind, size: r.size,
    epoch: r.epoch, updatedAt: r.updated_at, createdAt: r.created_at,
  }
}

// ---------------------------------------------------------------------------
// Db
// ---------------------------------------------------------------------------

export type FileRecord = ReturnType<typeof fileFromRow>

export function openDb(file: string) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true })
  const raw = new Database(file)
  raw.pragma('journal_mode = WAL')
  raw.pragma('foreign_keys = ON')
  raw.pragma('busy_timeout = 5000')
  raw.exec(SCHEMA)

  const now = () => Date.now()

  const users = {
    count(): number {
      return (raw.prepare('SELECT COUNT(*) AS n FROM users').get() as Row).n
    },
    create(u: { email: string; name: string; passwordHash: string; isAdmin?: boolean; color?: string }): UserRecord {
      const id = newId()
      const color = u.color ?? USER_COLORS[users.count() % USER_COLORS.length]
      raw.prepare('INSERT INTO users (id,email,name,password_hash,is_admin,color,settings_json,created_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, u.email.trim(), u.name.trim(), u.passwordHash, u.isAdmin ? 1 : 0, color, '{}', now())
      return users.get(id)!
    },
    get(id: string): UserRecord | null {
      const r = raw.prepare('SELECT * FROM users WHERE id = ?').get(id) as Row | undefined
      return r ? userFromRow(r) : null
    },
    getByEmail(email: string): UserRecord | null {
      const r = raw.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(email.trim()) as Row | undefined
      return r ? userFromRow(r) : null
    },
    list(): UserRecord[] {
      return (raw.prepare('SELECT * FROM users ORDER BY created_at').all() as Row[]).map(userFromRow)
    },
    update(id: string, patch: Partial<Pick<UserRecord, 'name' | 'passwordHash' | 'isAdmin' | 'settings' | 'color'>>): UserRecord | null {
      const cur = users.get(id)
      if (!cur) return null
      const next = { ...cur, ...patch }
      raw.prepare('UPDATE users SET name=?, password_hash=?, is_admin=?, color=?, settings_json=? WHERE id=?')
        .run(next.name, next.passwordHash, next.isAdmin ? 1 : 0, next.color, JSON.stringify(next.settings), id)
      return users.get(id)
    },
    delete(id: string): void {
      raw.prepare('DELETE FROM users WHERE id = ?').run(id)
    },
    /** public view of several users at once (missing ids are skipped) */
    publicMany(ids: string[]): UserPublic[] {
      return ids.map(id => users.get(id)).filter((u): u is UserRecord => !!u).map(toPublic)
    },
  }

  const sessions = {
    create(tokenHash: string, userId: string, ttlMs: number): SessionRecord {
      const t = now()
      raw.prepare('INSERT INTO sessions (token_hash,user_id,created_at,expires_at,last_seen_at) VALUES (?,?,?,?,?)')
        .run(tokenHash, userId, t, t + ttlMs, t)
      return { tokenHash, userId, createdAt: t, expiresAt: t + ttlMs, lastSeenAt: t }
    },
    get(tokenHash: string): SessionRecord | null {
      const r = raw.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(tokenHash) as Row | undefined
      if (!r) return null
      if (r.expires_at < now()) {
        sessions.delete(tokenHash)
        return null
      }
      return { tokenHash: r.token_hash, userId: r.user_id, createdAt: r.created_at, expiresAt: r.expires_at, lastSeenAt: r.last_seen_at }
    },
    touch(tokenHash: string): void {
      raw.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now(), tokenHash)
    },
    /** Sliding expiry: the session now expires `ttlMs` from now (also marks it seen). */
    extend(tokenHash: string, ttlMs: number): void {
      const t = now()
      raw.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(t, t + ttlMs, tokenHash)
    },
    /** token hashes of every live (unexpired) session of a user */
    hashesForUser(userId: string): string[] {
      return (raw.prepare('SELECT token_hash FROM sessions WHERE user_id = ? AND expires_at >= ?').all(userId, now()) as Row[]).map(r => r.token_hash)
    },
    delete(tokenHash: string): void {
      raw.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash)
    },
    deleteForUser(userId: string, exceptTokenHash?: string): void {
      raw.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(userId, exceptTokenHash ?? '')
    },
    /** delete expired sessions; returns how many were removed */
    purgeExpired(): number {
      return raw.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now()).changes
    },
  }

  const projects = {
    create(p: { id?: string; name: string; ownerId: string; settings?: Partial<ProjectSettings> }): ProjectRecord {
      const id = p.id ?? newId()
      const t = now()
      const s = p.settings ?? {}
      raw.transaction(() => {
        raw.prepare(`INSERT INTO projects (id,name,owner_id,created_at,updated_at,last_updated_by,compiler,root_file_id,external_docs_json,timeout_sec,spell_lang,image)
                     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(id, p.name, p.ownerId, t, t, p.ownerId, s.compiler ?? 'pdflatex', s.rootFileId ?? null,
            JSON.stringify(s.externalDocs ?? []), s.timeoutSec ?? 240, s.spellLang ?? 'en', s.image ?? '')
        raw.prepare('INSERT INTO project_members (project_id,user_id,role,added_at,last_opened_at) VALUES (?,?,?,?,?)')
          .run(id, p.ownerId, 'owner', t, t)
      })()
      return projects.get(id)!
    },
    get(id: string): ProjectRecord | null {
      const r = raw.prepare('SELECT * FROM projects WHERE id = ?').get(id) as Row | undefined
      return r ? projectFromRow(r) : null
    },
    /** every project the user is a member of, with their membership */
    listForUser(userId: string): { project: ProjectRecord; membership: MembershipRecord }[] {
      const rows = raw.prepare(`SELECT p.*, m.project_id AS m_project_id, m.user_id AS m_user_id, m.role AS m_role, m.added_at AS m_added_at,
                                       m.last_opened_at AS m_last_opened_at, m.trashed_at AS m_trashed_at, m.archived AS m_archived
                                FROM projects p JOIN project_members m ON m.project_id = p.id
                                WHERE m.user_id = ? ORDER BY p.updated_at DESC`).all(userId) as Row[]
      return rows.map(r => ({
        project: projectFromRow(r),
        membership: memberFromRow({
          project_id: r.m_project_id, user_id: r.m_user_id, role: r.m_role, added_at: r.m_added_at,
          last_opened_at: r.m_last_opened_at, trashed_at: r.m_trashed_at, archived: r.m_archived,
        }),
      }))
    },
    rename(id: string, name: string): void {
      raw.prepare('UPDATE projects SET name = ?, updated_at = ? WHERE id = ?').run(name, now(), id)
    },
    updateSettings(id: string, patch: Partial<ProjectSettings>): ProjectRecord | null {
      const cur = projects.get(id)
      if (!cur) return null
      const s = { ...cur.settings, ...patch }
      raw.prepare('UPDATE projects SET compiler=?, root_file_id=?, external_docs_json=?, timeout_sec=?, spell_lang=?, image=?, updated_at=? WHERE id=?')
        .run(s.compiler, s.rootFileId, JSON.stringify(s.externalDocs), s.timeoutSec, s.spellLang, s.image, now(), id)
      return projects.get(id)
    },
    /** mark the project as modified by `userId` (dashboard "last modified") */
    touchUpdated(id: string, userId: string | null): void {
      raw.prepare('UPDATE projects SET updated_at = ?, last_updated_by = ? WHERE id = ?').run(now(), userId, id)
    },
    delete(id: string): void {
      raw.prepare('DELETE FROM projects WHERE id = ?').run(id)
    },
  }

  const members = {
    get(projectId: string, userId: string): MembershipRecord | null {
      const r = raw.prepare('SELECT * FROM project_members WHERE project_id = ? AND user_id = ?').get(projectId, userId) as Row | undefined
      return r ? memberFromRow(r) : null
    },
    roleOf(projectId: string, userId: string): Role | null {
      return members.get(projectId, userId)?.role ?? null
    },
    list(projectId: string): MembershipRecord[] {
      return (raw.prepare(`SELECT * FROM project_members WHERE project_id = ?
                           ORDER BY CASE role WHEN 'owner' THEN 0 WHEN 'editor' THEN 1 ELSE 2 END, added_at`).all(projectId) as Row[]).map(memberFromRow)
    },
    /** insert or change role (never downgrades an owner) */
    upsert(projectId: string, userId: string, role: Role): MembershipRecord {
      const cur = members.get(projectId, userId)
      if (cur) {
        if (cur.role !== 'owner') raw.prepare('UPDATE project_members SET role = ? WHERE project_id = ? AND user_id = ?').run(role, projectId, userId)
      } else {
        raw.prepare('INSERT INTO project_members (project_id,user_id,role,added_at) VALUES (?,?,?,?)').run(projectId, userId, role, now())
      }
      return members.get(projectId, userId)!
    },
    remove(projectId: string, userId: string): void {
      raw.prepare("DELETE FROM project_members WHERE project_id = ? AND user_id = ? AND role != 'owner'").run(projectId, userId)
    },
    markOpened(projectId: string, userId: string): void {
      raw.prepare('UPDATE project_members SET last_opened_at = ? WHERE project_id = ? AND user_id = ?').run(now(), projectId, userId)
    },
    setTrashed(projectId: string, userId: string, trashed: boolean): void {
      raw.prepare('UPDATE project_members SET trashed_at = ? WHERE project_id = ? AND user_id = ?').run(trashed ? now() : null, projectId, userId)
    },
    setArchived(projectId: string, userId: string, archived: boolean): void {
      raw.prepare('UPDATE project_members SET archived = ? WHERE project_id = ? AND user_id = ?').run(archived ? 1 : 0, projectId, userId)
    },
  }

  const shareLinks = {
    get(projectId: string): { editor: string | null; viewer: string | null } {
      const rows = raw.prepare('SELECT role, token FROM share_links WHERE project_id = ?').all(projectId) as Row[]
      const out = { editor: null as string | null, viewer: null as string | null }
      for (const r of rows) out[r.role as 'editor' | 'viewer'] = r.token
      return out
    },
    set(projectId: string, role: 'editor' | 'viewer', token: string): void {
      raw.prepare('INSERT INTO share_links (project_id,role,token,created_at) VALUES (?,?,?,?) ON CONFLICT(project_id, role) DO UPDATE SET token = excluded.token, created_at = excluded.created_at')
        .run(projectId, role, token, now())
    },
    delete(projectId: string, role: 'editor' | 'viewer'): void {
      raw.prepare('DELETE FROM share_links WHERE project_id = ? AND role = ?').run(projectId, role)
    },
    byToken(token: string): { projectId: string; role: 'editor' | 'viewer' } | null {
      const r = raw.prepare('SELECT project_id, role FROM share_links WHERE token = ?').get(token) as Row | undefined
      return r ? { projectId: r.project_id, role: r.role } : null
    },
  }

  const files = {
    create(f: { id?: string; projectId: string; path: string; kind: FileKind; size?: number; epoch?: number }): FileRecord {
      const id = f.id ?? newId()
      const t = now()
      raw.prepare('INSERT INTO files (id,project_id,path,kind,size,epoch,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, f.projectId, f.path, f.kind, f.size ?? 0, f.epoch ?? 0, t, t)
      return files.get(id)!
    },
    get(id: string): FileRecord | null {
      const r = raw.prepare('SELECT * FROM files WHERE id = ?').get(id) as Row | undefined
      return r ? fileFromRow(r) : null
    },
    getByPath(projectId: string, p: string): FileRecord | null {
      const r = raw.prepare('SELECT * FROM files WHERE project_id = ? AND path = ?').get(projectId, p) as Row | undefined
      return r ? fileFromRow(r) : null
    },
    list(projectId: string): FileRecord[] {
      return (raw.prepare('SELECT * FROM files WHERE project_id = ? ORDER BY path').all(projectId) as Row[]).map(fileFromRow)
    },
    update(id: string, patch: Partial<Pick<FileRecord, 'path' | 'kind' | 'size' | 'epoch'>>): FileRecord | null {
      const cur = files.get(id)
      if (!cur) return null
      const n = { ...cur, ...patch }
      raw.prepare('UPDATE files SET path=?, kind=?, size=?, epoch=?, updated_at=? WHERE id=?').run(n.path, n.kind, n.size, n.epoch, now(), id)
      return files.get(id)
    },
    bumpEpoch(id: string): FileRecord | null {
      raw.prepare('UPDATE files SET epoch = epoch + 1, updated_at = ? WHERE id = ?').run(now(), id)
      return files.get(id)
    },
    delete(id: string): void {
      raw.prepare('DELETE FROM files WHERE id = ?').run(id)
    },
  }

  const labels = {
    create(l: { projectId: string; versionId: string; name: string; userId: string | null }): LabelRecord {
      const id = newId()
      const t = now()
      raw.prepare('INSERT INTO labels (id,project_id,version_id,name,user_id,created_at) VALUES (?,?,?,?,?,?)').run(id, l.projectId, l.versionId, l.name, l.userId, t)
      return { id, ...l, createdAt: t }
    },
    list(projectId: string): LabelRecord[] {
      return (raw.prepare('SELECT * FROM labels WHERE project_id = ? ORDER BY created_at DESC').all(projectId) as Row[])
        .map(r => ({ id: r.id, projectId: r.project_id, versionId: r.version_id, name: r.name, userId: r.user_id ?? null, createdAt: r.created_at }))
    },
    get(id: string): LabelRecord | null {
      const r = raw.prepare('SELECT * FROM labels WHERE id = ?').get(id) as Row | undefined
      return r ? { id: r.id, projectId: r.project_id, versionId: r.version_id, name: r.name, userId: r.user_id ?? null, createdAt: r.created_at } : null
    },
    delete(id: string): void {
      raw.prepare('DELETE FROM labels WHERE id = ?').run(id)
    },
  }

  const chat = {
    create(projectId: string, userId: string, content: string): ChatRecord {
      const t = now()
      const info = raw.prepare('INSERT INTO chat_messages (project_id,user_id,content,created_at) VALUES (?,?,?,?)').run(projectId, userId, content, t)
      return { id: Number(info.lastInsertRowid), projectId, userId, content, createdAt: t }
    },
    /** newest `limit` messages with id < before, returned in ascending order */
    list(projectId: string, before: number | null, limit: number): ChatRecord[] {
      const rows = raw.prepare('SELECT * FROM chat_messages WHERE project_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
        .all(projectId, before ?? Number.MAX_SAFE_INTEGER, limit) as Row[]
      return rows.reverse().map(r => ({ id: r.id, projectId: r.project_id, userId: r.user_id, content: r.content, createdAt: r.created_at }))
    },
  }

  return {
    raw,
    /** run fn inside a SQLite transaction */
    transaction<T>(fn: () => T): T {
      return raw.transaction(fn)()
    },
    close(): void {
      raw.close()
    },
    users, sessions, projects, members, shareLinks, files, labels, chat,
  }
}

export type Db = ReturnType<typeof openDb>
