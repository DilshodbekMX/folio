/**
 * Helpers for presenting a ParsedLog: counts (shared by the PDF toolbar badges and the logs
 * tabs so both always agree with the API response), grouping of repeated entries, labels.
 */
import type { CompileResponse, LogEntry, LogLevel, OutputFile, ParsedLog } from '@folio/shared/api'

export interface LogCounts {
  errors: number
  warnings: number
  typesetting: number
  info: number
}

export const NO_COUNTS: LogCounts = { errors: 0, warnings: 0, typesetting: 0, info: 0 }

export function logCounts(log: ParsedLog | null | undefined): LogCounts {
  if (!log) return NO_COUNTS
  return {
    errors: log.errors.length,
    warnings: log.warnings.length,
    typesetting: log.typesetting.length,
    info: log.info.length,
  }
}

export type LogFilter = 'all' | 'errors' | 'warnings' | 'typesetting'

/** Entries shown for a filter, most severe first (info entries are listed separately). */
export function entriesFor(log: ParsedLog | null | undefined, filter: LogFilter): LogEntry[] {
  if (!log) return []
  switch (filter) {
    case 'errors':
      return log.errors
    case 'warnings':
      return log.warnings
    case 'typesetting':
      return log.typesetting
    default:
      return [...log.errors, ...log.warnings, ...log.typesetting]
  }
}

export interface EntryGroup {
  key: string
  entry: LogEntry
  /** how many identical entries were folded into this one */
  count: number
}

function entryKey(e: LogEntry): string {
  return `${e.level}\u0000${e.message}\u0000${e.file ?? ''}\u0000${e.line ?? ''}`
}

/** Fold identical entries (same level, message and location) into one, keeping first-seen order. */
export function groupEntries(entries: readonly LogEntry[]): EntryGroup[] {
  const groups: EntryGroup[] = []
  const byKey = new Map<string, EntryGroup>()
  for (const entry of entries) {
    const k = entryKey(entry)
    const g = byKey.get(k)
    if (g) {
      g.count++
      continue
    }
    const group = { key: `${k}\u0000${groups.length}`, entry, count: 1 }
    byKey.set(k, group)
    groups.push(group)
  }
  return groups
}

export const LEVEL_LABEL: Record<LogLevel, string> = {
  error: 'Error',
  warning: 'Warning',
  typesetting: 'Typesetting',
  info: 'Info',
}

/** 'antiddos_v2.tex, line 1545' / 'lines 12–14' / 'mdpi.cls'. */
export function locationLabel(e: LogEntry): string | null {
  if (!e.file) return null
  if (e.line == null) return e.file
  if (e.lineEnd != null && e.lineEnd !== e.line) return `${e.file}, lines ${e.line}–${e.lineEnd}`
  return `${e.file}, line ${e.line}`
}

/** latexmk/TeX bookkeeping that is never useful to download (like Overleaf, not listed) */
const HIDDEN_OUTPUT_TYPES = new Set(['fls', 'fdb_latexmk'])

/** Outputs offered for download (every file of the build except bookkeeping files). */
export function downloadableOutputFiles(res: CompileResponse | null): OutputFile[] {
  return res ? res.outputFiles.filter(f => !HIDDEN_OUTPUT_TYPES.has(f.type)) : []
}

/** Output files other than the main PDF, most useful first (.bbl like Overleaf, then logs). */
export function otherOutputFiles(res: CompileResponse | null): OutputFile[] {
  if (!res) return []
  const mainPdf = res.pdfUrl
  const rank = (f: OutputFile): number => {
    if (f.type === 'bbl') return 0
    if (f.url === res.logUrl) return 1
    if (f.type === 'log' || f.type === 'blg') return 2
    if (f.type === 'pdf') return 3
    return 4
  }
  return downloadableOutputFiles(res)
    .filter(f => f.url !== mainPdf)
    .sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path, undefined, { numeric: true }))
}

/** Text outputs that can be shown in the raw log viewer: main log first, then .blg and other logs. */
export function viewableLogFiles(res: CompileResponse | null): OutputFile[] {
  if (!res) return []
  const logs = res.outputFiles.filter(f => f.type === 'log' || f.type === 'blg')
  return logs.sort((a, b) => {
    const ra = a.url === res.logUrl ? 0 : a.type === 'blg' ? 1 : 2
    const rb = b.url === res.logUrl ? 0 : b.type === 'blg' ? 1 : 2
    return ra - rb || a.path.localeCompare(b.path, undefined, { numeric: true })
  })
}
