import type { ButtonHTMLAttributes, ReactNode, Ref } from 'react'
import clsx from 'clsx'
import { renderIcon, type IconProp } from './icon'
import { Spinner } from './Spinner'
import { Tooltip, type TooltipSide } from './Tooltip'

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant
  size?: 'sm' | 'md'
  /** leading icon (lucide component or element) */
  icon?: IconProp
  /** trailing icon, e.g. a chevron for split/menu buttons */
  iconRight?: IconProp
  /** shows a spinner in place of the icon and disables the button */
  loading?: boolean
  /** stretch to the container width */
  block?: boolean
  ref?: Ref<HTMLButtonElement>
}

export function Button({
  variant = 'secondary', size = 'md', icon, iconRight, loading = false, block = false,
  className, children, disabled, type = 'button', ref, ...rest
}: ButtonProps) {
  const iconSize = size === 'sm' ? 14 : 16
  return (
    <button
      ref={ref}
      type={type}
      className={clsx('ui-btn', `ui-btn--${variant}`, `ui-btn--${size}`, block && 'ui-btn--block', loading && 'is-loading', className)}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Spinner size={iconSize - 2} label={null} /> : renderIcon(icon, iconSize)}
      {children !== undefined && children !== null && children !== false && <span className="ui-btn__label">{children}</span>}
      {renderIcon(iconRight, iconSize)}
    </button>
  )
}

export interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  icon: IconProp
  /** accessible name; also shown as the tooltip unless `tooltip` overrides it */
  label: string
  /** toggle state (sets aria-pressed) — e.g. the active rail tab */
  active?: boolean
  size?: 'sm' | 'md' | 'lg'
  tooltipSide?: TooltipSide
  /** tooltip content; defaults to `label`; false disables the tooltip */
  tooltip?: ReactNode | false
  /** small count/dot badge in the corner (0, null or undefined hides it) */
  badge?: number | string | null
  badgeTone?: 'accent' | 'danger' | 'neutral'
  variant?: 'ghost' | 'secondary' | 'danger'
  ref?: Ref<HTMLButtonElement>
}

export function IconButton({
  icon, label, active, size = 'md', tooltipSide = 'bottom', tooltip, badge, badgeTone = 'accent',
  variant = 'ghost', className, type = 'button', ref, ...rest
}: IconButtonProps) {
  const iconSize = size === 'sm' ? 14 : size === 'lg' ? 18 : 16
  const showBadge = badge !== undefined && badge !== null && badge !== 0 && badge !== ''
  const button = (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      aria-pressed={active === undefined ? undefined : active}
      className={clsx('ui-iconbtn', `ui-iconbtn--${size}`, `ui-iconbtn--${variant}`, active && 'is-active', className)}
      {...rest}
    >
      {renderIcon(icon, iconSize)}
      {showBadge && (
        <span className={clsx('ui-iconbtn__badge', `ui-iconbtn__badge--${badgeTone}`)} aria-hidden="true">
          {typeof badge === 'number' && badge > 99 ? '99+' : badge}
        </span>
      )}
    </button>
  )
  if (tooltip === false) return button
  const content = tooltip ?? label
  return (
    <Tooltip content={content} side={tooltipSide} describe={content !== label}>
      {button}
    </Tooltip>
  )
}
