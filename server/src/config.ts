/**
 * Server configuration from environment variables (see .env.example).
 * All data lives under DATA_DIR:
 *
 *   db.sqlite                         metadata (users, sessions, projects, members, files, labels, chat)
 *   projects/<pid>/                   canonical project files (only user files — never .git or sidecars)
 *   history/<pid>.git                 git dir for the project's history (work tree = projects/<pid>)
 *   ystate/<pid>/<fileId>.<epoch>.ybin   Yjs sidecar state per text file
 *   compiles/<pid>/                   persistent writable compile dir (mounted at /compile)
 *   builds/<pid>/<buildId>/           immutable per-build outputs + meta.json
 *   texcache/                         fontconfig + TEXMFVAR cache volume (mounted at /cache)
 *   previews/<pid>/<sha1>.png         EPS/PS preview cache
 *   tmp/                              upload temp files
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export interface Config {
  env: 'development' | 'production' | 'test'
  port: number
  host: string
  /**
   * e.g. 'https://latex.example.com' (always a bare origin: scheme + host [+ port], validated by
   * parsePublicOrigin) — when unset the Origin check compares with the Host header
   */
  publicOrigin: string | null
  dataDir: string
  dirs: {
    projects: string
    history: string
    ystate: string
    compiles: string
    builds: string
    texcache: string
    previews: string
    tmp: string
  }
  dbFile: string
  /** built SPA (web/dist); served in production */
  webDist: string
  /** node_modules/pdfjs-dist root; its cmaps/, standard_fonts/, wasm/, iccs/ are served under /pdfjs/ */
  pdfjsDir: string
  compile: {
    runner: 'docker' | 'local' | 'fake'
    image: string
    maxConcurrent: number
    defaultTimeoutSec: number
    maxTimeoutSec: number
    memory: string
    cpus: string
    /** host uid:gid the container runs as (files come out owned by the host user) */
    user: string
  }
  allowSignup: boolean
  sessionTtlDays: number
  maxUploadBytes: number
  version: string
}

const APP_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

function int(v: string | undefined, def: number): number {
  const n = v === undefined || v === '' ? NaN : Number(v)
  return Number.isFinite(n) ? n : def
}

/**
 * PUBLIC_ORIGIN as a bare origin ('https://latex.example.com'), null when unset. Throws a clear
 * error for values that would make every login fail with "Cross-origin request rejected": no
 * scheme ('latex.example.com'), a path ('https://example.com/folio' — Folio must be served at the
 * root of its origin), a query, a fragment or credentials. Default ports and case are normalised.
 */
export function parsePublicOrigin(value: string | undefined): string | null {
  const v = value?.trim()
  if (!v) return null
  const example = 'e.g. PUBLIC_ORIGIN=https://latex.example.com'
  let url: URL
  try {
    url = new URL(v)
  } catch {
    throw new Error(`PUBLIC_ORIGIN "${v}" is not a URL: write the address people open, with its scheme (${example})`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`PUBLIC_ORIGIN "${v}" must start with https:// or http:// (${example})`)
  }
  if (url.username || url.password) throw new Error(`PUBLIC_ORIGIN "${v}" must not contain a user name or password (${example})`)
  if (url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`PUBLIC_ORIGIN "${v}" has a path, query or fragment: Folio must be served at the root of its origin, sub-paths such as https://example.com/folio are not supported (${example})`)
  }
  return url.origin
}

/**
 * Who TeX runs as. Running Folio as root with the default COMPILE_USER would run every compile
 * container as root (fatal: the server refuses to start); an explicit COMPILE_USER of 0, or the
 * local runner under root, only warns. Null when fine.
 */
export function compileUserProblem(config: Config, env: NodeJS.ProcessEnv = process.env, uid: number | undefined = process.getuid?.()): { fatal: boolean; message: string } | null {
  if (config.compile.runner === 'docker') {
    if (uid === 0 && !env.COMPILE_USER) {
      return {
        fatal: true,
        message: 'Folio is running as root, so every compile container would run TeX as root. Run Folio as a normal user who is in the docker group (e.g. User= in its systemd unit), or set COMPILE_USER to an unprivileged uid:gid that can write the data directory.',
      }
    }
    if (/^0(?::|$)/.test(config.compile.user)) {
      return { fatal: false, message: `COMPILE_USER=${config.compile.user} runs TeX as root inside the compile containers; use an unprivileged uid:gid.` }
    }
  } else if (config.compile.runner === 'local' && uid === 0) {
    return { fatal: false, message: 'Folio is running as root with COMPILE_RUNNER=local: TeX runs on this machine as root, without a sandbox.' }
  }
  return null
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = path.resolve(APP_ROOT, env.DATA_DIR ?? 'data')
  const nodeEnv = env.NODE_ENV === 'production' ? 'production' : env.NODE_ENV === 'test' ? 'test' : 'development'
  const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
  const gid = typeof process.getgid === 'function' ? process.getgid() : 1000
  const runner = (env.COMPILE_RUNNER ?? 'docker') as Config['compile']['runner']
  if (!['docker', 'local', 'fake'].includes(runner)) throw new Error(`Invalid COMPILE_RUNNER: ${runner}`)
  return {
    env: nodeEnv,
    port: int(env.PORT, 3100),
    host: env.HOST ?? '127.0.0.1',
    publicOrigin: parsePublicOrigin(env.PUBLIC_ORIGIN),
    dataDir,
    dirs: {
      projects: path.join(dataDir, 'projects'),
      history: path.join(dataDir, 'history'),
      ystate: path.join(dataDir, 'ystate'),
      compiles: path.join(dataDir, 'compiles'),
      builds: path.join(dataDir, 'builds'),
      texcache: path.join(dataDir, 'texcache'),
      previews: path.join(dataDir, 'previews'),
      tmp: path.join(dataDir, 'tmp'),
    },
    dbFile: path.join(dataDir, 'db.sqlite'),
    webDist: path.resolve(APP_ROOT, env.WEB_DIST ?? 'web/dist'),
    pdfjsDir: path.resolve(APP_ROOT, 'node_modules/pdfjs-dist'),
    compile: {
      runner,
      image: env.COMPILE_IMAGE ?? 'texlive/texlive:latest-full',
      maxConcurrent: int(env.MAX_CONCURRENT_COMPILES, 4),
      defaultTimeoutSec: int(env.COMPILE_TIMEOUT_SEC, 240),
      maxTimeoutSec: 600,
      memory: env.COMPILE_MEMORY ?? '2g',
      cpus: env.COMPILE_CPUS ?? '2',
      user: env.COMPILE_USER ?? `${uid}:${gid}`,
    },
    allowSignup: env.ALLOW_SIGNUP === 'true' || env.ALLOW_SIGNUP === '1',
    sessionTtlDays: int(env.SESSION_TTL_DAYS, 30),
    maxUploadBytes: int(env.MAX_UPLOAD_MB, 50) * 1024 * 1024,
    version: '0.1.0',
  }
}
