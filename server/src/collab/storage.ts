/**
 * Disk helpers for the collab module: atomic writes (temp file + rename), sidecar paths and
 * the sidecar container format.
 *
 * Sidecar format (`ystate/<pid>/<fileId>.<epoch>.ybin`):
 *   MAGIC (8 bytes 'FOLIOYS1') · uint32 BE header length · header JSON (UTF-8) · Y.encodeStateAsUpdate bytes
 * The header records which disk text the state corresponds to, so a crash between the sidecar
 * write and the text write is recognised on the next load (instead of being mistaken for an
 * outside edit and "reconciled" away), and which client id created the document's initial
 * content (its lineage, used to refuse clients whose state comes from a lost earlier lineage).
 * A file without the magic prefix is read as a bare Yjs update.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

/** Ids produced by db.newId() are 16 url-safe chars; accept a slightly wider set, never '.' or '/'. */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function isSafeId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id)
}

export function sha1(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex')
}

export function projectStateDir(ystateDir: string, projectId: string): string {
  if (!isSafeId(projectId)) throw new Error(`invalid project id ${JSON.stringify(projectId)}`)
  return path.join(ystateDir, projectId)
}

export function sidecarPath(ystateDir: string, projectId: string, fileId: string, epoch: number): string {
  if (!isSafeId(fileId)) throw new Error(`invalid file id ${JSON.stringify(fileId)}`)
  if (!Number.isSafeInteger(epoch) || epoch < 0) throw new Error(`invalid epoch ${epoch}`)
  return path.join(projectStateDir(ystateDir, projectId), `${fileId}.${epoch}.ybin`)
}

/** Name of the persisted meta-room document inside `ystate/<pid>/` (cannot collide with `<id>.<epoch>.ybin`). */
export const META_SIDECAR_NAME = '_project-meta.ybin'

/** Every sidecar of a file as `{ epoch, path }` (any epoch). */
export async function listSidecars(ystateDir: string, projectId: string, fileId: string): Promise<{ epoch: number; path: string }[]> {
  const dir = projectStateDir(ystateDir, projectId)
  let names: string[]
  try {
    names = await fsp.readdir(dir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const prefix = `${fileId}.`
  const out: { epoch: number; path: string }[] = []
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith('.ybin')) continue
    const mid = name.slice(prefix.length, -'.ybin'.length)
    if (!/^\d+$/.test(mid)) continue
    out.push({ epoch: Number(mid), path: path.join(dir, name) })
  }
  return out
}

// ---------------------------------------------------------------------------
// Sidecar container
// ---------------------------------------------------------------------------

const MAGIC = Buffer.from('FOLIOYS1', 'latin1')

export interface SidecarHeader {
  v: 1
  /** sha1 of the Y.Text content encoded in this state */
  textHash: string
  /** sha1 of the disk text before the save that wrote this sidecar (null: unknown/missing) */
  prevTextHash: string | null
  /** client id that inserted the lineage's initial content (null: the lineage started empty) */
  base: number | null
  savedAt: number
}

export function encodeSidecar(header: SidecarHeader, update: Uint8Array): Buffer {
  const json = Buffer.from(JSON.stringify(header), 'utf8')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(json.length, 0)
  return Buffer.concat([MAGIC, len, json, update])
}

export function decodeSidecar(bytes: Uint8Array): { header: SidecarHeader | null; update: Uint8Array } {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buf.length < MAGIC.length + 4 || !buf.subarray(0, MAGIC.length).equals(MAGIC)) {
    return { header: null, update: bytes }
  }
  const len = buf.readUInt32BE(MAGIC.length)
  const start = MAGIC.length + 4
  if (start + len > buf.length) throw new Error('truncated sidecar header')
  const raw = JSON.parse(buf.subarray(start, start + len).toString('utf8')) as Partial<SidecarHeader>
  const header: SidecarHeader = {
    v: 1,
    textHash: typeof raw.textHash === 'string' ? raw.textHash : '',
    prevTextHash: typeof raw.prevTextHash === 'string' ? raw.prevTextHash : null,
    base: typeof raw.base === 'number' && Number.isSafeInteger(raw.base) ? raw.base : null,
    savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
  }
  return { header, update: new Uint8Array(buf.buffer, buf.byteOffset + start + len, buf.length - start - len) }
}

// ---------------------------------------------------------------------------
// Atomic writes
// ---------------------------------------------------------------------------

function tmpName(dir: string, target: string): string {
  return path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`)
}

async function writeTemp(dir: string, target: string, data: string | Uint8Array): Promise<string> {
  await fsp.mkdir(dir, { recursive: true })
  const tmp = tmpName(dir, target)
  try {
    const fh = await fsp.open(tmp, 'wx', 0o644)
    try {
      await fh.writeFile(data)
      await fh.sync()
    } finally {
      await fh.close()
    }
    return tmp
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

/**
 * Write `data` atomically: write + fsync a temp file, then rename it over the target (rename
 * replaces a symlink at the target instead of following it).
 *
 * `target` may be a resolver; it is evaluated synchronously immediately before the rename (and
 * the rename itself is synchronous), so a file move/delete recorded in the db while the temp file
 * was being written is honoured — null cancels the write. `cancelled()` is checked at the same
 * point. The temp file lives in `tmpDir` when given (keeps project directories free of transient
 * files); when that is on another filesystem (EXDEV) the write is retried next to the target.
 * Returns the path written, or null when cancelled.
 */
export async function writeFileAtomic(
  target: string | (() => string | null),
  data: string | Uint8Array,
  opts: { tmpDir?: string; cancelled?: () => boolean } = {},
): Promise<string | null> {
  const resolve = typeof target === 'string' ? () => target : target
  const initial = resolve()
  if (initial === null) return null
  const commit = (tmp: string): string | null => {
    if (opts.cancelled?.()) return null
    const file = resolve()
    if (file === null) return null
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.renameSync(tmp, file)
    return file
  }
  const attempt = async (dir: string): Promise<string | null> => {
    const tmp = await writeTemp(dir, initial, data)
    try {
      const out = commit(tmp)
      if (out === null) await fsp.rm(tmp, { force: true })
      return out
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {})
      throw err
    }
  }
  if (opts.tmpDir) {
    try {
      return await attempt(opts.tmpDir)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    }
  }
  return attempt(path.dirname(resolve() ?? initial))
}

/** Synchronous variant (small files only — used for the meta document, which must hit disk before it is broadcast). */
export function writeFileAtomicSync(file: string, data: Uint8Array): void {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = tmpName(dir, file)
  try {
    const fd = fs.openSync(tmp, 'wx', 0o644)
    try {
      fs.writeFileSync(fd, data)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    fs.renameSync(tmp, file)
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }) } catch { /* ignore */ }
    throw err
  }
}

/** Read a file, returning null when it does not exist. */
export async function readIfExists(file: string): Promise<Buffer | null> {
  try {
    return await fsp.readFile(file)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
}
