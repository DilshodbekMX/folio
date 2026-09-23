/**
 * "Upload files" modal (SPEC §6.7): drag-and-drop zone + file picker (multiple) + folder picker
 * (webkitdirectory), target folder (changeable), per-file progress, existing files → list the
 * conflicts with "Replace" / "Skip existing", per-file errors with "Retry failed", uploads in
 * batches of ≤ 200 files. The upload starts as soon as files are chosen (like Overleaf) and the
 * modal closes itself when everything succeeded.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import clsx from 'clsx'
import { CircleAlert, CircleCheck, FolderUp, RotateCcw, Upload, X } from 'lucide-react'
import { basename, dirname } from '@folio/shared/paths'
import { formatBytes, pluralize } from '../../lib/format'
import { useProject } from '../../stores/project'
import { Button, IconButton, Modal, Select, toast } from '../../ui'
import { FileIcon } from './FileIcon'
import {
  MAX_FILES_PER_REQUEST, filesFromDrop, filesFromInput, isOsFileDrag, planUpload, runUpload,
  type PickedFile, type PlannedFile,
} from './upload'
import './filetree.css'

type RowStatus = 'queued' | 'conflict' | 'uploading' | 'done' | 'error' | 'skipped' | 'cancelled'

interface Row {
  key: number
  picked: PickedFile
  path: string
  exists: boolean
  status: RowStatus
  progress: number
  error: string | null
  /** replace the existing file (conflict resolved with "Replace") */
  replace: boolean
  /** the error comes from validation (invalid name, folder in the way): retrying cannot help */
  planError: boolean
}

type Phase = 'idle' | 'confirm' | 'uploading' | 'finished'

let rowSeq = 0

function toRow(p: PlannedFile): Row {
  return {
    key: ++rowSeq,
    picked: { file: p.file, relativePath: p.relativePath },
    path: p.path,
    exists: p.exists,
    status: p.error ? 'error' : p.exists ? 'conflict' : 'queued',
    progress: 0,
    error: p.error,
    replace: false,
    planError: !!p.error,
  }
}

