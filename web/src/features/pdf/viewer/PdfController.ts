/**
 * pdf.js viewer controller (pdfjs-dist 6.3.289): PDFViewer + EventBus + PDFLinkService, with
 * double buffering so a recompile never flashes an empty page.
 *
 *   host (position: relative, owned by React)
 *     .pdf-slot.is-front   — scroll container of the visible PDFViewer (position: absolute)
 *     .pdf-slot.is-back    — a second PDFViewer, laid out but hidden (visibility: hidden)
 *
 * load(url) of a new build renders into the back slot: once its pages exist ('pagesinit') it
 * gets the front's zoom and top-of-viewport position (PDF point, XYZ destination), the pages in
 * view are rendered, the position is re-synced (the user may have scrolled meanwhile) and the
 * slots swap. The old document is released afterwards. The very first document loads straight
 * into the front slot with the remembered zoom/position.
 *
 * Hidden panes: the PDF panel collapses to width 0 in "editor only" layout. While the host is too
 * small to lay pages out, zoom presets are not re-applied (a fit-width scale for 0 px is
 * nonsense); the last position reported by pdf.js ('updateviewarea') is kept and restored, with
 * the preset re-applied, as soon as the host is usable again.
 *
 * Coordinates: SyncTeX/API points are PDF points from the page's top-left corner (y down):
 *   viewport point = viewport.convertToViewportPoint(viewBox[0] + x, viewBox[3] - y)
 *   PDF point      = [xp, yp] = viewport.convertToPdfPoint(cx, cy); x = xp - viewBox[0]; y = viewBox[3] - yp
 * (verified against the synctex CLI in docs/research/pdf-synctex.md).
 */
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist'
import type { PdfRect } from '@folio/shared/api'
import { DOCUMENT_ASSET_OPTIONS, pdfjsLib } from './pdfjs'
import { EventBus, LinkTarget, PDFLinkService, PDFViewer, RenderingStates } from 'pdfjs-dist/web/pdf_viewer.mjs'
import 'pdfjs-dist/web/pdf_viewer.css'
import type { PdfViewState } from './store'

/** A point on a page in PDF points, origin at the page's top-left corner, y down. */
export interface PdfPoint { page: number; x: number; y: number }

/** Top-left of the viewport as a PDF-space point (pdf.js user space, origin bottom-left). */
export interface ViewPosition { page: number; left: number; top: number }

export interface PdfDoubleClick extends PdfPoint {
  /** the word the double-click selected in the text layer ('' when none) */
  word: string
  /** text of the clicked text-layer run before the selected word (disambiguates repeated words) */
  before: string
}

export interface PdfControllerEvents {
  /** viewer state changes (page, zoom, loaded build, status) */
  onView(patch: Partial<PdfViewState>): void
  onDoubleClick(p: PdfDoubleClick): void
  /** the user changed the zoom (buttons, keyboard, Ctrl+wheel) */
  onUserZoom(scaleValue: string): void
  /** the top-left of the viewport moved (throttled by pdf.js' own update cycle); `docKey` as in load() */
  onPosition?(pos: ViewPosition, docKey: string | null): void
}

export interface PdfControllerOptions {
  /** zoom for the first document */
  initialScaleValue: string
  /** remembered position of a document (see load()'s docKey), e.g. from localStorage */
  positionFor?(docKey: string | null): ViewPosition | null
}

type ViewerOptions = ConstructorParameters<typeof PDFViewer>[0]

interface PageView {
  id: number
  div: HTMLDivElement
  viewport: {
    viewBox: number[]
    convertToViewportPoint(x: number, y: number): number[]
    convertToPdfPoint(x: number, y: number): number[]
  }
  renderingState: number
}

interface Slot {
  el: HTMLDivElement
  viewerEl: HTMLDivElement
  eventBus: EventBus
  linkService: PDFLinkService
  viewer: PDFViewer
  ac: AbortController
  task: PDFDocumentLoadingTask | null
  doc: PDFDocumentProxy | null
  buildId: string | null
  /** which document the PDF is of (load()'s docKey) */
  docKey: string | null
  /** the slot's zoom/position was applied: until then pdf.js reports its default spot (page 1) */
  placed: boolean
  /** bumped whenever the slot's document changes; pending waits compare it */
  gen: number
  /** called (and cleared) on reset so pending waits resolve */
  cancels: Set<() => void>
  /** pdf.js may still be fetching pages to initialise the viewer (viewer.pagesPromise pending) */
  pagesPending: boolean
}

/** zoom + position to apply; `top`: no position — start at the top of page 1 */
interface PendingView { scaleValue: string; position: ViewPosition | null; top?: boolean }

interface Highlight { el: HTMLDivElement; rect: PdfRect }

