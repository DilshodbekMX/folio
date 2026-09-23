/**
 * Logs and output files (SPEC §6.7): shown inside the PDF pane (over the viewer) while
 * useCompile.logsOpen. Tabs All / Errors / Warnings / Typesetting (bad boxes) with the counts of
 * the latest build's parsed log, entry cards (location → editor, hint, log excerpt; identical
 * entries folded into one card with ×N), info messages collapsed, the raw log viewer, other
 * output files and "Clear cached files".
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import { ArrowLeft, CircleAlert, CircleCheck, CircleX, FileSearch, RefreshCw, ScrollText, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { CompileResponse, CompileStatus, ParsedLog } from '@folio/shared/api'
import { COMPILERS } from '@folio/shared/api'
import { formatDateTime, formatDuration, formatRelative } from '../../lib/time'
import { useAuth } from '../../stores/auth'
import { useCompile } from '../../stores/compile'
import { Button, EmptyState, Spinner, Tabs, type TabDef } from '../../ui'
import { LogEntryCard } from './LogEntryCard'
import { OutputFiles } from './OutputFiles'
import { RawLogView, STDOUT_SOURCE, type RawSource } from './RawLogView'
import { entriesFor, groupEntries, logCounts, type LogFilter } from './logUtils'
import './logs.css'

type Tab = LogFilter | 'raw'
const MAX_CARDS = 100

const STATUS_TEXT: Record<CompileStatus, string> = {
  success: 'Compiled',
  failure: 'Compile failed — no PDF',
  'stopped-on-first-error': 'Stopped on the first error',
  timedout: 'Compile timed out',
  terminated: 'Compilation cancelled',
  error: 'Server error',
  'too-recently-compiled': 'Compiled',
  unavailable: 'Compile server busy',
  'no-root': 'No main document',
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(t)
  }, [intervalMs])
  return now
}

/** "Compiled antiddos_v2_supplementary.tex" — names the compiled document (several may have a \documentclass). */
function CompileSummary({ build }: { build: CompileResponse }) {
  const now = useNow(30_000)
  const meId = useAuth(s => s.me?.id)
  const ok = build.status === 'success'
  const compiler = COMPILERS.find(c => c.id === build.compiler)?.label ?? build.compiler
  const errors = build.log?.errors.length ?? 0
  const tone = ok ? (errors > 0 ? 'is-warn' : 'is-ok') : 'is-bad'
  // a check mark only for a clean build; a PDF with errors gets a warning sign
  const Icon = ok ? (errors > 0 ? TriangleAlert : CircleCheck) : CircleX
  const bits = [
    !ok && build.rootPath ? build.rootPath : null,
    formatDuration(build.timings.totalMs),
    compiler,
    build.by && build.by.id !== meId ? `by ${build.by.name}` : null,
  ].filter(Boolean)
  return (
    <p className={clsx('logs-summary', tone)}>
      <Icon size={14} aria-hidden="true" />
      <span className="logs-summary__status">
        {STATUS_TEXT[build.status]}
        {ok && build.rootPath && (
          <>
            {' '}
            <span className="logs-summary__doc">{build.rootPath}</span>
          </>
        )}
        {ok && errors > 0 ? ' with errors' : ''}
      </span>
      <span className="logs-summary__time" title={formatDateTime(build.compiledAt)}>
        {formatRelative(build.compiledAt, now)}
      </span>
      <span className="logs-summary__meta">{bits.join(' · ')}</span>
    </p>
  )
}

/**
 * Tab label that stays readable in a narrow PDF pane: there the text gives way to the level's
 * icon (or a short word) and stays available to screen readers and as a hover title.
 */
function TabLabel({ text, icon: Icon, short }: { text: string; icon: LucideIcon; short?: string }) {
  return (
    <span className="logs-tab" title={text}>
      {!short && <Icon className="logs-tab__icon" size={14} aria-hidden="true" />}
      <span className="logs-tab__text">{text}</span>
      {short && (
        <span className="logs-tab__short" aria-hidden="true">
          {short}
        </span>
      )}
    </span>
  )
}

function EntryList({ log, filter, build, onRaw }: { log: ParsedLog; filter: LogFilter; build: CompileResponse; onRaw: (s: RawSource) => void }) {
  const entries = useMemo(() => entriesFor(log, filter), [log, filter])
  const groups = useMemo(() => groupEntries(entries), [entries])
  const infoGroups = useMemo(() => groupEntries(log.info), [log])
  const shown = useMemo(() => groups.slice(0, MAX_CARDS), [groups])
  const ok = build.status === 'success'
  // show each distinct hint once in full; repeats are folded into the card's details
  const hintSeenBefore = useMemo(() => {
    const seen = new Set<string>()
    return shown.map(g => {
      const h = g.entry.hint
      if (!h) return false
      if (seen.has(h)) return true
      seen.add(h)
      return false
    })
  }, [shown])

  if (groups.length === 0 && !(filter === 'all' && infoGroups.length > 0)) {
    if (filter === 'errors' || (filter === 'all' && ok)) {
      return (
        <EmptyState icon={CircleCheck} title={filter === 'errors' ? 'No errors, great!' : 'No errors or warnings, great!'} className="logs-empty logs-empty--ok">
          {ok ? 'LaTeX finished without complaints.' : 'The log has no errors, but no PDF was produced — check the raw logs.'}
        </EmptyState>
      )
    }
    const text = filter === 'warnings' ? 'No warnings.' : filter === 'typesetting' ? 'No overfull or underfull boxes.' : 'The log contains no errors or warnings.'
    return (
      <EmptyState
        icon={CircleCheck}
        title={text}
        className="logs-empty"
        actions={
          !ok ? (
            <Button size="sm" variant="secondary" icon={ScrollText} onClick={() => onRaw(STDOUT_SOURCE)}>
              Show the compiler output
            </Button>
          ) : undefined
        }
      />
    )
  }

  return (
    <div className="logs-list">
      {groups.length > MAX_CARDS && (
        <p className="logs-note">
          {groups.length} distinct messages — showing the first {MAX_CARDS}. Fix the first error, or turn on “Stop on first error” to find it faster.
        </p>
      )}
      {shown.map((g, i) => (
        <LogEntryCard key={g.key} group={g} hintCollapsed={hintSeenBefore[i]} />
      ))}
      {filter === 'all' && infoGroups.length > 0 && (
        <details className="logs-info">
          <summary>
            {log.info.length} info {log.info.length === 1 ? 'message' : 'messages'}
          </summary>
          <div className="logs-info__list">
            {infoGroups.slice(0, MAX_CARDS).map(g => (
              <LogEntryCard key={g.key} group={g} />
            ))}
          </div>
        </details>
      )}
    </div>
  )
}