export function UploadModal({ onClose, folder }: { onClose: () => void; folder?: string }) {
  const files = useProject(s => s.files)
  const canEdit = useProject(s => s.role === 'owner' || s.role === 'editor')
  const initialFolder = folder && files && Object.values(files).some(f => f.path === folder && f.kind === 'folder') ? folder : ''
  const [target, setTarget] = useState(initialFolder)
  const [rows, setRows] = useState<Row[]>([])
  const [phase, setPhase] = useState<Phase>('idle')
  const [dragOver, setDragOver] = useState(false)
  const [overall, setOverall] = useState(0)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const folderInput = useRef<HTMLInputElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const rowsRef = useRef<Row[]>(rows)
  rowsRef.current = rows
  const closeTimer = useRef<number | undefined>(undefined)

  const folders = useMemo(
    () => Object.values(files).filter(f => f.kind === 'folder').map(f => f.path).sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })),
    [files],
  )

  useEffect(() => {
    const el = folderInput.current
    if (el) el.webkitdirectory = true
  }, [])

  useEffect(() => () => {
    abortRef.current?.abort()
    window.clearTimeout(closeTimer.current)
  }, [])

  const busy = phase === 'uploading'
  const conflicts = rows.filter(r => r.status === 'conflict')

  // -- adding files ---------------------------------------------------------------------------

  const addFiles = (picked: PickedFile[]) => {
    if (busy || picked.length === 0) return
    // a new selection after a finished upload starts a fresh list
    const keep = phase === 'finished' ? [] : rowsRef.current.filter(r => r.status !== 'skipped' && r.status !== 'cancelled')
    const existingPaths = new Set(keep.map(r => r.picked.relativePath))
    const fresh = picked.filter(p => !existingPaths.has(p.relativePath))
    const planned = planUpload(target, [...keep.map(r => r.picked), ...fresh])
    const next = planned.map((p, i) => {
      const old = keep[i]
      if (old && old.status === 'done') return old
      return old ? { ...toRow(p), key: old.key } : toRow(p)
    })
    setRows(next)
    if (next.some(r => r.status === 'conflict')) setPhase('confirm')
    else void start(next)
  }

  const retarget = (folderPath: string) => {
    setTarget(folderPath)
    // only a pending conflict decision is re-planned; finished rows stay as they are
    if (phase !== 'confirm') return
    const pending = rowsRef.current.filter(r => r.status !== 'done')
    const planned = planUpload(folderPath, pending.map(r => r.picked))
    const next = planned.map((p, i) => ({ ...toRow(p), key: pending[i].key }))
    setRows(next)
    if (!next.some(r => r.status === 'conflict')) void start(next, folderPath)
  }

  // -- uploading ------------------------------------------------------------------------------

  const start = async (list: Row[], folderPath = target) => {
    const pid = useProject.getState().projectId
    if (!pid) return
    const indexes = list.map((r, i) => (r.status === 'queued' ? i : -1)).filter(i => i >= 0)
    if (indexes.length === 0) {
      setPhase('finished')
      return
    }
    const ctrl = new AbortController()
    abortRef.current = ctrl
    setPhase('uploading')
    setOverall(0)
    const replace = list.some(r => r.status === 'queued' && r.replace)
    const picked = list.map(r => r.picked)
    const keys = list.map(r => r.key)
    const update = (i: number, patch: Partial<Row>) => {
      const key = keys[i]
      setRows(prev => prev.map(r => (r.key === key ? { ...r, ...patch } : r)))
    }
    setRows(prev => prev.map(r => (indexes.some(i => keys[i] === r.key) ? { ...r, status: 'uploading', progress: 0 } : r)))
    const res = await runUpload(pid, folderPath, picked, {
      replace,
      indexes,
      signal: ctrl.signal,
      onProgress: (loaded, total) => setOverall(Math.min(1, loaded / total)),
      onFileProgress: (i, fraction) => update(i, { progress: fraction }),
      onFileDone: i => update(i, { status: 'done', progress: 1 }),
      onFileError: (i, message) => update(i, { status: 'error', error: message }),
    })
    abortRef.current = null
    if (res.aborted) {
      setRows(prev => prev.map(r => (r.status === 'uploading' || r.status === 'queued' ? { ...r, status: 'cancelled', progress: 0 } : r)))
      setPhase('finished')
      return
    }
    if (res.conflicts.length > 0) {
      // someone created these files meanwhile
      const conflictKeys = new Set(res.conflicts.map(i => keys[i]))
      setRows(prev => prev.map(r => (conflictKeys.has(r.key) ? { ...r, status: 'conflict', exists: true, progress: 0 } : r)))
      setPhase('confirm')
      return
    }
    const failed = res.failed.length
    const uploaded = res.uploaded.length
    const invalid = list.filter(r => r.status === 'error').length
    if (failed === 0 && invalid === 0 && uploaded > 0) {
      setPhase('finished')
      toast(`Uploaded ${pluralize(uploaded, 'file')} to ${folderPath ? `${folderPath}/` : 'the project root'}.`, { tone: 'success' })
      closeTimer.current = window.setTimeout(onClose, 500)
      return
    }
    setPhase('finished')
  }

  const resolveConflicts = (replace: boolean) => {
    const next = rowsRef.current.map(r => (r.status === 'conflict' ? { ...r, status: (replace ? 'queued' : 'skipped') as RowStatus, replace } : r))
    setRows(next)
    void start(next)
  }

  const retryFailed = () => {
    const next = rowsRef.current.map(r => ((r.status === 'error' && !r.planError) || r.status === 'cancelled' ? { ...r, status: 'queued' as RowStatus, error: null, progress: 0 } : r))
    setRows(next)
    void start(next)
  }

  const removeRow = (key: number) => {
    const next = rowsRef.current.filter(x => x.key !== key)
    setRows(next)
    if (!next.some(x => x.status === 'conflict')) void start(next)
  }

  const cancel = () => {
    if (busy) {
      abortRef.current?.abort()
      return
    }
    onClose()
  }

  // -- drag and drop --------------------------------------------------------------------------

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!isOsFileDrag(e.dataTransfer) || busy) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    setDragOver(true)
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    if (!isOsFileDrag(e.dataTransfer)) return
    e.preventDefault()
    setDragOver(false)
    if (busy) return
    void filesFromDrop(e.dataTransfer).then(addFiles)
  }

  // -- render ---------------------------------------------------------------------------------

  const counts = {
    done: rows.filter(r => r.status === 'done').length,
    error: rows.filter(r => r.status === 'error').length,
    total: rows.length,
    bytes: rows.reduce((s, r) => s + r.picked.file.size, 0),
  }
  const retryable = rows.some(r => (r.status === 'error' && !r.planError) || r.status === 'cancelled')

  const footer = (
    <>
      <div className="ft-upload__summary" aria-live="polite">
        {busy && `Uploading ${counts.done} of ${pluralize(counts.total, 'file')} · ${Math.round(overall * 100)}%`}
        {phase === 'finished' && counts.total > 0 && `${counts.done} of ${pluralize(counts.total, 'file')} uploaded${counts.error ? ` · ${counts.error} failed` : ''}`}
        {phase === 'idle' && counts.total === 0 && `Up to ${MAX_FILES_PER_REQUEST} files are sent per batch; larger selections are split automatically.`}
      </div>
      {phase === 'finished' && retryable && (
        <Button variant="secondary" icon={RotateCcw} onClick={retryFailed}>
          Retry failed
        </Button>
      )}
      <Button variant={busy ? 'secondary' : 'ghost'} onClick={cancel}>
        {busy ? 'Cancel upload' : phase === 'finished' ? 'Close' : 'Cancel'}
      </Button>
    </>
  )

  return (
    <Modal
      open
      onClose={() => {
        // × / Esc: stop a running upload and close
        abortRef.current?.abort()
        onClose()
      }}
      title="Upload files"
      size="lg"
      footer={footer}
      closeOnBackdrop={!busy}
      bodyClassName="ft-upload"
    >
      <div className="ft-upload__target">
        <label htmlFor="ft-upload-target">Upload to</label>
        <Select
          id="ft-upload-target"
          size="sm"
          value={target}
          disabled={busy}
          onChange={e => retarget(e.target.value)}
          options={[{ value: '', label: 'Project root' }, ...folders.map(f => ({ value: f, label: `${f}/` }))]}
        />
      </div>

      {!canEdit ? (
        <p className="ft-upload__error" role="alert">You have view access to this project, so you can’t upload files.</p>
      ) : (
        <div
          className={clsx('ft-drop', dragOver && 'is-over', rows.length > 0 && 'is-compact', busy && 'is-disabled')}
          onDragOver={onDragOver}
          onDragEnter={onDragOver}
          onDragLeave={e => {
            if (!(e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget))) setDragOver(false)
          }}
          onDrop={onDrop}
        >
          <span className="ft-drop__icon" aria-hidden="true">
            <Upload size={rows.length > 0 ? 16 : 22} />
          </span>
          <div className="ft-drop__text">
            <p className="ft-drop__title">{rows.length > 0 ? 'Drop more files or folders here' : 'Drag files or folders here'}</p>
            {rows.length === 0 && <p className="ft-drop__or">or choose them from your computer</p>}
          </div>
          <div className="ft-drop__buttons">
            <Button size={rows.length > 0 ? 'sm' : 'md'} variant="secondary" icon={Upload} disabled={busy} onClick={() => fileInput.current?.click()} data-autofocus>
              Select files…
            </Button>
            <Button size={rows.length > 0 ? 'sm' : 'md'} variant="secondary" icon={FolderUp} disabled={busy} onClick={() => folderInput.current?.click()}>
              Select a folder…
            </Button>
          </div>
          <input
            ref={fileInput}
            type="file"
            multiple
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="ft-upload-files"
            onChange={e => {
              const picked = filesFromInput(e.target.files)
              e.target.value = ''
              addFiles(picked)
            }}
          />
          <input
            ref={folderInput}
            type="file"
            multiple
            className="visually-hidden"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="ft-upload-folder"
            onChange={e => {
              const picked = filesFromInput(e.target.files)
              e.target.value = ''
              addFiles(picked)
            }}
          />
        </div>
      )}

      {phase === 'confirm' && conflicts.length > 0 && (
        <div className="ft-upload__conflict" role="alert">
          <CircleAlert size={16} aria-hidden="true" className="ft-upload__conflict-icon" />
          <div className="ft-upload__conflict-text">
            <strong>{conflicts.length === 1 ? 'A file with this name already exists.' : `${conflicts.length} files already exist in this project.`}</strong>
            <span>Do you want to replace {conflicts.length === 1 ? 'it' : 'them'}? The current content is overwritten for everyone; earlier versions stay in the history.</span>
            <ul className="ft-upload__conflict-list">
              {conflicts.slice(0, 6).map(r => (
                <li key={r.key}><code>{r.path}</code></li>
              ))}
              {conflicts.length > 6 && <li>and {conflicts.length - 6} more</li>}
            </ul>
          </div>
          <div className="ft-upload__conflict-actions">
            <Button size="sm" variant="primary" onClick={() => resolveConflicts(true)}>
              Replace
            </Button>
            <Button size="sm" variant="ghost" onClick={() => resolveConflicts(false)}>
              {conflicts.length === rows.length ? 'Don’t upload' : 'Skip existing'}
            </Button>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <>
          <div className="ft-upload__listhead">
            <span>{pluralize(rows.length, 'file')} · {formatBytes(counts.bytes)}</span>
            {busy && (
              <span className="ft-upload__overall" aria-hidden="true">
                <span style={{ width: `${Math.round(overall * 100)}%` }} />
              </span>
            )}
          </div>
          <ul className="ft-upload__list" aria-label="Files to upload">
            {rows.map(r => (
              <UploadRow
                key={r.key}
                row={r}
                onRemove={phase === 'confirm' ? () => removeRow(r.key) : undefined}
              />
            ))}
          </ul>
        </>
      )}
    </Modal>
  )
}

