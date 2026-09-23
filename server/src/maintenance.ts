/**
 * Periodic housekeeping, started by main.ts after the server listens:
 *
 *   every minute   close sockets whose session ended (expiry, CLI reset-password, deleted rows)
 *   every hour     purge expired session rows; compile housekeeping (build retention, idle
 *                  compile dirs > 3 days, leftovers of deleted projects, old previews);
 *                  stale temp files (> 6 h) in DATA_DIR/tmp
 *
 * The first hourly run happens a couple of minutes after boot so start-up stays fast. Every task
 * is guarded: a failure is logged and retried on the next tick. All timers are unref'd.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { sweepSessionSockets } from './auth/live.ts'
import { moduleLog } from './log.ts'
import type { Services } from './services.ts'

const log = moduleLog('maintenance')

export interface MaintenanceOptions {
  sessionSweepMs?: number
  hourlyMs?: number
  firstHourlyDelayMs?: number
  tmpMaxAgeMs?: number
}

export interface Maintenance {
  /** run the hourly tasks now (tests, diagnostics) */
  runHourly(): Promise<void>
  stop(): void
}

/** Remove entries of `dir` older than `maxAgeMs` (upload / import / atomic-write leftovers). */
export async function cleanTmpDir(dir: string, maxAgeMs: number, now = Date.now()): Promise<number> {
  let n = 0
  for (const name of await fsp.readdir(dir).catch(() => [] as string[])) {
    const p = path.join(dir, name)
    try {
      const st = await fsp.lstat(p)
      if (now - st.mtimeMs > maxAgeMs) {
        await fsp.rm(p, { recursive: true, force: true })
        n++
      }
    } catch {
      /* raced with its owner */
    }
  }
  return n
}

type Sweepable = { sweep?: () => Promise<unknown> }

export function startMaintenance(s: Services, o: MaintenanceOptions = {}): Maintenance {
  const sessionSweepMs = o.sessionSweepMs ?? 60_000
  const hourlyMs = o.hourlyMs ?? 60 * 60 * 1000
  const tmpMaxAgeMs = o.tmpMaxAgeMs ?? 6 * 60 * 60 * 1000
  let hourlyRunning: Promise<void> | null = null
  let stopped = false

  const guard = (what: string, fn: () => unknown) => {
    try {
      const r = fn()
      if (r && typeof (r as Promise<unknown>).then === 'function') return (r as Promise<unknown>).catch(err => log.warn({ err }, `${what} failed`))
    } catch (err) {
      log.warn({ err }, `${what} failed`)
    }
    return undefined
  }

  async function hourly(): Promise<void> {
    await guard('session purge', () => {
      const n = s.db.sessions.purgeExpired()
      if (n) log.info({ sessions: n }, 'purged expired sessions')
    })
    await guard('compile housekeeping', () => (s.compile as Sweepable).sweep?.())
    await guard('tmp cleanup', async () => {
      const n = await cleanTmpDir(s.config.dirs.tmp, tmpMaxAgeMs)
      if (n) log.info({ entries: n }, 'removed stale temp files')
    })
  }

  const runHourly = (): Promise<void> => {
    if (stopped) return Promise.resolve()
    hourlyRunning ??= hourly().finally(() => { hourlyRunning = null })
    return hourlyRunning
  }

  const sessions = setInterval(() => guard('session socket sweep', () => sweepSessionSockets(s)), sessionSweepMs)
  sessions.unref()
  const first = setTimeout(() => void runHourly(), o.firstHourlyDelayMs ?? 2 * 60 * 1000)
  first.unref()
  const hourlyTimer = setInterval(() => void runHourly(), hourlyMs)
  hourlyTimer.unref()

  return {
    runHourly,
    stop() {
      stopped = true
      clearInterval(sessions)
      clearTimeout(first)
      clearInterval(hourlyTimer)
    },
  }
}
