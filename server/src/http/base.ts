/**
 * Express app factory without the route modules of other server modules (compile, synctex,
 * history). http/app.ts adds those; tests use this directly so the foundation can be tested
 * on its own.
 *
 * Middleware order (SPEC §4.2): helmet → json(4mb) → session loader → CSRF guard (/api) →
 * JSON compression (/api, res.json ≥ 1 kB) → /healthz, /api/system → route modules → /pdfjs
 * static → SPA static + index.html fallback → JSON 404 for /api → error handler. Static assets
 * are served brotli/gzip-compressed when the browser accepts it (http/compression.ts).
 */
import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import helmet from 'helmet'
import { COMPILERS, type SystemInfo } from '@folio/shared/api'
import type { Config } from '../config.ts'
import type { Services } from '../services.ts'
import { loadSession, requireUser } from '../auth/middleware.ts'
import { authRoutes } from '../auth/routes.ts'
import { projectRoutes } from '../projects/routes.ts'
import { fileRoutes } from '../files/routes.ts'
import { shareRoutes } from '../share/routes.ts'
import { chatRoutes } from '../chat/routes.ts'
import { searchRoutes } from '../search/routes.ts'
import { adminRoutes } from '../admin/routes.ts'
import { moduleLog } from '../log.ts'
import { compressedStatic, jsonCompression } from './compression.ts'
import { csrfGuard } from './csrf.ts'
import { errorHandler } from './error-handler.ts'
import { notFound } from './errors.ts'

const log = moduleLog('http')

export const PDFJS_SUBDIRS = ['cmaps', 'standard_fonts', 'wasm', 'iccs'] as const

export interface BuildAppOptions {
  /** additional route modules (mounted after the foundation routes) */
  extraRouters?: express.Router[]
}

/** The route modules owned by server-foundation. */
export function foundationRouters(s: Services): express.Router[] {
  return [authRoutes(s), projectRoutes(s), fileRoutes(s), shareRoutes(s), chatRoutes(s), searchRoutes(s), adminRoutes(s)]
}

function securityHeaders(): express.RequestHandler {
  return helmet({
    contentSecurityPolicy: {
      directives: {
        'script-src': ["'self'", "'wasm-unsafe-eval'"],
        'img-src': ["'self'", 'data:', 'blob:'],
        'worker-src': ["'self'", 'blob:'],
        'connect-src': ["'self'"],
        'upgrade-insecure-requests': null,
      },
    },
    strictTransportSecurity: false,
    crossOriginEmbedderPolicy: false,
  })
}

function systemInfoHandler(s: Services): express.RequestHandler {
  let cached: { at: number; value: SystemInfo } | null = null
  return async (_req, res) => {
    if (!cached || Date.now() - cached.at > 10_000) {
      let info: Awaited<ReturnType<Services['compile']['info']>>
      try {
        info = await s.compile.info()
      } catch (err) {
        log.warn({ err }, 'compile.info failed')
        info = { runner: s.config.compile.runner, image: s.config.compile.image, texLive: null, dockerOk: false }
      }
      cached = {
        at: Date.now(),
        value: {
          version: s.config.version,
          compileRunner: info.runner,
          compileImage: info.image,
          texLive: info.texLive,
          dockerOk: info.dockerOk,
          engines: COMPILERS.map(c => c.id),
          allowSignup: s.config.allowSignup,
        },
      }
    }
    res.setHeader('Cache-Control', 'no-store')
    res.json(cached.value)
  }
}

function mountPdfjs(app: express.Express, config: Config): void {
  for (const sub of PDFJS_SUBDIRS) {
    app.use(`/pdfjs/${sub}`, compressedStatic(path.join(config.pdfjsDir, sub), { maxAge: 365 * 24 * 3600, immutable: true }))
    app.use(`/pdfjs/${sub}`, express.static(path.join(config.pdfjsDir, sub), {
      index: false, immutable: true, maxAge: '365d', fallthrough: false, dotfiles: 'ignore', redirect: false,
    }))
  }
  // anything else under /pdfjs is a 404 (never the SPA's index.html)
  app.use('/pdfjs', (_req, _res, next) => next(notFound('No such pdf.js asset')))
}

function mountSpa(app: express.Express, config: Config): void {
  const dist = config.webDist
  const indexFile = path.join(dist, 'index.html')
  let present: boolean | null = null
  const hasDist = (): boolean => {
    // re-check until the build appears (the SPA may be built after the server started)
    if (!present) present = fs.existsSync(indexFile)
    return present
  }
  app.use('/assets', (_req, _res, next) => (hasDist() ? next() : next(notFound())))
  app.use('/assets', compressedStatic(path.join(dist, 'assets'), { maxAge: 365 * 24 * 3600, immutable: true }))
  app.use('/assets', express.static(path.join(dist, 'assets'), { index: false, immutable: true, maxAge: '365d', fallthrough: false }))
  const serveDist = express.static(dist, { index: false, redirect: false })
  app.use((req, res, next) => (hasDist() ? serveDist(req, res, next) : next()))
  app.get('/{*splat}', (req, res, next) => {
    const p = req.path
    if (p === '/api' || p.startsWith('/api/') || p.startsWith('/ws/') || p === '/ws' || p.startsWith('/pdfjs/')) return next()
    if (!hasDist()) return next(notFound('The web app has not been built (run npm run build) — use the Vite dev server'))
    res.setHeader('Cache-Control', 'no-cache')
    res.sendFile(indexFile)
  })
}

export function buildApp(s: Services, opts: BuildAppOptions = {}): express.Express {
  const app = express()
  app.disable('x-powered-by')
  app.set('trust proxy', 'loopback')
  app.locals.services = s

  app.use(securityHeaders())
  app.use(express.json({ limit: '4mb' }))
  app.use(loadSession)
  app.use('/api', csrfGuard(s.config))
  app.use('/api', jsonCompression())

  app.get('/healthz', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    res.json({ ok: true })
  })
  app.get('/api/system', requireUser, systemInfoHandler(s))

  for (const router of foundationRouters(s)) app.use(router)
  for (const router of opts.extraRouters ?? []) app.use(router)

  mountPdfjs(app, s.config)
  mountSpa(app, s.config)

  app.use('/api', (_req, _res, next) => next(notFound('No such API route')))
  app.use(errorHandler)
  return app
}
