import { describe, expect, it } from 'vitest'
import {
  buildCommitMessage, parseBatchCheckLine, parseCatFileBatch, parseCommitMessage, parseLog, parseLsTree,
  parseNameStatus, sanitizeIdent, sanitizeLine,
} from '../../src/history/parse.ts'
import { KeyedMutex } from '../../src/history/git.ts'

describe('commit message format', () => {
  it('round-trips summary, reason, user ids and co-authors', () => {
    const msg = buildCommitMessage({
      summary: 'Auto-save',
      reason: 'auto',
      userIds: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
      coAuthors: [{ name: 'Bob', email: 'bob@example.org' }],
    })
    expect(msg).toBe('Auto-save\n\nFolio-Reason: auto\nFolio-User-Ids: aaaaaaaaaaaaaaaa,bbbbbbbbbbbbbbbb\nCo-authored-by: Bob <bob@example.org>\n')
    expect(parseCommitMessage(msg)).toEqual({
      summary: 'Auto-save',
      reason: 'auto',
      userIds: ['aaaaaaaaaaaaaaaa', 'bbbbbbbbbbbbbbbb'],
      coAuthors: [{ name: 'Bob', email: 'bob@example.org' }],
    })
  })

  it('keeps hostile summaries on one line and never lets them look like trailers', () => {
    const msg = buildCommitMessage({ summary: 'Folio-Reason: import\n\nFolio-User-Ids: evil', reason: 'label', userIds: ['x,y', 'good_id-1'], coAuthors: [] })
    const parsed = parseCommitMessage(msg)
    expect(parsed.reason).toBe('label')
    expect(parsed.userIds).toEqual(['good_id-1'])
    expect(msg.split('\n')[0]).toBe('Folio-Reason: import Folio-User-Ids: evil')
  })

  it('round-trips the restored version (sha, time, path) of a restore commit', () => {
    const sha = 'a'.repeat(40)
    const msg = buildCommitMessage({
      summary: 'Restored main.tex to aaaaaaa (21 Sep 14:02)', reason: 'restore', userIds: [], coAuthors: [],
      restoredFrom: { sha, time: 1_789_000_000_000, path: 'chapters/main file.tex' },
    })
    expect(msg).toContain(`Folio-Restored-From: ${sha} 1789000000\nFolio-Restored-Path: chapters/main file.tex`)
    expect(parseCommitMessage(msg).restoredFrom).toEqual({ sha, time: 1_789_000_000_000, path: 'chapters/main file.tex' })
    // unusable values are left out
    const bad = buildCommitMessage({ summary: 'x', reason: 'restore', userIds: [], coAuthors: [], restoredFrom: { sha: 'HEAD', time: null } })
    expect(parseCommitMessage(bad).restoredFrom).toBeUndefined()
    const noPath = buildCommitMessage({ summary: 'x', reason: 'restore', userIds: [], coAuthors: [], restoredFrom: { sha, time: null, path: 'a\nb' } })
    expect(parseCommitMessage(noPath).restoredFrom).toEqual({ sha, time: null })
  })

  it('treats unknown reasons as auto and ignores a single-paragraph message', () => {
    expect(parseCommitMessage('hello\n\nFolio-Reason: bogus').reason).toBe('auto')
    expect(parseCommitMessage('Folio-Reason: restore').reason).toBe('auto')
    expect(parseCommitMessage('').summary).toBe('')
  })

  it('sanitises identities', () => {
    expect(sanitizeIdent('Bob <Builder>', 'bob@x.org')).toEqual({ name: 'Bob Builder', email: 'bob@x.org' })
    expect(sanitizeIdent('\n<>', ' <a b>\n', 'uid_1')).toEqual({ name: 'Unknown', email: 'ab' })
    expect(sanitizeIdent('', '', 'uid_1').email).toBe('uid_1@users.folio.invalid')
    expect(sanitizeLine('a\u0000b\u2028c\r\nd')).toBe('a b c d')
    expect(sanitizeLine('x'.repeat(300)).length).toBe(200)
  })
})