const MIN_USABLE_PX = 80
const PAGESINIT_TIMEOUT_MS = 30_000
const RENDER_WAIT_MS = 2_500
const HIGHLIGHT_MS = 3_000
/** upper bound for keeping a discarded document alive while pdf.js initialises its pages */
const LAZY_TEARDOWN_MS = 10_000
const PRESETS = new Set(['page-width', 'page-fit', 'page-height', 'auto', 'page-actual'])

function isPresetValue(v: string): boolean {
  return PRESETS.has(v)
}

/** Human-readable message for a pdf.js load failure. */
export function pdfErrorMessage(e: unknown): string {
  const name = typeof e === 'object' && e !== null ? (e as { name?: unknown }).name : undefined
  if (name === 'InvalidPDFException') return 'The PDF file is damaged or incomplete.'
  if (name === 'ResponseException' || name === 'MissingPDFException') {
    const status = (e as { status?: unknown }).status
    if (status === 404) return 'This PDF is no longer available on the server. Recompile to create a new one.'
    return 'The PDF could not be downloaded.'
  }
  if (name === 'PasswordException') return 'The PDF is password protected.'
  if (e instanceof Error && e.message) return `The PDF could not be displayed: ${e.message}`
  return 'The PDF could not be displayed.'
}

export class PdfController {
  private readonly host: HTMLElement
  private readonly events: PdfControllerEvents
  private readonly slots: [Slot, Slot]
  private frontIndex = 0
  private seq = 0
  private destroyed = false
  private initialScaleValue: string
  private readonly positionFor: (docKey: string | null) => ViewPosition | null
  /** where the PDF removed by clear() was: the next PDF of that document opens there */
  private cleared: { docKey: string | null; position: ViewPosition | null } | null = null
  /** zoom/position to apply to the front slot once the host is large enough */
  private pendingView: PendingView | null = null
  /** last top-left position reported by the front viewer while it was usable */
  private lastPos: ViewPosition | null = null
  /** the front slot got its zoom/position (false until the first document is laid out) */
  private viewReady = false
  private wasUsable = true
  private highlights: Highlight[] = []
  private highlightTimer: ReturnType<typeof setTimeout> | null = null
  private relayoutFrame = 0
  private resizeFrame = 0
  private wheelFactor = 1
  private wheelOrigin: [number, number] | null = null
  private wheelFrame = 0
  private resizePending = false
  /** the last pointer press was inside the PDF pane */
  private pointerInPane = false
  private usableWaiters: (() => void)[] = []
  private readonly ro: ResizeObserver
  private dprQuery: MediaQueryList | null = null
  private readonly ac = new AbortController()

  constructor(host: HTMLElement, events: PdfControllerEvents, opts: PdfControllerOptions) {
    this.host = host
    this.events = events
    this.initialScaleValue = opts.initialScaleValue
    this.positionFor = opts.positionFor ?? (() => null)
    this.slots = [this.createSlot(), this.createSlot()]
    this.setRole(this.slots[0], true)
    this.setRole(this.slots[1], false)

    this.ro = new ResizeObserver(() => {
      this.resizePending = true
      cancelAnimationFrame(this.resizeFrame)
      // rAF: avoids "ResizeObserver loop" errors when re-fitting changes the layout
      this.resizeFrame = requestAnimationFrame(() => this.onResize())
    })
    this.ro.observe(host)
    this.watchDevicePixelRatio()

    const signal = this.ac.signal
    host.addEventListener('dblclick', this.onDoubleClick, { signal })
    host.addEventListener('wheel', this.onWheel, { passive: false, signal })
    // keyboard zoom: on the document, because the focused text layer is replaced when the pages
    // re-render at the new scale (focus then falls back to <body>)
    document.addEventListener('keydown', this.onKeyDown, { signal })
    document.addEventListener('pointerdown', this.onPointerDown, { capture: true, signal })
  }

  // -- public API ---------------------------------------------------------------------------------

  private get front(): Slot {
    return this.slots[this.frontIndex]
  }

  private get back(): Slot {
    return this.slots[1 - this.frontIndex]
  }

  /** Build of the PDF on screen. */
  get buildId(): string | null {
    return this.front.buildId
  }

  get hasDocument(): boolean {
    return this.front.doc !== null
  }

  /** The scroll container of the visible PDF (focus target). */
  get scrollElement(): HTMLDivElement {
    return this.front.el
  }

