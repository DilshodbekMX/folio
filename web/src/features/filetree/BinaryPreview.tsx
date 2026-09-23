/**
 * Viewer for non-editable files (SPEC §6.7): images (<img>), PDF (first page and page
 * navigation with pdf.js), EPS/PS (server-rendered PNG), text files that cannot be edited (too
 * large / not UTF-8: read-only excerpt), anything else "No preview available". The header shows
 * name, type, size (and pixel/page size), Download and — for editors — Replace… (upload with
 * replace=true into the same path). `showPath={false}` leaves out the name where the path is
 * already shown right above (the editor's breadcrumb).
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import { Download, FileQuestion, FileUp } from 'lucide-react'
import type { FileEntry } from '@folio/shared/api'
import { classifyByName, isBrowserImage } from '@folio/shared/filetypes'
import { basename, dirname, extname } from '@folio/shared/paths'
import { api } from '../../api/endpoints'
import { errorMessage } from '../../api/client'
import { downloadUrl } from '../../lib/download'
import { formatBytes } from '../../lib/format'
import { formatRelative } from '../../lib/time'
import { useProject } from '../../stores/project'
import { Button, EmptyState, toast } from '../../ui'
import { FileIcon, fileTypeLabel } from './FileIcon'
import { ImagePreview, PdfPagePreview, TextExcerpt } from './previews'
import { replaceFile } from './upload'
import './filetree.css'

type PreviewKind = 'image' | 'pdf' | 'eps' | 'text' | 'none'

function previewKind(file: FileEntry): PreviewKind {
  const ext = extname(file.path)
  if (isBrowserImage(file.path)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'eps' || ext === 'ps') return 'eps'
  if (classifyByName(file.path) === 'text' || file.kind === 'text') return 'text'
  return 'none'
}

export function BinaryPreview({ file, showPath = true }: { file: FileEntry; showPath?: boolean }) {
  const pid = useProject(s => s.projectId)
  const canEdit = useProject(s => s.role === 'owner' || s.role === 'editor')
  const [detail, setDetail] = useState<string | null>(null)
  const [replacing, setReplacing] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const kind = previewKind(file)
  const name = basename(file.path)
  const version = `${file.updatedAt}-${file.size}`

  useEffect(() => setDetail(null), [file.id, version])

  if (!pid) return null
  const rawUrl = api.rawFileUrl(pid, file.id, { v: version })

  const download = () => downloadUrl(api.rawFileUrl(pid, file.id, { download: true }), name)

  const onReplace = async (picked: File | undefined) => {
    if (!picked) return
    setReplacing(0)
    try {
      await replaceFile(pid, file, picked, f => setReplacing(Math.round(f * 100)))
      toast(<>Replaced “{name}” with “{picked.name}”.</>, { tone: 'success' })
    } catch (e) {
      toast(`Couldn’t replace “${name}”: ${errorMessage(e)}`, { tone: 'error' })
    } finally {
      setReplacing(null)
    }
  }

  const meta = [fileTypeLabel(file.path, file.kind), formatBytes(file.size), detail, file.updatedAt > 0 ? `updated ${formatRelative(file.updatedAt)}` : null]
    .filter((x): x is string => !!x)

  let body
  switch (kind) {
    case 'image':
      body = <ImagePreview key={rawUrl} src={rawUrl} alt={name} onSize={(w, h) => setDetail(`${w} × ${h} px`)} />
      break
    case 'pdf':
      body = (
        <PdfPagePreview
          key={rawUrl}
          url={rawUrl}
          onInfo={info => setDetail(`${info.pages} ${info.pages === 1 ? 'page' : 'pages'}`)}
        />
      )
      break
    case 'eps':
      body = (
        <div className="ft-preview__eps">
          <ImagePreview key={version} src={api.previewFileUrl(pid, file.id, { v: version })} alt={`${name} (rendered preview)`} />
          <p className="ft-preview__caption">Preview rendered with Ghostscript — the PDF uses the original file.</p>
        </div>
      )
      break
    case 'text':
      body = (
        <div className="ft-preview__text">
          <p className="ft-preview__note">
            This file can’t be edited in Folio because it is larger than 2 MB or not UTF-8 text. It is shown read-only.
          </p>
          <TextExcerpt key={rawUrl} url={rawUrl} />
        </div>
      )
      break
    default:
      body = (
        <EmptyState
          icon={FileQuestion}
          title="No preview available"
          className="ft-preview__none"
          actions={<Button variant="secondary" icon={Download} onClick={download}>Download</Button>}
        >
          Folio can’t show {extname(file.path) ? <><code>.{extname(file.path)}</code> files</> : 'this type of file'} in the browser. Download it to open it on your computer.
        </EmptyState>
      )
  }

  return (
    <div className="ft-preview" data-kind={kind}>
      <header className={clsx('ft-preview__bar', !showPath && 'ft-preview__bar--compact')}>
        {showPath && <FileIcon path={file.path} kind={file.kind} size={18} className="ft-preview__icon" />}
        <div className="ft-preview__titles">
          {showPath && (
            <div className="ft-preview__name" title={file.path}>
              {dirname(file.path) && <span className="ft-preview__dir">{dirname(file.path)}/</span>}
              {name}
            </div>
          )}
          <div className="ft-preview__meta">
            {meta.map(m => (
              <span key={m} className="ft-preview__metaitem">{m}</span>
            ))}
          </div>
        </div>
        <div className="ft-preview__actions">
          {canEdit && (
            <>
              <Button
                size="sm"
                variant="ghost"
                icon={FileUp}
                loading={replacing !== null}
                onClick={() => inputRef.current?.click()}
                title="Upload a file from your computer to replace this one (same name and folder)"
              >
                {replacing !== null ? `Replacing… ${replacing}%` : 'Replace…'}
              </Button>
              <input
                ref={inputRef}
                type="file"
                className="visually-hidden"
                tabIndex={-1}
                aria-hidden="true"
                accept={extname(file.path) ? `.${extname(file.path)}` : undefined}
                onChange={e => {
                  const f = e.target.files?.[0]
                  e.target.value = ''
                  void onReplace(f)
                }}
              />
            </>
          )}
          <Button size="sm" variant="secondary" icon={Download} onClick={download}>
            Download
          </Button>
        </div>
      </header>
      {replacing !== null && (
        <div className="ft-preview__progress" role="progressbar" aria-valuenow={replacing} aria-valuemin={0} aria-valuemax={100} aria-label="Replacing file">
          <span style={{ width: `${replacing}%` }} />
        </div>
      )}
      <div className="ft-preview__body">{body}</div>
    </div>
  )
}
