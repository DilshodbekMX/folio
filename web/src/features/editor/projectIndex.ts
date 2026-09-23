/**
 * Project index for completions and the equation preview: labels (with their context line),
 * citation keys from .bib files and \bibitem entries, user-defined commands and environments,
 * KaTeX macros and the project's file paths.
 *
 * Built in the browser from `useProject.files` plus live texts: a file with a synced
 * DocSession is read from its Y.Text, every other file through `api.rawFile`. Updates are
 * incremental and debounced — a keystroke in the open file schedules a re-scan of that file
 * only (LIVE_DEBOUNCE_MS), tree changes re-check versions (updatedAt/epoch) and fetch changed
 * files with limited concurrency. The aggregated snapshot is rebuilt lazily on read.
 */
import type { FileEntry } from '@folio/shared/api'
import { extractBibKeys, extractBibitems, extractLabels, maskLatex } from '@folio/shared/latex'
import { extname } from '@folio/shared/paths'
import { api } from '../../api/endpoints'
import { docSessions } from '../../realtime/docs'
import { useProject } from '../../stores/project'
import { registerTestHook } from '../../stores/testHooks'

export interface IndexedLabel { label: string; path: string; line: number; context: string }
export interface IndexedCite {
  key: string
  path: string
  line: number
  source: 'bib' | 'bibitem'
  type?: string
  title?: string
  author?: string
  year?: string
  /** \bibitem: the (cleaned) reference text */
  text?: string
}
export interface IndexedCommand { name: string; args: number; optional: boolean; path: string; math: boolean }

export interface ProjectIndexSnapshot {
  /** incremented whenever any part changes */
  rev: number
  labels: IndexedLabel[]
  cites: IndexedCite[]
  commands: IndexedCommand[]
  environments: string[]
  /** KaTeX macros from \newcommand / \DeclareMathOperator definitions */
  macros: Record<string, string>
  /** every file and folder path of the project */
  files: FileEntry[]
}

interface FileData {
  labels: IndexedLabel[]
  cites: IndexedCite[]
  commands: IndexedCommand[]
  environments: string[]
  macros: Record<string, string>
}

const INDEXED_EXTS = new Set(['tex', 'ltx', 'latex', 'tikz', 'pgf', 'sty', 'cls', 'def', 'bib', 'bbl'])
const LIVE_DEBOUNCE_MS = 700
const TREE_DEBOUNCE_MS = 250
const FETCH_CONCURRENCY = 3
const MAX_INDEXED_CHARS = 2_500_000

export function isIndexedPath(path: string): boolean {
  return INDEXED_EXTS.has(extname(path))
}

// ---------------------------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------------------------

const DEF_RE = /\\(newcommand|renewcommand|providecommand|DeclareRobustCommand|DeclareMathOperator|NewDocumentCommand|RenewDocumentCommand|ProvideDocumentCommand|def|gdef|edef|let)\*?\s*\{?\s*\\([A-Za-z@]+)\s*\}?/g
const ENV_DEF_RE = /\\(?:newenvironment|renewenvironment|NewDocumentEnvironment|newtheorem\*?|declaretheorem)\s*\{([A-Za-z*@]+)\}/g
const ENV_USE_RE = /\\begin\s*\{([A-Za-z*]+)\}/g

function readGroup(text: string, i: number): { content: string; end: number } | null {
  if (text[i] !== '{') return null
  let depth = 0
  for (let k = i; k < text.length && k < i + 4000; k++) {
    const c = text[k]
    if (c === '\\') {
      k++
      continue
    }
    if (c === '{') depth++
    else if (c === '}') {
      if (--depth === 0) return { content: text.slice(i + 1, k), end: k + 1 }
    }
  }
  return null
}

function skipWs(text: string, i: number): number {
  while (i < text.length && (text[i] === ' ' || text[i] === '\t' || text[i] === '\n')) i++
  return i
}

