/**
 * @folio/shared/texlog — LaTeX / BibTeX / Biber / latexmk log parsing (browser-safe).
 *
 * Typical server use after a compile:
 *   const opts = { projectFiles, rootPath, getSource }
 *   const log = mergeLogs(parseLatexLog(logBytes, opts), parseBlg(blgText, opts), parseLatexmkOutput(stdout))
 *
 * Entries follow the LogEntry contract of api.ts: `file` is a project-relative path (or null
 * when the location is outside the project) and `line` is only set when the innermost file
 * of the message is that project file.
 *
 * Notes on the SPEC §5 signatures (supersets, no breaking deviation):
 *  - parseLatexLog also accepts the raw bytes (preferred: pdfTeX may split a UTF-8 character
 *    across a wrapped line) and the options `rootPath`, `getSource` (source lookups: the
 *    \usepackage line of a missing package, \bibitem/\label of duplicates, .bib keys) and
 *    `maxPrintLine` (default: auto-detect; Folio's own compiles are unwrapped).
 *  - With an empty `projectFiles` list every relative / compile-dir path counts as a project file.
 *  - Messages keep TeX's prefix ('Package natbib Warning: …', 'LaTeX Error: …'); undefined
 *    control sequences name the macro ('Undefined control sequence: \foo').
 *  - Each level is capped at MAX_ENTRIES_PER_LEVEL entries (+ one 'truncated-list' info entry)
 *    and each entry's content at MAX_ENTRY_CONTENT characters.
 */
import type { LogEntry, ParsedLog } from '../api.ts'

export { parseLatexLog, analyzeLatexLog, toLogEntry, MAX_ENTRIES_PER_LEVEL, MAX_ENTRY_CONTENT } from './latex.ts'
export type { LogParseOptions, LatexLogEntry, LatexLogAnalysis } from './latex.ts'
export { parseBibtexLog, parseBiberLog, parseBlg, analyzeBibtexLog, analyzeBiberLog } from './bib.ts'
export type { BibLogEntry } from './bib.ts'
export { parseLatexmkOutput, summarizeLatexmk } from './latexmk.ts'
export type { LatexmkSummary } from './latexmk.ts'
export { unwrapLog, unwrapLines, detectEngine } from './unwrap.ts'
export type { TexEngine, UnwrappedLog, UnwrapOptions } from './unwrap.ts'
export { LOG_HINTS, hintFor } from './hints.ts'
export type { LogHintRule } from './hints.ts'
export { PathMapper, DEFAULT_COMPILE_DIR } from './pathmap.ts'

/** Concatenate several parsed logs (e.g. .log + .blg), keeping each level in input order. */
export function mergeLogs(...logs: (ParsedLog | null | undefined)[]): ParsedLog {
  const out: ParsedLog = { errors: [], warnings: [], typesetting: [], info: [] }
  for (const l of logs) {
    if (!l) continue
    out.errors.push(...l.errors)
    out.warnings.push(...l.warnings)
    out.typesetting.push(...l.typesetting)
    out.info.push(...l.info)
  }
  return out
}

/** Total number of entries per level. */
export function countLog(log: ParsedLog): { errors: number; warnings: number; typesetting: number; info: number } {
  return { errors: log.errors.length, warnings: log.warnings.length, typesetting: log.typesetting.length, info: log.info.length }
}

/**
 * Collapse identical entries (same level, kind, message, file and line) for display,
 * e.g. 41 × "\headheight is too small". Order of first occurrence is kept.
 */
export function groupLogEntries(entries: LogEntry[]): { entry: LogEntry; count: number }[] {
  const map = new Map<string, { entry: LogEntry; count: number }>()
  for (const e of entries) {
    const key = `${e.level}\u0000${e.kind ?? ''}\u0000${e.message}\u0000${e.file ?? ''}\u0000${e.line ?? ''}`
    const g = map.get(key)
    if (g) g.count++
    else map.set(key, { entry: e, count: 1 })
  }
  return [...map.values()]
}
