/**
 * PDF pane toolbar: Recompile split button, Logs toggle with error/warning counts, "out of
 * date" / "auto-compile paused" chips, a chip naming the document when the PDF is not of the main
 * document (the supplement), Download PDF, Open in new tab — and on the right the page
 * indicator (type a number to jump) and zoom out / zoom menu / zoom in. On narrow panes labels
 * collapse (CSS container queries) and secondary actions move into a "More" menu.
 */
import { useEffect, useState, type FormEvent } from 'react'
import clsx from 'clsx'
import { ChevronDown, CirclePause, Download, Ellipsis, ExternalLink, FileText, Minus, Plus, ScrollText } from 'lucide-react'
import { basename } from '@folio/shared/paths'
import { getBlob } from '../../api/client'
import { downloadBlob, downloadUrl, openInNewTab } from '../../lib/download'
import { useCompile } from '../../stores/compile'
import { useProject } from '../../stores/project'
import { DropdownMenu, IconButton, Tooltip, type MenuItem } from '../../ui'
import { logCounts } from '../logs/logUtils'
import { useAutoCompileState } from './autoCompile'
import { CompileButton, runCompile } from './CompileButton'
import { pdfDownloadName } from './downloadName'
import { getPdfController, usePdfView } from './viewer/store'
import { ZOOM_STEPS, percentLabel, zoomLabel } from './zoom'

/** Path of the project's main document (null when none is set). */
function mainDocPath(s: ReturnType<typeof useProject.getState>): string | null {
  const id = s.settings?.rootFileId
  return id ? (s.files[id]?.path ?? null) : null
}

/**
 * Save the PDF on screen as "<project name>.pdf" — or "<project name> - <jobname>.pdf" when it is
 * of another root document than the main one (the supplement), so it is never saved under the
 * paper's name. The build URL answers with its own file name in Content-Disposition, which
 * browsers prefer over the download attribute, so the bytes are fetched (same origin, immutable
 * and usually cached) and saved under that name.
 */
export async function downloadPdf(): Promise<void> {
  const build = useCompile.getState().lastWithPdf
  const url = build?.pdfUrl
  if (!url) return
  const project = useProject.getState()
  const name = pdfDownloadName(project.name, build, mainDocPath(project))
  try {
    downloadBlob(await getBlob(url), name)
  } catch (e) {
    console.warn('[pdf] download via blob failed, falling back to the build URL', e)
    downloadUrl(url, name)
  }
}

function openPdf(): void {
  const url = useCompile.getState().lastWithPdf?.pdfUrl
  if (url) openInNewTab(url)
}

function LogsButton() {
  const open = useCompile(s => s.logsOpen)
  const log = useCompile(s => s.last?.log ?? null)
  const { errors, warnings } = logCounts(log)
  const parts = [errors > 0 ? `${errors} ${errors === 1 ? 'error' : 'errors'}` : null, warnings > 0 ? `${warnings} ${warnings === 1 ? 'warning' : 'warnings'}` : null].filter(Boolean)
  const label = open ? 'Back to PDF' : `Logs and output files${parts.length ? ` (${parts.join(', ')})` : ''}`
  return (
    <Tooltip content={open ? 'Back to PDF' : 'Logs and output files'} side="bottom">
      <button
        type="button"
        className={clsx('pdf-tbtn pdf-logsbtn', open && 'is-active')}
        aria-pressed={open}
        aria-label={label}
        onClick={() => useCompile.getState().setLogsOpen(!open)}
      >
        <ScrollText size={16} aria-hidden="true" />
        <span className="pdf-tbtn__label">Logs</span>
        {errors > 0 && (
          <span className="pdf-count pdf-count--error" aria-hidden="true" data-testid="pdf-errors">
            {errors > 99 ? '99+' : errors}
          </span>
        )}
        {warnings > 0 && (
          <span className="pdf-count pdf-count--warning" aria-hidden="true" data-testid="pdf-warnings">
            {warnings > 99 ? '99+' : warnings}
          </span>
        )}
      </button>
    </Tooltip>
  )
}

/**
 * Which document the PDF is of, when that is not simply the main document: another root document
 * (the supplement), or — until the document open in the editor has been compiled — the one that
 * was on screen before.
 */
