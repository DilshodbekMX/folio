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
 * classified 'binary' (read-only, downloadable). Files entering Folio go through
 * decodeIncomingText instead, which converts other encodings to UTF-8.
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

/** A text file entering Folio: its normalised text and the encoding it was converted from. */
export interface IncomingText {
  text: string
  /** WHATWG encoding name: 'utf-8' when the file was UTF-8 already */
  encoding: string
}

/**
 * Decode a file entering Folio (upload, replace, import); null when it is binary. Like
 * classifyFile, except that a text-by-extension file in another encoding (a Windows "ANSI" code
 * page, Latin-1, UTF-16 from Notepad) is converted instead of becoming read-only. Its encoding
 * is, in order: a UTF-16 byte-order mark, the file's own declaration (declaredEncoding), the
 * project's (`hint`), else Windows-1251 when the bytes read as Cyrillic and Windows-1252
 * otherwise. A sniffed file that is not UTF-8 stays binary, and so do formats that name their
 * own encoding (KEEPS_OWN_ENCODING). Whoever converts a file also points its encoding
 * declarations at UTF-8 (declareUtf8).
 */
export function decodeIncomingText(path: string, bytes: Uint8Array, hint?: string | null): IncomingText | null {
  const byName = classifyByName(path)
  if (byName === 'binary' || bytes.byteLength > MAX_TEXT_FILE_BYTES) return null
  let text = decodeUtf8Text(bytes)
  let encoding = 'utf-8'
  if (text === null) {
    if (byName !== 'text' || KEEPS_OWN_ENCODING.has(extname(path))) return null
    const source = sourceEncoding(bytes, hint)
    if (source === null) return null
    text = decodeAs(source, bytes)
    if (text === null || text.includes('\0')) return null
    encoding = source
  }
  text = normalizeText(text)
  return text.length <= MAX_TEXT_LENGTH ? { text, encoding } : null
}

/** Text formats that declare their own encoding (<meta charset>, <?xml encoding?>, # coding:, @charset): never converted. */
const KEEPS_OWN_ENCODING = new Set(['html', 'xml', 'py', 'css'])

/** inputenc options and editor encoding names that are not WHATWG labels (keys without spaces, '-' or '_'). */
const ENCODING_ALIASES: Record<string, string> = {
  ansinew: 'windows-1252', isolatin: 'windows-1252', isolatin1: 'windows-1252', windowslatin1: 'windows-1252',
  latin9: 'iso-8859-15', isolatin9: 'iso-8859-15', latin10: 'iso-8859-16', isolatin2: 'iso-8859-2',
  isolatin5: 'windows-1254', windowslatin2: 'windows-1250', windowscyrillic: 'windows-1251',
  applemac: 'macintosh', macosroman: 'macintosh', utf8x: 'utf-8', utf8unicode: 'utf-8',
}

/** The WHATWG name of an encoding as LaTeX or an editor writes it ('latin1', 'cp1251', 'UTF-8'); null when unknown or unsupported. */
function canonicalEncoding(name: string): string | null {
  const label = name.trim().toLowerCase()
  try {
    return new TextDecoder(ENCODING_ALIASES[label.replace(/[\s_-]/g, '')] ?? label).encoding
  } catch {
    return null
  }
}

const isLegacyEncoding = (name: string) => {
  const e = canonicalEncoding(name)
  return e !== null && e !== 'utf-8'
}

const MAGIC_ENCODING = /^(%\s*!\s*TEX\s+encoding\s*=\s*)(.*?)\s*$/i
const INPUTENC = /\\(?:usepackage|RequirePackage)\s*\[([^\]]*)\]\s*\{inputenc\}/g
const INPUTENCODING = /\\inputencoding\s*\{([^}]*)\}/g
const BIBENCODING = /\bbibencoding\s*=\s*([\w-]+)/g

/** The part of a line before its comment (a '%' not escaped by a backslash). */
function codeOf(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\') i++
    else if (line[i] === '%') return line.slice(0, i)
  }
  return line
}

/**
 * The encoding a TeX source declares: a `% !TEX encoding = …` line, else the last inputenc option
 * or \inputencoding outside comments. A WHATWG name ('utf-8', 'windows-1252', …), '' for an
 * encoding Folio cannot read (e.g. cp850), null without a declaration. ASCII is all it needs, so
 * a file that is not UTF-8 can be read as Latin-1 to find it.
 */
export function declaredEncoding(source: string): string | null {
  let last: string | null = null
  for (const line of source.split('\n')) {
    const magic = MAGIC_ENCODING.exec(line)
    if (magic) return canonicalEncoding(magic[2]!) ?? ''
    const code = codeOf(line)
    for (const m of code.matchAll(INPUTENC)) last = m[1]!.split(',').map(s => s.trim()).filter(Boolean).at(-1) ?? last
    for (const m of code.matchAll(INPUTENCODING)) last = m[1]!.trim()
  }
  return last === null ? null : canonicalEncoding(last) ?? ''
}

/**
 * Point legacy encoding declarations at UTF-8 once the files they describe are converted:
 * inputenc options (\usepackage, \RequirePackage, \inputencoding), biblatex's bibencoding and
 * `% !TEX encoding`. Otherwise LaTeX would read the converted bytes as Latin-1 and print "Ã©".
 * Commented-out declarations are left alone.
 */
export function declareUtf8(text: string): string {
  return text.split('\n').map(line => {
    const magic = MAGIC_ENCODING.exec(line)
    if (magic) return isLegacyEncoding(magic[2]!) ? `${magic[1]}UTF-8` : line
    const code = codeOf(line)
    const fixed = code
      .replace(INPUTENC, (m, opts: string) => opts.split(',').some(isLegacyEncoding) ? m.replace(`[${opts}]`, '[utf8]') : m)
      .replace(INPUTENCODING, (m, name: string) => isLegacyEncoding(name) ? '\\inputencoding{utf8}' : m)
      .replace(BIBENCODING, (m, name: string) => isLegacyEncoding(name) ? 'bibencoding=utf8' : m)
    return fixed === code ? line : fixed + line.slice(code.length)
  }).join('\n')
}

/** The encoding of a file that is not UTF-8 (see decodeIncomingText); null when Folio cannot read it. */
function sourceEncoding(bytes: Uint8Array, hint?: string | null): string | null {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le'
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be'
  for (const e of [declaredEncoding(decodeAs('windows-1252', bytes) ?? ''), hint]) {
    if (e === '') return null
    // a UTF-8 declaration is evidently wrong for these bytes
    if (e && e !== 'utf-8') return e
  }
  return looksCyrillic(bytes) ? 'windows-1251' : 'windows-1252'
}

/**
 * Windows-1251 or Windows-1252? Both have their letters at 0xC0–0xFF, but Cyrillic text has
 * whole words of them, Western text an accented letter or two between ASCII letters.
 */
function looksCyrillic(bytes: Uint8Array): boolean {
  let letters = 0
  let inWords = 0
  let run = 0
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i]! >= 0xc0) {
      letters++
      run++
      continue
    }
    if (run >= 3) inWords += run
    run = 0
  }
  return inWords * 2 > letters
}

function decodeAs(encoding: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    return null
  }
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
