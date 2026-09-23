/** Dashboard project actions (with confirmations, optimistic updates and toasts). */
import { create } from 'zustand'
import type { CompileResponse, ProjectSummary, ProjectTemplate } from '@folio/shared/api'
import { api } from '../../api/endpoints'
import { errorMessage } from '../../api/client'
import { downloadAs, downloadUrl, safeFilename } from '../../lib/download'
import { pluralize } from '../../lib/format'
import { compileStatusMessage } from '../../stores/compileStatus'
import { confirmDialog, dismissToast, promptDialog, toast } from '../../ui'
import { buildJobname, isOtherRoot, pdfDownloadName } from '../pdf/downloadName'
import { useDashboard } from './store'

type Navigate = (to: string) => void

const MAX_NAME = 150

export function validateProjectName(v: string): string | null {
  if (!v) return 'Enter a project name.'
  if (v.length > MAX_NAME) return `Project names can be at most ${MAX_NAME} characters.`
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return 'Project names cannot contain control characters.'
  return null
}

function ProjectList({ projects }: { projects: ProjectSummary[] }) {
  const shown = projects.slice(0, 8)
  return (
    <ul className="dash-confirm-list">
      {shown.map(p => (
        <li key={p.id}>{p.name}</li>
      ))}
      {projects.length > shown.length && <li className="dash-confirm-list__more">and {projects.length - shown.length} more</li>}
    </ul>
  )
}

/** Run `fn` for each project; report failures in one toast. Returns the ids that succeeded. */
async function forEachProject(projects: ProjectSummary[], fn: (p: ProjectSummary) => Promise<unknown>, verb: string): Promise<string[]> {
  const results = await Promise.allSettled(projects.map(fn))
  const ok: string[] = []
  const failed: { p: ProjectSummary; e: unknown }[] = []
  results.forEach((r, i) => {
    if (r.status === 'fulfilled') ok.push(projects[i].id)
    else failed.push({ p: projects[i], e: r.reason })
  })
  if (failed.length === 1) {
    toast(`Couldn’t ${verb} “${failed[0].p.name}”: ${errorMessage(failed[0].e)}`, { tone: 'error' })
  } else if (failed.length > 1) {
    toast(`Couldn’t ${verb} ${failed.length} projects: ${errorMessage(failed[0].e)}`, { tone: 'error' })
  }
  return ok
}

function refreshQuietly() {
  useDashboard.getState().load({ quiet: true }).catch(() => {})
}

export async function createProject(template: ProjectTemplate, navigate: Navigate): Promise<void> {
  const name = await promptDialog({
    title: template === 'example' ? 'New example project' : 'New blank project',
    label: 'Project name',
    initial: template === 'example' ? 'Example project' : '',
    placeholder: 'e.g. Thesis draft',
    confirmLabel: 'Create',
    validate: validateProjectName,
  })
  if (name === null) return
  try {
    const { id } = await api.createProject({ name, template })
    navigate(`/project/${id}`)
  } catch (e) {
    toast(`Couldn’t create the project: ${errorMessage(e)}`, { tone: 'error' })
  }
}

export async function copyProject(p: ProjectSummary, navigate: Navigate): Promise<void> {
  const name = await promptDialog({
    title: 'Copy project',
    label: 'New name',
    initial: `${p.name} (Copy)`,
    confirmLabel: 'Copy',
    validate: validateProjectName,
    message: 'The copy is owned by you. Collaborators, share links, history and chat are not copied.',
  })
  if (name === null) return
  try {
    const { id } = await api.copyProject(p.id, { name })
    toast(`Copied to “${name}”.`, { tone: 'success', action: { label: 'Open', onClick: () => navigate(`/project/${id}`) } })
    refreshQuietly()
  } catch (e) {
    toast(`Couldn’t copy “${p.name}”: ${errorMessage(e)}`, { tone: 'error' })
  }
}

export async function renameProject(p: ProjectSummary): Promise<void> {
  const name = await promptDialog({
    title: 'Rename project',
    label: 'New name',
    initial: p.name,
    confirmLabel: 'Rename',
    validate: validateProjectName,
  })
  if (name === null || name === p.name) return
  const prev = p.name
  useDashboard.getState().patch(p.id, { name })
  try {
    await api.updateProject(p.id, { name })
    toast(`Renamed to “${name}”.`, { tone: 'success' })
  } catch (e) {
    useDashboard.getState().patch(p.id, { name: prev })
    toast(`Couldn’t rename “${prev}”: ${errorMessage(e)}`, { tone: 'error' })
  }
}

