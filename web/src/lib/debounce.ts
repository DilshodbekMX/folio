/**
 * lodash-style debounce with `maxWait` (used e.g. by auto-compile: 2500 ms debounce, 5000 ms max wait).
 */

export interface DebounceOptions {
  /** the function is invoked at most `maxWait` ms after the first call of a burst */
  maxWait?: number
  /** also invoke on the leading edge of a burst */
  leading?: boolean
  /** invoke on the trailing edge (default true) */
  trailing?: boolean
}

export interface Debounced<A extends unknown[]> {
  (...args: A): void
  /** drop a pending invocation */
  cancel(): void
  /** run a pending invocation now */
  flush(): void
  /** true while an invocation is scheduled */
  pending(): boolean
}

export function debounce<A extends unknown[]>(
  fn: (...args: A) => void,
  wait: number,
  opts: DebounceOptions = {},
): Debounced<A> {
  const leading = opts.leading ?? false
  const trailing = opts.trailing ?? true
  const maxWait = opts.maxWait !== undefined ? Math.max(opts.maxWait, wait) : undefined
  let timer: ReturnType<typeof setTimeout> | null = null
  let lastArgs: A | null = null
  // start of the current burst (first call since the last invocation)
  let burstStart = 0
  let lastCall = 0

  const invoke = () => {
    const args = lastArgs
    lastArgs = null
    if (args) fn(...args)
  }

  const schedule = (now: number) => {
    if (timer !== null) clearTimeout(timer)
    let delay = Math.max(0, lastCall + wait - now)
    if (maxWait !== undefined) delay = Math.min(delay, Math.max(0, burstStart + maxWait - now))
    timer = setTimeout(onTimer, delay)
  }

  const onTimer = () => {
    timer = null
    const now = Date.now()
    const quietEnough = now - lastCall >= wait
    const waitedTooLong = maxWait !== undefined && now - burstStart >= maxWait
    if (quietEnough || waitedTooLong) {
      if (trailing) invoke()
      else lastArgs = null
      burstStart = 0
      return
    }
    schedule(now)
  }

  const debounced = ((...args: A) => {
    const now = Date.now()
    lastCall = now
    lastArgs = args
    if (timer === null) {
      burstStart = now
      if (leading) invoke()
    }
    schedule(now)
  }) as Debounced<A>

  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    lastArgs = null
    burstStart = 0
  }
  debounced.flush = () => {
    if (timer === null) return
    clearTimeout(timer)
    timer = null
    burstStart = 0
    invoke()
  }
  debounced.pending = () => timer !== null

  return debounced
}

/** Invoke at most once per `wait` ms (leading + trailing). */
export function throttle<A extends unknown[]>(fn: (...args: A) => void, wait: number): Debounced<A> {
  return debounce(fn, wait, { leading: true, trailing: true, maxWait: wait })
}
