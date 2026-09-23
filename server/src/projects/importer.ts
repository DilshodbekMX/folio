/**
 * Project importer (SPEC §4.7), shared by zip upload, the directory seed CLI, templates and
 * project copies.
 *
 * Pipeline: collect candidates (zip central directory / directory walk / in-memory files) →
 * normalise + validate paths, drop the ignore list and excluded names, strip a single common
 * top-level folder (zips) → stage into DATA_DIR/tmp/import-* (byte-counted) → classify
 * (text: UTF-8 + normalizeText) → drop `<root>.pdf` next to a root .tex → pick the root doc →
 * create the project row, move the staged tree to projects/<pid>, insert file rows →
 * history.init.
 *
 * Zip safety (yauzl): whole archive rejected for absolute / `..` names, symlink entries,
 * encrypted or undecodable entries, > 2000 entries, > 300 MB uncompressed, per-entry compression
 * ratio > 200:1 (entries > 1 MiB); extraction is byte-counted against the declared sizes (yauzl
 * validateEntrySizes) and the totals.
 *
 * Entry names are decoded and validated here (yauzl `decodeStrings: false`): yauzl's own check
 * refuses legal POSIX names such as `a:b.tex` as Windows drive paths, so a project containing one
 * (valid under shared/paths.ts) could not be re-imported from its own history download. Names are
 * decoded like yauzl does (UTF-8 flag / Info-ZIP Unicode Path extra field, else CP437), except that
 * unflagged names that are valid UTF-8 are read as UTF-8 (what macOS/Linux zip tools write).
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { Transform, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import yauzl from 'yauzl'
import type { Compiler, FileEntry, UserPublic } from '@folio/shared/api'
import { classifyFile, MAX_TEXT_FILE_BYTES, normalizeText } from '@folio/shared/filetypes'
import { basename, dirname, extname, normalizePath, validatePath } from '@folio/shared/paths'
import { newId } from '../db/index.ts'
import { badRequest, HttpError } from '../http/errors.ts'
import { moduleLog } from '../log.ts'
import type { Services } from '../services.ts'
import { MAX_PROJECT_ENTRIES, toEntry } from '../files/service.ts'
import { openReadStreamNoFollow } from '../files/storage.ts'

const log = moduleLog('importer')

export const MAX_ZIP_ENTRIES = 2000
export const MAX_IMPORT_BYTES = 300 * 1024 * 1024
export const MAX_COMPRESSION_RATIO = 200
/** entries smaller than this are exempt from the ratio check (small highly-compressible text is normal) */
const RATIO_MIN_BYTES = 1024 * 1024

/** Name patterns the seed CLI excludes unless --exclude is given (see createExcludeMatcher). */
export const DEFAULT_SEED_EXCLUDES = ['ready', '*.zip']

/** The application's own directory (never imported by the directory seed). */
export const APP_ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))

const IGNORED_SEGMENTS = new Set([
  '__macosx', '.git', '.svn', '.hg', '.ds_store', 'thumbs.db', 'desktop.ini', '.texpadtmp', '.r', '.venv', 'venv',
])
/** TeX build artefacts (lower-case suffixes, matched against the file name) */
const IGNORED_SUFFIXES = [
  '.aux', '.log', '.out', '.toc', '.lof', '.lot', '.fls', '.fdb_latexmk', '.synctex', '.synctex.gz',
  '.synctex(busy)', '.synctex.gz(busy)', '.pdfsync', '.xdv', '.dvi', '.bbl', '.blg', '.bcf', '.run.xml',
  '.nav', '.snm', '.vrb', '.nlo', '.ind', '.ilg', '.glo', '.gls', '.glg', '.swp',
]

const DOCUMENTCLASS_RE = /^[^%\n]*\\documentclass\s*(\[[^\]]*\])?\s*\{[^}]+\}/m

export function hasDocumentclass(text: string): boolean {
  return DOCUMENTCLASS_RE.test(text)
}

export type SkipReason = 'ignored' | 'excluded' | 'invalid-path' | 'symlink' | 'duplicate' | 'build-output' | 'special-file'
export interface SkippedEntry { path: string; reason: SkipReason; detail?: string }

