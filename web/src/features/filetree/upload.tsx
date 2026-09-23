/**
 * Upload engine shared by the UploadModal, OS drops onto the file tree and BinaryPreview's
 * "Replace…": collect files (including whole folders via webkitGetAsEntry / webkitdirectory),
 * validate them against the project (names, folders in the way, existing files), upload in
 * batches of ≤ 200 files with byte-accurate per-file progress, and turn a server 409 into a
 * list of conflicting paths that can be re-sent with replace=true.
 */
import type { FileEntry } from '@folio/shared/api'
import { basename, dirname, joinPath, normalizePath, validatePath } from '@folio/shared/paths'
import { api, type UploadItem } from '../../api/endpoints'
import { ApiError, errorMessage, isAbortError } from '../../api/client'
import { formatBytes, pluralize } from '../../lib/format'
import { useProject } from '../../stores/project'
import { confirmDialog, dismissToast, toast } from '../../ui'

/** Files accepted by one upload request (server: MAX_UPLOAD_FILES). */
export const MAX_FILES_PER_REQUEST = 200
/** Keep single requests reasonably small so progress stays smooth and failures cheap. */
const MAX_BYTES_PER_REQUEST = 64 * 1024 * 1024

/** OS clutter that is never uploaded. */
const JUNK = /(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__MACOSX(\/.*)?|\.git(\/.*)?)$/i

export interface PickedFile {
  file: File
  /** path relative to the upload folder ('figs/a.png') */
  relativePath: string
}

// -------------------------------------------------------------------------------------------
// collecting files
// -------------------------------------------------------------------------------------------

function cleanRelative(p: string): string {
  return normalizePath(p.replace(/^\.\//, ''))
}

/** From an <input type=file> (multiple or webkitdirectory). */
export function filesFromInput(list: FileList | null): PickedFile[] {
  if (!list) return []
  const out: PickedFile[] = []
  for (const file of Array.from(list)) {
    const rel = cleanRelative(file.webkitRelativePath || file.name)
    if (rel && !JUNK.test(rel)) out.push({ file, relativePath: rel })
  }
  return out
}

function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  // readEntries returns results in chunks (≤ 100 in Chrome) until it yields an empty array
  return new Promise((resolve, reject) => {
    const all: FileSystemEntry[] = []
    const next = () => reader.readEntries(batch => {
      if (batch.length === 0) resolve(all)
      else {
        all.push(...batch)
        next()
      }
    }, reject)
    next()
  })
}

function entryFile(entry: FileSystemFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject))
}

async function walkEntry(entry: FileSystemEntry, out: PickedFile[]): Promise<void> {
  const rel = cleanRelative(entry.fullPath || entry.name)
  if (JUNK.test(rel)) return
  if (entry.isFile) {
    const file = await entryFile(entry as FileSystemFileEntry)
    out.push({ file, relativePath: rel || file.name })
  } else if (entry.isDirectory) {
    const children = await readAllEntries((entry as FileSystemDirectoryEntry).createReader())
    for (const c of children) await walkEntry(c, out)
  }
}

/** True when a drag carries files from the OS (as opposed to tree items or text). */
export function isOsFileDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false
  return Array.from(dt.types).includes('Files')
}

/**
 * Snapshot a drop's DataTransfer. Must be called synchronously inside the drop handler
 * (DataTransferItems are only readable during the event); the returned promise then reads
 * folders recursively.
 */
export function filesFromDrop(dt: DataTransfer): Promise<PickedFile[]> {
  const entries: FileSystemEntry[] = []
  const plain: File[] = []
  const items = dt.items ? Array.from(dt.items) : []
  for (const item of items) {
    if (item.kind !== 'file') continue
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    if (entry) entries.push(entry)
    else {
      const f = item.getAsFile()
      if (f) plain.push(f)
    }
  }
  if (entries.length === 0 && plain.length === 0) plain.push(...Array.from(dt.files))
  return (async () => {
    const out: PickedFile[] = []
    for (const e of entries) await walkEntry(e, out)
    for (const f of plain) if (!JUNK.test(f.name)) out.push({ file: f, relativePath: f.name })
    return out
  })()
}

