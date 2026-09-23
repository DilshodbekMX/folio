/**
 * LaTeX (.log) parser: errors, warnings and bad boxes linked to project file + line.
 *
 * Single pass over logical (unwrapped) lines. Each line is checked in priority order —
 * fatal banner, error ('! ' or file:line:error), runaway, bad box, warning, missing character,
 * invalid UTF-8, pdfTeX warning — and a matching handler consumes its whole block, so the
 * parentheses inside user text (box content, error context, help text) never reach the file
 * stack. Every other line is scanned for '(' / ')' to maintain the stack of open input files.
 * Algorithm and regexes: docs/research/logparse.md (validated on real TeX Live 2026 logs).
 */
import type { LogEntry, LogLevel, ParsedLog } from '../api.ts'
import { hintFor } from './hints.ts'
import { DEFAULT_COMPILE_DIR, PathMapper, SourceCache, escapeRegExp, findInSources, type SourceGetter } from './pathmap.ts'
import { unwrapLines, type TexEngine } from './unwrap.ts'

export interface LogParseOptions {
  /** project-relative paths of all project files (decides what is a project file; resolves names with spaces/parentheses) */
  projectFiles: string[]
  /** directory TeX ran in, as TeX saw it (default '/compile') */
  compileDir?: string
  /** project path of the compiled root document (used for enrichment) */
  rootPath?: string | null
  /** current text of a project file; enables source lookups (missing-package line, duplicate \bibitem / \label, .bib keys) */
  getSource?: SourceGetter
  /** wrap width of the log; default auto-detect (Folio's own compiles are unwrapped) */
  maxPrintLine?: number
}

/** LogEntry plus parser details (log position, raw file name, page, package). */
export interface LatexLogEntry extends LogEntry {
  /** 1-based physical line in the .log where the message starts */
  logLine: number
  /** innermost file frame exactly as printed in the log (may be a system file) */
  rawFile: string | null
  /** page being built when the message was printed (best effort) */
  page: number | null
  package?: string
  /** an error that follows from a previous one (e.g. 'Emergency stop') */
  secondary?: boolean
}

export interface LatexLogAnalysis {
  engine: TexEngine
  /** all entries in log order */
  entries: LatexLogEntry[]
  /** pages in the output ('Output written on … (N pages') — 0 for 'No pages of output', null if unknown */
  pages: number | null
  /** file frames still open at the end of the log (raw names, outermost first) */
  finalStack: string[]
  /** unmatched '(' that were not file names, still open at the end */
  openParens: number
  /** the log reached TeX's final statistics */
  complete: boolean
  /** project path of the first file TeX opened */
  rootFile: string | null
}

type Frame = { kind: 'file'; raw: string; project: string | null } | { kind: 'paren' }

