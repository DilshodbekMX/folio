import { useCallback, useId, useSyncExternalStore } from 'react'
import { MenuPopup, useMenuDismiss, type MenuCloseReason, type MenuItem } from './Menu'

interface ContextMenuState {
  items: MenuItem[]
  x: number
  y: number
  target: Element | null
  /** element focused before the menu opened; focus returns there on Esc/select */
  restoreFocus: HTMLElement | null
  seq: number
}

let state: ContextMenuState | null = null
let seq = 0
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

/**
 * Open a context menu at the pointer (or at the target element for keyboard-invoked
 * context menus). Call from an `onContextMenu` handler; requires `<ContextMenuHost/>`.
 */
export function showContextMenu(
  event: { preventDefault(): void; stopPropagation?(): void; clientX: number; clientY: number; currentTarget?: EventTarget | null; target?: EventTarget | null },
  items: MenuItem[],
): void {
  event.preventDefault()
  event.stopPropagation?.()
  const target = (event.currentTarget instanceof Element ? event.currentTarget : event.target instanceof Element ? event.target : null)
  let x = event.clientX
  let y = event.clientY
  // Shift+F10 / the context-menu key report (0, 0): anchor to the element instead.
  if (x === 0 && y === 0 && target) {
    const r = target.getBoundingClientRect()
    x = r.left + Math.min(24, r.width / 2)
    y = r.bottom
  }
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  state = { items, x, y, target, restoreFocus: active, seq: ++seq }
  emit()
}

export function hideContextMenu(): void {
  if (!state) return
  state = null
  emit()
}

/** Mount once near the app root. */
export function ContextMenuHost() {
  const current = useSyncExternalStore(subscribe, () => state, () => null)
  const treeId = useId()

  const close = useCallback(
    (reason: MenuCloseReason) => {
      const restore = state?.restoreFocus
      hideContextMenu()
      if ((reason === 'escape' || reason === 'select' || reason === 'tab') && restore?.isConnected) restore.focus()
    },
    [],
  )
  const getAnchor = useCallback(() => state?.target ?? null, [])
  useMenuDismiss(current !== null, treeId, close, { anchor: getAnchor })

  if (!current) return null
  return (
    <MenuPopup
      key={current.seq}
      items={current.items}
      anchor={{ kind: 'point', x: current.x, y: current.y }}
      treeId={treeId}
      onClose={close}
      initialFocus="none"
      className="ui-menu--context"
    />
  )
}