export function LogsPane() {
  const last = useCompile(s => s.last)
  const compiling = useCompile(s => s.status === 'compiling')
  const [tab, setTab] = useState<Tab>('all')
  const [rawSource, setRawSource] = useState<RawSource | null>(null)
  const rootRef = useRef<HTMLElement | null>(null)
  const counts = logCounts(last?.log)
  const log = last?.log ?? null

  const close = () => {
    useCompile.getState().setLogsOpen(false)
    // give focus back to the toggle in the PDF toolbar
    requestAnimationFrame(() => document.querySelector<HTMLElement>('.pdf-logsbtn')?.focus({ preventScroll: true }))
  }
  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    // focus the pane when it opens so Escape / keyboard navigation work right away
    rootRef.current?.focus({ preventScroll: true })
  }, [])

  // Escape closes the pane while focus is inside it — or nowhere (e.g. the focused button was
  // removed after "Clear cached files") — unless a dialog or menu handles the key first.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('[data-ui-layer="modal"], [data-ui-layer="menu"]')) return
      const active = document.activeElement
      const root = rootRef.current
      if (active && active !== document.body && !(root && root.contains(active))) return
      e.preventDefault()
      closeRef.current()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  const showRaw = (s: RawSource) => {
    setRawSource(s)
    setTab('raw')
  }

  const tabs: TabDef[] = [
    { id: 'all', label: 'All', badge: counts.errors + counts.warnings + counts.typesetting, badgeTone: 'neutral' },
    { id: 'errors', label: <TabLabel text="Errors" icon={CircleX} />, badge: counts.errors, badgeTone: counts.errors > 0 ? 'danger' : 'neutral' },
    { id: 'warnings', label: <TabLabel text="Warnings" icon={TriangleAlert} />, badge: counts.warnings, badgeTone: counts.warnings > 0 ? 'warning' : 'neutral' },
    { id: 'typesetting', label: <TabLabel text="Typesetting" icon={CircleAlert} />, badge: counts.typesetting, badgeTone: counts.typesetting > 0 ? 'info' : 'neutral' },
    { id: 'raw', label: <TabLabel text="Raw logs" icon={ScrollText} short="Raw" /> },
  ]

  let body: ReactNode
  if (!last) {
    body = compiling ? (
      <div className="logs-state">
        <Spinner size={20} label="Compiling" />
        <p>Compiling… the logs appear here when it finishes.</p>
      </div>
    ) : (
      <EmptyState
        icon={FileSearch}
        title="No logs yet"
        className="logs-empty"
        actions={
          <Button size="sm" variant="primary" icon={RefreshCw} onClick={() => void useCompile.getState().compile()}>
            Recompile
          </Button>
        }
      >
        Compile the project to see its logs and output files here.
      </EmptyState>
    )
  } else if (tab === 'raw') {
    body = <RawLogView build={last} source={rawSource} onSourceChange={setRawSource} />
  } else {
    body = (
      <div className="logs-scroll">
        {log ? (
          <EntryList log={log} filter={tab} build={last} onRaw={showRaw} />
        ) : (
          <EmptyState
            icon={ScrollText}
            title="The compiler produced no log file"
            className="logs-empty"
            actions={
              last.stdout.trim() ? (
                <Button size="sm" variant="secondary" icon={ScrollText} onClick={() => showRaw(STDOUT_SOURCE)}>
                  Show the compiler output
                </Button>
              ) : undefined
            }
          >
            {last.stdout.trim() ? 'The compiler output may explain what went wrong.' : 'Try recompiling.'}
          </EmptyState>
        )}
        <OutputFiles build={last} onView={url => showRaw(url)} />
      </div>
    )
  }

  return (
    <section ref={rootRef} className="logs-pane" aria-label="Logs and output files" tabIndex={-1}>
      <header className="logs-head">
        <div className="logs-head__row">
          <Button size="sm" variant="ghost" icon={ArrowLeft} onClick={close} className="logs-head__back">
            Back to PDF
          </Button>
          <h2 className="logs-head__title">Logs and output files</h2>
          {compiling ? (
            <p className="logs-summary is-busy">
              <Spinner size={12} label={null} />
              <span className="logs-summary__status">Compiling…</span>
            </p>
          ) : (
            last && <CompileSummary build={last} />
          )}
        </div>
        {last && <Tabs tabs={tabs} active={tab} onChange={id => setTab(id as Tab)} label="Log filter" idPrefix="logs" className="logs-tabs" />}
      </header>
      <div className="logs-body" role={last ? 'tabpanel' : undefined} id={last ? `logs-panel-${tab}` : undefined} aria-labelledby={last ? `logs-tab-${tab}` : undefined}>
        {body}
      </div>
    </section>
  )
}
