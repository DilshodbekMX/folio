import { useEffect, useRef, useState, type DragEvent } from 'react'
import clsx from 'clsx'
import { FileArchive, TriangleAlert, Upload } from 'lucide-react'
import type { SkippedImportEntry } from '@folio/shared/api'
import { api } from '../../api/endpoints'
import { errorMessage, isAbortError } from '../../api/client'
import { formatBytes, pluralize } from '../../lib/format'
import { Button, Modal, toast } from '../../ui'

type Phase =
  | { kind: 'idle'; error?: string }
  | { kind: 'uploading'; file: File; fraction: number }
  | { kind: 'processing'; file: File }
  /** imported, but entries that may matter were skipped: show them before opening */
  | { kind: 'done'; projectId: string; skipped: SkippedImportEntry[] }

/** Entries every import leaves out on purpose (build output, OS/VCS clutter): no need to worry. */
function isRoutineSkip(e: SkippedImportEntry): boolean {
  return /^(build artefact|build output|ignored name)/i.test(e.reason)
}

/** Skipped entries grouped by reason, the ones that may matter first. */
function groupSkipped(skipped: readonly SkippedImportEntry[]): { reason: string; routine: boolean; paths: string[] }[] {
  const groups = new Map<string, { reason: string; routine: boolean; paths: string[] }>()
  for (const e of skipped) {
    // "build artefact (.aux)" and "build artefact (.log)" → one group per kind of reason
    const key = isRoutineSkip(e) ? e.reason.replace(/\s*\(.*\)$/, '').replace(/ ".*"$/, '') : e.reason.replace(/ ".*"$/, '')
    const g = groups.get(key) ?? { reason: key, routine: isRoutineSkip(e), paths: [] }
    g.paths.push(e.path)
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => Number(a.routine) - Number(b.routine))
}

const MAX_LISTED = 12

function isZip(file: File): boolean {
  return /\.zip$/i.test(file.name) || file.type === 'application/zip' || file.type === 'application/x-zip-compressed'
}

/** 'main.aux, main.log and 3 more' */
function summarize(skipped: readonly SkippedImportEntry[]): string {
  const names = skipped.slice(0, 2).map(e => e.path.split('/').pop() || e.path)
  return skipped.length > 2 ? `${names.join(', ')} and ${skipped.length - 2} more` : names.join(' and ')
}

/** Project name from the zip file name: 'My Paper (1).zip' → 'My Paper (1)'. */
function nameFromFile(file: File): string {
  const base = file.name.replace(/\.zip$/i, '').trim()
  return base.slice(0, 150) || 'Uploaded project'
}

/**
 * "Upload a project" — pick or drop a .zip; the upload starts immediately and the new
 * project opens when the server has imported it. Entries the server skipped
 * (CreateProjectResponse.skipped) are reported: routine ones (build output, __MACOSX…) in a
 * toast; anything else (hidden files, invalid or duplicate names, links…) in the dialog, before
 * the project opens.
 */
