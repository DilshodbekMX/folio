/**
 * File outline (SPEC §6.7): the sectioning commands of the open LaTeX file as a collapsible
 * tree, updated live while typing (the editor publishes the outline, debounced). Clicking an
 * entry jumps to it; the section containing the cursor is highlighted (or its nearest visible
 * ancestor when collapsed). Its header row (--panel-header-h) toggles useLayout.outlineOpen;
 * EditorLayout collapses the panel to exactly that header when closed.
 *
 * Keyboard (tree pattern): ↑/↓ move, → expands / enters, ← collapses / goes to the parent,
 * Home/End, Enter or Space jumps to the section.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import { ChevronRight, ListTree } from 'lucide-react'
import type { OutlineItem } from '@folio/shared/latex'
import { useEditor } from '../../stores/editor'
import { useLayout } from '../../stores/layout'
import { useProject } from '../../stores/project'
import { useActiveDoc } from '../editor/activeDoc'
import './outline.css'

interface TreeNode {
  item: OutlineItem
  key: string
  depth: number
  parent: TreeNode | null
  children: TreeNode[]
}

function buildTree(items: OutlineItem[]): { roots: TreeNode[]; all: TreeNode[] } {
  const roots: TreeNode[] = []
  const all: TreeNode[] = []
  const stack: TreeNode[] = []
  const seen = new Map<string, number>()
  for (const item of items) {
    const base = `${item.level}:${item.title}`
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    while (stack.length && stack[stack.length - 1].item.level >= item.level) stack.pop()
    const parent = stack[stack.length - 1] ?? null
    const node: TreeNode = { item, key: `${base}#${n}`, depth: stack.length, parent, children: [] }
    if (parent) parent.children.push(node)
    else roots.push(node)
    stack.push(node)
    all.push(node)
  }
  return { roots, all }
}

function visibleRows(roots: TreeNode[], collapsed: Set<string>): TreeNode[] {
  const out: TreeNode[] = []
  const walk = (nodes: TreeNode[]) => {
    for (const n of nodes) {
      out.push(n)
      if (n.children.length && !collapsed.has(n.key)) walk(n.children)
    }
  }
  walk(roots)
  return out
}

/** Collapsed sections per file, kept while the page is open. */
const collapsedByFile = new Map<string, Set<string>>()

export function OutlinePanel() {
  const open = useLayout(s => s.outlineOpen)
  const setOpen = useLayout(s => s.setOutlineOpen)
  const openFileId = useEditor(s => s.openFileId)
  const file = useProject(s => (openFileId ? s.files[openFileId] : undefined))

  return (
    <div className={clsx('ed-outline', open && 'is-open')}>
      <button
        type="button"
        className="ed-outline__header"
        aria-expanded={open}
        aria-controls="ed-outline-body"
        onClick={() => setOpen(!open)}
      >
        <ChevronRight size={14} className="ed-outline__caret" aria-hidden="true" />
        <span className="ed-outline__title">File outline</span>
      </button>
      <div id="ed-outline-body" className="ed-outline__body" hidden={!open}>
        {open && <OutlineBody fileId={file?.kind === 'text' ? file.id : null} isBinary={file?.kind === 'binary'} />}
      </div>
    </div>
  )
}

function OutlineBody({ fileId, isBinary }: { fileId: string | null; isBinary: boolean }) {
  const docFileId = useActiveDoc(s => s.fileId)
  const outline = useActiveDoc(s => s.outline)
  const supported = useActiveDoc(s => s.outlineSupported)
  const cursorLine = useEditor(s => (fileId && s.cursor?.fileId === fileId ? s.cursor.line : null))

  if (!fileId) {
    return <p className="ed-outline__empty">{isBinary ? 'No outline for this file.' : 'Open a LaTeX file to see its sections.'}</p>
  }
  if (docFileId !== fileId) return <p className="ed-outline__empty">Loading…</p>
  if (!supported) return <p className="ed-outline__empty">No outline for this file type.</p>
  if (outline.length === 0) {
    return (
      <div className="ed-outline__none">
        <ListTree size={18} aria-hidden="true" />
        <p>We can’t find any sections or subsections in this file.</p>
      </div>
    )
  }
  return <OutlineTree fileId={fileId} outline={outline} cursorLine={cursorLine} />
}

