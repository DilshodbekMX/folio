/**
 * Font-cache warm-up (SPEC §4.5). With a read-only root and a fresh tmpfs every compile would
 * rebuild the fontconfig and luaotfload caches (XeLaTeX ~2.5× slower; LuaLaTeX even segfaulted
 * while building its font-name database as uid 1000 — verified). The caches live on the
 * persistent `texcache/` volume mounted at /cache; this module fills them once per image, before
 * the first compile, and records `texcache/.warm-<image hash>`.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { moduleLog } from '../log.ts'

const log = moduleLog('compile.warmup')

export interface WarmupStep {
  argv: string[]
  timeoutMs: number
}

export interface WarmupRunResult {
  code: number | null
  timedOut: boolean
  output: string
  error?: string
}

export interface FontCacheWarmupOptions {
  texcacheDir: string
  /** image reference; the marker is keyed by the resolved image id when available */
  image: string
  /** resolves the image id (e.g. `docker image inspect`), null when unknown */
  imageId: () => Promise<string | null>
  /** runs one warm-up command in the sandbox with the cache mounted at /cache */
  run: (step: WarmupStep) => Promise<WarmupRunResult>
}

export const WARMUP_STEPS: WarmupStep[] = [
  { argv: ['luaotfload-tool', '-u'], timeoutMs: 5 * 60_000 },
  { argv: ['fc-cache'], timeoutMs: 2 * 60_000 },
]

export function warmMarkerName(imageKey: string): string {
  return `.warm-${createHash('sha1').update(imageKey).digest('hex').slice(0, 16)}`
}

/** Directories the sandbox expects under /cache (created on the host so they belong to the host user). */
export async function ensureCacheDirs(texcacheDir: string): Promise<void> {
  await fs.mkdir(path.join(texcacheDir, 'xdg'), { recursive: true })
  await fs.mkdir(path.join(texcacheDir, 'texmf-var'), { recursive: true })
}

export class FontCacheWarmup {
  private pending: Promise<void> | null = null
  private warmKey: string | null = null
  private failedAt = 0
  /** after a failed warm-up, compiles go ahead cold and the warm-up is retried at most this often */
  static readonly RETRY_MS = 10 * 60_000

  constructor(private readonly opts: FontCacheWarmupOptions) {}

  /** Resolve once the cache for the current image is warm (runs the warm-up at most once concurrently). */
  ensure(): Promise<void> {
    if (!this.pending) {
      this.pending = this.run().finally(() => { this.pending = null })
    }
    return this.pending
  }

  private async run(): Promise<void> {
    const imageKey = (await this.opts.imageId().catch(() => null)) ?? this.opts.image
    if (this.warmKey === imageKey) return
    if (this.failedAt && Date.now() - this.failedAt < FontCacheWarmup.RETRY_MS) return
    const marker = path.join(this.opts.texcacheDir, warmMarkerName(imageKey))
    await ensureCacheDirs(this.opts.texcacheDir)
    try {
      await fs.access(marker)
      this.warmKey = imageKey
      return
    } catch { /* not warm yet */ }

    const started = Date.now()
    log.info({ image: this.opts.image }, 'warming TeX font caches (first compile with this image)')
    let ok = true
    for (const step of WARMUP_STEPS) {
      const r = await this.opts.run(step)
      if (r.error || r.timedOut || r.code !== 0) {
        ok = false
        log.warn({ argv: step.argv, code: r.code, timedOut: r.timedOut, error: r.error, output: r.output.slice(-2000) }, 'font cache warm-up step failed')
      }
    }
    if (!ok) {
      // Leave the marker unset so a later compile retries; compiles proceed with a cold cache.
      this.failedAt = Date.now()
      return
    }
    this.failedAt = 0
    await fs.writeFile(marker, JSON.stringify({ image: this.opts.image, imageKey, warmedAt: Date.now() }) + '\n')
    this.warmKey = imageKey
    log.info({ ms: Date.now() - started }, 'TeX font caches warm')
  }
}
