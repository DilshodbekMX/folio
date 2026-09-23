/**
 * Symbol palette (Insert › Symbol…): a searchable grid of math symbols grouped in tabs
 * (Greek, Operators, Relations, Arrows, Misc). Clicking a symbol (or Enter on it) inserts its
 * command at the editor cursor and keeps the palette open for more; the footer shows the
 * command and any package it needs. Arrow keys move through the grid.
 */
import { useMemo, useRef, useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import { Search } from 'lucide-react'
import { EditorSelection } from '@codemirror/state'
import { useEditor } from '../../stores/editor'
import { Kbd, Modal, Tabs, TextField } from '../../ui'
import { SYMBOL_CATEGORIES, SYMBOLS, type SymbolCategory, type SymbolSpec } from './data/symbols'

type TabId = 'all' | SymbolCategory

function matches(s: SymbolSpec, q: string): boolean {
  if (!q) return true
  const hay = `${s.command} ${s.name} ${s.aliases ?? ''} ${s.glyph}`.toLowerCase()
  return q.toLowerCase().split(/\s+/).every(w => hay.includes(w.replace(/^\\/, '')))
}

/** Insert a command at the cursor; a space follows when a letter would glue onto the name. */
function insertSymbol(s: SymbolSpec): boolean {
  const view = useEditor.getState().view
  if (!view || view.state.readOnly) return false
  const { state } = view
  const tr = state.changeByRange(range => {
    const next = state.sliceDoc(range.to, range.to + 1)
    const needsSpace = /[A-Za-z]$/.test(s.command) && /[A-Za-z]/.test(next)
    const text = s.command + (needsSpace ? ' ' : '')
    // place the cursor inside an empty argument, e.g. \sqrt{|}
    const inner = s.command.endsWith('{}') ? text.length - 1 : text.length
    return { changes: { from: range.from, to: range.to, insert: text }, range: EditorSelection.cursor(range.from + inner) }
  })
  view.dispatch(state.update(tr, { scrollIntoView: true, userEvent: 'input' }))
  return true
}

export function SymbolPalette({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<TabId>('all')
  const [query, setQuery] = useState('')
  const [focused, setFocused] = useState<SymbolSpec | null>(null)
  const [last, setLast] = useState<string | null>(null)
  const gridRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const canInsert = useEditor(s => s.view !== null && !s.view.state.readOnly)

  const symbols = useMemo(
    () => SYMBOLS.filter(s => (tab === 'all' || s.category === tab) && matches(s, query.trim())),
    [tab, query],
  )

  const tabs = [
    { id: 'all', label: 'All' },
    ...SYMBOL_CATEGORIES.map(c => ({ id: c.id, label: c.label })),
  ]

  const pick = (s: SymbolSpec) => {
    if (insertSymbol(s)) setLast(s.command)
  }

  const onGridKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const grid = gridRef.current
    if (!grid) return
    const buttons = Array.from(grid.querySelectorAll<HTMLButtonElement>('button'))
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement)
    if (i === -1) return
    const cols = Math.max(1, Math.round(grid.clientWidth / (buttons[0]?.offsetWidth || 48)))
    let j = i
    if (e.key === 'ArrowRight') j = i + 1
    else if (e.key === 'ArrowLeft') j = i - 1
    else if (e.key === 'ArrowDown') j = i + cols
    else if (e.key === 'ArrowUp') {
      if (i < cols) {
        e.preventDefault()
        searchRef.current?.focus()
        return
      }
      j = i - cols
    } else if (e.key === 'Home') j = 0
    else if (e.key === 'End') j = buttons.length - 1
    else return
    e.preventDefault()
    buttons[Math.max(0, Math.min(buttons.length - 1, j))]?.focus()
  }

  const shown = focused && symbols.includes(focused) ? focused : symbols[0] ?? null

  return (
    <Modal
      open
      onClose={onClose}
      title="Insert symbol"
      size="lg"
      className="ed-symbols"
      bodyClassName="ed-symbols__body"
      initialFocus={searchRef}
      footer={
        <div className="ed-symbols__footer">
          {shown ? (
            <div className="ed-symbols__detail" aria-live="polite">
              <span className="ed-symbols__big" aria-hidden="true">{shown.glyph}</span>
              <span className="ed-symbols__meta">
                <code>{shown.command}</code>
                <span>
                  {shown.name}
                  {shown.pkg ? ` · needs \\usepackage{${shown.pkg}}` : ''}
                </span>
              </span>
            </div>
          ) : (
            <span />
          )}
          <span className="ed-symbols__hint">
            {!canInsert ? 'Open a file you can edit to insert symbols.' : last ? `Inserted ${last}` : <>Click or press <Kbd>Enter</Kbd> to insert · symbols are for math mode</>}
          </span>
        </div>
      }
    >
      <div className="ed-symbols__controls">
        <TextField
          ref={searchRef}
          icon={Search}
          size="sm"
          placeholder="Search symbols (e.g. alpha, arrow, ≤)"
          aria-label="Search symbols"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'ArrowDown') {
              e.preventDefault()
              gridRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
            } else if (e.key === 'Enter' && symbols[0]) {
              e.preventDefault()
              pick(symbols[0])
            }
          }}
        />
        <Tabs tabs={tabs} active={tab} onChange={id => setTab(id as TabId)} variant="pill" label="Symbol categories" />
      </div>
      {symbols.length === 0 ? (
        <p className="ed-symbols__none">No symbols match “{query}”.</p>
      ) : (
        <div ref={gridRef} className="ed-symbols__grid" role="group" aria-label="Symbols" onKeyDown={onGridKey}>
          {symbols.map(s => (
            <button
              key={`${s.category}:${s.command}`}
              type="button"
              className={clsx('ed-symbols__cell', shown === s && 'is-shown')}
              aria-label={`${s.name} ${s.command}`}
              title={s.command}
              disabled={!canInsert}
              onMouseEnter={() => setFocused(s)}
              onFocus={() => setFocused(s)}
              onClick={() => pick(s)}
            >
              <span aria-hidden="true">{s.glyph}</span>
            </button>
          ))}
        </div>
      )}
    </Modal>
  )
}
