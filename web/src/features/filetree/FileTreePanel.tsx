/**
 * File tree panel (SPEC §6.7/§6.8, Overleaf-style):
 *   header toolbar (New file, New folder, Upload, Collapse all) · nested tree from
 *   useProject.files (folders first, natural sort, indent guides, type icons) · main-document
 *   marker · presence dots · selection (click, Ctrl/Cmd-click, Shift-click) · WAI-ARIA tree
 *   keyboard navigation (↑↓←→ Home End, Enter opens, F2 renames, Delete deletes, type-ahead,
 *   Shift+F10/context-menu key) · inline rename with validation · context menu · HTML5
 *   drag-to-move (onto folders/root, never into itself, hover auto-expand) · OS file/folder
 *   drop → upload with a progress toast · expanded folders persisted per project in
 *   localStorage ('folio:filetree:<pid>') · auto-reveal of the open file · viewers get a
 *   read-only tree.
 */
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type DragEvent, type KeyboardEvent, type MouseEvent, type ReactNode,
} from 'react'
import clsx from 'clsx'
import {
  ChevronRight, ChevronsDownUp, ClipboardCopy, Download, Ellipsis, FilePlus, FolderPlus, House, Pencil, Trash2, Upload,
} from 'lucide-react'
import type { FileEntry } from '@folio/shared/api'
import type { PresenceUser } from '@folio/shared/protocol'
import { dirname, joinPath } from '@folio/shared/paths'
import { isMac } from '../../lib/platform'
import { isRecord, readJSON, writeJSON } from '../../lib/storage'
import { useEditor } from '../../stores/editor'
import { useLayout } from '../../stores/layout'
import { useProject } from '../../stores/project'
import { Button, EmptyState, IconButton, Spinner, Tooltip, showContextMenu, type MenuItem } from '../../ui'
import { requestEditorFocus } from '../editor/reveal'
import {
  copyText, deleteNodes, downloadNode, moveNodes, renameNode, setMainDocument, validateRename,
} from './actions'
import { FileIcon } from './FileIcon'
import {
  ancestorIds, buildTree, canMoveInto, containerPath, flattenVisible, isRootDocCandidate, topLevelOnly,
  type TreeModel, type TreeNode,
} from './tree'
import { filesFromDrop, isOsFileDrag, quickUpload } from './upload'
import './filetree.css'

const TREE_MIME = 'application/x-folio-tree-items'
const EXPAND_KEY = (pid: string) => `folio:filetree:${pid}`
const AUTO_EXPAND_MS = 650

// ---------------------------------------------------------------------------------------------
// expanded folders, persisted per project
// ---------------------------------------------------------------------------------------------

interface PersistedTree { expanded: string[] }

function loadExpanded(pid: string): Set<string> {
  const v = readJSON<PersistedTree | null>(EXPAND_KEY(pid), null, x =>
    isRecord(x) && Array.isArray(x.expanded) ? { expanded: x.expanded.filter((s): s is string => typeof s === 'string') } : undefined)
  return new Set(v?.expanded ?? [])
}

function saveExpanded(pid: string, expanded: Set<string>, model: TreeModel): void {
  // only prune against a populated tree (the file list may still be loading)
  const ids = model.byId.size > 0 ? [...expanded].filter(id => model.byId.get(id)?.kind === 'folder') : [...expanded]
  writeJSON(EXPAND_KEY(pid), { expanded: ids } satisfies PersistedTree)
}

/**
 * Open a file chosen in the tree: the editor comes into view ("PDF only" → split; not while the
 * History view shows that file's history instead) and takes the focus once the file has loaded.
 */
function openFromTree(id: string): void {
  const layout = useLayout.getState()
  if (!layout.historyOpen && layout.view === 'pdf') layout.setView('split')
  if (useProject.getState().files[id]?.kind === 'text') requestEditorFocus(id)
  useEditor.getState().openFile(id)
}

// ---------------------------------------------------------------------------------------------
// panel
// ---------------------------------------------------------------------------------------------

export function FileTreePanel() {
  const pid = useProject(s => s.projectId)
  if (!pid) return <div className="ft-panel" />
  return <FileTree key={pid} pid={pid} />
}

interface DropState {
  /** folder path the drop goes into ('' = project root) */
  target: string
  kind: 'move' | 'upload'
}

