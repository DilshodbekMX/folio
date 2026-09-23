/**
 * SyncTeX parser + search: golden comparison with the synctex CLI (TeX Live 2026) on the real
 * paper (XeLaTeX, 41 pages), a small multi-file pdfLaTeX document and a 4-file document of
 * multi-line paragraphs (pdfLaTeX + LuaLaTeX word clicks, fixtures/synctex/para-*), plus unit tests.
 * Goldens: fixtures/synctex/*-golden.json (generated with `synctex view|edit` in
 * texlive/texlive:latest-full, see docs of the JSON).
 */
import { gunzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  boxToRect, findInputTags, forwardSearch, forwardSearchBoxes, inverseSearch, listInputs, parseSynctex,
  parseSynctexText, SP_PER_BP, type SynctexIndex,
} from '../src/synctex/index.ts'
import { fixture, fixtureText, hasFixture } from './helpers.ts'

interface CliBox { page: number; h: number; v: number; W: number; H: number }
interface Golden {
  forward: { input: string; line: number; cli: CliBox[] }[]
  inverse: { page: number; x: number; y: number; kind: 'text' | 'grid'; cli: { input: string; line: number; column: number }[] }[]
}

/** rectangles (inflated by 1 bp) intersect on the same page */
function overlaps(a: CliBox, b: CliBox): boolean {
  if (a.page !== b.page) return false
  const iv = (a0: number, a1: number, b0: number, b1: number) =>
    Math.min(Math.max(a0, a1), Math.max(b0, b1)) - Math.max(Math.min(a0, a1), Math.min(b0, b1)) > -1
  return iv(a.v - a.H, a.v, b.v - b.H, b.v) && iv(a.h, a.h + a.W, b.h, b.h + b.W)
}

function compare(idx: SynctexIndex, g: Golden) {
  let fwdN = 0
  let samePage = 0
  let overlap = 0
  let emptyAgree = 0
  let emptyTotal = 0
  for (const q of g.forward) {
    const js = forwardSearchBoxes(idx, q.input, q.line)
    if (!q.cli.length) {
      emptyTotal++
      if (!js.length) emptyAgree++
      continue
    }
    fwdN++
    if (js.length && js[0].page === q.cli[0].page) samePage++
    if (js.length && q.cli.some(c => overlaps(c, js[0]))) overlap++
  }
  const inv = { text: { n: 0, same: 0, pm1: 0 }, grid: { n: 0, same: 0, pm1: 0 } }
  for (const p of g.inverse) {
    const js = inverseSearch(idx, p.page, p.x, p.y)
    if (!p.cli.length) continue
    const s = inv[p.kind]
    s.n++
    if (js.length && js[0].input === p.cli[0].input && js[0].line === p.cli[0].line) s.same++
    if (js.some(r => r.input === p.cli[0].input && Math.abs(r.line - p.cli[0].line) <= 1)) s.pm1++
  }
  return {
    forward: { n: fwdN, samePage: samePage / fwdN, firstBoxOverlap: overlap / fwdN, emptyAgree, emptyTotal },
    inverseText: { n: inv.text.n, sameLine: inv.text.same / inv.text.n, withinOne: inv.text.pm1 / inv.text.n },
    inverseGrid: { n: inv.grid.n, sameLine: inv.grid.same / inv.grid.n, withinOne: inv.grid.pm1 / inv.grid.n },
  }
}

const load = (name: string) => parseSynctexText(gunzipSync(fixture(`synctex/${name}`)).toString('latin1'))

