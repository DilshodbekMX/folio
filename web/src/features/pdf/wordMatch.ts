/**
 * PDF → code column refinement (pure, no DOM/app imports so it can be tested in Node).
 *
 * SyncTeX records lines, not columns, and the line it reports is often not the clicked word's
 * line: engines tag many boxes with the line where the paragraph ends (the blank line or the
 * last source line of a multi-line paragraph). We therefore look for the double-clicked word in
 * a window around that line — the nearest lines first, then upwards to the start of the
 * paragraph (or, when SyncTeX answered with an \end{…} line, to the \begin of that table or
 * list) — in passes of decreasing strictness:
 *   1. whole word, same case   2. whole word, any case   3. substring, any case (hyphenation)
 * A stricter pass on ANY candidate line beats a looser one on a nearer line (so 'repaired' is
 * not matched inside 'unrepaired' of the next paragraph). Within a pass, the hit whose preceding
 * words agree best with the PDF text before the click wins; ties go to the nearest line.
 */

export interface WordPosition {
  /** 1-based line */
  line: number
  /** 0-based column */
  column: number
}

/** how far upwards the search may extend to reach the start of a paragraph */
export const MAX_PARAGRAPH_LINES = 40
/** … or the \begin of an environment whose \end line SyncTeX answered with */
export const MAX_ENVIRONMENT_LINES = 80

const LETTER = /[\p{L}\p{N}]/u
/** lines that start a new block: the paragraph cannot continue above them */
const BLOCK_START = /^\s*\\(?:begin|end|item|(?:sub)*section|chapter|paragraph|subparagraph|part|caption|par)\b/
const END_ENV = /^\s*\\end\{([^}]+)\}/

export function normalizeWord(w: string): string {
  // PDF text uses ligatures (ﬁ, ﬂ) and typographic punctuation; strip what cannot be in the source
  return w.normalize('NFKC').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** how many words before the clicked one are compared to tell repeated words apart */
const CONTEXT_WORDS = 3

/** The last CONTEXT_WORDS words of the PDF text before the clicked word (lower-case, oldest first). */
export function previousWords(before: string): string[] {
  const words = before.normalize('NFKC').match(/[\p{L}\p{N}]+/gu) ?? []
  return words.slice(-CONTEXT_WORDS).map(w => w.toLowerCase())
}

/** Words of source text, ignoring LaTeX commands, braces and comments. */
function sourceWords(text: string): string[] {
  const plain = text
    .replace(/(?<!\\)%.*$/, '')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/[{}[\]~$\\]/g, ' ')
  return plain.match(/[\p{L}\p{N}]+/gu) ?? []
}

/**
 * The last CONTEXT_WORDS words of the source before `index` on line `n` (1-based), continuing on
 * the previous lines of the same paragraph (lower-case, oldest first).
 */
function sourcePreviousWords(lines: readonly string[], n: number, index: number): string[] {
  let words = sourceWords(lines[n - 1].slice(0, index))
  for (let k = n - 1; words.length < CONTEXT_WORDS && k >= 1 && k > n - 4; k--) {
    const text = lines[k - 1]
    if (text.trim() === '') break
    words = [...sourceWords(text), ...words]
  }
  return words.slice(-CONTEXT_WORDS).map(w => w.toLowerCase())
}

/** How many of the words right before the hit agree with the PDF (counted from the hit backwards). */
function contextScore(pdf: readonly string[], source: readonly string[]): number {
  let score = 0
  for (let i = pdf.length - 1, j = source.length - 1; i >= 0 && j >= 0 && pdf[i] === source[j]; i--, j--) score++
  return score
}

/**
 * Lines to search, nearest first: the SyncTeX line, ±1, ±2, then upwards to the start of the
 * paragraph (the line after a blank line, or a \begin/\item/\section… line), at most
 * MAX_PARAGRAPH_LINES above the SyncTeX line — or, when that line is an \end{env} line, up to
 * the matching \begin{env} (at most MAX_ENVIRONMENT_LINES).
 */
export function candidateLines(lines: readonly string[], line: number): number[] {
  const out: number[] = []
  const seen = new Set<number>()
  const add = (n: number) => {
    if (n < 1 || n > lines.length || seen.has(n)) return
    seen.add(n)
    out.push(n)
  }
  for (const d of [0, -1, 1, -2, 2]) add(line + d)
  // SyncTeX often answers with the blank line that ends the paragraph: start above it
  let n = line
  if (lines[n - 1] !== undefined && lines[n - 1].trim() === '') n--
  const env = lines[n - 1] !== undefined ? END_ENV.exec(lines[n - 1]) : null
  if (env) {
    // tables and lists are typeset at their end: SyncTeX answers with the \end{…} line, so the
    // whole environment (rows, \items) up to its \begin{…} is searched
    const begin = `\\begin{${env[1]}}`
    for (let k = 0; n >= 1 && k < MAX_ENVIRONMENT_LINES; n--, k++) {
      add(n)
      if (k > 0 && lines[n - 1].includes(begin)) break
    }
    return out
  }
  for (let k = 0; n >= 1 && k < MAX_PARAGRAPH_LINES; n--, k++) {
    const text = lines[n - 1]
    if (text.trim() === '') break
    add(n)
    if (BLOCK_START.test(text)) break
  }
  return out
}

type Matcher = (text: string, word: string) => number[]

const wholeWord = (flags: string): Matcher => (text, word) => {
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}(?![\\p{L}\\p{N}])`, flags)
  return [...text.matchAll(re)].map(m => m.index ?? 0)
}

const substring: Matcher = (text, word) => {
  const out: number[] = []
  const lower = text.toLowerCase()
  const w = word.toLowerCase()
  for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + 1)) out.push(i)
  return out
}

const PASSES: Matcher[] = [wholeWord('gu'), wholeWord('giu'), substring]

/**
 * Where the double-clicked `rawWord` is in the source, given SyncTeX's `line` (1-based) and the
 * PDF text before the word (`before`, to tell repeated words apart). null when the word is not
 * found near that line (the caller then keeps SyncTeX's line).
 */
export function refineWordPosition(lines: readonly string[], line: number, rawWord: string, before: string): WordPosition | null {
  const word = normalizeWord(rawWord)
  if (word.length < 2 || !LETTER.test(word)) return null
  const candidates = candidateLines(lines, line)
  const context = previousWords(before)
  for (const match of PASSES) {
    let best: WordPosition | null = null
    let bestScore = -1
    for (const n of candidates) {
      const text = lines[n - 1]
      for (const column of match(text, word)) {
        const score = context.length > 0 ? contextScore(context, sourcePreviousWords(lines, n, column)) : 0
        // nearest line first: only a better context match replaces an earlier hit
        if (score > bestScore) {
          best = { line: n, column }
          bestScore = score
          if (score === context.length) return best
        }
      }
    }
    if (best) return best
  }
  return null
}
