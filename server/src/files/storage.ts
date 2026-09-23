/**
 * Low-level, symlink-safe file system access for project directories.
 *
 * Invariants:
 *  - every path handed to the file system is built from a validated project path
 *    (shared/paths.ts) joined under the project root, and checked to stay inside it;
 *  - no component below the project root may be a symlink (checked with lstat before
 *    writing, reads open with O_NOFOLLOW);
 *  - writes are atomic: temp file in DATA_DIR/tmp (same file system) + fsync + rename, so a
 *    reader (compile sync, git snapshot, zip export) never sees a half-written file and temp
 *    files never appear inside the project tree.
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { normalizePath, validatePath } from '@folio/shared/paths'
import { badRequest, conflict, HttpError } from '../http/errors.ts'

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0

/** Validate a project path and return it normalised (400 on invalid input). */
export function checkProjectPath(input: string): string {
  if (typeof input !== 'string') throw badRequest('Path is required')
  const p = normalizePath(input)
  const err = validatePath(p)
  if (err) throw badRequest(err)
  return p
}

/** Lexically join a validated project path under `root` and make sure it stays inside. */
export function joinInside(root: string, projectPath: string): string {
  const p = checkProjectPath(projectPath)
  const abs = path.resolve(root, ...p.split('/'))
  if (abs === root || !abs.startsWith(root + path.sep)) throw badRequest('Path escapes the project directory')
  return abs
}

class SymlinkError extends HttpError {
  constructor(where: string) {
    super(400, 'validation', `Refusing to follow a symbolic link at ${where}`)
  }
}

/** Components strictly between `root` and `abs` (parents of abs), from the top down. */
function parentChain(root: string, abs: string): string[] {
  const rel = path.relative(root, abs)
  const segs = rel.split(path.sep)
  const out: string[] = []
  let cur = root
  for (let i = 0; i < segs.length - 1; i++) {
    cur = path.join(cur, segs[i])
    out.push(cur)
  }
  return out
}

/**
 * Throw when a component of `abs` below `root` (including `abs` itself when `includeSelf`) is a
 * symlink or a parent is not a directory. Missing components are fine (they will be created).
 */
export async function assertNoSymlinks(root: string, abs: string, includeSelf = true): Promise<void> {
  const chain = parentChain(root, abs)
  if (includeSelf) chain.push(abs)
  for (let i = 0; i < chain.length; i++) {
    let st: fs.Stats
    try {
      st = await fsp.lstat(chain[i])
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    if (st.isSymbolicLink()) throw new SymlinkError(path.relative(root, chain[i]))
    if (i < chain.length - (includeSelf ? 1 : 0) && !st.isDirectory()) {
      throw conflict(`"${path.relative(root, chain[i]).split(path.sep).join('/')}" is a file, not a folder`)
    }
  }
}

/** Synchronous variant for `FileService.absPath` (a handful of lstat calls). */
export function assertNoSymlinksSync(root: string, abs: string): void {
  const chain = parentChain(root, abs)
  chain.push(abs)
  for (const p of chain) {
    let st: fs.Stats
    try {
      st = fs.lstatSync(p)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return
      throw e
    }
    if (st.isSymbolicLink()) throw new SymlinkError(path.relative(root, p))
  }
}

/** mkdir -p for a directory inside `root`, refusing symlinked components. */
export async function ensureDir(root: string, absDir: string): Promise<void> {
  if (absDir === root) {
    await fsp.mkdir(root, { recursive: true })
    return
  }
  await assertNoSymlinks(root, absDir)
  await fsp.mkdir(absDir, { recursive: true, mode: 0o755 })
  // re-check after creation: a racing writer could have planted a link
  await assertNoSymlinks(root, absDir)
}

/**
 * Atomically replace (or create) the file at `abs` with `data`.
 * `tmpDir` should be on the same file system as `root` (DATA_DIR/tmp); on EXDEV we fall back to a
 * reserved-name temp file next to the target (names starting with `.folio` are never valid
 * project paths, so it can never collide with a user file).
 */
export async function writeFileAtomic(root: string, abs: string, data: Buffer | string, tmpDir: string, opts: { exclusive?: boolean } = {}): Promise<void> {
  if (!abs.startsWith(root + path.sep)) throw badRequest('Path escapes the project directory')
  await ensureDir(root, path.dirname(abs))
  const existing = await lstatOrNull(abs)
  if (existing) {
    if (opts.exclusive) throw conflict(`"${path.relative(root, abs).split(path.sep).join('/')}" already exists`)
    if (existing.isDirectory()) throw conflict(`"${path.relative(root, abs).split(path.sep).join('/')}" is a folder`)
  }
  await fsp.mkdir(tmpDir, { recursive: true })
  let tmp = path.join(tmpDir, `w-${randomUUID()}`)
  await writeAndSync(tmp, data)
  try {
    if (existing?.isSymbolicLink()) await fsp.unlink(abs)
    try {
      await fsp.rename(tmp, abs)
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e
      const local = path.join(path.dirname(abs), `.folio-tmp-${randomUUID()}`)
      await fsp.copyFile(tmp, local, fs.constants.COPYFILE_EXCL)
      await fsp.unlink(tmp).catch(() => {})
      tmp = local
      await fsp.rename(tmp, abs)
    }
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {})
    throw e
  }
}

