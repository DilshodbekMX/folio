/** File tree operations: rename/move, delete, download, main document, copy path. */
import { basename, dirname, joinPath, validateName } from '@folio/shared/paths'
import { api } from '../../api/endpoints'
import { errorMessage } from '../../api/client'
import { downloadUrl } from '../../lib/download'
import { pluralize } from '../../lib/format'
import { useProject } from '../../stores/project'
import { confirmDialog, toast } from '../../ui'
import { expectLocalDeletion } from '../editor/openFileGuard'
import { descendantFiles, topLevelOnly, type TreeNode } from './tree'

/** Validation message for renaming `node` to `name` (null when fine). */
export function validateRename(node: TreeNode, name: string): string | null {
  const err = validateName(name)
  if (err) return err
  if (name === node.name) return null
  const target = joinPath(dirname(node.path), name)
  const existing = useProject.getState().fileByPath(target)
  if (existing && existing.id !== node.id) return 'A file or folder with this name already exists here.'
  return null
}

export async function renameNode(node: TreeNode, name: string): Promise<boolean> {
  const pid = useProject.getState().projectId
  if (!pid || !node.entry || name === node.name) return false
  try {
    await api.moveEntry(pid, node.id, { path: joinPath(dirname(node.path), name) })
    return true
  } catch (e) {
    toast(`Couldn’t rename “${node.name}”: ${errorMessage(e)}`, { tone: 'error' })
    return false
  }
}

/**
 * Move nodes into `folder` ('' = root). Items already there or that would land inside
 * themselves are skipped; name collisions are reported like Overleaf does.
 */
export async function moveNodes(nodes: TreeNode[], folder: string): Promise<number> {
  const project = useProject.getState()
  const pid = project.projectId
  if (!pid) return 0
  let moved = 0
  for (const node of topLevelOnly(nodes)) {
    if (!node.entry) continue
    if (dirname(node.path) === folder) continue
    if (node.kind === 'folder' && (folder === node.path || folder.startsWith(node.path + '/'))) {
      toast(`“${node.name}” can’t be moved into itself.`, { tone: 'warning' })
      continue
    }
    const target = joinPath(folder, node.name)
    if (useProject.getState().fileByPath(target)) {
      toast(`An item named “${node.name}” already exists in this location. Rename or remove the conflicting item and try again.`, { tone: 'error' })
      continue
    }
    try {
      await api.moveEntry(pid, node.id, { path: target })
      moved++
    } catch (e) {
      toast(`Couldn’t move “${node.name}”: ${errorMessage(e)}`, { tone: 'error' })
    }
  }
  return moved
}

export async function deleteNodes(nodes: TreeNode[]): Promise<boolean> {
  const project = useProject.getState()
  const pid = project.projectId
  const list = topLevelOnly(nodes).filter(n => n.entry)
  if (!pid || list.length === 0) return false
  const rootId = project.settings?.rootFileId ?? null
  const includesRoot = !!rootId && list.some(n => n.id === rootId || (n.kind === 'folder' && descendantFiles(n).some(f => f.id === rootId)))
  const shown = list.slice(0, 10)
  const ok = await confirmDialog({
    title: list.length === 1 ? `Delete “${list[0].name}”?` : `Delete ${list.length} items?`,
    message: (
      <>
        <p>Are you sure you want to permanently delete the following {list.length === 1 ? (list[0].kind === 'folder' ? 'folder' : 'file') : 'items'}?</p>
        <ul className="ft-deletelist">
          {shown.map(n => {
            const inner = n.kind === 'folder' ? descendantFiles(n).length : 0
            return (
              <li key={n.id}>
                <code>{n.path}</code>
                {n.kind === 'folder' && <span className="ft-deletelist__meta"> — folder with {pluralize(inner, 'file')}</span>}
              </li>
            )
          })}
          {list.length > shown.length && <li className="ft-deletelist__meta">and {list.length - shown.length} more</li>}
        </ul>
        {includesRoot && <p className="ft-deletelist__warn">This includes the main document. Choose a new one in Settings → Compiler afterwards.</p>}
        <p className="ft-deletelist__meta">Deleted files can be recovered from the project history.</p>
      </>
    ),
    confirmLabel: 'Delete',
    danger: true,
  })
  if (!ok) return false
  // the editor closes if the open file is among them, without reporting it as someone else's doing
  expectLocalDeletion(list.map(n => ({ id: n.id, path: n.path, kind: n.kind })))
  let failed = 0
  for (const n of list) {
    try {
      await api.deleteEntry(pid, n.id)
    } catch (e) {
      failed++
      toast(`Couldn’t delete “${n.name}”: ${errorMessage(e)}`, { tone: 'error' })
    }
  }
  return failed === 0
}

export function downloadNode(node: TreeNode): void {
  const pid = useProject.getState().projectId
  if (!pid || !node.entry || node.kind === 'folder') return
  downloadUrl(api.rawFileUrl(pid, node.id, { download: true }), basename(node.path))
}

export async function setMainDocument(node: TreeNode): Promise<void> {
  try {
    await useProject.getState().updateSettings({ rootFileId: node.id })
    toast(<>“{node.path}” is now the main document.</>, { tone: 'success' })
  } catch (e) {
    toast(`Couldn’t set the main document: ${errorMessage(e)}`, { tone: 'error' })
  }
}

export async function copyText(text: string, what = 'Path'): Promise<void> {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
    else {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.setAttribute('readonly', '')
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      document.execCommand('copy')
      ta.remove()
    }
    toast(`${what} copied to the clipboard.`, { tone: 'success', duration: 2000 })
  } catch {
    toast(`Couldn’t copy to the clipboard.`, { tone: 'error' })
  }
}