function DocumentChip() {
  const shown = useCompile(s => s.lastWithPdf?.rootPath ?? null)
  const followed = useCompile(s => s.root)
  const main = useProject(s => mainDocPath(s))
  if (!shown || ((!main || shown === main) && (!followed || shown === followed))) return null
  const tip = followed && followed !== shown
    ? `This PDF is of ${shown}. Recompile to build ${followed}.`
    : `This PDF is of ${shown}${main ? `, not the main document ${main}` : ''}.`
  return (
    <Tooltip content={tip} side="bottom">
      <span className="pdf-chip pdf-chip--doc" tabIndex={0} role="note" aria-label={tip} data-testid="pdf-doc">
        <FileText size={13} aria-hidden="true" />
        <span className="pdf-chip__text">{basename(shown)}</span>
      </span>
    </Tooltip>
  )
}

/** Subtle chips: PDF out of date / auto-compile paused. */
function StatusChips() {
  const changed = useCompile(s => s.changedSinceCompile)
  const compiling = useCompile(s => s.status === 'compiling')
  const hasPdf = useCompile(s => !!s.lastWithPdf)
  const scheduled = useAutoCompileState(s => s.scheduled)
  const paused = useAutoCompileState(s => s.paused)
  // don't flash the chip while typing with auto-compile about to run
  const [settled, setSettled] = useState(false)
  const stale = changed && hasPdf && !compiling && !scheduled
  useEffect(() => {
    if (!stale) {
      setSettled(false)
      return
    }
    const t = setTimeout(() => setSettled(true), 700)
    return () => clearTimeout(t)
  }, [stale])

  return (
    <>
      {paused && (
        <Tooltip content={paused.message} side="bottom">
          <span className="pdf-chip pdf-chip--paused" tabIndex={0} role="status" aria-label="Auto-compile paused">
            <CirclePause size={14} aria-hidden="true" />
            <span className="pdf-chip__text">Auto-compile paused</span>
          </span>
        </Tooltip>
      )}
      {stale && settled && !paused && (
        <Tooltip content="There are changes since the last compile. Recompile to update the PDF." side="bottom">
          <button type="button" className="pdf-chip pdf-chip--stale" aria-label="PDF out of date — recompile" onClick={() => runCompile()}>
            <span className="pdf-chip__dot" aria-hidden="true" />
            <span className="pdf-chip__text">Out of date</span>
          </button>
        </Tooltip>
      )}
    </>
  )
}

function PageControl() {
  const page = usePdfView(s => s.page)
  const pages = usePdfView(s => s.pages)
  const ready = usePdfView(s => s.status === 'ready')
  const [draft, setDraft] = useState<string | null>(null)

  if (!ready || pages === 0) return null

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const n = Number(draft)
    if (Number.isFinite(n) && n >= 1) getPdfController()?.goToPage(Math.min(pages, Math.round(n)))
    setDraft(null)
  }

  return (
    <form className="pdf-page" onSubmit={submit}>
      <input
        className="pdf-page__input"
        inputMode="numeric"
        aria-label={`Page number, ${page} of ${pages}`}
        value={draft ?? String(page)}
        size={Math.max(1, String(pages).length)}
        onFocus={e => e.currentTarget.select()}
        onChange={e => setDraft(e.target.value.replace(/[^\d]/g, ''))}
        onBlur={() => setDraft(null)}
        onKeyDown={e => {
          if (e.key === 'Escape') {
            setDraft(null)
            e.currentTarget.blur()
          }
        }}
      />
      <span className="pdf-page__total" aria-hidden="true">
        / {pages}
      </span>
    </form>
  )
}

function zoomItems(scaleValue: string, scale: number): MenuItem[] {
  const ctrl = getPdfController()
  const numeric = Number(scaleValue)
  return [
    { label: 'Zoom in', shortcut: 'Mod-+', onSelect: () => ctrl?.zoomIn(), keepOpen: true },
    { label: 'Zoom out', shortcut: 'Mod--', onSelect: () => ctrl?.zoomOut(), keepOpen: true },
    { type: 'separator' },
    { type: 'radio', label: 'Fit to width', shortcut: 'Mod-0', checked: scaleValue === 'page-width', onSelect: () => ctrl?.setScaleValue('page-width') },
    { type: 'radio', label: 'Fit to page', shortcut: 'Mod-9', checked: scaleValue === 'page-fit', onSelect: () => ctrl?.setScaleValue('page-fit') },
    { type: 'separator' },
    { type: 'header', label: `Zoom to · now ${percentLabel(scale)}` },
    ...ZOOM_STEPS.map<MenuItem>(z => ({
      type: 'radio',
      label: percentLabel(z),
      checked: Number.isFinite(numeric) && Math.abs(numeric - z) < 0.001,
      onSelect: () => ctrl?.setScaleValue(String(z)),
    })),
  ]
}

