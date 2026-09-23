import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

/**
 * Renders children into document.body. Every floating layer (modals, menus, tooltips, toasts)
 * goes through here and carries `data-ui-layer` so focus management can tell layers apart
 * from the page underneath.
 */
export function Portal({ children }: { children: ReactNode }) {
  if (typeof document === 'undefined') return null
  return createPortal(children, document.body)
}
