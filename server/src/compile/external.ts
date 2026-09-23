/**
 * xr / xr-hyper external documents (SPEC §4.5 "xr pre-build").
 *
 * `\externaldocument{supp}` makes LaTeX read `supp.aux`, which latexmk never builds (Overleaf
 * relies on a Perl latexmkrc; we run with -norc). The compile service therefore builds every
 * external document in the same compile directory with its own jobname:
 *   - before the main run, when its `.aux` is missing, a project file it reads changed (its own
 *     .tex, what it \input's / \include's, its .bib, class, packages and figures — see
 *     documentDependencies), or the labels it imports itself (mutual xr: supp → main.aux) changed
 *     since its last build;
 *   - after the main run, again when the main run changed the labels it imports, so its PDF
 *     never keeps '??' for references to the main document (see compile/index.ts).
 * `\externaldocument` is detected in the root document and in every project file it reaches
 * through \input / \include / \subfile / \import / \usepackage (a preamble kept in its own
 * file), unless the project lists its external documents explicitly.
 * The \@input{…} lines of an .aux (chapters of \include) name files in UTF-8, whatever the engine.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import { moduleLog } from '../log.ts'
import { safeFileStat } from './sync.ts'

const log = moduleLog('compile.external')

type LatexHelpers = typeof import('@folio/shared/latex')

const LATEX_MODULE = '@folio/shared/latex'
let latexPromise: Promise<Partial<LatexHelpers> | null> | null = null

/** `@folio/shared/latex`, loaded lazily (null when unavailable — a local fallback is used). */
export function loadLatexHelpers(): Promise<Partial<LatexHelpers> | null> {
  latexPromise ??= (import(/* @vite-ignore */ LATEX_MODULE) as Promise<LatexHelpers>).catch(err => {
    log.warn({ err }, '@folio/shared/latex unavailable; using built-in \\documentclass / \\externaldocument detection')
    return null
  })
  return latexPromise
}

/** Blank out % comments (keeping \%) so commented-out commands are ignored. */
function stripComments(text: string): string {
  return text.replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, '$1$2')
}

export function fallbackHasDocumentclass(text: string): boolean {
  return /\\documentclass\s*(?:\[[^\]]*\])?\s*\{/.test(stripComments(text))
}

export function fallbackExternalDocuments(text: string): { name: string; prefix?: string }[] {
  const out: { name: string; prefix?: string }[] = []
  const re = /\\external(?:cite)?document\s*(?:\[([^\]]*)\])?\s*\{([^}]+)\}/g
  for (const m of stripComments(text).matchAll(re)) {
    const name = m[2].trim()
    if (name) out.push(m[1] !== undefined ? { name, prefix: m[1] } : { name })
  }
  return out
}

export async function hasDocumentclass(text: string): Promise<boolean> {
  const lib = await loadLatexHelpers()
  if (lib?.hasDocumentclass) {
    try {
      return lib.hasDocumentclass(text)
    } catch (err) {
      log.warn({ err }, 'hasDocumentclass failed; using fallback')
    }
  }
  return fallbackHasDocumentclass(text)
}

export async function externalDocumentNames(rootText: string): Promise<string[]> {
  const lib = await loadLatexHelpers()
  let docs: { name: string }[] | null = null
  if (lib?.extractExternalDocuments) {
    try {
      docs = lib.extractExternalDocuments(rootText)
    } catch (err) {
      log.warn({ err }, 'extractExternalDocuments failed; using fallback')
    }
  }
  return (docs ?? fallbackExternalDocuments(rootText)).map(d => d.name)
}

/** \input-like commands followed when looking for \externaldocument (with the extensions TeX tries). */
const FOLLOWED: Record<string, string[]> = {
  input: ['.tex', ''], include: ['.tex'], subfile: ['.tex', ''], import: ['.tex', ''], subimport: ['.tex', ''],
  usepackage: ['.sty'],
}
/** at most this many files are scanned per document */
const MAX_REACHABLE = 400

export function fallbackIncludes(text: string): { command: string; path: string }[] {
  const out: { command: string; path: string }[] = []
  const re = /\\(input|include|subfile|usepackage)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g
  for (const m of stripComments(text).matchAll(re)) {
    for (const part of m[1] === 'usepackage' ? m[2].split(',') : [m[2]]) {
      const p = part.trim()
      if (p) out.push({ command: m[1], path: p })
    }
  }
  return out
}

/**
 * Project text files a document reads: `docPath` itself, then every file reached through
 * \input / \include / \subfile / \import / \subimport / \usepackage (project .sty files),
 * breadth first. Names are resolved like TeX does with latexmk -cd: relative to the folder of
 * the document being compiled, whichever file contains the command.
 */
