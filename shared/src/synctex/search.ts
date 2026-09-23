/**
 * Forward (source → PDF) and inverse (PDF → source) SyncTeX queries, modelled on the C
 * implementation (synctex_iterator_new_display / synctex_iterator_new_edit) as described in
 * docs/research/pdf-synctex.md. Coordinates in the SyncTeX file are in sp from the page's
 * top-left; results are converted to PDF points (bp) with a top-left origin.
 *
 * Inverse search follows synctex_iterator_new_edit closely (the answers are checked against
 * `synctex edit` on pdfLaTeX, LuaLaTeX and XeLaTeX builds): the closest leaf uses the C
 * library's distance and tie rule, the left/right candidates are narrowed with its
 * "deepest container v3", and the parser applies the C link fix-ups (see parser.ts).
 */
import type { PdfRect } from '../api.ts'
import { NodeType, type SynctexIndex } from './parser.ts'

/** A box in the synctex CLI's shape: h = left, v = BOTTOM (baseline + depth), H = height + depth (bp). */
export interface SynctexBox {
  page: number
  h: number
  v: number
  W: number
  H: number
  /** the source line whose records were used (may differ from the requested line) */
  line: number
  /** number of matching records inside this box (ranking weight) */
  weight: number
}

export interface InverseResult {
  /** Input path as recorded in the SyncTeX file (e.g. '/compile/./main.tex') */
  input: string
  line: number
  /** -1 when the engine recorded no column (pdfTeX, XeTeX and LuaTeX never do) */
  column: number
}

/** Collapse '//' and '/./' and resolve '..' (POSIX). Keeps a leading '/' and strips a leading './'. */
export function normalizeSynctexPath(p: string): string {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop()
      else if (!abs) out.push('..')
      continue
    }
    out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}

/** Distinct Input paths recorded in the file (tag order). */
export function listInputs(idx: SynctexIndex): string[] {
  const seen = new Set<string>()
  const tags = [...idx.inputs.keys()].sort((a, b) => a - b)
  for (const t of tags) seen.add(idx.inputs.get(t)!)
  return [...seen]
}

/**
 * Tags of the Input(s) matching `inputPath`: an exact (normalised) match wins; otherwise a
 * path ending in '/' + inputPath (e.g. 'main.tex' matches '/compile/./main.tex').
 */
export function findInputTags(idx: SynctexIndex, inputPath: string): number[] {
  const want = normalizeSynctexPath(inputPath)
  const rel = want.replace(/^\/+/, '')
  const exact: number[] = []
  const suffix: number[] = []
  for (const [tag, p] of idx.inputs) {
    const np = normalizeSynctexPath(p)
    if (np === want) exact.push(tag)
    else if (rel && np.endsWith('/' + rel)) suffix.push(tag)
  }
  return exact.length ? exact : suffix
}

const isBox = (t: number) => t === NodeType.HBox || t === NodeType.VBox || t === NodeType.VoidHBox || t === NodeType.VoidVBox

function pageOf(idx: SynctexIndex, node: number): number {
  let n = node
  while (n >= 0 && idx.type[n] !== NodeType.Page) n = idx.parent[n]
  return n < 0 ? 0 : idx.rootPage.get(n) ?? 0
}

/** Box of a node in the CLI's shape (bp). */
export function boxOf(idx: SynctexIndex, b: number): { h: number; v: number; W: number; H: number } {
  const u = idx.unitBp
  if (idx.type[b] === NodeType.HBox) {
    return { h: idx.vh[b] * u + idx.xOffBp, v: (idx.v[b] + idx.vD[b]) * u + idx.yOffBp, W: idx.vW[b] * u, H: (idx.vH[b] + idx.vD[b]) * u }
  }
  return { h: idx.h[b] * u + idx.xOffBp, v: (idx.v[b] + idx.D[b]) * u + idx.yOffBp, W: idx.W[b] * u, H: (idx.H[b] + idx.D[b]) * u }
}

