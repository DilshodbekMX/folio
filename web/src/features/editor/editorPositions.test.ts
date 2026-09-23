/**
 * J-3: the cursor and scroll position of each file are remembered per project in localStorage
 * ('folio:editorpos:<pid>'), validated on read, pruned of deleted files and capped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readStoredPosition, storePosition, type StoredPosition } from './editorPositions'

let data: Map<string, string>
beforeEach(() => {
  data = new Map()
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const pos: StoredPosition = { anchor: { line: 636, col: 5 }, head: { line: 636, col: 9 }, top: 625 }
const stored = (pid: string) => JSON.parse(data.get(`folio:editorpos:${pid}`) ?? '{}') as Record<string, unknown>

describe('editor positions', () => {
  it('round-trips per project and file', () => {
    storePosition('p1', 'f1', pos)
    storePosition('p1', 'f2', { anchor: { line: 1, col: 0 }, head: { line: 1, col: 0 }, top: null })
    expect(readStoredPosition('p1', 'f1')).toEqual(pos)
    expect(readStoredPosition('p1', 'f2')?.top).toBeNull()
    expect(readStoredPosition('p2', 'f1')).toBeNull()
    expect(readStoredPosition('p1', 'f3')).toBeNull()
  })

  it('ignores malformed or corrupt storage', () => {
    data.set('folio:editorpos:p1', JSON.stringify({
      good: { a: [2, 1], h: [2, 1], t: 1, at: 1 },
      zeroLine: { a: [0, 1], h: [2, 1], t: 1 },
      negativeCol: { a: [2, -1], h: [2, 1], t: null },
      fraction: { a: [2.5, 1], h: [2, 1], t: 3 },
      text: 'x',
    }))
    expect(readStoredPosition('p1', 'good')).toEqual({ anchor: { line: 2, col: 1 }, head: { line: 2, col: 1 }, top: 1 })
    for (const id of ['zeroLine', 'negativeCol', 'fraction', 'text']) expect(readStoredPosition('p1', id)).toBeNull()
    data.set('folio:editorpos:p1', '{not json')
    expect(readStoredPosition('p1', 'good')).toBeNull()
    storePosition('p1', 'f1', pos)
    expect(readStoredPosition('p1', 'f1')).toEqual(pos)
  })

  it('drops the entries of files that are no longer in the project', () => {
    storePosition('p1', 'gone', pos)
    storePosition('p1', 'kept', pos)
    storePosition('p1', 'new', pos, new Set(['kept', 'new']))
    expect(Object.keys(stored('p1')).sort()).toEqual(['kept', 'new'])
    // an empty list (files not loaded yet) prunes nothing
    storePosition('p1', 'other', pos, new Set())
    expect(Object.keys(stored('p1')).sort()).toEqual(['kept', 'new', 'other'])
  })

  it('keeps at most 60 files: the file just written and the most recently written others', () => {
    vi.useFakeTimers()
    for (let i = 0; i < 70; i++) {
      vi.setSystemTime(1_000 + i)
      storePosition('p1', `f${i}`, pos)
    }
    const ids = Object.keys(stored('p1'))
    expect(ids).toHaveLength(60)
    expect(ids).toContain('f69')
    expect(ids).toContain('f10')
    expect(ids).not.toContain('f9')
    // several writes within one millisecond never drop the file being written
    vi.setSystemTime(5_000)
    for (let i = 0; i < 70; i++) storePosition('p1', `g${i}`, pos)
    expect(Object.keys(stored('p1'))).toContain('g69')
  })
})