/** Human-readable reason for a skipped entry (CreateProjectResponse.skipped). */
export function describeSkipped(e: SkippedEntry): string {
  switch (e.reason) {
    case 'ignored': return e.detail ?? 'ignored'
    case 'invalid-path': return e.detail ? `invalid name: ${e.detail}` : 'invalid name'
    case 'duplicate': return 'duplicate path'
    case 'build-output': return e.detail ? `build output (${e.detail})` : 'build output'
    case 'symlink': return 'symbolic link'
    case 'excluded': return e.detail ? `excluded (${e.detail})` : 'excluded'
    case 'special-file': return 'not a regular file'
  }
}

/** Why a (normalised) path is ignored by every import, or null. */
export function ignoreReason(p: string): string | null {
  const segs = p.split('/')
  for (let i = 0; i < segs.length; i++) {
    const lower = segs[i].toLowerCase()
    if (IGNORED_SEGMENTS.has(lower)) return `ignored name "${segs[i]}"`
    if (lower.startsWith('.') && !(i === segs.length - 1 && lower === '.latexmkrc')) return `hidden file or folder "${segs[i]}"`
  }
  const name = segs[segs.length - 1].toLowerCase()
  for (const suffix of IGNORED_SUFFIXES) if (name.endsWith(suffix) && name.length > suffix.length) return `build artefact (${suffix})`
  return null
}

function globToRegExp(glob: string): RegExp {
  const src = glob.split('').map(c => (c === '*' ? '[^/]*' : c === '?' ? '[^/]' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')
  return new RegExp(`^${src}$`, 'i')
}

/**
 * gitignore-like exclude matcher: a pattern without '/' matches any path segment
 * ('ready', '*.zip'); a pattern with '/' matches the full relative path or one of its prefixes.
 */
export function createExcludeMatcher(patterns: string[]): (p: string) => boolean {
  const cleaned = patterns.map(p => p.trim().replace(/^\.?\/+|\/+$/g, '')).filter(Boolean)
  const segment = cleaned.filter(p => !p.includes('/')).map(globToRegExp)
  const full = cleaned.filter(p => p.includes('/')).map(globToRegExp)
  return (p: string) => {
    const segs = p.split('/')
    if (segs.some(s => segment.some(re => re.test(s)))) return true
    for (let i = 1; i <= segs.length; i++) {
      const prefix = segs.slice(0, i).join('/')
      if (full.some(re => re.test(prefix))) return true
    }
    return false
  }
}

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** One file (or explicit directory) to import. `path` is the raw relative path ('/'-separated). */
export interface ImportCandidate {
  path: string
  isDir?: boolean
  /** declared size in bytes */
  size: number
  /** open the content stream (files only) */
  open?: () => Promise<Readable>
  /** in-memory content (templates, copies) */
  data?: Buffer
}

export interface CollectedSource {
  candidates: ImportCandidate[]
  skipped: SkippedEntry[]
  /** strip a single common top-level folder (zip uploads) */
  stripTopFolder: boolean
  close?: () => void
}

/**
 * Decode a raw zip entry name (see the header comment) and refuse unsafe ones: absolute paths,
 * `..` segments, NUL bytes. Backslashes are treated as separators.
 */
export function decodeZipEntryName(entry: Pick<yauzl.Entry, 'generalPurposeBitFlag' | 'extraFields'>, raw: Buffer): string {
  let name: string
  const flagged = (entry.generalPurposeBitFlag & 0x800) !== 0 || entry.extraFields.some(f => f.id === 0x7075)
  if (!flagged && raw.some(b => b >= 0x80)) {
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(raw).replace(/\\/g, '/')
    } catch {
      name = yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, raw, entry.extraFields, false)
    }
  } else {
    name = yauzl.getFileNameLowLevel(entry.generalPurposeBitFlag, raw, entry.extraFields, false)
  }
  if (name.includes('\0')) throw badRequest('Unsafe path in zip archive: the name contains a NUL byte')
  if (name.startsWith('/')) throw badRequest(`Unsafe path in zip archive: absolute path "${name}"`)
  if (name.split('/').includes('..')) throw badRequest(`Unsafe path in zip archive: invalid relative path "${name}"`)
  return name
}

function isZipMagic(head: Buffer): boolean {
  return head.length >= 4 && head[0] === 0x50 && head[1] === 0x4b && (head[2] === 0x03 || head[2] === 0x05) && (head[3] === 0x04 || head[3] === 0x06)
}

