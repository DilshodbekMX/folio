/**
 * Time formatting for the UI (dashboard "last modified", history version list, chat).
 * Output is English and locale-independent so it matches the rest of the UI copy.
 */

export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** Local midnight of the day containing `ts`. */
export function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** Whole calendar days between the local days of `ts` and `now` (0 = same day, 1 = yesterday). */
export function calendarDaysAgo(ts: number, now: number = Date.now()): number {
  return Math.round((startOfDay(now) - startOfDay(ts)) / DAY)
}

/** '14:05' (24-hour, local time). */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
}

/** '21 Sep' in the current year, '21 Sep 2025' otherwise. */
export function formatDate(ts: number, now: number = Date.now()): string {
  const d = new Date(ts)
  const base = `${d.getDate()} ${MONTHS[d.getMonth()]}`
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`
}

/** '21 Sep 2026, 14:05' */
export function formatDateTime(ts: number): string {
  const d = new Date(ts)
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${formatTime(ts)}`
}

/**
 * Relative time: 'just now', '1 minute ago', '5 minutes ago', '2 hours ago', 'yesterday',
 * '3 days ago', then an absolute date ('12 Aug', '3 Mar 2025').
 */
export function formatRelative(ts: number, now: number = Date.now()): string {
  const diff = now - ts
  if (diff < 0) return diff > -MINUTE ? 'just now' : formatDateTime(ts) // clock skew
  if (diff < 45 * SECOND) return 'just now'
  if (diff < 90 * SECOND) return '1 minute ago'
  if (diff < 45 * MINUTE) return `${Math.round(diff / MINUTE)} minutes ago`
  if (diff < 90 * MINUTE) return '1 hour ago'
  const days = calendarDaysAgo(ts, now)
  if (diff < 22 * HOUR || days === 0) return `${Math.max(2, Math.round(diff / HOUR))} hours ago`
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days} days ago`
  return formatDate(ts, now)
}

/** Stable local-day key 'YYYY-MM-DD'. */
export function dayKey(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

/** Day heading: 'Today', 'Yesterday', 'Monday, 14 September', 'Friday, 3 March 2025'. */
export function formatDayLabel(ts: number, now: number = Date.now()): string {
  const days = calendarDaysAgo(ts, now)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  const d = new Date(ts)
  const base = `${WEEKDAYS[d.getDay()]}, ${d.getDate()} ${MONTHS_LONG[d.getMonth()]}`
  return d.getFullYear() === new Date(now).getFullYear() ? base : `${base} ${d.getFullYear()}`
}

export interface DayGroup<T> {
  /** 'YYYY-MM-DD' */
  key: string
  /** 'Today', 'Yesterday', 'Monday, 14 September' … */
  label: string
  items: T[]
}

/** Group items by local day, keeping the input order (groups appear in order of first occurrence). */
export function groupByDay<T>(items: readonly T[], getTime: (item: T) => number, now: number = Date.now()): DayGroup<T>[] {
  const groups: DayGroup<T>[] = []
  const byKey = new Map<string, DayGroup<T>>()
  for (const item of items) {
    const ts = getTime(item)
    const key = dayKey(ts)
    let g = byKey.get(key)
    if (!g) {
      g = { key, label: formatDayLabel(ts, now), items: [] }
      byKey.set(key, g)
      groups.push(g)
    }
    g.items.push(item)
  }
  return groups
}

/**
 * '850 ms', '2.3 s', '42 s', '1 min 5 s', '2 min'. Rounded once, then split, so a value just
 * under a boundary reads as the next unit ('1.0 s', '10 s', '1 min', '2 min' — never '1000 ms',
 * '10.0 s', '60 s' or '1 min 60 s').
 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const whole = Math.round(ms)
  if (whole < SECOND) return `${whole} ms`
  // one decimal below 10 s
  const tenths = Math.round(ms / 100)
  if (tenths < 100) return `${(tenths / 10).toFixed(1)} s`
  const total = Math.round(ms / SECOND)
  if (total < 60) return `${total} s`
  const min = Math.floor(total / 60)
  const s = total % 60
  return s === 0 ? `${min} min` : `${min} min ${s} s`
}
