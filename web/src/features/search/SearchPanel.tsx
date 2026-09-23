/**
 * Project search rail panel (SPEC §6.7 / §6.8).
 *
 *  - Query field (debounced, Enter searches at once, Esc clears), toggles Match case / Regular
 *    expression / Whole word (remembered in localStorage), invalid regexes reported inline.
 *  - Results grouped by file (collapsible, match count), each match with its line number and
 *    the match highlighted in the preview; click / Enter → useEditor.jumpTo({fileId, line, column}).
 *  - Keyboard: ↓ from the field enters the results, ↑/↓/Home/End move, ←/→ collapse/expand a
 *    file, Enter opens, Esc returns to the field.
 *  - Mod-Shift-f opens the panel and focuses the field from anywhere in the editor page
 *    (a single window listener installed by this module; it only acts while a project is open).
 *    `openProjectSearch(query?)` does the same programmatically (e.g. from a menu).
 *
 * Replace-all is out of scope (SPEC §6.8).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { create } from 'zustand'
import clsx from 'clsx'
import { CaseSensitive, ChevronRight, FileText, RefreshCw, Regex, Search, SearchX, TriangleAlert, WholeWord, X } from 'lucide-react'
import type { SearchFileResult, SearchMatch, SearchResponse } from '@folio/shared/api'
import { api } from '../../api/endpoints'
import { errorMessage, isAbortError } from '../../api/client'
import { isRecord, readJSON, writeJSON } from '../../lib/storage'
import { useEditor } from '../../stores/editor'
import { useLayout } from '../../stores/layout'
import { useProject } from '../../stores/project'
import { EmptyState, IconButton, Kbd, Spinner, TextField, Tooltip, isModKey, toast } from '../../ui'
import { buildSearchRegExp, clipPreview, locateMatch, regexProblem, splitPath, type SearchFlags } from './match'
import './search.css'

/** Keyboard shortcut that opens the panel (CodeMirror key syntax). */
export const PROJECT_SEARCH_SHORTCUT = 'Mod-Shift-f'

const DEBOUNCE_MS = 300
const FLAGS_KEY = 'folio:search:flags'
const DEFAULT_FLAGS: SearchFlags = { regex: false, caseSensitive: false, wholeWord: false }

function loadFlags(): SearchFlags {
  return readJSON<SearchFlags>(FLAGS_KEY, DEFAULT_FLAGS, v => {
    if (!isRecord(v)) return undefined
    return { regex: v.regex === true, caseSensitive: v.caseSensitive === true, wholeWord: v.wholeWord === true }
  })
}

// ---------------------------------------------------------------------------------------------
// open / focus requests + the global shortcut
// ---------------------------------------------------------------------------------------------

interface FocusRequest { nonce: number; query?: string }
const useFocusRequest = create<{ request: FocusRequest | null }>(() => ({ request: null }))
let focusNonce = 0

/** The editor's current selection when it is a short single line (prefills the query). */
export function selectedSearchText(): string | undefined {
  const view = useEditor.getState().view
  if (!view) return undefined
  const sel = view.state.selection.main
  if (sel.empty || sel.to - sel.from > 200) return undefined
  const text = view.state.sliceDoc(sel.from, sel.to)
  return text.includes('\n') || !text.trim() ? undefined : text
}

/** Show the project search panel and focus its field (optionally with a new query). */
export function openProjectSearch(query?: string): void {
  useLayout.getState().setRailPanel('search')
  useFocusRequest.setState({ request: { nonce: ++focusNonce, query } })
}

function onShortcutKey(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.isComposing || e.repeat) return
  if (!isModKey(e) || !e.shiftKey || e.altKey) return
  if (e.code !== 'KeyF' && e.key.toLowerCase() !== 'f') return
  const project = useProject.getState()
  if (!project.projectId || project.loadState !== 'ready') return
  // a dialog owns the keyboard while it is open
  if (document.querySelector('[data-ui-layer="modal"]')) return
  e.preventDefault()
  openProjectSearch(selectedSearchText())
}