  /**
   * Show the PDF at `url` (a new build). A new build of the same document (`docKey`: which root
   * document it is of) keeps zoom and scroll position of the current PDF; a PDF of another
   * document (the supplement after the paper) keeps the zoom and opens where that document was
   * last read (positionFor), or at the top of page 1.
   * Resolves true when this PDF is on screen, false when a newer load superseded it; rejects
   * when the PDF cannot be loaded.
   */
  async load(url: string, buildId: string, docKey: string | null = null): Promise<boolean> {
    if (this.destroyed) return false
    const seq = ++this.seq
    if (!this.front.doc) this.emit({ status: 'loading', error: null })
    const task = pdfjsLib.getDocument({ url, ...DOCUMENT_ASSET_OPTIONS })
    let doc: PDFDocumentProxy
    try {
      doc = await task.promise
    } catch (e) {
      void task.destroy()
      if (seq !== this.seq || this.destroyed) return false
      const error = pdfErrorMessage(e)
      this.emit(this.front.doc ? { error } : { status: 'error', error })
      throw e
    }
    if (seq !== this.seq || this.destroyed) {
      void task.destroy()
      return false
    }

    const front = this.front
    if (!front.doc) {
      const ok = await this.attach(front, doc, task, buildId, docKey)
      if (seq !== this.seq || this.destroyed) return false
      if (!ok) return this.failInit(seq)
      this.applyView(front, this.takeInitialView(docKey))
      this.emitFront({ status: 'ready', error: null })
      return true
    }

    const back = this.back
    const ok = await this.attach(back, doc, task, buildId, docKey)
    if (seq !== this.seq || this.destroyed) return false
    if (!ok) return this.failInit(seq)
    const gen = back.gen
    if (this.usable()) {
      this.applyView(back, this.viewFor(docKey))
      await this.waitVisibleRendered(back, gen)
      if (seq !== this.seq || this.destroyed || back.gen !== gen) return false
      // the user may have scrolled the old PDF while the new one rendered
      const view = this.viewFor(docKey)
      if (!this.usable()) this.pendingView = view
      else if (view.position && docKey === this.front.docKey) this.scrollToPosition(back, view.position)
    } else {
      // collapsed pane: lay the new PDF out once the pane is visible again
      this.pendingView = this.viewFor(docKey)
    }
    this.swap()
    return true
  }

  /** Remove the PDF (e.g. after "Clear cached files"). */
  clear(): void {
    this.seq++
    // the next PDF (e.g. after "Clear cached files" + recompile) opens where this one was
    if (this.viewReady) {
      const view = this.currentView()
      this.initialScaleValue = view.scaleValue
      this.cleared = { docKey: this.front.docKey, position: view.position ?? this.lastPos }
    }
    this.clearHighlights()
    this.resetSlot(this.slots[0])
    this.resetSlot(this.slots[1])
    this.pendingView = null
    this.lastPos = null
    this.viewReady = false
    this.emit({ status: 'empty', buildId: null, page: 0, pages: 0, error: null })
  }

  setScaleValue(value: string): void {
    const f = this.front
    if (!f.doc) {
      this.initialScaleValue = value
      return
    }
    if (!this.usable()) {
      this.pendingView = { scaleValue: value, position: this.pendingView?.position ?? this.lastPos }
      this.emit({ scaleValue: value })
    } else {
      f.viewer.currentScaleValue = value
    }
    this.events.onUserZoom(value)
  }

  zoomIn(): void {
    this.stepZoom(1)
  }

  zoomOut(): void {
    this.stepZoom(-1)
  }

  goToPage(n: number): void {
    const f = this.front
    if (!f.doc) return
    const page = Math.min(Math.max(1, Math.round(n)), f.viewer.pagesCount)
    f.viewer.currentPageNumber = page
  }

  focus(): void {
    this.front.el.focus({ preventScroll: true })
  }