export function downloadZips(projects: ProjectSummary[]): void {
  // Browsers may block rapid-fire downloads; stagger them.
  projects.forEach((p, i) => {
    window.setTimeout(() => downloadUrl(api.downloadProjectUrl(p.id), `${safeFilename(p.name, 'project')}.zip`), i * 450)
  })
}

/** Projects whose PDF is being fetched or compiled for download (row spinner). */
export const usePdfDownloads = create<{ busy: ReadonlySet<string> }>(() => ({ busy: new Set<string>() }))

function setPdfBusy(id: string, on: boolean): void {
  const busy = new Set(usePdfDownloads.getState().busy)
  if (on) busy.add(id)
  else busy.delete(id)
  usePdfDownloads.setState({ busy })
}

/**
 * Download the PDF of the project's MAIN document as "<project name>.pdf". A project can have
 * several root documents (the paper and its supplement) and the newest build may be of another
 * one, so the main document's newest build is asked for and checked. Without a PDF of it, editors
 * compile it on demand (the server compiles the live documents); viewers get another root
 * document's PDF if there is one — saved as "<project name> - <jobname>.pdf", and told so — else,
 * like failed compiles, the offer to open the project.
 */
export async function downloadPdf(p: ProjectSummary, navigate: Navigate): Promise<void> {
  if (usePdfDownloads.getState().busy.has(p.id)) return
  const toastId = `dash-pdf-${p.id}`
  const open = { label: 'Open project', onClick: () => navigate(`/project/${p.id}`) }
  setPdfBusy(p.id, true)
  try {
    const detail = await api.getProject(p.id)
    const mainId = detail.settings.rootFileId
    const mainPath = mainId ? (detail.files.find(f => f.id === mainId)?.path ?? null) : null
    const last = await api.lastCompile(p.id, mainId ? { rootFileId: mainId } : { main: true })
    // (a server that keeps one last build per project may answer with another document's)
    const pdfs = (b: CompileResponse | null) => [b, b?.lastWithPdf].filter((x): x is CompileResponse => !!x?.pdfUrl)
    const withPdf = pdfs(last)
    let build = withPdf.find(b => !isOtherRoot(b, mainPath)) ?? null
    if (!build && p.role === 'viewer') {
      // viewers cannot compile the main document: the newest PDF of any root document
      const other = withPdf[0] ?? pdfs(await api.lastCompile(p.id))[0]
      if (!other) {
        toast(`“${p.name}” has no PDF yet. It appears once an editor compiles the project.`, { id: toastId, tone: 'warning', action: open })
        return
      }
      toast(`“${p.name}” has no PDF of its main document yet, so ${buildJobname(other)}.pdf is downloaded instead.`, { id: toastId, tone: 'warning', action: open })
      build = other
    }
    if (!build) {
      toast(`Compiling “${p.name}” to download its PDF…`, { id: toastId, tone: 'info', duration: 0 })
      const res = await api.compile(p.id, {})
      if (!res.pdfUrl) {
        const why = compileStatusMessage(res.status) ?? 'No PDF was produced.'
        toast(`PDF unavailable for download: “${p.name}” did not compile. ${why}`, { id: toastId, tone: 'error', duration: 10_000, action: open })
        return
      }
      dismissToast(toastId)
      build = res
    }
    await downloadAs(build.pdfUrl!, pdfDownloadName(p.name, build, mainPath))
  } catch (e) {
    toast(`Couldn’t get the PDF of “${p.name}”: ${errorMessage(e)}`, { id: toastId, tone: 'error', action: open })
  } finally {
    setPdfBusy(p.id, false)
  }
}

async function setFlag(projects: ProjectSummary[], flag: 'archived' | 'trashed', value: boolean, verb: string): Promise<string[]> {
  const store = useDashboard.getState()
  for (const p of projects) store.patch(p.id, { [flag]: value })
  const ok = await forEachProject(projects, p => api.updateProject(p.id, { [flag]: value }), verb)
  const okSet = new Set(ok)
  for (const p of projects) if (!okSet.has(p.id)) useDashboard.getState().patch(p.id, { [flag]: p[flag] })
  useDashboard.getState().clearSelection()
  return ok
}