/** \newcommand-style definitions: name, argument count, optional first argument, body. */
function scanDefinitions(masked: string, path: string, out: FileData): void {
  const seen = new Set<string>()
  DEF_RE.lastIndex = 0
  for (let m = DEF_RE.exec(masked); m; m = DEF_RE.exec(masked)) {
    const kind = m[1]
    const name = m[2]
    if (name.includes('@') || seen.has(name)) continue
    let i = m.index + m[0].length
    let args = 0
    let optional = false
    let body: string | null = null
    if (kind === 'let') continue
    if (kind === 'def' || kind === 'gdef' || kind === 'edef') {
      const params = /^((?:#\d)*)\s*/.exec(masked.slice(i, i + 40))
      if (params) {
        args = params[1].length / 2
        i += params[0].length
      }
      body = readGroup(masked, i)?.content ?? null
    } else if (kind === 'DeclareMathOperator') {
      body = readGroup(masked, skipWs(masked, i))?.content ?? null
      if (body !== null) body = `\\operatorname{${body}}`
    } else if (/DocumentCommand$/.test(kind)) {
      const spec = readGroup(masked, skipWs(masked, i))
      if (spec) {
        const specs = spec.content.match(/[mO]|o|r..|R..|s|t.|d..|D..|e\{[^}]*\}|E\{[^}]*\}\{[^}]*\}|v/g) ?? []
        args = specs.filter(x => x === 'm').length
        optional = specs.some(x => x !== 'm')
        i = spec.end
        body = readGroup(masked, skipWs(masked, i))?.content ?? null
      }
    } else {
      let j = skipWs(masked, i)
      const nArgs = /^\[\s*(\d)\s*\]/.exec(masked.slice(j, j + 12))
      if (nArgs) {
        args = Number(nArgs[1])
        j = skipWs(masked, j + nArgs[0].length)
        if (masked[j] === '[') {
          optional = true
          const close = masked.indexOf(']', j)
          if (close !== -1) j = skipWs(masked, close + 1)
        }
      }
      body = readGroup(masked, j)?.content ?? null
    }
    seen.add(name)
    const math = body !== null && /\\(?:mathrm|mathbf|mathcal|mathbb|operatorname|frac|sum|int|left|right|hat|bar|vec|[a-z]*arrow)|[_^]/.test(body)
    out.commands.push({ name, args: optional ? Math.max(0, args - 1) : args, optional, path, math })
    // KaTeX macros: simple bodies only (no optional argument, reasonable length)
    if (body !== null && !optional && body.length <= 400 && !/\\(?:makeatletter|csname|expandafter|@)/.test(body)) {
      out.macros[`\\${name}`] = body
    }
  }
}

function contextLine(text: string, line: number, lineStarts: number[]): string {
  const start = lineStarts[line - 1] ?? 0
  let end = text.indexOf('\n', start)
  if (end === -1) end = text.length
  return text.slice(start, end).trim().slice(0, 160)
}