// -------------------------------------------------------------------------------------------
// planning
// -------------------------------------------------------------------------------------------

export interface PlannedFile extends PickedFile {
  /** full project path */
  path: string
  /** a file already exists at `path` (needs replace) */
  exists: boolean
  /** why this file cannot be uploaded (invalid name, a folder is in the way …) */
  error: string | null
}

/** Validate picked files for upload into `folder` against the current project tree. */
export function planUpload(folder: string, picked: PickedFile[]): PlannedFile[] {
  const project = useProject.getState()
  const seen = new Set<string>()
  return picked.map(p => {
    const path = joinPath(folder, p.relativePath)
    let error = validatePath(path)
    if (error) error = error.replace(/: "[^"]*"$/, '')
    let exists = false
    if (!error && seen.has(path)) error = 'This file appears twice in the upload.'
    seen.add(path)
    if (!error) {
      const existing = project.fileByPath(path)
      if (existing?.kind === 'folder') error = 'A folder with this name already exists here.'
      else if (existing) exists = true
    }
    if (!error) {
      const segs = path.split('/')
      for (let i = 1; i < segs.length; i++) {
        const parent = project.fileByPath(segs.slice(0, i).join('/'))
        if (parent && parent.kind !== 'folder') {
          error = `“${parent.path}” is a file, not a folder.`
          break
        }
      }
    }
    return { ...p, path, exists, error }
  })
}

// -------------------------------------------------------------------------------------------
// running
// -------------------------------------------------------------------------------------------

export interface UploadCallbacks {
  /** overall bytes sent / total bytes */
  onProgress?(loaded: number, total: number): void
  /** per-file progress 0..1 (index into the `files` argument) */
  onFileProgress?(index: number, fraction: number): void
  onFileDone?(index: number, entry: FileEntry | null): void
  onFileError?(index: number, message: string): void
}

export interface UploadResult {
  uploaded: FileEntry[]
  failed: { index: number; message: string }[]
  /** indexes rejected with 409 because a file exists (only when replace=false) */
  conflicts: number[]
  aborted: boolean
}

function batches(files: PickedFile[], indexes: number[]): number[][] {
  const out: number[][] = []
  let cur: number[] = []
  let bytes = 0
  for (const i of indexes) {
    const size = files[i].file.size
    if (cur.length > 0 && (cur.length >= MAX_FILES_PER_REQUEST || bytes + size > MAX_BYTES_PER_REQUEST)) {
      out.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(i)
    bytes += size
  }
  if (cur.length) out.push(cur)
  return out
}

function conflictPaths(e: unknown): string[] | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null
  const details = e.details as { existing?: unknown } | undefined
  return Array.isArray(details?.existing) ? details.existing.filter((x): x is string => typeof x === 'string') : []
}

function uploadErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.status === 413) return e.message && e.message !== 'That is too large.' ? e.message : 'The file is too large to upload.'
  return errorMessage(e, 'The upload failed.')
}

/**
 * Upload `files` (relative to `folder`) in batches. Files are identified by their index in
 * `files`; only `indexes` (default: all) are sent. Never throws except for AbortError-free
 * programming errors: failures are reported per file.
 */
