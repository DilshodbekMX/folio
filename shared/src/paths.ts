/**
 * Project path rules shared by server and web.
 *
 * A project path is POSIX, relative, NFC-normalised, with no leading/trailing slash,
 * no empty, '.' or '..' segments. Segment names follow Overleaf's SafePath behaviour
 * (reimplemented, not copied): no '/', '\\', '*', control characters (C0, C1, DEL),
 * lone surrogates, leading/trailing whitespace, or JS prototype property names.
 * Names starting with '.git' or '.folio' are reserved (history/internal metadata).
 */

export const MAX_PATH_LENGTH = 1024
export const MAX_SEGMENT_LENGTH = 150

const BANNED_NAMES = new Set([
  '__proto__', 'constructor', 'prototype', 'hasOwnProperty', 'isPrototypeOf',
  'propertyIsEnumerable', 'toLocaleString', 'toString', 'valueOf',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
])

// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\/\\*\u0000-\u001F\u007F-\u009F]/
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/

/** Returns an error message, or null when `name` is a valid single path segment. */
export function validateName(name: string): string | null {
  if (name.length === 0) return 'Name must not be empty'
  if (name.length > MAX_SEGMENT_LENGTH) return `Name must be at most ${MAX_SEGMENT_LENGTH} characters`
  if (name === '.' || name === '..') return 'Invalid name'
  if (name !== name.trim()) return 'Name must not start or end with whitespace'
  if (BAD_CHARS.test(name)) return 'Name contains a forbidden character (/ \\ * or a control character)'
  if (LONE_SURROGATE.test(name)) return 'Name contains invalid Unicode'
  if (BANNED_NAMES.has(name)) return 'This name is reserved'
  const lower = name.toLowerCase()
  if (lower.startsWith('.git') || lower.startsWith('.folio')) return 'Names starting with .git or .folio are reserved'
  return null
}

/** Normalise a user-supplied path (NFC, backslashes → '/', collapse slashes, trim leading/trailing '/'). Does not validate. */
export function normalizePath(input: string): string {
  return input
    .normalize('NFC')
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/+|\/+$/g, '')
}

/** Returns an error message, or null when `path` (already normalised) is a valid project path. */
export function validatePath(path: string): string | null {
  if (path.length === 0) return 'Path must not be empty'
  if (path.length > MAX_PATH_LENGTH) return `Path must be at most ${MAX_PATH_LENGTH} characters`
  if (path !== normalizePath(path)) return 'Path is not normalised'
  for (const seg of path.split('/')) {
    const err = validateName(seg)
    if (err) return `${err}: "${seg}"`
  }
  return null
}

/** Normalise then validate; throws Error(message) when invalid. */
export function safePath(input: string): string {
  const p = normalizePath(input)
  const err = validatePath(p)
  if (err) throw new Error(err)
  return p
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.slice(i + 1)
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? '' : path.slice(0, i)
}

export function extname(path: string): string {
  const b = basename(path)
  const i = b.lastIndexOf('.')
  return i <= 0 ? '' : b.slice(i + 1).toLowerCase()
}

export function joinPath(...parts: string[]): string {
  return normalizePath(parts.filter(p => p.length > 0).join('/'))
}

/** true when `path` equals `folder` or lies inside it */
export function isWithin(path: string, folder: string): boolean {
  return folder === '' || path === folder || path.startsWith(folder + '/')
}

/** Compare paths for display: folders first is handled by callers; this is a natural, case-insensitive sort. */
export function comparePaths(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })
}

/**
 * A free path next to `path` for a copy of it: `dir/b.tex` → `dir/b (recovered).tex`, then
 * `dir/b (recovered 2).tex`, … (`label` replaces "recovered"). `taken(p)` says whether a path is
 * in use. The name keeps within MAX_SEGMENT_LENGTH by shortening the stem.
 */
export function siblingCopyPath(path: string, taken: (p: string) => boolean, label = 'recovered'): string {
  const dir = dirname(path)
  const name = basename(path)
  const dot = name.lastIndexOf('.')
  const stem = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : ''
  for (let n = 1; ; n++) {
    const suffix = n === 1 ? ` (${label})` : ` (${label} ${n})`
    const room = Math.max(1, MAX_SEGMENT_LENGTH - suffix.length - ext.length)
    const candidate = joinPath(dir, `${stem.slice(0, room).trimEnd() || 'file'}${suffix}${ext}`)
    if (!taken(candidate)) return candidate
  }
}
