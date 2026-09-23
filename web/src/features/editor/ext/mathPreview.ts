/**
 * Equation preview (UserSettings.equationPreview): while the cursor is inside math — $…$,
 * $$…$$, \(…\), \[…\] or an equation/align-like environment — a tooltip above the formula
 * shows it typeset with KaTeX; hovering math shows the same preview when the cursor is
 * elsewhere. KaTeX (JS + CSS + fonts, all same-origin) is loaded on first use. Invalid or
 * incomplete input keeps the last good rendering (dimmed) and shows KaTeX's message.
 * Project macros (\newcommand, \DeclareMathOperator) are passed to KaTeX.
 */
import { StateEffect, StateField, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, hoverTooltip, keymap, showTooltip, type Tooltip, type TooltipView, type ViewUpdate } from '@codemirror/view'
import type { KatexOptions } from 'katex'
import { registerTestHook } from '../../../stores/testHooks'
import { projectIndex } from '../projectIndex'
import { findMathAt, mathForPreview, type MathRegion } from './latexScan'
import { docKindFacet } from './completion'

type Katex = typeof import('katex').default

let katex: Katex | null = null
let katexLoading: Promise<Katex | null> | null = null

function loadKatex(): Promise<Katex | null> {
  if (katex) return Promise.resolve(katex)
  katexLoading ??= Promise.all([import('katex'), import('katex/dist/katex.min.css')])
    .then(([mod]) => {
      katex = mod.default
      return katex
    })
    .catch(err => {
      console.warn('[mathPreview] KaTeX failed to load', err)
      katexLoading = null
      return null
    })
  return katexLoading
}

function katexOptions(display: boolean): KatexOptions {
  return {
    displayMode: display,
    throwOnError: true,
    strict: 'ignore',
    trust: false,
    maxSize: 25,
    maxExpand: 400,
    output: 'html',
    // KaTeX may add \gdef definitions to the object: always hand it a copy
    macros: { ...projectIndex.snapshot().macros },
  }
}

function errorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.replace(/^KaTeX parse error:\s*/, '').replace(/ at position \d+:.*$/s, '')
}

/** Renders math into a host element, keeping the last good output when the input is invalid. */
class MathRenderer {
  readonly dom: HTMLElement
  private readonly body: HTMLElement
  private readonly error: HTMLElement
  private src: string | null = null
  private display = false
  private good = false

  constructor(className: string) {
    this.dom = document.createElement('div')
    this.dom.className = className
    this.body = document.createElement('div')
    this.body.className = 'ed-mathpreview__body'
    this.error = document.createElement('div')
    this.error.className = 'ed-mathpreview__error'
    this.error.hidden = true
    this.dom.append(this.body, this.error)
  }

  /** Returns true when the DOM changed. */
  render(src: string, display: boolean, onAsync?: () => void): boolean {
    if (src === this.src && display === this.display) return false
    this.src = src
    this.display = display
    if (!katex) {
      if (!this.good) this.body.textContent = ''
      this.dom.classList.add('is-loading')
      void loadKatex().then(k => {
        if (!k || this.src !== src) return
        this.dom.classList.remove('is-loading')
        this.src = null
        this.render(src, display)
        onAsync?.()
      })
      return true
    }
    if (!src.trim()) {
      this.body.textContent = ''
      this.good = false
      this.error.hidden = false
      this.error.textContent = 'Empty formula'
      return true
    }
    try {
      const target = document.createElement('div')
      katex.render(src, target, katexOptions(display))
      this.body.replaceChildren(...target.childNodes)
      this.good = true
      this.error.hidden = true
      this.dom.classList.remove('is-stale')
    } catch (e) {
      this.error.hidden = false
      this.error.textContent = errorText(e)
      this.dom.classList.toggle('is-stale', this.good)
    }
    return true
  }
}

// -- cursor preview ------------------------------------------------------------------------------

const hidePreview = StateEffect.define<null>()
/** switch the placement of a multi-line preview to the cursor's line (its \end is off screen) */
const placeAtCursor = StateEffect.define<boolean>()

// The preview follows the cursor; it is hidden with CSS while the editor is not focused
// (.cm-editor:not(.cm-focused)) — CodeMirror's focusChangeEffect is skipped when a
// transaction lands right after focusing, so focus is not tracked in this state.
interface PreviewState {
  region: MathRegion | null
  /** region start the user dismissed (Esc / ×) */
  hiddenAt: number | null
  /** place below the cursor's line instead of below the environment (set by previewVisibility) */
  atCursor: boolean
  tooltip: Tooltip | null
}

