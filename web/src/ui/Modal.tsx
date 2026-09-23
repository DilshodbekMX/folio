import {
  useEffect, useId, useLayoutEffect, useRef,
  type KeyboardEvent, type MouseEvent, type ReactNode, type RefObject,
} from 'react'
import clsx from 'clsx'
import { X } from 'lucide-react'
import { IconButton } from './Button'
import { Portal } from './Portal'
import { focusableWithin } from './utils'

export interface ModalProps {
  open: boolean
  onClose: () => void
  title: ReactNode
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** action row at the bottom (buttons are right-aligned) */
  footer?: ReactNode
  children?: ReactNode
  /** element to focus on open; otherwise the first [data-autofocus], then the first field/button in the body */
  initialFocus?: RefObject<HTMLElement | null>
  /** clicking the backdrop closes (default true) */
  closeOnBackdrop?: boolean
  /** hide the × button in the header */
  hideClose?: boolean
  className?: string
  bodyClassName?: string
  /** optional subtitle under the title */
  description?: ReactNode
}

// Stack of open modals: only the top one reacts to Esc / traps focus; the rest of the page
// (and lower modals) are made inert.
interface StackEntry { id: string; el: HTMLElement | null }
const stack: StackEntry[] = []

function syncInert() {
  const root = document.getElementById('root')
  if (root) root.inert = stack.length > 0
  stack.forEach((entry, i) => {
    if (entry.el) entry.el.inert = i !== stack.length - 1
  })
}

function isTop(id: string): boolean {
  return stack.length > 0 && stack[stack.length - 1].id === id
}

export function Modal({
  open, onClose, title, size = 'md', footer, children, initialFocus, closeOnBackdrop = true, hideClose = false,
  className, bodyClassName, description,
}: ModalProps) {
  if (!open) return null
  return (
    <ModalImpl
      onClose={onClose}
      title={title}
      size={size}
      footer={footer}
      initialFocus={initialFocus}
      closeOnBackdrop={closeOnBackdrop}
      hideClose={hideClose}
      className={className}
      bodyClassName={bodyClassName}
      description={description}
    >
      {children}
    </ModalImpl>
  )
}

function ModalImpl({
  onClose, title, size, footer, children, initialFocus, closeOnBackdrop, hideClose, className, bodyClassName, description,
}: Omit<ModalProps, 'open'>) {
  const id = useId()
  const titleId = `${id}-title`
  const descId = `${id}-desc`
  const rootRef = useRef<HTMLDivElement | null>(null)
  const dialogRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const downOnBackdrop = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Register in the stack before paint so inert/focus are right on the first frame.
  useLayoutEffect(() => {
    const entry: StackEntry = { id, el: rootRef.current }
    stack.push(entry)
    syncInert()
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null

    const dialog = dialogRef.current
    const target =
      initialFocus?.current ??
      dialog?.querySelector<HTMLElement>('[data-autofocus]') ??
      (bodyRef.current ? focusableWithin(bodyRef.current)[0] : undefined) ??
      dialog
    target?.focus({ preventScroll: true })

    return () => {
      const i = stack.indexOf(entry)
      if (i >= 0) stack.splice(i, 1)
      syncInert()
      // Restore focus only when it would otherwise be lost (a following modal/menu may own it).
      if (previouslyFocused?.isConnected && (document.activeElement === document.body || document.activeElement === null || !document.activeElement.isConnected || rootRef.current?.contains(document.activeElement))) {
        previouslyFocused.focus({ preventScroll: true })
      }
    }
    // Mount/unmount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // If focus escapes to the page (e.g. programmatic focus), pull it back into the top modal.
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      if (!isTop(id)) return
      const t = e.target
      if (!(t instanceof Element)) return
      if (rootRef.current?.contains(t)) return
      if (t.closest('[data-ui-layer]')) return // menus, tooltips, toasts, other dialogs
      dialogRef.current?.focus({ preventScroll: true })
    }
    document.addEventListener('focusin', onFocusIn)
    return () => document.removeEventListener('focusin', onFocusIn)
  }, [id])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!isTop(id)) return
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.stopPropagation()
      e.preventDefault()
      onCloseRef.current()
      return
    }
    if (e.key === 'Tab' && dialogRef.current) {
      const items = focusableWithin(dialogRef.current)
      if (items.length === 0) {
        e.preventDefault()
        dialogRef.current.focus()
        return
      }
      const first = items[0]
      const last = items[items.length - 1]
      const active = document.activeElement
      if (e.shiftKey && (active === first || active === dialogRef.current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && active === last) {
        e.preventDefault()
        first.focus()
      } else if (!(active instanceof Node) || !dialogRef.current.contains(active)) {
        e.preventDefault()
        first.focus()
      }
    }
  }

  const onRootMouseDown = (e: MouseEvent<HTMLDivElement>) => {
    downOnBackdrop.current = e.target === e.currentTarget
  }
  const onRootClick = (e: MouseEvent<HTMLDivElement>) => {
    if (closeOnBackdrop && downOnBackdrop.current && e.target === e.currentTarget && isTop(id)) onCloseRef.current()
    downOnBackdrop.current = false
  }

  return (
    <Portal>
      <div
        ref={rootRef}
        className="ui-modal-root"
        data-ui-layer="modal"
        onMouseDown={onRootMouseDown}
        onClick={onRootClick}
        onKeyDown={onKeyDown}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={description ? descId : undefined}
          tabIndex={-1}
          className={clsx('ui-modal', `ui-modal--${size}`, className)}
        >
          <header className="ui-modal__header">
            <div className="ui-modal__titles">
              <h2 id={titleId} className="ui-modal__title">{title}</h2>
              {description && <p id={descId} className="ui-modal__desc">{description}</p>}
            </div>
            {!hideClose && (
              <IconButton icon={X} label="Close" size="md" onClick={() => onCloseRef.current()} tooltip={false} className="ui-modal__close" />
            )}
          </header>
          <div ref={bodyRef} className={clsx('ui-modal__body', bodyClassName)}>
            {children}
          </div>
          {footer && <footer className="ui-modal__footer">{footer}</footer>}
        </div>
      </div>
    </Portal>
  )
}