// The paper fixtures are not distributed (unpublished manuscript); this suite skips without them.
describe.skipIf(!hasFixture('synctex/paper.synctex.gz'))('real paper (XeLaTeX, 41 pages) vs synctex CLI', () => {
  const present = hasFixture('synctex/paper.synctex.gz')
  const t0 = performance.now()
  const idx = present ? load('paper.synctex.gz') : ({} as ReturnType<typeof load>)
  const parseMs = performance.now() - t0
  const golden = JSON.parse(present ? fixtureText('synctex/paper-golden.json') : '{"forward":[],"inverse":[]}') as Golden

  it('parses fast into compact storage', () => {
    expect(parseMs).toBeLessThan(300)
    expect(idx.pages.size).toBe(41)
    expect(idx.output).toBe('xdv')
    // XeTeX's 1in offsets
    expect(idx.xOffBp).toBeCloseTo(72, 4)
    expect(idx.yOffBp).toBeCloseTo(72, 4)
    expect(idx.unitBp).toBeCloseTo(1 / SP_PER_BP, 12)
    let bytes = 0
    for (const a of [idx.type, idx.tag, idx.line, idx.col, idx.h, idx.v, idx.W, idx.H, idx.D, idx.parent, idx.end, idx.vh, idx.vW, idx.vH, idx.vD]) bytes += a.byteLength
    expect(bytes).toBeLessThan(16 * 1024 * 1024)
    expect(idx.count).toBeGreaterThan(100_000)
  })

  it('lists the recorded inputs', () => {
    const inputs = listInputs(idx)
    expect(inputs).toContain('/compile/./antiddos_v2.tex')
    expect(inputs).toContain('/compile/./Definitions/mdpi.cls')
    expect(inputs.filter(i => i.endsWith('antiddos_v2.aux'))).toHaveLength(1) // recorded twice with two tags
    expect(findInputTags(idx, '/compile/./antiddos_v2.aux')).toHaveLength(2)
    expect(findInputTags(idx, 'antiddos_v2.tex')).toEqual([1])
  })

  it('agrees with the CLI (forward ≥ 95 % first-box page and overlap; inverse ≥ 95 % same line on text)', () => {
    const r = compare(idx, golden)
    console.info(`[synctex] paper: parse ${parseMs.toFixed(1)} ms, ${JSON.stringify(r)}`)
    expect(r.forward.n).toBeGreaterThanOrEqual(40)
    expect(r.forward.samePage).toBeGreaterThanOrEqual(0.95)
    expect(r.forward.firstBoxOverlap).toBeGreaterThanOrEqual(0.95)
    expect(r.forward.emptyAgree).toBe(r.forward.emptyTotal)
    expect(r.inverseText.n).toBeGreaterThanOrEqual(40)
    expect(r.inverseText.sameLine).toBeGreaterThanOrEqual(0.95)
    expect(r.inverseGrid.withinOne).toBeGreaterThanOrEqual(0.85)
    // clicks in the margins / between lines: the C distance and tie rules give the CLI's line
    expect(r.inverseGrid.sameLine).toBeGreaterThanOrEqual(0.95)
  })

  it('returns PdfRects with a top-left origin that match the CLI boxes', () => {
    let exact = 0
    for (const q of golden.forward) {
      const c = q.cli[0]
      const b = forwardSearchBoxes(idx, q.input, q.line)[0]
      if (!c || !b || b.page !== c.page || Math.abs(b.h - c.h) > 0.01 || Math.abs(b.v - c.v) > 0.01 || Math.abs(b.W - c.W) > 0.01 || Math.abs(b.H - c.H) > 0.01) continue
      exact++
      const r = forwardSearch(idx, `/compile/./${q.input}`, q.line)[0]
      expect(r.page).toBe(c.page)
      expect(r.x).toBeCloseTo(Math.min(c.h, c.h + c.W), 2)
      expect(r.y).toBeCloseTo(c.v - c.H, 2)
      expect(r.width).toBeCloseTo(Math.abs(c.W), 2)
      expect(r.height).toBeCloseTo(c.H, 2)
    }
    expect(exact).toBeGreaterThanOrEqual(10)
  })

  it('inverse search can be restricted to project inputs', () => {
    // a click in the running header (typeset by the class) → mdpi.cls, or antiddos_v2.tex when restricted
    const any = inverseSearch(idx, 3, 300, 60)
    expect(any.length).toBeGreaterThan(0)
    const onlyMain = inverseSearch(idx, 3, 300, 60, { accept: i => i.endsWith('/antiddos_v2.tex') })
    expect(onlyMain.length).toBeGreaterThan(0)
    expect(onlyMain.every(r => r.input === '/compile/./antiddos_v2.tex')).toBe(true)
    expect(inverseSearch(idx, 99, 100, 100)).toEqual([])
    expect(inverseSearch(idx, 1, Number.NaN, 100)).toEqual([])
  })
})

