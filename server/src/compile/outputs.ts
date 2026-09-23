/**
 * Immutable per-build output directories (SPEC §4.5 "Outputs"):
 *
 *   builds/<pid>/<buildId>/  <job>.pdf .log .synctex.gz .aux .bbl .blg .out .toc .fls
 *                            + xr external docs' .pdf/.log, + meta.json (the CompileResponse)
 *
 * Files are COPIED out of the compile dir (never hard-linked: TeX rewrites its outputs in place
 * and would mutate old builds) and only when they are regular files reached through real
 * directories (lstat). An output that did not change since the previous build (the xr external
 * documents' PDF and log, usually) is hard-linked to that build's copy instead: builds are
 * immutable, so sharing an inode between two build dirs is safe.
 * Build ids are `${Date.now().toString(16)}-${16 hex}`; retention keeps the newest 5 builds per
 * project, builds younger than 30 minutes up to 20 in all, and explicitly pinned ids (every root
 * document's last and last successful build, builds a client fetched in the last minutes).
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import fsSync, { constants as fsConstants } from 'node:fs'
import path from 'node:path'
import type { CompileResponse, OutputFile } from '@folio/shared/api'
import { safeFileStat } from './sync.ts'

export const BUILD_ID_RE = /^[0-9a-f]{8,}-[0-9a-f]{16}$/
export const BUILD_FILE_RE = /^[\w.\-]+$/
export const PROJECT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
export const META_FILE = 'meta.json'

export const KEEP_NEWEST_BUILDS = 5
export const KEEP_BUILDS_YOUNGER_THAN_MS = 30 * 60_000
/** hard cap on builds kept for their age (pinned ids are kept on top of it) */
export const MAX_RECENT_BUILDS = 20

export function isValidProjectId(pid: string): boolean {
  return PROJECT_ID_RE.test(pid)
}

export function newBuildId(now = Date.now()): string {
  return `${now.toString(16)}-${randomBytes(8).toString('hex')}`
}

/** Creation time encoded in a build id (ms), NaN for malformed ids. */
export function buildTimestamp(buildId: string): number {
  return BUILD_ID_RE.test(buildId) ? parseInt(buildId.slice(0, buildId.indexOf('-')), 16) : NaN
}

/** Name under which an output is published: [\w.-] only, never a dot-file. */
export function publishedName(name: string): string {
  let n = name.replace(/[^\w.\-]/g, '_')
  if (n.startsWith('.')) n = `_${n.slice(1)}`
  return n || '_'
}

/** 'pdf', 'log', 'synctex.gz', … */
export function outputType(name: string): string {
  if (name.endsWith('.synctex.gz')) return 'synctex.gz'
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function buildFileUrl(projectId: string, buildId: string, name: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/builds/${encodeURIComponent(buildId)}/${encodeURIComponent(name)}`
}

export interface PublishItem {
  /** path inside the compile dir (POSIX) */
  rel: string
  /** file name inside the build dir (must match BUILD_FILE_RE) */
  name: string
  /** may be hard-linked to the previous build's copy when the source is unchanged (see `reuse`) */
  reusable?: boolean
}

/** A published copy of a compile-dir output: the source's fingerprint when it was copied. */
export interface PublishedSource {
  /** `${ino}:${size}:${mtimeMs}` of the compile-dir file */
  key: string
  /** absolute path of the copy in its build dir */
  abs: string
}

/**
 * Create the build dir and copy the given outputs into it. Missing / non-regular sources are
 * skipped. `reuse` (compile-dir path → last published copy) lets a `reusable` item whose source
 * is unchanged be hard-linked to that copy; it is updated with this build's copies.
 */
export async function publishBuild(o: {
  compileDir: string
  buildDir: string
  projectId: string
  buildId: string
  items: PublishItem[]
  reuse?: Map<string, PublishedSource>
}): Promise<OutputFile[]> {
  await fs.mkdir(path.dirname(o.buildDir), { recursive: true })
  await fs.mkdir(o.buildDir)
  const files: OutputFile[] = []
  const seen = new Set<string>()
  for (const item of o.items) {
    if (!BUILD_FILE_RE.test(item.name) || item.name.startsWith('.') || item.name === META_FILE || seen.has(item.name)) continue
    const st = await safeFileStat(o.compileDir, item.rel)
    if (!st) continue
    const dest = path.join(o.buildDir, item.name)
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`
    const prev = item.reusable ? o.reuse?.get(item.rel) : undefined
    let linked = false
    if (prev && prev.key === key) {
      try {
        const old = await fs.lstat(prev.abs)
        if (old.isFile() && old.size === st.size) {
          await fs.link(prev.abs, dest)
          linked = true
        }
      } catch {
        // the previous build was pruned meanwhile: copy
      }
    }
    if (!linked) await fs.copyFile(path.join(o.compileDir, item.rel), dest, fsConstants.COPYFILE_EXCL)
    if (item.reusable) o.reuse?.set(item.rel, { key, abs: dest })
    const out = await fs.lstat(dest)
    seen.add(item.name)
    files.push({ path: item.name, url: buildFileUrl(o.projectId, o.buildId, item.name), size: out.size, type: outputType(item.name) })
  }
  return files
}

