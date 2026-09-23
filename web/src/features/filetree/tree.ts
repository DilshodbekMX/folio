/**
 * File tree model: nested nodes built from useProject.files (folders first, natural sort),
 * the flattened list of visible rows, and small path helpers shared by the tree, the upload
 * flows and the history view.
 */
import type { FileEntry, FileKind } from '@folio/shared/api'
import { basename, dirname, extname, isWithin } from '@folio/shared/paths'

export interface TreeNode {
  id: string
  path: string
  name: string
  kind: FileKind
  depth: number
  parent: TreeNode | null
  children: TreeNode[]
  /** null for folders that only exist implicitly (a file's parent without its own entry) */
  entry: FileEntry | null
}

export interface TreeModel {
  roots: TreeNode[]
  byId: Map<string, TreeNode>
  byPath: Map<string, TreeNode>
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** Folders first, then a natural, case-insensitive order by name (ties broken by exact name). */
export function compareNodes(a: { kind: FileKind; name: string }, b: { kind: FileKind; name: string }): number {
  const af = a.kind === 'folder' ? 0 : 1
  const bf = b.kind === 'folder' ? 0 : 1
  if (af !== bf) return af - bf
  return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
}

export const VIRTUAL_PREFIX = 'virtual:'

export function buildTree(files: Record<string, FileEntry>): TreeModel {
  const byId = new Map<string, TreeNode>()
  const byPath = new Map<string, TreeNode>()
  const roots: TreeNode[] = []

  const entries = Object.values(files).sort((a, b) => a.path.length - b.path.length || (a.path < b.path ? -1 : 1))
  const ensureFolder = (path: string): TreeNode | null => {
    if (!path) return null
    const existing = byPath.get(path)
    if (existing) return existing.kind === 'folder' ? existing : null
    // implicit folder: the server normally has an entry for every folder, but never lose a file
    const parent = ensureFolder(dirname(path))
    const node: TreeNode = {
      id: VIRTUAL_PREFIX + path, path, name: basename(path), kind: 'folder', depth: parent ? parent.depth + 1 : 0,
      parent, children: [], entry: null,
    }
    byPath.set(path, node)
    byId.set(node.id, node)
    ;(parent ? parent.children : roots).push(node)
    return node
  }

  for (const f of entries) {
    if (byPath.has(f.path)) {
      // an implicit folder was created first (should not happen with shortest-first order)
      const n = byPath.get(f.path)!
      if (n.entry === null && f.kind === 'folder') {
        byId.delete(n.id)
        n.id = f.id
        n.entry = f
        byId.set(f.id, n)
      }
      continue
    }
    const parent = ensureFolder(dirname(f.path))
    const node: TreeNode = {
      id: f.id, path: f.path, name: basename(f.path), kind: f.kind, depth: parent ? parent.depth + 1 : 0,
      parent, children: [], entry: f,
    }
    byPath.set(f.path, node)
    byId.set(f.id, node)
    ;(parent ? parent.children : roots).push(node)
  }

  const sortRec = (list: TreeNode[]) => {
    list.sort(compareNodes)
    for (const n of list) if (n.children.length) sortRec(n.children)
  }
  sortRec(roots)
  return { roots, byId, byPath }
}

/** Depth-first list of the rows that are visible with the given folders expanded. */
export function flattenVisible(roots: TreeNode[], expanded: ReadonlySet<string>): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      out.push(n)
      if (n.kind === 'folder' && n.children.length && expanded.has(n.id)) walk(n.children)
    }
  }
  walk(roots)
  return out
}

/** Ids of the folders containing `node` (outermost first). */
export function ancestorIds(node: TreeNode): string[] {
  const out: string[] = []
  for (let p = node.parent; p; p = p.parent) out.unshift(p.id)
  return out
}

/** Every file (not folder) below `node` (or the node itself when it is a file). */
export function descendantFiles(node: TreeNode): TreeNode[] {
  if (node.kind !== 'folder') return [node]
  const out: TreeNode[] = []
  const walk = (list: TreeNode[]) => {
    for (const n of list) {
      if (n.kind === 'folder') walk(n.children)
      else out.push(n)
    }
  }
  walk(node.children)
  return out
}

/** Drop nodes that lie inside another node of the same list (moving/deleting a folder covers them). */
export function topLevelOnly(nodes: TreeNode[]): TreeNode[] {
  return nodes.filter(n => !nodes.some(o => o !== n && o.kind === 'folder' && n.path.startsWith(o.path + '/')))
}

/** Folder path a new entry / upload / drop goes into for a given node ('' = project root). */
export function containerPath(node: TreeNode | null | undefined): string {
  if (!node) return ''
  return node.kind === 'folder' ? node.path : dirname(node.path)
}

/** Main-document candidates: text files with a TeX extension. */
export function isRootDocCandidate(entry: FileEntry | null | undefined): boolean {
  if (!entry || entry.kind !== 'text') return false
  return ['tex', 'ltx', 'latex', 'rtex'].includes(extname(entry.path))
}

/** True when moving `node` into folder `target` ('' = root) makes sense. */
export function canMoveInto(node: TreeNode, target: string): boolean {
  if (dirname(node.path) === target) return false
  if (node.kind === 'folder' && isWithin(target, node.path)) return false
  return true
}
