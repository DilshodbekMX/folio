/** Before/after previews of a binary file between two versions (images and PDFs; others: sizes only). */
import clsx from 'clsx'
import { FileQuestion } from 'lucide-react'
import { isBrowserImage } from '@folio/shared/filetypes'
import { extname } from '@folio/shared/paths'
import { api } from '../../api/endpoints'
import { ImagePreview, PdfPagePreview } from '../filetree/previews'

export interface BinarySide {
  versionId: string
  path: string
}

/** One file as stored in a version (image, PDF page, or a "no preview" note). */
export function VersionFilePreview({ pid, side }: { pid: string; side: BinarySide }) {
  const url = api.historyFileUrl(pid, side.versionId, side.path)
  if (isBrowserImage(side.path)) return <ImagePreview key={url} src={url} alt={side.path} allowZoom={false} />
  if (extname(side.path) === 'pdf') return <PdfPagePreview key={url} url={url} navigation={false} />
  return (
    <div className="hist-bin__none">
      <FileQuestion size={22} aria-hidden="true" />
      <span>No preview for this file type</span>
    </div>
  )
}

export function BinaryDiff({ pid, before, after }: { pid: string; before: BinarySide | null; after: BinarySide | null }) {
  return (
    <div className={clsx('hist-bin', (!before || !after) && 'is-single')}>
      <figure className={clsx('hist-bin__side', 'hist-bin__side--before')}>
        <figcaption className="hist-bin__cap">
          <span className="hist-bin__tag hist-bin__tag--before">Before</span>
          {!before && <span className="hist-bin__absent">The file did not exist</span>}
        </figcaption>
        {before ? <VersionFilePreview pid={pid} side={before} /> : <div className="hist-bin__empty" />}
      </figure>
      <figure className={clsx('hist-bin__side', 'hist-bin__side--after')}>
        <figcaption className="hist-bin__cap">
          <span className="hist-bin__tag hist-bin__tag--after">After</span>
          {!after && <span className="hist-bin__absent">The file was deleted</span>}
        </figcaption>
        {after ? <VersionFilePreview pid={pid} side={after} /> : <div className="hist-bin__empty" />}
      </figure>
    </div>
  )
}
