/**
 * Menu engine shared by DropdownMenu, the context menu and the editor's menu bar:
 * a portal-rendered `role="menu"` list with nested submenus and full keyboard support
 * (arrows, Home/End, Enter/Space, → opens / ← closes a submenu, Esc closes one level,
 * Tab closes all, type-ahead by first letter).
 */
import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type KeyboardEvent as ReactKeyboardEvent, type ReactNode,
} from 'react'
import clsx from 'clsx'
import { Check, ChevronRight } from 'lucide-react'
import { renderIcon, type IconProp } from './icon'
import { Portal } from './Portal'
import { clamp, formatShortcut } from './utils'

export interface MenuItem {
  /** 'header': small-caps section title; 'caption': plain non-interactive text (e.g. an e-mail address) */
  type?: 'item' | 'separator' | 'header' | 'caption' | 'checkbox' | 'radio'
  label?: ReactNode
  icon?: IconProp
  /** CodeMirror-style key spec ('Mod-Shift-z') or a literal display string */
  shortcut?: string
  checked?: boolean
  disabled?: boolean
  danger?: boolean
  onSelect?: () => void
  /** submenu */
  items?: MenuItem[]
  /** stable key (falls back to the index) */
  id?: string
  /** secondary line under the label */
  description?: ReactNode
  /** keep the menu open after selecting (useful for checkbox toggles) */
  keepOpen?: boolean
  /** convenience: drop the item without filtering the array */
  hidden?: boolean
}

export type MenuCloseReason = 'select' | 'escape' | 'tab' | 'outside' | 'resize' | 'navigate'

export type MenuAnchor =
  | { kind: 'rect'; rect: DOMRect; placement: 'bottom-start' | 'bottom-end' | 'right-start' | 'top-start' }
  | { kind: 'point'; x: number; y: number }

const MARGIN = 6

function isInteractive(item: MenuItem): boolean {
  return item.type !== 'separator' && item.type !== 'header' && item.type !== 'caption' && !item.disabled
}

function labelText(item: MenuItem): string {
  return typeof item.label === 'string' ? item.label : typeof item.label === 'number' ? String(item.label) : ''
}

function shortcutText(spec: string): string {
  // Accept both key specs ('Mod-Enter', 'F2') and ready-made strings ('⌘↵').
  return /^([A-Z][a-z]*-)+.+$|^F\d{1,2}$|^Mod/.test(spec) ? formatShortcut(spec) : spec
}

function place(anchor: MenuAnchor, w: number, h: number): { left: number; top: number; maxHeight: number } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const maxHeight = vh - 2 * MARGIN
  const hh = Math.min(h, maxHeight)
  let left: number
  let top: number
  if (anchor.kind === 'point') {
    left = anchor.x + w > vw - MARGIN ? anchor.x - w : anchor.x
    top = anchor.y + hh > vh - MARGIN ? anchor.y - hh : anchor.y
  } else {
    const r = anchor.rect
    if (anchor.placement === 'right-start') {
      left = r.right - 2
      if (left + w > vw - MARGIN) left = r.left - w + 2
      top = r.top - 5
    } else {
      left = anchor.placement === 'bottom-end' ? r.right - w : r.left
      const below = r.bottom + 4
      const above = r.top - hh - 4
      if (anchor.placement === 'top-start') top = above >= MARGIN ? above : below
      else top = below + hh > vh - MARGIN && above >= MARGIN ? above : below
    }
  }
  return {
    left: clamp(left, MARGIN, Math.max(MARGIN, vw - w - MARGIN)),
    top: clamp(top, MARGIN, Math.max(MARGIN, vh - hh - MARGIN)),
    maxHeight,
  }
}

export interface MenuPopupProps {
  items: MenuItem[]
  anchor: MenuAnchor
  /** closes the whole menu tree */
  onClose: (reason: MenuCloseReason) => void
  /** submenus only: close this level and give focus back to the parent item */
  onCloseLevel?: () => void
  /** root level only: ← / → pressed where no submenu applies (menu bar navigation) */
  onNavigate?: (dir: 'left' | 'right') => void
  /** which item receives focus on open ('none' focuses the menu itself) */
  initialFocus?: 'first' | 'last' | 'none'
  level?: number
  /** shared id tying every level of one menu tree together (outside-click detection) */
  treeId: string
  labelledBy?: string
  id?: string
  className?: string
  minWidth?: number
}

