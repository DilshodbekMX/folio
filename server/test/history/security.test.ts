import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { validatePath } from '@folio/shared/paths'
import { collect, gitEnv, setup, unzip, type Harness } from './helpers.ts'

let h: Harness
beforeEach(async () => { h = await setup() })
afterEach(async () => { await h.cleanup() })

const HOSTILE = [
  '-rf.tex',
  '--help.tex',
  '-dir/-x.tex',
  'a b/c d.tex',
  'ünïcödé 文件.tex',
  'a:b.tex',
  'it\'s "quoted".tex',
  '$(touch pwned).tex',
  '`touch pwned2`.tex',
  'weird [x]?.tex',
  'x^{tree}.tex',
  '@{-1}.tex',
  'a..b.tex',
  'HEAD',
  '~tilde; rm -rf.tex',
]

describe('hostile file names', () => {
  it('are valid project paths (sanity)', () => {
    for (const p of HOSTILE) expect(validatePath(p), p).toBeNull()
  })

  it('survive snapshot, list, files, diff, fileAt, restore and archive untouched', async () => {
    for (const p of HOSTILE) await h.put(p, `v1 of ${p}\n`)
    await h.history.init(h.pid, h.owner)
    const v1 = (await h.history.list(h.pid, {})).versions[0]
    expect(v1.changes.map(c => c.path).sort()).toEqual([...HOSTILE].sort())

    for (const p of HOSTILE) await h.put(p, `v2 of ${p}\n`)
    const v2 = (await h.history.snapshot(h.pid, 'manual', h.owner))!
    const listed = (await h.history.list(h.pid, {})).versions[0]
    expect(listed.changes.filter(c => c.op === 'modified').map(c => c.path).sort()).toEqual([...HOSTILE].sort())

    const files = await h.history.files(h.pid, v2)
    expect(files.files.map(f => f.path).sort()).toEqual([...HOSTILE].sort())

    for (const p of HOSTILE) {
      const d = await h.history.diff(h.pid, { to: v2, path: p })
      expect(d, p).toMatchObject({ path: p, from: v1.id, oldText: `v1 of ${p}\n`, newText: `v2 of ${p}\n`, binary: false })
      expect((await h.history.fileAt(h.pid, v1.id, p))!.toString()).toBe(`v1 of ${p}\n`)
    }

    const res = await h.history.restore(h.pid, h.owner, v1.id)
    expect(res.restored.sort()).toEqual([...HOSTILE].sort())
    for (const p of HOSTILE) expect(fs.readFileSync(path.join(h.projectDir, p), 'utf8')).toBe(`v1 of ${p}\n`)

    const single = await h.history.restore(h.pid, h.owner, v2, '-dir/-x.tex')
    expect(single.restored).toEqual(['-dir/-x.tex'])

    const zip = await unzip(await collect(await h.history.archive(h.pid, v1.id)))
    expect([...zip.keys()].sort()).toEqual([...HOSTILE].sort())
    expect(zip.get('ünïcödé 文件.tex')!.toString()).toBe('v1 of ünïcödé 文件.tex\n')

    // nothing was ever executed by a shell
    for (const dir of [h.projectDir, h.root, process.cwd()]) {
      expect(fs.existsSync(path.join(dir, 'pwned'))).toBe(false)
      expect(fs.existsSync(path.join(dir, 'pwned2'))).toBe(false)
    }
  })
})