export async function runUpload(
  pid: string,
  folder: string,
  files: PickedFile[],
  opts: { replace: boolean; indexes?: number[]; signal?: AbortSignal } & UploadCallbacks,
): Promise<UploadResult> {
  const indexes = opts.indexes ?? files.map((_f, i) => i)
  const total = indexes.reduce((s, i) => s + files[i].file.size, 0) || 1
  const result: UploadResult = { uploaded: [], failed: [], conflicts: [], aborted: false }
  let done = 0

  const sendBatch = async (batch: number[]): Promise<void> => {
    const items: UploadItem[] = batch.map(i => ({ file: files[i].file, relativePath: files[i].relativePath }))
    const sizes = batch.map(i => files[i].file.size)
    const batchBytes = sizes.reduce((a, b) => a + b, 0)
    const report = (fraction: number) => {
      const loaded = fraction * batchBytes
      opts.onProgress?.(done + loaded, total)
      let offset = 0
      batch.forEach((idx, k) => {
        const size = sizes[k]
        const f = size === 0 ? (fraction > 0 ? 1 : 0) : Math.min(1, Math.max(0, (loaded - offset) / size))
        opts.onFileProgress?.(idx, fraction >= 1 ? 1 : f)
        offset += size
      })
    }
    report(0)
    try {
      const res = await api.uploadFiles(pid, items, folder, opts.replace, fraction => report(fraction), { signal: opts.signal })
      const byPath = new Map(res.files.map(f => [f.path, f]))
      for (const i of batch) {
        const entry = byPath.get(joinPath(folder, files[i].relativePath)) ?? null
        opts.onFileDone?.(i, entry)
        if (entry) result.uploaded.push(entry)
      }
      done += batchBytes
      opts.onProgress?.(done, total)
    } catch (e) {
      if (isAbortError(e)) throw e
      const conflicts = conflictPaths(e)
      if (conflicts && !opts.replace) {
        const set = new Set(conflicts)
        const conflicting = batch.filter(i => set.has(joinPath(folder, files[i].relativePath)))
        if (conflicting.length > 0) {
          result.conflicts.push(...conflicting)
          const rest = batch.filter(i => !set.has(joinPath(folder, files[i].relativePath)))
          done += conflicting.reduce((s, i) => s + files[i].file.size, 0)
          // nothing of the batch was written: send the others again on their own
          if (rest.length) await sendBatch(rest)
          return
        }
      }
      if (batch.length > 1 && e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 409) {
        // attribute the error to the file(s) that caused it
        for (const i of batch) await sendBatch([i])
        return
      }
      const message = uploadErrorMessage(e)
      for (const i of batch) {
        result.failed.push({ index: i, message })
        opts.onFileError?.(i, message)
      }
      done += batchBytes
      opts.onProgress?.(done, total)
    }
  }

  try {
    for (const batch of batches(files, indexes)) {
      if (opts.signal?.aborted) throw new DOMException('Upload aborted', 'AbortError')
      await sendBatch(batch)
    }
  } catch (e) {
    if (!isAbortError(e)) throw e
    result.aborted = true
  }
  return result
}

// -------------------------------------------------------------------------------------------
// quick upload (OS drop onto the tree) with a progress toast
// -------------------------------------------------------------------------------------------

function folderLabel(folder: string): string {
  return folder ? `${folder}/` : 'the project root'
}

let quickSeq = 0

/**
 * Upload dropped files into `folder` with a progress toast. Asks before replacing existing
 * files; files that cannot be uploaded are reported in the final toast.
 */
