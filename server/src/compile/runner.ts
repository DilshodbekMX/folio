/**
 * Compile runners (SPEC §4.5, `COMPILE_RUNNER`):
 *
 *   docker  latexmk in a hardened one-shot container (sandbox.ts); compile dir at /compile,
 *           persistent font/TeX cache at /cache
 *   local   latexmk on the host PATH with the same flags — NO sandbox (trusted single-user machines)
 *   fake    tests: copies pre-built outputs from server/test/fixtures/fake-build/
 *
 * Runners know nothing about projects, snapshots or builds: they run one latexmk job (or one
 * auxiliary tool such as texcount / Ghostscript) against a directory and report what happened.
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Compiler } from '@folio/shared/api'
import type { Config } from '../config.ts'
import { moduleLog } from '../log.ts'
import {
  dockerCli, explainDockerFailure, reapOrphans, runSandboxed, runSandboxedRaw, type SandboxMount, type SandboxRawResult,
} from './sandbox.ts'
import { ensureCacheDirs, FontCacheWarmup } from './warmup.ts'

const log = moduleLog('compile.runner')

// ---------------------------------------------------------------------------
// Contract
// ---------------------------------------------------------------------------

export interface LatexmkJob {
  /** container name (docker) / job label */
  name: string
  projectId: string
  /** host path of the writable compile directory */
  compileDir: string
  /** project path of the document to build, relative to compileDir */
  rootPath: string
  jobname: string
  compiler: Compiler
  draft: boolean
  stopOnFirstError: boolean
  /** latexmk -gt: run *latex at least once even when latexmk thinks everything is up to date */
  force: boolean
  timeoutMs: number
  /** abort → kill (outcome.terminated) */
  signal?: AbortSignal
}

export interface LatexmkOutcome {
  /** latexmk exit code (0 ok, 12 a rule failed, 137 killed), null when it never ran */
  code: number | null
  /** tail of latexmk's combined stdout+stderr */
  output: string
  timedOut: boolean
  /** killed through the abort signal (user pressed Stop) */
  terminated: boolean
  /** infrastructure failure (docker unavailable, image missing, latexmk not found…) */
  error: string | null
  durationMs: number
}

export interface ToolJob {
  name: string
  projectId?: string
  argv: string[]
  /** container-side paths (/compile, /in …); the local runner maps them back to host paths */
  mounts: SandboxMount[]
  workdir?: string
  timeoutMs: number
  signal?: AbortSignal
  maxStdoutBytes?: number
}

export interface ToolOutcome {
  code: number | null
  stdout: Buffer
  stderr: string
  timedOut: boolean
  terminated: boolean
  error: string | null
}

export interface RunnerInfo {
  texLive: string | null
  dockerOk: boolean
}

export interface CompileRunner {
  readonly kind: 'docker' | 'local' | 'fake'
  /** How TeX sees the compile directory (what appears in logs): '/compile' in the sandbox. */
  texCompileDir(compileDir: string): string
  latexmk(job: LatexmkJob): Promise<LatexmkOutcome>
  tool(job: ToolJob): Promise<ToolOutcome>
  /** Make sure the font caches are warm (docker; no-op elsewhere). Never throws. */
  warmup(): Promise<void>
  /** Kill leftovers of earlier runs of this server instance. Returns how many were removed. */
  reap(): Promise<number>
  info(): Promise<RunnerInfo>
}

// ---------------------------------------------------------------------------
// latexmk command line (shared by the docker and local runners)
// ---------------------------------------------------------------------------

export const DRAFT_PRETEX = '\\PassOptionsToPackage{draft}{graphicx}\\PassOptionsToPackage{draft}{graphics}'

export const ENGINE_FLAGS: Record<Compiler, string> = {
  pdflatex: '-pdf',
  latex: '-pdfdvi',
  xelatex: '-xelatex',
  lualatex: '-lualatex',
}

/** kpathsea reads these from the environment: unwrapped logs (verified; the CLI flag does not work) */
export const TEX_LOG_ENV: Record<string, string> = {
  max_print_line: '10000',
  error_line: '254',
  half_error_line: '238',
}