/** Read and validate a zip archive's central directory (nothing is extracted yet). */
export async function collectZip(zipPath: string, opts: { maxEntryBytes: number }): Promise<CollectedSource> {
  const fh = await fsp.open(zipPath, 'r')
  const head = Buffer.alloc(4)
  try {
    await fh.read(head, 0, 4, 0)
  } finally {
    await fh.close()
  }
  if (!isZipMagic(head)) throw badRequest('The uploaded file is not a zip archive')

  let zip: yauzl.ZipFile
  try {
    // names are decoded + validated by decodeZipEntryName (yauzl would refuse 'a:b.tex')
    zip = await yauzl.openPromise(zipPath, { autoClose: false, decodeStrings: false, validateEntrySizes: true, strictFileNames: false })
  } catch (err) {
    throw badRequest(`Invalid zip file: ${(err as Error).message}`)
  }
  try {
    if (zip.entryCount > MAX_ZIP_ENTRIES) throw new HttpError(413, 'too_large', `The zip has ${zip.entryCount} entries (limit ${MAX_ZIP_ENTRIES})`)
    const entries: { e: yauzl.Entry; name: string }[] = []
    try {
      for await (const e of zip.eachEntry()) entries.push({ e, name: decodeZipEntryName(e, e.fileName as unknown as Buffer) })
    } catch (err) {
      if (err instanceof HttpError) throw err
      throw badRequest(`Invalid zip file: ${(err as Error).message}`)
    }
    let total = 0
    const candidates: ImportCandidate[] = []
    for (const { e, name } of entries) {
      const mode = (e.externalFileAttributes >>> 16) & 0o170000
      if (mode === 0o120000) throw badRequest(`The zip contains a symbolic link ("${name}"); symbolic links are not allowed`)
      if (e.isEncrypted()) throw badRequest(`The zip contains an encrypted entry ("${name}")`)
      const isDir = name.endsWith('/')
      if (isDir) {
        candidates.push({ path: name, isDir: true, size: 0 })
        continue
      }
      if (!e.canDecodeFileData()) throw badRequest(`Unsupported compression method in "${name}"`)
      if (e.uncompressedSize > opts.maxEntryBytes) throw new HttpError(413, 'too_large', `"${name}" is too large (${e.uncompressedSize} bytes)`)
      if (e.uncompressedSize > RATIO_MIN_BYTES && e.uncompressedSize / Math.max(1, e.compressedSize) > MAX_COMPRESSION_RATIO) {
        throw new HttpError(413, 'too_large', `"${name}" has a suspicious compression ratio (possible zip bomb)`)
      }
      total += e.uncompressedSize
      if (total > MAX_IMPORT_BYTES) throw new HttpError(413, 'too_large', `The zip expands to more than ${MAX_IMPORT_BYTES / 1024 / 1024} MB`)
      const entry = e
      // yauzl (validateEntrySizes) errors the stream when the inflated size differs from the
      // declared one; stageFile additionally counts bytes against the per-entry and total limits
      candidates.push({ path: name, size: e.uncompressedSize, open: () => zip.openReadStreamPromise(entry) })
    }
    return { candidates, skipped: [], stripTopFolder: true, close: () => zip.close() }
  } catch (err) {
    zip.close()
    throw err
  }
}

/**
 * Walk a directory (seed): lstat-based, symlinks skipped, the app's own directory and the data
 * directory always skipped, `exclude` patterns applied (see createExcludeMatcher).
 */
