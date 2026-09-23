/**
 * Pure helpers for the history module: commit message format (summary + trailers) and
 * parsers for NUL-separated git output. No I/O here, so everything is unit-testable.
 *
 * Commit message format (written with `git commit --cleanup=whitespace -F -`):
 *
 *   <one-line human summary>
 *
 *   Folio-Reason: <HistoryReason>
 *   Folio-User-Ids: <id1>,<id2>,...            (omitted when nobody is credited)
 *   Folio-Restored-From: <sha> [<unix time>]   (restores: the version restored)
 *   Folio-Restored-Path: <path>                (single-file restores)
 *   Co-authored-by: <Name> <<email>>           (one per author after the first)
 *
 * The commit author is the first credited user (committer is always Folio), so
 * Folio-User-Ids[i] corresponds to [author, ...Co-authored-by][i] — used as a fallback for
 * users that have since been deleted.
 */
import type { FileChange, HistoryReason } from '@folio/shared/api'

export const HISTORY_REASONS: readonly HistoryReason[] = ['import', 'auto', 'restore', 'label', 'upload', 'file-op', 'manual', 'shutdown']

export const TRAILER_REASON = 'Folio-Reason'
export const TRAILER_USER_IDS = 'Folio-User-Ids'
export const TRAILER_CO_AUTHOR = 'Co-authored-by'
export const TRAILER_RESTORED_FROM = 'Folio-Restored-From'
export const TRAILER_RESTORED_PATH = 'Folio-Restored-Path'

/** ids that can safely go into the comma-separated trailer */
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/

export interface Ident {
  name: string
  email: string
}

export interface RestoredFrom {
  sha: string
  /** ms since epoch of the restored version (null when unknown) */
  time: number | null
  path?: string
}

export interface CommitMessageInput {
  summary: string
  reason: HistoryReason
  userIds: string[]
  coAuthors: Ident[]
  restoredFrom?: RestoredFrom
}

