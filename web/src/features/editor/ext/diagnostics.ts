/**
 * Compile-log diagnostics in the editor: entries of the last build's parsed log whose file is
 * the open document become @codemirror/lint diagnostics (gutter marker + underline + hover).
 * The underline is narrowed to the offending token where the log tells us: the `l.<n> …`
 * context of TeX errors (undefined control sequence → that command) or the key quoted in
 * undefined reference/citation warnings. Bad boxes are shown in the gutter only.
 */
import type { Text } from '@codemirror/state'
import type { Diagnostic } from '@codemirror/lint'
import type { LogEntry, ParsedLog } from '@folio/shared/api'

const MAX_DIAGNOSTICS = 400

function trimmedLine(doc: Text, n: number): { from: number; to: number } {
  const line = doc.line(n)
  const lead = /^\s*/.exec(line.text)![0].length
  const trail = /\s*$/.exec(line.text)![0].length
  const from = line.from + lead
  const to = Math.max(from, line.to - trail)
  return to > from ? { from, to } : { from: line.from, to: line.to }
}

/** The first command/word at `from` (for errors on very long lines without a precise column). */
function firstToken(doc: Text, from: number): { from: number; to: number } {
  const text = doc.sliceString(from, Math.min(doc.length, from + 200))
  const m = /^(?:\\[A-Za-z@]+\*?(?:\{[^{}\n]*\})?|\S+)/.exec(text)
  return { from, to: from + (m ? m[0].length : Math.min(1, text.length)) }
}

/** Narrow a TeX error to the token right before the error point shown in `l.<n> <context>`. */
function errorRange(entry: LogEntry, doc: Text, n: number): { from: number; to: number } | null {
  const m = /^l\.(\d+) (.*)$/m.exec(entry.content)
  if (!m || Number(m[1]) !== n) return null
  const context = m[2].replace(/\s+$/, '')
  if (!context) return null
  const line = doc.line(n)
  // TeX prints the line up to the error point; long lines are truncated at the front ("...")
  const probe = context.startsWith('...') ? context.slice(3) : context
  const at = line.text.indexOf(probe)
  if (at === -1) return null
  const end = at + probe.length
  const tail = line.text.slice(0, end)
  const cmd = /\\[A-Za-z@]+\*?$|\\.$/.exec(tail)
  const word = cmd ?? /[^\s{}[\]]+$/.exec(tail)
  if (!word) return null
  return { from: line.from + word.index, to: line.from + end }
}

/** Narrow an undefined reference/citation warning to the key in the source line. */
function keyRange(entry: LogEntry, doc: Text, n: number): { from: number; to: number } | null {
  const m = /[`']([^'`]+)'/.exec(entry.message)
  if (!m) return null
  const line = doc.line(n)
  const at = line.text.indexOf(m[1])
  if (at === -1) return null
  return { from: line.from + at, to: line.from + at + m[1].length }
}

function renderMessage(entry: LogEntry): () => Node {
  return () => {
    const root = document.createElement('div')
    root.className = 'ed-diag'
    const msg = document.createElement('div')
    msg.className = 'ed-diag__msg'
    msg.textContent = entry.message
    root.appendChild(msg)
    if (entry.hint) {
      const hint = document.createElement('div')
      hint.className = 'ed-diag__hint'
      hint.textContent = entry.hint
      root.appendChild(hint)
    }
    const src = document.createElement('div')
    src.className = 'ed-diag__src'
    const where = entry.lineEnd && entry.lineEnd !== entry.line ? `lines ${entry.line}–${entry.lineEnd}` : `line ${entry.line}`
    src.textContent = `${entry.source === 'latex' ? 'LaTeX' : entry.source === 'bibtex' ? 'BibTeX' : entry.source === 'biber' ? 'Biber' : 'latexmk'} · ${where}`
    root.appendChild(src)
    return root
  }
}

/** Diagnostics of `log` for the document at `path`. */
export function diagnosticsFor(log: ParsedLog | null | undefined, path: string, doc: Text): Diagnostic[] {
  if (!log) return []
  const out: Diagnostic[] = []
  const seen = new Set<string>()
  const groups: [LogEntry[], Diagnostic['severity']][] = [
    [log.errors, 'error'],
    [log.warnings, 'warning'],
    [log.typesetting, 'info'],
  ]
  for (const [entries, severity] of groups) {
    for (const e of entries) {
      if (out.length >= MAX_DIAGNOSTICS) return out
      if (e.file !== path || e.line === null || e.line < 1) continue
      const n = Math.min(e.line, doc.lines)
      const key = `${severity}:${n}:${e.message}`
      if (seen.has(key)) continue
      seen.add(key)
      let range: { from: number; to: number } | null = null
      if (severity === 'error') range = errorRange(e, doc, n)
      else if (severity === 'warning' && /undefined|multiply/i.test(e.message)) range = keyRange(e, doc, n)
      // bad boxes, and warnings without a precise location, are marked in the gutter only
      let quiet = severity === 'info'
      if (!range) {
        range = trimmedLine(doc, n)
        if (severity === 'warning') quiet = true
        else if (range.to - range.from > 160) range = firstToken(doc, range.from)
      }
      out.push({
        from: range.from,
        to: range.to,
        severity,
        message: e.hint ? `${e.message}\n${e.hint}` : e.message,
        renderMessage: renderMessage(e),
        ...(quiet ? { markClass: 'ed-lint-quiet' } : {}),
      })
    }
  }
  return out
}
