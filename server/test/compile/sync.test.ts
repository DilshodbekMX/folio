/**
 * Compile-dir sync: incremental writes, removal of stale sources, TeX outputs kept, and
 * symlink safety (the compile dir is writable by the sandbox; our Node process runs on the host).
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MANIFEST_NAME, readManifest, safeFileStat, syncCompileDir, type SnapshotEntry } from '../../src/compile/sync.ts'

let tmp: string
let dir: string
let outside: string

const text = (p: string, content: string): SnapshotEntry => {
  const data = Buffer.from(content)
  return { path: p, kind: 'text', sha1: createHash('sha1').update(data).digest('hex'), size: data.length, data }
}
const binary = (p: string, source: string): SnapshotEntry => {
  const data = fs.readFileSync(source)
  return { path: p, kind: 'binary', sha1: createHash('sha1').update(data).digest('hex'), size: data.length, source }
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-sync-test-'))
  dir = path.join(tmp, 'compile')
  outside = path.join(tmp, 'outside')
  fs.mkdirSync(outside)
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'do not touch')
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('syncCompileDir', () => {
  it('writes the snapshot, then only rewrites changed files and removes deleted sources', async () => {
    const img = path.join(tmp, 'img.png')
    fs.writeFileSync(img, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const r1 = await syncCompileDir(dir, [text('main.tex', 'A'), text('sec/a.tex', 'B'), binary('fig/img.png', img), { path: 'empty', kind: 'folder', sha1: '', size: 0 }])
    expect(r1.written.sort()).toEqual(['fig/img.png', 'main.tex', 'sec/a.tex'])
    expect(fs.readFileSync(path.join(dir, 'sec/a.tex'), 'utf8')).toBe('B')
    expect(fs.readFileSync(path.join(dir, 'fig/img.png'))).toEqual(fs.readFileSync(img))
    expect(fs.statSync(path.join(dir, 'empty')).isDirectory()).toBe(true)
    const m = await readManifest(dir)
    expect(Object.keys(m!.files).sort()).toEqual(['fig/img.png', 'main.tex', 'sec/a.tex'])

    // TeX outputs appear next to the sources
    fs.writeFileSync(path.join(dir, 'main.aux'), 'aux')
    fs.writeFileSync(path.join(dir, 'main.pdf'), 'pdf')
    const mtimeBefore = fs.statSync(path.join(dir, 'main.tex')).mtimeMs

    const r2 = await syncCompileDir(dir, [text('main.tex', 'A'), text('sec/a.tex', 'B2')])
    expect(r2.written).toEqual(['sec/a.tex'])
    expect(r2.removed.sort()).toEqual(['fig/img.png'])
    expect(fs.statSync(path.join(dir, 'main.tex')).mtimeMs).toBe(mtimeBefore)
    expect(fs.readFileSync(path.join(dir, 'sec/a.tex'), 'utf8')).toBe('B2')
    expect(fs.existsSync(path.join(dir, 'fig/img.png'))).toBe(false)
    // generated files survive
    expect(fs.readFileSync(path.join(dir, 'main.aux'), 'utf8')).toBe('aux')
    expect(fs.readFileSync(path.join(dir, 'main.pdf'), 'utf8')).toBe('pdf')
  })

  it('rewrites a source that was modified inside the compile dir', async () => {
    await syncCompileDir(dir, [text('main.tex', 'original')])
    fs.writeFileSync(path.join(dir, 'main.tex'), 'tampered by TeX')
    const r = await syncCompileDir(dir, [text('main.tex', 'original')])
    expect(r.written).toEqual(['main.tex'])
    expect(fs.readFileSync(path.join(dir, 'main.tex'), 'utf8')).toBe('original')
  })

  it('replaces a symlinked source instead of writing through it', async () => {
    await syncCompileDir(dir, [text('main.tex', 'v1')])
    const target = path.join(outside, 'secret.txt')
    fs.rmSync(path.join(dir, 'main.tex'))
    fs.symlinkSync(target, path.join(dir, 'main.tex'))
    await syncCompileDir(dir, [text('main.tex', 'v2')])
    expect(fs.lstatSync(path.join(dir, 'main.tex')).isSymbolicLink()).toBe(false)
    expect(fs.readFileSync(path.join(dir, 'main.tex'), 'utf8')).toBe('v2')
    expect(fs.readFileSync(target, 'utf8')).toBe('do not touch')
  })

  it('replaces a symlinked directory and never writes into its target', async () => {
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify({ version: 1, files: {}, externals: {} }))
    fs.symlinkSync(outside, path.join(dir, 'figures'))
    await syncCompileDir(dir, [text('figures/a.tikz', 'tikz')])
    expect(fs.lstatSync(path.join(dir, 'figures')).isDirectory()).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'figures/a.tikz'), 'utf8')).toBe('tikz')
    expect(fs.readdirSync(outside)).toEqual(['secret.txt'])
  })

  it('unlinks symlinks and special files anywhere in the tree', async () => {
    await syncCompileDir(dir, [text('main.tex', 'x'), text('sub/b.tex', 'y')])
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'main.bbl'))
    fs.symlinkSync('/', path.join(dir, 'sub', 'root'))
    execFileSync('mkfifo', [path.join(dir, 'fifo')])
    await syncCompileDir(dir, [text('main.tex', 'x'), text('sub/b.tex', 'y')])
    expect(fs.existsSync(path.join(dir, 'main.bbl'))).toBe(false)
    expect(() => fs.lstatSync(path.join(dir, 'sub', 'root'))).toThrow()
    expect(() => fs.lstatSync(path.join(dir, 'fifo'))).toThrow()
    expect(fs.readFileSync(path.join(outside, 'secret.txt'), 'utf8')).toBe('do not touch')
  })

  it('replaces a directory standing where a file must go, and a file where a folder must go', async () => {
    fs.mkdirSync(path.join(dir, 'main.tex'), { recursive: true })
    fs.writeFileSync(path.join(dir, MANIFEST_NAME), JSON.stringify({ version: 1, files: {}, externals: {} }))
    fs.writeFileSync(path.join(dir, 'sec'), 'a file named like a folder')
    await syncCompileDir(dir, [text('main.tex', 'x'), text('sec/a.tex', 'y')])
    expect(fs.readFileSync(path.join(dir, 'main.tex'), 'utf8')).toBe('x')
    expect(fs.readFileSync(path.join(dir, 'sec/a.tex'), 'utf8')).toBe('y')
  })

  it('empties a compile dir without a readable manifest (unknown state)', async () => {
    fs.mkdirSync(dir)
    fs.writeFileSync(path.join(dir, 'leftover.aux'), 'old')
    fs.writeFileSync(path.join(dir, MANIFEST_NAME), '{not json')
    await syncCompileDir(dir, [text('main.tex', 'x')])
    expect(fs.readdirSync(dir).sort()).toEqual([MANIFEST_NAME, 'main.tex'])
  })

  it('replaces the compile dir itself when it is a symlink', async () => {
    fs.symlinkSync(outside, dir)
    await syncCompileDir(dir, [text('main.tex', 'x')])
    expect(fs.lstatSync(dir).isDirectory()).toBe(true)
    expect(fs.readdirSync(outside)).toEqual(['secret.txt'])
  })

  it('does not write skipped paths (they would clash with TeX outputs)', async () => {
    await syncCompileDir(dir, [text('main.tex', 'x'), text('main.log', 'user log')], { skip: new Set(['main.log']) })
    expect(fs.existsSync(path.join(dir, 'main.log'))).toBe(false)
  })

  it('rejects entries escaping the compile dir', async () => {
    await expect(syncCompileDir(dir, [text('../escape.tex', 'x')])).rejects.toThrow(/escapes/)
    expect(fs.existsSync(path.join(tmp, 'escape.tex'))).toBe(false)
  })

  it('safeFileStat refuses symlinks on the way', async () => {
    await syncCompileDir(dir, [text('a/b.tex', 'x')])
    expect(await safeFileStat(dir, 'a/b.tex')).toBeTruthy()
    fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(dir, 'link.log'))
    fs.symlinkSync(outside, path.join(dir, 'linkdir'))
    expect(await safeFileStat(dir, 'link.log')).toBeNull()
    expect(await safeFileStat(dir, 'linkdir/secret.txt')).toBeNull()
    expect(await safeFileStat(dir, '../outside/secret.txt')).toBeNull()
  })
})