const RE = {
  fatal: /^(?:!|.+:\d+:)\s+==> Fatal error occurred/,
  texError: /^! ?(.*)$/,
  fle: /^((?:\.{1,2}\/|\/|[A-Za-z]:[\\/])[^:]*?|[^\s:()]+\.(?:tex|ltx|latex|sty|cls|bbl|aux|def|cfg|clo|fd|dtx|tikz|pgf|toc|lof|lot|out|ind|gls|nav|snm|vrb|w18)):(\d+): (.*)$/,
  notFle: /^(?:Package|Class|Module|LaTeX)\b/,
  lineRef: /^l\.(\d+)(?: (.*))?$/,
  runaway: /^Runaway (?:argument|definition|preamble|text)\?\s*$/,
  badbox: /^(Overfull|Underfull|Tight|Loose) \\([hv])box \((?:badness (\d+)|(-?\d+(?:\.\d+)?)pt too (?:wide|high))\) (?:(?:in paragraph|in alignment) at lines (\d+)--(\d+)|detected at line (\d+)|has occurred while \\output is active)/,
  warnHead: /^(?:(Package|Class|Module) ([^\s:]+)|(LaTeX3?)(?: ([A-Za-z]+))?) [Ww]arning(?: \(([^)]*)\))?: ?(.*)$/,
  pdftexWarn: /pdfTeX warning(?: \(([^)]*)\))?: ?(.*)$/,
  pdftexError: /^!\s*pdfTeX error(?: \(([^)]*)\))?: ?(.*)$/,
  missingChar: /^!? ?Missing character: There is no (.+?) (?:\(U\+([0-9A-F]{4,6})\) )?in font (.+?)[!.]$/,
  invalidUtf8: /^Invalid UTF-8 byte or sequence at line (\d+) replaced by U\+FFFD\.?$/,
  onInputLine: /\bon input line (\d+)\.?\s*$/,
  undefRef: /^(Reference|Citation|Hyper reference) [`']([^']*)' on page (\S+) undefined/,
  multiply: /(Label|Citation|Reference) [`']([^']*)' multiply defined/,
  rerun: /Rerun to get|Please \(re\)run|Please rerun|may have changed|has changed\. Rerun|Rerun LaTeX/,
  summary: /^There were (?:undefined (?:references|citations)|multiply[- ]defined (?:labels|citations))\.?$|^Some font shapes were not available, defaults substituted\.?$/,
  cont: /^\(([A-Za-z][\w@.\-]*)\)(\s+)(.*)$/,
  infoCont: /^\([A-Za-z][\w@.\-]*\)\s{2,}/,
  noFile: /^No file (.+)\.$/,
  outputWritten: /^Output written on .+ \((\d+) pages?\b/,
  noPages: /^No pages of output\.?$/,
  memory: /^Here is how much of TeX's memory you used/,
  pageMark: /\[(\d+)(?:\.\d+)*(?=[\s\]{<]|$)/g,
  lazyPath: /^((?:\.{1,2}\/|\/|[A-Za-z]:[\\/])[^\n]*?\.[A-Za-z0-9_-]{1,12})(?=[\s)"]|$)/,
  slashPath: /^((?:[A-Za-z]:)?[^\s()"[\]{}<>]*\/[^\s()"[\]{}<>]*)/,
  quoted: /^"([^"]+)"/,
}

