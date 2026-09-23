/**
 * Find & replace panel for @codemirror/search, styled like the rest of Folio: a search field
 * with Match case / Regular expression / Whole word toggles, an "n of m" counter,
 * previous/next, and a collapsible replace row (Replace / Replace all). Searches as you type:
 * the first match at or after where the search started is selected and scrolled into view
 * (wrapping around), the focus stays in the field. Keyboard:
 * Enter / Shift-Enter next/previous, Alt-Enter selects all matches, Enter in the replace field
 * replaces, Mod-Alt-Enter replaces all, Alt-C / Alt-R / Alt-W toggle the options, Esc closes
 * and returns to the text; Mod-Enter / Mod-s still compile.
 */
import { Annotation, EditorSelection, type Extension } from '@codemirror/state'
import { EditorView, type Panel, type ViewUpdate } from '@codemirror/view'
import {
  SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, replaceAll,
  replaceNext, search, selectMatches, setSearchQuery,
} from '@codemirror/search'

const MAX_COUNT = 9999
const SVG_NS = 'http://www.w3.org/2000/svg'

function icon(d: string, size = 15): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '2')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const part of d.split('|')) {
    const p = document.createElementNS(SVG_NS, 'path')
    p.setAttribute('d', part)
    svg.appendChild(p)
  }
  return svg
}

const ICONS = {
  chevronRight: 'M9 6l6 6-6 6',
  up: 'M12 19V5|M5 12l7-7 7 7',
  down: 'M12 5v14|M19 12l-7 7-7-7',
  close: 'M18 6 6 18|M6 6l12 12',
  selectAll: 'M4 7V5a1 1 0 0 1 1-1h2|M17 4h2a1 1 0 0 1 1 1v2|M20 17v2a1 1 0 0 1-1 1h-2|M7 20H5a1 1 0 0 1-1-1v-2|M8 12h8',
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v
    else e.setAttribute(k, v)
  }
  e.append(...children)
  return e
}

const replaceOpen = new WeakMap<EditorView, boolean>()
const panels = new WeakMap<EditorView, FolioSearchPanel>()
/** marks the selection changes made by searching as you type */
const incremental = Annotation.define<boolean>()

class FolioSearchPanel implements Panel {
  readonly dom: HTMLElement
  readonly top = true
  private query: SearchQuery
  private readonly searchField: HTMLInputElement
  private readonly replaceField: HTMLInputElement
  private readonly caseBtn: HTMLButtonElement
  private readonly regexpBtn: HTMLButtonElement
  private readonly wordBtn: HTMLButtonElement
  private readonly toggleBtn: HTMLButtonElement
  private readonly count: HTMLElement
  private readonly replaceRow: HTMLElement
  private countTimer: ReturnType<typeof setTimeout> | null = null
  private readonly view: EditorView
  /** where searching as you type starts: the cursor when the panel opened, then the last match navigated to or the last place clicked */
  private searchStart: number

