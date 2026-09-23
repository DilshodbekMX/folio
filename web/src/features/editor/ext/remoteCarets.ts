/**
 * Collaborators' name labels (y-codemirror.next draws them above each remote caret).
 *
 * - Shown only while it matters (J-5): for ACTIVE_MS after the collaborator's caret moves
 *   (they type or click) and while the pointer is over the caret; then the label fades out and
 *   the coloured caret stays. A label that stayed on screen covered the words of the line above
 *   a caret for as long as a co-author sat there. Carets get `ed-ycaret-active` while shown
 *   (theme.ts has the opacity rules).
 * - Readable on the first line (PAR-12): the label of a caret that close to the top of the
 *   document would be cut off under the editor toolbar, so it gets `ed-ycaret-below` and sits
 *   under the caret instead.
 *
 * The caret widgets carry no client id, so carets are matched to awareness states by the
 * collaborator's name and colour (two tabs of one person share both, and show together).
 */
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { ySyncFacet } from 'y-codemirror.next'
import type { Awareness } from 'y-protocols/awareness'

const BELOW = 'ed-ycaret-below'
const ACTIVE = 'ed-ycaret-active'
/** how long a label stays after the caret last moved */
export const ACTIVE_MS = 2000

interface AwarenessChange { added: number[]; updated: number[]; removed: number[] }

/** The browser's normal form of a CSS colour (inline styles read back as rgb(…)). */
function cssColor(c: string): string {
  const probe = document.createElement('span')
  probe.style.color = c
  return probe.style.color || c
}

function userKey(name: string, color: string): string {
  return `${cssColor(color)}|${name}`
}

export const remoteCaretLabels = ViewPlugin.fromClass(class {
  /** caret key → time until which its label is shown */
  private readonly activeUntil = new Map<string, number>()
  /** last cursor seen per remote client (a 'change' also fires for other fields, e.g. the name) */
  private readonly lastCursor = new Map<number, string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private readonly awareness: Awareness | null
  private readonly onChange = (change: AwarenessChange) => this.awarenessChanged(change)

  constructor(readonly view: EditorView) {
    this.awareness = (view.state.facet(ySyncFacet)?.awareness as Awareness | undefined) ?? null
    this.awareness?.on('change', this.onChange)
    this.schedule()
  }

  update(update: ViewUpdate): void {
    // awareness changes arrive as (empty) transactions from y-codemirror's remote-selection plugin
    if (update.transactions.length > 0 || update.geometryChanged || update.viewportChanged) this.schedule()
  }

  destroy(): void {
    this.awareness?.off('change', this.onChange)
    if (this.timer !== null) clearTimeout(this.timer)
  }

  private awarenessChanged({ added, updated, removed }: AwarenessChange): void {
    const awareness = this.awareness
    if (!awareness) return
    const now = Date.now()
    let moved = false
    for (const id of [...added, ...updated]) {
      if (id === awareness.clientID) continue
      const state = awareness.getStates().get(id) as { cursor?: unknown; user?: { name?: unknown; color?: unknown } } | undefined
      const cursor = state?.cursor == null ? null : JSON.stringify(state.cursor)
      if (cursor === null) {
        this.lastCursor.delete(id)
        continue
      }
      if (this.lastCursor.get(id) === cursor) continue
      this.lastCursor.set(id, cursor)
      // the same defaults as y-codemirror.next's caret widget
      const name = typeof state?.user?.name === 'string' ? state.user.name : 'Anonymous'
      const color = typeof state?.user?.color === 'string' ? state.user.color : '#30bced'
      this.activeUntil.set(userKey(name, color), now + ACTIVE_MS)
      moved = true
    }
    for (const id of removed) this.lastCursor.delete(id)
    if (moved) this.schedule()
  }

  /** Re-check once the next label is due to fade out. */
  private scheduleExpiry(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    const now = Date.now()
    let next = Infinity
    for (const [key, until] of this.activeUntil) {
      if (until <= now) this.activeUntil.delete(key)
      else next = Math.min(next, until)
    }
    if (next === Infinity) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.schedule()
    }, next - now + 20)
  }

  schedule(): void {
    this.scheduleExpiry()
    this.view.requestMeasure({
      key: this,
      read: view => {
        const carets = Array.from(view.contentDOM.querySelectorAll<HTMLElement>('.cm-ySelectionCaret'))
        if (carets.length === 0) return []
        // top of the document area (independent of the scroll position)
        const docTop = view.scrollDOM.getBoundingClientRect().top - view.scrollDOM.scrollTop
        const now = Date.now()
        return carets.map(caret => {
          const label = caret.querySelector<HTMLElement>('.cm-ySelectionInfo')
          const need = (label?.offsetHeight ?? 16) + 2
          const key = `${caret.style.backgroundColor}|${label?.textContent ?? ''}`
          return { caret, below: caret.getBoundingClientRect().top - docTop < need, active: (this.activeUntil.get(key) ?? 0) > now }
        })
      },
      write: list => {
        for (const { caret, below, active } of list) {
          caret.classList.toggle(BELOW, below)
          caret.classList.toggle(ACTIVE, active)
        }
      },
    })
  }
})