async function writeAndSync(file: string, data: Buffer | string): Promise<void> {
  const fh = await fsp.open(file, 'wx', 0o644)
  try {
    await fh.writeFile(data)
    await fh.sync()
  } finally {
    await fh.close()
  }
}

export async function lstatOrNull(abs: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(abs)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
}

/** Read a regular file without following a symlink at the final component. */
export async function readFileNoFollow(abs: string): Promise<Buffer> {
  const fh = await fsp.open(abs, fs.constants.O_RDONLY | O_NOFOLLOW)
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw badRequest('Not a regular file')
    return await fh.readFile()
  } finally {
    await fh.close()
  }
}

/** Open a read stream on a regular file without following symlinks. */
export async function openReadStreamNoFollow(abs: string): Promise<{ stream: fs.ReadStream; size: number }> {
  const fh = await fsp.open(abs, fs.constants.O_RDONLY | O_NOFOLLOW)
  try {
    const st = await fh.stat()
    if (!st.isFile()) throw badRequest('Not a regular file')
    return { stream: fh.createReadStream({ autoClose: true }), size: st.size }
  } catch (e) {
    await fh.close()
    throw e
  }
}

/** Remove a file or directory tree (never follows symlinks: a link is removed, not its target). */
export async function removeTree(abs: string): Promise<void> {
  await fsp.rm(abs, { recursive: true, force: true })
}

/**
 * Everything a rename `fromAbs` → `toAbs` inside `root` needs before the rename itself: symlink
 * checks, the destination's parent folders, and "destination is free". Returns whether the source
 * exists on disk (a folder that was never materialised has nothing to rename). The caller then
 * renames synchronously (fs.renameSync) in the same tick as its db update.
 */
export async function prepareMove(root: string, fromAbs: string, toAbs: string): Promise<boolean> {
  await assertNoSymlinks(root, fromAbs, false)
  const src = await lstatOrNull(fromAbs)
  if (src?.isSymbolicLink()) throw new SymlinkError(path.relative(root, fromAbs))
  await ensureDir(root, path.dirname(toAbs))
  if (await lstatOrNull(toAbs)) throw conflict(`"${path.relative(root, toAbs).split(path.sep).join('/')}" already exists`)
  return !!src
}

/** Rename `fromAbs` → `toAbs` inside `root` (creates the destination's parents). */
export async function movePath(root: string, fromAbs: string, toAbs: string): Promise<void> {
  if (await prepareMove(root, fromAbs, toAbs)) await fsp.rename(fromAbs, toAbs)
}
