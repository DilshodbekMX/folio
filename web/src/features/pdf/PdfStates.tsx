/**
 * What the PDF pane shows instead of (or on top of) the PDF:
 *   - FirstCompile: no build yet (Recompile call to action) / first compile running
 *   - CompileFailure: the latest compile produced no PDF and there is no older PDF (error
 *     summary with the first errors, the compiler output tail and the fitting next step)
 *   - CompileBanner: the latest compile failed but an older PDF is still shown, or the request
 *     itself failed (network, server busy), or it ran with offline documents
 *   - ViewerError: the PDF exists but pdf.js could not display it
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  CircleAlert, CircleStop, CircleX, Clock, CloudOff, FileText, OctagonX, RefreshCw, ScrollText, ServerCrash, Settings2, X,
} from 'lucide-react'
import type { CompileResponse, CompileStatus, LogEntry } from '@folio/shared/api'
import { basename } from '@folio/shared/paths'
import { compileStatusMessage, useCompile } from '../../stores/compile'
import { useLayout } from '../../stores/layout'
import { useProject } from '../../stores/project'
import { Button, Kbd, Spinner } from '../../ui'
import { jumpToEntry } from '../logs/LogEntryCard'
import { locationLabel } from '../logs/logUtils'
import { runCompile, stopCompile } from './CompileButton'

const STDOUT_TAIL_LINES = 60

function stdoutTail(stdout: string): string {
  const lines = stdout.replace(/\s+$/, '').split('\n')
  return lines.slice(-STDOUT_TAIL_LINES).join('\n')
}

/** The '[Folio] …' explanation the server appends for timeouts, stops and infrastructure errors. */
function folioNote(stdout: string): string | null {
  const lines = stdout.split('\n').filter(l => l.startsWith('[Folio] '))
  return lines.length ? lines[lines.length - 1].slice(8) : null
}

function openLogs(): void {
  useCompile.getState().setLogsOpen(true)
}

// -- first compile ----------------------------------------------------------------------------------

