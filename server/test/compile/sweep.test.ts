/**
 * Compile housekeeping (CompileService.sweep): build retention for every project, idle compile
 * directories, leftovers of deleted projects and old EPS previews.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { FakeRunner } from '../../src/compile/runner.ts'
import { COMPILE_DIR_IDLE_MS, PREVIEW_MAX_AGE_MS } from '../../src/compile/index.ts'
import { listBuildIds, newBuildId } from '../../src/compile/outputs.ts'
import { HELLO_TEX, makeEnv, type TestEnv } from './helpers.ts'

let env: TestEnv

afterEach(async () => {
  await env?.close()
})

/** Fake an old build directory (build ids encode their creation time). */
function oldBuild(e: TestEnv, pid: string, ageMs: number): string {
  const id = newBuildId(Date.now() - ageMs)
  const dir = path.join(e.config.dirs.builds, pid, id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'main.pdf'), '%PDF-1.5')
  return id
}

function age(p: string, ms: number): void {
  const t = new Date(Date.now() - ms)
  fs.utimesSync(p, t, t)
}

describe('compile housekeeping', () => {
  it('keeps an active project\'s recent builds and compile dir, prunes beyond the newest 5', async () => {
    env = await makeEnv({ runner: new FakeRunner({ delayMs: 1 }) })
    env.write('main.tex', HELLO_TEX)
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status).toBe('success')
    const old = Array.from({ length: 7 }, (_, i) => oldBuild(env, env.pid, 2 * 60 * 60 * 1000 + i * 1000))
    const res = await env.compile.sweep()
    const left = await listBuildIds(path.join(env.config.dirs.builds, env.pid))
    expect(left).toHaveLength(5)
    expect(left).toContain(r.buildId)
    expect(res.builds).toBe(3)
    expect(res.compileDirs).toBe(0)
    expect(fs.existsSync(path.join(env.config.dirs.compiles, env.pid))).toBe(true)
    // the pruned ones are the oldest
    expect(left).not.toContain(old[6])
  })

  it('removes an idle compile dir and keeps only the newest build of an idle project', async () => {
    env = await makeEnv({ runner: new FakeRunner({ delayMs: 1 }) })
    env.write('main.tex', HELLO_TEX)
    const r = await env.compile.compile(env.pid, env.owner, {})
    const compileDir = path.join(env.config.dirs.compiles, env.pid)
    const later = Date.now() + COMPILE_DIR_IDLE_MS + 60_000
    oldBuild(env, env.pid, 4 * 24 * 60 * 60 * 1000)
    const res = await env.compile.sweep({ now: later })
    expect(res.compileDirs).toBe(1)
    expect(fs.existsSync(compileDir)).toBe(false)
    const left = await listBuildIds(path.join(env.config.dirs.builds, env.pid))
    expect(left).toEqual([r.buildId])
    // the last build is still served, and the next compile rebuilds the dir from scratch
    expect((await env.compile.lastBuild(env.pid))?.buildId).toBe(r.buildId)
    const again = await env.compile.compile(env.pid, env.owner, {})
    expect(again.status).toBe('success')
    expect(fs.existsSync(compileDir)).toBe(true)
  })

  it('removes leftovers of deleted projects and old previews, ignores foreign names', async () => {
    env = await makeEnv({ runner: new FakeRunner({ delayMs: 1 }) })
    const ghost = 'GhostProject0001'
    for (const d of [env.config.dirs.compiles, env.config.dirs.builds, env.config.dirs.previews]) {
      fs.mkdirSync(path.join(d, ghost), { recursive: true })
      fs.writeFileSync(path.join(d, ghost, 'x'), 'x')
    }
    fs.mkdirSync(path.join(env.config.dirs.compiles, 'not a project id'), { recursive: true })
    const previews = path.join(env.config.dirs.previews, env.pid)
    fs.mkdirSync(previews, { recursive: true })
    fs.writeFileSync(path.join(previews, 'old.png'), 'x')
    fs.writeFileSync(path.join(previews, 'new.png'), 'x')
    age(path.join(previews, 'old.png'), PREVIEW_MAX_AGE_MS + 60_000)
    const res = await env.compile.sweep()
    expect(res.orphans).toBe(1)
    expect(res.previews).toBe(1)
    for (const d of [env.config.dirs.compiles, env.config.dirs.builds, env.config.dirs.previews]) {
      expect(fs.existsSync(path.join(d, ghost))).toBe(false)
    }
    expect(fs.existsSync(path.join(env.config.dirs.compiles, 'not a project id'))).toBe(true)
    expect(fs.readdirSync(previews)).toEqual(['new.png'])
  })

  it('never touches a project while it compiles', async () => {
    const runner = new FakeRunner({ delayMs: 400 })
    env = await makeEnv({ runner })
    env.write('main.tex', HELLO_TEX)
    const first = await env.compile.compile(env.pid, env.owner, {})
    const running = env.compile.compile(env.pid, env.owner, {})
    await new Promise(r => setTimeout(r, 100))
    const res = await env.compile.sweep({ now: Date.now() + COMPILE_DIR_IDLE_MS * 2 })
    expect(res.compileDirs).toBe(0)
    expect((await running).status).toBe('success')
    expect(first.status).toBe('success')
  })
})