export async function collectDirectory(srcDir: string, opts: { exclude?: string[]; skipDirs?: string[] } = {}): Promise<CollectedSource> {
  const root = await fsp.realpath(srcDir)
  const skipReal = new Set<string>()
  for (const d of [APP_ROOT, ...(opts.skipDirs ?? [])]) {
    try {
      skipReal.add(await fsp.realpath(d))
    } catch {
      /* does not exist */
    }
  }
  const excluded = createExcludeMatcher(opts.exclude ?? [])
  const candidates: ImportCandidate[] = []
  const skipped: SkippedEntry[] = []

  async function walk(absDir: string, rel: string): Promise<void> {
    const dirents = await fsp.readdir(absDir, { withFileTypes: true })
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    for (const d of dirents) {
      const childRel = rel ? `${rel}/${d.name}` : d.name
      const childAbs = path.join(absDir, d.name)
      const st = await fsp.lstat(childAbs)
      if (st.isSymbolicLink()) {
        skipped.push({ path: childRel, reason: 'symlink' })
        continue
      }
      if (excluded(normalizePath(childRel))) {
        skipped.push({ path: childRel, reason: 'excluded' })
        continue
      }
      if (st.isDirectory()) {
        if (skipReal.has(childAbs)) {
          skipped.push({ path: childRel, reason: 'excluded', detail: 'application or data directory' })
          continue
        }
        // don't descend into ignored folders (.git, __MACOSX, venv, …)
        const why = ignoreReason(normalizePath(childRel))
        if (why) {
          skipped.push({ path: childRel, reason: 'ignored', detail: why })
          continue
        }
        candidates.push({ path: childRel, isDir: true, size: 0 })
        await walk(childAbs, childRel)
      } else if (st.isFile()) {
        candidates.push({ path: childRel, size: st.size, open: async () => (await openReadStreamNoFollow(childAbs)).stream })
      } else {
        skipped.push({ path: childRel, reason: 'special-file' })
      }
    }
  }
  if (skipReal.has(root)) throw badRequest('Refusing to import the application directory itself')
  await walk(root, '')
  return { candidates, skipped, stripTopFolder: false }
}

/** In-memory source (templates, project copies). */
export function collectMemory(files: { path: string; data: Buffer | string }[], dirs: string[] = []): CollectedSource {
  return {
    candidates: [
      ...dirs.map(d => ({ path: d, isDir: true, size: 0 })),
      ...files.map(f => {
        const data = typeof f.data === 'string' ? Buffer.from(f.data, 'utf8') : f.data
        return { path: f.path, size: data.length, data }
      }),
    ],
    skipped: [],
    stripTopFolder: false,
  }
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface ImportOptions {
  owner: UserPublic
  name: string
  /** explicit root document path (after top-folder stripping) */
  rootPath?: string | null
  compiler?: Compiler
  externalDocs?: string[]
  timeoutSec?: number
  spellLang?: string
  /** use this project id (tests); default newId() */
  projectId?: string
  /** skip history.init (the caller initialises history itself, e.g. history.copyProject) */
  skipHistory?: boolean
  /** apply the ignore list (default true; false for copies of existing projects) */
  applyIgnoreList?: boolean
  /** an explicit rootPath that is not an imported text file is an error (default) or ignored */
  strictRoot?: boolean
}

export interface ImportResult {
  projectId: string
  files: FileEntry[]
  rootFileId: string | null
  rootPath: string | null
  skipped: SkippedEntry[]
  textPaths: string[]
  binaryPaths: string[]
  totalBytes: number
}

interface PlannedFile { path: string; cand: ImportCandidate }

/** Filter/normalise candidates; returns the files and folders to create. */
function plan(src: CollectedSource, applyIgnore: boolean): { files: PlannedFile[]; dirs: Set<string>; skipped: SkippedEntry[] } {
  const skipped = [...src.skipped]
  type Norm = { raw: string; path: string; cand: ImportCandidate }
  const keep: Norm[] = []
  for (const cand of src.candidates) {
    const p = normalizePath(cand.path)
    if (!p) continue
    if (applyIgnore) {
      const why = ignoreReason(p)
      if (why) {
        skipped.push({ path: cand.path, reason: 'ignored', detail: why })
        continue
      }
    }
    keep.push({ raw: cand.path, path: p, cand })
  }
  // strip a single top-level folder shared by every file (typical "zip of a folder")
  if (src.stripTopFolder) {
    const fileEntries = keep.filter(k => !k.cand.isDir)
    const first = fileEntries[0]?.path.split('/')[0]
    if (first && fileEntries.every(k => k.path.includes('/') && k.path.split('/')[0] === first)) {
      for (const k of keep) k.path = k.path === first ? '' : k.path.startsWith(first + '/') ? k.path.slice(first.length + 1) : k.path
    }
  }
  const files: PlannedFile[] = []
  const dirs = new Set<string>()
  const seen = new Set<string>()
  for (const k of keep) {
    if (!k.path) continue
    const err = validatePath(k.path)
    if (err) {
      skipped.push({ path: k.raw, reason: 'invalid-path', detail: err })
      continue
    }
    if (k.cand.isDir) {
      dirs.add(k.path)
      continue
    }
    if (seen.has(k.path)) {
      skipped.push({ path: k.raw, reason: 'duplicate' })
      continue
    }
    seen.add(k.path)
    files.push({ path: k.path, cand: k.cand })
  }
  // ancestors of files and folders are folders; a folder that is also a file path is a conflict → drop the folder
  for (const p of [...files.map(f => f.path), ...dirs]) {
    let d = dirname(p)
    while (d) {
      dirs.add(d)
      d = dirname(d)
    }
  }
  for (const d of [...dirs]) {
    if (seen.has(d)) {
      dirs.delete(d)
      // files below a path that is itself a file cannot be represented
      for (let i = files.length - 1; i >= 0; i--) {
        if (files[i].path.startsWith(d + '/')) {
          skipped.push({ path: files[i].path, reason: 'invalid-path', detail: `"${d}" is both a file and a folder` })
          files.splice(i, 1)
        }
      }
    }
  }
  return { files, dirs, skipped }
}

async function stageFile(stagingRoot: string, f: PlannedFile, maxBytes: number, counter: { total: number }): Promise<number> {
  const dest = path.join(stagingRoot, ...f.path.split('/'))
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  if (f.cand.data) {
    await fsp.writeFile(dest, f.cand.data, { flag: 'wx', mode: 0o644 })
    counter.total += f.cand.data.length
    return f.cand.data.length
  }
  if (!f.cand.open) throw new Error(`candidate ${f.path} has no content`)
  let n = 0
  const counting = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length
      counter.total += chunk.length
      if (n > maxBytes) cb(new HttpError(413, 'too_large', `"${f.path}" is too large`))
      else if (counter.total > MAX_IMPORT_BYTES) cb(new HttpError(413, 'too_large', `The import exceeds ${MAX_IMPORT_BYTES / 1024 / 1024} MB`))
      else cb(null, chunk)
    },
  })
  await pipeline(await f.cand.open(), counting, fs.createWriteStream(dest, { flags: 'wx', mode: 0o644 }))
  return n
}

