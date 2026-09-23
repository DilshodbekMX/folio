/**
 * CompileService + coordinator with the fake runner (no docker): single-flight, queued
 * follow-up, dedupe, per-user guard, global limit, timeout/stop kills, outputs, xr pre-build,
 * root selection, word count and previews.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CompileResponse } from '@folio/shared/api'
import { FakeRunner } from '../../src/compile/runner.ts'
import { HELLO_TEX, makeEnv, waitFor, type TestEnv } from './helpers.ts'

let env: TestEnv
let runner: FakeRunner

async function setup(o: Parameters<typeof makeEnv>[0] = {}) {
  runner = new FakeRunner({ delayMs: 20 })
  env = await makeEnv({ runner, ...o })
}

afterEach(async () => {
  await env?.close()
})

describe('compile with the fake runner', () => {
  beforeEach(() => setup())

  it('produces a build with pdf, log, synctex and meta.json', async () => {
    env.write('main.tex', HELLO_TEX)
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status).toBe('success')
    expect(r.cached).toBe(false)
    expect(r.jobname).toBe('main')
    expect(r.rootPath).toBe('main.tex')
    expect(r.buildId).toMatch(/^[0-9a-f]{8,}-[0-9a-f]{16}$/)
    expect(r.pdfUrl).toBe(`/api/projects/${env.pid}/builds/${r.buildId}/main.pdf`)
    expect(r.logUrl).toBe(`/api/projects/${env.pid}/builds/${r.buildId}/main.log`)
    expect(r.hasSynctex).toBe(true)
    expect(r.outputFiles.map(f => f.path).sort()).toEqual(['main.aux', 'main.log', 'main.pdf', 'main.synctex.gz'])
    expect(r.outputFiles.find(f => f.path === 'main.synctex.gz')?.type).toBe('synctex.gz')
    expect(r.by?.id).toBe(env.owner.id)
    expect(r.compiler).toBe('pdflatex')
    expect(r.timings.totalMs).toBeGreaterThanOrEqual(r.timings.compileMs)
    const pdf = env.compile.resolveBuildFile(env.pid, r.buildId!, 'main.pdf')
    expect(pdf).toBeTruthy()
    expect(fs.readFileSync(pdf!).subarray(0, 5).toString()).toBe('%PDF-')
    const meta = JSON.parse(fs.readFileSync(path.join(env.config.dirs.builds, env.pid, r.buildId!, 'meta.json'), 'utf8'))
    expect(meta.buildId).toBe(r.buildId)
    expect(meta.status).toBe('success')
    // first compile is manual → -gt
    expect(runner.runs[0].force).toBe(true)
    expect(runner.runs[0].name).toBe(`folio-server-compile-${r.buildId}`)
  })

  it('broadcasts compile:started and compile:done', async () => {
    env.write('main.tex', HELLO_TEX)
    const r = await env.compile.compile(env.pid, env.editor, { auto: true })
    const types = env.events.filter(e => e.projectId === env.pid).map(e => e.event)
    expect(types[0]).toEqual({ type: 'compile:started', by: env.editor, auto: true, rootPath: 'main.tex' })
    expect(types[1]).toEqual({ type: 'compile:done', by: env.editor, status: 'success', buildId: r.buildId, rootPath: 'main.tex', jobname: 'main' })
  })

  it('returns no-root when there is no document with \\documentclass', async () => {
    env.write('notes.tex', 'just text\n')
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status).toBe('no-root')
    expect(r.buildId).toBeNull()
    expect(runner.runs).toHaveLength(0)
  })

  it('picks main.tex, then settings.rootFileId, then request.rootFileId', async () => {
    env.write('a.tex', HELLO_TEX)
    env.write('sub/main.tex', HELLO_TEX)
    env.write('main.tex', HELLO_TEX)
    expect((await env.compile.compile(env.pid, env.owner, {})).rootPath).toBe('main.tex')
    env.setSettings({ rootFileId: env.fileId('a.tex') })
    expect((await env.compile.compile(env.pid, env.owner, {})).rootPath).toBe('a.tex')
    const r = await env.compile.compile(env.pid, env.owner, { rootFileId: env.fileId('sub/main.tex') })
    expect(r.rootPath).toBe('sub/main.tex')
    expect(r.status).toBe('success')
    expect(runner.runs.at(-1)!.rootPath).toBe('sub/main.tex')
    await expect(env.compile.compile(env.pid, env.owner, { rootFileId: 'doesnotexist12345' })).rejects.toMatchObject({ status: 400 })
  })

  it('falls back to auto-detection when settings.rootFileId is stale', async () => {
    env.write('paper.tex', HELLO_TEX)
    env.setSettings({ rootFileId: 'AAAAAAAAAAAAAAAA' })
    expect((await env.compile.compile(env.pid, env.owner, {})).rootPath).toBe('paper.tex')
  })

  it('refuses a root document whose name the shell/TeX cannot take safely', async () => {
    env.write('bad$(x).tex', HELLO_TEX)
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status).toBe('error')
    expect(r.stdout).toMatch(/cannot be compiled/)
    expect(runner.runs).toHaveLength(0)
  })

  it('reports failure (and a parsed log) when no PDF is produced; a stale PDF never counts', async () => {
    env.write('main.tex', HELLO_TEX)
    expect((await env.compile.compile(env.pid, env.owner, {})).status).toBe('success')
    runner.mode = 'error'
    env.write('main.tex', HELLO_TEX + '% changed\n')
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status).toBe('failure')
    expect(r.pdfUrl).toBeNull()
    expect(r.hasSynctex).toBe(false)
    expect(r.logUrl).toBeTruthy()
    expect(r.outputFiles.map(f => f.path)).toEqual(['main.log'])
    // the log parser (@folio/shared/texlog) sees "./main.tex:5: Undefined control sequence."
    if (r.log) {
      expect(r.log.errors[0]).toMatchObject({ file: 'main.tex', line: 5 })
    } else {
      expect(fs.readFileSync(env.compile.resolveBuildFile(env.pid, r.buildId!, 'main.log')!, 'utf8')).toMatch(/Undefined control sequence/)
    }
    const stop = await env.compile.compile(env.pid, env.owner, { stopOnFirstError: true })
    expect(stop.status).toBe('stopped-on-first-error')
  })

  it('lastBuild returns the newest build, also after a restart (from meta.json)', async () => {
    expect(await env.compile.lastBuild(env.pid)).toBeNull()
    env.write('main.tex', HELLO_TEX)
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect((await env.compile.lastBuild(env.pid))?.buildId).toBe(r.buildId)
    const fresh = env.restart({ runner })
    const last = await fresh.lastBuild(env.pid)
    expect(last?.buildId).toBe(r.buildId)
    expect(last?.status).toBe('success')
  })

  it('clearCache and deleteProject remove compile dir and builds', async () => {
    env.write('main.tex', HELLO_TEX)
    const r = await env.compile.compile(env.pid, env.owner, {})
    const compileDir = path.join(env.config.dirs.compiles, env.pid)
    expect(fs.existsSync(path.join(compileDir, 'main.pdf'))).toBe(true)
    await env.compile.clearCache(env.pid)
    expect(fs.existsSync(compileDir)).toBe(false)
    expect(env.compile.resolveBuildFile(env.pid, r.buildId!, 'main.pdf')).toBeNull()
    expect(await env.compile.lastBuild(env.pid)).toBeNull()
    await env.compile.compile(env.pid, env.owner, {})
    await env.compile.deleteProject(env.pid)
    expect(fs.existsSync(path.join(env.config.dirs.builds, env.pid))).toBe(false)
    expect(fs.existsSync(compileDir)).toBe(false)
  })

  it('fromScratch empties the compile dir first', async () => {
    env.write('main.tex', HELLO_TEX)
    await env.compile.compile(env.pid, env.owner, {})
    const junk = path.join(env.config.dirs.compiles, env.pid, 'stale.aux')
    fs.writeFileSync(junk, 'x')
    await env.compile.compile(env.pid, env.owner, {})
    expect(fs.existsSync(junk)).toBe(true)
    await env.compile.compile(env.pid, env.owner, { fromScratch: true })
    expect(fs.existsSync(junk)).toBe(false)
  })

  it('passes draft and stopOnFirstError to latexmk; -gt for manual compiles and for changed options', async () => {
    env.write('main.tex', HELLO_TEX)
    await env.compile.compile(env.pid, env.owner, { draft: true, stopOnFirstError: true })
    expect(runner.runs[0]).toMatchObject({ draft: true, stopOnFirstError: true, force: true, compiler: 'pdflatex', jobname: 'main' })
    env.write('main.tex', HELLO_TEX + '%x\n')
    // other users: the owner's auto compile would hit the 1 s guard right after a manual one
    await env.compile.compile(env.pid, env.editor, { auto: true, draft: true, stopOnFirstError: true })
    expect(runner.runs[1]).toMatchObject({ draft: true, stopOnFirstError: true, force: false })
    // latexmk would not notice the changed -usepretex: the auto compile must force a run
    await env.compile.compile(env.pid, env.viewer, { auto: true, draft: false })
    expect(runner.runs[2]).toMatchObject({ draft: false, force: true })
    env.setSettings({ compiler: 'xelatex' })
    await env.compile.compile(env.pid, env.outsider, { auto: true })
    expect(runner.runs[3]).toMatchObject({ compiler: 'xelatex', force: true })
  })

  it('uses the project compiler and timeout', async () => {
    env.write('main.tex', HELLO_TEX)
    env.setSettings({ compiler: 'xelatex', timeoutSec: 42 })
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.compiler).toBe('xelatex')
    expect(runner.runs[0].compiler).toBe('xelatex')
    expect(runner.runs[0].timeoutMs).toBeLessThanOrEqual(42_000)
    expect(runner.runs[0].timeoutMs).toBeGreaterThan(40_000)
  })

  it('does not sync project files that collide with TeX outputs of the root', async () => {
    env.write('main.tex', HELLO_TEX)
    env.write('main.pdf', Buffer.from('%PDF-1.4 user file'))
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status).toBe('success')
    const built = fs.readFileSync(env.compile.resolveBuildFile(env.pid, r.buildId!, 'main.pdf')!)
    expect(built.length).toBeGreaterThan(1000)
  })
})

describe('coordinator', () => {
  it('single-flight: concurrent requests coalesce into one queued follow-up (newest wins)', async () => {
    await setup()
    runner.delayMs = 300
    env.write('main.tex', HELLO_TEX)
    const first = env.compile.compile(env.pid, env.owner, {})
    await waitFor(() => runner.active === 1)
    const b = env.compile.compile(env.pid, env.editor, { draft: false })
    const c = env.compile.compile(env.pid, env.owner, { draft: false })
    const d = env.compile.compile(env.pid, env.editor, { draft: true })
    const [ra, rb, rc, rd] = await Promise.all([first, b, c, d])
    expect(runner.runs).toHaveLength(2)
    expect(runner.maxActive).toBe(1)
    expect(ra.status).toBe('success')
    expect(rb.buildId).toBe(rc.buildId)
    expect(rc.buildId).toBe(rd.buildId)
    expect(rb.buildId).not.toBe(ra.buildId)
    // newest request's options, newest request's user
    expect(runner.runs[1].draft).toBe(true)
    expect(rd.by?.id).toBe(env.editor.id)
  })

  it('a manual request in a burst keeps the follow-up manual (-gt)', async () => {
    await setup()
    runner.delayMs = 200
    env.write('main.tex', HELLO_TEX)
    const first = env.compile.compile(env.pid, env.owner, {})
    await waitFor(() => runner.active === 1)
    const m = env.compile.compile(env.pid, env.editor, {})
    env.write('main.tex', HELLO_TEX + '%1\n')
    const a = env.compile.compile(env.pid, env.owner, { auto: true })
    await Promise.all([first, m, a])
    expect(runner.runs).toHaveLength(2)
    expect(runner.runs[1].force).toBe(true)
  })

  it('dedupe: an unchanged auto compile returns the last successful build (cached)', async () => {
    await setup({ userGuardMs: 0 })
    env.write('main.tex', HELLO_TEX)
    const r1 = await env.compile.compile(env.pid, env.owner, { auto: true })
    expect(r1.status).toBe('success')
    const r2 = await env.compile.compile(env.pid, env.owner, { auto: true })
    expect(r2.cached).toBe(true)
    expect(r2.buildId).toBe(r1.buildId)
    expect(runner.runs).toHaveLength(1)
    // a manual compile always runs (with -gt)
    const r3 = await env.compile.compile(env.pid, env.owner, {})
    expect(r3.cached).toBe(false)
    expect(runner.runs).toHaveLength(2)
    expect(runner.runs[1].force).toBe(true)
    // an edit changes the snapshot hash
    env.write('main.tex', HELLO_TEX + '%edit\n')
    const r4 = await env.compile.compile(env.pid, env.owner, { auto: true })
    expect(r4.cached).toBe(false)
    expect(runner.runs).toHaveLength(3)
    // changing an option (draft) also changes the hash
    const r5 = await env.compile.compile(env.pid, env.owner, { auto: true, draft: true })
    expect(r5.cached).toBe(false)
    // reverting to a previously successful state is served from the cache again
    const r6 = await env.compile.compile(env.pid, env.owner, { auto: true, draft: true })
    expect(r6.cached).toBe(true)
    expect(r6.buildId).toBe(r5.buildId)
  })

  it('dedupe ignores builds that were cleared', async () => {
    await setup({ userGuardMs: 0 })
    env.write('main.tex', HELLO_TEX)
    await env.compile.compile(env.pid, env.owner, { auto: true })
    await env.compile.clearCache(env.pid)
    const r = await env.compile.compile(env.pid, env.owner, { auto: true })
    expect(r.cached).toBe(false)
    expect(runner.runs).toHaveLength(2)
  })

  it('per-user guard: a second auto compile within 1 s is too-recently-compiled', async () => {
    await setup()
    env.write('main.tex', HELLO_TEX)
    const r1 = await env.compile.compile(env.pid, env.owner, { auto: true })
    expect(r1.status).toBe('success')
    env.write('main.tex', HELLO_TEX + '%a\n')
    const r2 = await env.compile.compile(env.pid, env.owner, { auto: true })
    expect(r2.status).toBe('too-recently-compiled')
    expect(r2.buildId).toBeNull()
    // other users and manual compiles are not affected
    const r3 = await env.compile.compile(env.pid, env.editor, { auto: true })
    expect(r3.status).toBe('success')
    const r4 = await env.compile.compile(env.pid, env.owner, {})
    expect(r4.status).toBe('success')
    expect(runner.runs).toHaveLength(3)
  })

  it('timeout: the run is killed and reported as timedout; the compile dir is wiped', async () => {
    await setup({ settings: { timeoutSec: 1 } })
    runner.mode = 'hang'
    env.write('main.tex', HELLO_TEX)
    const started = Date.now()
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status).toBe('timedout')
    expect(Date.now() - started).toBeLessThan(5000)
    expect(runner.kills).toEqual([runner.runs[0].name])
    expect(r.stdout).toMatch(/timeout/)
    expect(fs.readdirSync(path.join(env.config.dirs.compiles, env.pid))).toEqual([])
    const done = env.events.find(e => e.event.type === 'compile:done')?.event
    expect(done).toMatchObject({ status: 'timedout' })
  })

  it('stop: kills the running compile (terminated) and cancels the queued follow-up', async () => {
    await setup()
    runner.mode = 'hang'
    env.write('main.tex', HELLO_TEX)
    const running = env.compile.compile(env.pid, env.owner, {})
    await waitFor(() => runner.active === 1)
    const queued = env.compile.compile(env.pid, env.editor, {})
    await env.compile.stop(env.pid)
    const [r1, r2] = await Promise.all([running, queued])
    expect(r1.status).toBe('terminated')
    expect(r2.status).toBe('terminated')
    expect(runner.kills).toHaveLength(1)
    expect(runner.runs).toHaveLength(1)
    // the next compile works normally
    runner.mode = 'success'
    expect((await env.compile.compile(env.pid, env.owner, {})).status).toBe('success')
  })

  it('global limit: compiles of different projects share maxConcurrent slots; backlog > 2x → unavailable', async () => {
    await setup({ env: { MAX_CONCURRENT_COMPILES: '1' } })
    runner.mode = 'hang'
    const pids = [env.pid, env.newProject('p2'), env.newProject('p3'), env.newProject('p4')]
    for (const pid of pids) {
      env.pid = pid
      env.write('main.tex', HELLO_TEX)
    }
    const results: Promise<CompileResponse>[] = []
    results.push(env.compile.compile(pids[0], env.owner, {}))
    await waitFor(() => runner.active === 1)
    results.push(env.compile.compile(pids[1], env.owner, {}))
    results.push(env.compile.compile(pids[2], env.owner, {}))
    // wait until both are queued behind the running one
    await new Promise(r => setTimeout(r, 100))
    const busy = await env.compile.compile(pids[3], env.owner, {})
    expect(busy.status).toBe('unavailable')
    expect(runner.maxActive).toBe(1)
    runner.mode = 'success'
    await env.compile.stop(pids[0])
    const [a, b, c] = await Promise.all(results)
    expect(a.status).toBe('terminated')
    expect(b.status).toBe('success')
    expect(c.status).toBe('success')
    expect(runner.maxActive).toBe(1)
  })

  it('shutdown stops running compiles and refuses new ones', async () => {
    await setup()
    runner.mode = 'hang'
    env.write('main.tex', HELLO_TEX)
    const running = env.compile.compile(env.pid, env.owner, {})
    await waitFor(() => runner.active === 1)
    await env.compile.shutdown()
    expect((await running).status).toBe('terminated')
    expect((await env.compile.compile(env.pid, env.owner, {})).status).toBe('unavailable')
  })
})

describe('xr external documents (fake runner)', () => {
  beforeEach(() => setup())

  const MAIN = String.raw`\documentclass{article}
\usepackage{xr}
\externaldocument{supp}
% \externaldocument{ignored}
\begin{document}
See Table~\ref{tab:s1}.
\end{document}
`
  const SUPP = String.raw`\documentclass{article}
\begin{document}
\begin{table}\caption{S1}\label{tab:s1}\end{table}
\end{document}
`

  it('pre-builds detected external documents once, and again when they change', async () => {
    env.write('main.tex', MAIN)
    env.write('supp.tex', SUPP)
    const r1 = await env.compile.compile(env.pid, env.owner, {})
    expect(r1.status).toBe('success')
    expect(runner.runs.map(r => r.rootPath)).toEqual(['supp.tex', 'main.tex'])
    expect(runner.runs[0]).toMatchObject({ jobname: 'supp', force: true, stopOnFirstError: false })
    expect(r1.externalBuilds).toEqual([{ path: 'supp.tex', status: 'success' }])
    expect(r1.outputFiles.map(f => f.path)).toEqual(expect.arrayContaining(['supp.pdf', 'supp.log', 'main.pdf']))

    const r2 = await env.compile.compile(env.pid, env.owner, {})
    expect(r2.externalBuilds).toEqual([])
    expect(runner.runs.map(r => r.rootPath)).toEqual(['supp.tex', 'main.tex', 'main.tex'])

    env.write('supp.tex', SUPP + '% changed\n')
    const r3 = await env.compile.compile(env.pid, env.owner, {})
    expect(r3.externalBuilds).toEqual([{ path: 'supp.tex', status: 'success' }])
    expect(runner.runs.at(-2)!.rootPath).toBe('supp.tex')
  })

  it('explicit settings.externalDocs win over detection', async () => {
    env.write('main.tex', HELLO_TEX)
    env.write('other/supp.tex', SUPP)
    env.setSettings({ externalDocs: ['other/supp'] })
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.externalBuilds).toEqual([{ path: 'other/supp.tex', status: 'success' }])
    expect(runner.runs[0]).toMatchObject({ rootPath: 'other/supp.tex', jobname: 'supp' })
  })
})

describe('word count and previews (fake runner)', () => {
  beforeEach(() => setup())

  it('wordCount runs texcount against the synced compile dir and parses it', async () => {
    env.write('main.tex', HELLO_TEX)
    const wc = await env.compile.wordCount(env.pid)
    expect(wc).toMatchObject({ rootPath: 'main.tex', textWords: 12, headerWords: 1, headers: 1, mathInline: 1, mathDisplay: 1 })
    const job = runner.tools[0]
    expect(job.argv).toEqual(['texcount', '-nocol', '-inc', '-utf8', 'main.tex'])
    expect(job.mounts).toEqual([{ host: path.join(env.config.dirs.compiles, env.pid), container: '/compile', ro: true }])
    expect(fs.readFileSync(path.join(env.config.dirs.compiles, env.pid, 'main.tex'), 'utf8')).toBe(HELLO_TEX)
    await expect(env.compile.wordCount(env.pid, 'missingmissing12')).rejects.toMatchObject({ status: 400 })
  })

  it('renderPreview renders EPS through gs once and caches by content', async () => {
    const eps = env.write('fig/logo.eps', Buffer.from('%!PS-Adobe-3.0 EPSF-3.0\n%%BoundingBox: 0 0 10 10\nshowpage\n'))
    const png = await env.compile.renderPreview(env.pid, eps.id)
    expect(png.subarray(1, 4).toString()).toBe('PNG')
    expect(runner.tools).toHaveLength(1)
    expect(runner.tools[0].argv[0]).toBe('gs')
    expect(runner.tools[0].argv).toContain('-dSAFER')
    expect(runner.tools[0].mounts[0]).toMatchObject({ container: '/in', ro: true })
    await env.compile.renderPreview(env.pid, eps.id)
    expect(runner.tools).toHaveLength(1)
    expect(fs.readdirSync(path.join(env.config.dirs.previews, env.pid)).filter(n => n.endsWith('.png'))).toHaveLength(1)
    const tex = env.write('main.tex', HELLO_TEX)
    await expect(env.compile.renderPreview(env.pid, tex.id)).rejects.toMatchObject({ status: 400 })
    await expect(env.compile.renderPreview(env.pid, 'nope-nope-nope-1')).rejects.toMatchObject({ status: 404 })
  })

  it('info() reports the runner', async () => {
    expect(await env.compile.info()).toEqual({ runner: 'fake', image: env.config.compile.image, texLive: null, dockerOk: false })
  })
})

// ---------------------------------------------------------------------------------------
// review fixes (CMP-1, LAST-1, CACHE-1, XR-1, XR-2)
// ---------------------------------------------------------------------------------------

/** A fake runner whose latexmk can exit 12 with a PDF (TeX errors in -f mode) or refuse to run. */
class ScriptedRunner extends FakeRunner {
  /** exit code of successful-looking runs (12 = TeX errors, PDF still written) */
  exitCode = 0
  /** latexmk without -gt answers "Nothing to do … gave an error in previous invocation" */
  refuseUnforced = false
  /** append a label that changes every run to each job's .aux (labels that never converge) */
  churnLabels = false
  /** append a fixed label per job to its .aux (the fixture .aux has none) */
  jobLabels = false