describe('small multi-file pdfLaTeX document vs synctex CLI', () => {
  const idx = load('small.synctex.gz')
  const golden = JSON.parse(fixtureText('synctex/small-golden.json')) as Golden

  it('maps files included with \\input', () => {
    expect(idx.output).toBe('pdf')
    expect(idx.xOffBp).toBe(0)
    expect(listInputs(idx)).toEqual(expect.arrayContaining(['/compile/./main.tex', '/compile/./chapters/intro.tex', '/compile/./chapters/results.tex']))
    const rects = forwardSearch(idx, '/compile/./chapters/intro.tex', 3)
    expect(rects[0].page).toBe(1)
    expect(forwardSearch(idx, 'chapters/results.tex', 19)[0].page).toBe(2)
  })

  it('agrees with the CLI', () => {
    const r = compare(idx, golden)
    console.info(`[synctex] small: ${JSON.stringify(r)}`)
    expect(r.forward.n).toBe(59)
    expect(r.forward.samePage).toBeGreaterThanOrEqual(0.95)
    // structural lines (blank lines, \begin{enumerate}, floats) rank differently from the CLI
    expect(r.forward.firstBoxOverlap).toBeGreaterThanOrEqual(0.85)
    expect(r.inverseText.sameLine).toBeGreaterThanOrEqual(0.95)
    expect(r.inverseText.withinOne).toBe(1)
    expect(r.inverseGrid.sameLine).toBeGreaterThanOrEqual(0.95)
  })
})

describe('multi-line paragraphs in \\input / \\include files (pdfLaTeX, LuaLaTeX) vs synctex CLI', () => {
  interface Click {
    word: string
    first: boolean
    page: number
    x: number
    y: number
    expected: { file: string; line: number }
    cli: { input: string; line: number } | null
  }
  const golden = JSON.parse(fixtureText('synctex/para-golden.json')) as { engines: Record<string, { synctex: string; clicks: Click[] }> }
  const rel = (p: string) => p.replace(/^\/compile\/(?:\.\/)?/, '')
  const right = (c: Click, r: { input: string; line: number } | null | undefined) =>
    !!r && rel(r.input) === c.expected.file && Math.abs(r.line - c.expected.line) <= 1

  for (const engine of ['pdflatex', 'lualatex']) {
    const { synctex, clicks } = golden.engines[engine]
    const idx = load(synctex)

    it(`${engine}: the first word of a typeset line maps to its own source line and file`, () => {
      // pdfTeX/LuaTeX write the paragraph's LAST line on the leading 'x' records of every line
      // box; without the C parser's link fix-up these clicks jumped to the end of the paragraph
      // or into the file holding the \include
      const firsts = clicks.filter(c => c.first)
      expect(firsts.length).toBeGreaterThanOrEqual(40)
      const wrong = firsts.filter(c => !right(c, inverseSearch(idx, c.page, c.x, c.y)[0])).map(c => c.word)
      expect(wrong.length).toBeLessThanOrEqual(1)
      // at least as good as the CLI itself
      expect(firsts.filter(c => right(c, inverseSearch(idx, c.page, c.x, c.y)[0])).length)
        .toBeGreaterThanOrEqual(firsts.filter(c => right(c, c.cli)).length)
    })

    it(`${engine}: every click agrees with the CLI or is right where the CLI is not`, () => {
      for (const c of clicks) {
        const r = inverseSearch(idx, c.page, c.x, c.y)[0]
        const same = !!r && !!c.cli && rel(r.input) === rel(c.cli.input) && r.line === c.cli.line
        if (!same) expect(right(c, r), `${c.word} ${JSON.stringify(r)} cli ${JSON.stringify(c.cli)}`).toBe(true)
      }
    })
  }

  it('the link fix-up only concerns leading x records of hboxes, and keeps forward search', () => {
    const text = [
      'SyncTeX Version:1', 'Input:1:/compile/./main.tex', 'Output:pdf', 'Magnification:1000', 'Unit:1',
      'X Offset:0', 'Y Offset:0', 'Content:', '{1', '[1,1:0,0:40000000,50000000,0',
      // a typeset line: its leading x records say line 9 (end of paragraph), the words are line 4
      '(1,9:1000000,6000000:30000000,655360,196608',
      'x1,9:2000000,6000000', 'x1,9:4000000,6000000', 'k1,4:4100000,6000000:100000', 'x1,4:6000000,6000000',
      ')',
      // a vbox's leading x keeps its own line
      '[1,7:1000000,9000000:30000000,655360,196608', 'x1,7:2000000,9000000', 'g1,8:3000000,9000000', ']',
      ']', '}1', 'Postamble:', '',
    ].join('\n')
    const idx2 = parseSynctexText(text)
    const u = 1 / SP_PER_BP
    expect(inverseSearch(idx2, 1, 2000000 * u, 5900000 * u)[0].line).toBe(4)
    expect(inverseSearch(idx2, 1, 4000000 * u, 5900000 * u)[0].line).toBe(4)
    // the fixed-up records are found under their new line; nothing is left under line 9 but the box
    expect(forwardSearchBoxes(idx2, 'main.tex', 4)[0].line).toBe(4)
    const current = [...idx2.friends.get(1)!.get(7)!].map(n => idx2.type[n])
    expect(current).toContain(5) // the vbox's x record
  })
})

