/**
 * Hardened, one-shot `docker run` (SPEC §4.5). Every TeX-side process Folio starts (latexmk,
 * texcount, Ghostscript, the SyncTeX CLI fallback, the font-cache warm-up) goes through here.
 *
 *   docker run --rm --init --pull never --name <name> --label k=v… --network none --cap-drop ALL
 *     --security-opt no-new-privileges --pids-limit 512 --memory M --memory-swap M --cpus C
 *     --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m --log-driver none --user uid:gid
 *     [--ulimit cpu=s:h] -e K=V… -v host:container[:ro|rw]… [-w dir] <image> <argv…>
 *
 * - spawned with an argv array, never through a shell;
 * - a timeout or an abort kills the container BY NAME (`docker kill`), because killing the docker
 *   CLI client leaves the container running (verified); the kill is retried until the client exits;
 * - `--rm` + the CLI waiting for removal means no container is left once the promise settles;
 * - `--log-driver none` keeps the daemon from duplicating output on disk (attached stdout/stderr
 *   still stream to us — verified); `--pull never` turns a missing image into an immediate error
 *   (exit 125) instead of a multi-GB download in the middle of a compile;
 * - the /tmp tmpfs is mounted `exec` on purpose: docker's --tmpfs silently adds `noexec`, and
 *   biber (a PAR-packed binary) unpacks itself into /tmp and executes from there — with noexec
 *   every biblatex document fails ("exec … failed (errno=13)", verified). The tmpfs is private
 *   to the container and discarded with it.
 */
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { moduleLog } from '../log.ts'

const log = moduleLog('compile.sandbox')

export interface SandboxMount {
  host: string
  container: string
  ro?: boolean
}

export interface SandboxOptions {
  /** container name; generated (`folio-s-<random>`) when omitted */
  name?: string
  image: string
  mounts: SandboxMount[]
  argv: string[]
  env?: Record<string, string>
  workdir?: string
  /** wall-clock limit; the container is killed when it elapses */
  timeoutMs: number
  /** e.g. '2g' (also used for --memory-swap, i.e. no swap) */
  memory?: string
  cpus?: string
  /** 'uid:gid' */
  user?: string
  labels?: Record<string, string>
  /** abort → docker kill (result.killed = true, timedOut = false) */
  signal?: AbortSignal
  /** RLIMIT_CPU backstop in seconds (per process; the wall-clock kill is the real limit) */
  cpuLimitSec?: number
  pidsLimit?: number
  /** cap for each captured stream (default 2 MiB) */
  maxOutputBytes?: number
  /** keep the first (default) or the last `maxOutputBytes` of each stream */
  keep?: 'head' | 'tail'
  /** capture stderr into the stdout stream (in arrival order) */
  mergeStderr?: boolean
}

export interface SandboxResult {
  /** exit code of `docker run` (the command's code; 125 = docker itself failed; 137 = killed) */
  code: number | null
  stdout: string
  stderr: string
  /** killed because timeoutMs elapsed */
  timedOut: boolean
  /** we killed the container (timeout or abort) */
  killed: boolean
  /** set when docker could not be started at all (e.g. ENOENT) */
  error?: string
}

export interface SandboxRawResult {
  code: number | null
  stdout: Buffer
  stderr: Buffer
  timedOut: boolean
  killed: boolean
  /** a stream exceeded maxOutputBytes and was cut */
  truncated: boolean
  error?: string
}

// ---------------------------------------------------------------------------
// Process-wide defaults (set by createCompileService so that containers started by other
// modules through runSandboxed — e.g. the SyncTeX CLI fallback — carry this instance's labels
// and resource limits and are reaped with the compile containers).
// ---------------------------------------------------------------------------

interface SandboxDefaults {
  user: string
  memory: string
  cpus: string
  labels: Record<string, string>
}

const defaults: SandboxDefaults = {
  user: typeof process.getuid === 'function' && typeof process.getgid === 'function' ? `${process.getuid()}:${process.getgid()}` : '1000:1000',
  memory: '1g',
  cpus: '1',
  labels: { 'folio.kind': 'compile' },
}

