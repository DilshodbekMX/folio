/** "New file" / "New folder" flows (File menu, file tree via useLayout.openModal('newfile' | 'newfolder')). */
import { joinPath, normalizePath, validatePath } from '@folio/shared/paths'
import { api } from '../../api/endpoints'
import { errorMessage } from '../../api/client'
import { useEditor } from '../../stores/editor'
import { useProject } from '../../stores/project'
import { promptDialog, toast } from '../../ui'

export function validateNewEntryName(value: string, folder: string): string | null {
  const rel = normalizePath(value)
  if (!rel) return 'Enter a name.'
  const path = joinPath(folder, rel)
  const err = validatePath(path)
  if (err) return err
  const project = useProject.getState()
  if (project.fileByPath(path)) return 'A file or folder with this name already exists here.'
  // Every parent that already exists must be a folder.
  const segments = path.split('/')
  for (let i = 1; i < segments.length; i++) {
    const parent = project.fileByPath(segments.slice(0, i).join('/'))
    if (parent && parent.kind !== 'folder') return `“${parent.path}” is a file, not a folder.`
  }
  return null
}

/** Resolve once the meta room has delivered the new entry (or after `timeoutMs`). */
export function waitForFile(fileId: string, timeoutMs: number): Promise<void> {
  if (useProject.getState().files[fileId]) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => {
      clearTimeout(timer)
      unsub()
      resolve()
    }
    const unsub = useProject.subscribe(s => {
      if (s.files[fileId]) done()
    })
    const timer = setTimeout(done, timeoutMs)
  })
}

export async function promptNewEntry(kind: 'text' | 'folder', folder = ''): Promise<void> {
  const project = useProject.getState()
  const pid = project.projectId
  if (!pid) return
  if (!project.canEdit()) {
    toast('You have view access to this project, so you can’t add files.', { tone: 'warning' })
    return
  }
  const base = normalizePath(folder)
  const name = await promptDialog({
    title: kind === 'folder' ? 'New folder' : 'New file',
    label: kind === 'folder' ? 'Folder name' : 'File name',
    message: base ? <>Creating in <code>{base}/</code></> : undefined,
    initial: kind === 'folder' ? '' : 'name.tex',
    placeholder: kind === 'folder' ? 'figures' : 'chapter.tex',
    select: kind === 'folder' ? 'all' : 'basename',
    confirmLabel: 'Create',
    validate: v => validateNewEntryName(v, base),
  })
  if (name === null) return
  const path = joinPath(base, normalizePath(name))
  try {
    const entry = await api.createEntry(pid, { path, kind })
    if (kind === 'text') {
      await waitForFile(entry.id, 3000)
      if (useProject.getState().projectId === pid) useEditor.getState().openFile(entry.id)
    }
  } catch (e) {
    toast(`Couldn’t create “${path}”: ${errorMessage(e)}`, { tone: 'error' })
  }
}
