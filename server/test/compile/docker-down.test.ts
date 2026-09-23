/**
 * Graceful behaviour when Docker is unavailable: compiles end with status 'error' and a clear,
 * actionable message (never a TeX 'failure'), and the system info reports dockerOk: false.
 * DOCKER_HOST points at a socket that does not exist, so no daemon is needed for this test.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { explainDockerFailure } from '../../src/compile/sandbox.ts'
import { HELLO_TEX, makeEnv, type TestEnv } from './helpers.ts'

describe('explainDockerFailure', () => {
  const image = 'texlive/texlive:latest-full'
  it('recognises daemon, permission and image problems', () => {
    expect(explainDockerFailure('failed to connect to the docker API at unix:///x.sock; check if the path is correct and if the daemon is running', image)).toMatch(/Docker is not running/)
    expect(explainDockerFailure('Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?', image)).toMatch(/Docker is not running/)
    expect(explainDockerFailure('permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock', image)).toMatch(/docker" group/)
    expect(explainDockerFailure('docker: Error response from daemon: No such image: texlive/texlive:latest-full', image)).toMatch(/docker pull texlive\/texlive:latest-full/)
    expect(explainDockerFailure('docker: Error response from daemon: conflict: name in use\n', image)).toMatch(/could not start the compile container: Error response from daemon: conflict/)
  })
  it('never blames docker once latexmk ran', () => {
    expect(explainDockerFailure('Rc files read:\n  NONE\nLatexmk: This is Latexmk\n! No such image in my document', image)).toBeNull()
    expect(explainDockerFailure('', image)).toBeNull()
  })
})

describe('compiling while Docker is down', () => {
  let env: TestEnv
  const saved = process.env.DOCKER_HOST
  beforeAll(async () => {
    process.env.DOCKER_HOST = 'unix:///nonexistent/folio-test-docker.sock'
    env = await makeEnv({ runnerKind: 'docker' })
  })
  afterAll(async () => {
    await env.close()
    if (saved === undefined) delete process.env.DOCKER_HOST
    else process.env.DOCKER_HOST = saved
  })

  it('returns status error with an actionable message', async () => {
    env.write('main.tex', HELLO_TEX)
    const r = await env.compile.compile(env.pid, env.owner, {})
    expect(r.status).toBe('error')
    expect(r.pdfUrl).toBeNull()
    expect(r.stdout).toMatch(/\[Folio\] (Docker is not running|Docker is not installed)/)
    const info = await env.compile.info()
    expect(info).toMatchObject({ runner: 'docker', dockerOk: false, texLive: null })
  })
})