  constructor(view: EditorView) {
    this.view = view
    this.query = getSearchQuery(view.state)
    this.searchStart = view.state.selection.main.from

    this.searchField = el('input', {
      class: 'ed-search__input',
      type: 'text',
      placeholder: 'Search',
      'aria-label': 'Search in file',
      'main-field': 'true',
      spellcheck: 'false',
      autocomplete: 'off',
    })
    this.searchField.value = this.query.search
    this.replaceField = el('input', {
      class: 'ed-search__input',
      type: 'text',
      placeholder: 'Replace with',
      'aria-label': 'Replace with',
      spellcheck: 'false',
      autocomplete: 'off',
    })
    this.replaceField.value = this.query.replace

    const toggle = (label: string, title: string, text: string) => {
      const b = el('button', { type: 'button', class: 'ed-search__opt', 'aria-label': label, title, 'aria-pressed': 'false' }, text)
      b.addEventListener('mousedown', e => e.preventDefault())
      return b
    }
    this.caseBtn = toggle('Match case', 'Match case (Alt+C)', 'Aa')
    this.regexpBtn = toggle('Regular expression', 'Regular expression (Alt+R)', '.*')
    this.wordBtn = toggle('Whole word', 'Whole word (Alt+W)', 'W')
    this.caseBtn.addEventListener('click', () => this.flip('case'))
    this.regexpBtn.addEventListener('click', () => this.flip('regexp'))
    this.wordBtn.addEventListener('click', () => this.flip('word'))

    const iconBtn = (label: string, path: string, onClick: () => void, cls = '') => {
      const b = el('button', { type: 'button', class: `ed-search__btn ${cls}`.trim(), 'aria-label': label, title: label })
      b.appendChild(icon(path))
      b.addEventListener('click', onClick)
      return b
    }

    this.toggleBtn = iconBtn('Toggle replace', ICONS.chevronRight, () => this.setReplaceOpen(!this.isReplaceOpen(), true), 'ed-search__toggle')
    this.count = el('span', { class: 'ed-search__count', 'aria-live': 'polite' })

    const field = el('div', { class: 'ed-search__field' }, this.searchField, el('span', { class: 'ed-search__opts' }, this.caseBtn, this.regexpBtn, this.wordBtn))
    const prev = iconBtn('Previous match (Shift+Enter)', ICONS.up, () => {
      this.commit()
      findPrevious(this.view)
    })
    const next = iconBtn('Next match (Enter)', ICONS.down, () => {
      this.commit()
      findNext(this.view)
    })
    const all = iconBtn('Select all matches (Alt+Enter)', ICONS.selectAll, () => {
      this.commit()
      selectMatches(this.view)
      this.view.focus()
    })
    const close = iconBtn('Close (Esc)', ICONS.close, () => this.close(), 'ed-search__close')

    const replaceBtn = el('button', { type: 'button', class: 'ed-search__action' }, 'Replace')
    replaceBtn.addEventListener('click', () => {
      this.commit()
      replaceNext(this.view)
    })
    const replaceAllBtn = el('button', { type: 'button', class: 'ed-search__action' }, 'Replace all')
    replaceAllBtn.addEventListener('click', () => {
      this.commit()
      replaceAll(this.view)
    })

    const findRow = el('div', { class: 'ed-search__row' }, this.toggleBtn, field, this.count, el('span', { class: 'ed-search__nav' }, prev, next, all), close)
    this.replaceRow = el('div', { class: 'ed-search__row ed-search__row--replace' },
      el('span', { class: 'ed-search__spacer' }),
      el('div', { class: 'ed-search__field' }, this.replaceField),
      el('span', { class: 'ed-search__actions' }, replaceBtn, replaceAllBtn),
    )
    this.dom = el('div', { class: 'ed-search', role: 'search' }, findRow, this.replaceRow)
    this.dom.addEventListener('keydown', e => this.keydown(e))
    this.searchField.addEventListener('input', () => {
      if (this.commit()) this.selectFirstMatch()
    })
    this.replaceField.addEventListener('input', () => this.commit())

    this.syncOptions()
    this.setReplaceOpen(replaceOpen.get(view) ?? false, false)
    this.scheduleCount(0)
    panels.set(view, this)
  }

  mount(): void {
    this.searchField.select()
  }

  update(update: ViewUpdate): void {
    let queryChanged = false
    let querySet = false
    for (const tr of update.transactions) {
      for (const e of tr.effects) {
        if (!e.is(setSearchQuery)) continue
        querySet = true
        if (!e.value.eq(this.query)) {
          this.query = e.value
          queryChanged = true
        }
      }
    }
    if (queryChanged) {
      if (this.searchField.value !== this.query.search) this.searchField.value = this.query.search
      if (this.replaceField.value !== this.query.replace) this.replaceField.value = this.query.replace
      this.syncOptions()
    }
    if (update.startState.readOnly !== update.state.readOnly) this.setReplaceOpen(this.isReplaceOpen(), false)
    if (querySet || update.docChanged || update.selectionSet) this.scheduleCount(update.docChanged ? 150 : 30)
    for (const tr of update.transactions) {
      if (tr.selection && !tr.annotation(incremental)) this.searchStart = tr.selection.main.from
      else if (tr.docChanged) this.searchStart = tr.changes.mapPos(this.searchStart)
    }
  }

  destroy(): void {
    if (this.countTimer !== null) clearTimeout(this.countTimer)
    if (panels.get(this.view) === this) panels.delete(this.view)
  }

  isReplaceOpen(): boolean {
    return !this.replaceRow.hidden
  }

  setReplaceOpen(open: boolean, focus: boolean): void {
    const allowed = open && !this.view.state.readOnly
    replaceOpen.set(this.view, allowed)
    this.replaceRow.hidden = !allowed
    this.toggleBtn.classList.toggle('is-open', allowed)
    this.toggleBtn.setAttribute('aria-expanded', String(allowed))
    this.toggleBtn.hidden = this.view.state.readOnly
    if (focus && allowed) this.replaceField.focus()
  }

  focusSearch(): void {
    this.searchField.focus()
    this.searchField.select()
  }