export interface ForwardOptions {
  /** page currently shown in the viewer: results on nearer pages come first */
  pageHint?: number
  /** cap on the number of boxes returned (default 200) */
  maxResults?: number
}

/** Forward search in the CLI's box shape, ranked like `synctex view`. */
export function forwardSearchBoxes(idx: SynctexIndex, inputPath: string, line: number, opts: ForwardOptions = {}): SynctexBox[] {
  const tags = findInputTags(idx, inputPath)
  if (!tags.length || !Number.isFinite(line)) return []
  let maxLine = -Infinity
  for (const t of tags) maxLine = Math.max(maxLine, idx.maxLine.get(t) ?? -Infinity)
  if (!Number.isFinite(maxLine) || maxLine < 1) return []
  const pageHint = opts.pageHint ?? 0
  const maxResults = opts.maxResults ?? 200

  let L = Math.min(Math.max(1, Math.trunc(line)), maxLine)
  let off = 1
  const step = () => {
    L += off
    off = off < 0 ? -(off - 1) : -(off + 1)
  }
  for (let tries = 100; tries-- > 0;) {
    if (L >= 1 && L <= maxLine) {
      const leaves: number[] = []
      const boxes: number[] = []
      for (const t of tags) {
        const nodes = idx.friends.get(t)?.get(L)
        if (!nodes) continue
        for (const n of nodes) (isBox(idx.type[n]) ? boxes : leaves).push(n)
      }
      const hits = leaves.length ? leaves : boxes
      if (hits.length) {
        // group by page, then by the enclosing (visible) box; weight = matching records inside it
        const perPage = new Map<number, Map<number, number>>()
        for (const n of hits) {
          const b = isBox(idx.type[n]) ? n : idx.parent[n]
          if (b < 0 || idx.type[b] === NodeType.Page) continue
          const page = pageOf(idx, b)
          let m = perPage.get(page)
          if (!m) perPage.set(page, (m = new Map()))
          m.set(b, (m.get(b) ?? 0) + 1)
        }
        const pageList = [...perPage.keys()].sort((a, b) => Math.abs(pageHint - a) - Math.abs(pageHint - b) || a - b)
        const out: SynctexBox[] = []
        for (const page of pageList) {
          const ranked = [...perPage.get(page)!].sort((a, b) => b[1] - a[1])
          for (const [b, weight] of ranked) {
            out.push({ page, line: L, weight, ...boxOf(idx, b) })
            if (out.length >= maxResults) return out
          }
        }
        if (out.length) return out
      }
    }
    step()
    if (L <= 0) step()
  }
  return []
}

/** Convert a CLI-shaped box (v = bottom) to a PdfRect (top-left corner, positive size). */
export function boxToRect(b: { page: number; h: number; v: number; W: number; H: number }): PdfRect {
  const x0 = Math.min(b.h, b.h + b.W)
  const top = Math.min(b.v - b.H, b.v)
  return { page: b.page, x: x0, y: top, width: Math.abs(b.W), height: Math.abs(b.H) }
}

/**
 * Forward search: rectangles (PDF points, top-left origin) showing where `line` of
 * `inputPath` was typeset. Column is accepted for API symmetry; TeX engines record none.
 */