/** Lines that start a new log message (used to end help text). */
const NEW_MSG = /^(?:! |\(|\)|\[\d|(?:LaTeX3?|Package \S+|Class \S+|Module \S+)(?: \w+)? (?:Warning|Error|Info)\b|LaTeX2e <|L3 programming layer <|(?:Over|Under)full |Missing character|No file |\\openout|File: |Package: |Document Class:|\*\*\*|Here is how much|Output written|Runaway |pdfTeX warning|[^\s:]+:\d+: )/

const MAX_ERROR_SCAN = 40
const MAX_BOX_LINES = 200

function norm(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function isBlank(s: string): boolean {
  return s.trim() === ''
}

export function analyzeLatexLog(input: string | Uint8Array, opts: LogParseOptions): LatexLogAnalysis {
  const mapper = new PathMapper(opts.projectFiles ?? [], opts.compileDir ?? DEFAULT_COMPILE_DIR)
  const { lines, lineNo, engine } = unwrapLines(input, { maxPrintLine: opts.maxPrintLine })
  const n = lines.length
  const entries: LatexLogEntry[] = []
  const stack: Frame[] = []
  let rootFile: string | null = null
  let lastShipped = 0
  let pages: number | null = null
  let complete = false
  let pendingRunaway: { lines: string[]; at: number } | null = null
  let lastError: LatexLogEntry | null = null
  let lastErrorEnd = -1

  const innermostFile = (): Extract<Frame, { kind: 'file' }> | null => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const f = stack[k]
      if (f.kind === 'file') return f
    }
    return null
  }
  const innermostProject = (): string | null => {
    for (let k = stack.length - 1; k >= 0; k--) {
      const f = stack[k]
      if (f.kind === 'file' && f.project) return f.project
    }
    return null
  }

  /** file/line for a message: the line is kept only when the file it belongs to is a project file */
  const locate = (line: number | null, explicitRaw?: string | null): { file: string | null; line: number | null; rawFile: string | null } => {
    if (explicitRaw) {
      const p = mapper.toProjectPath(explicitRaw)
      if (p) return { file: p, line, rawFile: explicitRaw }
      return { file: innermostProject(), line: null, rawFile: explicitRaw }
    }
    const f = innermostFile()
    if (f?.project) return { file: f.project, line, rawFile: f.raw }
    return { file: innermostProject(), line: null, rawFile: f?.raw ?? null }
  }

  const add = (e: Omit<LatexLogEntry, 'source' | 'page' | 'hint'>): LatexLogEntry => {
    const entry: LatexLogEntry = { ...e, source: 'latex', page: lastShipped + 1 }
    const hint = hintFor({ message: entry.message, kind: entry.kind })
    if (hint) entry.hint = hint
    entries.push(entry)
    return entry
  }

  const pushFile = (raw: string, project?: string | null) => {
    const proj = project !== undefined ? project : mapper.toProjectPath(raw)
    stack.push({ kind: 'file', raw, project: proj })
    if (rootFile === null && !stack.some((f, k) => k < stack.length - 1 && f.kind === 'file')) rootFile = proj
  }

  const scanParens = (s: string) => {
    let pos = 0
    while (pos < s.length) {
      const open = s.indexOf('(', pos)
      const close = s.indexOf(')', pos)
      if (open === -1 && close === -1) return
      if (close !== -1 && (open === -1 || close < open)) {
        const top = stack.pop()
        // never pop the last file frame (the root): a stray ')' must not empty the stack
        if (top && top.kind === 'file' && !stack.some(f => f.kind === 'file')) stack.push(top)
        pos = close + 1
        continue
      }
      const rest = s.slice(open + 1)
      let consumed = 0
      const known = mapper.matchKnown(rest)
      if (known) {
        pushFile(rest.slice(0, known.consumed).replace(/^"|"$/g, ''), known.path)
        consumed = known.consumed
      } else {
        let m = RE.quoted.exec(rest)
        let raw: string | null = null
        if (m) raw = m[1]
        else if ((m = RE.lazyPath.exec(rest))) raw = m[1]
        else if ((m = RE.slashPath.exec(rest))) raw = m[1]
        if (m && raw) {
          pushFile(raw)
          consumed = m[0].length
        } else {
          stack.push({ kind: 'paren' })
        }
      }
      pos = open + 1 + consumed
    }
  }

  const trackPages = (s: string) => {
    RE.pageMark.lastIndex = 0
    for (let m = RE.pageMark.exec(s); m; m = RE.pageMark.exec(s)) lastShipped = Number(m[1])
  }

  const scanText = (s: string) => {
    const t = s.replace(RE.infoCont, '')
    trackPages(t)
    scanParens(t)
  }

  let i = 0
  while (i < n) {
    const line = lines[i]
    const ln = lineNo[i]
    let m: RegExpExecArray | null

    if (line.length === 0) {
      i++
      continue
    }

    if (RE.fatal.test(line)) {
      i++
      continue
    }

    // ---------------------------------------------------------------- errors
    let fleRaw: string | null = null
    let fleLine: number | null = null
    let errText: string | null = null
    let pdftexCategory: string | undefined
    if ((m = RE.pdftexError.exec(line))) {
      errText = `pdfTeX error${m[1] ? ` (${m[1]})` : ''}: ${m[2]}`
      pdftexCategory = m[1]
    } else if (line.startsWith('!')) {
      m = RE.texError.exec(line)
      errText = m ? m[1] : line.slice(1)
    } else if (!RE.notFle.test(line) && (m = RE.fle.exec(line))) {
      fleRaw = m[1]
      fleLine = Number(m[2])
      errText = m[3]
    }
    if (errText !== null) {
      i = parseError(i, errText, fleRaw, fleLine, pdftexCategory)
      continue
    }

    if (RE.runaway.test(line)) {
      const runLines = [line]
      if (i + 1 < n && !NEW_MSG.test(lines[i + 1])) runLines.push(lines[i + 1])
      pendingRunaway = { lines: runLines, at: i + runLines.length }
      i += runLines.length
      continue
    }

    // ---------------------------------------------------------------- bad boxes
    if ((m = RE.badbox.exec(line))) {
      const [, what, hv, , , a, b, det] = m
      const block = [line]
      let j = i + 1
      if (!/has occurred while \\output is active/.test(line) || !/\[\]\s*$/.test(line)) {
        while (j < n && !isBlank(lines[j]) && j - i < MAX_BOX_LINES) block.push(lines[j++])
      }
      const first = a ? Number(a) : det ? Number(det) : null
      const loc = locate(first)
      const kind = `${what.toLowerCase()}-${hv}box`
      add({
        level: 'typesetting', kind, message: norm(line), content: block.join('\n'),
        file: loc.file, line: loc.line, lineEnd: b && loc.line !== null ? Number(b) : null,
        logLine: ln, rawFile: loc.rawFile,
      })
      i = j
      continue
    }

    // ---------------------------------------------------------------- warnings
    if ((m = RE.warnHead.exec(line))) {
      i = parseWarning(i, m)
      continue
    }

    if ((m = RE.missingChar.exec(line))) {
      const loc = locate(null)
      add({ level: 'warning', kind: 'missing-character', message: norm(line), content: line, file: loc.file, line: null, logLine: ln, rawFile: loc.rawFile })
      i++
      continue
    }

    if ((m = RE.invalidUtf8.exec(line))) {
      const loc = locate(Number(m[1]))
      add({ level: 'info', kind: 'invalid-utf8', message: norm(line), content: line, file: loc.file, line: loc.line, logLine: ln, rawFile: loc.rawFile })
      i++
      continue
    }

    if ((m = RE.noFile.exec(line))) {
      const loc = locate(null)
      add({ level: 'info', kind: 'no-file', message: line, content: line, file: loc.file, line: null, logLine: ln, rawFile: loc.rawFile })
      i++
      continue
    }

    const pdfIdx = line.indexOf('pdfTeX warning')
    if (pdfIdx >= 0) {
      if (pdfIdx > 0) scanText(line.slice(0, pdfIdx))
      i = parsePdftexWarning(i, line.slice(pdfIdx))
      continue
    }

    if ((m = RE.outputWritten.exec(line))) {
      pages = Number(m[1])
      complete = true
    } else if (RE.noPages.test(line)) {
      pages = 0
      complete = true
    } else if (RE.memory.test(line)) {
      complete = true
    }

    scanText(line)
    i++
  }

  if (!complete && engine !== 'unknown' && n > 1) {
    add({
      level: 'error', kind: 'log-truncated',
      message: 'The log ended unexpectedly: the TeX engine stopped before finishing (log ended unexpectedly).',
      content: lines.slice(Math.max(0, n - 5)).join('\n'), file: null, line: null,
      logLine: lineNo[n - 1] ?? 1, rawFile: null,
    })
  }

  enrich(entries, opts, rootFile)

  const finalStack = stack.filter((f): f is Extract<Frame, { kind: 'file' }> => f.kind === 'file').map(f => f.raw)
  return { engine, entries, pages, finalStack, openParens: stack.filter(f => f.kind === 'paren').length, complete, rootFile }

  // ------------------------------------------------------------------ handlers

  function parseError(start: number, errText: string, fleRaw: string | null, fleLine: number | null, pdftexCategory?: string): number {
    const header = lines[start]
    const block: string[] = [header]
    let j = start + 1
    // look ahead for the l.N line
    let lIdx = -1
    for (let k = j; k < n && k - start <= MAX_ERROR_SCAN; k++) {
      const l = lines[k]
      if (RE.lineRef.test(l)) {
        lIdx = k
        break
      }
      if (l.startsWith('! ') || RE.fatal.test(l) || (!RE.notFle.test(l) && RE.fle.test(l))) break
    }
    let texLine: number | null = null
    if (lIdx >= 0) {
      for (; j < lIdx; j++) block.push(lines[j])
      texLine = Number(RE.lineRef.exec(lines[lIdx])![1])
      block.push(lines[lIdx])
      j = lIdx + 1
      if (j < n && !NEW_MSG.test(lines[j]) && lines[j].length > 0) block.push(lines[j++]) // context after the error point
      j = consumeHelp(j, block)
    } else {
      // no line number: the block ends at the first empty line, but take a '*** (...)' explanation along
      while (j < n && lines[j].length > 0 && j - start <= MAX_ERROR_SCAN) {
        const l = lines[j]
        if (l.startsWith('! ') || RE.fatal.test(l) || (!RE.notFle.test(l) && RE.fle.test(l))) break
        if (/^[()]/.test(l) || RE.memory.test(l)) break
        block.push(l)
        j++
        if (l.startsWith('*** (')) break
      }
    }

    let message = errText
    let kind = 'tex-error'
    let pkg: string | undefined
    // continuation lines of the message itself
    let k = 1
    const pm = /^(Package|Class|Module) (\S+) Error: (.*)$/.exec(errText)
    const lm = /^LaTeX(?: (\w+))? Error: (.*)$/.exec(errText)
    if (pm) {
      pkg = pm[2]
      kind = `${pm[1].toLowerCase()}-error`
    } else if (lm) {
      kind = 'latex-error'
    }
    while (k < block.length && !isBlank(block[k]) && !RE.lineRef.test(block[k])) {
      const c = RE.cont.exec(block[k])
      if (pkg && c && c[1] === pkg) message += ' ' + c[3]
      else if ((pm || lm) && /^\s{2,}\S/.test(block[k])) message += ' ' + block[k].trim()
      else break
      k++
    }
    message = norm(message)

    const texTop = block.length > 1 ? block[1] : ''
    if (/^Undefined control sequence\.?$/.test(message)) {
      kind = 'undefined-control-sequence'
      const cs = /(\\(?:[A-Za-z@]+|.))\s*$/.exec(texTop.replace(/^l\.\d+ /, ''))
      if (cs && !texTop.endsWith('...')) message = `Undefined control sequence: ${cs[1]}`
    } else if (/^Missing \$ inserted/.test(message)) kind = 'missing-dollar'
    else if (/File [`'][^']*' not found/.test(message) || /^I can't find file/.test(message)) kind = 'missing-file'
    else if (/Unicode character .* not set up/.test(message)) kind = 'unicode-character'
    else if (/^Missing character: /.test(message)) kind = 'missing-character'
    else if (/^(?:Paragraph ended before|File ended while scanning)/.test(message)) kind = 'runaway-argument'
    else if (/^Emergency stop\.?$/.test(message)) kind = 'emergency-stop'
    else if (pdftexCategory !== undefined || /^pdfTeX error/.test(message)) kind = 'pdftex-error'

    const aborted = block.find(b => b.startsWith('*** ('))
    const secondary = kind === 'emergency-stop' && lastError !== null && lastErrorEnd >= 0 && start - lastErrorEnd <= 12
    if (kind === 'emergency-stop' && aborted && /no legal \\end found/.test(aborted)) {
      message = 'Emergency stop: job aborted, no legal \\end found'
    }

    let content = block.join('\n')
    if (pendingRunaway && start - pendingRunaway.at <= 3) content = pendingRunaway.lines.join('\n') + '\n' + content
    pendingRunaway = null

    const loc = locate(fleLine ?? texLine, fleRaw)
    if (secondary && lastError && lastError.line === null) {
      // e.g. a missing \input file: the line is only known from the Emergency stop that follows
      const sec = locate(fleLine ?? texLine, fleRaw)
      if (sec.line !== null && (lastError.file === null || lastError.file === sec.file)) {
        lastError.file = sec.file
        lastError.line = sec.line
      }
    }
    const entry = add({
      level: 'error', kind, message, content, file: loc.file, line: loc.line,
      logLine: lineNo[start], rawFile: loc.rawFile, ...(pkg ? { package: pkg } : {}),
      ...(secondary ? { secondary: true } : {}),
    })
    if (!secondary) lastError = entry
    lastErrorEnd = j
    return j
  }

  /** Help text after an error's context: one paragraph, or (\errhelp style, after a blank line) up to 4. */
  function consumeHelp(j: number, block: string[]): number {
    let budget = 30
    if (j < n && !isBlank(lines[j]) && !NEW_MSG.test(lines[j])) {
      while (j < n && !isBlank(lines[j]) && !NEW_MSG.test(lines[j]) && budget-- > 0) block.push(lines[j++])
      return j
    }
    if (j >= n || !isBlank(lines[j])) return j
    let k = j + 1
    let paras = 0
    while (k < n && paras < 4 && budget > 0) {
      if (isBlank(lines[k])) break // two blank lines in a row
      if (NEW_MSG.test(lines[k]) || /^[\\<[]|=\\/.test(lines[k])) break
      const para: string[] = []
      let p = k
      while (p < n && !isBlank(lines[p]) && budget-- > 0) {
        if (/[()]/.test(lines[p]) && NEW_MSG.test(lines[p])) break
        para.push(lines[p++])
      }
      if (para.some(l => /^[()]|^\\[A-Za-z@]+=/.test(l))) break
      block.push('', ...para)
      k = p
      paras++
      if (k < n && isBlank(lines[k])) k++
      else break
    }
    return paras > 0 ? k : j
  }

  function parseWarning(start: number, m: RegExpExecArray): number {
    const [, cls, pkgName, latex, sub, category, first] = m
    const block = [lines[start]]
    let text = first
    const expect = pkgName ?? sub ?? null
    let j = start + 1
    if (first.trim() === '') {
      // the text starts on the next lines, without the '(pkg)' prefix (xr: 'No file supp.aux' /
      // 'LABELS NOT IMPORTED.' / ' on input line 3.'): take them up to 'on input line N.'
      for (let k = j; k < n && k - j < 6; k++) {
        const l = lines[k]
        if (isBlank(l) || /^[()[]/.test(l) || RE.warnHead.test(l) || (NEW_MSG.test(l) && !/^No file /.test(l))) break
        text += ' ' + l.trim()
        block.push(l)
        j = k + 1
        if (RE.onInputLine.test(l)) break
      }
    }
    while (j < n) {
      const l = lines[j]
      if (isBlank(l)) break
      const c = RE.cont.exec(l)
      if (c && (c[1] === expect || c[2].length >= 2)) {
        text += ' ' + c[3]
        block.push(l)
        j++
        continue
      }
      if (/^\s+\S/.test(l)) {
        text += ' ' + l.trim()
        block.push(l)
        j++
        continue
      }
      break
    }
    text = norm(text)
    const who = cls ? `${cls} ${pkgName}` : `${latex}${sub ? ' ' + sub : ''}`
    const message = `${who} Warning${category ? ` (${category})` : ''}: ${text}`
    let kind = cls ? `${cls.toLowerCase()}-warning` : sub === 'Font' ? 'font-warning' : 'latex-warning'
    const ur = RE.undefRef.exec(text)
    if (ur) kind = ur[1] === 'Citation' ? 'undefined-citation' : 'undefined-reference'
    else if (RE.multiply.test(text)) kind = 'multiply-defined'
    else if (RE.summary.test(text)) kind = 'summary'
    else if (RE.rerun.test(text)) kind = 'rerun'
    else if (pkgName === 'xr' && /\bNo file\b/.test(text)) kind = 'xr-no-file'
    const il = RE.onInputLine.exec(text)
    const loc = locate(il ? Number(il[1]) : null)
    add({
      level: 'warning', kind, message, content: block.join('\n'), file: loc.file, line: loc.line,
      logLine: lineNo[start], rawFile: loc.rawFile, ...(pkgName ? { package: pkgName } : {}),
    })
    return j
  }

  function parsePdftexWarning(start: number, text: string): number {
    const m = RE.pdftexWarn.exec(text)!
    const block = [text]
    let j = start + 1
    let texLine: number | null = null
    // pdfTeX prints TeX context (<to be read again> … l.N …) after some warnings
    if (j < n && (/^</.test(lines[j]) || RE.lineRef.test(lines[j]))) {
      for (let k = j; k < n && k - start <= 12; k++) {
        const lr = RE.lineRef.exec(lines[k])
        block.push(lines[k])
        if (lr) {
          texLine = Number(lr[1])
          j = k + 1
          if (j < n && !isBlank(lines[j]) && !NEW_MSG.test(lines[j].trimStart())) {
            block.push(lines[j])
            trackPages(lines[j])
            j++
          }
          break
        }
        j = k + 1
      }
    }
    const loc = locate(texLine)
    add({
      level: 'warning', kind: 'pdftex-warning', message: norm(`pdfTeX warning${m[1] ? ` (${m[1]})` : ''}: ${m[2]}`),
      content: block.join('\n'), file: loc.file, line: loc.line, logLine: lineNo[start], rawFile: loc.rawFile,
    })
    return j
  }
}

/** Improve locations using the project sources (when `getSource` is available). */
function enrich(entries: LatexLogEntry[], opts: LogParseOptions, rootFile: string | null): void {
  const get = new SourceCache(opts.getSource)
  const root = opts.rootPath ?? rootFile
  const texFiles = (opts.projectFiles ?? []).filter(f => /\.(?:tex|ltx|latex)$/i.test(f))
  const ordered = (first: string | null) => (first ? [first, ...texFiles.filter(f => f !== first)] : texFiles)
  let usesXr: boolean | null = null
  const rootUsesXr = (): boolean => {
    if (usesXr !== null) return usesXr
    usesXr = !!findInSources(root ? [root] : [], get, /\\external(?:cite)?document\b/)
    return usesXr
  }

  for (const e of entries) {
    if (e.kind === 'missing-file' && get.available) {
      const mm = /File [`']([^']+)\.(sty|cls)' not found/.exec(e.message)
      if (mm) {
        const name = escapeRegExp(mm[1])
        const re = mm[2] === 'cls'
          ? new RegExp(`\\\\documentclass\\s*(?:\\[[^\\]]*\\])?\\s*\\{\\s*${name}\\s*\\}`)
          : new RegExp(`\\\\(?:usepackage|RequirePackage)\\s*(?:\\[[^\\]]*\\])?\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`)
        const hit = findInSources(ordered(e.file ?? root), get, re)
        if (hit) {
          e.file = hit.file
          e.line = hit.line
        }
      }
    }
    if (e.kind === 'multiply-defined' && e.line === null) {
      const mm = /(Label|Citation) [`']([^']*)' multiply defined/.exec(e.message)
      if (mm) {
        const key = escapeRegExp(mm[2])
        const re = mm[1] === 'Label'
          ? new RegExp(`\\\\label\\s*(?:\\[[^\\]]*\\])?\\s*\\{${key}\\}`)
          : new RegExp(`\\\\bibitem\\s*(?:\\[[^\\]]*\\])?\\s*\\{${key}\\}`)
        const hit = findInSources(ordered(e.file ?? root), get, re)
        if (hit) {
          e.file = hit.file
          e.line = hit.line
        }
        if (e.rawFile && /\.aux$/i.test(e.rawFile) && rootUsesXr()) {
          e.hint = hintFor({ message: e.message, kind: 'multiply-defined-xr' }) ?? e.hint
        }
      }
    }
  }
}

const EMPTY = (): ParsedLog => ({ errors: [], warnings: [], typesetting: [], info: [] })

/** longest `content` kept per entry (the raw log is always available separately) */
export const MAX_ENTRY_CONTENT = 4000
/** entries kept per level; the rest is summarised in one info entry */
export const MAX_ENTRIES_PER_LEVEL = 1000

/** Strip parser-only fields so entries match the LogEntry contract exactly. */
export function toLogEntry(e: LogEntry): LogEntry {
  const content = e.content.length > MAX_ENTRY_CONTENT ? `${e.content.slice(0, MAX_ENTRY_CONTENT)}\n…` : e.content
  const out: LogEntry = {
    level: e.level, message: e.message.length > MAX_ENTRY_CONTENT ? `${e.message.slice(0, MAX_ENTRY_CONTENT)}…` : e.message,
    content, file: e.file, line: e.line, source: e.source,
  }
  if (e.lineEnd !== undefined && e.lineEnd !== null) out.lineEnd = e.lineEnd
  if (e.kind !== undefined) out.kind = e.kind
  if (e.hint !== undefined) out.hint = e.hint
  if (typeof e.logLine === 'number' && e.logLine > 0) out.logLine = e.logLine
  if (e.page !== undefined) out.page = e.page
  return out
}

export function bucket(entries: LogEntry[]): ParsedLog {
  const out = EMPTY()
  const key: Record<LogLevel, keyof ParsedLog> = { error: 'errors', warning: 'warnings', typesetting: 'typesetting', info: 'info' }
  const dropped: Record<LogLevel, number> = { error: 0, warning: 0, typesetting: 0, info: 0 }
  for (const e of entries) {
    const list = out[key[e.level]]
    if (list.length >= MAX_ENTRIES_PER_LEVEL) dropped[e.level]++
    else list.push(toLogEntry(e))
  }
  const names: Record<LogLevel, string> = { error: 'errors', warning: 'warnings', typesetting: 'bad boxes', info: 'messages' }
  const source = entries[0]?.source ?? 'latex'
  for (const level of Object.keys(dropped) as LogLevel[]) {
    if (!dropped[level]) continue
    out.info.push({
      level: 'info', kind: 'truncated-list', source, file: null, line: null,
      message: `${dropped[level]} more ${names[level]} were not listed; see the raw log.`, content: '',
    })
  }
  return out
}

/** Parse a LaTeX .log into errors / warnings / bad boxes / info with project file + line. */
export function parseLatexLog(text: string | Uint8Array, opts: LogParseOptions): ParsedLog {
  return bucket(analyzeLatexLog(text, opts).entries)
}
