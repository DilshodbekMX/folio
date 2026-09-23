import { useId, useState } from 'react'
import clsx from 'clsx'
import { ChevronDown, CircleAlert, CircleX, CodeXml, Info, Lightbulb, TriangleAlert, type LucideIcon } from 'lucide-react'
import type { LogEntry, LogLevel } from '@folio/shared/api'
import { useEditor } from '../../stores/editor'
import { useLayout } from '../../stores/layout'
import { useProject } from '../../stores/project'
import { Tooltip, toast } from '../../ui'
import { LEVEL_LABEL, locationLabel, type EntryGroup } from './logUtils'

const LEVEL_ICON: Record<LogLevel, LucideIcon> = {
  error: CircleX,
  warning: TriangleAlert,
  typesetting: CircleAlert,
  info: Info,
}

/** Open the entry's file at its line (keeps the logs pane open, like Overleaf). */
export function jumpToEntry(e: LogEntry): void {
  if (!e.file) return
  const layout = useLayout.getState()
  if (layout.view === 'pdf') layout.setView('split')
  if (layout.historyOpen) layout.setHistoryOpen(false)
  const ok = useEditor.getState().jumpTo({ path: e.file, line: e.line ?? 1 })
  if (!ok) toast(`Couldn’t open ${e.file}: it is not a file of this project.`, { tone: 'warning' })
}

/**
 * One log message. `hintCollapsed`: the same hint was already shown on an earlier card, so it is
 * only shown when the card is expanded (keeps long lists of identical warnings readable).
 */
export function LogEntryCard({ group, hintCollapsed = false }: { group: EntryGroup; hintCollapsed?: boolean }) {
  const { entry, count } = group
  const [open, setOpen] = useState(false)
  const rawId = useId()
  const inProject = useProject(s => (entry.file ? s.fileByPath(entry.file)?.kind === 'text' : false))
  const location = locationLabel(entry)
  const hasRaw = entry.content.trim().length > 0 && entry.content.trim() !== entry.message.trim()
  const hasDetails = hasRaw || (!!entry.hint && hintCollapsed)
  const showHint = !!entry.hint && (!hintCollapsed || open)
  const Icon = LEVEL_ICON[entry.level]

  return (
    <article className={clsx('logs-entry', `logs-entry--${entry.level}`, open && 'is-open')} aria-label={`${LEVEL_LABEL[entry.level]}: ${entry.message}`}>
      <div className="logs-entry__head">
        <Icon className="logs-entry__icon" size={16} aria-hidden="true" />
        <div className="logs-entry__main">
          <p className="logs-entry__msg">{entry.message}</p>
          {location && (
            <div className="logs-entry__meta">
              {inProject ? (
                <Tooltip content="Go to code location">
                  <button type="button" className="logs-entry__loc" onClick={() => jumpToEntry(entry)}>
                    {location}
                  </button>
                </Tooltip>
              ) : (
                <span className="logs-entry__loc is-static">{location}</span>
              )}
              {entry.source !== 'latex' && <span className="logs-entry__source">{entry.source}</span>}
            </div>
          )}
        </div>
        {count > 1 && (
          <Tooltip content={`Reported ${count} times`}>
            <span className="logs-entry__count" tabIndex={0} aria-label={`Reported ${count} times`}>
              ×{count}
            </span>
          </Tooltip>
        )}
        <div className="logs-entry__actions">
          {inProject && (
            <Tooltip content="Go to code location">
              <button type="button" className="logs-entry__btn" aria-label={`Go to code location: ${location ?? ''}`} onClick={() => jumpToEntry(entry)}>
                <CodeXml size={15} aria-hidden="true" />
              </button>
            </Tooltip>
          )}
          {hasDetails && (
            <Tooltip content={open ? 'Show less' : hasRaw ? 'Show the log excerpt' : 'Show the hint'}>
              <button
                type="button"
                className={clsx('logs-entry__btn logs-entry__toggle', open && 'is-open')}
                aria-expanded={open}
                aria-controls={hasRaw ? rawId : undefined}
                aria-label={open ? 'Show less' : hasRaw ? 'Show the log excerpt' : 'Show the hint'}
                onClick={() => setOpen(o => !o)}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            </Tooltip>
          )}
        </div>
      </div>
      {showHint && (
        <p className="logs-entry__hint">
          <Lightbulb size={14} aria-hidden="true" />
          <span>{entry.hint}</span>
        </p>
      )}
      {hasRaw && open && (
        <pre id={rawId} className="logs-entry__raw">
          {entry.content}
        </pre>
      )}
    </article>
  )
}
