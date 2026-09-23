/**
 * SynctexService (SPEC §4.5 "SyncTeX"): forward (code → PDF) and inverse (PDF → code) search
 * for a finished build.
 *
 * - The build is located through CompileService.resolveBuildFile: `meta.json` (the stored
 *   CompileResponse, which gives the jobname / root path / output names) and
 *   `<job>.synctex.gz`. The file is gunzipped with a size cap and parsed with
 *   @folio/shared/synctex; parsed indexes are kept in an LRU cache keyed by project/build.
 * - Paths: TeX records Inputs as absolute paths in the compile directory
 *   ('/compile/./main.tex', or '/compile/sub/./main.tex' for a root in a sub-folder). The
 *   compile-dir prefix is derived from the root document's Input, and anything outside it
 *   (texmf .sty/.cls files) is not navigable.
 * - Fallback: when the JS search finds nothing (or the file cannot be parsed) the `synctex`
 *   CLI runs in a sandbox container with the build directory mounted read-only at /compile.
 */
import { execFile } from 'node:child_process'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import { LRUCache } from 'lru-cache'
import pLimit from 'p-limit'
import type { CompileResponse, PdfRect, SyncCodeToPdfResponse, SyncPdfToCodeResponse } from '@folio/shared/api'
import {
  forwardSearch, inverseSearch, normalizeSynctexPath, parseSynctexText, type SynctexIndex,
} from '@folio/shared/synctex'
import { HttpError, notFound } from '../http/errors.ts'
import { moduleLog } from '../log.ts'
import type { Services, SynctexService } from '../services.ts'

const log = moduleLog('synctex')
const gunzip = promisify(zlib.gunzip)

/** compressed .synctex.gz larger than this is not parsed */
export const MAX_SYNCTEX_GZ_BYTES = 128 * 1024 * 1024
/** cap for the gunzipped text (zlib maxOutputLength) */
export const MAX_SYNCTEX_BYTES = 256 * 1024 * 1024
const MAX_META_BYTES = 8 * 1024 * 1024
/** results returned to the client */
const MAX_RECTS = 100
const MAX_CODE_RESULTS = 10
const CLI_TIMEOUT_MS = 15_000
/** CLI fallback containers waiting beyond this are skipped (a viewer clicking around must not queue unbounded containers) */
const CLI_MAX_PENDING = 8
const CLI_MAX_OUTPUT = 4 * 1024 * 1024
const BUILD_ID_RE = /^[0-9a-f]{8,}-[0-9a-f]{16}$/
const PID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** A build's SyncTeX data, ready for queries. */
export interface LoadedSynctex {
  projectId: string
  buildId: string
  jobname: string
  /** absolute path of the build directory */
  buildDir: string
  /** file names inside the build directory */
  pdfName: string
  synctexName: string
  /** null when the JS parser failed on this file (queries go to the CLI) */
  index: SynctexIndex | null
  /** recorded compile directory prefix, e.g. '/compile/' */
  compileRoot: string
  /** project path → recorded Input paths */
  inputsByPath: Map<string, string[]>
  /** recorded Input path → project path */
  pathByInput: Map<string, string>
  /** approximate memory use (bytes) for the cache */
  size: number
}

export interface SynctexCliRequest {
  /** absolute path of the build directory (holds <job>.pdf and <job>.synctex.gz) */
  buildDir: string
  /** PDF file name inside the build directory */
  pdfName: string
  /** synctex arguments for a given PDF path (as the CLI will see it) */
  args: (pdfPath: string) => string[]
}

export interface SynctexServiceOptions {
  /** number of parsed builds kept in memory (default 8) */
  cacheEntries?: number
  /** memory budget of the cache in bytes (default 512 MiB) */
  cacheBytes?: number
  /**
   * Runs the synctex CLI with the build directory available at /compile (docker runner) or
   * in place (local runner); returns stdout or null. Default: derived from config.compile.runner.
   * Pass null to disable the CLI fallback.
   */
  runCli?: SynctexCliRunner | null
}

export interface FolioSynctexService extends SynctexService {
  /** parse (or fetch from the cache) a build's SyncTeX data */
  load(projectId: string, buildId: string): Promise<LoadedSynctex>
  /** drop cached builds of a project (or everything) */
  invalidate(projectId?: string): void
}

// ---------------------------------------------------------------------------
// CLI fallback
// ---------------------------------------------------------------------------

export type SynctexCliRunner = (req: SynctexCliRequest) => Promise<string | null>

