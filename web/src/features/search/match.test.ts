/**
 * The search panel re-locates each match inside the server's preview (long lines come back as a
 * window starting with '…', PREVIEW_CONTEXT characters before the match). These tests run the
 * server's own engine on real text, so a change to its preview window breaks them (ACC-12).
 */
import { describe, expect, it } from 'vitest'
import type { SearchFileResult, SearchMatch } from '@folio/shared/api'
import { buildSearchRegExp, clipPreview, locateMatch, regexProblem, type SearchFlags } from './match'

// loaded at run time: the web typecheck must not pull the server's (Node) sources in
const ENGINE = new URL('../../../../server/src/search/engine.ts', import.meta.url).pathname
const { searchFiles } = (await import(/* @vite-ignore */ ENGINE)) as {
  searchFiles(files: { fileId: string; path: string; text: string }[], opts: SearchFlags & { q: string; maxMatches: number }): Promise<{ results: SearchFileResult[] }>
}

const FLAGS: SearchFlags = { regex: false, caseSensitive: false, wholeWord: false }

async function search(text: string, q: string, flags: Partial<SearchFlags> = {}): Promise<{ line: string; m: SearchMatch }[]> {
  const f = { ...FLAGS, ...flags }
  const out = await searchFiles([{ fileId: 'f', path: 'main.tex', text }], { q, ...f, maxMatches: 1000 })
  const lines = text.split('\n')
  return (out.results[0]?.matches ?? []).map(m => ({ line: lines[m.line - 1], m }))
}

/** The located range is the very occurrence the server reported (same text, same column). */
function expectLocated(line: string, m: SearchMatch, q: string, flags: Partial<SearchFlags> = {}) {
  const re = buildSearchRegExp(q, { ...FLAGS, ...flags })
  const { start, end } = locateMatch(m.preview, m, re)
  expect(m.preview.slice(start, end)).toBe(line.slice(m.column, m.column + m.length))
  if (m.preview.startsWith('…')) {
    // the text before it in the window is the text before that column in the line
    expect(line.slice(m.column - (start - 1), m.column)).toBe(m.preview.slice(1, start))
  } else {
    expect(start).toBe(m.column)
  }
  const clipped = clipPreview(m.preview, start, end)
  expect(clipped.match).toBe(line.slice(m.column, m.column + m.length))
  return { start, end }
}

describe('locateMatch against the server engine', () => {
  it('finds the query in the middle of a 1000-character line (a "…" window)', async () => {
    const line = `${'lorem ipsum dolor '.repeat(28)}NEEDLE${' sit amet consectetur'.repeat(22)}`.slice(0, 1000)
    const hits = await search(`intro\n${line}\noutro`, 'needle')
    expect(hits).toHaveLength(1)
    expect(hits[0].m.preview.startsWith('…')).toBe(true)
    expectLocated(hits[0].line, hits[0].m, 'needle')
  })

  it('picks the reported occurrence among repeats in the same window', async () => {
    const line = `${'x'.repeat(300)} foo foo foo ${'y'.repeat(20)} foo ${'z'.repeat(400)}`
    const hits = await search(line, 'foo')
    expect(hits).toHaveLength(4)
    for (const h of hits) expectLocated(h.line, h.m, 'foo')
  })

  it('a match near the start of a long line keeps the line start', async () => {
    const line = `\\section{Needle} ${'text '.repeat(200)}`
    const [h] = await search(line, 'needle')
    expect(h.m.preview.startsWith('…')).toBe(false)
    expectLocated(h.line, h.m, 'needle')
  })

  it('agrees for case-sensitive, whole-word and regex queries', async () => {
    const line = `${'a'.repeat(250)} Label label labels \\label{sec:intro} ${'b'.repeat(250)}`
    for (const h of await search(line, 'label', { caseSensitive: true, wholeWord: true })) expectLocated(h.line, h.m, 'label', { caseSensitive: true, wholeWord: true })
    const re = String.raw`\\label\{[^}]+\}`
    const hits = await search(line, re, { regex: true })
    expect(hits).toHaveLength(1)
    const { start, end } = expectLocated(hits[0].line, hits[0].m, re, { regex: true })
    expect(hits[0].m.preview.slice(start, end)).toBe('\\label{sec:intro}')
  })

  it('short lines come back whole', async () => {
    const [h] = await search('  Some \\emph{short} line', 'short')
    expect(h.m.preview).toBe('  Some \\emph{short} line')
    const { start, end } = expectLocated(h.line, h.m, 'short')
    // leading indentation is dropped from the clipped preview
    expect(clipPreview(h.m.preview, start, end)).toEqual({ head: 'Some \\emph{', match: 'short', tail: '} line' })
  })
})

describe('regexProblem', () => {
  it('reports invalid regular expressions only in regex mode', () => {
    expect(regexProblem('a(b', { ...FLAGS, regex: true })).toMatch(/^Invalid regular expression/)
    expect(regexProblem('a(b', FLAGS)).toBeNull()
    expect(buildSearchRegExp('a(b', FLAGS)?.test('xa(bx')).toBe(true)
  })
})