export function UploadProjectModal({ open, onClose, onUploaded }: { open: boolean; onClose: () => void; onUploaded: (projectId: string) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const busy = phase.kind !== 'idle'

  useEffect(() => {
    if (!open) {
      abortRef.current?.abort()
      abortRef.current = null
      setPhase({ kind: 'idle' })
      setDragOver(false)
    }
  }, [open])

  useEffect(() => () => abortRef.current?.abort(), [])

  const start = async (file: File) => {
    if (!isZip(file)) {
      setPhase({ kind: 'idle', error: `“${file.name}” is not a .zip file. Compress your project folder into a .zip archive first.` })
      return
    }
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setPhase({ kind: 'uploading', file, fraction: 0 })
    try {
      const res = await api.uploadProject(file, nameFromFile(file), fraction => {
        if (ctrl.signal.aborted) return
        setPhase(fraction >= 1 ? { kind: 'processing', file } : { kind: 'uploading', file, fraction })
      }, { signal: ctrl.signal })
      if (ctrl.signal.aborted) return
      abortRef.current = null
      const skipped = res.skipped ?? []
      if (skipped.some(e => !isRoutineSkip(e))) {
        setPhase({ kind: 'done', projectId: res.id, skipped })
        return
      }
      if (skipped.length > 0) {
        toast(`Imported. ${pluralize(skipped.length, 'build or system file')} from the .zip ${skipped.length === 1 ? 'was' : 'were'} left out (${summarize(skipped)}).`, { tone: 'info', duration: 7000 })
      }
      onUploaded(res.id)
    } catch (e) {
      if (isAbortError(e)) return
      abortRef.current = null
      setPhase({ kind: 'idle', error: errorMessage(e, 'The upload failed.') })
    }
  }

  const cancel = () => {
    abortRef.current?.abort()
    abortRef.current = null
    if (phase.kind === 'idle' || phase.kind === 'done') onClose()
    else setPhase({ kind: 'idle' })
  }

  if (phase.kind === 'done') {
    const groups = groupSkipped(phase.skipped)
    const projectId = phase.projectId
    return (
      <Modal
        open={open}
        onClose={cancel}
        title="Project imported — some files were left out"
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={cancel}>
              Close
            </Button>
            <Button variant="primary" onClick={() => onUploaded(projectId)} data-autofocus>
              Open project
            </Button>
          </>
        }
      >
        <div className="dash-skipped">
          <p className="dash-skipped__lead">
            <TriangleAlert size={16} aria-hidden="true" />
            <span>
              {pluralize(phase.skipped.length, 'item')} from the .zip {phase.skipped.length === 1 ? 'was' : 'were'} not imported. Check
              that nothing your document needs is missing; you can upload such files into the project later.
            </span>
          </p>
          {groups.map(g => (
            <section key={g.reason} className={clsx('dash-skipped__group', g.routine && 'is-routine')}>
              <h3 className="dash-skipped__reason">
                {g.reason} <span className="dash-skipped__count">({g.paths.length})</span>
              </h3>
              <ul className="dash-skipped__list">
                {g.paths.slice(0, MAX_LISTED).map(path => (
                  <li key={path}>
                    <code>{path}</code>
                  </li>
                ))}
                {g.paths.length > MAX_LISTED && <li className="dash-skipped__more">and {g.paths.length - MAX_LISTED} more</li>}
              </ul>
            </section>
          ))}
        </div>
      </Modal>
    )
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    if (busy) return
    const file = e.dataTransfer.files[0]
    if (file) void start(file)
  }

  const pct = phase.kind === 'uploading' ? Math.round(phase.fraction * 100) : 100

  return (
    <Modal
      open={open}
      onClose={cancel}
      title="Upload a project"
      description="Import an existing LaTeX project from a .zip archive."
      size="md"
      footer={
        <Button variant="ghost" onClick={cancel}>
          {busy ? 'Cancel upload' : 'Cancel'}
        </Button>
      }
    >
      {phase.kind === 'idle' ? (
        <>
          <div
            className={clsx('dash-drop', dragOver && 'is-over')}
            onDragOver={e => {
              e.preventDefault()
              e.dataTransfer.dropEffect = 'copy'
              setDragOver(true)
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
          >
            <span className="dash-drop__icon" aria-hidden="true">
              <Upload size={22} />
            </span>
            <p className="dash-drop__title">Drag a .zip file here</p>
            <p className="dash-drop__or">or</p>
            <Button variant="secondary" onClick={() => inputRef.current?.click()} data-autofocus>
              Choose a file…
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept=".zip,application/zip,application/x-zip-compressed"
              className="visually-hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={e => {
                const f = e.target.files?.[0]
                e.target.value = ''
                if (f) void start(f)
              }}
            />
          </div>
          {phase.error && (
            <p className="dash-upload-error" role="alert">
              {phase.error}
            </p>
          )}
          <p className="dash-upload-hint">
            A single top-level folder is unwrapped automatically. Build output (.aux, .log, .synctex.gz…) is skipped, and the main document is
            detected from <code>\documentclass</code>.
          </p>
        </>
      ) : (
        <div className="dash-progress" aria-live="polite">
          <div className="dash-progress__file">
            <FileArchive size={18} aria-hidden="true" />
            <span className="dash-progress__name">{phase.file.name}</span>
            <span className="dash-progress__size">{formatBytes(phase.file.size)}</span>
          </div>
          <div
            className={clsx('dash-progress__bar', phase.kind === 'processing' && 'is-indeterminate')}
            role="progressbar"
            aria-label="Upload progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={phase.kind === 'uploading' ? pct : undefined}
          >
            <span style={{ width: `${pct}%` }} />
          </div>
          <p className="dash-progress__status">
            {phase.kind === 'uploading' ? `Uploading… ${pct}%` : 'Importing files…'}
          </p>
        </div>
      )}
    </Modal>
  )
}
