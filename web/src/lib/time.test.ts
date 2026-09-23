import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { calendarDaysAgo, formatDayLabel, formatDuration, formatRelative, groupByDay } from './time'

describe('formatDuration', () => {
  it('rounds once, so values just under a boundary read as the next unit (ACC-7)', () => {
    expect(formatDuration(119_600)).toBe('2 min')
    expect(formatDuration(179_999)).toBe('3 min')
    expect(formatDuration(59_960)).toBe('1 min')
    expect(formatDuration(3_599_999)).toBe('60 min')
    expect(formatDuration(999.6)).toBe('1.0 s')
    expect(formatDuration(9_960)).toBe('10 s')
  })

  it('keeps each unit below its boundary', () => {
    expect(formatDuration(0)).toBe('0 ms')
    expect(formatDuration(999.4)).toBe('999 ms')
    expect(formatDuration(1_500)).toBe('1.5 s')
    expect(formatDuration(9_940)).toBe('9.9 s')
    expect(formatDuration(42_400)).toBe('42 s')
    expect(formatDuration(59_400)).toBe('59 s')
    expect(formatDuration(60_000)).toBe('1 min')
    expect(formatDuration(65_000)).toBe('1 min 5 s')
    expect(formatDuration(119_400)).toBe('1 min 59 s')
  })

  it('never prints a 60 in the seconds', () => {
    for (let ms = 0; ms < 10 * 60_000; ms += 97) {
      const out = formatDuration(ms)
      expect(out).not.toMatch(/(^| )60 s$/)
      expect(out).not.toBe('1000 ms')
      expect(out).not.toBe('10.0 s')
    }
  })

  it('shows a dash for nonsense', () => {
    expect(formatDuration(-1)).toBe('—')
    expect(formatDuration(Number.NaN)).toBe('—')
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('—')
  })
})

// the tests run in Node (the web tsconfig has no Node types); Node applies a changed TZ at once
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env

describe('calendar days across a DST change (Europe/Berlin)', () => {
  const tz = env.TZ
  beforeAll(() => {
    env.TZ = 'Europe/Berlin'
  })
  afterAll(() => {
    if (tz === undefined) delete env.TZ
    else env.TZ = tz
  })

  // 2026-03-29: clocks go from 02:00 to 03:00 (a 23-hour day); 2026-10-25: 03:00 back to 02:00 (25 hours)
  const local = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()

  it('the day before a spring-forward day is "yesterday"', () => {
    const now = local(2026, 3, 29, 12)
    const ts = local(2026, 3, 28, 12)
    expect(now - ts).toBe(23 * 3600_000)
    expect(calendarDaysAgo(ts, now)).toBe(1)
    expect(formatDayLabel(ts, now)).toBe('Yesterday')
    expect(formatRelative(local(2026, 3, 28, 9), now)).toBe('yesterday')
  })

  it('the day before a fall-back day is "yesterday", two days back is not', () => {
    const now = local(2026, 10, 25, 12)
    expect(calendarDaysAgo(local(2026, 10, 24, 12), now)).toBe(1)
    expect(calendarDaysAgo(local(2026, 10, 24, 0, 30), now)).toBe(1)
    expect(calendarDaysAgo(local(2026, 10, 23, 23, 59), now)).toBe(2)
    expect(formatDayLabel(local(2026, 10, 23, 23, 59), now)).toBe('Friday, 23 October')
  })

  it('groups by local day in input order', () => {
    const now = local(2026, 3, 29, 20)
    const items = [local(2026, 3, 29, 1), local(2026, 3, 29, 4), local(2026, 3, 28, 23, 30), local(2025, 12, 31, 8)]
    const groups = groupByDay(items, t => t, now)
    expect(groups.map(g => [g.key, g.label, g.items.length])).toEqual([
      ['2026-03-29', 'Today', 2],
      ['2026-03-28', 'Yesterday', 1],
      ['2025-12-31', 'Wednesday, 31 December 2025', 1],
    ])
  })
})