/**
 * The synctex CLI in a one-shot sandbox container (compile/sandbox.ts) with the build directory
 * mounted read-only at /compile, so the recorded '/compile/…' Input paths and the PDF resolve.
 */
export function dockerSynctexCli(s: Services, extra: { name?: () => string; labels?: Record<string, string> } = {}): SynctexCliRunner {
  return async ({ buildDir, pdfName, args }) => {
    // imported lazily: compile/sandbox.ts belongs to server-compile
    const { runSandboxed } = await import('../compile/sandbox.ts')
    const r = await runSandboxed({
      ...(extra.name ? { name: extra.name() } : {}),
      image: s.config.compile.image,
      mounts: [{ host: buildDir, container: '/compile', ro: true }],
      argv: ['synctex', ...args(`/compile/${pdfName}`)],
      workdir: '/compile',
      timeoutMs: CLI_TIMEOUT_MS,
      memory: '512m',
      cpus: '1',
      pidsLimit: 64,
      maxOutputBytes: CLI_MAX_OUTPUT,
      env: { HOME: '/tmp' },
      labels: { 'folio.purpose': 'synctex', ...(extra.labels ?? {}) },
    })
    if (r.error || r.timedOut || r.code !== 0) {
      log.warn({ code: r.code, timedOut: r.timedOut, error: r.error, stderr: r.stderr.slice(0, 500) }, 'synctex CLI fallback failed')
      return null
    }
    return r.stdout
  }
}

/** The synctex CLI on this machine (local runner: TeX already runs unsandboxed here; paths are host paths). */
export function localSynctexCli(): SynctexCliRunner {
  return ({ buildDir, pdfName, args }) => new Promise(resolve => {
    execFile('synctex', args(path.join(buildDir, pdfName)), { cwd: buildDir, timeout: CLI_TIMEOUT_MS, maxBuffer: CLI_MAX_OUTPUT, encoding: 'utf8' },
      (err, stdout) => resolve(err ? null : stdout))
  })
}

function defaultCliRunner(s: Services): SynctexCliRunner | null {
  const runner = s.config.compile.runner
  if (runner === 'docker') return dockerSynctexCli(s)
  if (runner === 'local') return localSynctexCli()
  return null
}

