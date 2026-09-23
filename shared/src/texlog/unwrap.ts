/**
 * Undo TeX's hard wrapping of log lines (max_print_line, 79 by default).
 *
 * Folio's own compiles set max_print_line=10000 so their logs are not wrapped; this module
 * exists for foreign/uploaded logs and older builds. The wrap width is counted differently
 * per engine (measured on TeX Live 2026, see docs/research/logparse.md):
 *   - pdfTeX counts bytes and may split a UTF-8 sequence across lines → join bytes, then decode;
 *   - XeTeX counts Unicode code points;
 *   - LuaTeX wraps at 79 or 80 bytes and wraps early instead of splitting a multi-byte char.
 * Browser-safe: only TextEncoder/TextDecoder.
 */

export type TexEngine = 'pdftex' | 'xetex' | 'luatex' | 'unknown'

export interface UnwrappedLog {
  engine: TexEngine
  /** logical lines */
  lines: string[]
  /** 1-based physical line number of the first physical line of each logical line */
  lineNo: number[]
  /** wrap width that was undone; Infinity when the log was not considered wrapped */
  maxPrintLine: number
}

export interface UnwrapOptions {
  engine?: TexEngine
  /** Wrap width. Default: auto-detect (79 when the log looks wrapped, else Infinity = no joining). */
  maxPrintLine?: number
}

const DEFAULT_WRAP = 79

/**
 * A physical line that starts one of these is a new message even when the previous line is
 * exactly max_print_line long (TeX's print_nl after a full line produces no blank line).
 */
const NO_JOIN_NEXT = /^(?:! |l\.\d+ |Missing character: |File: |Package: |Document Class: |(?:LaTeX|LaTeX Font|LaTeX3|Package \S+|Class \S+|Module \S+) (?:Info|Warning|Error): |(?:Over|Under)full \\[hv]box |\*\*\* )/

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

export function detectEngine(firstLine: string): TexEngine {
  if (/^This is XeTeX\b/.test(firstLine)) return 'xetex'
  if (/^This is Lua(?:HB|MetaHB|Meta)?TeX\b/.test(firstLine)) return 'luatex'
  if (/^This is (?:pdfTeX|e-TeX|TeX|ε-pTeX|e-pTeX|e-upTeX|pTeX|upTeX|eptex|euptex)\b/i.test(firstLine)) return 'pdftex'
  return 'unknown'
}

function splitPhysical(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let start = 0
  for (;;) {
    const nl = bytes.indexOf(0x0a, start)
    if (nl === -1) break
    let end = nl
    if (end > start && bytes[end - 1] === 0x0d) end--
    out.push(bytes.subarray(start, end))
    start = nl + 1
  }
  if (start < bytes.length) {
    let end = bytes.length
    if (end > start && bytes[end - 1] === 0x0d) end--
    out.push(bytes.subarray(start, end))
  }
  return out
}

function codePointLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    // count every unit except the low half of a surrogate pair
    if (c < 0xdc00 || c > 0xdfff || i === 0 || (s.charCodeAt(i - 1) & 0xfc00) !== 0xd800) n++
  }
  return n
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0]
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

function endsWithEllipsis(b: Uint8Array): boolean {
  const n = b.length
  return n >= 3 && b[n - 1] === 0x2e && b[n - 2] === 0x2e && b[n - 3] === 0x2e
}

/** Length of a physical line in the unit the engine wraps by. */
function wrapLength(b: Uint8Array, engine: TexEngine): number {
  return engine === 'xetex' ? codePointLength(decoder.decode(b)) : b.length
}

function detectWrap(phys: Uint8Array[], engine: TexEngine): number {
  const limit = engine === 'luatex' ? DEFAULT_WRAP + 2 : DEFAULT_WRAP + 1
  let long = 0
  // line 1 (the banner) and the memory statistics line are never wrapped
  for (let i = 1; i < phys.length; i++) {
    const b = phys[i]
    if (b.length <= limit) continue
    if (wrapLength(b, engine) <= limit) continue
    if (decoder.decode(b.subarray(0, 120)).includes('stack positions out of')) continue
    if (++long >= 3) return Infinity
  }
  return DEFAULT_WRAP
}

function isWrapped(prev: Uint8Array, next: Uint8Array, engine: TexEngine, mpl: number): boolean {
  if (endsWithEllipsis(prev)) return false
  const bytes = prev.length
  switch (engine) {
    case 'xetex':
      return bytes >= mpl && codePointLength(decoder.decode(prev)) === mpl
    case 'luatex':
      if (bytes === mpl || bytes === mpl + 1) return true
      return bytes >= mpl - 3 && bytes < mpl && next.length > 0 && next[0] >= 0xc0
    default:
      return bytes === mpl
  }
}

/** Split a log into logical lines, joining physical lines TeX wrapped at max_print_line. */
export function unwrapLines(input: string | Uint8Array, opts: UnwrapOptions = {}): UnwrappedLog {
  const bytes = typeof input === 'string' ? encoder.encode(input) : input
  const phys = splitPhysical(bytes)
  const engine = opts.engine ?? detectEngine(phys.length ? decoder.decode(phys[0].subarray(0, 200)) : '')
  const mpl = opts.maxPrintLine ?? detectWrap(phys, engine)
  const lines: string[] = []
  const lineNo: number[] = []
  if (!Number.isFinite(mpl)) {
    for (let i = 0; i < phys.length; i++) {
      lines.push(decoder.decode(phys[i]))
      lineNo.push(i + 1)
    }
    return { engine, lines, lineNo, maxPrintLine: Infinity }
  }
  let acc: Uint8Array[] = []
  let accStart = 1
  const flush = () => {
    if (acc.length) {
      lines.push(decoder.decode(concat(acc)))
      lineNo.push(accStart)
    }
    acc = []
  }
  for (let i = 0; i < phys.length; i++) {
    const cur = phys[i]
    if (acc.length > 0 && isWrapped(phys[i - 1], cur, engine, mpl) && !NO_JOIN_NEXT.test(decoder.decode(cur.subarray(0, 64)))) {
      acc.push(cur)
      continue
    }
    flush()
    acc = [cur]
    accStart = i + 1
  }
  flush()
  return { engine, lines, lineNo, maxPrintLine: mpl }
}

/**
 * Return the log text with wrapped lines joined ('\n'-separated logical lines).
 * Pass the raw bytes when available: pdfTeX can split a UTF-8 character across a wrap.
 */
export function unwrapLog(input: string | Uint8Array, engine?: TexEngine, maxPrintLine?: number): string {
  return unwrapLines(input, { engine, maxPrintLine }).lines.join('\n')
}
