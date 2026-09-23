import { createElement, isValidElement, type ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

/**
 * Icons can be passed either as a lucide component (`icon={Plus}`) or as a ready element
 * (`icon={<Plus size={14} />}`). Components are rendered at the chrome's standard 16 px.
 */
export type IconProp = LucideIcon | ReactNode

function isComponent(icon: unknown): icon is LucideIcon {
  if (typeof icon === 'function') return true
  // forwardRef / memo components are objects carrying $$typeof but are not elements.
  return typeof icon === 'object' && icon !== null && '$$typeof' in icon && !isValidElement(icon) &&
    ('render' in icon || 'type' in icon)
}

export function renderIcon(icon: IconProp | undefined, size = 16): ReactNode {
  if (icon === undefined || icon === null || icon === false || icon === true) return null
  if (isComponent(icon)) return createElement(icon, { size, 'aria-hidden': true, focusable: false, strokeWidth: 1.9 })
  return icon as ReactNode
}