export function configureSandbox(patch: Partial<SandboxDefaults>): void {
  if (patch.user) defaults.user = patch.user
  if (patch.memory) defaults.memory = patch.memory
  if (patch.cpus) defaults.cpus = patch.cpus
  if (patch.labels) defaults.labels = { ...patch.labels }
}

export function sandboxDefaults(): Readonly<SandboxDefaults> {
  return defaults
}

// ---------------------------------------------------------------------------
// Validation + argv
// ---------------------------------------------------------------------------

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const LABEL_KEY_RE = /^[A-Za-z0-9][A-Za-z0-9._\-/]*$/
const SIZE_RE = /^\d+(?:\.\d+)?[bkmg]?$/i
const USER_RE = /^\d+(?::\d+)?$/

function assertPath(p: string, what: string): void {
  if (!p.startsWith('/')) throw new Error(`${what} must be absolute: ${p}`)
  // -v uses ':' as separator; ',' and control characters are never valid in our paths
  if (/[:,\u0000-\u001f]/.test(p)) throw new Error(`${what} contains a character docker cannot mount: ${JSON.stringify(p)}`)
}

export type DockerFailure = 'daemon' | 'permission' | 'image' | 'other'

/** Classify docker CLI output of a run that failed before the container's command ran (null: docker worked). */
export function classifyDockerFailure(output: string): { kind: DockerFailure; line: string } | null {
  const head = output.slice(0, 4000)
  // latexmk ran, so docker itself worked (its own output may quote arbitrary document text)
  if (/Latexmk|Rc files read/.test(head)) return null
  const line = head.split('\n').find(l => l.trim()) ?? ''
  if (/failed to connect to the docker API|Cannot connect to the Docker daemon|Is the docker daemon running|error during connect/i.test(head)) return { kind: 'daemon', line }
  if (/permission denied[^\n]*docker[^\n]*sock|docker\.sock[^\n]*permission denied/i.test(head)) return { kind: 'permission', line }
  if (/No such image|Unable to find image|pull access denied|manifest unknown|repository does not exist/i.test(head)) return { kind: 'image', line }
  if (/^docker: Error response from daemon/m.test(head)) {
    return { kind: 'other', line: (head.split('\n').find(l => l.startsWith('docker: Error response from daemon')) ?? line).replace(/^docker: /, '').trim() }
  }
  return null
}

/**
 * A human explanation when `docker run` failed before the command inside the container ran
 * (daemon unreachable, no permission on the socket, image missing), else null. Recent docker CLIs
 * exit 1 (not 125) when the daemon is unreachable, so the exit code alone cannot tell.
 */
export function explainDockerFailure(output: string, image: string): string | null {
  const f = classifyDockerFailure(output)
  if (!f) return null
  switch (f.kind) {
    case 'daemon':
      return 'Docker is not running or not reachable, so the document cannot be compiled. Start Docker (for example `sudo systemctl start docker`) and compile again; `npm run doctor` checks the setup.'
    case 'permission':
      return 'The Folio server is not allowed to use Docker (permission denied on the Docker socket). Add its user to the "docker" group and restart the server.'
    case 'image':
      return `The TeX Live image ${image} is not installed. Run \`docker pull ${image}\` on the server (about 5 GB) and compile again.`
    case 'other':
      return `Docker could not start the compile container: ${f.line}`
  }
}

export function randomContainerName(prefix = 'folio-s-'): string {
  return `${prefix}${randomBytes(8).toString('hex')}`
}