function lineStartsOf(text: string): number[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

function cleanBibitemText(raw: string): string {
  return raw
    .replace(/%[^\n]*/g, ' ')
    .replace(/\\(?:newblock|emph|textit|textbf|url|href|doi|bibinfo|bibfield|textsc)\b/g, ' ')
    .replace(/\\[a-zA-Z@]+\*?/g, ' ')
    .replace(/[{}~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 260)
}

export function scanTexFile(path: string, text: string): FileData {
  const out: FileData = { labels: [], cites: [], commands: [], environments: [], macros: {} }
  if (text.length > MAX_INDEXED_CHARS) return out
  const starts = lineStartsOf(text)
  for (const l of extractLabels(text)) out.labels.push({ label: l.label, path, line: l.line, context: contextLine(text, l.line, starts) })
  const items = extractBibitems(text)
  for (let i = 0; i < items.length; i++) {
    const it = items[i]
    const from = starts[it.line - 1] ?? 0
    const to = i + 1 < items.length ? (starts[items[i + 1].line - 1] ?? text.length) : Math.min(text.length, from + 1200)
    let chunk = text.slice(from, to)
    const k = chunk.indexOf(`{${it.key}}`)
    if (k !== -1) chunk = chunk.slice(k + it.key.length + 2)
    chunk = chunk.split(/\\end\s*\{thebibliography\}/)[0]
    const cleaned = cleanBibitemText(chunk)
    const year = /\b(1[89]\d\d|20\d\d)[a-z]?\b/.exec(cleaned)?.[1]
    out.cites.push({ key: it.key, path, line: it.line, source: 'bibitem', text: cleaned, ...(year ? { year } : {}) })
  }
  const masked = maskLatex(text)
  scanDefinitions(masked, path, out)
  const envs = new Set<string>()
  ENV_DEF_RE.lastIndex = 0
  for (let m = ENV_DEF_RE.exec(masked); m; m = ENV_DEF_RE.exec(masked)) envs.add(m[1])
  ENV_USE_RE.lastIndex = 0
  for (let m = ENV_USE_RE.exec(masked); m; m = ENV_USE_RE.exec(masked)) envs.add(m[1])
  out.environments = [...envs]
  return out
}

export function scanBibFile(path: string, text: string): FileData {
  const out: FileData = { labels: [], cites: [], commands: [], environments: [], macros: {} }
  if (text.length > MAX_INDEXED_CHARS) return out
  for (const e of extractBibKeys(text)) {
    out.cites.push({
      key: e.key, path, line: e.line, source: 'bib', type: e.type,
      ...(e.title ? { title: e.title } : {}), ...(e.author ? { author: e.author } : {}), ...(e.year ? { year: e.year } : {}),
    })
  }
  return out
}

function scanFile(path: string, text: string): FileData {
  return extname(path) === 'bib' ? scanBibFile(path, text) : scanTexFile(path, text)
}

// ---------------------------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------------------------

interface Entry {
  fileId: string
  path: string
  /** version the data was built from: 'live:<n>' or `${epoch}:${updatedAt}` */
  version: string | null
  data: FileData | null
  loading: boolean
}

const EMPTY_SNAPSHOT: ProjectIndexSnapshot = { rev: 0, labels: [], cites: [], commands: [], environments: [], macros: {}, files: [] }

class ProjectIndexManager {
  private projectId: string | null = null
  private entries = new Map<string, Entry>()
  private rev = 0
  private snapshotCache: ProjectIndexSnapshot = EMPTY_SNAPSHOT
  private snapshotRev = -1
  private unsubs: (() => void)[] = []
  private treeTimer: ReturnType<typeof setTimeout> | null = null
  private liveTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private liveSeq = 0
  private queue: string[] = []
  private active = 0
  private refs = 0
  private listeners = new Set<() => void>()
  /** the files map the last reconcile saw (a new identity means paths/files changed) */
  private filesSeen: Record<string, FileEntry> | null = null

  /** Start indexing the open project (ref-counted; pair with stop()). */
  start(): void {
    this.refs++
    if (this.refs > 1) return
    this.unsubs.push(
      useProject.subscribe((s, prev) => {
        if (s.projectId !== prev.projectId) this.reset()
        if (s.files !== prev.files || s.loadState !== prev.loadState) this.scheduleTree()
      }),
      docSessions.onChange(fileId => this.scheduleLive(fileId)),
    )
    this.reset()
    this.scheduleTree()
  }

  stop(): void {
    if (this.refs === 0) return
    this.refs--
    if (this.refs > 0) return
    for (const u of this.unsubs) u()
    this.unsubs = []
    this.clearTimers()
    this.entries.clear()
    this.projectId = null
    this.bump()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** Re-scan a file from its live text now (e.g. after its session synced). */
  refreshLive(fileId: string): void {
    this.scheduleLive(fileId, 0)
  }

  snapshot(): ProjectIndexSnapshot {
    if (this.snapshotRev === this.rev) return this.snapshotCache
    const labels: IndexedLabel[] = []
    const cites: IndexedCite[] = []
    const commands: IndexedCommand[] = []
    const envs = new Set<string>()
    const macros: Record<string, string> = {}
    const seenCmd = new Set<string>()
    const seenCite = new Set<string>()
    const sorted = [...this.entries.values()].sort((a, b) => a.path.localeCompare(b.path))
    // .tex before .sty/.cls so the user's own definitions win
    sorted.sort((a, b) => rankPath(a.path) - rankPath(b.path))
    for (const e of sorted) {
      if (!e.data) continue
      labels.push(...e.data.labels)
      for (const c of e.data.cites) {
        if (seenCite.has(c.key)) continue
        seenCite.add(c.key)
        cites.push(c)
      }
      for (const c of e.data.commands) {
        if (seenCmd.has(c.name)) continue
        seenCmd.add(c.name)
        commands.push(c)
      }
      for (const env of e.data.environments) envs.add(env)
      // KaTeX macros from the user's own documents only (class/package internals would shadow KaTeX built-ins)
      if (rankPath(e.path) === 0) for (const [k, v] of Object.entries(e.data.macros)) if (!(k in macros)) macros[k] = v
    }
    const files = Object.values(useProject.getState().files)
    this.snapshotCache = { rev: this.rev, labels, cites, commands, environments: [...envs], macros, files }
    this.snapshotRev = this.rev
    return this.snapshotCache
  }

  private bump(): void {
    this.rev++
    for (const fn of [...this.listeners]) {
      try {
        fn()
      } catch (e) {
        console.error('[projectIndex] listener failed', e)
      }
    }
  }

  private clearTimers(): void {
    if (this.treeTimer !== null) clearTimeout(this.treeTimer)
    this.treeTimer = null
    for (const t of this.liveTimers.values()) clearTimeout(t)
    this.liveTimers.clear()
    this.queue = []
  }

  private reset(): void {
    this.clearTimers()
    this.entries.clear()
    this.filesSeen = null
    this.projectId = useProject.getState().projectId
    this.bump()
  }

  private scheduleTree(): void {
    if (this.treeTimer !== null) clearTimeout(this.treeTimer)
    this.treeTimer = setTimeout(() => {
      this.treeTimer = null
      this.reconcile()
    }, TREE_DEBOUNCE_MS)
  }

  private scheduleLive(fileId: string, delay = LIVE_DEBOUNCE_MS): void {
    const entry = this.entries.get(fileId)
    if (!entry) return
    const prev = this.liveTimers.get(fileId)
    if (prev) clearTimeout(prev)
    this.liveTimers.set(fileId, setTimeout(() => {
      this.liveTimers.delete(fileId)
      this.indexLive(fileId)
    }, delay))
  }

  /** Index from the live Y.Text; returns false when there is no synced session. */
  private indexLive(fileId: string): boolean {
    const entry = this.entries.get(fileId)
    const session = docSessions.get(fileId)
    if (!entry || !session || !session.isSynced()) return false
    entry.data = scanFile(entry.path, session.ytext.toString())
    entry.version = `live:${++this.liveSeq}`
    this.bump()
    return true
  }

  private reconcile(): void {
    const st = useProject.getState()
    if (st.loadState !== 'ready' || !st.projectId) return
    if (st.projectId !== this.projectId) this.reset()
    // any tree change (new image, renamed folder…) changes the file-path completions
    let changed = st.files !== this.filesSeen
    this.filesSeen = st.files
    const alive = new Set<string>()
    for (const f of Object.values(st.files)) {
      if (f.kind !== 'text' || !isIndexedPath(f.path)) continue
      alive.add(f.id)
      let e = this.entries.get(f.id)
      if (!e) {
        e = { fileId: f.id, path: f.path, version: null, data: null, loading: false }
        this.entries.set(f.id, e)
      }
      if (e.path !== f.path) {
        const oldPath = e.path
        e.path = f.path
        if (e.data) e.data = relabel(e.data, oldPath, f.path)
        changed = true
      }
      const diskVersion = `${f.epoch}:${f.updatedAt}`
      const live = docSessions.get(f.id)
      if (live?.isSynced()) {
        if (!e.version?.startsWith('live:')) this.indexLive(f.id)
        continue
      }
      if (e.version !== diskVersion && !e.loading && !this.queue.includes(f.id)) this.queue.push(f.id)
    }
    for (const id of [...this.entries.keys()]) {
      if (!alive.has(id)) {
        this.entries.delete(id)
        changed = true
      }
    }
    if (changed) this.bump()
    this.pump()
  }

  private pump(): void {
    while (this.active < FETCH_CONCURRENCY && this.queue.length > 0) {
      const fileId = this.queue.shift()!
      void this.fetchFile(fileId)
    }
  }

  private async fetchFile(fileId: string): Promise<void> {
    const pid = this.projectId
    const f = useProject.getState().files[fileId]
    const e = this.entries.get(fileId)
    if (!pid || !f || !e) return
    const version = `${f.epoch}:${f.updatedAt}`
    this.active++
    e.loading = true
    try {
      // the file may have gained a live session meanwhile
      if (this.indexLive(fileId)) return
      const text = await api.rawFile(pid, fileId, { silent: true })
      if (this.projectId !== pid || this.entries.get(fileId) !== e) return
      if (docSessions.get(fileId)?.isSynced()) {
        this.indexLive(fileId)
        return
      }
      e.data = scanFile(e.path, text)
      e.version = version
      this.bump()
    } catch (err) {
      console.warn('[projectIndex] could not index', f.path, err)
      e.version = version // do not retry in a loop; the next change retries
    } finally {
      e.loading = false
      this.active--
      this.pump()
    }
  }
}

function rankPath(path: string): number {
  const ext = extname(path)
  return ext === 'tex' || ext === 'ltx' || ext === 'latex' ? 0 : ext === 'bib' ? 1 : 2
}

function relabel(data: FileData, _oldPath: string, path: string): FileData {
  return {
    labels: data.labels.map(l => ({ ...l, path })),
    cites: data.cites.map(c => ({ ...c, path })),
    commands: data.commands.map(c => ({ ...c, path })),
    environments: data.environments,
    macros: data.macros,
  }
}

export const projectIndex = new ProjectIndexManager()

registerTestHook('projectIndex', projectIndex)
