/**
 * HTTP test harness: the foundation app (http/base.ts) on an ephemeral port and a small
 * cookie-jar client that sends the CSRF header and a same-origin Origin like the web app.
 */
import type { AddressInfo } from 'node:net'
import http from 'node:http'
import yazl from 'yazl'
import { toPublic, type UserRecord } from '../../src/db/index.ts'
import { buildApp } from '../../src/http/base.ts'
import { createUpgradeHandler } from '../../src/http/upgrade.ts'
import { hashPassword } from '../../src/auth/passwords.ts'
import { createSession } from '../../src/auth/sessions.ts'
import type { Services } from '../../src/services.ts'
import { createTestServices, type TestContext } from './fakes.ts'

export const PASSWORD = 'correct horse battery'
let passwordHash: Promise<string> | null = null

export interface TestServer extends TestContext {
  base: string
  server: http.Server
  close(): Promise<void>
}

export async function startTestServer(env: Record<string, string> = {}): Promise<TestServer> {
  const ctx = await createTestServices(env)
  const app = buildApp(ctx.services)
  const server = http.createServer(app)
  server.on('upgrade', createUpgradeHandler(ctx.services))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    ...ctx,
    base: `http://127.0.0.1:${port}`,
    server,
    async close() {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await ctx.cleanup()
    },
  }
}

/** Create a user directly in the db (password PASSWORD; the hash is computed once). */
export async function makeUser(s: Services, email: string, name = email.split('@')[0], isAdmin = false): Promise<UserRecord> {
  passwordHash ??= hashPassword(PASSWORD)
  return s.db.users.create({ email, name, passwordHash: await passwordHash, isAdmin })
}

export interface Res<T = any> {
  status: number
  headers: Headers
  body: T
  text: string
}

export class Client {
  cookie: string | null = null
  constructor(readonly base: string, readonly origin: string | null = base) {}

  /** A client already logged in as `user` (session created directly in the db). */
  static as(t: { base: string; services: Services }, user: UserRecord): Client {
    const c = new Client(t.base)
    const { token } = createSession(t.services.db, t.services.config, user.id)
    c.cookie = `folio_session=${token}`
    return c
  }

  headers(extra: Record<string, string> = {}, method = 'GET'): Record<string, string> {
    const h: Record<string, string> = { ...extra }
    if (this.cookie) h.cookie = this.cookie
    if (method !== 'GET' && method !== 'HEAD') {
      h['X-Folio-Csrf'] ??= '1'
      if (this.origin) h.origin ??= this.origin
    }
    return h
  }

  private capture(res: Response): void {
    const set = res.headers.getSetCookie()
    for (const c of set) {
      const [pair] = c.split(';')
      const [name, value] = pair.split('=')
      if (name !== 'folio_session') continue
      this.cookie = value ? `folio_session=${value}` : null
    }
  }

  async raw(method: string, path: string, init: { body?: RequestInit['body']; headers?: Record<string, string> } = {}): Promise<Response> {
    const res = await fetch(this.base + path, { method, body: init.body, headers: this.headers(init.headers, method), redirect: 'manual' })
    this.capture(res)
    return res
  }

  async req<T = any>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res<T>> {
    const h = body === undefined ? headers : { 'content-type': 'application/json', ...headers }
    const res = await this.raw(method, path, { body: body === undefined ? undefined : JSON.stringify(body), headers: h })
    const text = await res.text()
    let parsed: any = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    return { status: res.status, headers: res.headers, body: parsed, text }
  }

  get<T = any>(path: string) {
    return this.req<T>('GET', path)
  }
  post<T = any>(path: string, body?: unknown, headers?: Record<string, string>) {
    return this.req<T>('POST', path, body ?? {}, headers)
  }
  patch<T = any>(path: string, body?: unknown) {
    return this.req<T>('PATCH', path, body ?? {})
  }
  del<T = any>(path: string) {
    return this.req<T>('DELETE', path)
  }

  async upload<T = any>(path: string, form: FormData): Promise<Res<T>> {
    const res = await this.raw('POST', path, { body: form })
    const text = await res.text()
    let parsed: any = null
    try {
      parsed = text ? JSON.parse(text) : null
    } catch {
      parsed = null
    }
    return { status: res.status, headers: res.headers, body: parsed, text }
  }

  async bytes(path: string): Promise<{ status: number; headers: Headers; data: Buffer }> {
    const res = await this.raw('GET', path)
    return { status: res.status, headers: res.headers, data: Buffer.from(await res.arrayBuffer()) }
  }
}

export function publicOf(u: UserRecord) {
  return toPublic(u)
}

/** Build a zip in memory with yazl. */
export function makeZip(entries: { name: string; data?: string | Buffer; mode?: number; compress?: boolean; dir?: boolean }[]): Promise<Buffer> {
  const zip = new yazl.ZipFile()
  for (const e of entries) {
    if (e.dir) zip.addEmptyDirectory(e.name)
    else zip.addBuffer(Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data ?? ''), e.name, { mode: e.mode, compress: e.compress ?? true })
  }
  zip.end()
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c))
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)))
    zip.outputStream.on('error', reject)
  })
}

/** Replace every occurrence of `from` by `to` (same byte length) — used to forge unsafe entry names. */
export function patchBytes(buf: Buffer, from: string, to: string): Buffer {
  const a = Buffer.from(from)
  const b = Buffer.from(to)
  if (a.length !== b.length) throw new Error('patchBytes: lengths differ')
  const out = Buffer.from(buf)
  let i = out.indexOf(a)
  let n = 0
  while (i !== -1) {
    b.copy(out, i)
    n++
    i = out.indexOf(a, i + a.length)
  }
  if (!n) throw new Error(`patchBytes: "${from}" not found`)
  return out
}

/** Read every entry of a zip buffer. */
export async function readZip(buf: Buffer): Promise<Map<string, Buffer>> {
  const yauzl = (await import('yauzl')).default
  const zip = await yauzl.fromBufferPromise(buf)
  const out = new Map<string, Buffer>()
  for await (const e of zip.eachEntry()) {
    if (e.fileName.endsWith('/')) {
      out.set(e.fileName, Buffer.alloc(0))
      continue
    }
    const stream = await zip.openReadStreamPromise(e)
    const chunks: Buffer[] = []
    for await (const c of stream) chunks.push(c as Buffer)
    out.set(e.fileName, Buffer.concat(chunks))
  }
  zip.close()
  return out
}

export function formWith(files: { name: string; data: string | Buffer; type?: string }[], fields: Record<string, string> = {}, field = 'files'): FormData {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  for (const f of files) form.append(field, new Blob([typeof f.data === 'string' ? f.data : new Uint8Array(f.data)], { type: f.type ?? 'application/octet-stream' }), f.name)
  return form
}
