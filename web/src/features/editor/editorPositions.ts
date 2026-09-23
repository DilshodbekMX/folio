/**
 * Cursor and scroll position of each file, remembered across reloads and visits (J-3), like
 * the open file ('folio:openFile:<pid>') and the PDF position ('folio:pdfpos:<pid>').
 *
 * localStorage 'folio:editorpos:<pid>' holds { [fileId]: { a, h, t, at } }: anchor and head as
 * [line, column] (1-based line, 0-based column), the first visible line (null: not scrolled)
 * and when it was written. Line/column rather than Yjs positions: the text may have changed
 * meanwhile, and a position near the old place is what the author wants back. Entries of files
 * that are gone are dropped on the next write, and only the most recent MAX_FILES are kept.
 * Within a session SourceEditor's in-memory state (exact Yjs positions) takes precedence.
 */
import { isRecord, readJSON, writeJSON } from '../../lib/storage'

export interface LineCol { line: number; col: number }
export interface StoredPosition { anchor: LineCol; head: LineCol; top: number | null }

interface Entry { a: [number, number]; h: [number, number]; t: number | null; at: number }

const MAX_FILES = 60
const key = (projectId: string) => `folio:editorpos:${projectId}`

const isLine = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 1
const isCol = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0
const isPair = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && isLine(v[0]) && isCol(v[1])

function sanitize(v: unknown): Record<string, Entry> | undefined {
  if (!isRecord(v)) return undefined
  const out: Record<string, Entry> = {}
  for (const [id, e] of Object.entries(v)) {
    if (!isRecord(e) || !isPair(e.a) || !isPair(e.h) || !(e.t === null || isLine(e.t))) continue
    out[id] = { a: e.a, h: e.h, t: e.t, at: typeof e.at === 'number' ? e.at : 0 }
  }
  return out
}

function readAll(projectId: string): Record<string, Entry> {
  return readJSON(key(projectId), {}, sanitize)
}

/** The remembered position of a file, if any. */
export function readStoredPosition(projectId: string, fileId: string): StoredPosition | null {
  const e = readAll(projectId)[fileId]
  if (!e) return null
  return { anchor: { line: e.a[0], col: e.a[1] }, head: { line: e.h[0], col: e.h[1] }, top: e.t }
}

/**
 * Remember a file's position. `known` (the project's current file ids, when loaded) drops the
 * entries of deleted files; the oldest entries beyond MAX_FILES go too.
 */
export function storePosition(projectId: string, fileId: string, pos: StoredPosition, known?: ReadonlySet<string>): void {
  const entry: Entry = { a: [pos.anchor.line, pos.anchor.col], h: [pos.head.line, pos.head.col], t: pos.top, at: Date.now() }
  // this file first, then the most recent others (never the one just written dropped by the cap)
  const others = Object.entries(readAll(projectId))
    .filter(([id]) => id !== fileId && (!known || known.size === 0 || known.has(id)))
    .sort((x, y) => y[1].at - x[1].at)
    .slice(0, MAX_FILES - 1)
  writeJSON(key(projectId), Object.fromEntries([[fileId, entry], ...others]))
}
