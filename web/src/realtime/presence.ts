import type { UserPublic } from '@folio/shared/api'
import type { MetaPresence, PresenceUser } from '@folio/shared/protocol'
import { colorLight, safeColor } from '../lib/colors'
import { isRecord } from '../lib/storage'

/** Awareness user for doc and meta rooms: { id, name, color, colorLight: color + '33' }. */
export function presenceUser(user: UserPublic): PresenceUser {
  const color = safeColor(user.color)
  return { id: user.id, name: user.name, color, colorLight: colorLight(color) }
}

/** Validate a remote awareness `user` field (never trust peers' state shapes). */
export function parsePresenceUser(v: unknown): PresenceUser | null {
  if (!isRecord(v)) return null
  if (typeof v.id !== 'string' || typeof v.name !== 'string') return null
  const color = safeColor(typeof v.color === 'string' ? v.color : null)
  const light = typeof v.colorLight === 'string' && v.colorLight ? v.colorLight : colorLight(color)
  return { id: v.id, name: v.name.slice(0, 200), color, colorLight: light }
}

/** Validate a remote meta-room awareness state. */
export function parseMetaPresence(v: unknown): MetaPresence | null {
  if (!isRecord(v)) return null
  const user = parsePresenceUser(v.user)
  if (!user) return null
  const openFileId = typeof v.openFileId === 'string' && v.openFileId ? v.openFileId : null
  return { user, openFileId }
}
