/**
 * BibTeX (0.99e) and Biber (2.x) .blg parsers.
 * Formats verified on TeX Live 2026 (docs/research/logparse.md). Biber 2.22 reports syntax
 * errors against a hashed temp file (/tmp/biber_tmp_xxxx/<md5>_1.utf8), so the data source is
 * tracked from "Found BibTeX data source '…'" instead; its line numbers equal the .bib lines.
 */
import type { LogEntry, ParsedLog } from '../api.ts'
import { hintFor } from './hints.ts'
import { bucket, type LogParseOptions } from './latex.ts'
import { DEFAULT_COMPILE_DIR, PathMapper, SourceCache, escapeRegExp, findInSources } from './pathmap.ts'

export interface BibLogEntry extends LogEntry {
  /** 1-based line in the .blg */
  logLine: number
  /** bibliography key the message is about, when known */
  key?: string
}

type BibOptions = Pick<LogParseOptions, 'projectFiles' | 'compileDir' | 'getSource'>

function splitLines(text: string): string[] {
  const t = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
  return t.replace(/\r\n?/g, '\n').split('\n')
}

class BibContext {
  readonly mapper: PathMapper
  readonly bibFiles: string[]
  readonly texFiles: string[]
  /** .bib files named by the log (project paths), searched first */
  readonly databases: string[] = []

  readonly opts: BibOptions
  readonly sources: SourceCache

  constructor(opts: BibOptions) {
    this.opts = opts
    this.sources = new SourceCache(opts.getSource)
    this.mapper = new PathMapper(opts.projectFiles ?? [], opts.compileDir ?? DEFAULT_COMPILE_DIR)
    this.bibFiles = (opts.projectFiles ?? []).filter(f => /\.bib$/i.test(f))
    this.texFiles = (opts.projectFiles ?? []).filter(f => /\.(?:tex|ltx|latex)$/i.test(f))
  }

  /** project path for a file name printed by BibTeX/Biber (relative to the compile dir); tries adding .bib */
  project(raw: string | null | undefined): string | null {
    if (!raw) return null
    return this.mapper.toProjectPath(raw) ?? (/\.bib$/i.test(raw) ? null : this.mapper.toProjectPath(raw + '.bib'))
  }

  addDatabase(raw: string): void {
    const p = this.project(raw)
    if (p && !this.databases.includes(p)) this.databases.push(p)
  }

  private bibOrder(preferred?: string | null): string[] {
    const out: string[] = []
    for (const f of [preferred ?? null, ...this.databases, ...this.bibFiles]) if (f && !out.includes(f)) out.push(f)
    return out
  }

  /** location of `@type{key,` in the .bib files; `nth` = 2 finds the second definition (duplicates) */
  findKey(key: string, preferred?: string | null, nth = 1): { file: string; line: number } | null {
    if (!this.sources.available) return null
    const re = new RegExp(`^[ \\t]*@\\s*\\w+\\s*[{(]\\s*${escapeRegExp(key)}\\s*(?:,|$)`, 'gm')
    let seen = 0
    for (const f of this.bibOrder(preferred)) {
      const text = this.sources.text(f)
      if (text === null) continue
      re.lastIndex = 0
      for (let m = re.exec(text); m; m = re.exec(text)) {
        if (++seen === nth) return { file: f, line: text.slice(0, m.index).split('\n').length }
      }
    }
    return null
  }

  /** first \cite-like command in the .tex sources mentioning `key` */
  findCite(key: string): { file: string; line: number } | null {
    const re = new RegExp(`\\\\[A-Za-z]*cite[A-Za-z]*\\*?\\s*(?:\\[[^\\]]*\\]\\s*){0,2}\\{[^}]*(?<![\\w:.-])${escapeRegExp(key)}(?![\\w:.-])[^}]*\\}`)
    return findInSources(this.texFiles, this.sources, re)
  }
}

function makeEntry(
  source: 'bibtex' | 'biber',
  level: 'error' | 'warning',
  message: string,
  content: string,
  logLine: number,
  loc: { file: string | null; line: number | null },
  kind: string,
  key?: string,
): BibLogEntry {
  const e: BibLogEntry = { level, message, content, file: loc.file, line: loc.line, source, kind, logLine }
  if (key) e.key = key
  const hint = hintFor({ message, kind })
  if (hint) e.hint = hint
  return e
}