/** Environment inside the sandbox: writable HOME on tmpfs, persistent caches on /cache. */
export const SANDBOX_ENV: Record<string, string> = {
  HOME: '/tmp',
  XDG_CACHE_HOME: '/cache/xdg',
  TEXMFVAR: '/cache/texmf-var',
  ...TEX_LOG_ENV,
}

export function latexmkArgv(o: {
  jobname: string
  compiler: Compiler
  draft: boolean
  stopOnFirstError: boolean
  force: boolean
  rootFile: string
}): string[] {
  const engine = ENGINE_FLAGS[o.compiler]
  if (!engine) throw new Error(`Unknown compiler: ${o.compiler}`)
  return [
    'latexmk', '-norc', '-cd', `-jobname=${o.jobname}`, '-synctex=1', '-interaction=batchmode',
    '-file-line-error', '-time',
    ...(o.force ? ['-gt'] : []),
    o.stopOnFirstError ? '-halt-on-error' : '-f',
    ...(o.draft ? [`-usepretex=${DRAFT_PRETEX}`] : []),
    engine,
    o.rootFile,
  ]
}

const MAX_LATEXMK_OUTPUT = 2 * 1024 * 1024

function texLiveFrom(versionOutput: string): string | null {
  const m = /\(TeX Live (\d{4})[^)]*\)/.exec(versionOutput)
  return m ? `TeX Live ${m[1]}` : null
}

function outcomeFromSandbox(r: SandboxRawResult, started: number, image: string): LatexmkOutcome {
  const output = r.stdout.toString('utf8')
  let error: string | null = r.error ?? null
  if (!error && !r.killed && r.code !== 0) error = explainDockerFailure(output, image)
  if (!error && !r.killed) {
    if (r.code === 125) error = `docker could not run the compile container: ${lastLines(output, 5)}`
    else if (r.code === 126 || r.code === 127) error = `latexmk could not be started in the TeX image (exit ${r.code})`
    else if (r.code === 137) error = 'The compiler was killed (out of memory?)'
    else if (r.code === null) error = 'The compile container ended abnormally'
  }
  return {
    code: r.code,
    output,
    timedOut: r.timedOut,
    terminated: r.killed && !r.timedOut,
    error,
    durationMs: Date.now() - started,
  }
}

function lastLines(s: string, n: number): string {
  return s.trimEnd().split('\n').slice(-n).join('\n')
}

// ---------------------------------------------------------------------------
// Docker
// ---------------------------------------------------------------------------

export interface DockerRunnerOptions {
  image: string
  texcacheDir: string
  memory: string
  cpus: string
  user: string
  /** labels put on every container (folio.kind, folio.instance) — also used to reap orphans */
  labels: Record<string, string>
  /** container name prefix for warm-up/info helper containers */
  namePrefix: string
}

export class DockerRunner implements CompileRunner {
  readonly kind = 'docker' as const
  private readonly warm: FontCacheWarmup
  private imageIdCache: { at: number; id: string | null } | null = null
  private texLive: string | null = null

  constructor(private readonly opts: DockerRunnerOptions) {
    this.warm = new FontCacheWarmup({
      texcacheDir: opts.texcacheDir,
      image: opts.image,
      imageId: () => this.imageId(),
      run: async step => {
        const r = await runSandboxedRaw({
          ...this.base(),
          name: `${opts.namePrefix}warm-${randomBytes(6).toString('hex')}`,
          mounts: [this.cacheMount()],
          argv: step.argv,
          workdir: '/tmp',
          timeoutMs: step.timeoutMs,
          mergeStderr: true,
          keep: 'tail',
        })
        return { code: r.code, timedOut: r.timedOut, output: r.stdout.toString('utf8'), error: r.error }
      },
    })
  }

  texCompileDir(): string {
    return '/compile'
  }

  private base() {
    return {
      image: this.opts.image,
      env: SANDBOX_ENV,
      memory: this.opts.memory,
      cpus: this.opts.cpus,
      user: this.opts.user,
      labels: this.opts.labels,
    }
  }

