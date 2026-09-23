/**
 * Live facts about the document shown in the editor, published by SourceEditor for the
 * outline panel and the breadcrumb: the file outline (debounced, recomputed from the editor
 * text) and the connection state of its collaborative session.
 */
import { create } from 'zustand'
import type { OutlineItem } from '@folio/shared/latex'
import type { DocStatus } from '../../realtime/docs'

export interface ActiveDocState {
  /** file the data below belongs to (null when no text editor is mounted) */
  fileId: string | null
  /** sectioning commands of the file (LaTeX files only) */
  outline: OutlineItem[]
  /** true for LaTeX files (outline applies) */
  outlineSupported: boolean
  /** WebSocket state of the document session */
  status: DocStatus
  /** the session was closed for good (too large, access): the editor shows an error */
  closed: boolean
}

export const useActiveDoc = create<ActiveDocState>(() => ({
  fileId: null,
  outline: [],
  outlineSupported: false,
  status: 'connecting',
  closed: false,
}))

/** The innermost outline entries containing `line` (outermost first), e.g. [Results, Ablation]. */
export function sectionTrail(outline: OutlineItem[], line: number | null): OutlineItem[] {
  if (line === null || outline.length === 0) return []
  const trail: OutlineItem[] = []
  for (const item of outline) {
    if (item.line > line) break
    while (trail.length && trail[trail.length - 1].level >= item.level) trail.pop()
    trail.push(item)
  }
  return trail
}