export interface ParsedCommitMessage {
  summary: string
  reason: HistoryReason
  userIds: string[]
  coAuthors: Ident[]
  restoredFrom?: RestoredFrom
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

/** One line, no control characters, bounded length. */
export function sanitizeLine(s: string, max = 200): string {
  const line = s.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  return line.length > max ? line.slice(0, max - 1).trimEnd() + '…' : line
}

/** A git identity that git accepts verbatim: no '<', '>', control chars; never empty. */
export function sanitizeIdent(name: string, email: string, fallbackId?: string): Ident {
  let n = sanitizeLine(name.replace(/[<>]/g, ''), 100).replace(/^[.,:;"'\\\s]+|[.,:;"'\\\s]+$/g, '')
  if (!n) n = 'Unknown'
  let e = email.replace(/[<>\s]/g, '').replace(CONTROL, '').slice(0, 200)
  if (!e) e = `${fallbackId && USER_ID_RE.test(fallbackId) ? fallbackId : 'unknown'}@users.folio.invalid`
  return { name: n, email: e }
}

export function isValidUserId(id: string): boolean {
  return USER_ID_RE.test(id)
}

export function buildCommitMessage(m: CommitMessageInput): string {
  const summary = sanitizeLine(m.summary) || 'Snapshot'
  const lines = [`${TRAILER_REASON}: ${m.reason}`]
  const ids = m.userIds.filter(isValidUserId)
  if (ids.length > 0) lines.push(`${TRAILER_USER_IDS}: ${ids.join(',')}`)
  const r = m.restoredFrom
  if (r && /^[0-9a-f]{40,64}$/.test(r.sha)) {
    lines.push(`${TRAILER_RESTORED_FROM}: ${r.sha}${r.time !== null && Number.isFinite(r.time) ? ` ${Math.round(r.time / 1000)}` : ''}`)
    // paths are validated project paths; anything that is not a clean single line is left out
    if (r.path && sanitizeLine(r.path, 1024) === r.path) lines.push(`${TRAILER_RESTORED_PATH}: ${r.path}`)
  }
  for (const c of m.coAuthors) {
    const id = sanitizeIdent(c.name, c.email)
    lines.push(`${TRAILER_CO_AUTHOR}: ${id.name} <${id.email}>`)
  }
  return `${summary}\n\n${lines.join('\n')}\n`
}

/** Parse a raw commit message (%B). Unknown/missing reason → 'auto'. */
export function parseCommitMessage(body: string): ParsedCommitMessage {
  const text = body.replace(/\r\n?/g, '\n').trim()
  const paragraphs = text.split(/\n[ \t]*\n/)
  const summary = (paragraphs[0] ?? '').split('\n')[0]?.trim() ?? ''
  let reason: HistoryReason = 'auto'
  const userIds: string[] = []
  const coAuthors: Ident[] = []
  let restoredFrom: RestoredFrom | undefined
  let restoredPath: string | undefined
  // Trailers live in the last paragraph (never the summary line itself).
  const trailerBlock = paragraphs.length > 1 ? paragraphs[paragraphs.length - 1] : ''
  for (const raw of trailerBlock.split('\n')) {
    const m = /^([A-Za-z0-9-]+)[ \t]*:[ \t]*(.*)$/.exec(raw.trim())
    if (!m) continue
    const key = m[1].toLowerCase()
    const value = m[2].trim()
    if (key === TRAILER_REASON.toLowerCase()) {
      if ((HISTORY_REASONS as string[]).includes(value)) reason = value as HistoryReason
    } else if (key === TRAILER_USER_IDS.toLowerCase()) {
      for (const id of value.split(',')) {
        const t = id.trim()
        if (isValidUserId(t) && !userIds.includes(t)) userIds.push(t)
      }
    } else if (key === TRAILER_CO_AUTHOR.toLowerCase()) {
      const im = /^(.*?)\s*<([^<>]*)>\s*$/.exec(value)
      if (im) coAuthors.push({ name: im[1].trim(), email: im[2].trim() })
      else if (value) coAuthors.push({ name: value, email: '' })
    } else if (key === TRAILER_RESTORED_FROM.toLowerCase()) {
      const rm = /^([0-9a-f]{40,64})(?:\s+(\d{1,12}))?$/.exec(value)
      if (rm) restoredFrom = { sha: rm[1], time: rm[2] ? Number(rm[2]) * 1000 : null }
    } else if (key === TRAILER_RESTORED_PATH.toLowerCase()) {
      if (value) restoredPath = value
    }
  }
  if (restoredFrom && restoredPath) restoredFrom.path = restoredPath
  return { summary, reason, userIds, coAuthors, ...(restoredFrom ? { restoredFrom } : {}) }
}

// ---------------------------------------------------------------------------
// git log
// ---------------------------------------------------------------------------

/**
 * `git log -z --name-status -M --format=LOG_FORMAT`: every record starts with \x1e, header fields
 * are separated by \x1f, the raw body is terminated by \x1f, then git prints NUL (and '\n' when
 * a diff follows) and the name-status tokens, each NUL-terminated.
 */
export const LOG_FORMAT = '%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%ct%x1f%B%x1f'

export interface LogRecord {
  sha: string
  parents: string[]
  authorName: string
  authorEmail: string
  /** ms since epoch (committer date) */
  time: number
  message: ParsedCommitMessage
  changes: FileChange[]
}

export function parseLog(out: string): LogRecord[] {
  const records: LogRecord[] = []
  for (const chunk of out.split('\x1e')) {
    if (!chunk) continue
    const fields: string[] = []
    let pos = 0
    // five header fields + body, each terminated by \x1f
    for (let i = 0; i < 6; i++) {
      const end = chunk.indexOf('\x1f', pos)
      if (end === -1) break
      fields.push(chunk.slice(pos, end))
      pos = end + 1
    }
    if (fields.length < 6 || !/^[0-9a-f]{40,64}$/.test(fields[0])) continue
    let rest = chunk.slice(pos)
    if (rest.startsWith('\0')) rest = rest.slice(1)
    if (rest.startsWith('\n')) rest = rest.slice(1)
    records.push({
      sha: fields[0],
      parents: fields[1].split(' ').filter(Boolean),
      authorName: fields[2],
      authorEmail: fields[3],
      time: Number(fields[4]) * 1000,
      message: parseCommitMessage(fields[5]),
      changes: parseNameStatus(rest),
    })
  }
  return records
}

/** Parse `--name-status -z` tokens: `S\0path\0` or `R<score>\0old\0new\0` / `C<score>\0src\0dst\0`. */
export function parseNameStatus(out: string): FileChange[] {
  const tokens = out.split('\0')
  const changes: FileChange[] = []
  let i = 0
  while (i < tokens.length) {
    const status = tokens[i++]
    if (!status) continue
    const code = status[0]
    if (code === 'R' || code === 'C') {
      const oldPath = tokens[i++]
      const newPath = tokens[i++]
      if (oldPath === undefined || newPath === undefined) break
      if (code === 'R') changes.push({ path: newPath, op: 'renamed', oldPath })
      else changes.push({ path: newPath, op: 'added' })
      continue
    }
    const p = tokens[i++]
    if (p === undefined) break
    if (code === 'A') changes.push({ path: p, op: 'added' })
    else if (code === 'D') changes.push({ path: p, op: 'deleted' })
    else changes.push({ path: p, op: 'modified' }) // M, T (type change), U, X
  }
  return changes
}

// ---------------------------------------------------------------------------
// ls-tree / cat-file
// ---------------------------------------------------------------------------

export interface TreeEntry {
  mode: string
  type: 'blob' | 'tree' | 'commit'
  oid: string
  /** bytes (blobs only; -1 otherwise) */
  size: number
  path: string
}

/** Parse `git ls-tree -r -z --long`: `<mode> SP <type> SP <oid> SP+ <size>\t<path>\0` */
export function parseLsTree(out: string): TreeEntry[] {
  const entries: TreeEntry[] = []
  for (const rec of out.split('\0')) {
    if (!rec) continue
    const tab = rec.indexOf('\t')
    if (tab === -1) continue
    const meta = rec.slice(0, tab).trim().split(/\s+/)
    if (meta.length < 3) continue
    const [mode, type, oid, size] = meta
    if (type !== 'blob' && type !== 'tree' && type !== 'commit') continue
    entries.push({ mode, type, oid, size: size && size !== '-' ? Number(size) : -1, path: rec.slice(tab + 1) })
  }
  return entries
}

export interface BatchObject {
  oid: string
  type: string
  size: number
  data: Buffer
}

/** Parse `git cat-file --batch` output (`<oid> <type> <size>\n<bytes>\n` per object; missing objects skipped). */
export function parseCatFileBatch(buf: Buffer): BatchObject[] {
  const out: BatchObject[] = []
  let pos = 0
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos)
    if (nl === -1) break
    const header = buf.subarray(pos, nl).toString('utf8')
    pos = nl + 1
    const m = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(header)
    if (!m) continue // "<name> missing" / "ambiguous"
    const size = Number(m[3])
    out.push({ oid: m[1], type: m[2], size, data: buf.subarray(pos, pos + size) })
    pos += size + 1
  }
  return out
}

/** Parse one line of `git cat-file --batch-check` output. */
export function parseBatchCheckLine(line: string): { oid: string; type: string; size: number } | null {
  const m = /^([0-9a-f]{40,64}) (\S+) (\d+)$/.exec(line.trim())
  return m ? { oid: m[1], type: m[2], size: Number(m[3]) } : null
}