/** Parse `synctex view|edit` output into records (each 'Output:' line starts a new one). */
export function parseCliOutput(stdout: string): Record<string, string>[] {
  const out: Record<string, string>[] = []
  let cur: Record<string, string> | null = null
  let inResult = false
  for (const line of stdout.split(/\r?\n/)) {
    if (line === 'SyncTeX result begin') {
      inResult = true
      continue
    }
    if (line === 'SyncTeX result end') break
    if (!inResult) continue
    const i = line.indexOf(':')
    if (i <= 0) continue
    const k = line.slice(0, i)
    const v = line.slice(i + 1)
    if (k === 'Output') {
      cur = {}
      out.push(cur)
      continue
    }
    if (cur && !(k in cur)) cur[k] = v
  }
  return out
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function num(v: string | undefined): number {
  return v === undefined ? NaN : Number(v)
}

export function createSynctexService(s: Services, opts: SynctexServiceOptions = {}): FolioSynctexService {
  const cache = new LRUCache<string, LoadedSynctex>({
    max: opts.cacheEntries ?? 8,
    maxSize: opts.cacheBytes ?? 512 * 1024 * 1024,
    sizeCalculation: v => Math.max(1, Math.ceil(v.size)),
  })
  const inflight = new Map<string, Promise<LoadedSynctex>>()
  // resolved lazily: the container is still being filled when the factory runs
  let cli: SynctexCliRunner | null | undefined = opts.runCli
  const getCli = () => {
    if (cli === undefined) cli = defaultCliRunner(s)
    return cli
  }
  const cliLimit = pLimit(2)

  async function readMeta(projectId: string, buildId: string): Promise<CompileResponse> {
    const metaPath = s.compile.resolveBuildFile(projectId, buildId, 'meta.json')
    if (!metaPath) throw notFound('Build not found')
    let raw: Buffer
    try {
      const st = await fsp.stat(metaPath)
      if (!st.isFile() || st.size > MAX_META_BYTES) throw new Error('bad meta.json')
      raw = await fsp.readFile(metaPath)
    } catch {
      throw notFound('Build not found')
    }
    try {
      return JSON.parse(raw.toString('utf8')) as CompileResponse
    } catch {
      throw new HttpError(500, 'internal', 'The build metadata is corrupt')
    }
  }

  function synctexFileName(meta: CompileResponse, jobname: string): string {
    const outs = Array.isArray(meta.outputFiles) ? meta.outputFiles : []
    const candidates = outs.filter(o => o && typeof o.path === 'string' && o.path.endsWith('.synctex.gz'))
    const main = candidates.find(o => o.path === `${jobname}.synctex.gz`) ?? candidates[0]
    return main ? main.path : `${jobname}.synctex.gz`
  }

  function pdfFileName(meta: CompileResponse, jobname: string, synctexName: string): string {
    const outs = Array.isArray(meta.outputFiles) ? meta.outputFiles : []
    const base = synctexName.replace(/\.synctex\.gz$/, '')
    return outs.find(o => o?.path === `${base}.pdf`)?.path ?? `${jobname}.pdf`
  }

  /** Map recorded Inputs to project paths (and back). */
  function mapInputs(projectId: string, inputs: Iterable<string>, rootPath: string | null): {
    compileRoot: string; inputsByPath: Map<string, string[]>; pathByInput: Map<string, string>
  } {
    const all = [...inputs]
    let compileRoot = '/compile/'
    if (rootPath) {
      for (const input of all) {
        const n = normalizeSynctexPath(input)
        if (n.endsWith('/' + rootPath)) {
          compileRoot = n.slice(0, n.length - rootPath.length)
          break
        }
      }
    }
    const inputsByPath = new Map<string, string[]>()
    const pathByInput = new Map<string, string>()
    for (const input of all) {
      const n = normalizeSynctexPath(input)
      if (!n.startsWith(compileRoot)) continue
      const rel = n.slice(compileRoot.length)
      if (!rel || rel.startsWith('../')) continue
      // only files that exist in the project are navigable (not .aux/.out etc.)
      if (!s.db.files.getByPath(projectId, rel)) continue
      pathByInput.set(input, rel)
      const list = inputsByPath.get(rel)
      if (list) list.push(input)
      else inputsByPath.set(rel, [input])
    }
    return { compileRoot, inputsByPath, pathByInput }
  }

  async function loadFresh(projectId: string, buildId: string): Promise<LoadedSynctex> {
    const meta = await readMeta(projectId, buildId)
    const jobname = typeof meta.jobname === 'string' && meta.jobname ? meta.jobname : null
    if (!jobname) throw notFound('This build has no SyncTeX data')
    const synctexName = synctexFileName(meta, jobname)
    const gzPath = s.compile.resolveBuildFile(projectId, buildId, synctexName)
    if (!gzPath) throw notFound('This build has no SyncTeX data')
    const buildDir = path.dirname(gzPath)
    const pdfName = pdfFileName(meta, jobname, synctexName)
    const rootPath = typeof meta.rootPath === 'string' ? meta.rootPath : null

    let index: SynctexIndex | null = null
    let inputs: string[] = []
    let size = 64 * 1024
    try {
      const st = await fsp.stat(gzPath)
      if (!st.isFile()) throw notFound('This build has no SyncTeX data')
      if (st.size > MAX_SYNCTEX_GZ_BYTES) throw new Error(`synctex file too large (${st.size} bytes)`)
      const gz = await fsp.readFile(gzPath)
      const raw = gz[0] === 0x1f && gz[1] === 0x8b ? await gunzip(gz, { maxOutputLength: MAX_SYNCTEX_BYTES }) : gz
      const t0 = performance.now()
      index = parseSynctexText(raw.toString('latin1'))
      if (index.pages.size === 0 || index.inputs.size === 0) throw new Error('no SyncTeX content in the file')
      inputs = [...new Set(index.inputs.values())]
      size = index.count * 60 + raw.length / 8
      log.debug({ projectId, buildId, nodes: index.count, ms: Math.round(performance.now() - t0) }, 'parsed synctex')
    } catch (err) {
      if (err instanceof HttpError) throw err
      log.warn({ err, projectId, buildId }, 'cannot parse synctex file; using the synctex CLI')
      index = null
    }
    const mapped = mapInputs(projectId, inputs, rootPath)
    return { projectId, buildId, jobname, buildDir, pdfName, synctexName, index, size, ...mapped }
  }

  async function load(projectId: string, buildId: string): Promise<LoadedSynctex> {
    if (!PID_RE.test(projectId)) throw notFound('Project not found')
    if (!BUILD_ID_RE.test(buildId)) throw notFound('Build not found')
    const key = `${projectId}/${buildId}`
    const hit = cache.get(key)
    if (hit) return hit
    let p = inflight.get(key)
    if (!p) {
      p = loadFresh(projectId, buildId).then(v => {
        cache.set(key, v)
        return v
      }).finally(() => inflight.delete(key))
      inflight.set(key, p)
    }
    return p
  }

  async function runCli(b: LoadedSynctex, args: (pdfPath: string) => string[]): Promise<Record<string, string>[] | null> {
    const run = getCli()
    if (!run) return null
    if (cliLimit.pendingCount >= CLI_MAX_PENDING) {
      log.warn({ projectId: b.projectId, buildId: b.buildId }, 'synctex CLI fallback skipped: too many pending runs')
      return null
    }
    try {
      const stdout = await cliLimit(() => run({ buildDir: b.buildDir, pdfName: b.pdfName, args }))
      return stdout === null ? null : parseCliOutput(stdout)
    } catch (err) {
      log.warn({ err }, 'synctex CLI fallback failed')
      return null
    }
  }

  /** Recorded Input(s) for a project path; also accepts inputs recorded outside the map (suffix match). */
  function inputsFor(b: LoadedSynctex, projectPath: string): string[] {
    const direct = b.inputsByPath.get(projectPath)
    if (direct) return direct
    if (!b.index) return [`${b.compileRoot}${projectPath}`]
    const out: string[] = []
    for (const input of new Set(b.index.inputs.values())) {
      if (normalizeSynctexPath(input) === `${b.compileRoot}${projectPath}`) out.push(input)
    }
    return out
  }

  return {
    load,

    invalidate(projectId?: string) {
      if (!projectId) {
        cache.clear()
        return
      }
      for (const key of [...cache.keys()]) if (key.startsWith(`${projectId}/`)) cache.delete(key)
    },

    async codeToPdf(projectId, buildId, projectPath, line, column): Promise<SyncCodeToPdfResponse> {
      const b = await load(projectId, buildId)
      const inputs = inputsFor(b, projectPath)
      if (!inputs.length) return { pdf: [] }
      let rects: PdfRect[] = []
      if (b.index) {
        for (const input of inputs) rects.push(...forwardSearch(b.index, input, line, column))
      }
      if (!rects.length) {
        const recs = await runCli(b, pdf => ['view', '-i', `${line}:${Math.max(0, column)}:${inputs[0]}`, '-o', pdf])
        rects = (recs ?? []).flatMap(r => {
          const page = num(r.Page)
          const h = num(r.h)
          const v = num(r.v)
          const W = num(r.W)
          const H = num(r.H)
          if (![page, h, v, W, H].every(Number.isFinite) || page < 1) return []
          return [{ page, x: Math.min(h, h + W), y: v - Math.abs(H), width: Math.abs(W), height: Math.abs(H) }]
        })
      }
      return { pdf: rects.slice(0, MAX_RECTS) }
    },

    async pdfToCode(projectId, buildId, page, x, y): Promise<SyncPdfToCodeResponse> {
      const b = await load(projectId, buildId)
      const toCode = (input: string, line: number, column: number) => {
        const p = b.pathByInput.get(input) ?? null
        if (!p || !Number.isFinite(line) || line < 1) return null
        const file = s.db.files.getByPath(projectId, p)
        return { path: p, fileId: file?.id ?? null, line, column: Number.isFinite(column) && column > 0 ? column : 0 }
      }
      let code: SyncPdfToCodeResponse['code'] = []
      if (b.index) {
        code = inverseSearch(b.index, page, x, y, { accept: input => b.pathByInput.has(input) })
          .map(r => toCode(r.input, r.line, r.column))
          .filter((c): c is NonNullable<typeof c> => c !== null)
      }
      if (!code.length) {
        const recs = await runCli(b, pdf => ['edit', '-o', `${page}:${x}:${y}:${pdf}`])
        if (recs) {
          // the CLI reports Inputs as recorded; map them like the parser's
          if (!b.index) {
            const extra = recs.map(r => r.Input).filter((i): i is string => typeof i === 'string')
            const m = mapInputs(projectId, extra, null)
            for (const [k, v] of m.pathByInput) b.pathByInput.set(k, v)
          }
          code = recs
            .map(r => (typeof r.Input === 'string' ? toCode(r.Input, num(r.Line), num(r.Column)) : null))
            .filter((c): c is NonNullable<typeof c> => c !== null)
        }
      }
      // de-duplicate (the same location can come from two tags of one file)
      const seen = new Set<string>()
      code = code.filter(c => {
        const k = `${c.path}:${c.line}`
        if (seen.has(k)) return false
        seen.add(k)
        return true
      })
      return { code: code.slice(0, MAX_CODE_RESULTS) }
    },
  }
}