  /**
   * Resolves once the pane is large enough and any deferred zoom/position has been applied
   * (e.g. right after switching from "editor only" back to a layout that shows the PDF).
   */
  whenUsable(timeoutMs = 1500): Promise<boolean> {
    if (this.usable() && !this.resizePending && !this.pendingView) return Promise.resolve(true)
    return new Promise(resolve => {
      const done = () => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        this.usableWaiters = this.usableWaiters.filter(w => w !== done)
        resolve(this.usable())
      }, timeoutMs)
      this.usableWaiters.push(done)
    })
  }

  /**
   * Draw fading highlight boxes (SyncTeX code→PDF) and scroll the first one into the middle of
   * the viewport. Returns the number of boxes drawn.
   */
  highlight(rects: PdfRect[]): number {
    this.clearHighlights()
    const f = this.front
    if (!f.doc || rects.length === 0) return 0
    const drawn: Highlight[] = []
    for (const rect of rects) {
      if (rect.page < 1 || rect.page > f.viewer.pagesCount) continue
      const el = document.createElement('div')
      el.className = 'pdf-highlight'
      el.setAttribute('aria-hidden', 'true')
      // overlays live in .pdfViewer: PDFPageView.reset() drops foreign children of page divs
      f.viewerEl.append(el)
      const h = { el, rect }
      this.placeHighlight(f, h)
      drawn.push(h)
    }
    this.highlights = drawn
    const first = drawn[0]
    if (first) {
      const box = this.rectToContainer(f, first.rect)
      if (box) {
        const c = f.el
        const top = box.top + box.height / 2 - c.clientHeight / 2
        const next: ScrollToOptions = { top: Math.max(0, top), behavior: 'instant' as ScrollBehavior }
        if (box.left < c.scrollLeft || box.left + Math.min(box.width, c.clientWidth) > c.scrollLeft + c.clientWidth) {
          next.left = Math.max(0, box.left - 24)
        }
        c.scrollTo(next)
      }
      this.highlightTimer = setTimeout(() => this.clearHighlights(), HIGHLIGHT_MS)
    }
    return drawn.length
  }

  /** The point in the middle of the most visible page area (for "Go to PDF location in code"). */
  visibleCenter(): PdfPoint | null {
    const f = this.front
    if (!f.doc || !this.usable()) return null
    const c = f.el.getBoundingClientRect()
    let best: { pv: PageView; area: number; cx: number; cy: number } | null = null
    for (let i = 0; i < f.viewer.pagesCount; i++) {
      const pv = f.viewer.getPageView(i) as PageView | undefined
      if (!pv) continue
      const r = pv.div.getBoundingClientRect()
      if (r.bottom <= c.top) continue
      if (r.top >= c.bottom) break
      const left = Math.max(r.left, c.left)
      const right = Math.min(r.right, c.right)
      const top = Math.max(r.top, c.top)
      const bottom = Math.min(r.bottom, c.bottom)
      const area = Math.max(0, right - left) * Math.max(0, bottom - top)
      if (!best || area > best.area) best = { pv, area, cx: (left + right) / 2, cy: (top + bottom) / 2 }
    }
    if (!best || best.area <= 0) return null
    return this.clientToPdf(best.pv, best.cx, best.cy)
  }

  /** Scroll offset of the visible PDF (lets callers tell whether the view moved). */
  scrollSignature(): string {
    const el = this.front.el
    return `${this.front.buildId}:${el.scrollTop}:${el.scrollLeft}:${this.front.viewer.currentScale}`
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.seq++
    this.ro.disconnect()
    this.ac.abort()
    this.dprQuery?.removeEventListener('change', this.onDprChange)
    cancelAnimationFrame(this.resizeFrame)
    cancelAnimationFrame(this.relayoutFrame)
    cancelAnimationFrame(this.wheelFrame)
    this.clearHighlights()
    for (const s of this.slots) {
      this.resetSlot(s, true)
      s.ac.abort()
      s.el.remove()
    }
  }

  // -- slots --------------------------------------------------------------------------------------

  private createSlot(): Slot {
    const el = document.createElement('div')
    el.className = 'pdf-slot'
    // PDFViewer insists on an absolutely positioned container; don't depend on stylesheet timing
    el.style.position = 'absolute'
    el.style.inset = '0'
    el.style.overflow = 'auto'
    el.setAttribute('role', 'document')
    el.setAttribute('aria-label', 'PDF preview')
    const viewerEl = document.createElement('div')
    viewerEl.className = 'pdfViewer'
    el.append(viewerEl)
    this.host.append(el)

    const eventBus = new EventBus()
    const linkService = new PDFLinkService({
      eventBus,
      externalLinkTarget: LinkTarget.BLANK,
      externalLinkRel: 'noopener noreferrer nofollow',
    })
    const ac = new AbortController()
    const options = {
      container: el,
      viewer: viewerEl,
      eventBus,
      linkService,
      textLayerMode: 1, // TextLayerMode.ENABLE
      annotationMode: pdfjsLib.AnnotationMode.ENABLE, // links, no forms
      annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE,
      enableAutoLinking: false,
      // present at runtime, missing from the .d.ts: removes the viewer's listeners on abort
      abortSignal: ac.signal,
    } as ViewerOptions
    const viewer = new PDFViewer(options)
    linkService.setViewer(viewer)

    const slot: Slot = { el, viewerEl, eventBus, linkService, viewer, ac, task: null, doc: null, buildId: null, docKey: null, placed: false, gen: 0, cancels: new Set(), pagesPending: false }

    eventBus.on('pagechanging', (e: { pageNumber: number }) => {
      if (slot === this.front && slot.doc) this.emit({ page: e.pageNumber, pages: viewer.pagesCount })
    })
    eventBus.on('scalechanging', (e: { scale: number }) => {
      if (slot !== this.front || !slot.doc) return
      this.emit({ scale: e.scale, scaleValue: viewer.currentScaleValue || String(e.scale) })
      this.scheduleHighlightRelayout()
    })
    eventBus.on('updateviewarea', (e: { location?: { pageNumber: number; left: number; top: number } }) => {
      if (slot !== this.front || !slot.doc || !slot.placed || !e.location || !this.usable()) return
      const pos: ViewPosition = { page: e.location.pageNumber, left: e.location.left, top: e.location.top }
      this.lastPos = pos
      this.events.onPosition?.(pos, slot.docKey)
    })
    return slot
  }

  private setRole(slot: Slot, front: boolean): void {
    slot.el.classList.toggle('is-front', front)
    slot.el.classList.toggle('is-back', !front)
    slot.el.inert = !front
    slot.el.tabIndex = front ? 0 : -1
    if (front) slot.el.removeAttribute('aria-hidden')
    else slot.el.setAttribute('aria-hidden', 'true')
  }

  /** Put `doc` into `slot`; resolves true once its pages exist ('pagesinit'). */
  private attach(slot: Slot, doc: PDFDocumentProxy, task: PDFDocumentLoadingTask, buildId: string, docKey: string | null): Promise<boolean> {
    this.resetSlot(slot)
    slot.task = task
    slot.doc = doc
    slot.buildId = buildId
    slot.docKey = docKey
    slot.placed = false
    const gen = slot.gen
    const inited = new Promise<boolean>(resolve => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const finish = (v: boolean) => {
        slot.eventBus.off('pagesinit', onInit)
        slot.cancels.delete(cancel)
        if (timer !== null) clearTimeout(timer)
        resolve(v)
      }
      const onInit = () => finish(slot.gen === gen)
      const cancel = () => finish(false)
      slot.eventBus.on('pagesinit', onInit)
      slot.cancels.add(cancel)
      timer = setTimeout(cancel, PAGESINIT_TIMEOUT_MS)
    })
    slot.viewer.setDocument(doc)
    slot.linkService.setDocument(doc, null)
    // After the first page is painted, PDFViewer fetches every other page (getPage 2..N) to set
    // its page views up; pagesPromise settles when that loop is done.
    slot.pagesPending = true
    void slot.viewer.pagesPromise?.then(
      () => {
        if (slot.doc === doc) slot.pagesPending = false
      },
      () => {},
    )
    return inited
  }

  /**
   * Remove the slot's document. `lazy` (the slot is being thrown away): if pdf.js is still
   * fetching pages to initialise the viewer, keep the document alive until that loop has
   * finished — destroying it now makes every pending getPage() log "Unable to get page N to
   * initialize viewer: Transport destroyed" (e.g. leaving the project right after it opened).
   */
  private resetSlot(slot: Slot, lazy = false): void {
    slot.gen++
    for (const cancel of [...slot.cancels]) cancel()
    slot.cancels.clear()
    const task = slot.task
    const pagesPromise = slot.doc && slot.pagesPending ? slot.viewer.pagesPromise : null
    const teardown = () => {
      if (slot.doc) {
        // setDocument(null) is supported at runtime (it tears the old document down)
        slot.viewer.setDocument(null as unknown as PDFDocumentProxy)
        slot.linkService.setDocument(null, null)
      }
      slot.task = null
      slot.doc = null
      slot.buildId = null
      slot.docKey = null
      slot.pagesPending = false
      // v6: PDFDocumentProxy.destroy() is gone — destroy the loading task
      if (task) void task.destroy()
    }
    if (lazy && pagesPromise) {
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        teardown()
      }
      const timer = setTimeout(finish, LAZY_TEARDOWN_MS)
      void pagesPromise.then(finish, finish)
      return
    }
    teardown()
  }

  private failInit(seq: number): false {
    if (seq === this.seq && !this.destroyed) {
      const error = 'The PDF could not be displayed.'
      this.emit(this.front.doc && this.front.buildId ? { error } : { status: 'error', error })
    }
    return false
  }

  private swap(): void {
    const old = this.front
    const focused = document.activeElement instanceof Node && old.el.contains(document.activeElement)
    this.clearHighlights()
    this.frontIndex = 1 - this.frontIndex
    const next = this.front
    this.setRole(next, true)
    this.setRole(old, false)
    if (focused) next.el.focus({ preventScroll: true })
    const otherDoc = old.docKey !== next.docKey
    this.resetSlot(old)
    // another document: the old one's last position must not be restored into this one
    if (otherDoc) this.lastPos = this.usable() ? this.getPosition(next) : null
    this.emitFront({ status: 'ready', error: null })
  }

  /** The remembered zoom/position for the first document of `docKey` (used once). */
  private takeInitialView(docKey: string | null): PendingView {
    const cleared = this.cleared?.docKey === docKey ? this.cleared.position : null
    const position = cleared ?? this.positionFor(docKey)
    this.cleared = null
    this.viewReady = true
    return { scaleValue: this.initialScaleValue, position, top: position === null }
  }

  /** Zoom + position of the front slot (or what is waiting to be applied to it). */
  private currentView(): PendingView {
    if (this.pendingView) return this.pendingView
    // the first document was superseded before it was laid out: start from the remembered view
    if (!this.viewReady) return this.takeInitialView(this.front.docKey)
    const f = this.front
    const scaleValue = f.viewer.currentScaleValue || this.initialScaleValue
    return { scaleValue, position: this.usable() ? this.getPosition(f) : this.lastPos }
  }

  /**
   * Zoom + position for a new PDF of document `docKey`: the current ones for a new build of the
   * document on screen; for another document the current zoom and that document's remembered
   * position, or the top of page 1 (never the other document's page number).
   */
  private viewFor(docKey: string | null): PendingView {
    if (!this.viewReady) return this.takeInitialView(docKey)
    const view = this.currentView()
    if (docKey === this.front.docKey) return view
    const position = this.positionFor(docKey)
    return { scaleValue: view.scaleValue, position, top: position === null }
  }

  /** Apply zoom + position to a slot (deferred while the host is too small to lay pages out). */
  private applyView(slot: Slot, view: PendingView): void {
    if (!this.usable()) {
      slot.placed = true
      this.pendingView = view
      return
    }
    slot.viewer.currentScaleValue = view.scaleValue
    this.applyPosition(slot, view)
    slot.placed = true
  }

  private applyPosition(slot: Slot, view: PendingView): void {
    if (view.position) {
      this.scrollToPosition(slot, view.position)
    } else if (view.top) {
      slot.el.scrollTop = 0
      slot.el.scrollLeft = 0
    }
  }

  private emit(patch: Partial<PdfViewState>): void {
    if (!this.destroyed) this.events.onView(patch)
  }

  private emitFront(extra: Partial<PdfViewState> = {}): void {
    const f = this.front
    const v = f.viewer
    const scaleValue = this.pendingView?.scaleValue ?? (v.currentScaleValue || this.initialScaleValue)
    this.emit({
      buildId: f.buildId,
      page: f.doc ? v.currentPageNumber : 0,
      pages: f.doc ? v.pagesCount : 0,
      scale: v.currentScale > 0 ? v.currentScale : 1,
      scaleValue,
      ...extra,
    })
  }

  // -- geometry ---------------------------------------------------------------------------------

  private usable(): boolean {
    return this.host.clientWidth >= MIN_USABLE_PX && this.host.clientHeight >= MIN_USABLE_PX
  }

  /** Top-left of the visible area as a PDF point on the first (partially) visible page. */
  private getPosition(slot: Slot): ViewPosition | null {
    if (!slot.doc) return null
    const c = slot.el.getBoundingClientRect()
    for (let i = 0; i < slot.viewer.pagesCount; i++) {
      const pv = slot.viewer.getPageView(i) as PageView | undefined
      if (!pv) continue
      const r = pv.div.getBoundingClientRect()
      if (r.bottom < c.top) continue
      const [left, top] = pv.viewport.convertToPdfPoint(c.left - r.left - pv.div.clientLeft, c.top - r.top - pv.div.clientTop)
      return { page: i + 1, left, top }
    }
    return null
  }

  private scrollToPosition(slot: Slot, p: ViewPosition): void {
    if (!slot.doc || slot.viewer.pagesCount === 0) return
    const page = Math.min(Math.max(1, p.page), slot.viewer.pagesCount)
    slot.viewer.scrollPageIntoView({
      pageNumber: page,
      destArray: [null, { name: 'XYZ' }, p.left, p.top, null],
      allowNegativeOffset: true,
    })
  }

  private visiblePageNumbers(slot: Slot): number[] {
    const out: number[] = []
    const top = slot.el.scrollTop
    const bottom = top + slot.el.clientHeight
    for (let i = 0; i < slot.viewer.pagesCount; i++) {
      const pv = slot.viewer.getPageView(i) as PageView | undefined
      if (!pv) continue
      const t = pv.div.offsetTop
      const b = t + pv.div.offsetHeight
      if (b <= top) continue
      if (t >= bottom) break
      out.push(i + 1)
    }
    return out
  }

  /** Wait until the pages in view of `slot` are painted (bounded by RENDER_WAIT_MS). */
  private waitVisibleRendered(slot: Slot, gen: number): Promise<void> {
    slot.viewer.update()
    const pending = new Set(
      this.visiblePageNumbers(slot).filter(n => {
        const pv = slot.viewer.getPageView(n - 1) as PageView | undefined
        return pv && pv.renderingState !== RenderingStates.FINISHED
      }),
    )
    if (pending.size === 0 || slot.gen !== gen) return Promise.resolve()
    return new Promise(resolve => {
      const finish = () => {
        slot.eventBus.off('pagerendered', onRendered)
        slot.cancels.delete(finish)
        clearTimeout(timer)
        resolve()
      }
      const onRendered = (e: { pageNumber: number }) => {
        pending.delete(e.pageNumber)
        if (pending.size === 0) finish()
      }
      slot.eventBus.on('pagerendered', onRendered)
      slot.cancels.add(finish)
      const timer = setTimeout(finish, RENDER_WAIT_MS)
    })
  }

  private clientToPdf(pv: PageView, clientX: number, clientY: number): PdfPoint {
    const r = pv.div.getBoundingClientRect()
    const [xp, yp] = pv.viewport.convertToPdfPoint(clientX - r.left - pv.div.clientLeft, clientY - r.top - pv.div.clientTop)
    const [x0, , , y1] = pv.viewport.viewBox
    return { page: pv.id, x: xp - x0, y: y1 - yp }
  }

  /** A PdfRect (top-left origin, PDF points) in the scroll container's coordinates. */
  private rectToContainer(slot: Slot, rect: PdfRect): { left: number; top: number; width: number; height: number } | null {
    const pv = slot.viewer.getPageView(rect.page - 1) as PageView | undefined
    if (!pv) return null
    const vp = pv.viewport
    const [x0, , , y1] = vp.viewBox
    const p1 = vp.convertToViewportPoint(x0 + rect.x, y1 - rect.y)
    const p2 = vp.convertToViewportPoint(x0 + rect.x + rect.width, y1 - (rect.y + rect.height))
    const [l0, t0, r0, b0] = pdfjsLib.Util.normalizeRect([p1[0], p1[1], p2[0], p2[1]]) as number[]
    // keep boxes on the page (SyncTeX boxes of wide floats/TikZ pictures can overhang it)
    const w = pv.div.clientWidth
    const h = pv.div.clientHeight
    const l = Math.min(Math.max(l0, 0), w)
    const r = Math.min(Math.max(r0, 0), w)
    const t = Math.min(Math.max(t0, 0), h)
    const b = Math.min(Math.max(b0, 0), h)
    return {
      left: pv.div.offsetLeft + pv.div.clientLeft + l,
      top: pv.div.offsetTop + pv.div.clientTop + t,
      width: r - l,
      height: b - t,
    }
  }

  // -- highlights ---------------------------------------------------------------------------------

  private placeHighlight(slot: Slot, h: Highlight): void {
    const box = this.rectToContainer(slot, h.rect)
    if (!box) {
      h.el.style.display = 'none'
      return
    }
    const padX = 2
    const minH = 6
    const height = Math.max(box.height, minH)
    h.el.style.display = ''
    h.el.style.left = `${box.left - padX}px`
    h.el.style.top = `${box.top - (height - box.height) / 2 - 1}px`
    h.el.style.width = `${Math.max(box.width, 4) + padX * 2}px`
    h.el.style.height = `${height + 2}px`
  }

  private scheduleHighlightRelayout(): void {
    if (this.highlights.length === 0) return
    cancelAnimationFrame(this.relayoutFrame)
    this.relayoutFrame = requestAnimationFrame(() => {
      const f = this.front
      for (const h of this.highlights) this.placeHighlight(f, h)
    })
  }

  private clearHighlights(): void {
    if (this.highlightTimer !== null) clearTimeout(this.highlightTimer)
    this.highlightTimer = null
    for (const h of this.highlights) h.el.remove()
    this.highlights = []
  }

  // -- zoom ---------------------------------------------------------------------------------------

  private stepZoom(dir: 1 | -1): void {
    const f = this.front
    if (!f.doc || !this.usable()) return
    if (dir > 0) f.viewer.increaseScale()
    else f.viewer.decreaseScale()
    this.events.onUserZoom(f.viewer.currentScaleValue)
  }

  private onWheel = (e: WheelEvent) => {
    if (!(e.ctrlKey || e.metaKey)) return
    const f = this.front
    if (!f.doc || !(e.target instanceof Node) || !f.el.contains(e.target)) return
    e.preventDefault()
    // pixel deltas (trackpads, pinch) and line deltas (mouse wheels) → a smooth factor
    const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaMode === 2 ? e.deltaY * 400 : e.deltaY
    this.wheelFactor *= Math.min(2, Math.max(0.5, Math.exp(-dy * 0.0025)))
    this.wheelOrigin = [e.clientX, e.clientY]
    if (this.wheelFrame) return
    this.wheelFrame = requestAnimationFrame(() => {
      this.wheelFrame = 0
      const factor = this.wheelFactor
      const cur = f.viewer.currentScale
      // pdf.js rounds scales to 2 decimals: keep accumulating tiny pinch steps
      if (Math.round(cur * factor * 100) === Math.round(cur * 100)) return
      this.wheelFactor = 1
      f.viewer.updateScale({ scaleFactor: factor, origin: this.wheelOrigin ?? undefined, drawingDelay: 250 })
      this.events.onUserZoom(f.viewer.currentScaleValue)
    })
  }

  /** The PDF pane (toolbar + viewer): keyboard zoom works while focus is anywhere in it. */
  private pane(): HTMLElement {
    return this.host.closest<HTMLElement>('.pdf-pane') ?? this.host
  }

  private onPointerDown = (e: PointerEvent) => {
    this.pointerInPane = e.target instanceof Node && this.pane().contains(e.target)
  }

  /**
   * Ctrl/Cmd + = / - / 0 / 9 zoom the PDF when focus is in the PDF pane — or on <body> after
   * the user last clicked into the pane (focus is lost when the text layer re-renders) — and
   * never while the logs pane covers the viewer. After the zoom, focus is kept on the viewer's
   * scroll container (it survives re-rendering) so the next shortcut still reaches the PDF
   * instead of zooming the whole web page.
   */
  private onKeyDown = (e: KeyboardEvent) => {
    if (!(e.ctrlKey || e.metaKey) || e.altKey || e.defaultPrevented) return
    const f = this.front
    if (!f.doc || this.destroyed) return
    const target = e.target instanceof Node ? e.target : null
    const idle = !target || target === document.body || target === document.documentElement || !target.isConnected
    const inViewer = !!target && f.el.contains(target)
    const inPane = !!target && !idle && this.pane().contains(target)
    if (!inViewer && !inPane && !(idle && this.pointerInPane && this.usable())) return
    // the logs pane covers the viewer: leave the keys alone
    if (this.pane().querySelector('.pdf-logs')) return
    switch (e.key) {
      case '+':
      case '=':
        this.zoomIn()
        break
      case '-':
      case '_':
        this.zoomOut()
        break
      case '0':
        this.setScaleValue('page-width')
        break
      case '9':
        this.setScaleValue('page-fit')
        break
      default:
        return
    }
    e.preventDefault()
    e.stopPropagation()
    if (inViewer || idle) this.focus()
  }

  // -- events -------------------------------------------------------------------------------------

  private onDoubleClick = (e: MouseEvent) => {
    const target = e.target
    if (!(target instanceof Element)) return
    const f = this.front
    if (!f.doc || !f.el.contains(target)) return
    if (target.closest('a, .annotationLayer section')) return // links keep their own behaviour
    const pageDiv = target.closest<HTMLElement>('.page')
    if (!pageDiv) return
    const page = Number(pageDiv.dataset.pageNumber)
    if (!Number.isInteger(page) || page < 1) return
    const pv = f.viewer.getPageView(page - 1) as PageView | undefined
    if (!pv) return
    const point = this.clientToPdf(pv, e.clientX, e.clientY)
    let word = ''
    let before = ''
    const sel = window.getSelection()
    if (sel && sel.rangeCount > 0 && target.closest('.textLayer')) {
      word = sel.toString().trim()
      const range = sel.getRangeAt(0)
      const node = range.startContainer
      if (node.nodeType === Node.TEXT_NODE && f.el.contains(node)) before = (node.textContent ?? '').slice(0, range.startOffset)
    }
    this.events.onDoubleClick({ ...point, word, before })
  }

  private onResize(): void {
    if (this.destroyed) return
    this.resizePending = false
    const usable = this.usable()
    const f = this.front
    if (!usable) {
      this.wasUsable = false
      return
    }
    const cameBack = !this.wasUsable
    this.wasUsable = true
    if (!f.doc) {
      this.flushUsableWaiters()
      return
    }
    if (this.pendingView) {
      const view = this.pendingView
      this.pendingView = null
      f.viewer.currentScaleValue = view.scaleValue
      this.applyPosition(f, view)
    } else if (cameBack) {
      const pos = this.lastPos
      const v = f.viewer.currentScaleValue
      if (isPresetValue(v)) f.viewer.currentScaleValue = v
      if (pos) this.scrollToPosition(f, pos)
    } else {
      // PDFViewer does not re-fit on resize by itself
      const v = f.viewer.currentScaleValue
      if (isPresetValue(v)) f.viewer.currentScaleValue = v
    }
    f.viewer.update()
    this.emitFront()
    this.scheduleHighlightRelayout()
    this.flushUsableWaiters()
  }

  private flushUsableWaiters(): void {
    const waiters = this.usableWaiters
    this.usableWaiters = []
    for (const w of waiters) w()
  }

  /** Re-render at the new resolution when the window moves to a screen with another DPR. */
  private watchDevicePixelRatio(): void {
    this.dprQuery?.removeEventListener('change', this.onDprChange)
    if (typeof matchMedia !== 'function') return
    this.dprQuery = matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    this.dprQuery.addEventListener('change', this.onDprChange, { once: true })
  }

  private onDprChange = () => {
    if (this.destroyed) return
    for (const s of this.slots) if (s.doc) s.viewer.refresh()
    this.watchDevicePixelRatio()
  }
}
