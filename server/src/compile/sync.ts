/**
 * Snapshot → compile directory sync (SPEC §4.5 "Compile dir").
 *
 * `compiles/<pid>/` is persistent and writable by the sandbox (aux files survive between
 * compiles, so a typical recompile is one pass). Our Node process runs on the host as the same
 * uid as the container user, so everything here is written defensively:
 *
 *   - the whole tree is walked with lstat semantics first; symlinks, FIFOs, sockets and devices
 *     are unlinked (a compile could plant `main.tex -> ~/.bashrc`), leftover temp files removed;
 *   - every parent component of a target is verified to be a real directory (non-directories are
 *     replaced), a directory standing where a file must go is removed;
 *   - files are written to a temp name in the same directory, then renamed over the target
 *     (rename replaces a symlink instead of following it);
 *   - only files whose content changed are rewritten (sha1 in `.folio-sync.json`, plus size and
 *     mtime so that a source modified inside the compile dir is detected), which preserves mtimes
 *     for latexmk;
 *   - files we synced earlier that left the project are unlinked; everything else TeX generated
 *     (aux, bbl, toc, …) is kept. Without a readable manifest the directory state is unknown and
 *     it is emptied first.
 *
 * TeX cannot touch the manifest: openout_any=p forbids writing dot-files.
 */
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import type { Stats } from 'node:fs'
import { constants as fsConstants } from 'node:fs'
import path from 'node:path'

export const MANIFEST_NAME = '.folio-sync.json'
const TMP_PREFIX = '.folio-tmp-'

export interface SnapshotEntry {
  /** project path (validated, POSIX, relative) */
  path: string
  kind: 'text' | 'binary' | 'folder'
  /** sha1 hex of the content ('' for folders) */
  sha1: string
  size: number
  /** text files: live UTF-8 content */
  data?: Buffer
  /** binary files: absolute path of the canonical file on disk */
  source?: string
}

export interface ManifestEntry {
  sha1: string
  size: number
  mtimeMs: number
}

export interface SyncManifest {
  version: 1
  files: Record<string, ManifestEntry>
  /** xr external document path → key (source sha1 + engine) of its last pre-build */
  externals: Record<string, string>
  /**
   * root document path → options of its last latexmk run. latexmk does not notice a changed
   * `-usepretex` (draft) and would report "up-to-date" — the caller forces a run (-gt) instead.
   */
  jobs: Record<string, string>
}

export interface SyncResult {
  manifest: SyncManifest
  written: string[]
  removed: string[]
}

function emptyManifest(): SyncManifest {
  return { version: 1, files: Object.create(null), externals: Object.create(null), jobs: Object.create(null) }
}