  override async latexmk(job: Parameters<FakeRunner['latexmk']>[0]) {
    if (this.refuseUnforced && !job.force) {
      this.runs.push(job)
      return {
        code: 12, timedOut: false, terminated: false, error: null, durationMs: 1,
        output: `Latexmk: Nothing to do for '${job.rootPath}'.\nLatexmk: All targets (${job.jobname}.pdf) are up-to-date\n  pdflatex: gave an error in previous invocation of latexmk.\n`,
      }
    }
    const out = await super.latexmk(job)
    if (out.code !== 0) return out
    const aux = path.join(job.compileDir, path.dirname(job.rootPath), `${job.jobname}.aux`)
    if (this.jobLabels) fs.appendFileSync(aux, `\\newlabel{sec:${job.jobname}}{{1}{1}}\n`)
    if (this.churnLabels) fs.appendFileSync(aux, `\\newlabel{run}{{${this.runs.length}}{1}}\n`)
    if (this.exitCode === 0) return out
    return { ...out, code: this.exitCode, output: `${out.output}Run number 1 of rule 'pdflatex'\nLatexmk: Errors, so I did not complete making targets\n` }
  }
}

describe('review fixes (fake runner)', () => {
  let sr: ScriptedRunner
  beforeEach(async () => {
    sr = new ScriptedRunner({ delayMs: 20 })
    runner = sr
    env = await makeEnv({ runner: sr, userGuardMs: 0 })
  })

  it('an auto compile after a run with TeX errors always runs TeX (-gt), so it never reports "no PDF, no log"', async () => {
    env.write('main.tex', HELLO_TEX)
    env.write('unused.tex', 'nothing\n')
    sr.exitCode = 12
    const r1 = await env.compile.compile(env.pid, env.owner, {})
    expect(r1.status).toBe('success')
    env.write('unused.tex', 'nothing more\n')
    const r2 = await env.compile.compile(env.pid, env.owner, { auto: true })
    expect(sr.runs[1].force).toBe(true)
    expect(r2).toMatchObject({ status: 'success' })
    expect(r2.log).not.toBeNull()
    // once a run is clean, latexmk decides again
    sr.exitCode = 0
    env.write('unused.tex', 'x\n')
    await env.compile.compile(env.pid, env.owner, { auto: true })
    env.write('unused.tex', 'y\n')
    await env.compile.compile(env.pid, env.owner, { auto: true })
    expect(sr.runs.map(r => r.force)).toEqual([true, true, true, false])
    // "stop on first error" is part of the options: toggling it forces a run
    env.write('unused.tex', 'z\n')
    await env.compile.compile(env.pid, env.owner, { auto: true, stopOnFirstError: true })
    expect(sr.runs.at(-1)).toMatchObject({ force: true, stopOnFirstError: true })
  })

  it('when latexmk refuses to run TeX after an earlier error, the compile runs it with -gt', async () => {
    env.write('main.tex', HELLO_TEX)
    await env.compile.compile(env.pid, env.owner, {})
    env.write('main.tex', HELLO_TEX + '%a\n')
    sr.refuseUnforced = true
    const r = await env.compile.compile(env.pid, env.owner, { auto: true })
    expect(sr.runs.slice(1).map(x => x.force)).toEqual([false, true])
    expect(r.status).toBe('success')
    expect(r.pdfUrl).toBeTruthy()
  })

  it('GET last: after a failed build it also names the last build with a PDF (also after a restart and a sweep)', async () => {
    env.write('main.tex', HELLO_TEX)
    const good = await env.compile.compile(env.pid, env.owner, {})
    sr.mode = 'error'
    const bad = await env.compile.compile(env.pid, env.owner, {})
    expect(bad.status).toBe('failure')
    const last = await env.compile.lastBuild(env.pid)
    expect(last?.buildId).toBe(bad.buildId)
    expect(last?.lastWithPdf).toMatchObject({ buildId: good.buildId, status: 'success', pdfUrl: good.pdfUrl })
    // a success needs no pointer
    sr.mode = 'success'
    const again = await env.compile.compile(env.pid, env.owner, {})
    expect((await env.compile.lastBuild(env.pid))?.lastWithPdf).toBeUndefined()
    expect(again.lastWithPdf).toBeUndefined()

    sr.mode = 'error'
    await env.compile.compile(env.pid, env.owner, {})
    // restart: nothing in memory; the good build is found on disk and survives the idle sweep
    const fresh = env.restart({ runner: sr })
    await fresh.sweep({ now: Date.now() + 10 * 24 * 60 * 60 * 1000 })
    const after = await fresh.lastBuild(env.pid)
    expect(after?.status).toBe('failure')
    expect(after?.lastWithPdf?.buildId).toBe(again.buildId)
    expect(fresh.resolveBuildFile(env.pid, again.buildId!, 'main.pdf')).toBeTruthy()
  })

  it('"Clear cached files" never cancels a running compile: 409 while one runs', async () => {
    env.write('main.tex', HELLO_TEX)
    sr.delayMs = 400
    const running = env.compile.compile(env.pid, env.editor, {})
    await waitFor(() => sr.active > 0)
    await expect(env.compile.clearCache(env.pid)).rejects.toMatchObject({ status: 409, code: 'compile_running' })
    const r = await running
    expect(r.status).toBe('success')
    expect(sr.kills).toEqual([])
    // right after the compile answered, clearing works
    await env.compile.clearCache(env.pid)
    expect(await env.compile.lastBuild(env.pid)).toBeNull()
  })

  const MUTUAL_MAIN = String.raw`\documentclass{article}
\usepackage{xr}
\externaldocument[S-]{supp}
\begin{document}
\section{Main}\label{sec:main}
See \ref{S-sec:supp}.
\end{document}
`
  const MUTUAL_SUPP = String.raw`\documentclass{article}
\usepackage{xr}
\externaldocument[M-]{main}
\begin{document}
\section{Supp}\label{sec:supp}
See \ref{M-sec:main}.
\end{document}
`

  it('mutual xr: the external document is built again after the main one when the labels it imports changed', async () => {
    sr.jobLabels = true
    env.write('main.tex', MUTUAL_MAIN)
    env.write('supp.tex', MUTUAL_SUPP)
    const r1 = await env.compile.compile(env.pid, env.owner, {})
    // supp before main (main.aux missing), main, supp again (main.aux now exists)
    expect(sr.runs.map(r => r.rootPath)).toEqual(['supp.tex', 'main.tex', 'supp.tex'])
    expect(sr.runs[2]).toMatchObject({ jobname: 'supp', force: true })
    expect(r1.externalBuilds).toEqual([{ path: 'supp.tex', status: 'success' }])
    // nothing changed: only the main document runs
    await env.compile.compile(env.pid, env.owner, {})
    expect(sr.runs.map(r => r.rootPath).slice(3)).toEqual(['main.tex'])
  })

  it('mutual xr: when the rebuilt external changes the labels the main document imports, the main runs once more', async () => {
    sr.churnLabels = true
    env.write('main.tex', MUTUAL_MAIN)
    env.write('supp.tex', MUTUAL_SUPP)
    await env.compile.compile(env.pid, env.owner, {})
    expect(sr.runs.map(r => r.rootPath)).toEqual(['supp.tex', 'main.tex', 'supp.tex', 'main.tex'])
  })

  it('compiling a listed external document on its own (the open file as root) pre-builds what it imports', async () => {
    sr.jobLabels = true
    env.write('main.tex', MUTUAL_MAIN)
    env.write('supp.tex', MUTUAL_SUPP)
    env.setSettings({ externalDocs: ['supp.tex'] })
    const r = await env.compile.compile(env.pid, env.owner, { rootFileId: env.fileId('supp.tex') })
    expect(r).toMatchObject({ status: 'success', rootPath: 'supp.tex', jobname: 'supp' })
    expect(r.externalBuilds).toEqual([{ path: 'main.tex', status: 'success' }])
    expect(sr.runs.map(x => x.rootPath).slice(0, 2)).toEqual(['main.tex', 'supp.tex'])
    // the main document still uses the listed ones
    const m = await env.compile.compile(env.pid, env.owner, {})
    expect(m.rootPath).toBe('main.tex')
    expect(m.outputFiles.map(f => f.path)).toEqual(expect.arrayContaining(['supp.pdf', 'main.pdf']))
  })

  it('finds \\externaldocument in a preamble file the root \\input s', async () => {
    env.write('main.tex', '\\documentclass{article}\n\\input{preamble}\n\\begin{document}\nSee \\ref{S-sec:supp}.\n\\end{document}\n')
    env.write('preamble.tex', '\\usepackage{xr}\n\\externaldocument[S-]{supp}\n')
    env.write('supp.tex', MUTUAL_SUPP.replace('\\externaldocument[M-]{main}\n', ''))
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.externalBuilds).toEqual([{ path: 'supp.tex', status: 'success' }])
    expect(sr.runs[0]).toMatchObject({ rootPath: 'supp.tex', jobname: 'supp' })
  })
})

