/**
 * The diff behind the history's unified diffs (PERF-1).
 *
 * @codemirror/merge compares characters and, in a merge view, gives up early (scanLimit 500):
 * once an edited stretch of a large file cannot be split by a shared substring, the whole
 * stretch becomes ONE change. A replace-all of 28 words in the 200 KB paper showed as
 * "1 change +1420 −1420". Here the texts are first compared line by line (every distinct line
 * becomes one character, so the paper is a 1 700-character comparison), then only the changed
 * stretches of lines are compared character by character. Everything runs on the main thread,
 * so both steps share a time budget: past it, a changed stretch is reported as whole changed
 * lines (coarser, never wrong) instead of freezing the tab on a pathological comparison.
 *
 * Pure module (no DOM): used by DiffViewer through `HISTORY_DIFF_CONFIG`.
 */
import { Change, diff, type DiffConfig } from '@codemirror/merge'

/** time for the whole comparison (line pass + character passes), ms */
const BUDGET_MS = 2_000
/** part of the budget the line pass may use */
const LINE_PASS_MS = 1_000
/** character pass inside one changed stretch of lines */
const INNER_SCAN_LIMIT = 10_000
/** without usable line structure (more distinct lines than one UTF-16 unit can name) */
const FALLBACK: DiffConfig = { scanLimit: INNER_SCAN_LIMIT, timeout: BUDGET_MS }

/** distinct lines that get one UTF-16 code unit each (surrogates skipped, 0 unused) */
const MAX_DISTINCT_LINES = 0xffff - 0x800 - 1

function codeFor(id: number): number {
  const c = id + 1
  return c < 0xd800 ? c : c + 0x800
}

/** Offsets where each line starts (lines keep their '\n'; the last one may be empty). */
export function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

/** One character per line, the same character for equal lines (null: too many distinct lines). */
function encodeLines(text: string, starts: number[], ids: Map<string, number>): string | null {
  const codes: number[] = new Array(starts.length)
  for (let k = 0; k < starts.length; k++) {
    const line = text.slice(starts[k], k + 1 < starts.length ? starts[k + 1] : text.length)
    let id = ids.get(line)
    if (id === undefined) {
      if (ids.size >= MAX_DISTINCT_LINES) return null
      id = ids.size
      ids.set(line, id)
    }
    codes[k] = codeFor(id)
  }
  let out = ''
  for (let i = 0; i < codes.length; i += 4096) out += String.fromCharCode(...codes.slice(i, i + 4096))
  return out
}

/**
 * Changes between `a` and `b` (sorted, non-overlapping, offsets into the full texts): a line
 * diff first, then a character diff inside each changed stretch of lines.
 */
export function lineFirstDiff(a: string, b: string): readonly Change[] {
  const deadline = Date.now() + BUDGET_MS
  const startsA = lineStarts(a)
  const startsB = lineStarts(b)
  const ids = new Map<string, number>()
  const linesA = encodeLines(a, startsA, ids)
  const linesB = linesA === null ? null : encodeLines(b, startsB, ids)
  if (linesA === null || linesB === null) return diff(a, b, FALLBACK)
  const offset = (starts: number[], text: string, line: number) => (line < starts.length ? starts[line] : text.length)
  const out: Change[] = []
  for (const block of diff(linesA, linesB, { timeout: LINE_PASS_MS })) {
    const fromA = offset(startsA, a, block.fromA)
    const toA = offset(startsA, a, block.toA)
    const fromB = offset(startsB, b, block.fromB)
    const toB = offset(startsB, b, block.toB)
    const left = deadline - Date.now()
    // pure insertions/deletions of lines, or out of time: the stretch as it is
    if (fromA === toA || fromB === toB || left <= 0) {
      out.push(new Change(fromA, toA, fromB, toB))
      continue
    }
    for (const c of diff(a.slice(fromA, toA), b.slice(fromB, toB), { scanLimit: INNER_SCAN_LIMIT, timeout: left })) {
      out.push(new Change(c.fromA + fromA, c.toA + fromA, c.fromB + fromB, c.toB + fromB))
    }
  }
  return out
}

/** `diffConfig` for unifiedMergeView in the history and the recovered-text comparison. */
export const HISTORY_DIFF_CONFIG: DiffConfig = { override: lineFirstDiff }