  private cacheMount(): SandboxMount {
    return { host: this.opts.texcacheDir, container: '/cache', ro: false }
  }

  async latexmk(job: LatexmkJob): Promise<LatexmkOutcome> {
    const started = Date.now()
    await ensureCacheDirs(this.opts.texcacheDir)
    const r = await runSandboxedRaw({
      ...this.base(),
      name: job.name,
      labels: { ...this.opts.labels, 'folio.project': job.projectId },
      mounts: [{ host: job.compileDir, container: '/compile', ro: false }, this.cacheMount()],
      argv: latexmkArgv({ ...job, rootFile: path.posix.join('/compile', job.rootPath) }),
      workdir: '/compile',
      timeoutMs: job.timeoutMs,
      signal: job.signal,
      // RLIMIT_CPU is per process, so this only bounds a runaway engine if our wall-clock kill fails
      cpuLimitSec: Math.ceil(job.timeoutMs / 1000) + 60,
      maxOutputBytes: MAX_LATEXMK_OUTPUT,
      keep: 'tail',
      mergeStderr: true,
    })
    return outcomeFromSandbox(r, started, this.opts.image)
  }

  async tool(job: ToolJob): Promise<ToolOutcome> {
    await ensureCacheDirs(this.opts.texcacheDir)
    const r = await runSandboxedRaw({
      ...this.base(),
      name: job.name,
      labels: job.projectId ? { ...this.opts.labels, 'folio.project': job.projectId } : this.opts.labels,
      mounts: [...job.mounts, this.cacheMount()],
      argv: job.argv,
      workdir: job.workdir ?? '/tmp',
      timeoutMs: job.timeoutMs,
      signal: job.signal,
      maxOutputBytes: job.maxStdoutBytes ?? 8 * 1024 * 1024,
      keep: 'head',
    })
    let error: string | null = r.error ?? null
    if (!error && !r.killed && r.code !== 0) error = explainDockerFailure(r.stderr.toString('utf8'), this.opts.image)
    if (!error && !r.killed && (r.code === 125 || r.code === null)) {
      error = `docker could not run the tool container: ${lastLines(r.stderr.toString('utf8'), 5)}`
    }
    if (!error && r.truncated) error = 'Tool output exceeded the size limit'
    return {
      code: r.code,
      stdout: r.stdout,
      stderr: r.stderr.toString('utf8'),
      timedOut: r.timedOut,
      terminated: r.killed && !r.timedOut,
      error,
    }
  }

  warmup(): Promise<void> {
    return this.warm.ensure().catch(err => {
      log.warn({ err }, 'font cache warm-up failed')
    })
  }

  reap(): Promise<number> {
    return reapOrphans(this.opts.labels)
  }

  /** Image id (sha256:…) of the configured image, cached for a minute; null when missing. */
  async imageId(): Promise<string | null> {
    const now = Date.now()
    if (this.imageIdCache && now - this.imageIdCache.at < 60_000) return this.imageIdCache.id
    const r = await dockerCli(['image', 'inspect', '--format', '{{.Id}}', this.opts.image], 15_000)
    const id = r.code === 0 ? r.stdout.trim() || null : null
    this.imageIdCache = { at: now, id }
    return id
  }

  async info(): Promise<RunnerInfo> {
    const v = await dockerCli(['version', '--format', '{{.Server.Version}}'], 10_000)
    if (v.code !== 0) return { texLive: null, dockerOk: false }
    const id = await this.imageId()
    if (!id) return { texLive: null, dockerOk: false }
    if (!this.texLive) {
      const r = await runSandboxed({
        ...this.base(),
        name: `${this.opts.namePrefix}info-${randomBytes(6).toString('hex')}`,
        mounts: [],
        argv: ['tex', '--version'],
        workdir: '/tmp',
        timeoutMs: 30_000,
      })
      this.texLive = r.code === 0 ? texLiveFrom(r.stdout) : null
    }
    return { texLive: this.texLive, dockerOk: true }
  }
}

// ---------------------------------------------------------------------------
// Local (unsandboxed)
// ---------------------------------------------------------------------------