function OutlineTree({ fileId, outline, cursorLine }: { fileId: string; outline: OutlineItem[]; cursorLine: number | null }) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => collapsedByFile.get(fileId) ?? new Set())
  const [focusKey, setFocusKey] = useState<string | null>(null)
  const rowRefs = useRef(new Map<string, HTMLDivElement>())
  const listRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    setCollapsed(collapsedByFile.get(fileId) ?? new Set())
  }, [fileId])

  const { roots, all } = useMemo(() => buildTree(outline), [outline])
  const rows = useMemo(() => visibleRows(roots, collapsed), [roots, collapsed])

  // the section containing the cursor, or its nearest visible ancestor
  const activeKey = useMemo(() => {
    if (cursorLine === null) return null
    let hit: TreeNode | null = null
    for (const n of all) {
      if (n.item.line > cursorLine) break
      hit = n
    }
    for (let n = hit; n; n = n.parent) {
      let hidden = false
      for (let p = n.parent; p; p = p.parent) if (collapsed.has(p.key)) hidden = true
      if (!hidden) return n.key
    }
    return null
  }, [all, cursorLine, collapsed])

  useEffect(() => {
    if (!activeKey) return
    const el = rowRefs.current.get(activeKey)
    const list = listRef.current
    if (!el || !list || list.contains(document.activeElement)) return
    el.scrollIntoView({ block: 'nearest' })
  }, [activeKey])

  const toggle = (key: string, force?: boolean) => {
    setCollapsed(prev => {
      const next = new Set(prev)
      const collapse = force ?? !next.has(key)
      if (collapse) next.add(key)
      else next.delete(key)
      collapsedByFile.set(fileId, next)
      return next
    })
  }

  const jump = (node: TreeNode) => {
    useEditor.getState().jumpTo({ fileId, line: node.item.line })
  }

  const tabKey = focusKey && rows.some(r => r.key === focusKey) ? focusKey : activeKey && rows.some(r => r.key === activeKey) ? activeKey : rows[0]?.key

  const focusRow = (key: string | undefined) => {
    if (!key) return
    setFocusKey(key)
    rowRefs.current.get(key)?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = rows.findIndex(r => r.key === (document.activeElement as HTMLElement | null)?.dataset.key)
    if (i === -1) return
    const node = rows[i]
    switch (e.key) {
      case 'ArrowDown':
        focusRow(rows[Math.min(rows.length - 1, i + 1)].key)
        break
      case 'ArrowUp':
        focusRow(rows[Math.max(0, i - 1)].key)
        break
      case 'Home':
        focusRow(rows[0].key)
        break
      case 'End':
        focusRow(rows[rows.length - 1].key)
        break
      case 'ArrowRight':
        if (node.children.length && collapsed.has(node.key)) toggle(node.key, false)
        else if (node.children.length) focusRow(node.children[0].key)
        else return
        break
      case 'ArrowLeft':
        if (node.children.length && !collapsed.has(node.key)) toggle(node.key, true)
        else if (node.parent) focusRow(node.parent.key)
        else return
        break
      case 'Enter':
      case ' ':
        jump(node)
        break
      default:
        return
    }
    e.preventDefault()
  }

  return (
    <div ref={listRef} className="ed-outline__tree" role="tree" aria-label="File outline" onKeyDown={onKeyDown}>
      {rows.map(node => {
        const hasChildren = node.children.length > 0
        const isCollapsed = collapsed.has(node.key)
        const active = node.key === activeKey
        return (
          <div
            key={node.key}
            ref={el => {
              if (el) rowRefs.current.set(node.key, el)
              else rowRefs.current.delete(node.key)
            }}
            data-key={node.key}
            role="treeitem"
            aria-level={node.depth + 1}
            aria-expanded={hasChildren ? !isCollapsed : undefined}
            aria-selected={active}
            tabIndex={node.key === tabKey ? 0 : -1}
            className={clsx('ed-outline__row', active && 'is-active', `ed-outline__row--l${Math.max(-1, Math.min(5, node.item.level))}`)}
            style={{ paddingLeft: 6 + node.depth * 14 }}
            title={`${node.item.title} — line ${node.item.line}`}
            onFocus={() => setFocusKey(node.key)}
            onClick={() => jump(node)}
          >
            {hasChildren ? (
              <span
                className={clsx('ed-outline__toggle', !isCollapsed && 'is-open')}
                aria-hidden="true"
                onClick={e => {
                  e.stopPropagation()
                  toggle(node.key)
                }}
              >
                <ChevronRight size={13} />
              </span>
            ) : (
              <span className="ed-outline__toggle ed-outline__toggle--leaf" aria-hidden="true" />
            )}
            <span className="ed-outline__label">{node.item.title || `\\${node.item.command}`}</span>
          </div>
        )
      })}
    </div>
  )
}
