/**
 * Keyboard shortcuts modal (SPEC §6.7): every shortcut Folio supports, grouped, with
 * platform-aware key labels (⌘ ⌥ ⇧ on macOS, Ctrl/Alt/Shift elsewhere) and a filter field.
 */
import { useMemo, useState } from 'react'
import { Search, SearchX, X } from 'lucide-react'
import { useSettings } from '../../stores/auth'
import { EmptyState, IconButton, Modal, TextField, formatShortcut, isMac, shortcutParts } from '../../ui'
import { SHORTCUT_GROUPS, type ShortcutItem } from './shortcuts'
import './shortcuts.css'

const MAC_MODIFIER_ORDER = ['⌃', '⌥', '⇧', '⌘']

/** Key caps for a spec; macOS lists modifiers in the conventional ⌃⌥⇧⌘ order. */
function keyCaps(spec: string): string[] {
  const parts = shortcutParts(spec)
  if (!isMac || parts.length < 3) return parts
  const key = parts[parts.length - 1]
  const mods = parts.slice(0, -1).sort((a, b) => MAC_MODIFIER_ORDER.indexOf(a) - MAC_MODIFIER_ORDER.indexOf(b))
  return [...mods, key]
}

function KeyCombo({ spec }: { spec: string }) {
  return (
    <span className="ui-kbd-group" aria-label={formatShortcut(spec)}>
      {keyCaps(spec).map((p, i) => (
        <kbd key={i} className="ui-kbd" aria-hidden="true">
          {p}
        </kbd>
      ))}
    </span>
  )
}

function keysFor(item: ShortcutItem): string[] {
  return (isMac && item.mac ? item.mac : item.keys) ?? []
}

function searchText(item: ShortcutItem): string {
  const keys = keysFor(item).map(k => `${formatShortcut(k)} ${k}`).join(' ')
  return `${item.label} ${item.note ?? ''} ${item.gesture ?? ''} ${keys}`.toLowerCase()
}

export function ShortcutsModal({ onClose }: { onClose: () => void }) {
  const keybindings = useSettings().keybindings
  const [filter, setFilter] = useState('')

  const groups = useMemo(() => {
    const words = filter.trim().toLowerCase().split(/\s+/).filter(Boolean)
    // shortcuts that exist only on the other platform (e.g. macOS-only layout keys)
    const available = SHORTCUT_GROUPS.map(g => ({ ...g, items: g.items.filter(it => it.gesture || keysFor(it).length > 0) })).filter(g => g.items.length > 0)
    if (words.length === 0) return available
    return available.map(g => {
      const titleHit = words.every(w => g.title.toLowerCase().includes(w))
      return { ...g, items: titleHit ? g.items : g.items.filter(it => words.every(w => searchText(it).includes(w))) }
    }).filter(g => g.items.length > 0)
  }, [filter])

  return (
    <Modal
      open
      onClose={onClose}
      title="Keyboard shortcuts"
      size="xl"
      className="keys-modal"
      bodyClassName="keys-modal__body"
      description={isMac ? 'Shortcuts for macOS.' : `Shortcuts for ${navigatorPlatform()}. On a Mac, use ⌘ where Ctrl is shown.`}
    >
      <div className="keys-toolbar">
        <TextField
          size="sm"
          icon={Search}
          value={filter}
          placeholder="Filter shortcuts"
          aria-label="Filter shortcuts"
          wrapperClassName="keys-filter"
          onChange={e => setFilter(e.target.value)}
          onKeyDown={e => {
            if (e.key === 'Escape' && filter) {
              e.preventDefault()
              e.stopPropagation()
              setFilter('')
            }
          }}
          trailing={filter ? <IconButton icon={X} label="Clear filter" size="sm" tooltip={false} onClick={() => setFilter('')} /> : undefined}
          data-autofocus
        />
        {keybindings !== 'default' && (
          <p className="keys-note">
            {keybindings === 'vim'
              ? 'Vim keybindings are on: :w compiles, and some keys below behave differently while the editor has focus.'
              : 'Emacs keybindings are on: some keys below behave differently while the editor has focus.'}
          </p>
        )}
      </div>
      {groups.length === 0 ? (
        <EmptyState icon={SearchX} title="No shortcuts found" size="sm">
          Nothing matches “{filter.trim()}”.
        </EmptyState>
      ) : (
        <div className="keys-groups">
          {groups.map(g => (
            <section key={g.id} className="keys-group" aria-labelledby={`keys-${g.id}`}>
              <h3 id={`keys-${g.id}`} className="keys-group__title">
                {g.title}
              </h3>
              <dl className="keys-list">
                {g.items.map(item => (
                  <div key={item.label} className="keys-item">
                    <dt className="keys-item__label">
                      {item.label}
                      {item.note && <span className="keys-item__note">{item.note}</span>}
                    </dt>
                    <dd className="keys-item__keys">
                      {item.gesture ? (
                        <span className="keys-gesture">{isMac && item.macGesture ? item.macGesture : item.gesture}</span>
                      ) : (
                        keysFor(item).map((k, i) => (
                          <span key={k} className="keys-alt">
                            {i > 0 && <span className="keys-or">{item.label.includes(' / ') ? '/' : 'or'}</span>}
                            <KeyCombo spec={k} />
                          </span>
                        ))
                      )}
                    </dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      )}
    </Modal>
  )
}

function navigatorPlatform(): string {
  const p = typeof navigator === 'undefined' ? '' : navigator.platform || navigator.userAgent
  if (/win/i.test(p)) return 'Windows'
  if (/linux|x11/i.test(p)) return 'Linux'
  return 'Windows and Linux'
}
