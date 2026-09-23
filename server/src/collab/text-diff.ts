/**
 * Minimal-edit application of a new text onto a live Y.Text.
 *
 * Every server-side text change (disk reconcile on load, history restore, uploads, REST writes)
 * goes through applyTextDiff so the CRDT history is kept and collaborators' concurrent edits in
 * untouched regions survive. Never replace a Y.Doc/Y.Text wholesale.
 *
 * Diff strategy (bounded cost — fast-diff is O(N·D) and has no deadline):
 *   1. strip the common prefix/suffix (never splitting a UTF-16 surrogate pair);
 *   2. small middle → character diff with fast-diff;
 *   3. large middle → line diff (jsdiff diffArrays with an edit-length cap and a timeout), each
 *      changed hunk refined with fast-diff while it is small and the time budget lasts;
 *   4. anything beyond the budget → one delete + one insert of the middle.
 */
import fastDiff from 'fast-diff'
import { diffArrays } from 'diff'
import type * as Y from 'yjs'

export type DiffOp = [-1 | 0 | 1, string]

/** middle size (old + new UTF-16 units) up to which a direct character diff is used */
const CHAR_DIFF_LIMIT = 4000
/** changed line hunks up to this size (old + new) are refined to character level */
const HUNK_REFINE_LIMIT = 2000
const LINE_DIFF_MAX_EDITS = 10_000
const DIFF_TIME_BUDGET_MS = 250

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff

function splitLines(s: string): string[] {
  return s.match(/[^\n]*\n|[^\n]+/g) ?? []
}

function pushOp(ops: DiffOp[], op: -1 | 0 | 1, s: string): void {
  if (s.length === 0) return
  const last = ops[ops.length - 1]
  if (last && last[0] === op) last[1] += s
  else ops.push([op, s])
}

function charDiff(ops: DiffOp[], a: string, b: string): void {
  for (const [op, s] of fastDiff(a, b)) pushOp(ops, op, s)
}

function diffMiddle(ops: DiffOp[], a: string, b: string, deadline: number): void {
  if (a.length === 0) return pushOp(ops, 1, b)
  if (b.length === 0) return pushOp(ops, -1, a)
  if (a.length + b.length <= CHAR_DIFF_LIMIT) return charDiff(ops, a, b)

  const budget = Math.max(1, Math.floor(deadline - performance.now()))
  const parts = diffArrays(splitLines(a), splitLines(b), { maxEditLength: LINE_DIFF_MAX_EDITS, timeout: budget })
  if (!parts) {
    pushOp(ops, -1, a)
    pushOp(ops, 1, b)
    return
  }
  let del = ''
  let ins = ''
  const flushHunk = () => {
    if (del && ins && del.length + ins.length <= HUNK_REFINE_LIMIT && performance.now() < deadline) {
      charDiff(ops, del, ins)
    } else {
      pushOp(ops, -1, del)
      pushOp(ops, 1, ins)
    }
    del = ''
    ins = ''
  }
  for (const part of parts) {
    const text = part.value.join('')
    if (part.removed) del += text
    else if (part.added) ins += text
    else {
      flushHunk()
      pushOp(ops, 0, text)
    }
  }
  flushHunk()
}

/** Edit script turning `a` into `b` (EQUAL/DELETE runs consume `a`, EQUAL/INSERT runs build `b`). */
export function diffTexts(a: string, b: string): DiffOp[] {
  const ops: DiffOp[] = []
  if (a === b) {
    pushOp(ops, 0, a)
    return ops
  }
  let start = 0
  const min = Math.min(a.length, b.length)
  while (start < min && a.charCodeAt(start) === b.charCodeAt(start)) start++
  if (start > 0 && isHigh(a.charCodeAt(start - 1))) start--
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--
    endB--
  }
  if (endA < a.length && isLow(a.charCodeAt(endA))) {
    // the suffix would start with the low half of a pair whose high half differs: move that
    // (identical) unit into the middle
    endA++
    endB++
  }
  pushOp(ops, 0, a.slice(0, start))
  diffMiddle(ops, a.slice(start, endA), b.slice(start, endB), performance.now() + DIFF_TIME_BUDGET_MS)
  pushOp(ops, 0, a.slice(endA))
  return ops
}

/**
 * Turn `ytext` into `next` with a minimal set of deletes/inserts. Runs inside one Yjs
 * transaction (joining the caller's transaction when there is one — e.g.
 * `doc.transact(() => applyTextDiff(t, s), 'server')`; otherwise `origin` is used).
 * The caller is responsible for normalising `next` (normalizeText). Returns true when the
 * text changed.
 */
export function applyTextDiff(ytext: Y.Text, next: string, origin: unknown = null): boolean {
  const current = ytext.toString()
  if (current === next) return false
  const ops = diffTexts(current, next)
  const apply = () => {
    let pos = 0
    for (const [op, s] of ops) {
      if (op === 0) pos += s.length
      else if (op === -1) ytext.delete(pos, s.length)
      else {
        ytext.insert(pos, s)
        pos += s.length
      }
    }
  }
  if (ytext.doc) ytext.doc.transact(apply, origin)
  else apply()
  return true
}
