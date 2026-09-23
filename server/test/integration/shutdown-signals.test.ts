/**
 * The real server process (main.ts) and its signal handling (OPS-3): under `npm run dev` a
 * Ctrl+C reaches the server twice within milliseconds (terminal + tsx watch). That must not
 * skip the graceful shutdown: an edit the server acknowledged but has not saved yet (2 s save
 * debounce) ends up on disk, and the process says "bye".
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as Y from 'yjs'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FileEntry, ProjectDetail } from '@folio/shared/api'
import { DOC_TEXT_KEY } from '@folio/shared/protocol'
import { hashPassword } from '../../src/auth/passwords.ts'
import { createSession } from '../../src/auth/sessions.ts'
import { loadConfig } from '../../src/config.ts'
import { openDb } from '../../src/db/index.ts'

const ROOT = path.resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

describe('server process: shutdown on signals', () => {
  let dataDir: string
  let child: ChildProcess
  let output = ''
  let base: string
  let cookie: string

  beforeAll(async () => {
    dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-signals-'))
    const config = loadConfig({ DATA_DIR: dataDir, NODE_ENV: 'test' })
    for (const d of Object.values(config.dirs)) fs.mkdirSync(d, { recursive: true })
    const db = openDb(config.dbFile)
    const user = db.users.create({ email: 'alice@example.com', name: 'Alice', passwordHash: await hashPassword('signal-pass-1'), isAdmin: true })
    cookie = `folio_session=${createSession(db, config, user.id).token}`
    db.close()
    const port = await freePort()
    base = `http://127.0.0.1:${port}`
    child = spawn(process.execPath, ['--import', 'tsx', path.join(ROOT, 'server/src/main.ts')], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: 'production', FOLIO_ENV_FILE: 'none', LOG_LEVEL: 'info',
        DATA_DIR: dataDir, PORT: String(port), HOST: '127.0.0.1', COMPILE_RUNNER: 'fake',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout!.on('data', d => { output += String(d) })
    child.stderr!.on('data', d => { output += String(d) })
    for (let i = 0; i < 300; i++) {
      try {
        if ((await fetch(`${base}/healthz`)).ok) return
      } catch {
        // not up yet
      }
      await sleep(50)
    }
    throw new Error(`the server did not start:\n${output}`)
  })

  afterAll(async () => {
    if (child.exitCode === null) child.kill('SIGKILL')
    await fsp.rm(dataDir, { recursive: true, force: true })
  })

  it('the same SIGINT twice within milliseconds still shuts down gracefully and saves acknowledged edits', async () => {
    const headers = { cookie, 'X-Folio-Csrf': '1', origin: base, 'content-type': 'application/json' }
    const created = await fetch(`${base}/api/projects`, { method: 'POST', headers, body: JSON.stringify({ name: 'Signals', template: 'blank' }) })
    expect(created.status).toBe(201)
    const pid = ((await created.json()) as { id: string }).id
    const detail = (await (await fetch(`${base}/api/projects/${pid}`, { headers: { cookie } })).json()) as ProjectDetail
    const main = detail.files.find(f => f.path === 'main.tex') as FileEntry

    const doc = new Y.Doc()
    const provider = new WebsocketProvider(`${base.replace('http', 'ws')}/ws/doc/${pid}`, main.id, doc, {
      WebSocketPolyfill: class extends WebSocket {
        constructor(url: string, protocols?: string | string[]) {
          super(url, protocols, { headers: { cookie, origin: base } })
        }
      } as unknown as typeof globalThis.WebSocket,
      disableBc: true,
      params: { epoch: String(main.epoch) },
    })
    const marker = `% SIGNAL-${Date.now()}`
    try {
      for (let i = 0; i < 300 && !provider.synced; i++) await sleep(10)
      expect(provider.synced).toBe(true)
      doc.getText(DOC_TEXT_KEY).insert(0, `${marker}\n`)
      // the server has the edit (live text), but has not saved it yet (2 s debounce)
      for (let i = 0; i < 200; i++) {
        const live = await (await fetch(`${base}/api/projects/${pid}/files/${main.id}/raw`, { headers: { cookie } })).text()
        if (live.includes(marker)) break
        await sleep(10)
      }
      const onDisk = path.join(dataDir, 'projects', pid, 'main.tex')
      expect(fs.readFileSync(onDisk, 'utf8')).not.toContain(marker)

      const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
      child.kill('SIGINT')
      await sleep(2)
      child.kill('SIGINT')
      const code = await Promise.race([exited, sleep(30_000).then(() => 'timeout' as const)])
      expect(code).toBe(0)
      expect(output).toContain('"msg":"bye"')
      expect(output).not.toMatch(/second SIGINT/)
      expect(fs.readFileSync(onDisk, 'utf8')).toContain(marker)
    } finally {
      provider.destroy()
      doc.destroy()
    }
  })
})
