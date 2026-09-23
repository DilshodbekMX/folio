/**
 * Word count with texcount (SPEC §4.5 "wordCount"), run in the sandbox against the synced
 * compile directory (mounted read-only). `-inc` follows \input/\include; with more than one file
 * texcount prints a block per file and then a "File(s) total" block — that total is what we
 * report. `-utf8`: every text file in a Folio project is UTF-8.
 */
import type { WordCountResponse } from '@folio/shared/api'

export function texcountArgv(rootFileName: string): string[] {
  return ['texcount', '-nocol', '-inc', '-utf8', rootFileName]
}

type Counts = Omit<WordCountResponse, 'rootPath' | 'raw'>

const FIELDS: [RegExp, keyof Counts][] = [
  [/^Words in text:\s*(\d+)/, 'textWords'],
  [/^Words in headers:\s*(\d+)/, 'headerWords'],
  [/^Words outside text \(captions, etc\.\):\s*(\d+)/, 'captionWords'],
  [/^Number of headers:\s*(\d+)/, 'headers'],
  [/^Number of floats\/tables\/figures:\s*(\d+)/, 'floats'],
  [/^Number of math inlines:\s*(\d+)/, 'mathInline'],
  [/^Number of math displayed:\s*(\d+)/, 'mathDisplay'],
]

/** Parse texcount's default (non-brief) output; the "File(s) total" block wins when present. */
export function parseTexcount(raw: string): Counts {
  const lines = raw.replace(/\r\n?/g, '\n').split('\n').map(l => l.trim())
  const totalAt = lines.findIndex(l => /^File\(s\) total:/.test(l))
  const block = totalAt >= 0 ? lines.slice(totalAt + 1) : lines
  const counts: Counts = { textWords: 0, headerWords: 0, captionWords: 0, headers: 0, floats: 0, mathInline: 0, mathDisplay: 0 }
  const seen = new Set<keyof Counts>()
  for (const line of block) {
    for (const [re, key] of FIELDS) {
      if (seen.has(key)) continue
      const m = re.exec(line)
      if (m) {
        counts[key] = Number(m[1])
        seen.add(key)
      }
    }
    if (seen.size === FIELDS.length) break
  }
  return counts
}

/** True when the output contains at least one counter (i.e. texcount actually counted something). */
export function looksLikeTexcount(raw: string): boolean {
  return /^Words in text:\s*\d+/m.test(raw)
}
