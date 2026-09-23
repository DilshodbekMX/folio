/**
 * Compile coordinator (SPEC §4.5 "Coordinator"):
 *
 *   - per project single-flight: while a compile runs, further requests are coalesced into one
 *     queued follow-up PER ROOT DOCUMENT (newest request wins; a manual or from-scratch request
 *     anywhere in the burst keeps the follow-up manual / from scratch) and every waiting caller
 *     gets the result of the root it asked for. Requests for different roots (the main document
 *     and an open supplement, `req.rootFileId`) are never merged: they queue in arrival order;
 *   - per-user 1 s guard for auto compiles → 'too-recently-compiled';
 *   - snapshot-hash dedupe: an auto compile whose snapshot equals the last successful build of
 *     its root returns that build (`cached: true`) without starting TeX; manual compiles always run;
 *   - global concurrency limit (a FIFO of slots); 'unavailable' when the backlog waiting for a
 *     slot would exceed 2 × the limit;
 *   - stop: aborts the running compile (the runner kills its container → 'terminated') and
 *     cancels the queued follow-ups. A compile still waiting for a global slot leaves the queue
 *     at once ('terminated'), so stop never waits for other projects' compiles.
 *
 * The coordinator is generic over the snapshot type; project I/O lives in the hooks (index.ts).
 */
import type { CompileRequest, CompileResponse, CompileStatus, UserPublic } from '@folio/shared/api'

export interface CompileJob {
  projectId: string
  user: UserPublic
  req: CompileRequest
  /** when the (first coalesced) request arrived */
  requestedAt: number
}

export interface PreparedSnapshot {
  /** content hash of everything that influences the output */
  hash: string
}

export interface CoordinatorHooks<P extends PreparedSnapshot> {
  /** Snapshot the project. May short-circuit with a final response (e.g. 'no-root'). */
  prepare(job: CompileJob): Promise<{ prepared: P } | { response: CompileResponse }>
  /** Sync + TeX + outputs. Compile failures are reported through the status, not thrown. */
  execute(job: CompileJob, prepared: P, signal: AbortSignal): Promise<CompileResponse>
  /** A response that carries only a status (no build). */
  statusOnly(job: CompileJob, status: CompileStatus, message: string): CompileResponse
  /** The last successful build of the prepared root if its snapshot hash equals `prepared.hash` (and it still exists), marked cached. */
  cachedBuild(projectId: string, prepared: P): Promise<CompileResponse | null>
}

export interface CoordinatorOptions {
  maxConcurrent: number
  /** per-user minimum interval between auto compiles of one project (default 1000 ms) */
  userGuardMs?: number
  now?: () => number
}

interface Waiter {
  resolve: (r: CompileResponse) => void
  reject: (e: unknown) => void
}

interface Running {
  job: CompileJob
  abort: AbortController
  done: Promise<CompileResponse>
}

interface Pending {
  /** the requested root document ('' = the project's main document) */
  key: string
  job: CompileJob
  waiters: Waiter[]
}

interface ProjectSlot {
  running: Running | null
  /** queued follow-ups, at most one per root document, in arrival order */
  pending: Pending[]
}

/** Follow-ups are coalesced per requested root document only. */
function rootKey(job: CompileJob): string {
  return job.req.rootFileId ?? ''
}

/**
 * FIFO of global compile slots. Unlike p-limit, a waiter can leave the queue: a stopped compile
 * that is still waiting for a slot settles at once instead of when another project's compile
 * ends.
 */
class Slots {
  active = 0
  private readonly queue: { grant: () => void }[] = []

  constructor(private readonly max: number) {}

  /** compiles waiting for a slot */
  get waiting(): number {
    return this.queue.length
  }

  /** Resolves true once a slot is held, false when `signal` aborts first (nothing is held then). */
  acquire(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false)
    if (this.active < this.max) {
      this.active++
      return Promise.resolve(true)
    }
    return new Promise<boolean>(resolve => {
      const waiter = {
        grant: () => {
          signal.removeEventListener('abort', onAbort)
          this.active++
          resolve(true)
        },
      }
      const onAbort = () => {
        const i = this.queue.indexOf(waiter)
        if (i >= 0) this.queue.splice(i, 1)
        resolve(false)
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.queue.push(waiter)
    })
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
    while (this.active < this.max && this.queue.length > 0) this.queue.shift()!.grant()
  }
}

function mergeJobs(older: CompileJob, newer: CompileJob): CompileJob {
  return {
    ...newer,
    req: {
      ...newer.req,
      auto: !!older.req.auto && !!newer.req.auto,
      fromScratch: !!older.req.fromScratch || !!newer.req.fromScratch,
    },
    requestedAt: Math.min(older.requestedAt, newer.requestedAt),
  }
}

export class CompileCoordinator<P extends PreparedSnapshot> {
  private readonly slots = new Map<string, ProjectSlot>()
  private readonly lastRequest = new Map<string, number>()
  private readonly limit: Slots
  private readonly guardMs: number
  private readonly now: () => number
  private closed = false

  constructor(private readonly hooks: CoordinatorHooks<P>, private readonly opts: CoordinatorOptions) {
    this.limit = new Slots(Math.max(1, opts.maxConcurrent))
    this.guardMs = opts.userGuardMs ?? 1000
    this.now = opts.now ?? Date.now
  }