interface LocalProcResult {
  code: number | null
  stdout: Buffer
  stderr: Buffer
  timedOut: boolean
  killed: boolean
  truncated: boolean
  error?: string
}

/** Spawn a host process in its own process group; timeout/abort kill the whole group. */
function spawnLocal(cmd: string, args: string[], o: {
  cwd: string
  env: NodeJS.ProcessEnv
  timeoutMs: number
  signal?: AbortSignal
  maxBytes: number
  keep: 'head' | 'tail'
  merge: boolean
}): Promise<LocalProcResult> {
  return new Promise(resolve => {
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outSize = 0
    let errSize = 0
    let truncated = false
    let timedOut = false
    let killed = false
    let settled = false
    const push = (arr: Buffer[], size: number, c: Buffer): number => {
      arr.push(c)
      size += c.length
      if (o.keep === 'head') {
        if (size > o.maxBytes) {
          truncated = true
          const excess = size - o.maxBytes
          arr[arr.length - 1] = c.subarray(0, c.length - excess)
          size = o.maxBytes
        }
      } else {
        while (size > o.maxBytes && arr.length > 1) { size -= arr.shift()!.length; truncated = true }
      }
      return size
    }
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true })
    } catch (e) {
      resolve({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut, killed, truncated, error: (e as Error).message })
      return
    }
    child.stdout!.on('data', (c: Buffer) => { outSize = push(out, outSize, c) })
    child.stderr!.on('data', (c: Buffer) => {
      if (o.merge) outSize = push(out, outSize, c)
      else errSize = push(err, errSize, c)
    })
    const killGroup = () => {
      killed = true
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }
    const timer = setTimeout(() => { timedOut = true; killGroup() }, Math.max(1, o.timeoutMs))
    timer.unref?.()
    const onAbort = () => killGroup()
    if (o.signal) {
      if (o.signal.aborted) onAbort()
      else o.signal.addEventListener('abort', onAbort, { once: true })
    }
    const finish = (code: number | null, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      o.signal?.removeEventListener('abort', onAbort)
      resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), timedOut, killed, truncated, ...(error ? { error } : {}) })
    }
    child.on('error', e => finish(null, `Cannot run ${cmd}: ${e.message}`))
    child.on('close', (code, sig) => finish(code ?? (sig ? 128 + 9 : null)))
  })
}

/**
 * Environment for host TeX processes (local runner): what TeX, latexmk and their helpers need —
 * never the server's own configuration or secrets (the documents are untrusted input).
 */
export function localTexEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const keep = /^(PATH|HOME|USER|LOGNAME|LANG|LANGUAGE|LC_[A-Z]+|TZ|TMPDIR|TEMP|TMP|SOURCE_DATE_EPOCH|FORCE_SOURCE_DATE|openin_any|openout_any|shell_escape|max_print_line|error_line|half_error_line|TEX[A-Z_]*|[A-Z]*INPUTS|KPATHSEA[A-Z_]*|MF[A-Z_]*|MP[A-Z_]*|BIBINPUTS|BSTINPUTS|BIBER[A-Z_]*|LUA[A-Z_]*|FONTCONFIG[A-Z_]*|PERL5LIB)$/
  const out: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined && keep.test(k)) out[k] = v
  return { ...out, ...TEX_LOG_ENV }
}

/** Replace container-side paths in argv/workdir by the mounted host paths. */
export function mapContainerPath(p: string, mounts: SandboxMount[]): string {
  const sorted = [...mounts].sort((a, b) => b.container.length - a.container.length)
  for (const m of sorted) {
    if (p === m.container) return m.host
    if (p.startsWith(m.container + '/')) return path.join(m.host, p.slice(m.container.length + 1))
  }
  return p
}

export class LocalRunner implements CompileRunner {
  readonly kind = 'local' as const
  private texLive: string | null | undefined

  texCompileDir(compileDir: string): string {
    return compileDir
  }

