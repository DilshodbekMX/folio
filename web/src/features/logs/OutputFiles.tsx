/**
 * "Other logs and files": every output of the latest build except the main PDF (.bbl first, as
 * journals ask for it) and latexmk bookkeeping (.fls, .fdb_latexmk), xr external documents'
 * PDFs and logs, "Download all" (one .zip of the build's outputs, main PDF included, packed in
 * the browser) and "Clear cached files".
 */
import { useState } from 'react'
import clsx from 'clsx'
import { ChevronRight, Download, Eraser, Eye, FileArchive, FileCode, FileText, FolderDown, Link2 } from 'lucide-react'
import type { CompileResponse, CompileStatus, OutputFile } from '@folio/shared/api'
import { errorMessage, getArrayBuffer } from '../../api/client'
import { downloadBlob, safeFilename } from '../../lib/download'
import { formatBytes } from '../../lib/format'
import { useCompile } from '../../stores/compile'
import { useProject } from '../../stores/project'
import { Button, Tooltip, confirmDialog, toast } from '../../ui'
import { downloadableOutputFiles, otherOutputFiles } from './logUtils'
import { zipStore } from './zip'

const TYPE_HINT: Record<string, string> = {
  bbl: 'Bibliography for journal submissions',
  aux: 'Auxiliary data (labels, citations)',
  log: 'LaTeX log',
  blg: 'BibTeX / Biber log',
  out: 'hyperref bookmarks',
  toc: 'Table of contents',
  'synctex.gz': 'SyncTeX data',
  pdf: 'PDF',
}

function iconFor(f: OutputFile) {
  if (f.type === 'log' || f.type === 'blg') return FileText
  if (f.type === 'pdf') return FileText
  if (f.type === 'synctex.gz' || f.type === 'gz') return FileArchive
  return FileCode
}

const EXTERNAL_STATUS: Partial<Record<CompileStatus, string>> = {
  success: 'built',
  failure: 'failed',
  'stopped-on-first-error': 'failed',
  timedout: 'timed out',
  terminated: 'stopped',
  error: 'error',
}

/** Fetch every output of `build` and save them as "<project> - output files.zip". */
async function downloadAll(build: CompileResponse): Promise<void> {
  const files = downloadableOutputFiles(build)
  const entries = await Promise.all(
    files.map(async f => ({ name: f.path, data: new Uint8Array(await getArrayBuffer(f.url)), date: new Date(build.compiledAt) })),
  )
  const project = safeFilename(useProject.getState().name, 'project')
  downloadBlob(zipStore(entries), `${project} - output files.zip`)
}

export function OutputFiles({ build, onView }: { build: CompileResponse | null; onView: (url: string) => void }) {
  const files = otherOutputFiles(build)
  const canEdit = useProject(s => s.role === 'owner' || s.role === 'editor')
  const compiling = useCompile(s => s.status === 'compiling')
  const [open, setOpen] = useState(true)
  const [clearing, setClearing] = useState(false)
  const [zipping, setZipping] = useState(false)
  const external = build?.externalBuilds ?? []

  const onDownloadAll = async () => {
    if (!build) return
    setZipping(true)
    try {
      await downloadAll(build)
    } catch (e) {
      toast(`Couldn’t download the output files: ${errorMessage(e)}`, { tone: 'error' })
    } finally {
      setZipping(false)
    }
  }

  const clearCache = async () => {
    const ok = await confirmDialog({
      title: 'Clear cached files?',
      message:
        'This deletes the compile directory with its auxiliary files (.aux, .bbl, .toc, …) and the saved PDFs and logs. Your project files are not touched. The next compile starts from scratch and takes longer.',
      confirmLabel: 'Clear cached files',
      danger: true,
    })
    if (!ok) return
    setClearing(true)
    try {
      await useCompile.getState().clearCache()
      toast('Cached files cleared. The next compile starts from scratch.', { tone: 'success' })
    } catch (e) {
      toast(`Couldn’t clear the cached files: ${errorMessage(e)}`, { tone: 'error' })
    } finally {
      setClearing(false)
    }
  }

  return (
    <section className="logs-files" aria-label="Other logs and files">
      <button type="button" className="logs-files__head" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <ChevronRight className={clsx('logs-files__chevron', open && 'is-open')} size={14} aria-hidden="true" />
        <span className="logs-files__title">Other logs and files</span>
        <span className="logs-files__n">{files.length}</span>
      </button>
      {open && (
        <div className="logs-files__body">
          {external.length > 0 && (
            <p className="logs-files__ext">
              <Link2 size={14} aria-hidden="true" />
              <span>
                Pre-built for cross-references:{' '}
                {external.map((x, i) => (
                  <span key={x.path}>
                    {i > 0 && ', '}
                    <code>{x.path}</code> <span className={clsx('logs-files__extstatus', x.status === 'success' ? 'is-ok' : 'is-bad')}>{EXTERNAL_STATUS[x.status] ?? x.status}</span>
                  </span>
                ))}
              </span>
            </p>
          )}
          {files.length === 0 ? (
            <p className="logs-files__empty">{build ? 'This build produced no other files.' : 'Compile the project to see its output files.'}</p>
          ) : (
            <ul className="logs-files__list">
              {files.map(f => {
                const Icon = iconFor(f)
                const viewable = f.type === 'log' || f.type === 'blg'
                return (
                  <li key={f.url} className="logs-file">
                    <Icon className="logs-file__icon" size={16} aria-hidden="true" />
                    <span className="logs-file__name" title={f.path}>
                      {f.path}
                      {f.url === build?.logUrl && <span className="logs-file__tag">main log</span>}
                    </span>
                    <span className="logs-file__desc">{TYPE_HINT[f.type] ?? f.type.toUpperCase()}</span>
                    <span className="logs-file__size">{formatBytes(f.size)}</span>
                    <span className="logs-file__actions">
                      {viewable && (
                        <Tooltip content="View in raw logs">
                          <button type="button" className="logs-file__btn" aria-label={`View ${f.path}`} onClick={() => onView(f.url)}>
                            <Eye size={14} aria-hidden="true" />
                          </button>
                        </Tooltip>
                      )}
                      <Tooltip content={`Download ${f.path}`}>
                        <a className="logs-file__btn" href={f.url} download={f.path} aria-label={`Download ${f.path}`}>
                          <Download size={14} aria-hidden="true" />
                        </a>
                      </Tooltip>
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
          {build && downloadableOutputFiles(build).length > 0 && (
            <div className="logs-files__all">
              <Button size="sm" variant="secondary" icon={FolderDown} loading={zipping} onClick={() => void onDownloadAll()}>
                Download all
              </Button>
              <span className="logs-files__foothint">Every output file of this compile, the PDF included, as one .zip.</span>
            </div>
          )}
        </div>
      )}
      {canEdit && (
        <div className="logs-files__foot">
          <Button variant="danger" size="sm" icon={Eraser} loading={clearing} disabled={compiling} onClick={() => void clearCache()}>
            Clear cached files
          </Button>
          <span className="logs-files__foothint">Use it when stale auxiliary files cause strange errors.</span>
        </div>
      )}
    </section>
  )
}
