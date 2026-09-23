/**
 * Raw log viewer: the main .log (fetched from logUrl), .blg / external documents' logs, or the
 * latexmk output kept in the compile response. Monospace, searchable (case-insensitive, with
 * next/previous), line wrapping toggle, download.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from 'react'
import clsx from 'clsx'
import { ChevronDown, ChevronUp, Download, Search, TextWrap, X } from 'lucide-react'
import type { CompileResponse } from '@folio/shared/api'
import { errorMessage, getText } from '../../api/client'
import { formatBytes } from '../../lib/format'
import { onSignOut } from '../../stores/auth'
import { Button, IconButton, Select, Spinner, TextField } from '../../ui'
import { viewableLogFiles } from './logUtils'

/** 'stdout' = latexmk output from the compile response; otherwise an output file URL */
export type RawSource = string

export const STDOUT_SOURCE = 'stdout'
const MAX_MATCHES = 5000
const MAX_RENDER_CHARS = 4 * 1024 * 1024

// Build outputs are immutable: cache fetched logs by URL (small LRU).
const cache = new Map<string, string>()
// logs of the previous account's projects never outlive its session
onSignOut(() => cache.clear())
function remember(url: string, text: string): void {
  cache.delete(url)
  cache.set(url, text)
  while (cache.size > 6) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

interface Props {
  build: CompileResponse
  source: RawSource | null
  onSourceChange: (s: RawSource) => void
}

export function RawLogView({ build, source, onSourceChange }: Props) {
  const files = useMemo(() => viewableLogFiles(build), [build])
  const effective = source && (source === STDOUT_SOURCE || files.some(f => f.url === source))
    ? source
    : files[0]?.url ?? STDOUT_SOURCE
  const file = files.find(f => f.url === effective) ?? null

  const [text, setText] = useState<string | null>(() => (effective === STDOUT_SOURCE ? build.stdout : cache.get(effective) ?? null))
  const [loadError, setLoadError] = useState<string | null>(null)
  const [wrap, setWrap] = useState(true)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [current, setCurrent] = useState(0)
  const [reload, setReload] = useState(0)
  const preRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    setLoadError(null)
    if (effective === STDOUT_SOURCE) {
      setText(build.stdout)
      return
    }
    const hit = cache.get(effective)
    if (hit !== undefined) {
      setText(hit)
      return
    }
    setText(null)
    const ac = new AbortController()
    getText(effective, { signal: ac.signal })
      .then(t => {
        remember(effective, t)
        setText(t)
      })
      .catch(e => {
        if (!ac.signal.aborted) setLoadError(errorMessage(e, 'The log could not be loaded.'))
      })
    return () => ac.abort()
  }, [effective, build.stdout, reload])

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 150)
    return () => clearTimeout(t)
  }, [query])

  const shown = text !== null && text.length > MAX_RENDER_CHARS ? text.slice(text.length - MAX_RENDER_CHARS) : text

  const matches = useMemo(() => {
    const q = debounced
    if (!q || !shown) return []
    const hay = shown.toLowerCase()
    const needle = q.toLowerCase()
    const out: number[] = []
    for (let i = hay.indexOf(needle); i >= 0 && out.length < MAX_MATCHES; i = hay.indexOf(needle, i + needle.length)) out.push(i)
    return out
  }, [shown, debounced])

  useEffect(() => {
    setCurrent(0)
  }, [debounced, effective])

  useEffect(() => {
    if (matches.length === 0) return
    const el = preRef.current?.querySelector<HTMLElement>('mark.is-current')
    el?.scrollIntoView({ block: 'center', inline: 'nearest' })
  }, [current, matches])

  const step = (dir: 1 | -1) => {
    if (matches.length === 0) return
    setCurrent(c => (c + dir + matches.length) % matches.length)
  }

  const onSearchKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      step(e.shiftKey ? -1 : 1)
    } else if (e.key === 'Escape' && query) {
      e.preventDefault()
      e.stopPropagation()
      setQuery('')
    }
  }

  const content = useMemo(() => {
    if (!shown) return null
    if (matches.length === 0) return shown
    const parts: (string | ReactElement)[] = []
    let pos = 0
    const len = debounced.length
    matches.forEach((m, i) => {
      if (m > pos) parts.push(shown.slice(pos, m))
      parts.push(
        <mark key={m} className={clsx('logs-raw__mark', i === current && 'is-current')}>
          {shown.slice(m, m + len)}
        </mark>,
      )
      pos = m + len
    })
    if (pos < shown.length) parts.push(shown.slice(pos))
    return parts
  }, [shown, matches, current, debounced])

  const options = [
    ...files.map(f => ({ value: f.url, label: `${f.path}${f.url === build.logUrl ? ' (main log)' : ''}` })),
    { value: STDOUT_SOURCE, label: 'Compiler output (latexmk)' },
  ]

  return (
    <div className="logs-raw">
      <div className="logs-raw__bar">
        <Select
          size="sm"
          aria-label="Log file"
          value={effective}
          options={options}
          onChange={e => onSourceChange(e.target.value)}
          wrapperClassName="logs-raw__select"
        />
        <TextField
          size="sm"
          icon={Search}
          value={query}
          placeholder="Search the log"
          aria-label="Search the log"
          onChange={e => setQuery(e.target.value)}
          onKeyDown={onSearchKey}
          wrapperClassName="logs-raw__search"
          trailing={
            query ? (
              <span className="logs-raw__count" aria-live="polite">
                {matches.length === 0 ? 'No matches' : `${current + 1} / ${matches.length}${matches.length >= MAX_MATCHES ? '+' : ''}`}
              </span>
            ) : undefined
          }
        />
        <IconButton icon={ChevronUp} size="sm" label="Previous match (Shift+Enter)" disabled={matches.length === 0} onClick={() => step(-1)} />
        <IconButton icon={ChevronDown} size="sm" label="Next match (Enter)" disabled={matches.length === 0} onClick={() => step(1)} />
        {query && <IconButton icon={X} size="sm" label="Clear search" onClick={() => setQuery('')} />}
        <span className="logs-raw__spacer" />
        <IconButton icon={TextWrap} size="sm" label={wrap ? 'Turn off line wrapping' : 'Wrap long lines'} active={wrap} onClick={() => setWrap(w => !w)} />
        {file && (
          <a className="logs-raw__download" href={file.url} download={file.path} aria-label={`Download ${file.path} (${formatBytes(file.size)})`} title={`Download ${file.path}`}>
            <Download size={14} aria-hidden="true" />
          </a>
        )}
      </div>
      <div className="logs-raw__body">
        {loadError ? (
          <div className="logs-raw__state">
            <p>{loadError}</p>
            <Button size="sm" onClick={() => setReload(r => r + 1)}>
              Try again
            </Button>
          </div>
        ) : text === null ? (
          <div className="logs-raw__state">
            <Spinner size={18} label="Loading the log" />
          </div>
        ) : text.trim() === '' ? (
          <div className="logs-raw__state">
            <p>{effective === STDOUT_SOURCE ? 'The compiler printed nothing.' : 'This log is empty.'}</p>
          </div>
        ) : (
          <pre ref={preRef} className={clsx('logs-raw__text', wrap && 'is-wrapped')} tabIndex={0} aria-label="Log text">
            {shown !== text && <span className="logs-raw__trimmed">… (showing the last {formatBytes(MAX_RENDER_CHARS)}; download the file for the rest){'\n'}</span>}
            {content}
          </pre>
        )}
      </div>
    </div>
  )
}