export function forwardSearch(idx: SynctexIndex, inputPath: string, line: number, column?: number, opts: ForwardOptions = {}): PdfRect[] {
  void column
  const seen = new Set<string>()
  const out: PdfRect[] = []
  for (const b of forwardSearchBoxes(idx, inputPath, line, opts)) {
    const r = boxToRect(b)
    const key = `${r.page}:${r.x.toFixed(2)}:${r.y.toFixed(2)}:${r.width.toFixed(2)}:${r.height.toFixed(2)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

// ---------------------------------------------------------------------------------------
// Inverse search
// ---------------------------------------------------------------------------------------

interface Hit { h: number; v: number }

function hasKids(idx: SynctexIndex, n: number): boolean {
  return idx.end[n] > n + 1
}

/** h-ordered distance (C: _synctex_point_h_ordered_distance_v2): > 0 node right of hit, < 0 left, 0 inside */
function hDist(idx: SynctexIndex, hit: Hit, n: number): number {
  const t = idx.type[n]
  let min: number
  let max: number
  if (t === NodeType.HBox) {
    const a = idx.vh[n]
    const b = a + idx.vW[n]
    min = Math.min(a, b)
    max = Math.max(a, b)
  } else if (t === NodeType.VBox || t === NodeType.VoidHBox || t === NodeType.VoidVBox || t === NodeType.Rule) {
    min = idx.h[n]
    max = min + Math.abs(idx.W[n])
  } else if (t === NodeType.Kern) {
    const W = idx.W[n]
    const h = idx.h[n]
    if (W < 0) {
      min = h
      max = h - W
    } else {
      min = h - W
      max = h
    }
    const med = (min + max) / 2
    if (hit.h < min) return min - hit.h + 1
    if (hit.h > max) return max - hit.h - 1
    return hit.h > med ? max - hit.h + 1 : min - hit.h - 1
  } else {
    min = max = idx.h[n]
  }
  if (hit.h < min) return min - hit.h
  if (hit.h > max) return max - hit.h
  return 0
}

function vDist(idx: SynctexIndex, hit: Hit, n: number): number {
  const t = idx.type[n]
  let min: number
  let max: number
  if (t === NodeType.HBox) {
    min = idx.v[n] - Math.abs(idx.vH[n])
    max = idx.v[n] + Math.abs(idx.vD[n])
  } else if (t === NodeType.VBox || t === NodeType.VoidHBox || t === NodeType.VoidVBox) {
    min = idx.v[n] - Math.abs(idx.H[n])
    max = idx.v[n] + Math.abs(idx.D[n])
  } else {
    // leaves use the height/depth of their enclosing box
    const p = idx.parent[n]
    const pH = p < 0 ? 0 : idx.type[p] === NodeType.HBox ? idx.vH[p] : idx.H[p]
    const pD = p < 0 ? 0 : idx.type[p] === NodeType.HBox ? idx.vD[p] : idx.D[p]
    min = idx.v[n] - Math.abs(pH)
    max = idx.v[n] + Math.abs(pD)
  }
  if (hit.v < min) return min - hit.v
  if (hit.v > max) return max - hit.v
  return 0
}

const inBox = (idx: SynctexIndex, hit: Hit, n: number) => hDist(idx, hit, n) === 0 && vDist(idx, hit, n) === 0
const area = (idx: SynctexIndex, b: number) => Math.abs(idx.vW[b]) * (Math.abs(idx.vH[b]) + Math.abs(idx.vD[b]))
const pointNodeDistance = (idx: SynctexIndex, hit: Hit, n: number) => Math.abs(hDist(idx, hit, n)) + Math.abs(vDist(idx, hit, n))

function deepestContainer(idx: SynctexIndex, hit: Hit, n: number): number {
  if (!hasKids(idx, n)) return -1
  for (let k = n + 1; k < idx.end[n]; k = idx.end[k]) {
    if (hasKids(idx, k) && inBox(idx, hit, k)) {
      const d = deepestContainer(idx, hit, k)
      if (d >= 0) return d
    }
  }
  if (idx.type[n] === NodeType.VBox) {
    let best = -1
    let bd = Infinity
    for (let k = n + 1; k < idx.end[n]; k = idx.end[k]) {
      if (!hasKids(idx, k)) continue
      const d = pointNodeDistance(idx, hit, k)
      if (d <= bd) {
        bd = d
        best = k
      }
    }
    if (best >= 0) return best
  }
  return inBox(idx, hit, n) ? n : -1
}

/** L1 distance from the hit to the box [h0, h1] × [v0, v1] (C: _synctex_distance_to_box_v2) */
function boxDistance(hit: Hit, h0: number, h1: number, v0: number, v1: number): number {
  const dh = hit.h < h0 ? h0 - hit.h : hit.h > h1 ? hit.h - h1 : 0
  const dv = hit.v < v0 ? v0 - hit.v : hit.v > v1 ? hit.v - v1 : 0
  return dh + dv
}

/**
 * Distance from the hit to a leaf as the C library measures it for "closest deep child"
 * (_synctex_point_node_distance_v2): glue, math, current and boundary records are vertical
 * segments from the baseline up to the enclosing box's height; a kern is the nearer of its two
 * edges. Rules and void boxes are never candidates (Infinity).
 */
function leafDistance(idx: SynctexIndex, hit: Hit, n: number): number {
  const t = idx.type[n]
  if (t !== NodeType.Kern && t !== NodeType.Glue && t !== NodeType.Math && t !== NodeType.Current && t !== NodeType.Boundary) return Infinity
  const p = idx.parent[n]
  const v1 = idx.v[n]
  const v0 = v1 - Math.abs(p < 0 ? 0 : idx.H[p])
  const h = idx.h[n]
  const d = boxDistance(hit, h, h, v0, v1)
  if (t !== NodeType.Kern) return d
  const h2 = h - idx.W[n]
  return Math.min(d, boxDistance(hit, h2, h2, v0, v1))
}

/** Closest leaf below `n` (C: __synctex_closest_deep_child_v2 — on a tie the later leaf wins unless it is a kern). */
function closestDeepChild(idx: SynctexIndex, hit: Hit, n: number, accept?: (k: number) => boolean): number {
  let best = -1
  let bd = Infinity
  for (let k = n + 1; k < idx.end[n]; k++) {
    if (accept && !accept(k)) continue
    const d = leafDistance(idx, hit, k)
    if (d === Infinity) continue
    if (d < bd || (d === bd && idx.type[k] !== NodeType.Kern)) {
      bd = d
      best = k
    }
  }
  return best
}

interface Closest { l: number; ld: number; r: number; rd: number }

/**
 * C: _synctex_eq_deepest_container_v3 (used to narrow the left/right candidates): depth first
 * into every child box whether or not it contains the hit; a vbox answers with its closest
 * child box that has content.
 */
function deepestContainerV3(idx: SynctexIndex, hit: Hit, n: number): number {
  if (!hasKids(idx, n)) return -1
  for (let k = n + 1; k < idx.end[n]; k = idx.end[k]) {
    const d = deepestContainerV3(idx, hit, k)
    if (d >= 0) return d
  }
  if (idx.type[n] === NodeType.VBox) {
    let best = -1
    let bd = Infinity
    for (let k = n + 1; k < idx.end[n]; k = idx.end[k]) {
      if (!hasKids(idx, k)) continue
      const d = pointNodeDistance(idx, hit, k)
      if (d < bd) {
        bd = d
        best = k
      }
    }
    if (best >= 0) return best
  }
  return inBox(idx, hit, n) ? n : -1
}

function narrow(idx: SynctexIndex, hit: Hit, n: number): number {
  if (n < 0 || !hasKids(idx, n)) return n
  const d = deepestContainerV3(idx, hit, n)
  const c = d >= 0 ? d : n
  const deep = closestDeepChild(idx, hit, c)
  return deep >= 0 ? deep : c
}

function preferLower(idx: SynctexIndex, cur: number, cand: number): boolean {
  // on equal distance prefer the smaller line (then column) of the same input
  return idx.tag[cur] === idx.tag[cand] && (idx.line[cur] > idx.line[cand] || (idx.line[cur] === idx.line[cand] && idx.col[cur] > idx.col[cand]))
}

function closestChildren(idx: SynctexIndex, hit: Hit, box: number): Closest {
  const res: Closest = { l: -1, ld: Infinity, r: -1, rd: Infinity }
  if (!hasKids(idx, box)) return res
  const horizontal = idx.type[box] === NodeType.HBox
  for (let k = box + 1; k < idx.end[box]; k = idx.end[k]) {
    const d = horizontal ? hDist(idx, hit, k) : vDist(idx, hit, k)
    if (d > 0) {
      if (res.rd > d) {
        res.r = k
        res.rd = d
      } else if (horizontal && res.rd === d && res.r >= 0 && preferLower(idx, res.r, k)) res.r = k
    } else if (d === 0) {
      if (horizontal && hasKids(idx, k)) return closestChildren(idx, hit, k)
      res.l = k
      res.ld = 0
    } else {
      const e = -d
      if (res.ld > e) {
        res.l = k
        res.ld = e
      } else if (horizontal && res.ld === e && res.l >= 0 && preferLower(idx, res.l, k)) res.l = k
    }
  }
  res.l = narrow(idx, hit, res.l)
  res.r = narrow(idx, hit, res.r)
  return res
}

export interface InverseOptions {
  /**
   * Accept only these inputs (e.g. project files). When none of the best candidates is
   * accepted, the nearest record on the page from an accepted input is returned instead.
   */
  accept?: (input: string) => boolean
}

/**
 * Inverse search: source locations for a point on `page` (1-based) at (x, y) in PDF points
 * from the page's top-left. The best candidate comes first (at most two, like `synctex edit`).
 */
export function inverseSearch(idx: SynctexIndex, page: number, x: number, y: number, opts: InverseOptions = {}): InverseResult[] {
  const root = idx.pages.get(page)
  if (root === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return []
  const hit: Hit = { h: (x - idx.xOffBp) / idx.unitBp, v: (y - idx.yOffBp) / idx.unitBp }

  // smallest hbox containing the hit
  let node = -1
  let nodeArea = Infinity
  for (let k = root + 1; k < idx.end[root]; k++) {
    if (idx.type[k] !== NodeType.HBox || !inBox(idx, hit, k)) continue
    const a = area(idx, k)
    if (node < 0 || a < nodeArea) {
      node = k
      nodeArea = a
    }
  }

  let l = -1
  let r = -1
  let ld = 0
  let rd = 0
  if (node >= 0) {
    const d = deepestContainer(idx, hit, node)
    if (d >= 0) node = d
    const c = closestChildren(idx, hit, node)
    ;({ l, r, ld, rd } = c)
    if (l < 0 && r < 0) l = node
  } else {
    l = closestDeepChild(idx, hit, root)
  }

  let picked: number[] = []
  if (l >= 0 && r >= 0 && (idx.tag[l] !== idx.tag[r] || idx.line[l] !== idx.line[r] || idx.col[l] !== idx.col[r])) {
    if (idx.line[r] < idx.line[l] || (idx.line[r] === idx.line[l] && ld > rd)) picked = [r, l]
    else picked = [l, r]
  } else if (l >= 0 && r >= 0) picked = [ld > rd ? r : l]
  else if (l >= 0 || r >= 0) picked = [l >= 0 ? l : r]

  const toResult = (n: number): InverseResult | null => {
    const input = idx.inputs.get(idx.tag[n])
    if (input === undefined || idx.type[n] === NodeType.Page) return null
    return { input, line: idx.line[n], column: idx.col[n] }
  }
  let out = picked.map(toResult).filter((e): e is InverseResult => e !== null)
  if (opts.accept) {
    const accept = opts.accept
    out = out.filter(e => accept(e.input))
    if (!out.length) {
      const fallback = closestDeepChild(idx, hit, root, k => {
        const input = idx.inputs.get(idx.tag[k])
        return input !== undefined && idx.line[k] > 0 && accept(input)
      })
      const f = fallback >= 0 ? toResult(fallback) : null
      if (f) out = [f]
    }
  }
  return out
}

/** Number of pages with SyncTeX content. */
export function synctexPages(idx: SynctexIndex): number[] {
  return [...idx.pages.keys()].sort((a, b) => a - b)
}
