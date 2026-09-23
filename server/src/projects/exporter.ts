/**
 * Zip export of the current live state (SPEC §4.7): flush the collaborative docs, then stream a
 * yazl zip of every entry — text files from CollabService.getText (live bytes), binaries from
 * disk (O_NOFOLLOW), empty folders as directory entries.
 */
import type { Response } from 'express'
import yazl from 'yazl'
import { extname } from '@folio/shared/paths'
import { moduleLog } from '../log.ts'
import type { Services } from '../services.ts'
import { openReadStreamNoFollow, readFileNoFollow } from '../files/storage.ts'

const log = moduleLog('exporter')

/**
 * yazl (like yauzl) refuses entry names whose first segment looks like a Windows drive ("a:b.tex"),
 * although they are legal project paths on POSIX. Such entries are added under a placeholder and
 * renamed before their header is written — safe because a deflated addBuffer entry only becomes
 * pumpable after the asynchronous deflate. (yazl 3.3.1 internals: ZipFile.entries[].utf8FileName.)
 */
const DRIVE_LIKE = /^[a-zA-Z]:/

function addBufferNamed(zip: yazl.ZipFile, data: Buffer, name: string, opts: { mtime: Date; mode: number; compress: boolean }): void {
  if (!DRIVE_LIKE.test(name)) {
    zip.addBuffer(data, name, opts)
    return
  }
  zip.addBuffer(data, `_${name}`, { ...opts, compress: true })
  const entries = (zip as unknown as { entries: { utf8FileName: Buffer }[] }).entries
  entries[entries.length - 1].utf8FileName = Buffer.from(name, 'utf8')
}

/** Already-compressed formats are stored, not deflated. */
const STORED = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'woff', 'woff2', 'mp3', 'mp4', 'mov'])

/** Build the zip for a project; resolves once every entry has been queued. */
export async function buildProjectZip(s: Services, projectId: string): Promise<yazl.ZipFile> {
  try {
    await s.collab.flushProject(projectId)
  } catch (err) {
    log.warn({ err, projectId }, 'flushProject failed before export; using live texts')
  }
  const entries = s.files.list(projectId)
  const zip = new yazl.ZipFile()
  const withChildren = new Set<string>()
  for (const e of entries) {
    const i = e.path.lastIndexOf('/')
    if (i > 0) withChildren.add(e.path.slice(0, i))
  }
  for (const e of entries) {
    const mtime = new Date(e.updatedAt)
    if (e.kind === 'folder') {
      // (an empty folder with a drive-like name cannot be represented by yazl; it is skipped)
      if (!withChildren.has(e.path) && !DRIVE_LIKE.test(e.path)) zip.addEmptyDirectory(e.path, { mtime })
      continue
    }
    if (e.kind === 'text') {
      const text = await s.collab.getText(projectId, e.id)
      addBufferNamed(zip, Buffer.from(text, 'utf8'), e.path, { mtime, mode: 0o100644, compress: true })
      continue
    }
    const abs = s.files.absPath(projectId, e.path)
    if (DRIVE_LIKE.test(e.path)) {
      addBufferNamed(zip, await readFileNoFollow(abs), e.path, { mtime, mode: 0o100644, compress: true })
      continue
    }
    // opened lazily so a project with many binaries does not hold one fd per file at once
    zip.addReadStreamLazy(e.path, { mtime, mode: 0o100644, compress: !STORED.has(extname(e.path)) }, cb => {
      openReadStreamNoFollow(abs).then(r => cb(null, r.stream), err => cb(err, undefined as unknown as NodeJS.ReadableStream))
    })
  }
  zip.end()
  return zip
}

/** File name for the download: the project name made filesystem-friendly. */
export function zipFileName(projectName: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = projectName.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return `${cleaned || 'project'}.zip`
}

export async function sendProjectZip(s: Services, projectId: string, projectName: string, res: Response): Promise<void> {
  const zip = await buildProjectZip(s, projectId)
  res.setHeader('Content-Type', 'application/zip')
  res.setHeader('Cache-Control', 'no-store')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.attachment(zipFileName(projectName))
  const out = zip.outputStream
  out.on('error', err => {
    log.warn({ err, projectId }, 'zip export failed')
    res.destroy(err as Error)
  })
  res.on('close', () => {
    if (!res.writableFinished) (out as unknown as { destroy?: () => void }).destroy?.()
  })
  out.pipe(res)
}