export function MenuPopup({
  items, anchor, onClose, onCloseLevel, onNavigate, initialFocus = 'first', level = 0, treeId,
  labelledBy, id, className, minWidth,
}: MenuPopupProps) {
  const visible = items.filter(i => !i.hidden)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null)
  const [activeIndex, setActiveIndex] = useState(-1)
  const [submenu, setSubmenu] = useState<{ index: number; focus: 'first' | 'none' } | null>(null)
  const hoverTimer = useRef<number | undefined>(undefined)
  const typeahead = useRef({ text: '', at: 0 })
  const baseId = useId()

  useLayoutEffect(() => {
    const el = menuRef.current
    if (!el) return
    setPos(place(anchor, el.offsetWidth, el.scrollHeight))
    // Re-place when the anchor moves (new DOMRect object) or the item list changes size.
  }, [anchor, visible.length])

  const focusIndex = useCallback((i: number) => {
    setActiveIndex(i)
    const el = itemRefs.current[i]
    if (el) el.focus({ preventScroll: false })
  }, [])

  const interactiveIndexes = visible.map((it, i) => (isInteractive(it) ? i : -1)).filter(i => i >= 0)

  useEffect(() => {
    if (!pos) return
    if (initialFocus === 'first' && interactiveIndexes.length) focusIndex(interactiveIndexes[0])
    else if (initialFocus === 'last' && interactiveIndexes.length) focusIndex(interactiveIndexes[interactiveIndexes.length - 1])
    else menuRef.current?.focus({ preventScroll: true })
    // Only on first placement.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos !== null])

  useEffect(() => () => window.clearTimeout(hoverTimer.current), [])

  const move = (delta: 1 | -1) => {
    if (!interactiveIndexes.length) return
    const cur = interactiveIndexes.indexOf(activeIndex)
    const next = cur === -1
      ? (delta === 1 ? 0 : interactiveIndexes.length - 1)
      : (cur + delta + interactiveIndexes.length) % interactiveIndexes.length
    focusIndex(interactiveIndexes[next])
  }

  const activate = (index: number, viaKeyboard: boolean) => {
    const item = visible[index]
    if (!item || !isInteractive(item)) return
    if (item.items && item.items.some(i => !i.hidden)) {
      setSubmenu({ index, focus: viaKeyboard ? 'first' : 'none' })
      return
    }
    if (item.keepOpen) {
      item.onSelect?.()
      return
    }
    onClose('select')
    item.onSelect?.()
  }

  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    // Keys typed inside an open submenu are handled there (they bubble through the React tree).
    if (e.target instanceof Node && !menuRef.current?.contains(e.target)) return
    const item = activeIndex >= 0 ? visible[activeIndex] : undefined
    const hasSub = !!item?.items?.some(i => !i.hidden) && isInteractive(item)
    switch (e.key) {
      case 'ArrowDown':
        move(1)
        break
      case 'ArrowUp':
        move(-1)
        break
      case 'Home':
      case 'PageUp':
        if (interactiveIndexes.length) focusIndex(interactiveIndexes[0])
        break
      case 'End':
      case 'PageDown':
        if (interactiveIndexes.length) focusIndex(interactiveIndexes[interactiveIndexes.length - 1])
        break
      case 'Enter':
      case ' ':
        if (activeIndex >= 0) activate(activeIndex, true)
        break
      case 'ArrowRight':
        if (hasSub) setSubmenu({ index: activeIndex, focus: 'first' })
        else if (level === 0) onNavigate?.('right')
        else return
        break
      case 'ArrowLeft':
        if (level > 0) onCloseLevel?.()
        else onNavigate?.('left')
        break
      case 'Escape':
        if (level > 0) onCloseLevel?.()
        else onClose('escape')
        break
      case 'Tab':
        onClose('tab')
        break
      default: {
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && /\S/.test(e.key)) {
          const now = Date.now()
          const ta = typeahead.current
          ta.text = now - ta.at > 700 ? e.key.toLowerCase() : ta.text + e.key.toLowerCase()
          ta.at = now
          const start = Math.max(0, interactiveIndexes.indexOf(activeIndex))
          const order = [...interactiveIndexes.slice(start + (ta.text.length === 1 ? 1 : 0)), ...interactiveIndexes.slice(0, start + 1)]
          const hit = order.find(i => labelText(visible[i]).toLowerCase().startsWith(ta.text))
          if (hit !== undefined) focusIndex(hit)
          break
        }
        return
      }
    }
    e.preventDefault()
    e.stopPropagation()
  }

  const onItemEnter = (index: number) => {
    const item = visible[index]
    window.clearTimeout(hoverTimer.current)
    if (!isInteractive(item)) return
    focusIndex(index)
    const hasSub = !!item.items?.some(i => !i.hidden)
    if (hasSub && submenu?.index !== index) {
      hoverTimer.current = window.setTimeout(() => setSubmenu({ index, focus: 'none' }), 110)
    } else if (!hasSub && submenu) {
      hoverTimer.current = window.setTimeout(() => setSubmenu(null), 220)
    }
  }

  const sub = submenu ? visible[submenu.index] : undefined
  const subAnchorEl = submenu ? itemRefs.current[submenu.index] : null

  let hasToggleColumn = false
  for (const it of visible) if (it.type === 'checkbox' || it.type === 'radio') hasToggleColumn = true

  return (
    <Portal>
      <div
        ref={menuRef}
        id={id}
        role="menu"
        tabIndex={-1}
        aria-labelledby={labelledBy}
        aria-orientation="vertical"
        data-ui-layer="menu"
        data-menu-tree={treeId}
        className={clsx('ui-menu', pos && 'is-positioned', hasToggleColumn && 'has-toggles', className)}
        style={{
          left: pos?.left ?? -9999,
          top: pos?.top ?? -9999,
          maxHeight: pos?.maxHeight,
          minWidth,
        }}
        onKeyDown={onKeyDown}
        onContextMenu={e => e.preventDefault()}
      >
        {visible.map((item, i) => {
          const key = item.id ?? `${i}`
          if (item.type === 'separator') return <div key={key} role="separator" className="ui-menu__sep" />
          if (item.type === 'header' || item.type === 'caption') {
            return (
              <div key={key} role="presentation" className={item.type === 'header' ? 'ui-menu__header' : 'ui-menu__caption'}>
                {item.label}
              </div>
            )
          }
          const hasSub = !!item.items?.some(x => !x.hidden)
          const role = item.type === 'checkbox' ? 'menuitemcheckbox' : item.type === 'radio' ? 'menuitemradio' : 'menuitem'
          return (
            <div
              key={key}
              id={`${baseId}-${i}`}
              ref={el => {
                itemRefs.current[i] = el
              }}
              role={role}
              tabIndex={-1}
              aria-disabled={item.disabled || undefined}
              aria-checked={role === 'menuitem' ? undefined : !!item.checked}
              aria-haspopup={hasSub ? 'menu' : undefined}
              aria-expanded={hasSub ? submenu?.index === i : undefined}
              className={clsx(
                'ui-menu__item',
                item.danger && 'is-danger',
                item.disabled && 'is-disabled',
                (activeIndex === i || submenu?.index === i) && 'is-active',
              )}
              onFocus={() => {
                if (activeIndex !== i) setActiveIndex(i)
              }}
              onMouseEnter={() => onItemEnter(i)}
              onMouseLeave={() => {
                if (activeIndex === i && !hasSub) setActiveIndex(-1)
              }}
              onClick={e => {
                e.preventDefault()
                activate(i, false)
              }}
            >
              {hasToggleColumn && (
                <span className="ui-menu__check" aria-hidden="true">
                  {item.checked ? (item.type === 'radio' ? <span className="ui-menu__radio" /> : <Check size={14} strokeWidth={2.4} />) : null}
                </span>
              )}
              {item.icon !== undefined && <span className="ui-menu__icon">{renderIcon(item.icon, 16)}</span>}
              <span className="ui-menu__text">
                <span className="ui-menu__label">{item.label}</span>
                {item.description && <span className="ui-menu__desc">{item.description}</span>}
              </span>
              {item.shortcut && <span className="ui-menu__shortcut">{shortcutText(item.shortcut)}</span>}
              {hasSub && <ChevronRight className="ui-menu__chevron" size={14} aria-hidden="true" />}
            </div>
          )
        })}
      </div>
      {sub && sub.items && subAnchorEl && submenu && (
        <MenuPopup
          key={submenu.index}
          items={sub.items}
          anchor={{ kind: 'rect', rect: subAnchorEl.getBoundingClientRect(), placement: 'right-start' }}
          onClose={onClose}
          onCloseLevel={() => {
            const idx = submenu.index
            setSubmenu(null)
            focusIndex(idx)
          }}
          initialFocus={submenu.focus}
          level={level + 1}
          treeId={treeId}
          labelledBy={`${baseId}-${submenu.index}`}
          className={className}
        />
      )}
    </Portal>
  )
}