function computeRegion(state: EditorState): MathRegion | null {
  if (state.facet(docKindFacet) !== 'latex') return null
  const sel = state.selection.main
  if (state.selection.ranges.length !== 1) return null
  const region = findMathAt(state.doc, sel.head)
  if (!region) return null
  if (!sel.empty && (sel.from < region.from || sel.to > region.to)) return null
  return region
}

/**
 * Where the preview goes. One-line math: above the formula (above the cursor's line when the
 * formula starts on an earlier line). Multi-line environments: below their `\end` line when it
 * is near the cursor (≤ 6 lines) and on screen, else below the cursor's line — never over the
 * lines being edited, and always anchored somewhere visible.
 */
function placement(state: EditorState, region: MathRegion, at = state.selection.main.head, atCursor = false): { pos: number; above: boolean } {
  const doc = state.doc
  const cur = doc.lineAt(at)
  const startLine = doc.lineAt(region.from)
  const endLine = doc.lineAt(region.to)
  if (startLine.number === endLine.number) return { pos: startLine.number === cur.number ? region.from : cur.from, above: true }
  if (!atCursor && endLine.number - cur.number <= 6) return { pos: endLine.from, above: false }
  // below the cursor's line; the view positions it under the cursor itself (getCoords), so the
  // tooltip object stays the same while typing on that line
  return { pos: cur.from, above: false }
}

/** Whether a position is on screen within the text area (hover previews). */
function isVisible(view: EditorView, pos: number): boolean {
  const box = view.scrollDOM.getBoundingClientRect()
  const c = view.coordsAtPos(pos)
  return !!c && c.top >= box.top && c.bottom <= box.bottom - 48
}

function makeTooltip(at: { pos: number; above: boolean }): Tooltip {
  return {
    pos: at.pos,
    above: at.above,
    arrow: false,
    create: view => new CursorPreviewView(view),
  }
}

const previewField = StateField.define<PreviewState>({
  create: state => {
    const region = computeRegion(state)
    return { region, hiddenAt: null, atCursor: false, tooltip: region ? makeTooltip(placement(state, region)) : null }
  },
  update(value, tr) {
    let hide = false
    let atCursor = value.atCursor
    for (const e of tr.effects) {
      if (e.is(hidePreview)) hide = true
      else if (e.is(placeAtCursor)) atCursor = e.value
    }
    if (!tr.docChanged && !tr.selection && !hide && atCursor === value.atCursor) return value
    let hiddenAt = value.hiddenAt !== null && tr.docChanged ? tr.changes.mapPos(value.hiddenAt) : value.hiddenAt
    const region = computeRegion(tr.state)
    // a dismissal lasts until the cursor leaves that formula
    if (hide && region) hiddenAt = region.from
    else if (!region || region.from !== hiddenAt) hiddenAt = null
    const visible = region && region.from !== hiddenAt ? region : null
    // another formula: start again with the preferred placement
    if (!visible || !value.region || visible.from !== (tr.docChanged ? tr.changes.mapPos(value.region.from) : value.region.from)) {
      if (atCursor === value.atCursor) atCursor = false
    }
    let tooltip: Tooltip | null = null
    if (visible) {
      const at = placement(tr.state, visible, tr.state.selection.main.head, atCursor)
      const prev = value.tooltip
      tooltip = prev && value.region && prev.pos === at.pos && !!prev.above === at.above ? prev : makeTooltip(at)
    }
    return { region: visible, hiddenAt, atCursor, tooltip }
  },
  provide: f => showTooltip.from(f, v => v.tooltip),
})

/**
 * When the preferred anchor (below an environment's \end) is off screen or at the very bottom,
 * re-anchor at the cursor. Decided from measured coordinates, so it cannot oscillate.
 */