export async function writeBuildMeta(buildDir: string, response: CompileResponse): Promise<void> {
  const tmp = path.join(buildDir, `.meta-${randomBytes(6).toString('hex')}`)
  await fs.writeFile(tmp, JSON.stringify(response), { flag: 'wx' })
  await fs.rename(tmp, path.join(buildDir, META_FILE))
}

export async function readBuildMeta(buildDir: string): Promise<CompileResponse | null> {
  try {
    const st = await fs.lstat(path.join(buildDir, META_FILE))
    if (!st.isFile() || st.size > 32 * 1024 * 1024) return null
    const data = JSON.parse(await fs.readFile(path.join(buildDir, META_FILE), 'utf8')) as CompileResponse
    return data && typeof data.status === 'string' ? data : null
  } catch {
    return null
  }
}

/** Valid build ids in a project's builds dir, newest first. */
export async function listBuildIds(projectBuildsDir: string): Promise<string[]> {
  let dirents: fsSync.Dirent[]
  try {
    dirents = await fs.readdir(projectBuildsDir, { withFileTypes: true })
  } catch {
    return []
  }
  return dirents
    .filter(d => d.isDirectory() && BUILD_ID_RE.test(d.name))
    .map(d => d.name)
    .sort((a, b) => buildTimestamp(b) - buildTimestamp(a) || (a < b ? 1 : a > b ? -1 : 0))
}

/**
 * Delete old builds: keep the newest `keepNewest`, builds younger than `maxAgeMs` among the newest
 * `maxRecent` (an auto-compiling project publishes several builds a minute: age alone would keep
 * hundreds), and every id in `keep`. Returns the removed ids.
 */
export async function pruneBuilds(projectBuildsDir: string, o: {
  keepNewest?: number
  maxAgeMs?: number
  maxRecent?: number
  keep?: Iterable<string>
  now?: number
} = {}): Promise<string[]> {
  const keepNewest = o.keepNewest ?? KEEP_NEWEST_BUILDS
  const maxAge = o.maxAgeMs ?? KEEP_BUILDS_YOUNGER_THAN_MS
  const maxRecent = o.maxRecent ?? MAX_RECENT_BUILDS
  const now = o.now ?? Date.now()
  const keep = new Set(o.keep ?? [])
  const ids = await listBuildIds(projectBuildsDir)
  const removed: string[] = []
  for (let i = keepNewest; i < ids.length; i++) {
    const id = ids[i]
    if (keep.has(id) || (i < maxRecent && now - buildTimestamp(id) < maxAge)) continue
    await fs.rm(path.join(projectBuildsDir, id), { recursive: true, force: true })
    removed.push(id)
  }
  return removed
}

/**
 * Absolute path of a build output, or null. Validates the ids and the file name, and requires
 * real directories and a regular file all the way down (no symlinks).
 */
export function resolveBuildFileIn(buildsRoot: string, projectId: string, buildId: string, file: string): string | null {
  if (!isValidProjectId(projectId) || !BUILD_ID_RE.test(buildId)) return null
  if (!BUILD_FILE_RE.test(file) || file.startsWith('.') || file.length > 255) return null
  const projectDir = path.join(buildsRoot, projectId)
  const buildDir = path.join(projectDir, buildId)
  const abs = path.join(buildDir, file)
  if (path.dirname(abs) !== buildDir) return null
  try {
    if (!fsSync.lstatSync(projectDir).isDirectory()) return null
    if (!fsSync.lstatSync(buildDir).isDirectory()) return null
    return fsSync.lstatSync(abs).isFile() ? abs : null
  } catch {
    return null
  }
}