/**
 * `window.dispatchEvent(new CustomEvent(PROJECT_SEARCH_EVENT, { detail: { query } }))` opens the
 * project search with `query` — for code that must not import React modules (e.g. the editor's
 * find panel: "Search all project files").
 */
export const PROJECT_SEARCH_EVENT = 'folio:project-search'

function onSearchEvent(e: Event): void {
  const detail = (e as CustomEvent<unknown>).detail
  const query = isRecord(detail) && typeof detail.query === 'string' && detail.query.trim() ? detail.query : undefined
  if (useProject.getState().projectId) openProjectSearch(query)
}

/** One window listener for the whole app (replaced, not duplicated, when this module is hot-reloaded). */
function installShortcut(): void {
  if (typeof window === 'undefined') return
  const g = window as Window & { __folioProjectSearchKey?: (e: KeyboardEvent) => void; __folioProjectSearchEvent?: (e: Event) => void }
  if (g.__folioProjectSearchKey) window.removeEventListener('keydown', g.__folioProjectSearchKey)
  if (g.__folioProjectSearchEvent) window.removeEventListener(PROJECT_SEARCH_EVENT, g.__folioProjectSearchEvent)
  g.__folioProjectSearchKey = onShortcutKey
  g.__folioProjectSearchEvent = onSearchEvent
  window.addEventListener('keydown', onShortcutKey)
  window.addEventListener(PROJECT_SEARCH_EVENT, onSearchEvent)
}
installShortcut()

// ---------------------------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------------------------

interface Results {
  status: 'idle' | 'loading' | 'done' | 'error'
  /** query/flags the shown response belongs to */
  query: string
  flags: SearchFlags
  response: SearchResponse | null
  error: string | null
}

const IDLE: Results = { status: 'idle', query: '', flags: DEFAULT_FLAGS, response: null, error: null }

type Row =
  | { kind: 'file'; key: string; file: SearchFileResult }
  | { kind: 'match'; key: string; file: SearchFileResult; match: SearchMatch; index: number }

