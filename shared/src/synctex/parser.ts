/**
 * SyncTeX (.synctex) parser with compact struct-of-arrays storage.
 *
 * Semantics follow jlaurens/synctex synctex_parser.c (unit/magnification/offset formulas,
 * visible hbox extents, boundary pseudo-leaves) as documented and validated against the
 * synctex CLI in docs/research/pdf-synctex.md. Browser-safe: gzip must be undone by the
 * caller (the server gunzips with node:zlib; the web could use DecompressionStream).
 *
 * Record syntax (synctex(5)): `<type><tag>,<line>[,<col>]:<h>,<v>[:<W>[,<H>,<D>]]`
 * with type one of `[ ( h v x k g $ r`, `]` / `)` closing boxes, `{N` / `}N` sheets.
 *
 * Link fix-ups done by the C parser (and therefore by `synctex edit`), reproduced here:
 *   - the leading `x` records of an hbox (before its first other child) carry the line where
 *     the paragraph ENDED (pdfTeX/LuaTeX write them at \par time); they take the tag/line/column
 *     of the next non-`x` child of the box (C: x_handle / _synctex_handle_set_tlc);
 *   - an hbox whose content ends with a kern followed by glue: that kern and the last glue take
 *     the link of the node before the kern;
 *   - the boundary at an hbox's left edge takes the link of the box's first child (C: the line
 *     only; we also take the tag, see closeBox).
 * The last two change what inverse search reports; the forward index keeps the records' own
 * links, as in C.
 */

/** 1 bp = 65536 × 72.27 / 72 sp */
export const SP_PER_BP = 65781.76

/** Node type codes stored in SynctexIndex.type */
export const NodeType = {
  Page: 0,
  VBox: 1,
  HBox: 2,
  VoidVBox: 3,
  VoidHBox: 4,
  Current: 5,
  Kern: 6,
  Glue: 7,
  Math: 8,
  Rule: 9,
  /** pseudo-leaf added at hbox boundaries (like the C parser) */
  Boundary: 10,
} as const
export type NodeType = (typeof NodeType)[keyof typeof NodeType]

export interface SynctexIndex {
  version: number
  /** 'pdf' | 'xdv' | 'dvi' */
  output: string
  magnification: number
  unit: number
  /** bp per synctex unit (includes magnification) */
  unitBp: number
  /** page offsets in bp (XeTeX writes 1in) */
  xOffBp: number
  yOffBp: number
  /** tag → Input path as recorded (e.g. '/compile/./main.tex') */
  inputs: Map<number, string>
  /** number of nodes */
  count: number
  type: Uint8Array
  tag: Int32Array
  line: Int32Array
  col: Int32Array
  h: Int32Array
  v: Int32Array
  W: Int32Array
  H: Int32Array
  D: Int32Array
  parent: Int32Array
  /** one past the last descendant (i + 1 for leaves) */
  end: Int32Array
  /** visible extents: hboxes grow to contain their content (else equal to the declared box) */
  vh: Int32Array
  vW: Int32Array
  vH: Int32Array
  vD: Int32Array
  /** page number → index of the page's root node */
  pages: Map<number, number>
  /** index of a page root node → page number */
  rootPage: Map<number, number>
  /** tag → line → node indices (document order) */
  friends: Map<number, Map<number, Int32Array>>
  /** tag → largest line with records */
  maxLine: Map<number, number>
}

const INT_MAX = 2147483647

const PREAMBLE = 0
const CONTENT = 1
const POSTAMBLE = 2
const POST_SCRIPTUM = 3

function typeOf(c: number): NodeType | -1 {
  switch (c) {
    case 91: return NodeType.VBox // [
    case 40: return NodeType.HBox // (
    case 118: return NodeType.VoidVBox // v
    case 104: return NodeType.VoidHBox // h
    case 120: return NodeType.Current // x
    case 107: return NodeType.Kern // k
    case 103: return NodeType.Glue // g
    case 36: return NodeType.Math // $
    case 114: return NodeType.Rule // r
    default: return -1
  }
}

/** Parse a TeX dimension ('72.27pt', '1in', '12345sp'…) to sp; unitless numbers are pt. */
function dimensionToSp(s: string): number | null {
  const m = /^\s*(-?\d*\.?\d+)\s*(pt|in|cm|mm|bp|sp|pc|dd|cc|nd|nc|px)?\s*$/.exec(s)
  if (!m) return null
  const x = Number(m[1])
  const pt: Record<string, number> = {
    pt: 1, in: 72.27, cm: 72.27 / 2.54, mm: 72.27 / 25.4, bp: 72.27 / 72, pc: 12,
    dd: 1238 / 1157, cc: 12 * 1238 / 1157, nd: 685 / 642, nc: 12 * 685 / 642, px: 72.27 / 72,
  }
  if (m[2] === 'sp') return x
  return x * (pt[m[2] ?? 'pt'] ?? 1) * 65536
}