function ZoomControls() {
  const scale = usePdfView(s => s.scale)
  const scaleValue = usePdfView(s => s.scaleValue)
  const ready = usePdfView(s => s.status === 'ready')
  if (!ready) return null
  const label = zoomLabel(scaleValue, scale)
  return (
    <div className="pdf-zoom" role="group" aria-label="Zoom">
      <IconButton icon={Minus} size="sm" label="Zoom out" tooltip={`Zoom out`} className="pdf-zoom__step" onClick={() => getPdfController()?.zoomOut()} />
      <DropdownMenu
        align="end"
        minWidth={210}
        items={zoomItems(scaleValue, scale)}
        trigger={
          <button type="button" className="pdf-zoom__menu" aria-label={`PDF zoom level: ${label}`}>
            <span className="pdf-zoom__label">{label}</span>
            <ChevronDown size={13} aria-hidden="true" />
          </button>
        }
      />
      <IconButton icon={Plus} size="sm" label="Zoom in" className="pdf-zoom__step" onClick={() => getPdfController()?.zoomIn()} />
    </div>
  )
}

function MoreMenu({ hasPdf }: { hasPdf: boolean }) {
  const scaleValue = usePdfView(s => s.scaleValue)
  const ready = usePdfView(s => s.status === 'ready')
  const ctrl = () => getPdfController()
  const items: MenuItem[] = [
    { label: 'Download PDF', icon: Download, disabled: !hasPdf, onSelect: () => void downloadPdf() },
    { label: 'Open PDF in new tab', icon: ExternalLink, disabled: !hasPdf, onSelect: openPdf },
    { type: 'separator' },
    { label: 'Zoom in', icon: Plus, shortcut: 'Mod-+', disabled: !ready, keepOpen: true, onSelect: () => ctrl()?.zoomIn() },
    { label: 'Zoom out', icon: Minus, shortcut: 'Mod--', disabled: !ready, keepOpen: true, onSelect: () => ctrl()?.zoomOut() },
    { type: 'radio', label: 'Fit to width', checked: scaleValue === 'page-width', disabled: !ready, onSelect: () => ctrl()?.setScaleValue('page-width') },
    { type: 'radio', label: 'Fit to page', checked: scaleValue === 'page-fit', disabled: !ready, onSelect: () => ctrl()?.setScaleValue('page-fit') },
  ]
  return (
    <DropdownMenu
      align="end"
      items={items}
      trigger={
        <button type="button" className="pdf-tbtn pdf-more" aria-label="More PDF actions">
          <Ellipsis size={16} aria-hidden="true" />
        </button>
      }
    />
  )
}

export function PdfToolbar() {
  const hasPdf = useCompile(s => !!s.lastWithPdf?.pdfUrl)
  const noPdfTip = 'Compile your project to download the PDF'
  return (
    <div className="pdf-toolbar" role="toolbar" aria-label="PDF toolbar">
      <div className="pdf-toolbar__left">
        <CompileButton />
        <LogsButton />
        <StatusChips />
        <DocumentChip />
      </div>
      <div className="pdf-toolbar__right">
        <PageControl />
        <ZoomControls />
        <span className="pdf-toolbar__sep" aria-hidden="true" />
        <IconButton icon={Download} size="sm" label="Download PDF" tooltip={hasPdf ? 'Download PDF' : noPdfTip} aria-disabled={!hasPdf || undefined} className={clsx('pdf-wide', !hasPdf && 'is-disabled')} onClick={() => hasPdf && void downloadPdf()} />
        <IconButton icon={ExternalLink} size="sm" label="Open PDF in new tab" tooltip={hasPdf ? 'Open PDF in new tab' : noPdfTip} aria-disabled={!hasPdf || undefined} className={clsx('pdf-wide', !hasPdf && 'is-disabled')} onClick={() => hasPdf && openPdf()} />
        <span className="pdf-narrow">
          <MoreMenu hasPdf={hasPdf} />
        </span>
      </div>
    </div>
  )
}