  async latexmk(job: LatexmkJob): Promise<LatexmkOutcome> {
    const started = Date.now()
    const argv = latexmkArgv({ ...job, rootFile: path.join(job.compileDir, job.rootPath) })
    const r = await spawnLocal(argv[0], argv.slice(1), {
      cwd: job.compileDir,
      env: localTexEnv(),
      timeoutMs: job.timeoutMs,
      signal: job.signal,
      maxBytes: MAX_LATEXMK_OUTPUT,
      keep: 'tail',
      merge: true,
    })
    const output = r.stdout.toString('utf8')
    let error: string | null = r.error ?? null
    if (!error && !r.killed && (r.code === 126 || r.code === 127)) error = `latexmk could not be started (exit ${r.code})`
    return { code: r.code, output, timedOut: r.timedOut, terminated: r.killed && !r.timedOut, error, durationMs: Date.now() - started }
  }

  async tool(job: ToolJob): Promise<ToolOutcome> {
    const argv = job.argv.map(a => mapContainerPath(a, job.mounts))
    // container-only directories such as /tmp exist on the host as well
    const cwd = job.workdir ? mapContainerPath(job.workdir, job.mounts) : os.tmpdir()
    const r = await spawnLocal(argv[0], argv.slice(1), {
      cwd,
      env: localTexEnv(),
      timeoutMs: job.timeoutMs,
      signal: job.signal,
      maxBytes: job.maxStdoutBytes ?? 8 * 1024 * 1024,
      keep: 'head',
      merge: false,
    })
    let error: string | null = r.error ?? null
    if (!error && r.truncated) error = 'Tool output exceeded the size limit'
    return { code: r.code, stdout: r.stdout, stderr: r.stderr.toString('utf8'), timedOut: r.timedOut, terminated: r.killed && !r.timedOut, error }
  }

  async warmup(): Promise<void> {}

  async reap(): Promise<number> {
    return 0
  }

  async info(): Promise<RunnerInfo> {
    if (this.texLive === undefined) {
      const r = await spawnLocal('tex', ['--version'], { cwd: process.cwd(), env: localTexEnv(), timeoutMs: 15_000, maxBytes: 64 * 1024, keep: 'head', merge: true })
      this.texLive = r.code === 0 ? texLiveFrom(r.stdout.toString('utf8')) : null
    }
    return { texLive: this.texLive, dockerOk: false }
  }
}

// ---------------------------------------------------------------------------
// Fake (tests)
// ---------------------------------------------------------------------------

export const FAKE_FIXTURE_DIR = fileURLToPath(new URL('../../test/fixtures/fake-build/', import.meta.url))

export type FakeMode = 'success' | 'error' | 'hang'

export interface FakeRunnerOptions {
  fixtureDir?: string
  /** simulated latexmk duration (default 20 ms) */
  delayMs?: number
  mode?: FakeMode
}

/**
 * Pretends to be latexmk: after `delayMs` it copies main.{pdf,log,synctex.gz,aux} from the
 * fixture directory as `<jobname>.*` next to the root document ('error' mode: error.log only,
 * exit 12). A timeout or abort "kills" the run (recorded in `kills`). Runs, kills and tool calls
 * are recorded for assertions.
 */
export class FakeRunner implements CompileRunner {
  readonly kind = 'fake' as const
  readonly fixtureDir: string
  delayMs: number
  mode: FakeMode
  readonly runs: LatexmkJob[] = []
  readonly kills: string[] = []
  readonly tools: ToolJob[] = []
  /** number of latexmk jobs currently "running" (for concurrency assertions) */
  active = 0
  maxActive = 0

  constructor(opts: FakeRunnerOptions = {}) {
    this.fixtureDir = opts.fixtureDir ?? FAKE_FIXTURE_DIR
    this.delayMs = opts.delayMs ?? 20
    this.mode = opts.mode ?? 'success'
  }

  texCompileDir(): string {
    return '/compile'
  }