/** Input paths are bytes; when the text was decoded as latin1, re-decode them as UTF-8. */
function fixPathEncoding(p: string): string {
  let high = false
  for (let i = 0; i < p.length; i++) {
    const c = p.charCodeAt(i)
    if (c > 0xff) return p
    if (c > 0x7f) high = true
  }
  if (!high) return p
  const bytes = new Uint8Array(p.length)
  for (let i = 0; i < p.length; i++) bytes[i] = p.charCodeAt(i)
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return p
  }
}

class NodeStore {
  cap: number
  n = 0
  type: Uint8Array
  tag: Int32Array
  line: Int32Array
  col: Int32Array
  h: Int32Array
  v: Int32Array
  W: Int32Array
  H: Int32Array
  D: Int32Array
  parent: Int32Array
  end: Int32Array
  vh: Int32Array
  vW: Int32Array
  vH: Int32Array
  vD: Int32Array
  /** registered in the friend (tag/line) index */
  reg: Uint8Array

  constructor(cap: number) {
    this.cap = Math.max(16, cap)
    this.type = new Uint8Array(this.cap)
    this.tag = new Int32Array(this.cap)
    this.line = new Int32Array(this.cap)
    this.col = new Int32Array(this.cap)
    this.h = new Int32Array(this.cap)
    this.v = new Int32Array(this.cap)
    this.W = new Int32Array(this.cap)
    this.H = new Int32Array(this.cap)
    this.D = new Int32Array(this.cap)
    this.parent = new Int32Array(this.cap)
    this.end = new Int32Array(this.cap)
    this.vh = new Int32Array(this.cap)
    this.vW = new Int32Array(this.cap)
    this.vH = new Int32Array(this.cap)
    this.vD = new Int32Array(this.cap)
    this.reg = new Uint8Array(this.cap)
  }

  private grow(): void {
    const cap = this.cap * 2
    const g8 = (a: Uint8Array) => { const b = new Uint8Array(cap); b.set(a); return b }
    const g32 = (a: Int32Array) => { const b = new Int32Array(cap); b.set(a); return b }
    this.type = g8(this.type)
    this.reg = g8(this.reg)
    this.tag = g32(this.tag)
    this.line = g32(this.line)
    this.col = g32(this.col)
    this.h = g32(this.h)
    this.v = g32(this.v)
    this.W = g32(this.W)
    this.H = g32(this.H)
    this.D = g32(this.D)
    this.parent = g32(this.parent)
    this.end = g32(this.end)
    this.vh = g32(this.vh)
    this.vW = g32(this.vW)
    this.vH = g32(this.vH)
    this.vD = g32(this.vD)
    this.cap = cap
  }

  add(t: NodeType, tag: number, line: number, col: number, h: number, v: number, W: number, H: number, D: number, parent: number, reg: boolean): number {
    if (this.n === this.cap) this.grow()
    const i = this.n++
    this.type[i] = t
    this.tag[i] = tag
    this.line[i] = line
    this.col[i] = col
    this.h[i] = h
    this.v[i] = v
    this.W[i] = W
    this.H[i] = H
    this.D[i] = D
    this.parent[i] = parent
    this.end[i] = i + 1
    this.vh[i] = h
    this.vW[i] = W
    this.vH[i] = H
    this.vD[i] = D
    this.reg[i] = reg ? 1 : 0
    return i
  }

  /** make hbox `b` contain the point (h, v) (C: _synctex_make_hbox_contain_point) */
  containPoint(b: number, h: number, v: number): void {
    const min = this.vh[b]
    const max = min + this.vW[b]
    if (h < min) {
      this.vW[b] = max - h
      this.vh[b] = h
    } else if (h > max) {
      this.vW[b] = h - min
    }
    const bv = this.v[b]
    if (v < bv - this.vH[b]) this.vH[b] = bv - v
    else if (v > bv + this.vD[b]) this.vD[b] = v - bv
  }

  containBox(b: number, h0: number, v0: number, h1: number, v1: number): void {
    this.containPoint(b, h0, v0)
    this.containPoint(b, h1, v1)
  }
}

