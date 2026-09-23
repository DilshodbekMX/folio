/**
 * Hardened git CLI wrapper for the history module (SPEC §4.6).
 *
 * - Always execFile (never a shell). Every repository command runs as
 *   `git --git-dir=<gd> --work-tree=<wt> -c core.hooksPath=/dev/null -c core.fsmonitor=false ...`
 *   with a minimal environment: no inherited GIT_* variables, no system/global config
 *   (GIT_CONFIG_NOSYSTEM=1, GIT_CONFIG_GLOBAL=/dev/null), a private HOME, no terminal prompts.
 *   `--work-tree` is omitted only while the project directory does not exist (git refuses to
 *   run any command with a missing work tree); callers never run `add` in that state.
 * - Callers only ever pass validated revisions (hex / HEAD) and never pass user paths as
 *   pathspecs: paths go through `<sha>:<path>` object names or are matched in JS.
 * - Commands of one repository never overlap: each call goes through a per-git-dir mutex, so
 *   concurrent add/commit/log never race on index.lock.
 * - Output is collected as a Buffer (paths and blobs are raw bytes); callers parse -z output.
 */
import { execFile } from 'node:child_process'
import fs from 'node:fs'

/** A repository: the separate git dir plus the project's working tree. */
export interface GitRepo {
  gitDir: string
  workTree: string
}

export interface GitRunOptions {
  /** data written to git's stdin (stdin is closed immediately otherwise) */
  input?: string | Buffer
  /** extra environment variables (e.g. GIT_AUTHOR_NAME) */
  env?: Record<string, string>
  /** exit codes that count as success (default [0]) — e.g. [0, 1] for `diff --quiet` */
  okCodes?: number[]
  maxBuffer?: number
  timeoutMs?: number
  /** working directory of the git process (default: the git dir) */
  cwd?: string
  /** additional `-c key=value` settings placed after the hardening flags (they win) */
  config?: string[]
}

export interface GitResult {
  code: number
  stdout: Buffer
  stderr: string
}

export class GitError extends Error {
  constructor(
    message: string,
    public readonly args: string[],
    /** exit code, or a Node error code such as 'ENOENT' / 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' */
    public readonly exitCode: number | string | null,
    public readonly stderr: string,
  ) {
    super(message)
    this.name = 'GitError'
  }
}

/** 64 MiB: enough for `git log --name-status` pages and text blobs. */
export const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024
/** 512 MiB: blob reads of large binaries (uploads are capped far below this). */
export const BLOB_MAX_BUFFER = 512 * 1024 * 1024
export const DEFAULT_TIMEOUT_MS = 120_000

/** Hardening flags placed before every subcommand. */
export const HARDENING_CONFIG: readonly string[] = [
  'core.hooksPath=/dev/null',
  'core.fsmonitor=false',
  'core.autocrlf=false',
  'core.safecrlf=false',
  'core.quotepath=false',
  'core.excludesFile=/dev/null',
  'core.attributesFile=/dev/null',
  'gc.auto=0',
  'gc.autoDetach=false',
  'user.name=Folio',
  'user.email=folio@localhost',
  'commit.gpgSign=false',
  'tag.gpgSign=false',
  'log.showSignature=false',
  'protocol.allow=never',
]

/** Serialises async work per key (FIFO). */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>()

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    let release!: () => void
    const mine = new Promise<void>(resolve => { release = resolve })
    const tail = prev.then(() => mine)
    this.tails.set(key, tail)
    await prev
    try {
      return await fn()
    } finally {
      release()
      if (this.tails.get(key) === tail) this.tails.delete(key)
    }
  }

  /** true while some task holds or waits for `key` */
  busy(key: string): boolean {
    return this.tails.has(key)
  }

  /** Resolves once every task queued so far (for every key) has finished. */
  async drain(): Promise<void> {
    while (this.tails.size > 0) await Promise.all([...this.tails.values()])
  }
}

export interface GitRunner {
  /** Run a command against a repository (serialised per git dir). */
  run(repo: GitRepo, args: string[], opts?: GitRunOptions): Promise<GitResult>
  /** Run a command that is not bound to an existing repository (e.g. `init`). */
  runBare(args: string[], opts?: GitRunOptions): Promise<GitResult>
}

