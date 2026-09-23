/**
 * EPS/PS → PNG previews for the file tree (SPEC §4.5 "renderPreview"): Ghostscript in the
 * sandbox (-dSAFER, network none, read-only input mount), first page only, cached as
 * `previews/<pid>/<sha1 of the file>.png`.
 *
 * Deviation (safer, same result): instead of mounting the file's project folder we copy the file
 * into a fresh temp folder that holds nothing else and mount that read-only at /in. This keeps
 * sibling files out of the container and makes arbitrary file names safe for `docker -v`.
 */
import { createHash, randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { HttpError, notFound, tooLarge } from '../http/errors.ts'
import type { CompileRunner } from './runner.ts'

export const PREVIEW_EXTENSIONS = new Set(['eps', 'ps', 'epsi', 'epsf'])
export const MAX_PREVIEW_SOURCE_BYTES = 64 * 1024 * 1024
const MAX_PNG_BYTES = 64 * 1024 * 1024
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export function gsPreviewArgv(inputPath: string): string[] {
  return [
    'gs', '-q', '-dSAFER', '-dBATCH', '-dNOPAUSE', '-dEPSCrop', '-sDEVICE=png16m', '-r150',
    '-dTextAlphaBits=4', '-dGraphicsAlphaBits=4', '-dFirstPage=1', '-dLastPage=1',
    // PostScript `print` output goes to stderr so stdout carries nothing but the PNG
    '-sstdout=%stderr', '-sOutputFile=-', inputPath,
  ]
}

export function isPng(buf: Buffer): boolean {
  return buf.length > PNG_SIGNATURE.length && buf.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
}

const inflight = new Map<string, Promise<Buffer>>()

export async function renderPreviewCached(o: {
  runner: CompileRunner
  projectId: string
  /** absolute path of the EPS/PS file in the project dir */
  source: string
  ext: string
  /** previews/<pid> */
  cacheDir: string
  /** scratch space for the per-render input folder */
  tmpDir: string
  containerName: string
  timeoutMs?: number
}): Promise<Buffer> {
  const st = await fs.lstat(o.source).catch(() => null)
  if (!st?.isFile()) throw notFound('File not found')
  if (st.size > MAX_PREVIEW_SOURCE_BYTES) throw tooLarge('File is too large to preview')
  const bytes = await fs.readFile(o.source)
  const sha1 = createHash('sha1').update(bytes).digest('hex')
  const cached = path.join(o.cacheDir, `${sha1}.png`)
  try {
    const hit = await fs.lstat(cached)
    if (hit.isFile()) return await fs.readFile(cached)
  } catch { /* miss */ }

  let job = inflight.get(cached)
  if (!job) {
    job = render(o, bytes, cached).finally(() => inflight.delete(cached))
    inflight.set(cached, job)
  }
  return job
}

async function render(o: Parameters<typeof renderPreviewCached>[0], bytes: Buffer, cached: string): Promise<Buffer> {
  await fs.mkdir(o.tmpDir, { recursive: true })
  const work = await fs.mkdtemp(path.join(o.tmpDir, 'preview-'))
  try {
    const input = `input.${o.ext}`
    await fs.writeFile(path.join(work, input), bytes, { mode: 0o644 })
    await fs.chmod(work, 0o755)
    const r = await o.runner.tool({
      name: o.containerName,
      projectId: o.projectId,
      argv: gsPreviewArgv(`/in/${input}`),
      mounts: [{ host: work, container: '/in', ro: true }],
      workdir: '/tmp',
      timeoutMs: o.timeoutMs ?? 60_000,
      maxStdoutBytes: MAX_PNG_BYTES,
    })
    if (r.error) throw new HttpError(503, 'unavailable', `Preview renderer unavailable: ${r.error}`)
    if (r.timedOut) throw new HttpError(504, 'timeout', 'Rendering the preview took too long')
    if (r.code !== 0 || !isPng(r.stdout)) {
      throw new HttpError(422, 'preview_failed', 'Ghostscript could not render this file', { stderr: r.stderr.slice(-2000) })
    }
    await fs.mkdir(o.cacheDir, { recursive: true })
    const tmp = path.join(o.cacheDir, `.tmp-${randomBytes(6).toString('hex')}`)
    await fs.writeFile(tmp, r.stdout, { flag: 'wx' })
    await fs.rename(tmp, cached)
    return r.stdout
  } finally {
    await fs.rm(work, { recursive: true, force: true })
  }
}
