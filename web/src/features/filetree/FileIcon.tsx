/** File-type icons for the tree, the upload list and the history file lists. */
import clsx from 'clsx'
import {
  BookMarked, File, FileArchive, FileCode, FileImage, FileSpreadsheet, FileTerminal, FileText, FileType, Folder,
  FolderOpen, type LucideIcon,
} from 'lucide-react'
import type { FileKind } from '@folio/shared/api'
import { basename, extname } from '@folio/shared/paths'
import './filetree.css'

export type FileIconType =
  | 'folder' | 'tex' | 'bib' | 'image' | 'pdf' | 'eps' | 'code' | 'doc' | 'data' | 'archive' | 'font' | 'script' | 'generic'

const TEX = new Set(['tex', 'latex', 'ltx', 'rtex', 'rnw', 'tikz', 'pgf'])
const BIB = new Set(['bib', 'bibtex'])
const IMAGE = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'svg', 'ico'])
const EPS = new Set(['eps', 'ps'])
const CODE = new Set(['sty', 'cls', 'bst', 'bbx', 'cbx', 'lbx', 'dbx', 'def', 'clo', 'ldf', 'fd', 'cfg', 'dtx', 'ins', 'ist', 'mf', 'asy', 'lua', 'py', 'r', 'js', 'ts', 'css', 'html', 'xml', 'json', 'toml', 'ini', 'yml', 'yaml', 'gv', 'dot', 'hs', 'lhs', 'm'])
const DOC = new Set(['txt', 'md', 'markdown', 'rmd', 'qmd'])
const DATA = new Set(['csv', 'tsv', 'dat', 'xlsx', 'xls', 'ods'])
const ARCHIVE = new Set(['zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'tar'])
const FONT = new Set(['otf', 'ttf', 'woff', 'woff2', 'pfb', 'afm', 'tfm', 'vf'])
const SCRIPT = new Set(['sh', 'mk', 'makefile', 'latexmkrc'])

export function fileIconType(path: string, kind: FileKind = 'text'): FileIconType {
  if (kind === 'folder') return 'folder'
  const ext = extname(path)
  const name = basename(path).toLowerCase()
  if (TEX.has(ext)) return 'tex'
  if (BIB.has(ext)) return 'bib'
  if (IMAGE.has(ext)) return 'image'
  if (ext === 'pdf') return 'pdf'
  if (EPS.has(ext)) return 'eps'
  if (CODE.has(ext)) return 'code'
  if (DOC.has(ext) || name === 'readme') return 'doc'
  if (DATA.has(ext)) return 'data'
  if (ARCHIVE.has(ext)) return 'archive'
  if (FONT.has(ext)) return 'font'
  if (SCRIPT.has(ext) || name === 'makefile' || name === 'latexmkrc' || name === '.latexmkrc') return 'script'
  return 'generic'
}

const ICONS: Record<Exclude<FileIconType, 'folder'>, LucideIcon> = {
  tex: FileText,
  bib: BookMarked,
  image: FileImage,
  pdf: FileType,
  eps: FileImage,
  code: FileCode,
  doc: FileText,
  data: FileSpreadsheet,
  archive: FileArchive,
  font: FileType,
  script: FileTerminal,
  generic: File,
}

/** Human-readable type label ('PNG image', 'PDF document', 'LaTeX source' …). */
export function fileTypeLabel(path: string, kind: FileKind = 'binary'): string {
  if (kind === 'folder') return 'Folder'
  const ext = extname(path)
  const up = ext.toUpperCase()
  switch (fileIconType(path, kind)) {
    case 'tex': return ext === 'tikz' || ext === 'pgf' ? 'TikZ/PGF source' : 'LaTeX source'
    case 'bib': return 'BibTeX bibliography'
    case 'image': return `${up} image`
    case 'pdf': return 'PDF document'
    case 'eps': return ext === 'ps' ? 'PostScript document' : 'Encapsulated PostScript'
    case 'archive': return `${up} archive`
    case 'font': return `${up} font`
    case 'data': return `${up} data`
    default: return up ? `${up} file` : 'File'
  }
}

export function FileIcon({ path, kind, open, size = 16, className }: { path: string; kind: FileKind; open?: boolean; size?: number; className?: string }) {
  const type = fileIconType(path, kind)
  const Icon = type === 'folder' ? (open ? FolderOpen : Folder) : ICONS[type]
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" className={clsx('ft-icon', `ft-icon--${type}`, className)} />
}