  /** compiles waiting for a global slot */
  get backlog(): number {
    return this.limit.waiting
  }

  get active(): number {
    return this.limit.active
  }

  isRunning(projectId: string): boolean {
    return !!this.slots.get(projectId)?.running
  }

  compile(job: CompileJob): Promise<CompileResponse> {
    if (this.closed) return Promise.resolve(this.hooks.statusOnly(job, 'unavailable', 'The server is shutting down.'))
    const now = this.now()
    const key = `${job.projectId}\u0000${job.user.id}`
    if (job.req.auto) {
      const last = this.lastRequest.get(key)
      if (last !== undefined && now - last < this.guardMs) {
        return Promise.resolve(this.hooks.statusOnly(job, 'too-recently-compiled', 'A compile was requested less than a second ago.'))
      }
    }
    this.lastRequest.set(key, now)
    if (this.lastRequest.size > 10_000) {
      for (const [k, t] of this.lastRequest) if (now - t >= this.guardMs) this.lastRequest.delete(k)
    }

    let slot = this.slots.get(job.projectId)
    if (!slot) {
      slot = { running: null, pending: [] }
      this.slots.set(job.projectId, slot)
    }
    if (!slot.running) return this.start(job.projectId, slot, job)
    const s = slot
    return new Promise<CompileResponse>((resolve, reject) => {
      const key = rootKey(job)
      const same = s.pending.find(p => p.key === key)
      if (same) {
        same.job = mergeJobs(same.job, job)
        same.waiters.push({ resolve, reject })
      } else {
        s.pending.push({ key, job, waiters: [{ resolve, reject }] })
      }
    })
  }

  private start(projectId: string, slot: ProjectSlot, job: CompileJob): Promise<CompileResponse> {
    const abort = new AbortController()
    const done = this.run(job, abort.signal)
    const running: Running = { job, abort, done }
    slot.running = running
    done
      .catch(() => undefined)
      .then(() => {
        if (slot.running === running) slot.running = null
        if (this.closed) {
          const all = slot.pending.splice(0)
          for (const p of all) for (const w of p.waiters) w.resolve(this.hooks.statusOnly(p.job, 'unavailable', 'The server is shutting down.'))
        }
        const next = slot.pending.shift()
        if (next) {
          this.start(projectId, slot, next.job).then(
            r => { for (const w of next.waiters) w.resolve(r) },
            e => { for (const w of next.waiters) w.reject(e) },
          )
        } else if (!slot.running && this.slots.get(projectId) === slot) {
          this.slots.delete(projectId)
        }
      })
    return done
  }

  private async run(job: CompileJob, signal: AbortSignal): Promise<CompileResponse> {
    const prep = await this.hooks.prepare(job)
    if ('response' in prep) return prep.response
    if (signal.aborted) return this.hooks.statusOnly(job, 'terminated', 'The compile was stopped.')
    if (job.req.auto && !job.req.fromScratch) {
      const cached = await this.hooks.cachedBuild(job.projectId, prep.prepared)
      if (cached) return cached
    }
    const max = Math.max(1, this.opts.maxConcurrent)
    if (this.limit.active >= max && this.limit.waiting >= 2 * max) {
      return this.hooks.statusOnly(job, 'unavailable', 'The compile server is busy; please try again in a moment.')
    }
    // a stop while waiting for a slot answers at once (the waiter leaves the queue)
    if (!await this.limit.acquire(signal)) return this.hooks.statusOnly(job, 'terminated', 'The compile was stopped.')
    try {
      if (signal.aborted) return this.hooks.statusOnly(job, 'terminated', 'The compile was stopped.')
      return await this.hooks.execute(job, prep.prepared, signal)
    } finally {
      this.limit.release()
    }
  }

  /** Kill the running compile (if any), cancel the queued follow-ups, wait (≤ 20 s) for the kill. */
  async stop(projectId: string): Promise<void> {
    const slot = this.slots.get(projectId)
    if (!slot) return
    for (const p of slot.pending.splice(0)) {
      for (const w of p.waiters) w.resolve(this.hooks.statusOnly(p.job, 'terminated', 'The compile was stopped.'))
    }
    const running = slot.running
    if (running) {
      running.abort.abort()
      await settleWithin(running.done, 20_000)
    }
  }

  /** Resolves when the project has no running compile (≤ timeoutMs). */
  async idle(projectId: string, timeoutMs = 60_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const running = this.slots.get(projectId)?.running
      if (!running || Date.now() >= deadline) return
      await settleWithin(running.done, deadline - Date.now())
    }
  }

  /** Forget a project (after it was deleted). */
  forget(projectId: string): void {
    for (const k of this.lastRequest.keys()) if (k.startsWith(`${projectId}\u0000`)) this.lastRequest.delete(k)
    const slot = this.slots.get(projectId)
    if (slot && !slot.running && slot.pending.length === 0) this.slots.delete(projectId)
  }

  /** Refuse new compiles, stop everything and wait for the running ones to finish. */
  async shutdown(): Promise<void> {
    this.closed = true
    await Promise.all([...this.slots.keys()].map(pid => this.stop(pid)))
  }
}

function settleWithin(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise(resolve => {
    const t = setTimeout(resolve, Math.max(0, ms))
    p.then(() => { clearTimeout(t); resolve() }, () => { clearTimeout(t); resolve() })
  })
}