function UploadRow({ row, onRemove }: { row: Row; onRemove?: () => void }) {
  const dir = dirname(row.path)
  const pct = Math.round(row.progress * 100)
  let status
  switch (row.status) {
    case 'uploading':
      status = (
        <span className="ft-urow__progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={`Uploading ${basename(row.path)}`}>
          <span className="ft-urow__bar"><span style={{ width: `${pct}%` }} /></span>
          <span className="ft-urow__pct">{pct}%</span>
        </span>
      )
      break
    case 'done':
      status = (
        <span className="ft-urow__ok">
          <CircleCheck size={14} aria-hidden="true" /> Uploaded
        </span>
      )
      break
    case 'error':
      status = (
        <span className="ft-urow__err" title={row.error ?? undefined}>
          <CircleAlert size={14} aria-hidden="true" /> {row.error ?? 'Failed'}
        </span>
      )
      break
    case 'conflict':
      status = <span className="ft-urow__warn">Already exists</span>
      break
    case 'skipped':
      status = <span className="ft-urow__muted">Skipped</span>
      break
    case 'cancelled':
      status = <span className="ft-urow__muted">Cancelled</span>
      break
    default:
      status = <span className="ft-urow__muted">{row.replace ? 'Will replace' : 'Waiting'}</span>
  }
  return (
    <li className={clsx('ft-urow', `is-${row.status}`)}>
      <FileIcon path={row.path || row.picked.relativePath} kind="binary" />
      <span className="ft-urow__name" title={row.path || row.picked.relativePath}>
        {dir && <span className="ft-urow__dir">{dir}/</span>}
        {basename(row.path || row.picked.relativePath)}
      </span>
      <span className="ft-urow__size">{formatBytes(row.picked.file.size)}</span>
      <span className="ft-urow__status">{status}</span>
      {onRemove && row.status !== 'done' ? (
        <IconButton size="sm" icon={X} label={`Remove ${basename(row.picked.relativePath)}`} onClick={onRemove} className="ft-urow__remove" />
      ) : (
        <span className="ft-urow__remove" aria-hidden="true" />
      )}
    </li>
  )
}