  private wait(ms: number, timeoutMs: number, signal?: AbortSignal): Promise<'done' | 'timeout' | 'abort'> {
    return new Promise(resolve => {
      let t1: NodeJS.Timeout | undefined
      const finish = (v: 'done' | 'timeout' | 'abort') => {
        if (t1) clearTimeout(t1)
        clearTimeout(t2)
        signal?.removeEventListener('abort', onAbort)
        resolve(v)
      }
      const onAbort = () => finish('abort')
      if (ms !== Infinity) t1 = setTimeout(() => finish('done'), ms)
      const t2 = setTimeout(() => finish('timeout'), Math.max(1, timeoutMs))
      if (signal?.aborted) { queueMicrotask(onAbort); return }
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  async latexmk(job: LatexmkJob): Promise<LatexmkOutcome> {
    const started = Date.now()
    this.runs.push(job)
    this.active++
    this.maxActive = Math.max(this.maxActive, this.active)
    try {
      const mode = this.mode
      const how = await this.wait(mode === 'hang' ? Infinity : this.delayMs, job.timeoutMs, job.signal)
      const header = `Latexmk: This is Latexmk (fake runner).\nRunning '${job.compiler}' on '${job.rootPath}' as job '${job.jobname}'\n`
      if (how !== 'done') {
        this.kills.push(job.name)
        return { code: 137, output: header + 'Killed\n', timedOut: how === 'timeout', terminated: how === 'abort', error: null, durationMs: Date.now() - started }
      }
      const rootAbs = path.join(job.compileDir, job.rootPath)
      const st = await fs.lstat(rootAbs).catch(() => null)
      if (!st?.isFile()) {
        return { code: 11, output: header + `Latexmk: Filename '${job.rootPath}' does not exist\n`, timedOut: false, terminated: false, error: null, durationMs: Date.now() - started }
      }
      const dir = path.dirname(rootAbs)
      const put = async (fixture: string, ext: string) => {
        const dest = path.join(dir, `${job.jobname}.${ext}`)
        await fs.rm(dest, { force: true, recursive: true })
        await fs.copyFile(path.join(this.fixtureDir, fixture), dest)
      }
      if (mode === 'error') {
        await put('error.log', 'log')
        return { code: 12, output: header + 'Latexmk: Errors, so I did not complete making targets\n', timedOut: false, terminated: false, error: null, durationMs: Date.now() - started }
      }
      await put('main.aux', 'aux')
      await put('main.log', 'log')
      await put('main.synctex.gz', 'synctex.gz')
      await put('main.pdf', 'pdf')
      return { code: 0, output: header + `Latexmk: All targets (${job.jobname}.pdf) are up-to-date\n`, timedOut: false, terminated: false, error: null, durationMs: Date.now() - started }
    } finally {
      this.active--
    }
  }

  async tool(job: ToolJob): Promise<ToolOutcome> {
    this.tools.push(job)
    const how = await this.wait(this.delayMs, job.timeoutMs, job.signal)
    if (how !== 'done') return { code: 137, stdout: Buffer.alloc(0), stderr: '', timedOut: how === 'timeout', terminated: how === 'abort', error: null }
    const fixture = job.argv[0] === 'texcount' ? 'texcount.txt' : job.argv[0] === 'gs' ? 'preview.png' : null
    if (!fixture) return { code: 127, stdout: Buffer.alloc(0), stderr: `${job.argv[0]}: not available in the fake runner`, timedOut: false, terminated: false, error: null }
    return { code: 0, stdout: await fs.readFile(path.join(this.fixtureDir, fixture)), stderr: '', timedOut: false, terminated: false, error: null }
  }

  async warmup(): Promise<void> {}

  async reap(): Promise<number> {
    return 0
  }

  async info(): Promise<RunnerInfo> {
    return { texLive: null, dockerOk: false }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createRunner(config: Config, o: { labels: Record<string, string>; namePrefix: string }): CompileRunner {
  switch (config.compile.runner) {
    case 'docker':
      return new DockerRunner({
        image: config.compile.image,
        texcacheDir: config.dirs.texcache,
        memory: config.compile.memory,
        cpus: config.compile.cpus,
        user: config.compile.user,
        labels: o.labels,
        namePrefix: o.namePrefix,
      })
    case 'local':
      return new LocalRunner()
    case 'fake':
      return new FakeRunner()
  }
}
