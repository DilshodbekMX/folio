/**
 * Snapshot scheduler (SPEC §4.6 snapshot policy): activity on a project arms an idle timer
 * (default 30 s after the last activity) and, on the first activity of a window, a max-wait
 * timer (default 5 min) so continuous editing is still captured. Whichever fires first
 * triggers one snapshot; both timers are then cleared.
 *
 * `noteActivity` is called for every collaborative edit, so it must stay cheap: instead of
 * re-arming the idle timer on each call it only records the time, and the timer re-arms
 * itself for the remainder when it fires early.
 */

export interface SchedulerTiming {
  idleMs: number
  maxMs: number
}

interface Pending {
  users: Set<string>
  last: number
  idle: NodeJS.Timeout | null
  max: NodeJS.Timeout | null
}

export class SnapshotScheduler {
  private pending = new Map<string, Pending>()

  constructor(
    private readonly timing: SchedulerTiming,
    /** called when a project's timers fire; receives the users noted since the last take */
    private readonly onFire: (projectId: string, users: string[]) => void,
  ) {}

  /** Record activity; returns true when `userId` is new in the project's pending window. */
  note(projectId: string, userId: string | null): boolean {
    const now = Date.now()
    let p = this.pending.get(projectId)
    if (!p) {
      p = { users: new Set(), last: now, idle: null, max: null }
      p.max = unref(setTimeout(() => this.fire(projectId), this.timing.maxMs))
      this.pending.set(projectId, p)
    }
    p.last = now
    const added = !!userId && !p.users.has(userId)
    if (userId) p.users.add(userId)
    if (!p.idle) p.idle = this.armIdle(projectId, this.timing.idleMs)
    return added
  }

  /** Users noted in the project's pending window (without taking it). */
  users(projectId: string): string[] {
    const p = this.pending.get(projectId)
    return p ? [...p.users] : []
  }

  /** Remove the project's pending window (clearing its timers); returns its users, or null when nothing was pending. */
  take(projectId: string): string[] | null {
    const p = this.pending.get(projectId)
    if (!p) return null
    this.pending.delete(projectId)
    if (p.idle) clearTimeout(p.idle)
    if (p.max) clearTimeout(p.max)
    return [...p.users]
  }

  has(projectId: string): boolean {
    return this.pending.has(projectId)
  }

  pendingProjects(): string[] {
    return [...this.pending.keys()]
  }

  cancel(projectId: string): void {
    this.take(projectId)
  }

  cancelAll(): void {
    for (const pid of this.pendingProjects()) this.take(pid)
  }

  private armIdle(projectId: string, delay: number): NodeJS.Timeout {
    return unref(setTimeout(() => {
      const p = this.pending.get(projectId)
      if (!p) return
      p.idle = null
      const quiet = Date.now() - p.last
      if (quiet < this.timing.idleMs) {
        p.idle = this.armIdle(projectId, this.timing.idleMs - quiet)
        return
      }
      this.fire(projectId)
    }, Math.max(1, delay)))
  }

  private fire(projectId: string): void {
    const users = this.take(projectId)
    if (users) this.onFire(projectId, users)
  }
}

function unref(t: NodeJS.Timeout): NodeJS.Timeout {
  t.unref?.()
  return t
}