const previewVisibility = ViewPlugin.fromClass(class {
  private pending = false
  private readonly onScroll = () => this.check()
  constructor(readonly view: EditorView) {
    view.scrollDOM.addEventListener('scroll', this.onScroll, { passive: true })
  }
  destroy(): void {
    this.view.scrollDOM.removeEventListener('scroll', this.onScroll)
  }
  update(u: ViewUpdate): void {
    if (!u.docChanged && !u.selectionSet && !u.viewportChanged && !u.geometryChanged && u.startState.field(previewField, false) === u.state.field(previewField, false)) return
    this.check()
  }
  private check(): void {
    const st = this.view.state.field(previewField, false)
    if (!st?.tooltip || !st.region || this.pending) return
    const doc = this.view.state.doc
    const endLine = doc.lineAt(st.region.to)
    if (doc.lineAt(st.region.from).number === endLine.number) return
    this.pending = true
    this.view.requestMeasure({
      key: this,
      read: view => {
        const box = view.scrollDOM.getBoundingClientRect()
        const c = view.coordsAtPos(endLine.from)
        // keep room for a preview below the \end line
        return !c || c.top < box.top || c.bottom > box.bottom - 48
      },
      write: wantCursor => {
        this.pending = false
        const cur = this.view.state.field(previewField, false)
        if (!cur?.region || wantCursor === cur.atCursor) return
        queueMicrotask(() => {
          if (this.view.dom.isConnected) this.view.dispatch({ effects: placeAtCursor.of(wantCursor) })
        })
      },
    })
  }
})

class CursorPreviewView implements TooltipView {
  readonly dom: HTMLElement
  private readonly renderer = new MathRenderer('ed-mathpreview__render')

  constructor(private readonly view: EditorView) {
    this.dom = document.createElement('div')
    this.dom.className = 'ed-mathpreview'
    // keep the editor focused (the preview follows the cursor)
    this.dom.addEventListener('mousedown', e => e.preventDefault())
    const head = document.createElement('div')
    head.className = 'ed-mathpreview__head'
    const label = document.createElement('span')
    label.textContent = 'Equation preview'
    const close = document.createElement('button')
    close.type = 'button'
    close.className = 'ed-mathpreview__close'
    close.setAttribute('aria-label', 'Hide equation preview')
    close.title = 'Hide (Esc)'
    close.textContent = '×'
    close.addEventListener('mousedown', e => e.preventDefault())
    close.addEventListener('click', () => this.view.dispatch({ effects: hidePreview.of(null) }))
    head.append(label, close)
    this.dom.append(head, this.renderer.dom)
    this.refresh()
  }

  update(_update: ViewUpdate): void {
    this.refresh()
  }

  /** Below-the-cursor placement follows the cursor within its (possibly wrapped) line. */
  getCoords(pos: number) {
    const st = this.view.state.field(previewField, false)
    const head = this.view.state.selection.main.head
    const at = st?.atCursor && this.view.state.doc.lineAt(head).from === pos ? head : pos
    const c = this.view.coordsAtPos(at)
    return c ?? { left: 0, right: 0, top: -1e4, bottom: -1e4 }
  }

  private refresh(): void {
    const region = this.view.state.field(previewField).region
    if (!region) return
    this.renderer.render(mathForPreview(region), region.display, () => this.view.requestMeasure())
  }
}

// -- hover preview -------------------------------------------------------------------------------

const hoverPreview = hoverTooltip(
  (view, pos) => {
    if (view.state.facet(docKindFacet) !== 'latex') return null
    const region = findMathAt(view.state.doc, pos)
    if (!region) return null
    const shown = view.state.field(previewField, false)?.region
    if (shown && shown.from === region.from && view.hasFocus) return null
    let at = placement(view.state, region, pos)
    if (!at.above && !isVisible(view, at.pos)) at = placement(view.state, region, pos, true)
    return {
      pos: at.pos,
      end: region.to,
      above: at.above,
      arrow: false,
      create: v => {
        const renderer = new MathRenderer('ed-mathpreview__render')
        const dom = document.createElement('div')
        dom.className = 'ed-mathpreview ed-mathpreview--hover'
        dom.appendChild(renderer.dom)
        renderer.render(mathForPreview(region), region.display, () => v.requestMeasure())
        return { dom }
      },
    }
  },
  { hoverTime: 350 },
)

export function mathPreview(): Extension {
  return [
    previewField,
    previewVisibility,
    hoverPreview,
    keymap.of([
      {
        key: 'Escape',
        run: view => {
          const st = view.state.field(previewField, false)
          if (!st?.region) return false
          view.dispatch({ effects: hidePreview.of(null) })
          return true
        },
      },
    ]),
  ]
}

/** Warm the KaTeX chunk (called when the preview is enabled). */
export function preloadMathPreview(): void {
  void loadKatex()
}

registerTestHook('mathPreviewState', (view: EditorView) => view.state.field(previewField, false) ?? null)
