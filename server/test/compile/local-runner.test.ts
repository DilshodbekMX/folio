/**
 * LocalRunner (COMPILE_RUNNER=local) with stub `latexmk` / `texcount` scripts on PATH: argv,
 * working directory, container-path mapping for tools, timeout and abort kill the process group.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { LocalRunner } from '../../src/compile/runner.ts'

let tmp: string
let compileDir: string
let savedPath: string | undefined

const LATEXMK = `#!/bin/sh
echo "ARGS: $*"
echo "CWD: $(pwd)"
echo "MPL: $max_print_line"
job=""; last=""
for a in "$@"; do
  case "$a" in -jobname=*) job="\${a#-jobname=}";; esac
  last="$a"
done
# the runner passes only a minimal TeX environment, so the sleep is controlled through a file
if [ -f "$(dirname "$0")/sleep" ]; then sleep "$(cat "$(dirname "$0")/sleep")"; fi
printf '%%PDF-1.4 stub' > "$(dirname "$last")/$job.pdf"
exit 0
`

const TEXCOUNT = `#!/bin/sh
echo "Words in text: 5"
echo "CWD: $(pwd)"
echo "ARG: $*"
`

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-local-runner-'))
  const bin = path.join(tmp, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, 'latexmk'), LATEXMK, { mode: 0o755 })
  fs.writeFileSync(path.join(bin, 'texcount'), TEXCOUNT, { mode: 0o755 })
  compileDir = path.join(tmp, 'compile')
  fs.mkdirSync(path.join(compileDir, 'sub'), { recursive: true })
  fs.writeFileSync(path.join(compileDir, 'sub/main.tex'), 'x')
  savedPath = process.env.PATH
  process.env.PATH = `${bin}:${savedPath ?? ''}`
})

afterAll(() => {
  process.env.PATH = savedPath
  fs.rmSync(tmp, { recursive: true, force: true })
})

const job = (o: Partial<Parameters<LocalRunner['latexmk']>[0]> = {}) => ({
  name: 'local-test', projectId: 'p', compileDir, rootPath: 'sub/main.tex', jobname: 'main', compiler: 'pdflatex' as const,
  draft: false, stopOnFirstError: false, force: true, timeoutMs: 10_000, ...o,
})

describe('LocalRunner', () => {
  it('runs latexmk with the host paths and the log environment', async () => {
    const r = await new LocalRunner().latexmk(job())
    expect(r.code).toBe(0)
    expect(r.error).toBeNull()
    expect(r.output).toContain(`ARGS: -norc -cd -jobname=main -synctex=1 -interaction=batchmode -file-line-error -time -gt -f -pdf ${compileDir}/sub/main.tex`)
    expect(r.output).toContain(`CWD: ${compileDir}`)
    expect(r.output).toContain('MPL: 10000')
    expect(fs.readFileSync(path.join(compileDir, 'sub/main.pdf'), 'utf8')).toBe('%PDF-1.4 stub')
    expect(new LocalRunner().texCompileDir(compileDir)).toBe(compileDir)
  })

  it('timeout kills the whole process group', async () => {
    fs.writeFileSync(path.join(tmp, 'bin', 'sleep'), '30')
    try {
      const t0 = Date.now()
      const r = await new LocalRunner().latexmk(job({ timeoutMs: 300 }))
      expect(r.timedOut).toBe(true)
      expect(r.terminated).toBe(false)
      expect(Date.now() - t0).toBeLessThan(5000)
    } finally {
        }
  })

  it('abort terminates the run', async () => {
    fs.writeFileSync(path.join(tmp, 'bin', 'sleep'), '30')
    try {
      const ac = new AbortController()
      const p = new LocalRunner().latexmk(job({ signal: ac.signal }))
      setTimeout(() => ac.abort(), 200)
      const r = await p
      expect(r.terminated).toBe(true)
      expect(r.timedOut).toBe(false)
    } finally {
        }
  })

  it('maps container paths of tools to the host', async () => {
    const r = await new LocalRunner().tool({
      name: 'wc', argv: ['texcount', '-nocol', '/compile/sub/main.tex'],
      mounts: [{ host: compileDir, container: '/compile', ro: true }], workdir: '/compile/sub', timeoutMs: 10_000,
    })
    expect(r.code).toBe(0)
    const out = r.stdout.toString()
    expect(out).toContain(`CWD: ${compileDir}/sub`)
    expect(out).toContain(`ARG: -nocol ${compileDir}/sub/main.tex`)
  })

  it('reports a missing binary as an infrastructure error', async () => {
    const r = await new LocalRunner().tool({ name: 'x', argv: ['folio-definitely-missing-binary'], mounts: [], timeoutMs: 5000 })
    expect(r.error).toMatch(/Cannot run/)
  })
})
