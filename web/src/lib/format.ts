/** Small text formatting helpers shared by features. */

/** '0 B', '999 B', '1.2 KB', '3.4 MB' (1 KB = 1024 B). */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  if (bytes < 1024) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

/** '1 file', '3 files'; `plural` defaults to word + 's'. */
export function pluralize(n: number, word: string, plural: string = `${word}s`): string {
  return `${n} ${n === 1 ? word : plural}`
}

/** Up to two initials for avatars: 'Ada Lovelace' → 'AL', 'alice@x.org' → 'A'. */
export function initials(name: string): string {
  const clean = name.trim().replace(/@.*$/, '')
  if (!clean) return '?'
  const words = clean.split(/[\s._-]+/).filter(Boolean)
  const first = Array.from(words[0] ?? clean)[0] ?? '?'
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] ?? '' : ''
  return (first + last).toUpperCase()
}

/** Shorten long strings in the middle: 'figures/very/long/name.png' → 'figures/…/name.png'. */
export function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s
  if (max <= 1) return '…'
  const head = Math.ceil((max - 1) / 2)
  const tail = Math.floor((max - 1) / 2)
  return `${s.slice(0, head)}…${tail > 0 ? s.slice(s.length - tail) : ''}`
}

/** URL-safe random id (for nonces and client-side keys). */
export function randomId(length = 16): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'
  const bytes = new Uint8Array(length)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes)
  else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256)
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet[bytes[i] & 63]
  return out
}