export interface GitRunnerOptions {
  /** private HOME / XDG_CONFIG_HOME for git (created 0700 on first use) */
  home: string
  /** git executable (default 'git' from PATH) */
  binary?: string
}

export function createGitRunner(opts: GitRunnerOptions): GitRunner {
  const binary = opts.binary ?? 'git'
  const mutex = new KeyedMutex()
  let homeReady = false

  const baseEnv: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: opts.home,
    XDG_CONFIG_HOME: opts.home,
    LC_ALL: 'C',
    LANG: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_PAGER: 'cat',
  }

  function ensureHome(): void {
    if (homeReady) return
    fs.mkdirSync(opts.home, { recursive: true, mode: 0o700 })
    homeReady = true
  }

  function exec(argv: string[], o: GitRunOptions, cwd: string): Promise<GitResult> {
    ensureHome()
    const okCodes = o.okCodes ?? [0]
    return new Promise<GitResult>((resolve, reject) => {
      const child = execFile(binary, argv, {
        cwd,
        env: { ...baseEnv, ...o.env },
        encoding: 'buffer',
        maxBuffer: o.maxBuffer ?? DEFAULT_MAX_BUFFER,
        timeout: o.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        killSignal: 'SIGKILL',
        windowsHide: true,
      }, (err, stdout, stderr) => {
        const errText = truncate(stderr.toString('utf8'))
        if (!err) {
          if (okCodes.includes(0)) return resolve({ code: 0, stdout, stderr: errText })
          return reject(new GitError(`git ${describe(argv)} exited with 0`, argv, 0, errText))
        }
        const code = (err as NodeJS.ErrnoException & { code?: number | string }).code
        if (typeof code === 'number' && okCodes.includes(code)) return resolve({ code, stdout, stderr: errText })
        let msg: string
        if (code === 'ENOENT') msg = `git executable not found (${binary})`
        else if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') msg = `git ${describe(argv)}: output exceeds the buffer limit`
        else if ((err as { killed?: boolean }).killed) msg = `git ${describe(argv)} timed out`
        else msg = `git ${describe(argv)} failed${typeof code === 'number' ? ` (exit ${code})` : ''}: ${firstLine(errText) || err.message}`
        reject(new GitError(msg, argv, code ?? null, errText))
      })
      // Always close stdin so commands that read it never hang; ignore EPIPE when git exits early.
      child.stdin?.on('error', () => {})
      child.stdin?.end(o.input)
    })
  }

  function configArgs(o: GitRunOptions): string[] {
    const out: string[] = []
    for (const c of [...HARDENING_CONFIG, ...(o.config ?? [])]) out.push('-c', c)
    return out
  }

  return {
    run(repo, args, o = {}) {
      return mutex.run(repo.gitDir, async () => {
        // git refuses to run at all when --work-tree names a missing directory (even for
        // read-only commands), so it is only passed while the project directory exists.
        // Commands that need the work tree (add) are never run without it.
        const hasWorkTree = await isDirectory(repo.workTree)
        const argv = [
          `--git-dir=${repo.gitDir}`,
          ...(hasWorkTree ? [`--work-tree=${repo.workTree}`] : []),
          '--no-pager', ...configArgs(o), ...args,
        ]
        return exec(argv, o, o.cwd ?? repo.gitDir)
      })
    },
    runBare(args, o = {}) {
      const argv = ['--no-pager', ...configArgs(o), ...args]
      return exec(argv, o, o.cwd ?? opts.home)
    },
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(p)).isDirectory()
  } catch {
    return false
  }
}

function truncate(s: string, max = 16 * 1024): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0] ?? ''
}

/** `git <subcommand>` for messages (never echoes paths or config values) */
function describe(argv: string[]): string {
  let i = 0
  while (i < argv.length && (argv[i].startsWith('-'))) i += argv[i] === '-c' ? 2 : 1
  return argv[i] ?? ''
}

/** Full or abbreviated lowercase hex object id, or HEAD. */
export const REV_RE = /^(?:HEAD|[0-9a-f]{4,64})$/
export const FULL_SHA_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/
