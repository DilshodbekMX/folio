/**
 * Text vs binary classification. Classify by extension first (never by libmagic —
 * e.g. MDPI's mdpi.cls contains a stray 0x1C byte), then sniff unknown extensions.
 *
 * Size limit: a text document is limited to MAX_DOC_LENGTH UTF-16 code units — the unit the
 * editor and the collaboration rooms count in. A byte limit alone would turn an editable
 * document in Greek, Cyrillic or CJK (2–3 UTF-8 bytes per character) into a "binary" file on
 * restore, copy or re-import.
 */
import { extname } from './paths.ts'
import { MAX_DOC_LENGTH } from './protocol.ts'

/** Extensions that are always edited as collaborative text documents. */
export const TEXT_EXTENSIONS = new Set([
  'tex', 'latex', 'ltx', 'sty', 'cls', 'bst', 'bib', 'bibtex', 'bbx', 'cbx', 'lbx', 'dbx',
  'txt', 'md', 'markdown', 'tikz', 'pgf', 'mtx', 'rtex', 'asy', 'dtx', 'ins', 'ist', 'def',
  'clo', 'ldf', 'fd', 'cfg', 'rmd', 'qmd', 'rnw', 'lua', 'py', 'r', 'gv', 'dot', 'mf', 'yml',
  'yaml', 'json', 'csv', 'tsv', 'dat', 'xmpdata', 'inc', 'lco', 'm', 'sh', 'mk', 'makefile',
  'latexmkrc', 'glo', 'nlo', 'hs', 'lhs', 'toml', 'ini', 'xml', 'html', 'css', 'js', 'ts',
])

/** Extensions that are always binary regardless of content. */
export const BINARY_EXTENSIONS = new Set([
  'pdf', 'png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'eps', 'ps', 'svg',
  'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'tar', 'otf', 'ttf', 'woff', 'woff2', 'pfb', 'afm',
  'tfm', 'vf', 'mp3', 'mp4', 'mov', 'avi', 'wav', 'ico', 'xlsx', 'xls', 'docx', 'doc', 'pptx',
  'odt', 'ods', 'jar', 'class', 'exe', 'dll', 'so', 'o', 'bin', 'dvi', 'xdv',
])

/** Maximum length of a text document in UTF-16 code units (the collaborative document limit). */
export const MAX_TEXT_LENGTH = MAX_DOC_LENGTH

/**
 * Coarse size bound of a text document on disk: one UTF-16 code unit takes at most 3 UTF-8
 * bytes, so larger files can never be text. Between MAX_TEXT_LENGTH and this bound the decoded
 * length decides (textLengthFits).
 */
export const MAX_TEXT_FILE_BYTES = 3 * MAX_TEXT_LENGTH

export type Classified = 'text' | 'binary'

/** Classification from the path alone; 'unknown' means the content must be sniffed. */
export function classifyByName(path: string): Classified | 'unknown' {
  const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase()
  if (name === 'latexmkrc' || name === '.latexmkrc' || name === 'makefile' || name === 'readme') return 'text'
  const ext = extname(path)
  if (ext && TEXT_EXTENSIONS.has(ext)) return 'text'
  if (ext && BINARY_EXTENSIONS.has(ext)) return 'binary'
  return 'unknown'
}

/** Returns true when bytes are valid UTF-8 without NUL bytes. */
export function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** The text of UTF-8 bytes without NUL, or null when they are not text. */
export function decodeUtf8Text(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}

/** Does this text fit in a collaborative document (normalised length ≤ MAX_TEXT_LENGTH)? */
export function textLengthFits(text: string): boolean {
  // normalising only shortens: skip it when the raw length already fits
  return text.length <= MAX_TEXT_LENGTH || normalizeText(text).length <= MAX_TEXT_LENGTH
}

/**
 * Full classification. Text-by-extension files that are not valid UTF-8 (e.g. latin1 .tex)
 * or longer than MAX_TEXT_LENGTH characters (UTF-16 code units, after normalisation) are
 * classified 'binary' (read-only, downloadable).
 */
export function classifyFile(path: string, bytes: Uint8Array): Classified {
  if (bytes.byteLength > MAX_TEXT_FILE_BYTES) return 'binary'
  const byName = classifyByName(path)
  if (byName === 'binary') return 'binary'
  // a UTF-16 code unit takes at least one byte: short files cannot exceed the length limit
  if (bytes.byteLength <= MAX_TEXT_LENGTH) return looksLikeUtf8Text(bytes) ? 'text' : 'binary'
  const text = decodeUtf8Text(bytes)
  return text !== null && textLengthFits(text) ? 'text' : 'binary'
}

/** Normalise text entering the system: strip BOM, CRLF/CR → LF. (CRLF inside Y.Text desynchronises CodeMirror.) */
export function normalizeText(s: string): string {
  return (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s).replace(/\r\n?/g, '\n')
}

const MIME: Record<string, string> = {
  pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff',
  eps: 'application/postscript', ps: 'application/postscript', zip: 'application/zip',
}

/** Image formats the browser can display directly in <img>. */
export function isBrowserImage(path: string): boolean {
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(extname(path))
}

export function mimeFor(path: string): string {
  return MIME[extname(path)] ?? 'application/octet-stream'
}