/** Resolve `rel` inside `base`, refusing anything that escapes it. */
export function insidePath(base: string, rel: string): string {
  const root = path.resolve(base)
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Path escapes the compile directory: ${rel}`)
  return abs
}

async function lstatOrNull(p: string): Promise<Stats | null> {
  try {
    return await fs.lstat(p)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return null
    throw err
  }
}

/** Make sure `dir` is a real directory (not a symlink / file), creating it if needed. */
export async function ensureRealDir(dir: string): Promise<void> {
  const st = await lstatOrNull(dir)
  if (st?.isDirectory()) return
  if (st) await fs.rm(dir, { force: true })
  await fs.mkdir(dir, { recursive: true })
  const again = await fs.lstat(dir)
  if (!again.isDirectory()) throw new Error(`Not a directory: ${dir}`)
}

/** Create the directory chain base/rel component by component, replacing non-directories. */
export async function ensureDirPath(base: string, rel: string): Promise<void> {
  if (!rel || rel === '.') return
  let cur = base
  for (const part of rel.split('/')) {
    cur = path.join(cur, part)
    const st = await lstatOrNull(cur)
    if (st?.isDirectory()) continue
    if (st) await fs.rm(cur, { force: true })
    await fs.mkdir(cur)
  }
}

/**
 * lstat `base/rel` with every parent component checked to be a real directory. Returns the
 * stats of a regular file, or null (missing, symlink anywhere on the way, not a file).
 */
export async function safeFileStat(base: string, rel: string): Promise<Stats | null> {
  let abs: string
  try {
    abs = insidePath(base, rel)
  } catch {
    return null
  }
  const parts = path.relative(base, abs).split(path.sep)
  let cur = base
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i])
    const st = await lstatOrNull(cur)
    if (!st) return null
    if (i < parts.length - 1) {
      if (!st.isDirectory()) return null
    } else {
      return st.isFile() ? st : null
    }
  }
  return null
}

/** Remove everything inside `dir` (not `dir` itself). Symlinks are unlinked, never followed. */
export async function emptyDir(dir: string): Promise<void> {
  let names: string[]
  try {
    names = await fs.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  await Promise.all(names.map(n => fs.rm(path.join(dir, n), { recursive: true, force: true })))
}

/**
 * Walk the compile dir without following links: unlink symlinks, special files and our own
 * leftover temp files; return every regular file (project-relative POSIX path → stats).
 */
export async function sanitizeTree(base: string): Promise<Map<string, Stats>> {
  const files = new Map<string, Stats>()
  const walk = async (rel: string): Promise<void> => {
    const dir = rel ? path.join(base, rel) : base
    let dirents
    try {
      dirents = await fs.readdir(dir, { withFileTypes: true })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    for (const d of dirents) {
      const r = rel ? `${rel}/${d.name}` : d.name
      const abs = path.join(dir, d.name)
      if (d.isDirectory()) {
        await walk(r)
      } else if (d.isFile() && !d.name.startsWith(TMP_PREFIX)) {
        const st = await lstatOrNull(abs)
        if (st?.isFile()) files.set(r, st)
      } else {
        // symlink, FIFO, socket, device, or a stale temp file
        await fs.rm(abs, { force: true })
      }
    }
  }
  await walk('')
  return files
}

export async function readManifest(compileDir: string): Promise<SyncManifest | null> {
  const p = path.join(compileDir, MANIFEST_NAME)
  const st = await lstatOrNull(p)
  if (!st?.isFile() || st.size > 64 * 1024 * 1024) return null
  try {
    const raw = JSON.parse(await fs.readFile(p, 'utf8')) as Partial<SyncManifest>
    if (raw.version !== 1 || typeof raw.files !== 'object' || raw.files === null) return null
    const m = emptyManifest()
    for (const [k, v] of Object.entries(raw.files)) {
      if (v && typeof v.sha1 === 'string' && typeof v.size === 'number' && typeof v.mtimeMs === 'number') m.files[k] = v
    }
    for (const [k, v] of Object.entries(raw.externals ?? {})) {
      if (typeof v === 'string') m.externals[k] = v
    }
    for (const [k, v] of Object.entries(raw.jobs ?? {})) {
      if (typeof v === 'string') m.jobs[k] = v
    }
    return m
  } catch {
    return null
  }
}

export async function writeManifest(compileDir: string, m: SyncManifest): Promise<void> {
  await atomicWrite(compileDir, MANIFEST_NAME, Buffer.from(JSON.stringify(m)))
}

/** Write base/rel through a temp file + rename (never follows a symlink at the target). */
export async function atomicWrite(base: string, rel: string, data: Buffer): Promise<void> {
  const target = insidePath(base, rel)
  const tmp = path.join(path.dirname(target), `${TMP_PREFIX}${randomBytes(8).toString('hex')}`)
  try {
    await fs.writeFile(tmp, data, { flag: 'wx', mode: 0o644 })
    await fs.rename(tmp, target)
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

async function copyInto(base: string, rel: string, source: string): Promise<boolean> {
  const src = await lstatOrNull(source)
  if (!src?.isFile()) return false
  const target = insidePath(base, rel)
  const tmp = path.join(path.dirname(target), `${TMP_PREFIX}${randomBytes(8).toString('hex')}`)
  try {
    await fs.copyFile(source, tmp, fsConstants.COPYFILE_EXCL)
    await fs.chmod(tmp, 0o644)
    await fs.rename(tmp, target)
    return true
  } catch (err) {
    await fs.rm(tmp, { force: true })
    throw err
  }
}

/**
 * Bring `compileDir` in line with the snapshot. `skip` lists project paths that must not be
 * written (they would clash with TeX outputs, e.g. `<job>.pdf`). Writes the manifest.
 */
export async function syncCompileDir(compileDir: string, entries: SnapshotEntry[], opts: { skip?: Set<string> } = {}): Promise<SyncResult> {
  const skip = opts.skip ?? new Set<string>()
  await ensureRealDir(compileDir)
  let manifest = await readManifest(compileDir)
  if (!manifest) {
    await emptyDir(compileDir)
    manifest = emptyManifest()
  }
  const onDisk = await sanitizeTree(compileDir)

  const wanted = new Map<string, SnapshotEntry>()
  for (const e of entries) {
    if (e.kind !== 'folder' && skip.has(e.path)) continue
    insidePath(compileDir, e.path)
    wanted.set(e.path, e)
  }

  const removed: string[] = []
  for (const p of Object.keys(manifest.files)) {
    const e = wanted.get(p)
    if (e && e.kind !== 'folder') continue
    if (!skip.has(p) && onDisk.has(p)) {
      await fs.rm(insidePath(compileDir, p), { force: true })
      onDisk.delete(p)
      removed.push(p)
    }
  }

  const next = emptyManifest()
  const written: string[] = []
  // folders first (TeX may write into empty project folders, e.g. TikZ externalisation)
  for (const e of wanted.values()) {
    if (e.kind !== 'folder') continue
    await ensureDirPath(compileDir, e.path)
  }
  for (const e of wanted.values()) {
    if (e.kind === 'folder') continue
    const prev = manifest.files[e.path]
    const disk = onDisk.get(e.path)
    if (prev && prev.sha1 === e.sha1 && disk && disk.size === prev.size && disk.mtimeMs === prev.mtimeMs) {
      next.files[e.path] = prev
      continue
    }
    await ensureDirPath(compileDir, path.posix.dirname(e.path) === '.' ? '' : path.posix.dirname(e.path))
    const target = insidePath(compileDir, e.path)
    const cur = await lstatOrNull(target)
    if (cur && !cur.isFile()) await fs.rm(target, { recursive: true, force: true })
    let ok = true
    if (e.kind === 'text') await atomicWrite(compileDir, e.path, e.data ?? Buffer.alloc(0))
    else ok = e.source ? await copyInto(compileDir, e.path, e.source) : false
    if (!ok) continue
    const after = await fs.lstat(target)
    next.files[e.path] = { sha1: e.sha1, size: after.size, mtimeMs: after.mtimeMs }
    written.push(e.path)
  }
  for (const [k, v] of Object.entries(manifest.externals)) {
    if (wanted.has(k)) next.externals[k] = v
  }
  for (const [k, v] of Object.entries(manifest.jobs)) {
    if (wanted.has(k)) next.jobs[k] = v
  }
  await writeManifest(compileDir, next)
  return { manifest: next, written, removed }
}