/** Full `docker` argv for a sandboxed run (exported for tests and for debugging). */
export function buildDockerArgs(opts: SandboxOptions & { name: string }): string[] {
  const user = opts.user ?? defaults.user
  const memory = opts.memory ?? defaults.memory
  const cpus = opts.cpus ?? defaults.cpus
  const labels = { ...defaults.labels, ...(opts.labels ?? {}) }
  if (!NAME_RE.test(opts.name)) throw new Error(`Invalid container name: ${opts.name}`)
  if (!USER_RE.test(user)) throw new Error(`Invalid container user: ${user}`)
  if (!SIZE_RE.test(memory)) throw new Error(`Invalid memory limit: ${memory}`)
  if (!/^\d+(?:\.\d+)?$/.test(cpus)) throw new Error(`Invalid cpus: ${cpus}`)
  if (!opts.image || /\s/.test(opts.image) || opts.image.startsWith('-')) throw new Error(`Invalid image: ${opts.image}`)
  if (opts.argv.length === 0) throw new Error('Empty argv')

  const args = [
    'run', '--rm', '--init', '--pull', 'never', '--name', opts.name,
  ]
  for (const [k, v] of Object.entries(labels)) {
    if (!LABEL_KEY_RE.test(k)) throw new Error(`Invalid label key: ${k}`)
    args.push('--label', `${k}=${v}`)
  }
  args.push(
    '--network', 'none',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(opts.pidsLimit ?? 512),
    '--memory', memory,
    '--memory-swap', memory,
    '--cpus', cpus,
    '--read-only',
    '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=256m',
    '--log-driver', 'none',
    '--user', user,
  )
  if (opts.cpuLimitSec && opts.cpuLimitSec > 0) {
    const soft = Math.ceil(opts.cpuLimitSec)
    args.push('--ulimit', `cpu=${soft}:${soft + 10}`)
  }
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (!ENV_KEY_RE.test(k)) throw new Error(`Invalid env name: ${k}`)
    if (/[\n\r\0]/.test(v)) throw new Error(`Invalid env value for ${k}`)
    args.push('-e', `${k}=${v}`)
  }
  for (const m of opts.mounts) {
    assertPath(m.host, 'Mount source')
    assertPath(m.container, 'Mount target')
    args.push('-v', `${m.host}:${m.container}:${m.ro ? 'ro' : 'rw'}`)
  }
  if (opts.workdir) {
    assertPath(opts.workdir, 'Working directory')
    args.push('-w', opts.workdir)
  }
  args.push(opts.image, ...opts.argv)
  return args
}

// ---------------------------------------------------------------------------
// Output capture
// ---------------------------------------------------------------------------

class Capture {
  private chunks: Buffer[] = []
  private size = 0
  truncated = false
  constructor(private readonly max: number, private readonly keep: 'head' | 'tail') {}

  push(chunk: Buffer): void {
    if (this.keep === 'head') {
      if (this.size >= this.max) { this.truncated = true; return }
      const room = this.max - this.size
      const part = chunk.length > room ? chunk.subarray(0, room) : chunk
      if (part.length < chunk.length) this.truncated = true
      this.chunks.push(part)
      this.size += part.length
      return
    }
    this.chunks.push(chunk)
    this.size += chunk.length
    while (this.size > this.max && this.chunks.length > 0) {
      const first = this.chunks[0]
      const excess = this.size - this.max
      this.truncated = true
      if (first.length <= excess) {
        this.chunks.shift()
        this.size -= first.length
      } else {
        this.chunks[0] = first.subarray(excess)
        this.size -= excess
      }
    }
  }

  buffer(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

// ---------------------------------------------------------------------------
// docker helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Run a short docker CLI command (never a shell). Resolves even on failure. */
export function dockerCli(args: string[], timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string; error?: string }> {
  return new Promise(resolve => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      if (err && typeof (err as NodeJS.ErrnoException).code === 'string') {
        resolve({ code: null, stdout: stdout ?? '', stderr: stderr ?? '', error: err.message })
        return
      }
      const code = err ? ((err as { code?: number }).code ?? 1) : 0
      resolve({ code: typeof code === 'number' ? code : 1, stdout: stdout ?? '', stderr: stderr ?? '' })
    })
  })
}

/** `docker kill <name>`; true when docker reported success. */
export async function kill(name: string): Promise<boolean> {
  if (!NAME_RE.test(name)) return false
  const r = await dockerCli(['kill', name], 15_000)
  return r.code === 0
}

/**
 * Kill (and remove) every container carrying all the given labels. Defaults to the labels of this
 * process (`folio.kind=compile` + the instance label set by the compile service). Returns the
 * number of containers removed; never throws.
 */