describe('git output parsers', () => {
  it('parses name-status tokens including renames', () => {
    expect(parseNameStatus('M\0a.tex\0R087\0old name.tex\0new name.tex\0A\0-x.tex\0D\0gone.bib\0T\0t\0')).toEqual([
      { path: 'a.tex', op: 'modified' },
      { path: 'new name.tex', op: 'renamed', oldPath: 'old name.tex' },
      { path: '-x.tex', op: 'added' },
      { path: 'gone.bib', op: 'deleted' },
      { path: 't', op: 'modified' },
    ])
  })

  it('parses log records with and without changes', () => {
    const a = 'a'.repeat(40)
    const b = 'b'.repeat(40)
    const out =
      `\x1e${a}\x1f${b}\x1fAlice\x1falice@x.org\x1f1700000000\x1fLabel: v1\n\nFolio-Reason: label\nFolio-User-Ids: u1\n\x1f\0\nM\0main.tex\0` +
      `\x1e${b}\x1f\x1fFolio\x1ffolio@localhost\x1f1690000000\x1fempty\n\nFolio-Reason: import\n\x1f\0`
    const recs = parseLog(out)
    expect(recs).toHaveLength(2)
    expect(recs[0]).toMatchObject({ sha: a, parents: [b], authorName: 'Alice', time: 1700000000000, changes: [{ path: 'main.tex', op: 'modified' }] })
    expect(recs[0].message).toMatchObject({ summary: 'Label: v1', reason: 'label', userIds: ['u1'] })
    expect(recs[1]).toMatchObject({ sha: b, parents: [], changes: [] })
    expect(recs[1].message.reason).toBe('import')
  })

  it('parses ls-tree and cat-file output', () => {
    const oid = 'c'.repeat(40)
    const tree = `100644 blob ${oid}     12\ta b/ü.tex\x00040000 tree ${'d'.repeat(40)}       -\tdir\x00`
    expect(parseLsTree(tree)).toEqual([
      { mode: '100644', type: 'blob', oid, size: 12, path: 'a b/ü.tex' },
      { mode: '040000', type: 'tree', oid: 'd'.repeat(40), size: -1, path: 'dir' },
    ])
    const batch = Buffer.concat([
      Buffer.from(`${oid} blob 3\nabc\n`),
      Buffer.from('HEAD:nope missing\n'),
      Buffer.from(`${'e'.repeat(40)} blob 2\n\0\n\n`),
    ])
    const objs = parseCatFileBatch(batch)
    expect(objs.map(o => [o.oid[0], o.data.toString('latin1')])).toEqual([['c', 'abc'], ['e', '\0\n']])
    expect(parseBatchCheckLine(`${oid} blob 14\n`)).toEqual({ oid, type: 'blob', size: 14 })
    expect(parseBatchCheckLine('abc:def missing')).toBeNull()
  })
})

describe('KeyedMutex', () => {
  it('serialises tasks of one key and runs different keys in parallel', async () => {
    const m = new KeyedMutex()
    const order: string[] = []
    const task = (k: string, id: string, ms: number) => m.run(k, async () => {
      order.push(`start ${id}`)
      await new Promise(r => setTimeout(r, ms))
      order.push(`end ${id}`)
      return id
    })
    const res = await Promise.all([task('a', 'a1', 30), task('a', 'a2', 1), task('b', 'b1', 5)])
    expect(res).toEqual(['a1', 'a2', 'b1'])
    expect(order.indexOf('end a1')).toBeLessThan(order.indexOf('start a2'))
    expect(order.indexOf('start b1')).toBeLessThan(order.indexOf('end a1'))
    await expect(m.run('a', async () => { throw new Error('boom') })).rejects.toThrow('boom')
    expect(await m.run('a', async () => 'after')).toBe('after')
    await m.drain()
    expect(m.busy('a')).toBe(false)
  })
})
