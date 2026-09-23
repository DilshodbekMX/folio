import {
  Children, cloneElement, isValidElement, useCallback, useId, useMemo, useRef, useState,
  type KeyboardEvent, type MouseEvent, type ReactElement, type Ref,
} from 'react'
import { MenuPopup, useMenuDismiss, type MenuAnchor, type MenuCloseReason, type MenuItem } from './Menu'
import { chain, mergeRefs } from './utils'

export interface DropdownMenuProps {
  /** the button that opens the menu; it receives ref, onClick, onKeyDown and aria attributes */
  trigger: ReactElement
  items: MenuItem[]
  align?: 'start' | 'end'
  /** open above the trigger (e.g. at the bottom of the rail) */
  side?: 'bottom' | 'top' | 'right'
  /** controlled mode (menu bar); omit for self-managed state */
  open?: boolean
  onOpenChange?: (open: boolean, reason?: MenuCloseReason | 'trigger') => void
  /** ←/→ at the top level where no submenu applies (menu bar navigation) */
  onNavigate?: (dir: 'left' | 'right') => void
  /** focus behaviour when opened in controlled mode (menu bar hover-switch uses 'none') */
  initialFocus?: 'first' | 'last' | 'none'
  className?: string
  minWidth?: number
}

type TriggerProps = {
  ref?: Ref<HTMLElement>
  onClick?: (e: MouseEvent<HTMLElement>) => void
  onKeyDown?: (e: KeyboardEvent<HTMLElement>) => void
  id?: string
  'aria-haspopup'?: string
  'aria-expanded'?: boolean
  'aria-controls'?: string
}

export function DropdownMenu({
  trigger, items, align = 'start', side = 'bottom', open: openProp, onOpenChange, onNavigate, initialFocus,
  className, minWidth,
}: DropdownMenuProps) {
  const [openState, setOpenState] = useState(false)
  const [focusMode, setFocusMode] = useState<'first' | 'last' | 'none'>('first')
  const controlled = openProp !== undefined
  const open = controlled ? openProp : openState
  const triggerRef = useRef<HTMLElement | null>(null)
  const treeId = useId()
  const menuId = `${treeId}-menu`
  const child = Children.only(trigger)
  const childProps = (isValidElement(child) ? child.props : {}) as TriggerProps
  const triggerId = childProps.id ?? `${treeId}-trigger`

  const setOpen = useCallback(
    (next: boolean, reason?: MenuCloseReason | 'trigger') => {
      if (!controlled) setOpenState(next)
      onOpenChange?.(next, reason)
    },
    [controlled, onOpenChange],
  )

  const close = useCallback(
    (reason: MenuCloseReason) => {
      setOpen(false, reason)
      // Return focus to the trigger unless the user clicked elsewhere; a selected action may
      // move focus afterwards (it runs right after this).
      if (reason === 'escape' || reason === 'select' || reason === 'tab') triggerRef.current?.focus()
    },
    [setOpen],
  )

  const getTrigger = useCallback(() => triggerRef.current, [])
  useMenuDismiss(open, treeId, close, { trigger: getTrigger })

  const ref = useMemo(() => mergeRefs<HTMLElement>(childProps.ref, triggerRef), [childProps.ref])

  const anchor: MenuAnchor | null = useMemo(() => {
    if (!open || !triggerRef.current) return null
    const rect = triggerRef.current.getBoundingClientRect()
    if (side === 'right') return { kind: 'rect', rect, placement: 'right-start' }
    if (side === 'top') return { kind: 'rect', rect, placement: 'top-start' }
    return { kind: 'rect', rect, placement: align === 'end' ? 'bottom-end' : 'bottom-start' }
    // The anchor is measured once per opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, align, side])

  if (!isValidElement(child)) return null

  const clone = cloneElement(child as ReactElement<TriggerProps>, {
    ref,
    id: triggerId,
    'aria-haspopup': 'menu',
    'aria-expanded': open,
    'aria-controls': open ? menuId : undefined,
    onClick: chain(childProps.onClick, (e: MouseEvent<HTMLElement>) => {
      if (e.defaultPrevented) return
      // detail === 0: activated from the keyboard → focus the first item.
      setFocusMode(e.detail === 0 ? 'first' : 'none')
      setOpen(!open, 'trigger')
    }),
    onKeyDown: chain(childProps.onKeyDown, (e: KeyboardEvent<HTMLElement>) => {
      if (e.defaultPrevented) return
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusMode(e.key === 'ArrowDown' ? 'first' : 'last')
        setOpen(true, 'trigger')
      }
    }),
  })

  return (
    <>
      {clone}
      {open && anchor && (
        <MenuPopup
          id={menuId}
          items={items}
          anchor={anchor}
          treeId={treeId}
          labelledBy={triggerId}
          onClose={close}
          onNavigate={onNavigate}
          initialFocus={initialFocus ?? focusMode}
          className={className}
          minWidth={minWidth}
        />
      )}
    </>
  )
}