export async function reachableTexts(docPath: string, texts: ReadonlyMap<string, string>): Promise<string[]> {
  const lib = await loadLatexHelpers()
  const baseDir = path.posix.dirname(docPath) === '.' ? '' : path.posix.dirname(docPath)
  const seen = new Set<string>([docPath])
  const order = [docPath]
  for (let i = 0; i < order.length && order.length < MAX_REACHABLE; i++) {
    const text = texts.get(order[i])
    if (text === undefined) continue
    let refs: { command: string; path: string }[]
    try {
      refs = lib?.extractIncludes ? lib.extractIncludes(text) : fallbackIncludes(text)
    } catch (err) {
      log.warn({ err }, 'extractIncludes failed; using fallback')
      refs = fallbackIncludes(text)
    }
    for (const r of refs) {
      const exts = FOLLOWED[r.command]
      if (!exts) continue
      const clean = r.path.replace(/^"(.*)"$/, '$1').replace(/\\/g, '/')
      for (const ext of exts) {
        const cand = normalizeInside(baseDir ? `${baseDir}/${clean}${ext}` : `${clean}${ext}`)
        if (!cand || !texts.has(cand)) continue
        if (!seen.has(cand)) {
          seen.add(cand)
          order.push(cand)
        }
        break
      }
      if (order.length >= MAX_REACHABLE) break
    }
  }
  return order
}

/**
 * Commands whose file argument TeX reads besides the \input-like ones reachableTexts follows:
 * a change to one of these files can change an external document's output (citations,
 * page numbers, its class or packages), so it is part of the external document's rebuild key.
 */
const READ_COMMANDS = new Set([
  'bibliography', 'addbibresource', 'documentclass', 'usepackage', 'includegraphics', 'includepdf', 'includesvg',
  'lstinputlisting', 'inputminted', 'verbatiminput',
])
/** at most this many dependencies are collected per document */
const MAX_DEPENDENCIES = 2000

/**
 * Project files a document reads: every text file reachable through \input / \include / … (see
 * reachableTexts) plus the project files named by \bibliography, \addbibresource,
 * \documentclass, \usepackage, \includegraphics and similar commands in any of them. Sorted.
 * An xr external document is rebuilt when one of these files changes (not only its own .tex).
 */
export async function documentDependencies(docPath: string, texts: ReadonlyMap<string, string>, projectPaths: ReadonlySet<string>): Promise<string[]> {
  const lib = await loadLatexHelpers()
  const reach = await reachableTexts(docPath, texts)
  const out = new Set(reach)
  if (lib?.extractIncludes && lib.resolveInclude) {
    const baseDir = path.posix.dirname(docPath) === '.' ? '' : path.posix.dirname(docPath)
    for (const f of reach) {
      const text = texts.get(f)
      if (text === undefined) continue
      let refs: { command: string; path: string }[]
      try {
        refs = lib.extractIncludes(text)
      } catch (err) {
        log.warn({ err }, 'extractIncludes failed while collecting dependencies')
        continue
      }
      for (const r of refs) {
        if (!READ_COMMANDS.has(r.command)) continue
        const hit = lib.resolveInclude(r as Parameters<LatexHelpers['resolveInclude']>[0], projectPaths, baseDir)
        if (hit) out.add(hit)
      }
      if (out.size >= MAX_DEPENDENCIES) break
    }
  }
  return [...out].sort()
}

/** `\externaldocument` names of a document and of every project file it reads (first occurrence order). */
export async function detectExternalDocuments(docPath: string, texts: ReadonlyMap<string, string>): Promise<string[]> {
  const out: string[] = []
  for (const f of await reachableTexts(docPath, texts)) {
    for (const name of await externalDocumentNames(texts.get(f) ?? '')) if (!out.includes(name)) out.push(name)
  }
  return out
}

/**
 * Compile-dir paths of the `.aux` files a document imports with \externaldocument (resolved
 * against the document's own folder, as TeX sees it with latexmk -cd).
 */
