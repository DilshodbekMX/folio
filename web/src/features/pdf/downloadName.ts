/**
 * File name for a downloaded PDF (PDF toolbar, File → Download → PDF, dashboard).
 *
 * The main document's PDF is saved as "<project name>.pdf". A project can have more than one root
 * document (the paper plus a supplement with its own \documentclass, standalone figures); the
 * PDF of any other root is saved as "<project name> - <jobname>.pdf", so the supplement is never
 * saved under the paper's name.
 */
import type { CompileResponse } from '@folio/shared/api'
import { basename } from '@folio/shared/paths'
import { safeFilename } from '../../lib/download'

type Build = Pick<CompileResponse, 'rootPath' | 'jobname'>

/** True when `build` is of a root document other than the main document `mainPath`. */
export function isOtherRoot(build: Build | null | undefined, mainPath: string | null | undefined): boolean {
  return !!build?.rootPath && !!mainPath && build.rootPath !== mainPath
}

/** Job name of a build: the root file's basename without .tex. */
export function buildJobname(build: Build): string {
  if (build.jobname) return build.jobname
  const base = build.rootPath ? basename(build.rootPath) : ''
  return base.replace(/\.tex$/i, '')
}

export function pdfDownloadName(projectName: string, build: Build | null | undefined, mainPath: string | null | undefined): string {
  const project = safeFilename(projectName, 'project')
  if (build && isOtherRoot(build, mainPath)) {
    const job = buildJobname(build)
    if (job) return `${project} - ${safeFilename(job, 'document')}.pdf`
  }
  return `${project}.pdf`
}