function FileTree({ pid }: { pid: string }) {
  const files = useProject(s => s.files)
  const loadState = useProject(s => s.loadState)
  const canEdit = useProject(s => s.role === 'owner' || s.role === 'editor')
  const rootFileId = useProject(s => s.settings?.rootFileId ?? null)
  const presence = useProject(s => s.presence)
  const openFileId = useEditor(s => s.openFileId)
  const openModal = useLayout(s => s.openModal)

  const model = useMemo(() => buildTree(files), [files])
  const [expanded, setExpanded] = useState<Set<string>>(() => loadExpanded(pid))
  const rows = useMemo(() => flattenVisible(model.roots, expanded), [model, expanded])

  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set(openFileId ? [openFileId] : []))
  const [anchorId, setAnchorId] = useState<string | null>(openFileId)
  const [focusId, setFocusId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [drop, setDrop] = useState<DropState | null>(null)
  const [dragging, setDragging] = useState<ReadonlySet<string>>(() => new Set())

  const treeRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const pendingFocus = useRef<{ id: string; focus: boolean } | null>(null)
  const pendingReveal = useRef<string | null>(openFileId)
  const dragIds = useRef<string[] | null>(null)
  const autoExpand = useRef<{ id: string; timer: number } | null>(null)
  const typeahead = useRef({ text: '', at: 0 })

  // latest values for event handlers
  const st = useRef({ model, rows, selection, anchorId, focusId, canEdit, expanded, rootFileId })
  st.current = { model, rows, selection, anchorId, focusId, canEdit, expanded, rootFileId }

  // -- expanded state ----------------------------------------------------------------------

  const updateExpanded = useCallback((fn: (prev: Set<string>) => Set<string>) => {
    setExpanded(prev => {
      const next = fn(prev)
      if (next === prev) return prev
      saveExpanded(pid, next, st.current.model)
      return next
    })
  }, [pid])

  const setFolderOpen = useCallback((id: string, open: boolean) => {
    updateExpanded(prev => {
      if (prev.has(id) === open) return prev
      const next = new Set(prev)
      if (open) next.add(id)
      else next.delete(id)
      return next
    })
  }, [updateExpanded])

  const toggleFolder = useCallback((id: string) => {
    updateExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [updateExpanded])

  const expandPath = useCallback((node: TreeNode) => {
    const ids = ancestorIds(node)
    updateExpanded(prev => (ids.every(id => prev.has(id)) ? prev : new Set([...prev, ...ids])))
  }, [updateExpanded])

  // -- reveal the open file -----------------------------------------------------------------

  useEffect(() => {
    pendingReveal.current = openFileId
  }, [openFileId])

  useEffect(() => {
    const id = pendingReveal.current
    if (!id) return
    const node = model.byId.get(id)
    if (!node) return // not delivered by the meta room yet
    pendingReveal.current = null
    expandPath(node)
    setSelection(prev => (prev.size === 1 && prev.has(id) ? prev : new Set([id])))
    setAnchorId(id)
    pendingFocus.current = { id, focus: false }
  }, [model, openFileId, expandPath])

  // drop selection entries whose files disappeared (only schedule an update when needed: the
  // file list can change hundreds of times per second during a bulk upload)
  useEffect(() => {
    if ([...st.current.selection].some(id => !model.byId.has(id))) {
      setSelection(prev => new Set([...prev].filter(id => model.byId.has(id))))
    }
    if (renamingId && !model.byId.has(renamingId)) setRenamingId(null)
  }, [model, renamingId])

  // scroll/focus rows requested by keyboard navigation or reveal
  useLayoutEffect(() => {
    const req = pendingFocus.current
    if (!req) return
    const el = treeRef.current?.querySelector<HTMLElement>(`[data-ft-row][data-id="${CSS.escape(req.id)}"]`)
    if (!el) return
    pendingFocus.current = null
    el.scrollIntoView({ block: 'nearest' })
    if (req.focus) el.focus({ preventScroll: true })
  })

  // -- selection helpers ------------------------------------------------------------------

  const focusRow = useCallback((id: string, focus = true) => {
    setFocusId(id)
    pendingFocus.current = { id, focus }
  }, [])

  const selectOnly = useCallback((id: string) => {
    setSelection(new Set([id]))
    setAnchorId(id)
  }, [])

  const selectRange = useCallback((toId: string) => {
    const { rows: list, anchorId: a } = st.current
    const from = list.findIndex(r => r.id === (a ?? toId))
    const to = list.findIndex(r => r.id === toId)
    if (from < 0 || to < 0) {
      selectOnly(toId)
      return
    }
    const [lo, hi] = from < to ? [from, to] : [to, from]
    setSelection(new Set(list.slice(lo, hi + 1).map(r => r.id)))
  }, [selectOnly])

  const openNode = useCallback((node: TreeNode) => {
    if (node.kind === 'folder') toggleFolder(node.id)
    else openFromTree(node.id)
  }, [toggleFolder])

  const selectedNodes = useCallback((): TreeNode[] => {
    const { model: m, rows: list, selection: sel } = st.current
    const order = new Map(list.map((r, i) => [r.id, i]))
    return [...sel].map(id => m.byId.get(id)).filter((n): n is TreeNode => !!n)
      .sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0))
  }, [])

  const targetFolder = useCallback((): string => {
    const nodes = selectedNodes()
    return nodes.length === 1 ? containerPath(nodes[0]) : ''
  }, [selectedNodes])

  // -- actions --------------------------------------------------------------------------------

  const startRename = useCallback((node: TreeNode) => {
    if (!st.current.canEdit || !node.entry) return
    selectOnly(node.id)
    setFocusId(node.id)
    setRenamingId(node.id)
  }, [selectOnly])

  const finishRename = useCallback((restoreFocusTo: string | null) => {
    setRenamingId(null)
    if (restoreFocusTo) focusRow(restoreFocusTo)
  }, [focusRow])

  const deleteSelected = useCallback(async (nodes: TreeNode[]) => {
    if (!st.current.canEdit || nodes.length === 0) return
    const list = st.current.rows
    const idx = list.findIndex(r => r.id === nodes[0].id)
    const ok = await deleteNodes(nodes)
    if (!ok) return
    // keep keyboard focus nearby
    const removed = new Set(nodes.map(n => n.id))
    const next = list.slice(idx + 1).find(r => !removed.has(r.id) && !nodes.some(n => r.path.startsWith(n.path + '/')))
      ?? list.slice(0, Math.max(0, idx)).reverse().find(r => !removed.has(r.id))
    if (next) {
      selectOnly(next.id)
      focusRow(next.id)
    }
  }, [focusRow, selectOnly])

  const nodeMenu = useCallback((node: TreeNode): MenuItem[] => {
    const { canEdit: editable, rootFileId: root } = st.current
    const isFolder = node.kind === 'folder'
    const real = !!node.entry
    const items: MenuItem[] = []
    if (isFolder && editable) {
      items.push(
        { label: 'New file…', icon: FilePlus, onSelect: () => openModal('newfile', { folder: node.path }) },
        { label: 'New folder…', icon: FolderPlus, onSelect: () => openModal('newfolder', { folder: node.path }) },
        { label: 'Upload…', icon: Upload, onSelect: () => openModal('upload', { folder: node.path }) },
        { type: 'separator' },
      )
    }
    if (editable && real) {
      items.push({ label: 'Rename', icon: Pencil, shortcut: 'F2', onSelect: () => startRename(node) })
    }
    if (!isFolder) items.push({ label: 'Download', icon: Download, onSelect: () => downloadNode(node) })
    if (editable && isRootDocCandidate(node.entry)) {
      const isRoot = root === node.id
      items.push({
        label: isRoot ? 'Main document' : 'Set as main document',
        icon: House,
        disabled: isRoot,
        description: isRoot ? 'This file is compiled by Recompile' : undefined,
        onSelect: () => void setMainDocument(node),
      })
    }
    items.push({ label: 'Copy path', icon: ClipboardCopy, onSelect: () => void copyText(node.path) })
    if (editable && real) {
      items.push(
        { type: 'separator' },
        { label: 'Delete', icon: Trash2, danger: true, shortcut: isMac ? '⌘⌫' : 'Del', onSelect: () => void deleteSelected([node]) },
      )
    }
    return items
  }, [deleteSelected, openModal, startRename])

  const multiMenu = useCallback((nodes: TreeNode[]): MenuItem[] => {
    const items: MenuItem[] = [
      { type: 'header', label: `${nodes.length} items selected` },
      { label: 'Copy paths', icon: ClipboardCopy, onSelect: () => void copyText(nodes.map(n => n.path).join('\n'), 'Paths') },
    ]
    if (st.current.canEdit) {
      items.push({ type: 'separator' }, { label: `Delete ${nodes.length} items`, icon: Trash2, danger: true, onSelect: () => void deleteSelected(nodes) })
    }
    return items
  }, [deleteSelected])

  const rootMenu = useCallback((): MenuItem[] => [
    { label: 'New file…', icon: FilePlus, onSelect: () => openModal('newfile') },
    { label: 'New folder…', icon: FolderPlus, onSelect: () => openModal('newfolder') },
    { label: 'Upload…', icon: Upload, onSelect: () => openModal('upload') },
  ], [openModal])

  // -- pointer --------------------------------------------------------------------------------

  const rowFromEvent = (e: { target: EventTarget | null }): TreeNode | null => {
    const el = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-ft-row]') : null
    const id = el?.dataset.id
    return id ? st.current.model.byId.get(id) ?? null : null
  }

  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest('.ft-rename, .ft-row__menu')) return
    const node = rowFromEvent(e)
    if (!node) {
      if (e.target === scrollRef.current || e.target === treeRef.current) setSelection(new Set())
      return
    }
    const mod = isMac ? e.metaKey : e.ctrlKey
    setFocusId(node.id)
    if (e.shiftKey) {
      selectRange(node.id)
      return
    }
    if (mod) {
      setSelection(prev => {
        const next = new Set(prev)
        if (next.has(node.id)) next.delete(node.id)
        else next.add(node.id)
        return next
      })
      setAnchorId(node.id)
      return
    }
    selectOnly(node.id)
    const onCaret = e.target instanceof Element && !!e.target.closest('.ft-row__caret')
    if (node.kind === 'folder' || onCaret) toggleFolder(node.id)
    else openFromTree(node.id)
  }

  const onDoubleClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!(e.target instanceof Element) || !e.target.closest('.ft-row__name')) return
    const node = rowFromEvent(e)
    if (node) startRename(node)
  }

  const onContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    if (e.target instanceof Element && e.target.closest('.ft-rename')) return
    const node = rowFromEvent(e)
    if (!node) {
      if (!st.current.canEdit) return
      showContextMenu(e, rootMenu())
      return
    }
    const sel = st.current.selection
    if (!sel.has(node.id)) selectOnly(node.id)
    setFocusId(node.id)
    const nodes = sel.has(node.id) && sel.size > 1 ? selectedNodes() : [node]
    showContextMenu(e, nodes.length > 1 ? multiMenu(nodes) : nodeMenu(node))
  }

  const onMenuButton = useCallback((e: MouseEvent<HTMLButtonElement>, rowNode: TreeNode) => {
    e.stopPropagation()
    // memoised rows may hold an older (equivalent) node object: use the current one
    const node = st.current.model.byId.get(rowNode.id) ?? rowNode
    selectOnly(node.id)
    setFocusId(node.id)
    const r = e.currentTarget.getBoundingClientRect()
    showContextMenu({ preventDefault: () => e.preventDefault(), clientX: r.left, clientY: r.bottom + 2, currentTarget: e.currentTarget }, nodeMenu(node))
  }, [nodeMenu, selectOnly])

  // -- keyboard -------------------------------------------------------------------------------

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!(e.target instanceof HTMLElement) || !e.target.matches('[data-ft-row]')) return
    const { rows: list, model: m, canEdit: editable, expanded: exp } = st.current
    const node = m.byId.get(e.target.dataset.id ?? '')
    if (!node) return
    const i = list.findIndex(r => r.id === node.id)
    const move = (j: number) => {
      const target = list[Math.max(0, Math.min(list.length - 1, j))]
      if (!target) return
      if (e.shiftKey) {
        selectRange(target.id)
      } else {
        selectOnly(target.id)
      }
      focusRow(target.id)
    }
    const mod = isMac ? e.metaKey : e.ctrlKey
    switch (e.key) {
      case 'ArrowDown':
        move(i + 1)
        break
      case 'ArrowUp':
        move(i - 1)
        break
      case 'Home':
        move(0)
        break
      case 'End':
        move(list.length - 1)
        break
      case 'PageDown':
        move(i + 10)
        break
      case 'PageUp':
        move(i - 10)
        break
      case 'ArrowRight':
        if (node.kind === 'folder') {
          if (!exp.has(node.id)) setFolderOpen(node.id, true)
          else if (node.children.length) move(i + 1)
        }
        break
      case 'ArrowLeft':
        if (node.kind === 'folder' && exp.has(node.id)) setFolderOpen(node.id, false)
        else if (node.parent) {
          selectOnly(node.parent.id)
          focusRow(node.parent.id)
        }
        break
      case 'Enter':
      case ' ':
        selectOnly(node.id)
        openNode(node)
        break
      case 'F2':
        if (editable) startRename(node)
        break
      case 'Delete':
        if (editable) void deleteSelected(st.current.selection.has(node.id) ? selectedNodes() : [node])
        break
      case 'Backspace':
        // macOS: ⌘⌫ deletes (Finder); elsewhere Backspace is left alone
        if (editable && isMac && e.metaKey) void deleteSelected(st.current.selection.has(node.id) ? selectedNodes() : [node])
        else return
        break
      case 'Escape':
        if (st.current.selection.size > 1) selectOnly(node.id)
        else return
        break
      case 'a':
        if (mod) setSelection(new Set(list.map(r => r.id)))
        else if (!typeAhead(e.key, i)) return
        break
      default:
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) {
          if (!typeAhead(e.key, i)) return
          break
        }
        return
    }
    e.preventDefault()
    e.stopPropagation()
  }

  const typeAhead = (key: string, from: number): boolean => {
    const list = st.current.rows
    const now = Date.now()
    const ta = typeahead.current
    ta.text = now - ta.at > 700 ? key.toLowerCase() : ta.text + key.toLowerCase()
    ta.at = now
    const start = ta.text.length === 1 ? from + 1 : from
    const order = [...list.slice(start), ...list.slice(0, start)]
    const hit = order.find(r => r.name.toLowerCase().startsWith(ta.text))
    if (!hit) return false
    selectOnly(hit.id)
    focusRow(hit.id)
    return true
  }

  // -- drag and drop --------------------------------------------------------------------------

  const clearAutoExpand = () => {
    if (autoExpand.current) window.clearTimeout(autoExpand.current.timer)
    autoExpand.current = null
  }

  const endDrag = () => {
    dragIds.current = null
    clearAutoExpand()
    setDrop(null)
    setDragging(prev => (prev.size ? new Set() : prev))
  }

  useEffect(() => () => clearAutoExpand(), [])

  const onDragStart = (e: DragEvent<HTMLDivElement>) => {
    const node = rowFromEvent(e)
    if (!node || !st.current.canEdit || !node.entry) {
      e.preventDefault()
      return
    }
    let nodes: TreeNode[]
    if (st.current.selection.has(node.id)) nodes = topLevelOnly(selectedNodes()).filter(n => n.entry)
    else {
      selectOnly(node.id)
      nodes = [node]
    }
    dragIds.current = nodes.map(n => n.id)
    // dim the dragged rows once the browser has taken its drag snapshot
    const ids = new Set(dragIds.current)
    window.setTimeout(() => {
      if (dragIds.current) setDragging(ids)
    }, 0)
    e.dataTransfer.effectAllowed = 'copyMove'
    e.dataTransfer.setData(TREE_MIME, JSON.stringify(dragIds.current))
    // dropping onto the editor inserts the path
    e.dataTransfer.setData('text/plain', nodes.map(n => n.path).join('\n'))
    const ghost = document.createElement('div')
    ghost.className = 'ft-dragimage'
    ghost.textContent = nodes.length === 1 ? nodes[0].name : `${nodes.length} items`
    document.body.appendChild(ghost)
    e.dataTransfer.setDragImage(ghost, -12, -8)
    window.setTimeout(() => ghost.remove(), 0)
  }

  const dropTargetFor = (node: TreeNode | null): string => containerPath(node)

  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    const internal = Array.from(e.dataTransfer.types).includes(TREE_MIME) && dragIds.current !== null
    const os = !internal && isOsFileDrag(e.dataTransfer)
    if ((!internal && !os) || !st.current.canEdit) return
    const node = rowFromEvent(e)
    const target = dropTargetFor(node)
    if (internal) {
      const m = st.current.model
      const moving = (dragIds.current ?? []).map(id => m.byId.get(id)).filter((n): n is TreeNode => !!n)
      if (!moving.some(n => canMoveInto(n, target))) {
        e.dataTransfer.dropEffect = 'none'
        if (drop) setDrop(null)
        clearAutoExpand()
        return
      }
    }
    e.preventDefault()
    e.dataTransfer.dropEffect = internal ? 'move' : 'copy'
    if (!drop || drop.target !== target || drop.kind !== (internal ? 'move' : 'upload')) {
      setDrop({ target, kind: internal ? 'move' : 'upload' })
    }
    // hovering a collapsed folder opens it after a moment
    if (node && node.kind === 'folder' && !st.current.expanded.has(node.id) && node.children.length > 0) {
      if (autoExpand.current?.id !== node.id) {
        clearAutoExpand()
        const id = node.id
        autoExpand.current = { id, timer: window.setTimeout(() => setFolderOpen(id, true), AUTO_EXPAND_MS) }
      }
    } else if (autoExpand.current && autoExpand.current.id !== node?.id) {
      clearAutoExpand()
    }
  }

  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    const to = e.relatedTarget
    if (to instanceof Node && e.currentTarget.contains(to)) return
    clearAutoExpand()
    setDrop(null)
  }

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    const internalIds = dragIds.current
    const isInternal = Array.from(e.dataTransfer.types).includes(TREE_MIME)
    const target = dropTargetFor(rowFromEvent(e))
    if (!st.current.canEdit || (!isInternal && !isOsFileDrag(e.dataTransfer))) {
      endDrag()
      return
    }
    e.preventDefault()
    endDrag()
    if (isInternal) {
      let ids = internalIds
      if (!ids) {
        try {
          const parsed: unknown = JSON.parse(e.dataTransfer.getData(TREE_MIME))
          ids = Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
        } catch {
          ids = []
        }
      }
      const m = st.current.model
      const nodes = ids.map(id => m.byId.get(id)).filter((n): n is TreeNode => !!n)
      void moveNodes(nodes, target).then(moved => {
        const folder = target ? m.byPath.get(target) : undefined
        if (moved > 0 && folder) setFolderOpen(folder.id, true)
      })
      return
    }
    const pending = filesFromDrop(e.dataTransfer)
    void pending.then(async picked => {
      if (picked.length === 0) return
      await quickUpload(target, picked)
      const folder = target ? st.current.model.byPath.get(target) : undefined
      if (folder) setFolderOpen(folder.id, true)
    })
  }

  // -- presence ---------------------------------------------------------------------------------

  const presenceByFile = useMemo(() => {
    const map = new Map<string, PresenceUser[]>()
    for (const p of presence) {
      if (!p.openFileId) continue
      const list = map.get(p.openFileId) ?? []
      if (!list.some(u => u.id === p.user.id)) list.push(p.user)
      map.set(p.openFileId, list)
    }
    return map
  }, [presence])

  const presenceFor = (node: TreeNode, isExpanded: boolean): PresenceUser[] => {
    if (node.kind !== 'folder') return presenceByFile.get(node.id) ?? []
    if (isExpanded || presenceByFile.size === 0) return []
    const out: PresenceUser[] = []
    for (const [fileId, users] of presenceByFile) {
      const f = files[fileId]
      if (!f || !f.path.startsWith(node.path + '/')) continue
      for (const u of users) if (!out.some(x => x.id === u.id)) out.push(u)
    }
    return out
  }

  // -- render -----------------------------------------------------------------------------------

  const tabbableId = (focusId && model.byId.has(focusId) && rows.some(r => r.id === focusId) ? focusId : null)
    ?? rows.find(r => selection.has(r.id))?.id
    ?? rows.find(r => r.id === openFileId)?.id
    ?? rows[0]?.id
    ?? null
  const dropFolder = drop && drop.target ? drop.target : null
  const newTarget = targetFolder()

  let body: ReactNode
  if (loadState !== 'ready' && model.roots.length === 0) {
    body = (
      <div className="ft-loading" aria-busy="true">
        <Spinner size={16} label="Loading files" />
      </div>
    )
  } else if (model.roots.length === 0) {
    body = (
      <EmptyState
        size="sm"
        icon={FolderPlus}
        title="No files yet"
        className="ft-empty"
        actions={canEdit ? (
          <>
            <Button size="sm" variant="secondary" icon={FilePlus} onClick={() => openModal('newfile')}>New file</Button>
            <Button size="sm" variant="secondary" icon={Upload} onClick={() => openModal('upload')}>Upload</Button>
          </>
        ) : undefined}
      >
        {canEdit ? 'Create a file or drop files here to upload them.' : 'This project doesn’t contain any files.'}
      </EmptyState>
    )
  } else {
    body = (
      <div
        ref={treeRef}
        role="tree"
        aria-label="Project files"
        aria-multiselectable="true"
        className="ft-tree"
      >
        {rows.map(node => {
          const isExpanded = node.kind === 'folder' && expanded.has(node.id)
          return (
            <TreeRow
              key={node.id}
              node={node}
              expanded={isExpanded}
              selected={selection.has(node.id)}
              open={node.id === openFileId}
              tabbable={node.id === tabbableId}
              isRoot={node.id === rootFileId}
              renaming={renamingId === node.id}
              dragging={dragging.has(node.id)}
              canEdit={canEdit}
              presence={presenceFor(node, isExpanded)}
              drop={dropFolder === null ? null : node.path === dropFolder ? 'target' : node.path.startsWith(dropFolder + '/') ? 'inside' : null}
              onMenu={onMenuButton}
              onRenameDone={finishRename}
            />
          )
        })}
      </div>
    )
  }

  return (
    <section
      className={clsx('ft-panel', drop && drop.target === '' && 'is-drop-root', drop?.kind === 'upload' && 'is-drop-upload')}
      aria-label="File tree"
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onDragEnd={endDrag}
    >
      <header className="ft-header">
        <h2 className="ft-header__title">Files</h2>
        <div className="ft-header__tools" role="toolbar" aria-label="File tree actions">
          {canEdit && (
            <>
              <IconButton size="sm" icon={FilePlus} label="New file" tooltip={newTarget ? `New file in ${newTarget}/` : 'New file'} onClick={() => openModal('newfile', { folder: newTarget })} />
              <IconButton size="sm" icon={FolderPlus} label="New folder" tooltip={newTarget ? `New folder in ${newTarget}/` : 'New folder'} onClick={() => openModal('newfolder', { folder: newTarget })} />
              <IconButton size="sm" icon={Upload} label="Upload" tooltip={newTarget ? `Upload to ${newTarget}/` : 'Upload'} onClick={() => openModal('upload', { folder: newTarget })} />
            </>
          )}
          <IconButton size="sm" icon={ChevronsDownUp} label="Collapse all folders" disabled={expanded.size === 0} onClick={() => updateExpanded(() => new Set())} />
        </div>
      </header>
      <div
        ref={scrollRef}
        className="ft-scroll"
        onClick={onClick}
        onDoubleClick={onDoubleClick}
        onContextMenu={onContextMenu}
        onKeyDown={onKeyDown}
        onDragStart={onDragStart}
      >
        {body}
      </div>
      {drop?.kind === 'upload' && (
        <div className="ft-drophint" aria-hidden="true">
          <Upload size={14} />
          <span>Drop to upload to {drop.target ? <strong>{drop.target}/</strong> : <strong>the project root</strong>}</span>
        </div>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------------------------
// row
// ---------------------------------------------------------------------------------------------

interface TreeRowProps {
  node: TreeNode
  expanded: boolean
  selected: boolean
  open: boolean
  tabbable: boolean
  isRoot: boolean
  renaming: boolean
  dragging: boolean
  canEdit: boolean
  presence: PresenceUser[]
  drop: 'target' | 'inside' | null
  onMenu: (e: MouseEvent<HTMLButtonElement>, node: TreeNode) => void
  onRenameDone: (focusId: string | null) => void
}

/**
 * Rows re-render only when what they show changes: the tree model is rebuilt (new node objects)
 * whenever any FileEntry changes, e.g. every autosave updates a file's size.
 */
function sameRow(a: TreeRowProps, b: TreeRowProps): boolean {
  const x = a.node
  const y = b.node
  return x.id === y.id && x.path === y.path && x.name === y.name && x.kind === y.kind && x.depth === y.depth &&
    x.children.length === y.children.length && (x.entry === null) === (y.entry === null) &&
    (x.parent?.children.length ?? -1) === (y.parent?.children.length ?? -1) &&
    (x.parent ? x.parent.children.indexOf(x) : -1) === (y.parent ? y.parent.children.indexOf(y) : -1) &&
    a.expanded === b.expanded && a.selected === b.selected && a.open === b.open && a.tabbable === b.tabbable &&
    a.isRoot === b.isRoot && a.renaming === b.renaming && a.dragging === b.dragging && a.canEdit === b.canEdit &&
    a.drop === b.drop && a.onMenu === b.onMenu && a.onRenameDone === b.onRenameDone &&
    a.presence.length === b.presence.length && a.presence.every((u, i) => u.id === b.presence[i].id && u.color === b.presence[i].color && u.name === b.presence[i].name)
}

const TreeRow = memo(function TreeRow({
  node, expanded, selected, open, tabbable, isRoot, renaming, dragging, canEdit, presence, drop, onMenu, onRenameDone,
}: TreeRowProps) {
  const isFolder = node.kind === 'folder'
  const siblings = node.parent ? node.parent.children : null
  const guides = []
  for (let d = 0; d < node.depth; d++) guides.push(<span key={d} className="ft-row__guide" style={{ left: `calc(var(--ft-pad) + ${d} * var(--ft-indent) + var(--ft-indent) / 2)` }} />)
  return (
    <div
      role="treeitem"
      data-ft-row=""
      data-id={node.id}
      data-path={node.path}
      data-kind={node.kind}
      aria-level={node.depth + 1}
      aria-expanded={isFolder ? expanded : undefined}
      aria-selected={selected}
      aria-setsize={siblings?.length}
      aria-posinset={siblings ? siblings.indexOf(node) + 1 : undefined}
      aria-label={`${node.name}${isRoot ? ', main document' : ''}`}
      aria-current={open ? 'page' : undefined}
      tabIndex={tabbable ? 0 : -1}
      draggable={canEdit && !!node.entry && !renaming}
      className={clsx(
        'ft-row',
        selected && 'is-selected',
        open && 'is-open',
        isRoot && 'is-root',
        drop === 'target' && 'is-drop-target',
        drop === 'inside' && 'is-drop-inside',
        renaming && 'is-renaming',
        dragging && 'is-dragging',
      )}
      style={{ ['--ft-depth' as string]: node.depth }}
      title={renaming ? undefined : node.path}
    >
      {guides}
      <span className="ft-row__caret" aria-hidden="true">
        {isFolder && node.children.length > 0 && <ChevronRight size={14} className={clsx(expanded && 'is-expanded')} />}
      </span>
      <FileIcon path={node.path} kind={node.kind} open={expanded} className="ft-row__icon" />
      {renaming ? (
        <RenameInput node={node} onDone={onRenameDone} />
      ) : (
        <span className="ft-row__name">{node.name}</span>
      )}
      {!renaming && (
        <span className="ft-row__meta">
          {isRoot && (
            <Tooltip content="Main document — compiled by Recompile" side="right">
              <span className="ft-mainbadge" aria-hidden="true">main</span>
            </Tooltip>
          )}
          {presence.length > 0 && <PresenceDots users={presence} inFolder={isFolder} />}
          <button
            type="button"
            className="ft-row__menu"
            tabIndex={-1}
            aria-label={`Open ${node.name} action menu`}
            onClick={e => onMenu(e, node)}
            onDoubleClick={e => e.stopPropagation()}
          >
            <Ellipsis size={14} aria-hidden="true" />
          </button>
        </span>
      )}
    </div>
  )
}, sameRow)

function PresenceDots({ users, inFolder }: { users: PresenceUser[]; inFolder: boolean }) {
  const shown = users.slice(0, 3)
  const names = users.map(u => u.name).join(', ')
  return (
    <Tooltip content={`${names} ${inFolder ? (users.length === 1 ? 'is editing a file in this folder' : 'are editing files in this folder') : users.length === 1 ? 'has this file open' : 'have this file open'}`} side="right">
      <span className="ft-presence" role="img" aria-label={`Open by ${names}`}>
        {shown.map(u => (
          <span key={u.id} className="ft-presence__dot" style={{ background: u.color }} />
        ))}
        {users.length > shown.length && <span className="ft-presence__more">+{users.length - shown.length}</span>}
      </span>
    </Tooltip>
  )
}

// ---------------------------------------------------------------------------------------------
// inline rename
// ---------------------------------------------------------------------------------------------

function waitForPath(fileId: string, path: string, timeoutMs: number): Promise<void> {
  const ok = () => useProject.getState().files[fileId]?.path === path
  if (ok()) return Promise.resolve()
  return new Promise(resolve => {
    const done = () => {
      window.clearTimeout(timer)
      unsub()
      resolve()
    }
    const unsub = useProject.subscribe(() => {
      if (ok()) done()
    })
    const timer = window.setTimeout(done, timeoutMs)
  })
}

function RenameInput({ node, onDone }: { node: TreeNode; onDone: (focusId: string | null) => void }) {
  const [value, setValue] = useState(node.name)
  const [busy, setBusy] = useState(false)
  const [showError, setShowError] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const finished = useRef(false)
  const busyRef = useRef(false)
  const trimmed = value.trim()
  const error = validateRename(node, trimmed)

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus({ preventScroll: true })
    const dot = node.kind === 'folder' ? -1 : node.name.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : node.name.length)
  }, [node.kind, node.name])

  const commit = async (fromBlur: boolean) => {
    if (finished.current || busyRef.current) return
    if (trimmed === node.name || trimmed === '') {
      finished.current = true
      onDone(fromBlur ? null : node.id)
      return
    }
    if (error) {
      if (fromBlur) {
        finished.current = true
        onDone(null)
      } else {
        setShowError(true)
      }
      return
    }
    busyRef.current = true
    setBusy(true)
    const entry: FileEntry | null = node.entry
    const ok = await renameNode(node, trimmed)
    if (ok && entry) await waitForPath(entry.id, joinPath(dirname(node.path), trimmed), 3000)
    finished.current = true
    onDone(fromBlur ? null : node.id)
  }

  return (
    <span className="ft-rename">
      <input
        ref={inputRef}
        className={clsx('ft-rename__input', showError && error && 'is-invalid')}
        value={value}
        disabled={busy}
        spellCheck={false}
        autoComplete="off"
        aria-label={`New name for ${node.name}`}
        aria-invalid={showError && !!error}
        onChange={e => {
          setValue(e.target.value)
          setShowError(true)
        }}
        onKeyDown={e => {
          e.stopPropagation()
          if (e.key === 'Enter') {
            e.preventDefault()
            void commit(false)
          } else if (e.key === 'Escape') {
            e.preventDefault()
            finished.current = true
            onDone(node.id)
          }
        }}
        onBlur={() => void commit(true)}
        onClick={e => e.stopPropagation()}
        onDoubleClick={e => e.stopPropagation()}
        onDragStart={e => {
          e.preventDefault()
          e.stopPropagation()
        }}
      />
      {showError && error && trimmed !== node.name && (
        <span className="ft-rename__error" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}