describe('isolation of the separate git dir', () => {
  it('a planted .git file / .gitignore / .gitattributes in the project dir changes nothing', async () => {
    // another repository the planted .git file points to
    const other = path.join(h.root, 'other.git')
    execFileSync('git', ['init', '--quiet', '--bare', other], { env: gitEnv(h.root) })
    await h.put('main.tex', 'line\n')
    await h.put('sub/x.tex', 'sub\n')
    fs.writeFileSync(path.join(h.projectDir, '.git'), `gitdir: ${other}\n`)
    fs.writeFileSync(path.join(h.projectDir, '.gitignore'), '*\n')
    fs.writeFileSync(path.join(h.projectDir, '.gitattributes'), '* export-ignore\n*.tex text eol=crlf filter=evil ident\n')
    fs.writeFileSync(path.join(h.projectDir, 'sub', '.GITkeep'), '')
    fs.writeFileSync(path.join(h.projectDir, '.folio-tmp-123'), 'temp')
    fs.writeFileSync(path.join(h.projectDir, 'id.tex'), '$Id$\n')

    await h.history.init(h.pid, h.owner)
    const head = (await h.history.list(h.pid, {})).versions[0]
    expect(head.changes.map(c => c.path).sort()).toEqual(['id.tex', 'main.tex', 'sub/x.tex'])
    // stored bytes are exactly the disk bytes (no eol/ident conversion)
    expect((await h.history.fileAt(h.pid, head.id, 'main.tex'))!.toString('latin1')).toBe('line\n')
    expect((await h.history.fileAt(h.pid, head.id, 'id.tex'))!.toString()).toBe('$Id$\n')
    // archive ignores export-ignore from the work tree
    const zip = await unzip(await collect(await h.history.archive(h.pid, head.id)))
    expect([...zip.keys()].sort()).toEqual(['id.tex', 'main.tex', 'sub/x.tex'])
    // the planted target repository was never written to
    expect(execFileSync('git', ['--git-dir', other, 'rev-list', '--all'], { env: gitEnv(h.root), encoding: 'utf8' })).toBe('')
    expect(fs.readdirSync(path.join(other, 'objects')).filter(n => /^[0-9a-f]{2}$/.test(n))).toEqual([])
    // and the planted files are still there (history never deletes user-dir files)
    expect(fs.existsSync(path.join(h.projectDir, '.git'))).toBe(true)
  })

  it('a planted .git directory does not capture snapshots', async () => {
    await h.put('main.tex', 'a\n')
    execFileSync('git', ['init', '--quiet', h.projectDir], { env: gitEnv(h.root) })
    await h.history.init(h.pid, h.owner)
    expect(h.git(['ls-tree', '-r', '--name-only', 'HEAD']).trim()).toBe('main.tex')
    expect(() => execFileSync('git', ['-C', h.projectDir, 'rev-parse', '--verify', '-q', 'HEAD'], { env: gitEnv(h.root) })).toThrow()
  })

  it('never runs hooks or fsmonitor, even when the repo config asks for them', async () => {
    await h.put('main.tex', 'a\n')
    await h.history.init(h.pid, h.owner)
    const marker = path.join(h.root, 'hook-ran')
    const script = `#!/bin/sh\necho ran >> "${marker}"\n`
    const hooksDir = path.join(h.gitDir, 'hooks')
    const altHooks = path.join(h.root, 'alt-hooks')
    for (const dir of [hooksDir, altHooks]) {
      fs.mkdirSync(dir, { recursive: true })
      for (const name of ['pre-commit', 'commit-msg', 'post-commit', 'reference-transaction', 'post-index-change', 'fsmonitor-watchman']) {
        fs.writeFileSync(path.join(dir, name), script, { mode: 0o755 })
      }
    }
    h.git(['config', 'core.hooksPath', altHooks])
    h.git(['config', 'core.fsmonitor', path.join(altHooks, 'fsmonitor-watchman')])
    h.git(['config', 'diff.external', path.join(altHooks, 'pre-commit')])

    await h.put('main.tex', 'b\n')
    const v = (await h.history.snapshot(h.pid, 'manual'))!
    await h.history.list(h.pid, {})
    await h.history.diff(h.pid, { to: v, path: 'main.tex' })
    await h.history.createLabel(h.pid, h.owner, 'tagged')
    await collect(await h.history.archive(h.pid, v))
    expect(fs.existsSync(marker)).toBe(false)
  })

  it('ignores GIT_* variables of the server process', async () => {
    const saved = { ...process.env }
    try {
      process.env.GIT_DIR = path.join(h.root, 'nope.git')
      process.env.GIT_WORK_TREE = '/'
      process.env.GIT_INDEX_FILE = path.join(h.root, 'evil-index')
      process.env.GIT_AUTHOR_NAME = 'Mallory'
      process.env.GIT_EXEC_PATH = '/nonexistent'
      await h.put('main.tex', 'a\n')
      await h.history.init(h.pid, h.owner)
      await h.put('main.tex', 'b\n')
      expect(await h.history.snapshot(h.pid, 'manual')).toMatch(/^[0-9a-f]{40}$/)
    } finally {
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
      Object.assign(process.env, saved)
    }
    expect(fs.existsSync(path.join(h.root, 'evil-index'))).toBe(false)
    expect(h.git(['log', '--format=%an']).trim().split('\n')).toEqual(['Folio', 'Olivia Owner'])
  })

  it('rejects project ids that could escape the history directory', async () => {
    for (const bad of ['..', '../x', 'a/b', '', '-x/..']) {
      await expect(h.history.snapshot(bad, 'manual')).rejects.toMatchObject({ status: 404 })
    }
    h.history.noteActivity('../../etc', null) // silently ignored
  })
})
