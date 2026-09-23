import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import { applyTextDiff, diffTexts } from '../../src/collab/index.ts'

function seeded(seed: number): () => number {
  let x = seed >>> 0 || 1
  return () => {
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    return (x >>> 0) / 0x100000000
  }
}

const ALPHABET = ['a', 'b', 'c', ' ', '\n', '\\', '{', '}', 'é', '😀', '中', 'x', 'y']

function randomText(rand: () => number, n: number): string {
  let s = ''
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)]
  return s
}

/** Random edits at code-point boundaries (never splits a surrogate pair). */
function mutate(rand: () => number, s: string, edits: number): string {
  let cps = [...s]
  for (let i = 0; i < edits; i++) {
    const pos = Math.floor(rand() * (cps.length + 1))
    const r = rand()
    if (r < 0.4) cps.splice(pos, Math.floor(rand() * 5))
    else if (r < 0.8) cps.splice(pos, 0, ...randomText(rand, 1 + Math.floor(rand() * 6)))
    else cps.splice(pos, Math.floor(rand() * 3), ...randomText(rand, Math.floor(rand() * 4)))
  }
  return cps.join('')
}

function ytextWith(content: string): Y.Text {
  const doc = new Y.Doc()
  const t = doc.getText('content')
  t.insert(0, content)
  return t
}

function assertScript(a: string, b: string): void {
  const ops = diffTexts(a, b)
  expect(ops.filter(o => o[0] !== 1).map(o => o[1]).join('')).toBe(a)
  expect(ops.filter(o => o[0] !== -1).map(o => o[1]).join('')).toBe(b)
}

describe('applyTextDiff', () => {
  it('produces exactly the target text for random edits (incl. astral characters)', () => {
    const rand = seeded(42)
    for (let i = 0; i < 400; i++) {
      const a = randomText(rand, Math.floor(rand() * 200))
      const b = mutate(rand, a, 1 + Math.floor(rand() * 6))
      const t = ytextWith(a)
      applyTextDiff(t, b)
      expect(t.toString()).toBe(b)
      assertScript(a, b)
    }
  })

  it('never splits surrogate pairs at the prefix/suffix boundary', () => {
    const cases: [string, string][] = [
      ['a😀b', 'a😁b'], ['😀', '😁'], ['x😀', 'x😁'], ['😀x', '😁x'], ['a😀', 'a😁'],
      ['', '😀'], ['😀', ''], ['😀😀', '😀'], ['ab', 'a😀b'],
    ]
    for (const [a, b] of cases) {
      for (const op of diffTexts(a, b)) {
        const s = op[1]
        expect(/^[\uDC00-\uDFFF]/.test(s) || /[\uD800-\uDBFF]$/.test(s), JSON.stringify([a, b, op])).toBe(false)
      }
      const t = ytextWith(a)
      applyTextDiff(t, b)
      expect(t.toString()).toBe(b)
    }
  })

  it('is a no-op for equal text and reports whether it changed anything', () => {
    const t = ytextWith('same')
    let updates = 0
    t.doc!.on('update', () => updates++)
    expect(applyTextDiff(t, 'same')).toBe(false)
    expect(updates).toBe(0)
    expect(applyTextDiff(t, 'same!')).toBe(true)
    expect(updates).toBe(1)
  })

  it('applies all edits in one transaction and joins an enclosing transaction origin', () => {
    const t = ytextWith('one two three four five')
    const origins: unknown[] = []
    t.doc!.on('update', (_u: Uint8Array, origin: unknown) => origins.push(origin))
    t.doc!.transact(() => applyTextDiff(t, 'ONE two three four FIVE'), 'server')
    expect(t.toString()).toBe('ONE two three four FIVE')
    expect(origins).toEqual(['server'])
  })

  it('keeps edits minimal on large documents (line diff + character refinement)', () => {
    const rand = seeded(7)
    const lines: string[] = []
    for (let i = 0; i < 3000; i++) lines.push(`Line ${i}: ${randomText(rand, 40)}`)
    const a = lines.join('\n')
    const edited = [...lines]
    for (const i of [10, 700, 1500, 2999]) edited[i] = edited[i].replace('Line', 'LINE')
    const b = edited.join('\n')
    const ops = diffTexts(a, b)
    const changed = ops.filter(o => o[0] !== 0).reduce((n, o) => n + o[1].length, 0)
    expect(changed).toBeLessThanOrEqual(4 * 8)
    const t = ytextWith(a)
    applyTextDiff(t, b)
    expect(t.toString()).toBe(b)
  })

  it('stays fast for completely different large texts', () => {
    const rand = seeded(9)
    const a = randomText(rand, 150_000)
    const b = randomText(rand, 150_000)
    const started = performance.now()
    const t = ytextWith(a)
    applyTextDiff(t, b)
    expect(t.toString()).toBe(b)
    expect(performance.now() - started).toBeLessThan(5000)
  })

  it('preserves concurrent edits of another replica in untouched regions', () => {
    const base = 'AAA\nBBB\nCCC\nDDD\nEEE\n'
    const server = new Y.Doc()
    server.getText('content').insert(0, base)
    const client = new Y.Doc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
    // client edits CCC while the server replaces BBB and DDD (computed from the old base)
    const ct = client.getText('content')
    ct.delete(base.indexOf('CCC'), 3)
    ct.insert(base.indexOf('CCC'), 'client')
    server.transact(() => applyTextDiff(server.getText('content'), base.replace('BBB', 'bbb').replace('DDD', 'ddd')), 'server')
    Y.applyUpdate(server, Y.encodeStateAsUpdate(client))
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server))
    expect(server.getText('content').toString()).toBe('AAA\nbbb\nclient\nddd\nEEE\n')
    expect(client.getText('content').toString()).toBe(server.getText('content').toString())
  })
})
