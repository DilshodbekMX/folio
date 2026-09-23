/**
 * The user's real XeTeX logs (TeX Live 2026, wrapped at 79 columns, no -file-line-error).
 * Expectations: docs/research/logparse.md "TEST FIXTURE" sections.
 */
import { describe, expect, it } from 'vitest'
import { analyzeLatexLog, groupLogEntries, parseLatexLog, unwrapLines } from '../src/texlog/index.ts'
import { all, counts, hasFixture, optionalFixture, sourcesIn } from './helpers.ts'

const PROJECT = [
  'antiddos_v2.tex', 'antiddos_v2_supplementary.tex',
  'Definitions/mdpi.cls', 'Definitions/journalnames.tex', 'Definitions/logo-mdpi.eps', 'Definitions/logo-orcid.pdf',
  'Definitions/logo-updates.eps', 'Definitions/mdpi.bst', 'Definitions/mdpi_apacite.bst', 'Definitions/mdpi_apacite.sty',
  'Definitions/mdpi_chicago.bst', 'Definitions/logo-mdpi.pdf',
]

describe.skipIf(!hasFixture('texlog/antiddos_v2.log'))('antiddos_v2.log (real paper, 41 pages)', () => {
  const bytes = optionalFixture('texlog/antiddos_v2.log')
  const a = analyzeLatexLog(bytes, { projectFiles: PROJECT, rootPath: 'antiddos_v2.tex', getSource: sourcesIn('paper') })
  const log = parseLatexLog(bytes, { projectFiles: PROJECT, rootPath: 'antiddos_v2.tex', getSource: sourcesIn('paper') })

  it('has the expected totals', () => {
    expect(a.engine).toBe('xetex')
    expect(counts(log)).toEqual({ errors: 0, warnings: 74, typesetting: 29, info: 6 })
    expect(a.pages).toBe(41)
    expect(a.complete).toBe(true)
  })

  it('keeps the file stack balanced (root only, no paren frames)', () => {
    expect(a.finalStack).toEqual(['./antiddos_v2.tex'])
    expect(a.openParens).toBe(0)
    expect(a.rootFile).toBe('antiddos_v2.tex')
  })

  it('reports all 29 bad boxes as underfull \\hbox in antiddos_v2.tex with the right ranges', () => {
    const t = log.typesetting
    expect(t.every(e => e.kind === 'underfull-hbox' && e.file === 'antiddos_v2.tex')).toBe(true)
    const ranges = new Map<string, number>()
    for (const e of t) ranges.set(`${e.line}--${e.lineEnd}`, (ranges.get(`${e.line}--${e.lineEnd}`) ?? 0) + 1)
    expect(Object.fromEntries(ranges)).toEqual({
      '108--108': 1, '118--119': 1, '192--193': 1, '236--236': 9, '343--344': 1, '661--662': 2, '667--668': 1,
      '1093--1094': 1, '1330--1331': 1, '1453--1453': 2, '1534--1536': 1, '1549--1551': 3, '1591--1593': 2,
      '1654--1656': 2, '1660--1662': 1,
    })
    const badness = t.map(e => Number(/badness (\d+)/.exec(e.message)![1]))
    expect(badness).toEqual([1436, 1527, 1762, 10000, 1178, 1178, 10000, 10000, 1642, 2401, 1178, 1178, 1275, 10000, 2359, 1365,
      2961, 1565, 1137, 1360, 1609, 2384, 2368, 1454, 5050, 2707, 1389, 1097, 1286])
  })

  it('logs the physical line of each bad box', () => {
    const lines = a.entries.filter(e => e.level === 'typesetting').map(e => e.logLine)
    expect(lines.slice(0, 11)).toEqual([1665, 1680, 1729, 1742, 1747, 1752, 1757, 1762, 1767, 1772, 1777])
    expect(lines.at(-1)).toBe(2172)
  })

  it('attributes the inputenc warning to the class that loaded it, without a line', () => {
    const w = log.warnings[0]
    expect(w.message).toBe('Package inputenc Warning: inputenc package ignored with utf8 based engines.')
    expect(w.file).toBe('Definitions/mdpi.cls')
    expect(w.line).toBeNull()
    expect(a.entries[0].rawFile).toBe('/home/detector/texlive/2026/texmf-dist/tex/latex/base/inputenc.sty')
    expect(a.entries[0].logLine).toBe(42)
  })

  it('finds the 13 multiply-defined warnings read from the .aux and locates the \\bibitem definitions', () => {
    const md = a.entries.filter(e => e.kind === 'multiply-defined')
    expect(md).toHaveLength(13)
    expect(md.map(e => e.logLine)).toEqual([1372, 1375, 1378, 1382, 1385, 1388, 1391, 1394, 1397, 1400, 1403, 1406, 1409])
    expect(md.every(e => e.rawFile === './antiddos_v2.aux' && e.file === 'antiddos_v2.tex')).toBe(true)
    const where = Object.fromEntries(md.map(e => [/[`']([^']+)'/.exec(e.message)![1], e.line]))
    expect(where).toEqual({
      Siffer2017Anomaly: 1545, Rubinstein2009Antidote: 1593, Engelen2021Troubleshooting: 1596, Li2023ECOD: 1650,
      Li2020COPOD: 1653, Xu2023DIF: 1656, Goldstein2012HBOS: 1659, Bandaragoda2018INNE: 1662, Pevny2016Loda: 1665,
      Liu2008IsolationForest: 1668, Hosking1987GPD: 1671, Pendlebury2019Tesseract: 1677, LastPage: null,
    })
    // the duplicates come from xr's \externaldocument: the hint says so
    expect(md[0].hint).toMatch(/externaldocument/)
  })

  it('reads the hyperref token warnings at line 108', () => {
    const h = log.warnings.filter(e => /Token not allowed/.test(e.message))
    expect(h).toHaveLength(16)
    expect(h.every(e => e.file === 'antiddos_v2.tex' && e.line === 108)).toBe(true)
    expect(h.filter(e => /math shift/.test(e.message))).toHaveLength(14)
    expect(h[1].message).toMatch(/removing `\\geq'/)
    expect(h[4].message).toMatch(/removing `\\leq'/)
    expect(h[0].hint).toMatch(/texorpdfstring/)
  })

  it('treats the 6 XeTeX invalid UTF-8 messages as info at line 108', () => {
    expect(log.info).toHaveLength(6)
    expect(log.info.every(e => e.kind === 'invalid-utf8' && e.file === 'antiddos_v2.tex' && e.line === 108)).toBe(true)
  })

  it('reads 41 fancyhdr \\headheight warnings, one per page', () => {
    const f = a.entries.filter(e => /fancyhdr Warning/.test(e.message))
    expect(f).toHaveLength(41)
    expect(f[0].logLine).toBe(1686)
    expect(f[0].message).toMatch(/Make it at least 20\.0pt/)
    expect(f.slice(1).every(e => /18\.18796pt/.test(e.message))).toBe(true)
    expect(f.every(e => e.file === 'antiddos_v2.tex' && e.line === null)).toBe(true)
    expect(f.map(e => e.page)).toEqual(Array.from({ length: 41 }, (_, i) => i + 1))
    const groups = groupLogEntries(log.warnings.filter(e => /fancyhdr/.test(e.message)))
    expect(groups.map(g => g.count)).toEqual([1, 40])
  })

  it('has the remaining warnings and nothing unexpected', () => {
    const texts = log.warnings.map(e => e.message)
    expect(texts).toContain('LaTeX Warning: Text page 29 contains only floats.')
    expect(texts.filter(t => t === 'Package natbib Warning: There were multiply defined citations.')).toHaveLength(1)
    expect(texts.filter(t => t === 'LaTeX Warning: There were multiply-defined labels.')).toHaveLength(1)
    const kinds = new Set(all(log).map(e => e.kind))
    for (const k of ['undefined-reference', 'undefined-citation', 'rerun', 'missing-character', 'font-warning', 'overfull-hbox']) {
      expect(kinds.has(k)).toBe(false)
    }
  })

  it('maps every entry after log line 1772 to antiddos_v2.tex (unbalanced "(" in box content)', () => {
    const late = a.entries.filter(e => e.logLine > 1772)
    expect(late.length).toBeGreaterThan(20)
    expect(late.every(e => e.file === 'antiddos_v2.tex')).toBe(true)
  })

  it('unwraps without false joins', () => {
    const u = unwrapLines(bytes)
    expect(u.maxPrintLine).toBe(79)
    expect(u.lines.some(l => /defFile:|styPackage:/.test(l))).toBe(false)
    expect(u.lines.some(l => l.includes('/rerunfilecheck/rerunfilecheck.sty'))).toBe(true)
    // 'Largouët' line: 80 bytes but 79 code points → joined
    expect(u.lines.some(l => /Largouët, C\. Netspot: /.test(l) && l.length > 79)).toBe(true)
  })

  it('works without project files or sources', () => {
    const plain = parseLatexLog(bytes, { projectFiles: [] })
    expect(counts(plain)).toEqual({ errors: 0, warnings: 74, typesetting: 29, info: 6 })
    // without the project list every local file counts as a project file (the .aux too)
    const md = plain.warnings.filter(e => e.kind === 'multiply-defined')
    expect(md.every(e => e.file === 'antiddos_v2.aux' && e.line === null)).toBe(true)
  })

  it('also accepts the log as a string', () => {
    const s = parseLatexLog(bytes.toString('utf8'), { projectFiles: PROJECT })
    expect(counts(s)).toEqual(counts(log))
  })
})

describe.skipIf(!hasFixture('texlog/antiddos_v2.log'))('antiddos_v2_supplementary.log (real paper, 19 pages)', () => {
  const bytes = optionalFixture('texlog/antiddos_v2_supplementary.log')
  const opts = { projectFiles: PROJECT, rootPath: 'antiddos_v2_supplementary.tex', getSource: sourcesIn('paper') }
  const a = analyzeLatexLog(bytes, opts)
  const log = parseLatexLog(bytes, opts)

  it('has the expected totals and a balanced stack', () => {
    expect(counts(log)).toEqual({ errors: 0, warnings: 35, typesetting: 18, info: 0 })
    expect(a.finalStack).toEqual(['./antiddos_v2_supplementary.tex'])
    expect(a.openParens).toBe(0)
    expect(a.pages).toBe(19)
  })

  it('reads 12 underfull and 6 overfull boxes with their ranges', () => {
    const t = log.typesetting
    expect(t.every(e => e.file === 'antiddos_v2_supplementary.tex')).toBe(true)
    expect(t.filter(e => e.kind === 'underfull-hbox')).toHaveLength(12)
    const over = t.filter(e => e.kind === 'overfull-hbox')
    expect(over).toHaveLength(6)
    expect(over.every(e => e.line === 217 && e.lineEnd === 217 && /0\.58865pt too wide/.test(e.message))).toBe(true)
    const ranges = t.filter(e => e.kind === 'underfull-hbox').map(e => `${e.line}--${e.lineEnd}`)
    expect(ranges).toEqual(['147--148', '147--148', '436--437', '436--437', '436--437', '532--533',
      '740--742', '740--742', '740--742', '752--754', '752--754', '752--754'])
    expect(a.entries.filter(e => e.kind === 'overfull-hbox').map(e => e.logLine)).toEqual([1654, 1659, 1664, 1669, 1674, 1679])
  })

  it('has the expected warnings', () => {
    const w = log.warnings
    expect(w.filter(e => /inputenc/.test(e.message))).toHaveLength(1)
    const md = w.filter(e => e.kind === 'multiply-defined')
    expect(md).toHaveLength(13)
    expect(md.find(e => /Hosking1987GPD/.test(e.message))!.line).toBe(733)
    expect(md.find(e => /Rubinstein2009Antidote/.test(e.message))!.line).toBe(766)
    const fancy = w.filter(e => /fancyhdr/.test(e.message))
    expect(fancy).toHaveLength(19)
    expect(fancy.filter(e => /18\.13795pt/.test(e.message))).toHaveLength(1)
    expect(w.filter(e => e.kind === 'summary')).toHaveLength(2)
    expect(w.some(e => /hyperref/.test(e.message))).toBe(false)
  })
})
