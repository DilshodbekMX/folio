/**
 * Live checks against the TeX Live image (FOLIO_DOCKER_TESTS=1): compile fixture sources with the
 * compile argv of SPEC §4.5 and verify the log parser and the SyncTeX parser on fresh output.
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { forwardSearchBoxes, inverseSearch, parseSynctexText } from '../src/synctex/index.ts'
import { parseBlg, parseLatexLog } from '../src/texlog/index.ts'
import { FIXTURES, brief } from './helpers.ts'

const DOCKER = process.env.FOLIO_DOCKER_TESTS === '1'
const IMAGE = process.env.COMPILE_IMAGE ?? 'texlive/texlive:latest-full'
const uid = typeof process.getuid === 'function' ? process.getuid() : 1000
const gid = typeof process.getgid === 'function' ? process.getgid() : 1000

function docker(dir: string, cache: string, argv: string[], env: Record<string, string> = {}): { code: number | null; stdout: string } {
  const name = `folio-shared-parsers-${randomBytes(6).toString('hex')}`
  const args = [
    'run', '--rm', '--init', '--name', name, '--label', 'folio.test=shared-parsers', '--network', 'none', '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges', '--pids-limit', '512', '--memory', '2g', '--memory-swap', '2g', '--cpus', '2',
    '--read-only', '--tmpfs', '/tmp:rw,exec,nosuid,nodev,size=256m', '--user', `${uid}:${gid}`,
    '-e', 'HOME=/tmp', '-e', 'XDG_CACHE_HOME=/cache/xdg', '-e', 'TEXMFVAR=/cache/texmf-var',
    ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    '-v', `${dir}:/compile:rw`, '-v', `${cache}:/cache:rw`, '-w', '/compile', IMAGE, ...argv,
  ]
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 64 << 20 })
  if (r.error || r.status === null) spawnSync('docker', ['kill', name])
  return { code: r.status, stdout: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

const UNWRAP = { max_print_line: '10000', error_line: '254', half_error_line: '238' }
const latexmk = (engine: string, root: string) =>
  ['latexmk', '-norc', '-cd', `-jobname=${path.basename(root, '.tex')}`, '-synctex=1', '-interaction=batchmode', '-file-line-error', '-f', engine, `/compile/${root}`]

describe.skipIf(!DOCKER)('live TeX Live output (docker)', () => {
  let tmp: string
  let cache: string

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-shared-parsers-'))
    cache = path.join(tmp, 'cache')
    fs.mkdirSync(cache)
  })
  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('pdfLaTeX error document: the parser finds every problem', () => {
    const dir = path.join(tmp, 'errors')
    fs.cpSync(path.join(FIXTURES, 'texlog/sources'), dir, { recursive: true })
    const r = docker(dir, cache, latexmk('-pdf', 'errors.tex'), UNWRAP)
    expect(r.code).not.toBeNull()
    const files = ['errors.tex', 'sections/intro.tex', 'my dir/file name.tex']
    const log = parseLatexLog(fs.readFileSync(path.join(dir, 'errors.log')), { projectFiles: files })
    expect(brief(log.errors).map(e => [e[1], e[2], e[3]])).toEqual([
      ['undefined-control-sequence', 'errors.tex', 5], ['missing-dollar', 'errors.tex', 6], ['missing-dollar', 'sections/intro.tex', 1],
      ['undefined-control-sequence', 'sections/intro.tex', 3], ['package-error', 'errors.tex', 13], ['runaway-argument', 'errors.tex', 16],
      ['tex-error', 'errors.tex', 16], ['unicode-character', 'errors.tex', 22],
    ])
    expect(log.typesetting).toHaveLength(6)
    expect(log.warnings.filter(w => w.kind === 'undefined-reference' || w.kind === 'undefined-citation')).toHaveLength(2)
  }, 300_000)

  it('BibTeX document: .blg errors and warnings', () => {
    const dir = path.join(tmp, 'bt')
    fs.cpSync(path.join(FIXTURES, 'texlog/sources'), dir, { recursive: true })
    docker(dir, cache, latexmk('-pdf', 'bt.tex'), UNWRAP)
    const blg = parseBlg(fs.readFileSync(path.join(dir, 'bt.blg'), 'utf8'), { projectFiles: ['bt.tex', 'refs.bib'] })
    expect(blg.errors.map(e => [e.file, e.line])).toEqual([['refs.bib', 14], ['refs.bib', 22]])
    expect(blg.warnings).toHaveLength(9)
  }, 300_000)

  it('SyncTeX of a fresh multi-file build agrees with the synctex CLI', () => {
    const dir = path.join(tmp, 'small')
    fs.cpSync(path.join(FIXTURES, 'synctex/small-src'), dir, { recursive: true })
    docker(dir, cache, latexmk('-pdf', 'main.tex'), UNWRAP)
    const idx = parseSynctexText(gunzipSync(fs.readFileSync(path.join(dir, 'main.synctex.gz'))).toString('latin1'))
    const queries: [string, number][] = [['main.tex', 11], ['main.tex', 20], ['chapters/intro.tex', 3], ['chapters/intro.tex', 9], ['chapters/results.tex', 2], ['chapters/results.tex', 19]]
    const script = queries.map(([f, l]) => `echo "@@ ${f} ${l}"; synctex view -i "${l}:0:${f}" -o main.pdf`).join('; ')
    const out = docker(dir, cache, ['sh', '-c', script]).stdout
    const blocks = out.split('@@ ').slice(1)
    expect(blocks).toHaveLength(queries.length)
    for (const [i, block] of blocks.entries()) {
      const page = Number(/^Page:(\d+)$/m.exec(block)![1])
      const v = Number(/^v:([\d.]+)$/m.exec(block)![1])
      const H = Number(/^H:([\d.]+)$/m.exec(block)![1])
      const [f, l] = queries[i]
      const js = forwardSearchBoxes(idx, f, l)[0]
      expect(js.page).toBe(page)
      // first boxes overlap vertically
      expect(Math.min(js.v, v) - Math.max(js.v - js.H, v - H)).toBeGreaterThan(-1)
    }
    // inverse: a point on the first line of the introduction
    const box = forwardSearchBoxes(idx, 'chapters/intro.tex', 3)[0]
    const edit = docker(dir, cache, ['synctex', 'edit', '-o', `${box.page}:${box.h + 20}:${box.v - 3}:main.pdf`]).stdout
    const line = Number(/^Line:(\d+)$/m.exec(edit)![1])
    expect(inverseSearch(idx, box.page, box.h + 20, box.v - 3)[0].line).toBe(line)
  }, 300_000)
})