// ---------------------------------------------------------------------------------------
// Unit tests on a hand-written file
// ---------------------------------------------------------------------------------------

const SMALL = [
  'SyncTeX Version:1',
  'Input:1:/compile/./main.tex',
  'Input:2:/compile/./chapters/a b.tex',
  'Output:pdf',
  'Magnification:1000',
  'Unit:1',
  'X Offset:0',
  'Y Offset:0',
  'Content:',
  '!120',
  '{1',
  '[1,1:0,0:40000000,50000000,0',
  '(1,3:4736286,6000000:30000000,655360,196608',
  'x1,3:5000000,6000000',
  'g1,3:9000000,=',
  'k1,3:12000000,6000000:100000',
  ')',
  '(2,5:4736286,7000000:30000000,655360,196608',
  'x2,5:5000000,7000000',
  '$2,5:8000000,7000000',
  ')',
  'r1,9:4736286,8000000:1000,1000,0',
  ']',
  '}1',
  'Input:3:/compile/./late.tex',
  '{2',
  '[3,1:0,0:40000000,50000000,0',
  '(3,1:4736286,6000000:20000000,655360,196608',
  'x3,1:5000000,6000000',
  ')',
  ']',
  '}2',
  'Postamble:',
  'Count:14',
  '',
].join('\n')

