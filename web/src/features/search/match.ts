/**
 * Pure helpers for the project search panel: build the same RegExp the server uses
 * (server/src/search/engine.ts), locate a match inside a server preview (previews of long lines
 * are windows that may start with '…', so the column is re-checked against the text) and clip a
 * preview around the match for the narrow rail panel.
 */
import type { SearchMatch } from '@folio/shared/api'

export interface SearchFlags {
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
}

function patternSource(q: string, f: SearchFlags): string {
  let source = f.regex ? q : q.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  if (f.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`
  return source
}

/** The query as a global RegExp (same semantics as the server), or null when it is invalid. */
export function buildSearchRegExp(q: string, f: SearchFlags): RegExp | null {
  try {
    return new RegExp(patternSource(q, f), `g${f.wholeWord ? 'u' : ''}${f.caseSensitive ? '' : 'i'}`)
  } catch {
    return null
  }
}

/** Human-readable problem with a regular expression query, or null when it is valid. */
export function regexProblem(q: string, f: SearchFlags): string | null {
  if (!f.regex || q === '') return null
  try {
    new RegExp(patternSource(q, f), `g${f.wholeWord ? 'u' : ''}`)
    return null
  } catch (e) {
    const msg = e instanceof Error ? e.message.replace(/^Invalid regular expression:\s*/, '') : String(e)
    return `Invalid regular expression: ${msg}`
  }
}

/** Server preview rule: long lines are cut to a window that starts 60 chars before the match. */
const PREVIEW_CONTEXT = 60

/** Position of the match inside `preview` ([start, end) in UTF-16 units). */
export function locateMatch(preview: string, m: SearchMatch, re: RegExp | null): { start: number; end: number } {
  const expected: number[] = []
  if (preview.startsWith('…')) expected.push(1 + m.column - Math.max(0, m.column - PREVIEW_CONTEXT))
  expected.push(m.column)
  if (re) {
    re.lastIndex = 0
    let best: { start: number; end: number; dist: number } | null = null
    let guard = 0
    for (let x = re.exec(preview); x && guard < 500; x = re.exec(preview), guard++) {
      if (x[0].length === 0) {
        re.lastIndex = x.index + 1
        continue
      }
      const idx = x.index
      const dist = Math.min(...expected.map(e => Math.abs(e - idx)))
      if (!best || dist < best.dist) best = { start: idx, end: idx + x[0].length, dist }
      if (dist === 0) break
    }
    re.lastIndex = 0
    if (best) return { start: best.start, end: best.end }
  }
  for (const e of expected) {
    if (e >= 0 && e + m.length <= preview.length) return { start: e, end: e + m.length }
  }
  return { start: 0, end: 0 }
}

export interface ClippedPreview {
  head: string
  match: string
  tail: string
}

/**
 * Split the preview into text before / the match / after, dropping leading indentation and
 * keeping at most `context` characters before the match (the start is cut at a word boundary
 * and marked with '…').
 */
export function clipPreview(preview: string, start: number, end: number, context = 28): ClippedPreview {
  let s = 0
  while (s < start && /\s/.test(preview[s])) s++
  let head = preview.slice(s, start)
  if (head.length > context) {
    let cut = start - context
    const space = preview.indexOf(' ', cut)
    if (space > cut && space < start - 8) cut = space + 1
    head = `…${preview.slice(cut, start)}`
  }
  return { head, match: preview.slice(start, end), tail: preview.slice(end) }
}

/** 'figures/plot.tex' → { dir: 'figures', base: 'plot.tex' } */
export function splitPath(path: string): { dir: string; base: string } {
  const i = path.lastIndexOf('/')
  return i < 0 ? { dir: '', base: path } : { dir: path.slice(0, i), base: path.slice(i + 1) }
}
