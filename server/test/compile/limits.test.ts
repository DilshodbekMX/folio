/**
 * Resource limits for the auxiliary containers any viewer can trigger: word counts of one
 * document are coalesced, and texcount/Ghostscript runs share a small global slot pool with a
 * bounded queue (503 beyond it) so a flood of requests cannot start unbounded containers.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { FakeRunner } from '../../src/compile/runner.ts'
import { HttpError } from '../../src/http/errors.ts'
import { HELLO_TEX, makeEnv, type TestEnv } from './helpers.ts'

let env: TestEnv
afterEach(async () => {
  await env?.close()
})

describe('auxiliary container limits', () => {
  it('coalesces concurrent word counts of the same document', async () => {
    const runner = new FakeRunner({ delayMs: 200 })
    env = await makeEnv({ runner })
    env.write('main.tex', HELLO_TEX)
    const results = await Promise.all([1, 2, 3, 4].map(() => env.compile.wordCount(env.pid)))
    expect(runner.tools.filter(t => t.argv[0] === 'texcount')).toHaveLength(1)
    expect(new Set(results.map(r => r.textWords)).size).toBe(1)
    // a later request runs again
    await env.compile.wordCount(env.pid)
    expect(runner.tools.filter(t => t.argv[0] === 'texcount')).toHaveLength(2)
  })

  it('runs at most 2 tool containers at once and refuses beyond a queue of 16 (503)', async () => {
    const runner = new FakeRunner({ delayMs: 150 })
    let active = 0
    let maxActive = 0
    const tool = runner.tool.bind(runner)
    runner.tool = async job => {
      active++
      maxActive = Math.max(maxActive, active)
      try {
        return await tool(job)
      } finally {
        active--
      }
    }
    env = await makeEnv({ runner })
    const ids = Array.from({ length: 22 }, (_, i) => env.write(`fig${i}.eps`, Buffer.from(`%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 ${i + 1} 1\n`)).id)
    const settled = await Promise.allSettled(ids.map(id => env.compile.renderPreview(env.pid, id)))
    const ok = settled.filter(r => r.status === 'fulfilled')
    const busy = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(maxActive).toBe(2)
    expect(ok).toHaveLength(18)
    expect(busy).toHaveLength(4)
    for (const b of busy) expect(b.reason).toBeInstanceOf(HttpError)
    expect((busy[0].reason as HttpError).status).toBe(503)
    // the pool frees up again
    await expect(env.compile.renderPreview(env.pid, ids[21])).resolves.toBeInstanceOf(Buffer)
  })
})
