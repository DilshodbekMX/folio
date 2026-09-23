import {
  Children, cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState,
  type FocusEvent, type ReactElement, type ReactNode, type Ref,
} from 'react'
import clsx from 'clsx'
import { Portal } from './Portal'
import { chain, clamp, mergeRefs } from './utils'

export type TooltipSide = 'top' | 'bottom' | 'left' | 'right'

export interface TooltipProps {
  content: ReactNode
  side?: TooltipSide
  /** a single element that accepts ref + mouse/focus handlers (DOM element or ref-forwarding component) */
  children: ReactElement
  /** hover delay in ms (focus shows immediately) */
  delay?: number
  disabled?: boolean
  /**
   * Link the tooltip to the trigger with aria-describedby (default true). IconButton turns this
   * off when the tooltip only repeats its aria-label.
   */
  describe?: boolean
}

type TriggerProps = {
  ref?: Ref<HTMLElement>
  onMouseEnter?: (e: unknown) => void
  onMouseLeave?: (e: unknown) => void
  onFocus?: (e: FocusEvent<HTMLElement>) => void
  onBlur?: (e: unknown) => void
  onPointerDown?: (e: unknown) => void
  onKeyDown?: (e: unknown) => void
  'aria-describedby'?: string
}

const GAP = 6
const MARGIN = 6

/** Hover/focus tooltip rendered in a portal; Esc or a click hides it. */
export function Tooltip({ content, side = 'top', children, delay = 450, disabled, describe = true }: TooltipProps) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ left: number; top: number; side: TooltipSide } | null>(null)
  const anchorRef = useRef<HTMLElement | null>(null)
  const tipRef = useRef<HTMLDivElement | null>(null)
  const timer = useRef<number | undefined>(undefined)
  const id = useId()

  const hide = useCallback(() => {
    window.clearTimeout(timer.current)
    setOpen(false)
  }, [])
  const showSoon = useCallback(() => {
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setOpen(true), delay)
  }, [delay])

  useEffect(() => () => window.clearTimeout(timer.current), [])
  useEffect(() => {
    if (disabled) hide()
  }, [disabled, hide])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide()
    }
    const onScroll = () => hide()
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
    }
  }, [open, hide])

  // Hide when the trigger disappears (e.g. unmounted while hovered).
  useEffect(() => {
    if (!open) return
    const t = window.setInterval(() => {
      if (!anchorRef.current || !anchorRef.current.isConnected) hide()
    }, 500)
    return () => window.clearInterval(t)
  }, [open, hide])

  useLayoutEffect(() => {
    if (!open) {
      setPos(null)
      return
    }
    const a = anchorRef.current
    const t = tipRef.current
    if (!a || !t) return
    const r = a.getBoundingClientRect()
    const w = t.offsetWidth
    const h = t.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let s = side
    if (s === 'top' && r.top - h - GAP < MARGIN) s = 'bottom'
    else if (s === 'bottom' && r.bottom + h + GAP > vh - MARGIN) s = 'top'
    else if (s === 'left' && r.left - w - GAP < MARGIN) s = 'right'
    else if (s === 'right' && r.right + w + GAP > vw - MARGIN) s = 'left'
    let left: number
    let top: number
    if (s === 'top' || s === 'bottom') {
      left = clamp(r.left + r.width / 2 - w / 2, MARGIN, vw - w - MARGIN)
      top = s === 'top' ? r.top - h - GAP : r.bottom + GAP
    } else {
      top = clamp(r.top + r.height / 2 - h / 2, MARGIN, vh - h - MARGIN)
      left = s === 'left' ? r.left - w - GAP : r.right + GAP
    }
    setPos({ left, top, side: s })
  }, [open, side, content])

  const child = Children.only(children)
  const childProps = (isValidElement(child) ? child.props : {}) as TriggerProps
  const ref = useMemo(() => mergeRefs<HTMLElement>(childProps.ref, anchorRef), [childProps.ref])

  if (!content || !isValidElement(child)) return child

  const trigger = cloneElement(child as ReactElement<TriggerProps>, {
    ref,
    onMouseEnter: chain(childProps.onMouseEnter, () => {
      if (!disabled) showSoon()
    }),
    onMouseLeave: chain(childProps.onMouseLeave, hide),
    onFocus: chain(childProps.onFocus, (e: FocusEvent<HTMLElement>) => {
      if (disabled) return
      // Only keyboard focus opens immediately; mouse focus waits for the hover delay.
      let visible = false
      try {
        visible = e.currentTarget.matches(':focus-visible')
      } catch {
        visible = false
      }
      if (visible) {
        window.clearTimeout(timer.current)
        setOpen(true)
      }
    }),
    onBlur: chain(childProps.onBlur, hide),
    onPointerDown: chain(childProps.onPointerDown, hide),
    'aria-describedby': open && describe ? clsx(childProps['aria-describedby'], id) : childProps['aria-describedby'],
  })

  return (
    <>
      {trigger}
      {open && (
        <Portal>
          <div
            ref={tipRef}
            id={id}
            role="tooltip"
            data-ui-layer="tooltip"
            data-side={pos?.side ?? side}
            className={clsx('ui-tooltip', pos && 'is-positioned')}
            style={pos ? { left: pos.left, top: pos.top } : { left: -9999, top: -9999 }}
          >
            {content}
          </div>
        </Portal>
      )}
    </>
  )
}
