import { afterEach, describe, expect, it } from 'vitest'
import { SnapshotScheduler } from '../../src/history/scheduler.ts'
import { setup, sleep, waitFor, type Harness } from './helpers.ts'

describe('SnapshotScheduler', () => {
  it('fires once after the idle period and re-arms for continuous activity until max', async () => {
    const fired: { pid: string; users: string[]; at: number }[] = []
    const sch = new SnapshotScheduler({ idleMs: 80, maxMs: 300 }, (pid, users) => fired.push({ pid, users, at: Date.now() }))
    const t0 = Date.now()
    sch.note('p1', 'u1')
    sch.note('p1', 'u2')
    sch.note('p1', null)
    await sleep(40)
    expect(fired).toEqual([])
    await waitFor(() => fired.length === 1, 2000, 5)
    expect(fired[0].users.sort()).toEqual(['u1', 'u2'])
    expect(fired[0].at - t0).toBeGreaterThanOrEqual(75)
    expect(sch.has('p1')).toBe(false)

    // continuous activity every 20 ms never goes idle; max (300 ms) forces the snapshot
    const t1 = Date.now()
    const iv = setInterval(() => sch.note('p2', 'u3'), 20)
    try {
      await waitFor(() => fired.length === 2, 2000, 5)
    } finally {
      clearInterval(iv)
    }
    expect(fired[1].pid).toBe('p2')
    expect(fired[1].at - t1).toBeGreaterThanOrEqual(290)
    expect(fired[1].at - t1).toBeLessThan(600)
    sch.cancelAll()
  })

  it('take() clears the window and its timers', async () => {
    const fired: string[] = []
    const sch = new SnapshotScheduler({ idleMs: 30, maxMs: 60 }, pid => fired.push(pid))
    sch.note('p', 'a')
    expect(sch.take('p')).toEqual(['a'])
    expect(sch.take('p')).toBeNull()
    await sleep(100)
    expect(fired).toEqual([])
  })
})

describe('history idle snapshots', () => {
  let h: Harness
  afterEach(async () => { await h.cleanup() })

  it('snapshots after the idle period with the active users as authors', async () => {
    h = await setup({ idleMs: 150, maxMs: 2000 })
    await h.put('main.tex', 'a\n')
    await h.history.init(h.pid, h.owner)
    await h.put('main.tex', 'b\n')
    h.history.noteActivity(h.pid, h.alice.id)
    h.collab.editors.set(h.pid, [h.bob.id])
    await sleep(60)
    expect((await h.history.list(h.pid, {})).versions).toHaveLength(1)
    const versions = await waitFor(async () => {
      const v = (await h.history.list(h.pid, {})).versions
      return v.length === 2 ? v : null
    })
    expect(versions[0].reason).toBe('auto')
    expect(versions[0].authors.map(a => a.id)).toEqual([h.bob.id, h.alice.id])
    // nothing else is pending afterwards
    await sleep(250)
    expect((await h.history.list(h.pid, {})).versions).toHaveLength(2)
  })

  it('file-tree operations schedule a snapshot through noteActivity', async () => {
    h = await setup({ idleMs: 100, maxMs: 1000 })
    await h.put('main.tex', 'a\n')
    await h.history.init(h.pid, h.owner)
    await h.files.create(h.pid, h.alice, 'chapter.tex', 'text', 'new chapter\n')
    const versions = await waitFor(async () => {
      const v = (await h.history.list(h.pid, {})).versions
      return v.length === 2 ? v : null
    })
    expect(versions[0].changes).toEqual([{ path: 'chapter.tex', op: 'added' }])
    expect(versions[0].authors).toEqual([h.alice])
  })

  it('an explicit snapshot absorbs the pending window', async () => {
    h = await setup({ idleMs: 120, maxMs: 1000 })
    await h.put('main.tex', 'a\n')
    await h.history.init(h.pid, h.owner)
    await h.put('main.tex', 'b\n')
    h.history.noteActivity(h.pid, h.alice.id)
    const sha = await h.history.snapshot(h.pid, 'manual', h.owner)
    const v = (await h.history.list(h.pid, {})).versions[0]
    expect(v.id).toBe(sha)
    expect(v.authors).toEqual([h.owner, h.alice])
    await sleep(300)
    expect((await h.history.list(h.pid, {})).versions).toHaveLength(2)
  })

  it('shutdown() commits pending windows and ignores later activity', async () => {
    h = await setup({ idleMs: 60_000, maxMs: 300_000 })
    await h.put('main.tex', 'a\n')
    await h.history.init(h.pid, h.owner)
    await h.put('main.tex', 'b\n')
    h.history.noteActivity(h.pid, h.alice.id)
    await h.history.shutdown()
    const { versions } = await h.history.list(h.pid, {})
    expect(versions).toHaveLength(2)
    expect(versions[0]).toMatchObject({ reason: 'shutdown', authors: [h.alice] })
    await h.put('main.tex', 'c\n')
    h.history.noteActivity(h.pid, h.alice.id) // ignored after shutdown
    await sleep(50)
    expect((await h.history.list(h.pid, {})).versions).toHaveLength(2)
  })
})