export async function reapOrphans(labels: Record<string, string> = defaults.labels): Promise<number> {
  const filters = Object.entries(labels).flatMap(([k, v]) => ['--filter', `label=${k}=${v}`])
  if (filters.length === 0) return 0
  const ps = await dockerCli(['ps', '-aq', ...filters], 15_000)
  if (ps.code !== 0) return 0
  const ids = ps.stdout.split(/\s+/).filter(id => /^[0-9a-f]{6,64}$/.test(id))
  if (ids.length === 0) return 0
  const rm = await dockerCli(['rm', '-f', ...ids], 60_000)
  if (rm.code !== 0) log.warn({ stderr: rm.stderr.trim() }, 'failed to reap orphan containers')
  else log.info({ count: ids.length }, 'reaped orphan compile containers')
  return rm.code === 0 ? ids.length : 0
}

/** True when a container with exactly this name exists (running or not). */
export async function containerExists(name: string): Promise<boolean> {
  const r = await dockerCli(['ps', '-aq', '--filter', `name=^/${name}$`], 15_000)
  return r.code === 0 && r.stdout.trim().length > 0
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

/** Like runSandboxed but returns raw Buffers (binary stdout, e.g. Ghostscript PNG output). */
export function runSandboxedRaw(opts: SandboxOptions): Promise<SandboxRawResult> {
  const name = opts.name ?? randomContainerName()
  let args: string[]
  try {
    args = buildDockerArgs({ ...opts, name })
  } catch (err) {
    return Promise.resolve({ code: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), timedOut: false, killed: false, truncated: false, error: (err as Error).message })
  }
  const max = opts.maxOutputBytes ?? 2 * 1024 * 1024
  const keep = opts.keep ?? 'head'
  const out = new Capture(max, keep)
  const errCap = opts.mergeStderr ? out : new Capture(max, keep)

  return new Promise(resolve => {
    let settled = false
    let exited = false
    let timedOut = false
    let killed = false
    let spawnError: string | undefined
    let killing: Promise<void> | null = null

    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    child.stdout.on('data', (c: Buffer) => out.push(c))
    child.stderr.on('data', (c: Buffer) => errCap.push(c))

    const killContainer = (): Promise<void> => {
      if (killing) return killing
      killed = true
      killing = (async () => {
        // The container may not exist yet (docker run still creating it) — retry until the
        // client exits. If docker itself is wedged, give up after ~20 s and drop the client.
        for (let attempt = 0; !exited; attempt++) {
          await kill(name)
          if (exited) break
          await delay(attempt < 10 ? 250 : 1000)
          if (attempt === 25 && !exited) {
            log.error({ name }, 'docker kill did not stop the container; killing the docker client')
            child.kill('SIGKILL')
          }
        }
      })()
      return killing
    }

    const timer = setTimeout(() => {
      timedOut = true
      void killContainer()
    }, Math.max(1, opts.timeoutMs))
    timer.unref?.()

    const onAbort = () => { void killContainer() }
    if (opts.signal) {
      if (opts.signal.aborted) onAbort()
      else opts.signal.addEventListener('abort', onAbort, { once: true })
    }

    const finish = (code: number | null) => {
      if (settled) return
      settled = true
      exited = true
      clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      resolve({
        code,
        stdout: out.buffer(),
        stderr: opts.mergeStderr ? Buffer.alloc(0) : errCap.buffer(),
        timedOut,
        killed,
        truncated: out.truncated || errCap.truncated,
        ...(spawnError ? { error: spawnError } : {}),
      })
    }

    child.on('error', err => {
      spawnError = (err as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'Docker is not installed on this server (the `docker` command was not found), so documents cannot be compiled. Install Docker, or set COMPILE_RUNNER=local to use a local TeX installation.'
        : `Cannot run docker: ${err.message}`
      finish(null)
    })
    child.on('close', code => finish(code))
  })
}

/** Run a command in a fresh, hardened, network-less container and capture its output. */
export async function runSandboxed(opts: SandboxOptions): Promise<SandboxResult> {
  const r = await runSandboxedRaw(opts)
  return {
    code: r.code,
    stdout: r.stdout.toString('utf8'),
    stderr: r.stderr.toString('utf8'),
    timedOut: r.timedOut,
    killed: r.killed,
    ...(r.error ? { error: r.error } : {}),
  }
}