describe('parser and search units', () => {
  const idx = parseSynctexText(SMALL)
  const u = 1 / SP_PER_BP

  it('reads the preamble, pages and inputs declared inside the content', () => {
    expect(idx.version).toBe(1)
    expect([...idx.pages.keys()]).toEqual([1, 2])
    expect(listInputs(idx)).toEqual(['/compile/./main.tex', '/compile/./chapters/a b.tex', '/compile/./late.tex'])
    expect(idx.maxLine.get(1)).toBe(9)
  })

  it('forward: box of the line with top-left origin', () => {
    const [r] = forwardSearch(idx, 'main.tex', 3)
    expect(r.page).toBe(1)
    expect(r.x).toBeCloseTo(4736286 * u, 6)
    expect(r.y).toBeCloseTo((6000000 - 655360) * u, 6)
    expect(r.width).toBeCloseTo(30000000 * u, 6)
    expect(r.height).toBeCloseTo((655360 + 196608) * u, 6)
    expect(forwardSearch(idx, '/compile/./chapters/a b.tex', 5)[0].y).toBeCloseTo((7000000 - 655360) * u, 6)
    expect(forwardSearch(idx, 'late.tex', 1)[0].page).toBe(2)
  })

  it('forward: searches nearby lines and clamps to the last line', () => {
    expect(forwardSearchBoxes(idx, 'main.tex', 2)[0].line).toBe(3)
    expect(forwardSearchBoxes(idx, 'main.tex', 500)[0].line).toBe(9)
    expect(forwardSearch(idx, 'missing.tex', 1)).toEqual([])
  })

  it('reads compressed "=" coordinates', () => {
    const g = [...idx.friends.get(1)!.get(3)!].find(n => idx.type[n] === 7)!
    expect(idx.v[g]).toBe(6000000)
    expect(idx.h[g]).toBe(9000000)
  })

  it('inverse: the line under the point, and the nearest record outside boxes', () => {
    expect(inverseSearch(idx, 1, 5100000 * u, 5900000 * u)[0]).toEqual({ input: '/compile/./main.tex', line: 3, column: -1 })
    expect(inverseSearch(idx, 1, 6000000 * u, 6950000 * u)[0]).toEqual({ input: '/compile/./chapters/a b.tex', line: 5, column: -1 })
    expect(inverseSearch(idx, 2, 5100000 * u, 5900000 * u)[0].input).toBe('/compile/./late.tex')
    // far below everything on page 1: nearest leaf
    expect(inverseSearch(idx, 1, 5000000 * u, 30000000 * u).length).toBeGreaterThan(0)
  })

  it('applies magnification, unit and offsets (incl. post scriptum)', () => {
    const scaled = parseSynctexText(SMALL.replace('Magnification:1000', 'Magnification:2000').replace('X Offset:0', 'X Offset:4736286'))
    expect(scaled.unitBp).toBeCloseTo(2 / SP_PER_BP, 12)
    expect(scaled.xOffBp).toBeCloseTo(72, 4)
    const [r] = forwardSearch(scaled, 'main.tex', 3)
    expect(r.x).toBeCloseTo(72 + 2 * 4736286 * u, 4)
    const unitless = parseSynctexText(SMALL.replace('Unit:1', 'Unit:0'))
    expect(unitless.unitBp).toBeCloseTo(8192 / SP_PER_BP, 10)
    const post = parseSynctexText(SMALL.replace('Count:14', 'Count:14\nPost scriptum:\nMagnification:1.5\nX Offset:1in\nY Offset:72.27pt'))
    expect(post.unitBp).toBeCloseTo(1.5 / SP_PER_BP, 12)
    expect(post.xOffBp).toBeCloseTo(72, 3)
    expect(post.yOffBp).toBeCloseTo(72, 3)
  })

  it('decodes UTF-8 input paths from latin1 text and bytes', () => {
    const utf8Path = '/compile/./chapitre é.tex'
    const bytes = new TextEncoder().encode(SMALL.replace('/compile/./late.tex', utf8Path))
    let latin1 = ''
    for (const b of bytes) latin1 += String.fromCharCode(b)
    expect(listInputs(parseSynctexText(latin1))).toContain(utf8Path)
    expect(listInputs(parseSynctex(bytes))).toContain(utf8Path)
  })

  it('parseSynctex needs a gunzip function for compressed data', () => {
    const gz = fixture('synctex/small.synctex.gz')
    expect(() => parseSynctex(gz)).toThrow(/gunzip/)
    const idx2 = parseSynctex(new Uint8Array(gz), { gunzip: b => gunzipSync(b) })
    expect(idx2.pages.size).toBe(2)
  })

  it('ignores malformed lines, forms and records outside sheets', () => {
    const noisy = SMALL
      .replace('Content:', 'Content:\nx1,1:5,5\n<1\nf1:5,5\n>')
      .replace('x1,3:5000000,6000000', 'x1,3:5000000,6000000\nx1,garbage\nk1,3:\n$')
    const n = parseSynctexText(noisy)
    expect(forwardSearch(n, 'main.tex', 3)).toHaveLength(1)
    expect(parseSynctexText('').pages.size).toBe(0)
    expect(parseSynctexText('not a synctex file\n{\n}').pages.size).toBe(0)
  })

  it('boxToRect normalises negative widths (right-to-left boxes)', () => {
    expect(boxToRect({ page: 1, h: 100, v: 50, W: -20, H: 10 })).toEqual({ page: 1, x: 80, y: 40, width: 20, height: 10 })
  })
})