export function FirstCompile({ loading, recompiling = false }: { loading: boolean; recompiling?: boolean }) {
  const compiling = useCompile(s => s.status === 'compiling')
  const canEdit = useProject(s => s.role === 'owner' || s.role === 'editor')
  const autoCompile = useCompile(s => s.options.autoCompile)

  if (loading) {
    return (
      <div className="pdf-state pdf-state--quiet" aria-busy="true">
        <Spinner size={20} label="Loading the PDF" />
      </div>
    )
  }
  if (compiling) {
    return (
      <div className="pdf-state" aria-live="polite">
        <div className="pdf-state__card">
          <Spinner size={26} label={null} />
          <h3 className="pdf-state__title">Compiling…</h3>
          <p className="pdf-state__text">
            {recompiling
              ? 'The PDF appears here as soon as LaTeX has finished.'
              : 'The first compile of a project takes a little longer while LaTeX builds its auxiliary files.'}
          </p>
          {canEdit && (
            <div className="pdf-state__actions">
              <Button size="sm" variant="secondary" icon={CircleStop} onClick={() => void stopCompile()}>
                Stop compilation
              </Button>
            </div>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="pdf-state">
      <div className="pdf-state__card">
        <div className="pdf-state__paper" aria-hidden="true">
          <FileText size={28} strokeWidth={1.5} />
        </div>
        <h3 className="pdf-state__title">No PDF yet</h3>
        <p className="pdf-state__text">
          Compile the project to see the PDF here.
          {canEdit && autoCompile ? ' After that it recompiles by itself while you type.' : ''}
          {canEdit ? '' : ' It also appears here as soon as an editor compiles it.'}
        </p>
        <div className="pdf-state__actions">
          <Button variant="primary" icon={RefreshCw} onClick={() => runCompile()}>
            Recompile
          </Button>
        </div>
        {canEdit && (
          <p className="pdf-state__hint">
            or press <Kbd keys="Mod-Enter" />
          </p>
        )}
      </div>
    </div>
  )
}

// -- failure without any PDF ------------------------------------------------------------------------

interface FailureInfo {
  icon: typeof CircleX
  title: string
  text: ReactNode
  tone: 'error' | 'warning' | 'neutral'
}

function failureInfo(status: CompileStatus): FailureInfo {
  switch (status) {
    case 'stopped-on-first-error':
      return {
        icon: OctagonX,
        tone: 'error',
        title: 'No PDF: “Stop on first error” is on',
        text: '“Stop on first error” is enabled. Turning it off may let LaTeX produce a PDF anyway — your project will still have errors.',
      }
    case 'timedout':
      return {
        icon: Clock,
        tone: 'warning',
        title: 'Timed out',
        text: (
          <>
            Your compile took too long and was stopped. The most common causes are:
            <ul className="pdf-state__list">
              <li>large or high-resolution images, or complex TikZ/pgfplots figures;</li>
              <li>a fatal error that keeps LaTeX from finishing — “Stop on first error” helps to find it;</li>
              <li>an endless loop in a macro.</li>
            </ul>
          </>
        ),
      }
    case 'terminated':
      return {
        icon: CircleStop,
        tone: 'neutral',
        title: 'Compilation cancelled',
        text: 'The compile was stopped with “Stop compilation”. The raw logs show how far it got.',
      }
    case 'error':
      return {
        icon: ServerCrash,
        tone: 'error',
        title: 'Server error',
        text: 'The compiler could not be run. If this keeps happening, the TeX installation (Docker) on the server needs attention.',
      }
    case 'no-root':
      return {
        icon: Settings2,
        tone: 'warning',
        title: 'Unknown main document',
        text: 'Folio could not tell which file to compile. Choose the main document in Settings → Compiler, or right-click a .tex file and choose “Set as main document”.',
      }
    default:
      return {
        icon: CircleX,
        tone: 'error',
        title: 'No PDF',
        text: 'LaTeX finished without producing a PDF. This usually means there is an error in the document — fix the first one below, then recompile.',
      }
  }
}

function ErrorPreview({ entries }: { entries: LogEntry[] }) {
  if (entries.length === 0) return null
  return (
    <ul className="pdf-errlist" aria-label="First errors">
      {entries.map((e, i) => {
        const loc = locationLabel(e)
        return (
          <li key={i} className="pdf-errlist__item">
            <CircleX className="pdf-errlist__icon" size={14} aria-hidden="true" />
            <div className="pdf-errlist__main">
              <p className="pdf-errlist__msg">{e.message}</p>
              {loc && (
                <button type="button" className="pdf-errlist__loc" onClick={() => jumpToEntry(e)}>
                  {loc}
                </button>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

export function CompileFailure({ build }: { build: CompileResponse }) {
  const canEdit = useProject(s => s.role === 'owner' || s.role === 'editor')
  const compiling = useCompile(s => s.status === 'compiling')
  const info = failureInfo(build.status)
  const errors = build.log?.errors ?? []
  const note = folioNote(build.stdout)
  const tail = useMemo(() => stdoutTail(build.stdout), [build.stdout])
  const [showOutput, setShowOutput] = useState(build.status === 'error' || !build.log)
  const Icon = info.icon

  // viewers may recompile (with their own options) but not change the project settings
  let primary: ReactNode = null
  if (build.status !== 'no-root' || canEdit) {
    if (build.status === 'stopped-on-first-error') {
      primary = (
        <Button
          variant="primary"
          onClick={() => {
            useCompile.getState().setOption('stopOnFirstError', false)
            runCompile()
          }}
        >
          Turn off “Stop on first error” and recompile
        </Button>
      )
    } else if (build.status === 'timedout' && !useCompile.getState().options.stopOnFirstError) {
      primary = (
        <Button
          variant="primary"
          onClick={() => {
            useCompile.getState().setOption('stopOnFirstError', true)
            runCompile()
          }}
        >
          Turn on “Stop on first error” and recompile
        </Button>
      )
    } else if (build.status === 'no-root') {
      primary = (
        <Button variant="primary" icon={Settings2} onClick={() => useLayout.getState().openModal('settings')}>
          Open settings
        </Button>
      )
    } else {
      primary = (
        <Button variant="primary" icon={RefreshCw} loading={compiling} onClick={() => runCompile()}>
          Recompile
        </Button>
      )
    }
  }

  return (
    <div className="pdf-state pdf-state--failure">
      <div className={clsx('pdf-fail', `pdf-fail--${info.tone}`)} role="alert">
        <div className="pdf-fail__head">
          <span className="pdf-fail__icon" aria-hidden="true">
            <Icon size={18} />
          </span>
          <h3 className="pdf-fail__title">{info.title}</h3>
        </div>
        <div className="pdf-fail__text">{info.text}</div>
        {note && build.status !== 'terminated' && <p className="pdf-fail__note">{note}</p>}
        <ErrorPreview entries={errors.slice(0, 3)} />
        {errors.length > 3 && <p className="pdf-fail__more">and {errors.length - 3} more {errors.length - 3 === 1 ? 'error' : 'errors'} in the logs.</p>}
        <div className="pdf-fail__actions">
          {primary}
          {build.status !== 'no-root' && (
            <Button variant="secondary" icon={ScrollText} onClick={openLogs}>
              View logs
            </Button>
          )}
          {canEdit && (build.status === 'failure' || build.status === 'terminated' || build.status === 'timedout') && (
            <Button variant="ghost" onClick={() => runCompile({ fromScratch: true })}>
              Recompile from scratch
            </Button>
          )}
        </div>
        {tail.trim() && (
          <div className="pdf-fail__output">
            <button type="button" className="pdf-fail__toggle" aria-expanded={showOutput} onClick={() => setShowOutput(v => !v)}>
              {showOutput ? 'Hide compiler output' : 'Show compiler output'}
            </button>
            {showOutput && (
              <pre className="pdf-fail__pre" tabIndex={0} aria-label="Compiler output (last lines)">
                {tail}
              </pre>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// -- banner over an older PDF ---------------------------------------------------------------------

interface BannerSpec {
  key: string
  tone: 'error' | 'warning' | 'info'
  icon: typeof CircleX
  text: ReactNode
  logs?: boolean
}

export function CompileBanner() {
  const last = useCompile(s => s.last)
  const lastWithPdf = useCompile(s => s.lastWithPdf)
  const error = useCompile(s => s.error)
  const offline = useCompile(s => s.offline)
  const compiling = useCompile(s => s.status === 'compiling')
  const [dismissed, setDismissed] = useState<string | null>(null)

  const spec = useMemo<BannerSpec | null>(() => {
    const statusMsg = last ? compileStatusMessage(last.status) : null
    // the request failed or was refused without a new build (network, server busy, …)
    if (error && error !== statusMsg) {
      return { key: `req:${error}`, tone: 'error', icon: CircleAlert, text: error }
    }
    if (last && lastWithPdf && last !== lastWithPdf && last.status !== 'success' && !last.pdfUrl) {
      // the document compiled has no PDF yet: the one below is of another root document
      const other = !!last.rootPath && !!lastWithPdf.rootPath && last.rootPath !== lastWithPdf.rootPath
      const shown = other
        ? `The PDF below is of ${basename(lastWithPdf.rootPath!)}; ${basename(last.rootPath!)} has none yet.`
        : 'The PDF below is from the last successful compile.'
      const map: Partial<Record<CompileStatus, string>> = {
        failure: 'The last compile produced no PDF.',
        'stopped-on-first-error': 'The last compile stopped on the first error.',
        timedout: 'The last compile timed out.',
        terminated: 'The last compile was cancelled.',
        error: 'The last compile failed on the server.',
        'no-root': 'Folio couldn’t find the main document.',
      }
      const head = map[last.status] ?? statusMsg ?? 'The last compile failed.'
      return {
        key: `build:${last.buildId ?? last.compiledAt}`,
        tone: last.status === 'terminated' ? 'info' : 'error',
        icon: last.status === 'timedout' ? Clock : CircleX,
        text: (
          <>
            <strong>{head}</strong> {shown}
          </>
        ),
        logs: last.status !== 'no-root',
      }
    }
    if (offline && last) {
      return {
        key: `offline:${last.buildId ?? last.compiledAt}`,
        tone: 'warning',
        icon: CloudOff,
        text: 'Some of your files were offline, so this PDF was built from the last version the server received.',
      }
    }
    return null
  }, [last, lastWithPdf, error, offline])

  // a new problem shows the banner again
  useEffect(() => {
    if (compiling) setDismissed(null)
  }, [compiling])

  if (!spec || dismissed === spec.key) return null
  const Icon = spec.icon
  return (
    <div className={clsx('pdf-banner', `pdf-banner--${spec.tone}`)} role={spec.tone === 'error' ? 'alert' : 'status'}>
      <Icon className="pdf-banner__icon" size={15} aria-hidden="true" />
      <p className="pdf-banner__text">{spec.text}</p>
      {spec.logs && (
        <button type="button" className="pdf-banner__action" onClick={openLogs}>
          View logs
        </button>
      )}
      <button type="button" className="pdf-banner__close" aria-label="Dismiss" onClick={() => setDismissed(spec.key)}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

// -- pdf.js could not display the PDF -------------------------------------------------------------

export function ViewerError({ message, onRetry }: { message: string; onRetry: () => void }) {
  const pdfUrl = useCompile(s => s.lastWithPdf?.pdfUrl ?? null)
  return (
    <div className="pdf-state">
      <div className="pdf-fail pdf-fail--warning" role="alert">
        <div className="pdf-fail__head">
          <span className="pdf-fail__icon" aria-hidden="true">
            <CircleAlert size={18} />
          </span>
          <h3 className="pdf-fail__title">The PDF couldn’t be displayed</h3>
        </div>
        <p className="pdf-fail__text">{message}</p>
        <div className="pdf-fail__actions">
          <Button variant="primary" icon={RefreshCw} onClick={onRetry}>
            Try again
          </Button>
          {pdfUrl && (
            <a className="ui-btn ui-btn--secondary ui-btn--md" href={pdfUrl} target="_blank" rel="noopener noreferrer">
              Open the PDF file
            </a>
          )}
        </div>
      </div>
    </div>
  )
}
