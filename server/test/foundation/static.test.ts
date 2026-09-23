import fsp from 'node:fs/promises'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import express from 'express'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { jsonCompression } from '../../src/http/compression.ts'
import { Client, startTestServer, type TestServer } from './helpers.ts'

describe('SPA static serving', () => {
  let t: TestServer
  let dist: string

  beforeAll(async () => {
    dist = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-foundation-dist-'))
    await fsp.mkdir(path.join(dist, 'assets'))
    await fsp.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Folio</title><div id="root"></div>')
    await fsp.writeFile(path.join(dist, 'assets', 'app-123.js'), 'console.log(1)')
    await fsp.writeFile(path.join(dist, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>')
    t = await startTestServer({ WEB_DIST: dist })
  })
  afterAll(async () => {
    await t.close()
    await fsp.rm(dist, { recursive: true, force: true })
  })

  it('serves index.html for client routes, assets with immutable caching, JSON 404s for the API', async () => {
    const c = new Client(t.base)
    for (const p of ['/', '/project/abc', '/join/sometoken', '/login?next=%2F']) {
      const r = await c.raw('GET', p)
      expect(r.status, p).toBe(200)
      expect(r.headers.get('content-type')).toContain('text/html')
      expect(r.headers.get('cache-control')).toBe('no-cache')
      expect(await r.text()).toContain('<div id="root">')
    }
    const asset = await c.raw('GET', '/assets/app-123.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect((await c.raw('GET', '/assets/missing.js')).status).toBe(404)
    expect((await c.raw('GET', '/favicon.svg')).status).toBe(200)
    const api = await c.get('/api/nope')
    expect(api.status).toBe(404)
    expect(api.body.error.code).toBe('not_found')
    expect((await c.raw('GET', '/pdfjs/unknown')).status).toBe(404)
    // POSTs to non-API paths are not answered with the SPA
    expect((await c.raw('POST', '/project/abc')).status).toBe(404)
  })
})

describe('HTTP compression (PERF-5)', () => {
  let t: TestServer
  let dist: string
  const JS = `/* bundle */\n${'export function f(){return "Folio compiles LaTeX in a sandbox"}\n'.repeat(200)}`

  /** raw request (no transparent decompression): status, headers and the bytes on the wire */
  function get(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
      http.get(url, { headers }, res => {
        const chunks: Buffer[] = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
      }).on('error', reject)
    })
  }

  beforeAll(async () => {
    dist = await fsp.mkdtemp(path.join(os.tmpdir(), 'folio-foundation-dist-'))
    await fsp.mkdir(path.join(dist, 'assets'))
    await fsp.writeFile(path.join(dist, 'index.html'), '<!doctype html><title>Folio</title><div id="root"></div>')
    await fsp.writeFile(path.join(dist, 'assets', 'index-abc.js'), JS)
    await fsp.writeFile(path.join(dist, 'assets', 'tiny-abc.js'), 'x()')
    t = await startTestServer({ WEB_DIST: dist })
  })
  afterAll(async () => {
    await t.close()
    await fsp.rm(dist, { recursive: true, force: true })
  })

  it('serves static assets brotli- or gzip-compressed when accepted, as they are otherwise', async () => {
    const url = `${t.base}/assets/index-abc.js`
    const br = await get(url, { 'accept-encoding': 'gzip, deflate, br' })
    expect(br.status).toBe(200)
    expect(br.headers['content-encoding']).toBe('br')
    expect(br.headers['vary']).toMatch(/Accept-Encoding/i)
    expect(br.headers['content-type']).toMatch(/javascript/)
    expect(br.headers['cache-control']).toContain('immutable')
    expect(Number(br.headers['content-length'])).toBe(br.body.length)
    expect(br.body.length).toBeLessThan(JS.length / 5)
    expect(zlib.brotliDecompressSync(br.body).toString()).toBe(JS)

    const gz = await get(url, { 'accept-encoding': 'gzip' })
    expect(gz.headers['content-encoding']).toBe('gzip')
    expect(zlib.gunzipSync(gz.body).toString()).toBe(JS)

    const plain = await get(url)
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.body.toString()).toBe(JS)
    // ranges and tiny files are served as they are
    const range = await get(url, { 'accept-encoding': 'br', range: 'bytes=0-9' })
    expect(range.status).toBe(206)
    expect(range.headers['content-encoding']).toBeUndefined()
    expect(range.body.toString()).toBe(JS.slice(0, 10))
    expect((await get(`${t.base}/assets/tiny-abc.js`, { 'accept-encoding': 'br' })).headers['content-encoding']).toBeUndefined()
    // revalidation
    const again = await get(url, { 'accept-encoding': 'br', 'if-none-match': String(br.headers.etag) })
    expect(again.status).toBe(304)
    // no traversal out of the assets folder
    expect((await get(`${t.base}/assets/..%2Findex.html`, { 'accept-encoding': 'br' })).headers['content-encoding']).toBeUndefined()
  })

  it('compresses JSON responses of at least 1 kB, never smaller ones', async () => {
    const app = express()
    app.use(jsonCompression())
    app.get('/big', (_req, res) => { res.json({ text: 'Folio '.repeat(2000) }) })
    app.get('/small', (_req, res) => { res.json({ ok: true }) })
    const server = http.createServer(app)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      const big = await get(`${base}/big`, { 'accept-encoding': 'gzip, br' })
      expect(big.headers['content-encoding']).toBe('br')
      expect(big.headers['content-type']).toBe('application/json; charset=utf-8')
      expect(JSON.parse(zlib.brotliDecompressSync(big.body).toString())).toEqual({ text: 'Folio '.repeat(2000) })
      const gz = await get(`${base}/big`, { 'accept-encoding': 'gzip' })
      expect(JSON.parse(zlib.gunzipSync(gz.body).toString()).text).toHaveLength(12000)
      const raw = await get(`${base}/big`)
      expect(raw.headers['content-encoding']).toBeUndefined()
      expect(JSON.parse(raw.body.toString()).text).toHaveLength(12000)
      const small = await get(`${base}/small`, { 'accept-encoding': 'br' })
      expect(small.headers['content-encoding']).toBeUndefined()
      expect(JSON.parse(small.body.toString())).toEqual({ ok: true })
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
