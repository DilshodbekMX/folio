/**
 * Compiles the built-in templates with pdfLaTeX in the TeX Live image (FOLIO_DOCKER_TESTS=1).
 */
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTemplate } from '../../src/projects/templates.ts'

const exec = promisify(execFile)
const IMAGE = 'texlive/texlive:latest-full'
const docker = process.env.FOLIO_DOCKER_TESTS === '1'

function latexmk(dir: string, name: string): Promise<{ code: number; out: string }> {
  const uid = process.getuid?.() ?? 1000
  const gid = process.getgid?.() ?? 1000
  const args = [
    'run', '--rm', '--init', '--name', name, '--label', 'folio.kind=test', '--label', 'folio.owner=server-foundation',
    '--network', 'none', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=256m', '--user', `${uid}:${gid}`, '-e', 'HOME=/tmp',
    '-v', `${dir}:/work:rw`, '-w', '/work', IMAGE,
    'latexmk', '-norc', '-pdf', '-interaction=nonstopmode', '-halt-on-error', '-file-line-error', 'main.tex',
  ]
  return new Promise(resolve => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.on('data', d => (out += d))
    child.stderr.on('data', d => (out += d))
    const timer = setTimeout(() => void exec('docker', ['kill', name]).catch(() => {}), 240_000)
    child.on('close', code => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, out })
    })
  })
}

describe.skipIf(!docker)('templates compile with pdfLaTeX (docker)', () => {
  let tmp: string
  beforeAll(async () => {
    tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-foundation-tpl-'))
  })
  afterAll(async () => {
    await fsp.rm(tmp, { recursive: true, force: true })
  })

  for (const template of ['blank', 'example'] as const) {
    it(`${template} template`, async () => {
      const dir = path.join(tmp, template)
      await fsp.mkdir(dir)
      const t = buildTemplate(template, { projectName: 'Test & {Project} 100%', authorName: 'Ada_Lovelace #1' })
      for (const f of t.files) await fsp.writeFile(path.join(dir, f.path), f.content)
      const name = `folio-server-foundation-${template}-${randomBytes(4).toString('hex')}`
      const r = await latexmk(dir, name)
      expect(r.code, r.out.slice(-3000)).toBe(0)
      const pdf = await fsp.stat(path.join(dir, 'main.pdf'))
      expect(pdf.size).toBeGreaterThan(1000)
      const log = await fsp.readFile(path.join(dir, 'main.log'), 'utf8')
      expect(log).not.toMatch(/^! /m)
      expect(log).not.toMatch(/undefined references|Citation .* undefined|Reference .* undefined/)
      if (template === 'example') {
        const blg = await fsp.readFile(path.join(dir, 'main.blg'), 'utf8')
        expect(blg).not.toMatch(/error message/)
        const aux = await fsp.readFile(path.join(dir, 'main.aux'), 'utf8')
        for (const key of ['lamport1994latex', 'knuth1984texbook', 'mittelbach2004companion']) expect(aux).toContain(key)
        for (const label of ['fig:pipeline', 'tab:results', 'eq:gauss', 'sec:math']) expect(aux).toContain(`{${label}}`)
      }
    }, 300_000)
  }
})
