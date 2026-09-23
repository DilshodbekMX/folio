/**
 * HTTP compression without extra dependencies:
 *
 *   - compressedStatic(dir): the web app's hashed, immutable assets (JS, CSS, source maps, SVG,
 *     fonts, wasm…) are served brotli- or gzip-compressed when the browser accepts it. Each file
 *     is compressed once, on first request (brotli q9: ~60 ms for the 1.4 MB main bundle), and
 *     kept in memory; a rebuilt file (other size / mtime) is compressed again. Range requests and
 *     files that do not shrink fall through to express.static.
 *   - jsonCompression(): API responses sent with res.json() of at least 1 kB (search results,
 *     history diffs, GET /compile/last) are compressed asynchronously (brotli q4 or gzip).
 *     Nothing else is touched: build outputs (PDF ranges, SyncTeX), file downloads and zips keep
 *     their bytes, and WebSocket upgrades never reach Express.
 *
 * Both set `Vary: Accept-Encoding`.
 */
import fs from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import zlib from 'node:zlib'
import type { Request, RequestHandler, Response } from 'express'
import { moduleLog } from '../log.ts'

const log = moduleLog('http')

const brotli = promisify(zlib.brotliCompress)
const gzip = promisify(zlib.gzip)

type Encoding = 'br' | 'gzip'

/** extensions of text-like assets worth compressing (woff2, png, … are compressed already) */
const COMPRESSIBLE = new Set(['.js', '.mjs', '.css', '.map', '.json', '.svg', '.html', '.txt', '.wasm', '.ttf', '.otf', '.woff', '.icc', '.bcmap', '.pfb'])
/** smaller files are not worth it */
const MIN_BYTES = 1024
/** assets larger than this are served as they are */
const MAX_ASSET_BYTES = 16 * 1024 * 1024
/** compressed variants kept in memory */
const MAX_CACHED = 400

/**
 * br when the client accepts it at least as much as gzip (browsers list gzip first with the same
 * weight, which a plain negotiation would pick), else gzip, else null (send as is).
 */
export function preferredEncoding(req: Pick<Request, 'headers'>): Encoding | null {
  const header = req.headers['accept-encoding']
  if (typeof header !== 'string' || !header) return null
  const q = new Map<string, number>()
  for (const part of header.toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map(x => x.trim())
    if (!name) continue
    let weight = 1
    for (const p of params) {
      const m = /^q=([0-9.]+)$/.exec(p)
      if (m) weight = Number(m[1])
    }
    q.set(name, Number.isFinite(weight) ? weight : 0)
  }
  const star = q.get('*') ?? 0
  const br = q.get('br') ?? star
  const gz = q.get('gzip') ?? q.get('x-gzip') ?? star
  if (br > 0 && br >= gz) return 'br'
  return gz > 0 ? 'gzip' : null
}

function compress(data: Buffer, enc: Encoding, dynamic: boolean): Promise<Buffer> {
  if (enc === 'gzip') return gzip(data, { level: dynamic ? 6 : 9 })
  return brotli(data, {
    params: {
      [zlib.constants.BROTLI_PARAM_QUALITY]: dynamic ? 4 : 9,
      [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length,
    },
  })
}

interface CachedAsset {
  /** `${size}:${mtimeMs}` of the file when it was compressed */
  key: string
  data: Promise<Buffer | null>
}

/**
 * Serve compressed copies of the static files under `dir` (mount it right before express.static
 * for the same path). `maxAge` in seconds; `immutable` adds the immutable directive.
 */
export function compressedStatic(dir: string, opts: { maxAge: number; immutable: boolean }): RequestHandler {
  const root = path.resolve(dir)
  const cache = new Map<string, CachedAsset>()
  const cacheControl = `public, max-age=${opts.maxAge}${opts.immutable ? ', immutable' : ''}`

  return async (req, res, next) => {
    try {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || req.headers.range) return next()
      let rel: string
      try {
        rel = decodeURIComponent(req.path)
      } catch {
        return next()
      }
      const ext = path.extname(rel).toLowerCase()
      if (!COMPRESSIBLE.has(ext) || rel.includes('\0')) return next()
      const clean = path.posix.normalize(`/${rel}`)
      // like express.static (dotfiles: 'ignore'): nothing under a dot-file or dot-folder
      if (clean.split('/').some(seg => seg.startsWith('.'))) return next()
      const abs = path.resolve(root, `.${clean}`)
      if (!abs.startsWith(root + path.sep)) return next()
      res.vary('Accept-Encoding')
      const enc = preferredEncoding(req)
      if (!enc) return next()
      const st = await fs.lstat(abs).catch(() => null)
      if (!st?.isFile() || st.size < MIN_BYTES || st.size > MAX_ASSET_BYTES) return next()
      const key = `${st.size}:${st.mtimeMs}`
      const id = `${enc}\0${abs}`
      let hit = cache.get(id)
      if (!hit || hit.key !== key) {
        if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value!)
        const data = fs.readFile(abs)
          .then(raw => compress(raw, enc, false))
          .then(out => (out.length < st.size ? out : null))
          .catch(err => {
            log.warn({ err, file: abs }, 'could not compress a static file')
            return null
          })
        hit = { key, data }
        cache.set(id, hit)
      }
      const body = await hit.data
      if (!body) return next()
      const etag = `W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}-${enc}"`
      res.type(ext)
      res.set({
        'Content-Encoding': enc,
        'Cache-Control': cacheControl,
        'Last-Modified': st.mtime.toUTCString(),
        ETag: etag,
      })
      if (req.fresh) {
        res.status(304).end()
        return
      }
      res.set('Content-Length', String(body.length))
      if (req.method === 'HEAD') res.end()
      else res.end(body)
    } catch (err) {
      next(err)
    }
  }
}

/** Compress JSON bodies of at least `minBytes` sent with res.json() (mount before the API routes). */
export function jsonCompression(minBytes = MIN_BYTES): RequestHandler {
  return (req, res, next) => {
    const plain = res.json.bind(res)
    res.json = function json(body: unknown): Response {
      const enc = preferredEncoding(req)
      let text: string | undefined
      try {
        text = JSON.stringify(body)
      } catch {
        return plain(body)
      }
      if (text === undefined) return plain(body)
      res.vary('Accept-Encoding')
      if (!enc || res.getHeader('Content-Encoding') || Buffer.byteLength(text) < minBytes) return plain(body)
      const raw = Buffer.from(text, 'utf8')
      compress(raw, enc, true).then(out => {
        if (res.headersSent || res.writableEnded) return
        res.set('Content-Type', 'application/json; charset=utf-8')
        res.set('Content-Encoding', enc)
        res.send(out)
      }, err => {
        log.warn({ err }, 'could not compress a JSON response')
        if (!res.headersSent) res.set('Content-Type', 'application/json; charset=utf-8').send(raw)
      })
      return res
    }
    next()
  }
}