export async function archiveProjects(projects: ProjectSummary[]): Promise<void> {
  if (!projects.length) return
  const ok = await confirmDialog({
    title: projects.length === 1 ? 'Archive project' : 'Archive projects',
    message: (
      <>
        You are about to archive the following {projects.length === 1 ? 'project' : 'projects'}:
        <ProjectList projects={projects} />
        <p className="dash-confirm-note">Archiving only affects your own project list, not your collaborators’.</p>
      </>
    ),
    confirmLabel: 'Archive',
  })
  if (!ok) return
  const done = await setFlag(projects, 'archived', true, 'archive')
  if (done.length) toast(`Archived ${pluralize(done.length, 'project')}.`, { tone: 'success' })
}

export async function unarchiveProjects(projects: ProjectSummary[]): Promise<void> {
  if (!projects.length) return
  const done = await setFlag(projects, 'archived', false, 'restore')
  if (done.length) toast(`Moved ${pluralize(done.length, 'project')} back to your projects.`, { tone: 'success' })
}

export async function trashProjects(projects: ProjectSummary[]): Promise<void> {
  if (!projects.length) return
  const ok = await confirmDialog({
    title: projects.length === 1 ? 'Trash project' : 'Trash projects',
    message: (
      <>
        You are about to move the following {projects.length === 1 ? 'project' : 'projects'} to the trash:
        <ProjectList projects={projects} />
        <p className="dash-confirm-note">Trashing only affects your own project list. You can restore trashed projects at any time.</p>
      </>
    ),
    confirmLabel: 'Move to trash',
  })
  if (!ok) return
  const done = await setFlag(projects, 'trashed', true, 'trash')
  if (done.length) toast(`Moved ${pluralize(done.length, 'project')} to the trash.`, { tone: 'success' })
}

export async function restoreProjects(projects: ProjectSummary[]): Promise<void> {
  if (!projects.length) return
  const done = await setFlag(projects, 'trashed', false, 'restore')
  if (done.length) toast(`Restored ${pluralize(done.length, 'project')}.`, { tone: 'success' })
}

/**
 * Trash view "Delete / Leave": owned projects are deleted for everyone, shared ones are left
 * (membership removed). One confirmation covers both.
 */
export async function deleteOrLeaveProjects(projects: ProjectSummary[], meId: string): Promise<void> {
  const owned = projects.filter(p => p.role === 'owner')
  const shared = projects.filter(p => p.role !== 'owner')
  if (!owned.length && !shared.length) return
  const title = owned.length && shared.length
    ? 'Delete and leave projects'
    : owned.length
      ? (owned.length === 1 ? 'Delete project' : 'Delete projects')
      : (shared.length === 1 ? 'Leave project' : 'Leave projects')
  const ok = await confirmDialog({
    title,
    danger: owned.length > 0,
    confirmLabel: owned.length && shared.length ? 'Delete and leave' : owned.length ? 'Delete forever' : 'Leave',
    message: (
      <>
        {owned.length > 0 && (
          <>
            These {owned.length === 1 ? 'project' : 'projects'} will be permanently deleted, for you and everyone
            {owned.length === 1 ? ' it is' : ' they are'} shared with:
            <ProjectList projects={owned} />
          </>
        )}
        {shared.length > 0 && (
          <>
            You will leave {shared.length === 1 ? 'this project' : 'these projects'} and lose access:
            <ProjectList projects={shared} />
          </>
        )}
        {owned.length > 0 && <p className="dash-confirm-note dash-confirm-note--danger">This cannot be undone.</p>}
      </>
    ),
  })
  if (!ok) return
  const deleted = await forEachProject(owned, p => api.deleteProject(p.id), 'delete')
  const left = await forEachProject(shared, p => api.removeMember(p.id, meId), 'leave')
  useDashboard.getState().remove([...deleted, ...left])
  if (deleted.length) toast(`Deleted ${pluralize(deleted.length, 'project')}.`, { tone: 'success' })
  if (left.length) toast(`Left ${pluralize(left.length, 'project')}.`, { tone: 'success' })
}
