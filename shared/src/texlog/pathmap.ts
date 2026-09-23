/**
 * Mapping between file names as TeX/BibTeX/Biber print them and project-relative paths.
 * Folio compiles in `/compile` (the project snapshot), so names appear as `./x.tex`,
 * `/compile/x.tex`, `/compile/./x.tex`, `x.tex` or quoted (`"./my dir/x.tex"` from LuaTeX).
 */

export const DEFAULT_COMPILE_DIR = '/compile'

/** Characters that may follow a file name TeX printed after '(' */
const AFTER_NAME = /^(?:$|[\s)("[\]{}<])/

export interface KnownMatch {
  /** project path */
  path: string
  /** number of characters of the input consumed (including quotes) */
  consumed: number
}

export class PathMapper {
  readonly compileDir: string
  readonly files: Set<string>
  /** project files bucketed by their first two characters, longest first */
  private readonly buckets = new Map<string, string[]>()
  private readonly prefixes: string[]

  constructor(projectFiles: readonly string[], compileDir: string = DEFAULT_COMPILE_DIR) {
    this.compileDir = compileDir.replace(/\/+$/, '') || DEFAULT_COMPILE_DIR
    this.files = new Set(projectFiles)
    for (const f of this.files) {
      const k = f.slice(0, 2)
      let b = this.buckets.get(k)
      if (!b) this.buckets.set(k, (b = []))
      b.push(f)
    }
    for (const b of this.buckets.values()) b.sort((a, c) => c.length - a.length)
    this.prefixes = [`${this.compileDir}/./`, `${this.compileDir}/`, './', '']
  }

  /**
   * Normalise a printed name: strip quotes, compile-dir prefix and './', collapse '//' and '/./'
   * and 'dir/../' (leading '../' is kept).
   */
  normalize(raw: string): string {
    let p = raw.trim().replace(/^"(.*)"$/, '$1').replace(/\\/g, '/')
    p = p.replace(/\/{2,}/g, '/').replace(/\/\.(?=\/)/g, '')
    if (p === this.compileDir) return ''
    if (p.startsWith(this.compileDir + '/')) p = p.slice(this.compileDir.length + 1)
    while (p.startsWith('./')) p = p.slice(2)
    if (p.includes('../')) {
      const out: string[] = []
      for (const seg of p.split('/')) {
        if (seg === '..' && out.length > 0 && out[out.length - 1] !== '..') out.pop()
        else out.push(seg)
      }
      p = out.join('/')
    }
    return p
  }

  /**
   * Is `raw` (as printed) a relative name or inside the compile directory, i.e. potentially a
   * project file? ('../x.tex' is one when the compile directory is a sub-folder of the project
   * and the project list names it so.)
   */
  isLocal(raw: string): boolean {
    const p = raw.trim().replace(/^"(.*)"$/, '$1')
    if (p.startsWith(this.compileDir + '/')) return true
    return !(p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p))
  }

  /**
   * Project path for a printed name, or null when it is not a project file (system file,
   * generated file such as .aux, or unknown). With an empty project list every local
   * (relative / compile-dir) name inside the compile directory counts as a project file.
   */
  toProjectPath(raw: string | null | undefined): string | null {
    if (!raw) return null
    if (!this.isLocal(raw)) return null
    const p = this.normalize(raw)
    if (!p) return null
    if (this.files.size === 0) return p.startsWith('../') ? null : p
    return this.files.has(p) ? p : null
  }

  /** Longest project file named at the start of `rest` (text right after an opening parenthesis). */
  matchKnown(rest: string): KnownMatch | null {
    if (this.files.size === 0) return null
    const q = rest.charCodeAt(0) === 34 /* " */ ? 1 : 0
    for (const prefix of this.prefixes) {
      if (!rest.startsWith(prefix, q)) continue
      const at = q + prefix.length
      const bucket = this.buckets.get(rest.slice(at, at + 2))
      if (!bucket) continue
      for (const f of bucket) {
        if (!rest.startsWith(f, at)) continue
        const end = at + f.length
        if (q) {
          if (rest.charCodeAt(end) === 34) return { path: f, consumed: end + 1 }
          continue
        }
        if (AFTER_NAME.test(rest.slice(end, end + 1))) return { path: f, consumed: end }
      }
    }
    return null
  }
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 1-based line number of a character offset. */
export function lineAt(text: string, offset: number): number {
  let n = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) n++
  return n
}

/** Replace LaTeX comments by spaces (keeps offsets and line numbers stable). */
export function blankComments(text: string): string {
  return text.replace(/(^|[^\\])((?:\\\\)*)%.*$/gm, (m, a: string, b: string) => a + b + ' '.repeat(m.length - a.length - b.length))
}

export type SourceGetter = (path: string) => string | null | undefined

/** Memoises a SourceGetter (raw text and comment-blanked text per path). */
export class SourceCache {
  private readonly raw = new Map<string, string | null>()
  private readonly blanked = new Map<string, string | null>()
  private readonly getSource: SourceGetter | undefined

  constructor(getSource?: SourceGetter) {
    this.getSource = getSource
  }

  get available(): boolean {
    return !!this.getSource
  }

  text(path: string): string | null {
    if (!this.getSource) return null
    if (this.raw.has(path)) return this.raw.get(path)!
    let t: string | null | undefined
    try {
      t = this.getSource(path)
    } catch {
      t = null
    }
    const v = typeof t === 'string' ? t : null
    this.raw.set(path, v)
    return v
  }

  withoutComments(path: string): string | null {
    if (this.blanked.has(path)) return this.blanked.get(path)!
    const t = this.text(path)
    const v = t === null ? null : blankComments(t)
    this.blanked.set(path, v)
    return v
  }
}

/** Find the first match of `re` (global flag not required) in the given files; returns file + 1-based line. */
export function findInSources(
  files: readonly string[],
  sources: SourceCache,
  re: RegExp,
  stripComments = true,
): { file: string; line: number } | null {
  if (!sources.available) return null
  for (const f of files) {
    const hay = stripComments ? sources.withoutComments(f) : sources.text(f)
    if (!hay) continue
    re.lastIndex = 0
    const m = re.exec(hay)
    if (m) return { file: f, line: lineAt(hay, m.index) }
  }
  return null
}