function pickRoot(texts: Map<string, string>): string | null {
  const main = texts.get('main.tex')
  if (main !== undefined && hasDocumentclass(main)) return 'main.tex'
  const candidates = [...texts.keys()]
    .filter(p => ['tex', 'ltx', 'rtex', 'rnw'].includes(extname(p)) && hasDocumentclass(texts.get(p)!))
    .sort((a, b) => {
      const da = a.split('/').length
      const db = b.split('/').length
      if (da !== db) return da - db
      const ma = basename(a) === 'main.tex' ? 0 : 1
      const mb = basename(b) === 'main.tex' ? 0 : 1
      if (ma !== mb) return ma - mb
      return a < b ? -1 : a > b ? 1 : 0
    })
  return candidates[0] ?? null
}

/**
 * Import a collected source as a new project owned by `opts.owner`. Always closes the source.
 * On failure nothing is left behind (staging dir, project row and directory are removed).
 */
export async function importProject(s: Services, src: CollectedSource, opts: ImportOptions): Promise<ImportResult> {
  const staging = await fsp.mkdtemp(path.join(s.config.dirs.tmp, 'import-'))
  const projectId = opts.projectId ?? newId()
  const projectDir = path.join(s.config.dirs.projects, projectId)
  let projectCreated = false
  let moved = false
  try {
    const { files, dirs, skipped } = plan(src, opts.applyIgnoreList !== false)
    if (files.length + dirs.size > MAX_PROJECT_ENTRIES) {
      throw new HttpError(413, 'too_large', `The import has ${files.length + dirs.size} files and folders (limit ${MAX_PROJECT_ENTRIES})`)
    }
    const maxEntryBytes = Math.max(s.config.maxUploadBytes, 50 * 1024 * 1024)
    const counter = { total: 0 }
    const sizes = new Map<string, number>()
    for (const f of files) sizes.set(f.path, await stageFile(staging, f, maxEntryBytes, counter))
    for (const d of dirs) await fsp.mkdir(path.join(staging, ...d.split('/')), { recursive: true })
    src.close?.()

    // classify; text is normalised in place
    const kinds = new Map<string, 'text' | 'binary'>()
    const texts = new Map<string, string>()
    for (const f of files) {
      const abs = path.join(staging, ...f.path.split('/'))
      const size = sizes.get(f.path)!
      if (size > MAX_TEXT_FILE_BYTES) {
        kinds.set(f.path, 'binary')
        continue
      }
      const bytes = await fsp.readFile(abs)
      const kind = classifyFile(f.path, bytes)
      kinds.set(f.path, kind)
      if (kind === 'text') {
        const text = normalizeText(bytes.toString('utf8'))
        texts.set(f.path, text)
        const out = Buffer.from(text, 'utf8')
        if (!out.equals(bytes)) await fsp.writeFile(abs, out)
        sizes.set(f.path, out.length)
      }
    }

    // `<root>.pdf` next to a root .tex is a stale build output
    const kept: PlannedFile[] = []
    for (const f of files) {
      if (extname(f.path) === 'pdf') {
        const tex = f.path.slice(0, -4) + '.tex'
        const t = texts.get(tex)
        if (t !== undefined && hasDocumentclass(t)) {
          skipped.push({ path: f.cand.path, reason: 'build-output', detail: `output of ${tex}` })
          await fsp.rm(path.join(staging, ...f.path.split('/')), { force: true })
          continue
        }
      }
      kept.push(f)
    }

    let rootPath: string | null = null
    if (opts.rootPath && texts.has(normalizePath(opts.rootPath))) {
      rootPath = normalizePath(opts.rootPath)
    } else if (opts.rootPath && opts.strictRoot !== false) {
      throw badRequest(`Main document "${opts.rootPath}" was not found among the imported text files`)
    } else {
      rootPath = pickRoot(texts)
    }
    const externalDocs = (opts.externalDocs ?? []).map(p => {
      const np = normalizePath(p)
      const err = validatePath(np)
      if (err) throw badRequest(`Invalid external document path "${p}": ${err}`)
      return np
    })

    // create the project, move the staged tree in, insert rows
    await fsp.mkdir(s.config.dirs.projects, { recursive: true })
    s.db.projects.create({
      id: projectId,
      name: opts.name,
      ownerId: opts.owner.id,
      settings: {
        compiler: opts.compiler ?? 'pdflatex',
        rootFileId: null,
        externalDocs,
        timeoutSec: opts.timeoutSec ?? s.config.compile.defaultTimeoutSec,
        spellLang: opts.spellLang ?? 'en',
        image: s.config.compile.image,
      },
    })
    projectCreated = true
    await moveDir(staging, projectDir)
    moved = true
    await fsp.chmod(projectDir, 0o755)

    const entries: FileEntry[] = []
    let rootFileId: string | null = null
    s.db.transaction(() => {
      for (const d of [...dirs].sort()) entries.push(toEntry(s.db.files.create({ projectId, path: d, kind: 'folder' })))
      for (const f of kept) {
        const rec = s.db.files.create({ projectId, path: f.path, kind: kinds.get(f.path)!, size: sizes.get(f.path)! })
        if (f.path === rootPath) rootFileId = rec.id
        entries.push(toEntry(rec))
      }
      if (rootFileId) s.db.projects.updateSettings(projectId, { rootFileId })
    })

    if (!opts.skipHistory) {
      try {
        await s.history.init(projectId, opts.owner)
      } catch (err) {
        log.warn({ err, projectId }, 'history.init failed after import')
      }
    }
    const textPaths = kept.filter(f => kinds.get(f.path) === 'text').map(f => f.path)
    const binaryPaths = kept.filter(f => kinds.get(f.path) === 'binary').map(f => f.path)
    log.info({ projectId, owner: opts.owner.id, text: textPaths.length, binary: binaryPaths.length, folders: dirs.size, skipped: skipped.length, rootPath }, 'project imported')
    if (skipped.length) log.debug({ projectId, skipped }, 'import skipped entries')
    return {
      projectId,
      files: entries,
      rootFileId,
      rootPath: rootFileId ? rootPath : null,
      skipped,
      textPaths,
      binaryPaths,
      totalBytes: kept.reduce((n, f) => n + sizes.get(f.path)!, 0),
    }
  } catch (err) {
    if (projectCreated) {
      try {
        s.db.projects.delete(projectId)
      } catch (e) {
        log.warn({ err: e, projectId }, 'failed to remove partially imported project row')
      }
    }
    if (moved) await fsp.rm(projectDir, { recursive: true, force: true }).catch(() => {})
    throw err
  } finally {
    src.close?.()
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => {})
  }
}

async function moveDir(from: string, to: string): Promise<void> {
  try {
    await fsp.rename(from, to)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
    await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false, verbatimSymlinks: true })
    await fsp.rm(from, { recursive: true, force: true })
  }
}