// ---------------------------------------------------------------------------------------
// review round 2 (J-1/REG-1 server side, PERF-2, PERF-4, ACC-1, ACC-2)
// ---------------------------------------------------------------------------------------

/** A fake runner that fails (no PDF, error log) for the listed root documents only. */
class PerRootRunner extends FakeRunner {
  readonly failing = new Set<string>()

  override async latexmk(job: Parameters<FakeRunner['latexmk']>[0]) {
    if (!this.failing.has(job.rootPath)) return super.latexmk(job)
    const mode = this.mode
    this.mode = 'error'
    try {
      return await super.latexmk(job)
    } finally {
      this.mode = mode
    }
  }
}

describe('review round 2 (fake runner)', () => {
  let pr: PerRootRunner
  beforeEach(async () => {
    pr = new PerRootRunner({ delayMs: 20 })
    runner = pr
    env = await makeEnv({ runner: pr, userGuardMs: 0 })
  })

  const SUPP_STANDALONE = '\\documentclass{article}\n\\begin{document}\nSupplement.\n\\end{document}\n'

  it('keeps the last build per root document: another root never replaces yours (also after a restart)', async () => {
    env.write('main.tex', HELLO_TEX)
    env.write('supp.tex', SUPP_STANDALONE)
    const main = await env.compile.compile(env.pid, env.owner, {})
    const supp = await env.compile.compile(env.pid, env.editor, { rootFileId: env.fileId('supp.tex') })
    expect(supp.rootPath).toBe('supp.tex')
    const done = env.events.map(e => e.event).filter(e => e.type === 'compile:done')
    expect(done.map(e => e.type === 'compile:done' && [e.rootPath, e.jobname])).toEqual([['main.tex', 'main'], ['supp.tex', 'supp']])
    for (const c of [env.compile, env.restart({ runner: pr })]) {
      expect((await c.lastBuild(env.pid))?.buildId).toBe(supp.buildId)
      expect((await c.lastBuild(env.pid, { rootPath: 'main.tex' }))?.buildId).toBe(main.buildId)
      expect((await c.lastBuild(env.pid, { rootPath: 'supp.tex' }))?.buildId).toBe(supp.buildId)
      expect((await c.lastBuild(env.pid, { main: true }))?.buildId).toBe(main.buildId)
      expect(await c.lastBuild(env.pid, { rootPath: 'other.tex' })).toBeNull()
    }
    // the main document is the configured one when set
    env.setSettings({ rootFileId: env.fileId('supp.tex') })
    expect((await env.compile.lastBuild(env.pid, { main: true }))?.buildId).toBe(supp.buildId)
  })

  it('lastWithPdf is the last good PDF of the same document, not another root\'s', async () => {
    env.write('main.tex', HELLO_TEX)
    env.write('supp.tex', SUPP_STANDALONE)
    const good = await env.compile.compile(env.pid, env.owner, {})
    pr.failing.add('main.tex')
    const bad = await env.compile.compile(env.pid, env.owner, {})
    expect(bad.status).toBe('failure')
    const supp = await env.compile.compile(env.pid, env.owner, { rootFileId: env.fileId('supp.tex') })
    expect(supp.status).toBe('success')
    const last = await env.compile.lastBuild(env.pid, { rootPath: 'main.tex' })
    expect(last?.buildId).toBe(bad.buildId)
    expect(last?.lastWithPdf?.buildId).toBe(good.buildId)
    const fresh = env.restart({ runner: pr })
    expect((await fresh.lastBuild(env.pid, { rootPath: 'main.tex' }))?.lastWithPdf?.buildId).toBe(good.buildId)
  })

  it('never merges queued compiles of different root documents: each caller gets its own root', async () => {
    env.write('main.tex', HELLO_TEX)
    env.write('supp.tex', SUPP_STANDALONE)
    pr.delayMs = 300
    const first = env.compile.compile(env.pid, env.owner, {})
    await waitFor(() => pr.active === 1)
    const alice = env.compile.compile(env.pid, env.editor, { auto: true, rootFileId: env.fileId('supp.tex') })
    const bob = env.compile.compile(env.pid, env.owner, { auto: true })
    const bob2 = env.compile.compile(env.pid, env.viewer, {})
    const [r0, ra, rb, rb2] = await Promise.all([first, alice, bob, bob2])
    expect(r0.rootPath).toBe('main.tex')
    expect(ra.rootPath).toBe('supp.tex')
    expect(ra.by?.id).toBe(env.editor.id)
    expect(rb.rootPath).toBe('main.tex')
    // the two main-document requests share one follow-up (and it stays manual)
    expect(rb2.buildId).toBe(rb.buildId)
    // arrival order: supp's follow-up before main's
    expect(pr.runs.map(r => r.rootPath)).toEqual(['main.tex', 'supp.tex', 'main.tex'])
    expect(pr.runs[2].force).toBe(true)
  })

  it('stop answers at once for a compile still waiting for a global slot (PERF-2)', async () => {
    await env.close()
    pr = new PerRootRunner({ delayMs: 20 })
    runner = pr
    env = await makeEnv({ runner: pr, userGuardMs: 0, env: { MAX_CONCURRENT_COMPILES: '1' } })
    pr.mode = 'hang'
    const other = env.pid
    env.write('main.tex', HELLO_TEX)
    const waiting = env.newProject('p2')
    env.pid = waiting
    env.write('main.tex', HELLO_TEX)
    const running = env.compile.compile(other, env.owner, {})
    await waitFor(() => pr.active === 1)
    const queued = env.compile.compile(waiting, env.owner, {})
    await new Promise(r => setTimeout(r, 100))
    const t0 = Date.now()
    await env.compile.stop(waiting)
    expect(Date.now() - t0).toBeLessThan(1000)
    const r = await queued
    expect(r.status).toBe('terminated')
    expect(Date.now() - t0).toBeLessThan(1000)
    // a new compile of that project is not stuck behind the dead one; the other compile goes on
    pr.mode = 'success'
    await env.compile.stop(other)
    expect((await running).status).toBe('terminated')
    expect((await env.compile.compile(waiting, env.owner, {})).status).toBe('success')
  })

  const XR_MAIN = '\\documentclass{article}\n\\usepackage{xr}\n\\externaldocument{supp}\n\\begin{document}\nSee \\ref{s:a} and \\ref{s:b}.\n\\end{document}\n'

  it('rebuilds an external document when a file it \\input s (or its .bib) changes (ACC-1)', async () => {
    env.write('main.tex', XR_MAIN)
    env.write('supp.tex', '\\documentclass{article}\n\\begin{document}\n\\input{part}\n\\bibliography{refs}\n\\end{document}\n')
    env.write('part.tex', '\\section{A}\\label{s:a}\n')
    env.write('refs.bib', '@article{a, title={A}}\n')
    const r1 = await env.compile.compile(env.pid, env.owner, {})
    expect(r1.externalBuilds).toEqual([{ path: 'supp.tex', status: 'success' }])
    // unchanged: not rebuilt
    expect((await env.compile.compile(env.pid, env.owner, {})).externalBuilds).toEqual([])
    // a label added in the \input'ed part: rebuilt
    env.write('part.tex', '\\section{B}\\label{s:b}\n\\section{A}\\label{s:a}\n')
    expect((await env.compile.compile(env.pid, env.owner, {})).externalBuilds).toEqual([{ path: 'supp.tex', status: 'success' }])
    // its bibliography changed: rebuilt
    env.write('refs.bib', '@article{a, title={A2}}\n')
    expect((await env.compile.compile(env.pid, env.owner, {})).externalBuilds).toEqual([{ path: 'supp.tex', status: 'success' }])
    // a file only the main document reads: not rebuilt
    env.write('main.tex', XR_MAIN.replace('See', 'Now see'))
    expect((await env.compile.compile(env.pid, env.owner, {})).externalBuilds).toEqual([])
  })

  it('a main document and an external one with the same file name never collide in the build (ACC-2)', async () => {
    env.write('main.tex', '\\documentclass{article}\n\\usepackage{xr}\n\\externaldocument{supp/main}\n\\begin{document}\nMAIN, see \\ref{s:x}.\n\\end{document}\n')
    env.write('supp/main.tex', '\\documentclass{article}\n\\begin{document}\n\\section{Supp}\\label{s:x}\nSUPPLEMENT.\n\\end{document}\n')
    const r1 = await env.compile.compile(env.pid, env.owner, {})
    expect(r1.status).toBe('success')
    expect(r1.externalBuilds).toEqual([{ path: 'supp/main.tex', status: 'success' }])
    const names = r1.outputFiles.map(f => f.path)
    expect(names).toEqual(expect.arrayContaining(['main.pdf', 'main.log', 'supp__main.pdf', 'supp__main.log']))
    expect(r1.pdfUrl).toMatch(/\/main\.pdf$/)
    expect(r1.logUrl).toMatch(/\/main\.log$/)
    // the external document's log is its own: nothing of the main log is reported against it
    expect(r1.log?.warnings.filter(w => w.kind === 'external-undefined-references') ?? []).toEqual([])

    // the main document fails without a PDF, the external one is rebuilt with one
    pr.failing.add('main.tex')
    env.write('supp/main.tex', '\\documentclass{article}\n\\begin{document}\n\\section{Supp}\\label{s:x}\nSUPPLEMENT changed.\n\\end{document}\n')
    const r2 = await env.compile.compile(env.pid, env.owner, { stopOnFirstError: true })
    expect(r2.status).toBe('stopped-on-first-error')
    expect(r2.pdfUrl).toBeNull()
    expect(r2.outputFiles.map(f => f.path)).toEqual(expect.arrayContaining(['main.log', 'supp__main.pdf']))
    expect(r2.outputFiles.map(f => f.path)).not.toContain('main.pdf')
    // errors are reported once, against the main document
    if (r2.log) expect(r2.log.errors.map(e => e.file)).toEqual(['main.tex'])
  })

  it('an external document whose jobname is free keeps its plain output names', async () => {
    env.write('main.tex', '\\documentclass{article}\n\\usepackage{xr}\n\\externaldocument{other/supp}\n\\begin{document}\nx\n\\end{document}\n')
    env.write('other/supp.tex', SUPP_STANDALONE)
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.outputFiles.map(f => f.path)).toEqual(expect.arrayContaining(['main.pdf', 'supp.pdf', 'supp.log']))
  })

  it('retention: an auto-compiling project keeps at most 20 recent builds, plus what a client is reading (PERF-4)', async () => {
    env.write('main.tex', HELLO_TEX)
    pr.delayMs = 1
    const first = await env.compile.compile(env.pid, env.owner, {})
    // a client still reads the first build's PDF
    expect(env.compile.resolveBuildFile(env.pid, first.buildId!, 'main.pdf')).toBeTruthy()
    for (let i = 0; i < 26; i++) {
      env.write('main.tex', `${HELLO_TEX}% ${i}\n`)
      await env.compile.compile(env.pid, env.owner, {})
    }
    await new Promise(r => setTimeout(r, 50)) // pruning runs in the background
    const left = fs.readdirSync(path.join(env.config.dirs.builds, env.pid))
    expect(left.length).toBeLessThanOrEqual(21)
    expect(left).toContain(first.buildId)
  })
})