export function SearchPanel() {
  const projectId = useProject(s => s.projectId)
  const visible = useLayout(s => s.railPanel === 'search')
  const setRailPanel = useLayout(s => s.setRailPanel)
  const request = useFocusRequest(s => s.request)

  const [query, setQuery] = useState('')
  const [flags, setFlags] = useState<SearchFlags>(loadFlags)
  const [results, setResults] = useState<Results>(IDLE)
  const [runNonce, setRunNonce] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [selectedKey, setSelectedKey] = useState<string | null>(null)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const immediateRef = useRef(false)

  const problem = regexProblem(query, flags)

  // New project: start over.
  useEffect(() => {
    setQuery('')
    setResults(IDLE)
    setCollapsed(new Set())
  }, [projectId])

  // Run the search (debounced; Enter / refresh run immediately).
  useEffect(() => {
    abortRef.current?.abort()
    const q = query
    if (!projectId || q.trim() === '' || problem) {
      if (q.trim() === '') setResults(IDLE)
      return
    }
    const run = () => {
      const ctrl = new AbortController()
      abortRef.current = ctrl
      setResults(r => ({ ...r, status: 'loading', error: null }))
      api.search(projectId, { q, ...flags }, { signal: ctrl.signal }).then(
        response => {
          if (ctrl.signal.aborted) return
          setResults({ status: 'done', query: q, flags, response, error: null })
        },
        e => {
          if (isAbortError(e) || ctrl.signal.aborted) return
          setResults(r => ({ ...r, status: 'error', error: errorMessage(e, 'The search failed.') }))
        },
      )
    }
    const immediate = immediateRef.current
    immediateRef.current = false
    if (immediate) {
      run()
      return () => abortRef.current?.abort()
    }
    const t = window.setTimeout(run, DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [projectId, query, flags, problem, runNonce])

  useEffect(() => () => abortRef.current?.abort(), [])

  // Different query/flags → expand everything again.
  const resultKey = `${results.query}\u0000${results.flags.regex}${results.flags.caseSensitive}${results.flags.wholeWord}`
  useEffect(() => {
    setCollapsed(new Set())
    setActiveKey(null)
    setSelectedKey(null)
  }, [resultKey])

  const runNow = useCallback(() => {
    immediateRef.current = true
    setRunNonce(n => n + 1)
  }, [])

  // Showing the panel again refreshes the results (files may have changed meanwhile).
  const wasVisible = useRef(visible)
  useEffect(() => {
    if (visible && !wasVisible.current && results.status === 'done' && query.trim()) runNow()
    wasVisible.current = visible
  }, [visible, results.status, query, runNow])

  // Focus requests (Mod-Shift-f, openProjectSearch).
  useEffect(() => {
    if (!request || !visible) return
    useFocusRequest.setState({ request: null })
    if (request.query !== undefined && request.query !== query) {
      immediateRef.current = true
      setQuery(request.query)
    }
    const focus = () => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    focus()
    // the rail panel may still be expanding
    const raf = window.requestAnimationFrame(focus)
    return () => window.cancelAnimationFrame(raf)
  }, [request, visible, query])

  const toggleFlag = (k: keyof SearchFlags) => {
    const next = { ...flags, [k]: !flags[k] }
    setFlags(next)
    writeJSON(FLAGS_KEY, next)
  }

  const re = useMemo(() => buildSearchRegExp(results.query, results.flags), [results.query, results.flags])
  const response = results.response
  const files = response?.results ?? []
  const total = useMemo(() => files.reduce((n, f) => n + f.matches.length, 0), [files])

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = []
    for (const file of files) {
      out.push({ kind: 'file', key: `f:${file.fileId}`, file })
      if (collapsed.has(file.fileId)) continue
      file.matches.forEach((match, index) => out.push({ kind: 'match', key: `m:${file.fileId}:${index}`, file, match, index }))
    }
    return out
  }, [files, collapsed])

  const openMatch = (file: SearchFileResult, match: SearchMatch, key: string) => {
    setSelectedKey(key)
    setActiveKey(key)
    const ok = useEditor.getState().jumpTo({ fileId: file.fileId, path: file.path, line: match.line, column: match.column })
    if (!ok) toast(`“${file.path}” no longer exists. Search again to refresh the results.`, { tone: 'warning' })
  }

  const toggleFile = (fileId: string, open?: boolean) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      const isOpen = !next.has(fileId)
      if (open ?? !isOpen) next.delete(fileId)
      else next.add(fileId)
      return next
    })
  }

  const focusRow = (key: string | null) => {
    if (!key) return
    setActiveKey(key)
    const el = listRef.current?.querySelector<HTMLElement>(`[data-srch-key="${CSS.escape(key)}"]`)
    el?.focus()
    el?.scrollIntoView({ block: 'nearest' })
  }

  const onListKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const key = target.dataset.srchKey
    if (!key) return
    const i = rows.findIndex(r => r.key === key)
    if (i < 0) return
    const row = rows[i]
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        focusRow(rows[Math.min(rows.length - 1, i + 1)]?.key ?? null)
        break
      case 'ArrowUp':
        e.preventDefault()
        if (i === 0) inputRef.current?.focus()
        else focusRow(rows[i - 1].key)
        break
      case 'Home':
        e.preventDefault()
        focusRow(rows[0]?.key ?? null)
        break
      case 'End':
        e.preventDefault()
        focusRow(rows[rows.length - 1]?.key ?? null)
        break
      case 'ArrowLeft':
        e.preventDefault()
        if (row.kind === 'match') focusRow(`f:${row.file.fileId}`)
        else if (!collapsed.has(row.file.fileId)) toggleFile(row.file.fileId, false)
        break
      case 'ArrowRight':
        e.preventDefault()
        if (row.kind === 'file') {
          if (collapsed.has(row.file.fileId)) toggleFile(row.file.fileId, true)
          else focusRow(rows[i + 1]?.kind === 'match' ? rows[i + 1].key : null)
        }
        break
      case 'Escape':
        e.preventDefault()
        inputRef.current?.focus()
        break
      default:
        break
    }
  }

  const onInputKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      if (query.trim() && !problem) runNow()
    } else if (e.key === 'ArrowDown' && rows.length > 0) {
      e.preventDefault()
      focusRow(rows[0].key)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      if (query) setQuery('')
      else useEditor.getState().view?.focus()
    }
  }

  const loading = results.status === 'loading'
  const tabStop = activeKey && rows.some(r => r.key === activeKey) ? activeKey : rows[0]?.key ?? null
  const fileCount = files.length

  let summary: string | null = null
  if (results.status === 'done' || (loading && response)) {
    summary = total === 0 ? 'No results' : `${total.toLocaleString('en')} result${total === 1 ? '' : 's'} in ${fileCount} file${fileCount === 1 ? '' : 's'}`
  }

  let body
  if (!query.trim()) {
    body = (
      <EmptyState icon={Search} title="Search all project files" size="sm" className="srch-empty">
        <p>Find text in every file of the project, then click a result to jump to it.</p>
        <p className="srch-empty__keys">
          <Kbd keys={PROJECT_SEARCH_SHORTCUT} /> opens this panel from anywhere.
        </p>
      </EmptyState>
    )
  } else if (problem) {
    body = null
  } else if (results.status === 'error') {
    body = (
      <div className="srch-error" role="alert">
        <TriangleAlert size={14} aria-hidden="true" />
        <span>{results.error}</span>
      </div>
    )
  } else if (!response) {
    body = (
      <div className="srch-center">
        <Spinner size={16} label="Searching" />
      </div>
    )
  } else if (files.length === 0) {
    const anyFlag = results.flags.caseSensitive || results.flags.wholeWord || results.flags.regex
    body = (
      <EmptyState icon={SearchX} title="No results" size="sm" className="srch-empty">
        Nothing matches “{results.query}” in this project’s text files.
        {anyFlag && ' Try turning off Match case, Regular expression or Whole word.'}
      </EmptyState>
    )
  } else {
    body = (
      <div
        ref={listRef}
        className={clsx('srch-results', loading && 'is-stale')}
        role="list"
        aria-label="Search results"
        aria-busy={loading || undefined}
        onKeyDown={onListKeyDown}
      >
        {files.map(file => {
          const open = !collapsed.has(file.fileId)
          const { dir, base } = splitPath(file.path)
          const fkey = `f:${file.fileId}`
          return (
            <div key={file.fileId} className="srch-group" role="listitem">
              <button
                type="button"
                className="srch-file"
                data-srch-key={fkey}
                tabIndex={tabStop === fkey ? 0 : -1}
                aria-expanded={open}
                title={file.path}
                onClick={() => {
                  setActiveKey(fkey)
                  toggleFile(file.fileId)
                }}
              >
                <ChevronRight size={14} className={clsx('srch-file__chev', open && 'is-open')} aria-hidden="true" />
                <FileText size={14} className="srch-file__icon" aria-hidden="true" />
                <span className="srch-file__label">
                  <span className="srch-file__name">{base}</span>
                  {dir && <span className="srch-file__dir">{dir}</span>}
                </span>
                <span className="srch-file__count" aria-label={`${file.matches.length} matches`}>
                  {file.matches.length}
                </span>
              </button>
              {open && (
                <ul className="srch-matches">
                  {file.matches.map((m, index) => {
                    const key = `m:${file.fileId}:${index}`
                    const pos = locateMatch(m.preview, m, re)
                    const clip = clipPreview(m.preview, pos.start, pos.end, 80)
                    return (
                      <li key={key}>
                        <button
                          type="button"
                          className={clsx('srch-match', selectedKey === key && 'is-selected')}
                          data-srch-key={key}
                          tabIndex={tabStop === key ? 0 : -1}
                          aria-current={selectedKey === key ? 'true' : undefined}
                          aria-label={`Line ${m.line}: ${m.preview.trim()}`}
                          onClick={() => openMatch(file, m, key)}
                          onFocus={() => setActiveKey(key)}
                        >
                          <span className="srch-match__line">{m.line}</span>
                          <span className="srch-match__text">
                            {/* the head is clipped on the left (rtl box, ltr text) so the match stays visible */}
                            <span className="srch-match__head">
                              <bdi>{clip.head.trimEnd()}</bdi>
                            </span>
                            {/* trailing spaces would be reordered to the far (clipped) side of the rtl box */}
                            {clip.head.length !== clip.head.trimEnd().length && (
                              <span className="srch-match__ws">{clip.head.slice(clip.head.trimEnd().length)}</span>
                            )}
                            <mark className="srch-match__hit">{clip.match}</mark>
                            <span className="srch-match__tail">{clip.tail}</span>
                          </span>
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
        {response.truncated && (
          <p className="srch-truncated" role="note">
            <TriangleAlert size={14} aria-hidden="true" />
            <span>Only the first {total.toLocaleString('en')} matches are shown. Refine the search to see the rest.</span>
          </p>
        )}
      </div>
    )
  }

  return (
    <section className="srch" aria-label="Project search">
      <header className="srch-head">
        <h2 className="srch-head__title">Project search</h2>
        <div className="srch-head__actions">
          <IconButton
            icon={RefreshCw}
            label="Search again"
            size="sm"
            disabled={!query.trim() || !!problem || loading}
            onClick={runNow}
          />
          <IconButton icon={X} label="Close project search" size="sm" onClick={() => setRailPanel(null)} />
        </div>
      </header>
      <div className="srch-form">
        <TextField
          ref={inputRef}
          size="sm"
          icon={Search}
          value={query}
          invalid={!!problem}
          placeholder="Search in all project files…"
          aria-label="Search in all project files"
          aria-describedby={problem ? 'srch-problem' : undefined}
          spellCheck={false}
          autoComplete="off"
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onInputKeyDown}
          trailing={
            query ? (
              <IconButton
                icon={X}
                label="Clear search"
                size="sm"
                tooltip={false}
                onClick={() => {
                  setQuery('')
                  inputRef.current?.focus()
                }}
              />
            ) : undefined
          }
        />
        <div className="srch-options">
          <div className="srch-toggles" role="group" aria-label="Search options">
            <FlagToggle icon={CaseSensitive} label="Match case" on={flags.caseSensitive} onToggle={() => toggleFlag('caseSensitive')} />
            <FlagToggle icon={Regex} label="Regular expression" on={flags.regex} onToggle={() => toggleFlag('regex')} />
            <FlagToggle icon={WholeWord} label="Whole word" on={flags.wholeWord} onToggle={() => toggleFlag('wholeWord')} />
          </div>
          <span className="srch-summary" aria-live="polite">
            {loading && <Spinner size={12} label={null} />}
            {loading && !summary ? 'Searching…' : summary}
          </span>
        </div>
        {problem && (
          <p id="srch-problem" className="srch-problem" role="alert">
            {problem}
          </p>
        )}
      </div>
      <div className="srch-body">{body}</div>
    </section>
  )
}

function FlagToggle({ icon: Icon, label, on, onToggle }: { icon: typeof Regex; label: string; on: boolean; onToggle: () => void }) {
  return (
    <Tooltip content={label} side="bottom" describe={false}>
      <button type="button" className={clsx('srch-toggle', on && 'is-on')} aria-pressed={on} aria-label={label} onClick={onToggle}>
        <Icon size={16} aria-hidden="true" />
      </button>
    </Tooltip>
  )
}