export function importedAuxPaths(docPath: string, names: string[]): string[] {
  const dir = path.posix.dirname(docPath) === '.' ? '' : path.posix.dirname(docPath)
  const out: string[] = []
  for (const name of names) {
    const base = name.trim().replace(/\\/g, '/').replace(/\.(?:aux|tex)$/i, '')
    const p = base ? normalizeInside(dir ? `${dir}/${base}.aux` : `${base}.aux`) : null
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

const MAX_AUX_BYTES = 16 * 1024 * 1024

/**
 * Hash of the labels xr would import from these `.aux` files: their \newlabel lines, following
 * \@input{…} (chapters of \include) a few levels deep. A missing file counts as one without
 * labels. Everything else in an .aux (toc, citations, page count) is ignored: it does not change
 * what the importing document shows.
 */
export async function importedLabelsHash(compileDir: string, auxPaths: string[]): Promise<string> {
  const h = createHash('sha1')
  const seen = new Set<string>()
  const visit = async (rel: string, depth: number): Promise<void> => {
    if (seen.has(rel) || seen.size > 64) return
    seen.add(rel)
    h.update(`\u0000${rel}\u0000`)
    const st = await safeFileStat(compileDir, rel)
    if (!st || st.size > MAX_AUX_BYTES) return
    let text: string
    try {
      text = await fs.readFile(path.join(compileDir, ...rel.split('/')), 'latin1')
    } catch {
      return
    }
    const dir = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel)
    for (const line of text.split('\n')) {
      if (line.startsWith('\\newlabel')) h.update(line).update('\n')
      else if (depth < 3 && line.startsWith('\\@input{')) {
        const m = /^\\@input\{([^}]+)\}/.exec(line)
        // the file was read byte for byte (latin1); TeX wrote the name as UTF-8 bytes
        const child = m ? auxChild(compileDir, dir, Buffer.from(m[1], 'latin1').toString('utf8')) : null
        if (child) await visit(await child, depth + 1)
      }
    }
  }
  for (const p of auxPaths) await visit(p, 0)
  return h.digest('hex').slice(0, 16)
}

/**
 * Compile-dir path of an \@input{…} .aux file: as written (UTF-8), or its NFC / NFD form when only
 * that one exists (project paths are NFC; an editor may have typed the \include name decomposed).
 */
function auxChild(compileDir: string, dir: string, name: string): Promise<string> | null {
  const rel = normalizeInside(dir ? `${dir}/${name}` : name)
  return rel === null ? null : existingForm(compileDir, rel)
}

async function existingForm(compileDir: string, rel: string): Promise<string> {
  if (await safeFileStat(compileDir, rel)) return rel
  for (const form of ['NFC', 'NFD'] as const) {
    const alt: string = rel.normalize(form)
    if (alt !== rel && await safeFileStat(compileDir, alt)) return alt
  }
  return rel
}

/** Normalised POSIX path inside the project (null when it escapes it or is empty). */
function normalizeInside(p: string): string | null {
  const n = path.posix.normalize(p).replace(/^\.\//, '')
  return n === '.' || n === '' || n.startsWith('../') || n === '..' || n.startsWith('/') ? null : n
}

/**
 * Project paths of the external documents to pre-build. Explicit `settings.externalDocs` win
 * (a missing `.tex` extension is tolerated); otherwise the names found in the root document are
 * resolved relative to the root's folder. Only existing text files are returned, never the
 * root itself, without duplicates.
 */
export function resolveExternalDocs(o: {
  rootPath: string
  explicit: string[]
  detected: string[]
  isTextFile: (projectPath: string) => boolean
}): string[] {
  const out: string[] = []
  const add = (p: string | null) => {
    if (p && p !== o.rootPath && !out.includes(p) && o.isTextFile(p)) out.push(p)
  }
  const norm = (p: string): string | null => {
    const n = path.posix.normalize(p.replace(/\\/g, '/')).replace(/^\.\//, '')
    return n === '.' || n.startsWith('../') || n.startsWith('/') ? null : n
  }
  if (o.explicit.length > 0) {
    for (const e of o.explicit) {
      const n = norm(e.trim())
      if (!n) continue
      add(o.isTextFile(n) ? n : o.isTextFile(`${n}.tex`) ? `${n}.tex` : null)
    }
    return out
  }
  const rootDir = path.posix.dirname(o.rootPath)
  for (const name of o.detected) {
    const base = name.trim().replace(/\.(?:aux|tex)$/i, '')
    if (!base) continue
    add(norm(path.posix.join(rootDir, `${base}.tex`)))
  }
  return out
}

/** jobname of a document: its file name without the last extension */
export function jobnameOf(projectPath: string): string {
  const b = path.posix.basename(projectPath)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(0, i) : b
}

/** `<dir>/<job>.<ext>` for the outputs of the document at projectPath */
export function outputPath(projectPath: string, ext: string): string {
  const dir = path.posix.dirname(projectPath)
  const name = `${jobnameOf(projectPath)}.${ext}`
  return dir === '.' ? name : `${dir}/${name}`
}