/** Parse the (already gunzipped) text of a .synctex file. */
export function parseSynctexText(text: string): SynctexIndex {
  let lineCount = 1
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lineCount++
  const S = new NodeStore(lineCount + (lineCount >> 2))

  const inputs = new Map<number, string>()
  const pages = new Map<number, number>()
  let version = 1
  let output = 'pdf'
  let mag = 1000
  let unit = 1
  let xOff = 0
  let yOff = 0
  let postMag: number | null = null
  let postXsp: number | null = null
  let postYsp: number | null = null
  let section = PREAMBLE

  // open boxes: node index + index of its last child (for the closing boundary)
  const stack: number[] = []
  const lastChild: number[] = []
  // per open box: leading 'x' records waiting for the link of the box's next non-'x' child
  const pendingX: number[][] = []
  // trailing kern / glue of the box being read (C: last_k / last_g)
  let lastK = -1
  let lastG = -1
  // [node, source]: link copies applied after the friend index is built
  const trailFix: [number, number][] = []
  let page = -1
  let lastV = 0

  /** give the pending leading 'x' records the tag/line/column of `src` */
  const resolvePending = (pend: number[] | undefined, src: number) => {
    if (!pend || pend.length === 0) return
    for (const x of pend) {
      S.tag[x] = S.tag[src]
      S.line[x] = S.line[src]
      S.col[x] = S.col[src]
    }
    pend.length = 0
  }

  // number scanner over `text`
  let p = 0
  let ok = true
  const int = (): number => {
    let c = text.charCodeAt(p)
    let neg = false
    if (c === 45) {
      neg = true
      c = text.charCodeAt(++p)
    }
    let n = 0
    const start = p
    while (c >= 48 && c <= 57) {
      n = n * 10 + (c - 48)
      c = text.charCodeAt(++p)
    }
    if (p === start) {
      ok = false
      return 0
    }
    if (n > INT_MAX) n = INT_MAX
    return neg ? -n : n
  }

  const closeBox = () => {
    const b = stack.pop()!
    const last = lastChild.pop()!
    // leading 'x' records never followed by another child keep their own link
    pendingX.pop()
    S.end[b] = S.n
    if (S.type[b] === NodeType.HBox) {
      // the start boundary (b + 1) points at the box's first child: a click between the left
      // edge and the first word belongs to that word (C copies only the line; copying the tag
      // too keeps a line typeset from an \input file from being attributed to the includer)
      if (b + 2 < S.n) trailFix.push([b + 1, b + 2])
      if (lastK >= 0 && lastG >= 0) {
        // content ends with kern + glue: both take the link of the node before the kern
        let prev = -1
        for (let k = b + 1; k < S.n; k = S.end[k]) {
          if (k === lastK) break
          prev = k
        }
        if (prev >= 0) trailFix.push([lastK, prev], [lastG, prev])
      }
      // boundary pseudo-leaf at the right edge, carrying the last child's link
      const src = last >= 0 && S.type[last] !== NodeType.Boundary ? last : b
      S.add(NodeType.Boundary, S.tag[src], S.line[src], S.col[src], S.vh[b] + S.vW[b], S.v[b], 0, 0, 0, b, src !== b)
      S.end[b] = S.n
      const parent = stack.length ? stack[stack.length - 1] : -1
      if (parent >= 0) {
        lastChild[lastChild.length - 1] = b
        if (S.type[parent] === NodeType.HBox) {
          S.containBox(parent, S.vh[b], S.v[b] - S.vH[b], S.vh[b] + S.vW[b], S.v[b] + S.vD[b])
        }
      }
    }
    // the closed box is the next child of its parent: it resolves the parent's pending 'x' records
    if (S.type[b] !== NodeType.Page) resolvePending(pendingX[pendingX.length - 1], b)
    lastK = lastG = -1
  }

  const closeAll = () => {
    while (stack.length) closeBox()
  }

  let ls = 0
  const len = text.length
  while (ls < len) {
    let le = text.indexOf('\n', ls)
    if (le === -1) le = len
    const c = text.charCodeAt(ls)
    if (le === ls) {
      ls = le + 1
      continue
    }
    if (section === CONTENT) {
      const t = typeOf(c)
      if (t !== -1) {
        if (page >= 0) {
          p = ls + 1
          ok = true
          const tag = int()
          if (text.charCodeAt(p) !== 44) ok = false
          p++
          const line = int()
          let col = -1
          if (text.charCodeAt(p) === 44) {
            p++
            col = int()
          }
          if (text.charCodeAt(p) !== 58) ok = false
          p++
          const h = int()
          if (text.charCodeAt(p) !== 44) ok = false
          p++
          let v: number
          if (text.charCodeAt(p) === 61) {
            v = lastV
            p++
          } else {
            v = int()
            lastV = v
          }
          let W = 0
          let H = 0
          let D = 0
          if (p < le && text.charCodeAt(p) === 58) {
            p++
            W = int()
            if (p < le && text.charCodeAt(p) === 44) {
              p++
              H = int()
              if (text.charCodeAt(p) === 44) {
                p++
                D = int()
              }
            }
          }
          if (ok) {
            const parent = stack[stack.length - 1]
            const prev = lastChild[lastChild.length - 1]
            const i = S.add(t, tag, line, col, h, v, W, H, D, parent, true)
            lastChild[lastChild.length - 1] = i
            const parentIsHbox = S.type[parent] === NodeType.HBox
            const pend = pendingX[pendingX.length - 1]
            if (t === NodeType.Current) {
              // right after the hbox's start (or after other leading 'x'): link decided by the next child
              if (pend && (pend.length > 0 || (parentIsHbox && prev >= 0 && S.type[prev] === NodeType.Boundary))) pend.push(i)
              lastK = lastG = -1
            } else if (t !== NodeType.HBox && t !== NodeType.VBox) {
              resolvePending(pend, i)
              if (t === NodeType.Kern) {
                lastK = i
                lastG = -1
              } else if (t === NodeType.Glue && lastK >= 0) {
                lastG = i
              } else {
                lastK = lastG = -1
              }
            }
            if (t === NodeType.HBox || t === NodeType.VBox) {
              stack.push(i)
              lastChild.push(-1)
              pendingX.push([])
              lastK = lastG = -1
              if (t === NodeType.HBox) {
                const b0 = S.add(NodeType.Boundary, tag, line, col, h, v, 0, 0, 0, i, true)
                lastChild[lastChild.length - 1] = b0
              }
            } else if (parentIsHbox) {
              if (t === NodeType.Current || t === NodeType.Glue || t === NodeType.Math) {
                S.containPoint(parent, h, v)
              } else if (t === NodeType.Kern) {
                // a kern's position is recorded after the move: it spans [h - W, h]
                if (W < 0) S.containBox(parent, h, v, h - W, v)
                else S.containBox(parent, h - W, v, h, v)
              } else if (t === NodeType.VoidHBox) {
                S.containBox(parent, h, v - H, h + W, v + D)
              }
            }
          }
        }
      } else if (c === 93 || c === 41) { // ] )
        if (page >= 0 && stack.length > 1) closeBox()
      } else if (c === 123) { // {
        closeAll()
        p = ls + 1
        ok = true
        const n = int()
        if (ok) {
          page = n
          const root = S.add(NodeType.Page, 0, 0, -1, 0, 0, 0, 0, 0, -1, false)
          pages.set(n, root)
          stack.push(root)
          lastChild.push(-1)
          pendingX.push([])
        }
      } else if (c === 125) { // }
        closeAll()
        page = -1
      } else if (c === 73 && text.startsWith('Input:', ls)) {
        const j = text.indexOf(':', ls + 6)
        if (j !== -1 && j < le) inputs.set(Number(text.slice(ls + 6, j)), fixPathEncoding(text.slice(j + 1, le).replace(/\r$/, '')))
      } else if (c === 80 && text.startsWith('Postamble:', ls)) {
        closeAll()
        page = -1
        section = POSTAMBLE
      }
      // '!' byte offsets, forms ('<', '>', 'f') and anything unknown are ignored
      ls = le + 1
      continue
    }

    const L = text.slice(ls, le).replace(/\r$/, '')
    if (L.startsWith('Input:')) {
      const j = L.indexOf(':', 6)
      if (j !== -1) inputs.set(Number(L.slice(6, j)), fixPathEncoding(L.slice(j + 1)))
    } else if (section === PREAMBLE) {
      if (L.startsWith('SyncTeX Version:')) version = Number(L.slice(16)) || 1
      else if (L.startsWith('Output:')) output = L.slice(7)
      else if (L.startsWith('Magnification:')) mag = Number(L.slice(14))
      else if (L.startsWith('Unit:')) unit = Number(L.slice(5))
      else if (L.startsWith('X Offset:')) xOff = Number(L.slice(9))
      else if (L.startsWith('Y Offset:')) yOff = Number(L.slice(9))
      else if (L.startsWith('Content:')) section = CONTENT
    } else if (section === POSTAMBLE) {
      if (L.startsWith('Post scriptum:')) section = POST_SCRIPTUM
    } else if (section === POST_SCRIPTUM) {
      if (L.startsWith('Magnification:')) {
        const x = Number(L.slice(14))
        if (Number.isFinite(x) && x > 0) postMag = x
      } else if (L.startsWith('X Offset:')) postXsp = dimensionToSp(L.slice(9))
      else if (L.startsWith('Y Offset:')) postYsp = dimensionToSp(L.slice(9))
    }
    ls = le + 1
  }
  closeAll()

  // unit / offsets per synctex_parser.c synctex_scanner_parse()
  const preUnit = Number.isFinite(unit) && unit > 0 ? unit : 8192
  const preMag = Number.isFinite(mag) && mag > 0 ? mag : 1000
  const unitBp = (postMag ?? 1) * preUnit / SP_PER_BP * preMag / 1000
  const xOffBp = postXsp !== null ? postXsp / SP_PER_BP : (Number.isFinite(xOff) ? xOff : 0) * preUnit / SP_PER_BP
  const yOffBp = postYsp !== null ? postYsp / SP_PER_BP : (Number.isFinite(yOff) ? yOff : 0) * preUnit / SP_PER_BP

  // friend index: tag → line → nodes (two passes, document order)
  const counts = new Map<number, Map<number, number>>()
  for (let i = 0; i < S.n; i++) {
    if (!S.reg[i]) continue
    const tg = S.tag[i]
    let m = counts.get(tg)
    if (!m) counts.set(tg, (m = new Map()))
    const ln = S.line[i]
    m.set(ln, (m.get(ln) ?? 0) + 1)
  }
  let total = 0
  for (const m of counts.values()) for (const k of m.values()) total += k
  const pool = new Int32Array(total)
  const friends = new Map<number, Map<number, Int32Array>>()
  const fill = new Map<number, Map<number, number>>()
  const maxLine = new Map<number, number>()
  let off = 0
  for (const [tg, m] of counts) {
    const fm = new Map<number, Int32Array>()
    const cur = new Map<number, number>()
    let max = -Infinity
    for (const [ln, k] of m) {
      fm.set(ln, pool.subarray(off, off + k))
      cur.set(ln, 0)
      off += k
      if (ln > max) max = ln
    }
    friends.set(tg, fm)
    fill.set(tg, cur)
    maxLine.set(tg, max)
  }
  for (let i = 0; i < S.n; i++) {
    if (!S.reg[i]) continue
    const tg = S.tag[i]
    const ln = S.line[i]
    const cur = fill.get(tg)!
    const k = cur.get(ln)!
    friends.get(tg)!.get(ln)![k] = i
    cur.set(ln, k + 1)
  }

  // trailing kern/glue links (after the friend index: forward search keeps their own line)
  for (const [node, src] of trailFix) {
    S.tag[node] = S.tag[src]
    S.line[node] = S.line[src]
    S.col[node] = S.col[src]
  }

  const n = S.n
  return {
    version, output, magnification: preMag, unit: preUnit, unitBp, xOffBp, yOffBp, inputs, count: n,
    type: S.type.slice(0, n), tag: S.tag.slice(0, n), line: S.line.slice(0, n), col: S.col.slice(0, n),
    h: S.h.slice(0, n), v: S.v.slice(0, n), W: S.W.slice(0, n), H: S.H.slice(0, n), D: S.D.slice(0, n),
    parent: S.parent.slice(0, n), end: S.end.slice(0, n),
    vh: S.vh.slice(0, n), vW: S.vW.slice(0, n), vH: S.vH.slice(0, n), vD: S.vD.slice(0, n),
    pages, rootPage: new Map([...pages].map(([pg, root]) => [root, pg])), friends, maxLine,
  }
}

export interface ParseSynctexOptions {
  /** decompress gzip bytes (e.g. node:zlib gunzipSync with maxOutputLength); required for .synctex.gz input */
  gunzip?: (gz: Uint8Array) => Uint8Array
}

/** Parse .synctex bytes (plain, or gzip when `gunzip` is supplied) or text. */
export function parseSynctex(data: Uint8Array | string, opts: ParseSynctexOptions = {}): SynctexIndex {
  if (typeof data === 'string') return parseSynctexText(data)
  let bytes = data
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (!opts.gunzip) throw new Error('gzip-compressed SyncTeX data needs a gunzip function')
    bytes = opts.gunzip(bytes)
  }
  return parseSynctexText(new TextDecoder('utf-8').decode(bytes))
}