/** Detailed BibTeX .blg entries in log order. */
export function analyzeBibtexLog(text: string, opts: BibOptions): BibLogEntry[] {
  const L = splitLines(text)
  const ctx = new BibContext(opts)
  const out: BibLogEntry[] = []
  const NONE = { file: null, line: null }
  for (let i = 0; i < L.length; i++) {
    const l = L[i]
    let m: RegExpExecArray | null
    if ((m = /^Database file #\d+: (.+)$/.exec(l))) {
      ctx.addDatabase(m[1])
      continue
    }
    // Warning--message  [+ "--line N of file F"]
    if ((m = /^Warning--(.*)$/.exec(l))) {
      const msg = m[1]
      const loc = /^--line (\d+) of file (.+)$/.exec(L[i + 1] ?? '')
      if (loc) {
        const file = ctx.project(loc[2])
        out.push(makeEntry('bibtex', 'warning', msg, `${l}\n${L[i + 1]}`, i + 1,
          { file, line: file ? Number(loc[1]) : null }, 'bibtex-warning'))
        i++
        continue
      }
      const missing = /^I didn't find a database entry for "([^"]+)"$/.exec(msg)
      if (missing) {
        out.push(makeEntry('bibtex', 'warning', msg, l, i + 1, ctx.findCite(missing[1]) ?? NONE, 'undefined-citation', missing[1]))
        continue
      }
      const inKey = / in (\S+)$/.exec(msg)
      const key = inKey?.[1]
      out.push(makeEntry('bibtex', 'warning', msg, l, i + 1, (key && ctx.findKey(key)) || NONE, 'bibtex-warning', key))
      continue
    }
    // <message>---line N of file F … I'm skipping whatever remains of this entry|command
    if ((m = /^(.*)---line (\d+) of file (.+)$/.exec(l))) {
      let msg = m[1]
      const block = [l]
      if (msg === '' && i > 0) msg = L[i - 1]
      let j = i + 1
      let prevLine = false
      while (j < L.length && j - i < 12) {
        const c = L[j]
        if (/^I'm skipping whatever remains of this (?:entry|command)$/.test(c)) {
          block.push(c)
          j++
          break
        }
        if (/^\(Error may have been on previous line\)$/.test(c)) prevLine = true
        else if (!/^ : /.test(c) && !/^ :\s*$/.test(c)) break
        block.push(c)
        j++
      }
      if (prevLine) msg += ' (the error may be on the previous line)'
      const file = ctx.project(m[3])
      out.push(makeEntry('bibtex', 'error', msg, block.join('\n'), i + 1, { file, line: file ? Number(m[2]) : null }, 'bibtex-error'))
      i = j - 1
      continue
    }
    if ((m = /^(.*)---while reading file (.+)$/.exec(l))) {
      const file = ctx.project(m[2])
      out.push(makeEntry('bibtex', 'error', m[1] || l, l, i + 1, { file, line: null }, 'bibtex-error'))
      continue
    }
    if ((m = /^while executing---line (\d+) of file (.+)$/.exec(l))) {
      const msg = L[i - 1] ?? l
      // .bst errors: the file is a style, usually not part of the project
      const file = ctx.project(m[2])
      out.push(makeEntry('bibtex', 'error', msg, `${msg}\n${l}`, i, { file, line: file ? Number(m[1]) : null }, 'bibtex-error'))
      continue
    }
    if ((m = /^A bad cross reference---entry "([^"]+)"$/.exec(l))) {
      const next = L[i + 1] ?? ''
      out.push(makeEntry('bibtex', 'error', `${l} ${next}`.trim(), `${l}\n${next}`, i + 1, ctx.findKey(m[1]) ?? NONE, 'bibtex-error', m[1]))
      i++
      continue
    }
    if ((m = /^I couldn't open (database|style|auxiliary) file (.+)$/.exec(l))) {
      out.push(makeEntry('bibtex', 'error', l, l, i + 1, { file: null, line: null }, 'missing-file'))
      continue
    }
  }
  return out
}

/** Detailed Biber .blg entries in log order. */
export function analyzeBiberLog(text: string, opts: BibOptions): BibLogEntry[] {
  const L = splitLines(text)
  const ctx = new BibContext(opts)
  const out: BibLogEntry[] = []
  const HEAD = /^(?:\[\d+\] [^>]*> )?(INFO|WARN|ERROR|FATAL) - (.*)$/
  let dataSource: string | null = null
  for (let i = 0; i < L.length; i++) {
    const m = HEAD.exec(L[i])
    if (!m) continue
    const [, lvl, msgRaw] = m
    let msg = msgRaw
    // multi-line messages continue on lines without a level prefix
    const block = [L[i]]
    while (i + 1 < L.length && L[i + 1] !== '' && !HEAD.test(L[i + 1]) && !/^\[\d+\] /.test(L[i + 1])) {
      block.push(L[++i])
      msg += ' ' + L[i].trim()
    }
    const ds = /^Found BibTeX data source '(.+)'$/.exec(msg)
    if (ds) {
      dataSource = ds[1]
      ctx.addDatabase(ds[1])
      continue
    }
    if (lvl === 'INFO') continue
    const level: 'error' | 'warning' = lvl === 'WARN' ? 'warning' : 'error'
    const logLine = i + 1 - (block.length - 1)
    let loc: { file: string | null; line: number | null } = { file: null, line: null }
    let key: string | undefined
    let message = msg
    let kind = level === 'error' ? 'biber-error' : 'biber-warning'
    let sm: RegExpExecArray | null
    if ((sm = /^BibTeX subsystem: (.+?), line (\d+), (.*)$/.exec(msg))) {
      const file = ctx.project(/biber_tmp|_\d+\.utf8$/.test(sm[1]) ? dataSource : sm[1]) ?? ctx.project(dataSource)
      loc = { file, line: file ? Number(sm[2]) : null }
      message = sm[3]
    } else if ((sm = /^Duplicate entry key: '([^']+)' in file '([^']+)'/.exec(msg))) {
      key = sm[1]
      const file = ctx.project(sm[2])
      loc = ctx.findKey(key, file, 2) ?? ctx.findKey(key, file) ?? { file, line: null }
      kind = 'duplicate-entry'
    } else if ((sm = /^I didn't find a database entry for '([^']+)'/.exec(msg))) {
      key = sm[1]
      loc = ctx.findCite(key) ?? loc
      kind = 'undefined-citation'
    } else if ((sm = /[Ee]ntry '([^']+)' \(([^)]+)\)/.exec(msg))) {
      key = sm[1]
      const file = ctx.project(sm[2])
      loc = ctx.findKey(key, file) ?? { file, line: null }
    } else if ((sm = /[Ee]ntry '([^']+)'/.exec(msg))) {
      key = sm[1]
      loc = ctx.findKey(key) ?? loc
    } else if (/^Cannot find (?:file )?'[^']+'/.test(msg)) {
      kind = 'missing-file'
    } else if (lvl === 'FATAL' && dataSource) {
      // e.g. "Caught signal: SEGV  Likely your .bib has a very bad entry…": blame the current data source
      loc = { file: ctx.project(dataSource), line: null }
    }
    out.push(makeEntry('biber', level, message, block.join('\n'), logLine, loc, kind, key))
  }
  return out
}

export function parseBibtexLog(text: string, opts: BibOptions): ParsedLog {
  return bucket(analyzeBibtexLog(text, opts))
}

export function parseBiberLog(text: string, opts: BibOptions): ParsedLog {
  return bucket(analyzeBiberLog(text, opts))
}

/** Parse a .blg, choosing BibTeX or Biber from its first line. */
export function parseBlg(text: string, opts: BibOptions): ParsedLog {
  const first = splitLines(text.slice(0, 400))[0] ?? ''
  if (/INFO - This is Biber/.test(first)) return parseBiberLog(text, opts)
  return parseBibtexLog(text, opts)
}
