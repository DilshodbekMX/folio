import clsx from 'clsx'
import type { ReactNode } from 'react'
import { renderIcon, type IconProp } from './icon'
import { formatShortcut, shortcutParts } from './utils'

export interface EmptyStateProps {
  icon?: IconProp
  title: ReactNode
  children?: ReactNode
  /** buttons under the text */
  actions?: ReactNode
  className?: string
  size?: 'sm' | 'md'
}

export function EmptyState({ icon, title, children, actions, className, size = 'md' }: EmptyStateProps) {
  return (
    <div className={clsx('ui-empty', `ui-empty--${size}`, className)}>
      {icon !== undefined && <div className="ui-empty__icon">{renderIcon(icon, size === 'sm' ? 20 : 28)}</div>}
      <div className="ui-empty__title">{title}</div>
      {children && <div className="ui-empty__body">{children}</div>}
      {actions && <div className="ui-empty__actions">{actions}</div>}
    </div>
  )
}

export interface KbdProps {
  /** literal key text… */
  children?: ReactNode
  /** …or a CodeMirror-style spec rendered for the current platform ('Mod-Enter' → ⌘↵ / Ctrl+Enter) */
  keys?: string
  className?: string
}

export function Kbd({ children, keys, className }: KbdProps) {
  if (keys) {
    const parts = shortcutParts(keys)
    return (
      <span className={clsx('ui-kbd-group', className)} aria-label={formatShortcut(keys)}>
        {parts.map((p, i) => (
          <kbd key={i} className="ui-kbd" aria-hidden="true">
            {p}
          </kbd>
        ))}
      </span>
    )
  }
  return <kbd className={clsx('ui-kbd', className)}>{children}</kbd>
}

/**
 * Temporary stand-in used by wave-1 placeholders of feature components; the owning
 * feature replaces it with the real component.
 */
export function Placeholder({ name, note, className }: { name: string; note?: ReactNode; className?: string }) {
  return (
    <div className={clsx('ui-placeholder', className)} data-placeholder={name}>
      <span className="ui-placeholder__name">{name}</span>
      <span className="ui-placeholder__note">{note ?? 'Coming soon'}</span>
    </div>
  )
}