  private flip(which: 'case' | 'regexp' | 'word'): void {
    const q = this.query
    const next = new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: which === 'case' ? !q.caseSensitive : q.caseSensitive,
      regexp: which === 'regexp' ? !q.regexp : q.regexp,
      wholeWord: which === 'word' ? !q.wholeWord : q.wholeWord,
      literal: q.literal,
    })
    this.query = next
    this.view.dispatch({ effects: setSearchQuery.of(next) })
    this.syncOptions()
    this.selectFirstMatch()
  }

  /** Apply the fields to the search query; true when it changed. */
  private commit(): boolean {
    const q = new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.query.caseSensitive,
      regexp: this.query.regexp,
      wholeWord: this.query.wholeWord,
      literal: this.query.literal,
    })
    if (q.eq(this.query)) return false
    this.query = q
    this.view.dispatch({ effects: setSearchQuery.of(q) })
    return true
  }

  /** Search as you type: select the first match at or after the start (wrapping), focus stays here. */
  private selectFirstMatch(): void {
    const q = this.query
    if (!q.search || !q.valid) return
    const { state } = this.view
    const start = Math.min(this.searchStart, state.doc.length)
    let m = q.getCursor(state, start).next()
    if (m.done) m = q.getCursor(state, 0, start).next()
    if (m.done) return
    const { from, to } = m.value
    this.view.dispatch({
      selection: EditorSelection.single(from, to),
      effects: EditorView.scrollIntoView(from, { y: 'center' }),
      annotations: incremental.of(true),
      userEvent: 'select.search',
    })
  }

  private syncOptions(): void {
    const set = (b: HTMLButtonElement, on: boolean) => {
      b.classList.toggle('is-on', on)
      b.setAttribute('aria-pressed', String(on))
    }
    set(this.caseBtn, this.query.caseSensitive)
    set(this.regexpBtn, this.query.regexp)
    set(this.wordBtn, this.query.wholeWord)
  }

  private close(): void {
    closeSearchPanel(this.view)
    this.view.focus()
  }

  private keydown(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey
    if (e.key === 'Escape') {
      e.preventDefault()
      this.close()
      return
    }
    if (e.altKey && !mod) {
      const k = e.key.toLowerCase()
      if (k === 'c' || k === 'r' || k === 'w') {
        e.preventDefault()
        this.flip(k === 'c' ? 'case' : k === 'r' ? 'regexp' : 'word')
        return
      }
    }
    if (mod && !e.altKey && e.key.toLowerCase() === 'f') {
      e.preventDefault()
      this.focusSearch()
      return
    }
    if (e.key !== 'Enter') return
    // Mod-Enter is left to the page (compile), like everywhere else in the editor
    if (mod && !e.altKey) return
    e.preventDefault()
    this.commit()
    if (e.target === this.replaceField) {
      if (mod && e.altKey) replaceAll(this.view)
      else replaceNext(this.view)
      return
    }
    if (e.altKey) {
      selectMatches(this.view)
      this.view.focus()
    } else if (e.shiftKey) findPrevious(this.view)
    else findNext(this.view)
  }

  private scheduleCount(delay: number): void {
    if (this.countTimer !== null) clearTimeout(this.countTimer)
    this.countTimer = setTimeout(() => {
      this.countTimer = null
      this.updateCount()
    }, delay)
  }

  private updateCount(): void {
    const q = this.query
    this.dom.classList.remove('is-invalid', 'is-empty')
    if (!q.search) {
      this.count.textContent = ''
      return
    }
    if (!q.valid) {
      this.count.textContent = 'Invalid'
      this.dom.classList.add('is-invalid')
      return
    }
    const { state } = this.view
    const sel = state.selection.main
    let total = 0
    let current = 0
    const cursor = q.getCursor(state)
    for (let r = cursor.next(); !r.done; r = cursor.next()) {
      total++
      if (current === 0 && r.value.from === sel.from && r.value.to === sel.to) current = total
      if (total > MAX_COUNT) break
    }
    if (total === 0) {
      this.count.textContent = 'No results'
      this.dom.classList.add('is-empty')
      return
    }
    const totalText = total > MAX_COUNT ? `${MAX_COUNT}+` : String(total)
    this.count.textContent = current ? `${current} of ${totalText}` : `${totalText} ${total === 1 ? 'match' : 'matches'}`
  }
}

/** Open the find panel (optionally with the replace row expanded) and focus the search field. */
export function openSearch(view: EditorView, withReplace: boolean): boolean {
  if (withReplace && !view.state.readOnly) replaceOpen.set(view, true)
  openSearchPanel(view)
  const panel = panels.get(view)
  if (panel) {
    if (withReplace) panel.setReplaceOpen(true, false)
    panel.focusSearch()
  }
  return true
}

export function searchExtension(): Extension {
  return search({
    top: true,
    createPanel: view => new FolioSearchPanel(view),
    scrollToMatch: range => EditorView.scrollIntoView(range, { y: 'center' }),
  })
}