/**
 * Close the menu tree on pointer-down outside of it (and outside `trigger`, which toggles by
 * itself), on window resize/blur, and when a container holding the anchor scrolls (so the menu
 * never floats detached from what opened it; unrelated scrolling, e.g. the PDF restoring its
 * position after a compile, leaves it open).
 */
export function useMenuDismiss(
  open: boolean,
  treeId: string,
  onClose: (reason: MenuCloseReason) => void,
  opts: { trigger?: () => Element | null; anchor?: () => Element | null } = {},
) {
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const optsRef = useRef(opts)
  optsRef.current = opts
  useEffect(() => {
    if (!open) return
    const inTree = (t: EventTarget | null) =>
      t instanceof Element && !!t.closest(`[data-menu-tree="${CSS.escape(treeId)}"]`)
    const onPointerDown = (e: PointerEvent) => {
      if (inTree(e.target)) return
      const trig = optsRef.current.trigger?.()
      if (trig && e.target instanceof Node && trig.contains(e.target)) return
      onCloseRef.current('outside')
    }
    const onScroll = (e: Event) => {
      if (inTree(e.target)) return
      const anchor = optsRef.current.anchor?.() ?? optsRef.current.trigger?.()
      const t = e.target
      if (!anchor || t === document || t === window || (t instanceof Node && t.contains(anchor))) {
        onCloseRef.current('resize')
      }
    }
    const onResize = () => onCloseRef.current('resize')
    document.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onResize)
    window.addEventListener('blur', onResize)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onResize)
      window.removeEventListener('blur', onResize)
    }
  }, [open, treeId])
}
