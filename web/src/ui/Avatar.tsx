import clsx from 'clsx'
import type { ReactNode } from 'react'
import { DropdownMenu } from './DropdownMenu'
import type { MenuItem } from './Menu'
import { Tooltip } from './Tooltip'

export interface AvatarUser {
  name: string
  color: string
  id?: string
}

/** Up to two initials: "Ada Lovelace" → "AL", "grace" → "G". */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._@-]+/).filter(Boolean)
  if (words.length === 0) return '?'
  const first = Array.from(words[0])[0] ?? ''
  const second = words.length > 1 ? (Array.from(words[words.length - 1])[0] ?? '') : ''
  return (first + second).toUpperCase()
}

/** Dark or light text for a background colour (WCAG relative luminance). */
export function readableTextOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return '#ffffff'
  const n = parseInt(m[1], 16)
  const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  const lum = 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2]
  // White initials read best on mid/dark colours; switch to near-black below 3:1 contrast.
  return 1.05 / (lum + 0.05) >= 3 ? '#ffffff' : '#10160f'
}

export interface AvatarProps {
  user: AvatarUser
  size?: number
  className?: string
  /** decorative avatars next to a visible name should pass true */
  decorative?: boolean
}

export function Avatar({ user, size = 24, className, decorative = false }: AvatarProps) {
  return (
    <span
      className={clsx('ui-avatar', className)}
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : user.name}
      aria-hidden={decorative || undefined}
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.42)),
        background: user.color,
        color: readableTextOn(user.color),
      }}
    >
      {initials(user.name)}
    </span>
  )
}

export interface AvatarStackUser extends AvatarUser {
  /** secondary tooltip line, e.g. the file the user is in */
  detail?: ReactNode
}

export interface AvatarStackProps {
  users: AvatarStackUser[]
  /** maximum avatars shown including the "+N" overflow chip (default 5) */
  max?: number
  size?: number
  /** makes avatars clickable (e.g. jump to that user's file) */
  onSelect?: (user: AvatarStackUser) => void
  className?: string
}

export function AvatarStack({ users, max = 5, size = 26, onSelect, className }: AvatarStackProps) {
  if (users.length === 0) return null
  const overflow = users.length > max ? users.slice(max - 1) : []
  const shown = overflow.length ? users.slice(0, max - 1) : users
  const tip = (u: AvatarStackUser) => (
    <span className="ui-avatarstack__tip">
      <strong>{u.name}</strong>
      {u.detail && <span>{u.detail}</span>}
    </span>
  )
  const overflowItems: MenuItem[] = overflow.map((u, i) => ({
    id: u.id ?? `${i}`,
    label: u.name,
    description: u.detail,
    icon: <Avatar user={u} size={18} decorative />,
    onSelect: onSelect ? () => onSelect(u) : undefined,
  }))
  return (
    <div className={clsx('ui-avatarstack', className)} role="group" aria-label={`${users.length} online`}>
      {shown.map((u, i) => (
        <Tooltip key={u.id ?? i} content={tip(u)} side="bottom" describe={false}>
          {onSelect ? (
            <button type="button" className="ui-avatarstack__item" aria-label={`${u.name}${typeof u.detail === 'string' ? ` — ${u.detail}` : ''}`} onClick={() => onSelect(u)}>
              <Avatar user={u} size={size} decorative />
            </button>
          ) : (
            <span className="ui-avatarstack__item" tabIndex={0} aria-label={u.name}>
              <Avatar user={u} size={size} decorative />
            </span>
          )}
        </Tooltip>
      ))}
      {overflow.length > 0 && (
        <DropdownMenu
          align="end"
          items={overflowItems}
          trigger={
            <button type="button" className="ui-avatarstack__item ui-avatarstack__more" aria-label={`${overflow.length} more`} style={{ width: size, height: size }}>
              +{overflow.length}
            </button>
          }
        />
      )}
    </div>
  )
}
