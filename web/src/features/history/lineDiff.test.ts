/**
 * PERF-1: the history diff of a large file with scattered edits lists each edit, not one change
 * covering most of the file (the merge view's default scan limit gave up on them), stays a valid
 * diff, and keeps a time bound on pathological comparisons.
 */
import { describe, expect, it } from 'vitest'
import { Chunk } from '@codemirror/merge'
import { Text } from '@codemirror/state'
import { HISTORY_DIFF_CONFIG, lineFirstDiff } from './lineDiff'

// a ~200 KB LaTeX-like paper: deterministic words, some long paragraph lines, repeated terms
function paper(): string {
  let seed = 42
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff
  const words = ['the', 'detector', 'window', 'CESNET', 'baseline', 'EWMA', 'score', 'traffic', 'benign', 'alarm', 'threshold', 'calibration']
  const lines: string[] = []
  for (let i = 0; i < 1700; i++) {
    if (i % 60 === 0) lines.push(`\\section{Part ${i / 60}}\\label{sec:p${i}}`)
    else if (i % 7 === 0) lines.push('')
    else lines.push(Array.from({ length: 5 + Math.floor(rnd() * 30) }, () => words[Math.floor(rnd() * words.length)]).join(' ') + ` (${i}).`)
  }
  return lines.join('\n') + '\n'
}

const toText = (s: string) => Text.of(s.split('\n'))
const chunks = (a: string, b: string, conf: object) => Chunk.build(toText(a), toText(b), conf)
const changedSize = (list: readonly Chunk[]) => list.reduce((n, c) => n + (c.toA - c.fromA) + (c.toB - c.fromB), 0)

/** a + changes = b, changes in order and not overlapping */
function applies(a: string, b: string): boolean {
  let out = ''
  let pos = 0
  let posB = 0
  for (const c of lineFirstDiff(a, b)) {
    if (c.fromA < pos || c.fromB < posB || a.slice(pos, c.fromA) !== b.slice(posB, c.fromB)) return false
    out += a.slice(pos, c.fromA) + b.slice(c.fromB, c.toB)
    pos = c.toA
    posB = c.toB
  }
  return out + a.slice(pos) === b
}

function spread(s: string, n: number): string {
  let out = ''
  let last = 0
  for (let i = 1; i <= n; i++) {
    const at = s.indexOf('\n', Math.floor((s.length * i) / (n + 1)))
    out += s.slice(last, at) + ` EDIT${i}`
    last = at
  }
  return out + s.slice(last)
}

// the acceptance-test paper (SPEC §1), when this checkout sits next to it
const realPaper = await import('../../../../../antiddos_v2.tex?raw').then(m => m.default as string, () => null)

describe('lineFirstDiff (history diffs)', () => {
  const a = paper()

  it('the fixture is large enough to defeat the default scan limit', () => {
    expect(a.length).toBeGreaterThan(150_000)
    // the library's merge-view default reports a replace-all as ONE change over most of the file
    const b = a.split('CESNET').join('CESNET-2')
    const naive = chunks(a, b, { scanLimit: 500 })
    expect(naive.length).toBe(1)
  })

  it.each([
    ['10 spread edits', (s: string) => spread(s, 10)],
    ['replace-all of a frequent word', (s: string) => s.split('CESNET').join('CESNET-2')],
    ['replace-all of a command', (s: string) => s.split('\\label{').join('\\label{x:')],
    ['a paragraph rewrapped plus a typo', (s: string) => s.replace(/\n([a-z][^\n]{120,})/, m => m.replace(/ /g, '\n')).replace('the ', 'teh ')],
  ])('%s: as many changes as the exact diff, no more changed text', (_name, edit) => {
    const b = edit(a)
    const ours = chunks(a, b, HISTORY_DIFF_CONFIG)
    const exact = chunks(a, b, {})
    expect(ours.length).toBeGreaterThan(1)
    expect(Math.abs(ours.length - exact.length)).toBeLessThanOrEqual(Math.max(1, exact.length * 0.05))
    expect(changedSize(ours)).toBeLessThanOrEqual(changedSize(exact) * 1.05 + 10)
    expect(applies(a, b)).toBe(true)
  })

  it('edge cases stay valid diffs', () => {
    for (const [x, y] of [['', a], [a, ''], [a, a], [a.trimEnd(), `${a.trimEnd()} x`], ['one line', 'one line\n'], ['x'.repeat(50_000), 'y'.repeat(50_000)]]) {
      expect(applies(x, y)).toBe(true)
    }
  })

  it('a rewrite of a 1.5 MB file finishes within the time budget', () => {
    const words = (n: number, seed: number) => Array.from({ length: n }, (_, i) => ((i * 7919 + seed) % 100_003).toString(36)).join(' ')
    const x = Array.from({ length: 25_000 }, (_, i) => words(10, i)).join('\n')
    const y = Array.from({ length: 25_000 }, (_, i) => words(10, i * 31 + 5)).join('\n')
    const t0 = Date.now()
    expect(applies(x, y)).toBe(true)
    expect(Date.now() - t0).toBeLessThan(6_000)
  })

  it.skipIf(realPaper === null)('the real paper: a replace-all of CESNET lists every edited line', () => {
    const text = realPaper!.replace(/\r\n?/g, '\n')
    const b = text.split('CESNET').join('CESNET-2')
    const ours = chunks(text, b, HISTORY_DIFF_CONFIG)
    expect(ours.length).toBe(chunks(text, b, {}).length)
    expect(ours.length).toBeGreaterThan(10)
  })
})