export async function quickUpload(folder: string, picked: PickedFile[]): Promise<void> {
  const project = useProject.getState()
  const pid = project.projectId
  if (!pid || picked.length === 0) return
  if (!project.canEdit()) {
    toast('You have view access to this project, so you can’t upload files.', { tone: 'warning' })
    return
  }
  const plan = planUpload(folder, picked)
  const invalid = plan.filter(p => p.error)
  const valid = plan.map((p, i) => ({ p, i })).filter(x => !x.p.error)
  let replace = false
  let indexes = valid.map(x => x.i)
  const existing = valid.filter(x => x.p.exists)
  if (existing.length > 0) {
    const ok = await confirmDialog({
      title: existing.length === 1 ? 'Replace existing file?' : `Replace ${existing.length} existing files?`,
      message: <ConflictList paths={existing.map(x => x.p.path)} />,
      confirmLabel: 'Replace',
    })
    if (!ok) {
      indexes = indexes.filter(i => !plan[i].exists)
    } else {
      replace = true
    }
  }
  if (indexes.length === 0) {
    if (invalid.length) toast(invalidSummary(invalid), { tone: 'error' })
    return
  }

  const id = `ft-upload-${++quickSeq}`
  const ctrl = new AbortController()
  const count = pluralize(indexes.length, 'file')
  const totalBytes = indexes.reduce((s, i) => s + plan[i].file.size, 0)
  const show = (pct: number) =>
    toast(
      <span className="ft-toastprogress">
        <span>Uploading {count} to {folderLabel(folder)} · {pct}%</span>
        <span className="ft-toastprogress__bar" aria-hidden="true"><span style={{ width: `${pct}%` }} /></span>
      </span>,
      { id, duration: 0, action: { label: 'Cancel', onClick: () => ctrl.abort() } },
    )
  show(0)
  let lastPct = -1
  const res = await runUpload(pid, folder, plan, {
    replace,
    indexes,
    signal: ctrl.signal,
    onProgress: (loaded, total) => {
      const pct = Math.min(100, Math.round((loaded / total) * 100))
      if (pct !== lastPct) {
        lastPct = pct
        show(pct)
      }
    },
  })
  dismissToast(id)
  if (res.aborted) {
    toast('Upload cancelled.', { tone: 'info' })
    return
  }
  const failed = res.failed.length + invalid.length
  if (res.uploaded.length > 0 && failed === 0 && res.conflicts.length === 0) {
    toast(`Uploaded ${pluralize(res.uploaded.length, 'file')} (${formatBytes(totalBytes)}) to ${folderLabel(folder)}.`, { tone: 'success' })
    return
  }
  const parts: string[] = []
  if (res.uploaded.length) parts.push(`Uploaded ${pluralize(res.uploaded.length, 'file')}.`)
  if (res.conflicts.length) parts.push(`${pluralize(res.conflicts.length, 'file')} already existed and ${res.conflicts.length === 1 ? 'was' : 'were'} skipped.`)
  if (res.failed.length) parts.push(`${pluralize(res.failed.length, 'file')} failed: ${res.failed[0].message}`)
  if (invalid.length) parts.push(invalidSummary(invalid))
  toast(parts.join(' '), { tone: res.uploaded.length ? 'warning' : 'error', duration: 9000 })
}

function invalidSummary(invalid: PlannedFile[]): string {
  const first = invalid[0]
  return invalid.length === 1
    ? `“${first.relativePath}” can’t be uploaded: ${first.error}`
    : `${invalid.length} files can’t be uploaded (e.g. “${first.relativePath}”: ${first.error})`
}

export function ConflictList({ paths, max = 8 }: { paths: string[]; max?: number }) {
  const shown = paths.slice(0, max)
  return (
    <>
      <p>{paths.length === 1 ? 'This file already exists in the project:' : 'These files already exist in the project:'}</p>
      <ul className="ft-conflictlist">
        {shown.map(p => (
          <li key={p}>
            <code>{p}</code>
          </li>
        ))}
        {paths.length > max && <li className="ft-conflictlist__more">and {paths.length - max} more</li>}
      </ul>
      <p>
        Replacing {paths.length === 1 ? 'it overwrites its' : 'them overwrites their'} current content for everyone. Earlier versions stay available in
        the history.
      </p>
    </>
  )
}

/** Replace one existing file's content with a picked file (BinaryPreview "Replace…"). */
export async function replaceFile(pid: string, target: FileEntry, file: File, onProgress?: (fraction: number) => void): Promise<FileEntry | null> {
  const folder = dirname(target.path)
  const res = await api.uploadFiles(pid, [{ file, relativePath: basename(target.path) }], folder, true, f => onProgress?.(f))
  return res.files[0] ?? null
}
