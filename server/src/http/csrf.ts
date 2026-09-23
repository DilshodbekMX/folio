/**
 * CSRF guard for state-changing requests under /api (SPEC §4.2):
 *  - header `X-Folio-Csrf: 1` is required (cross-origin pages cannot add it without a CORS
 *    preflight, and we never answer preflights);
 *  - `Origin`, when present, must be same-origin — compared with PUBLIC_ORIGIN or the request's
 *    own origin: its Host (with the port), or X-Forwarded-Host / -Proto from a loopback reverse
 *    proxy, exactly like the WebSocket upgrade (http/origin.ts requestHost / requestProto);
 *  - without `Origin`, `Sec-Fetch-Site` must be `same-origin` or absent (non-browser clients).
 * Rejections are logged (warn, at most once a minute per origin/host pair): a misconfigured
 * proxy or PUBLIC_ORIGIN shows up in the server log, not only in the browser.
 */
import type { Request, RequestHandler } from 'express'
import { CSRF_HEADER } from '@folio/shared/api'
import type { Config } from '../config.ts'
import { moduleLog } from '../log.ts'
import { forbidden } from './errors.ts'
import { isAllowedOrigin } from './origin.ts'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const LOG_EVERY_MS = 60_000

const log = moduleLog('http')

export function csrfGuard(config: Config): RequestHandler {
  const lastLogged = new Map<string, number>()
  const report = (req: Request, reason: string, origin: string | undefined) => {
    const key = `${reason}\u0000${origin ?? ''}\u0000${req.host ?? ''}`
    const now = Date.now()
    if (now - (lastLogged.get(key) ?? 0) < LOG_EVERY_MS) return
    if (lastLogged.size > 1000) lastLogged.clear()
    lastLogged.set(key, now)
    log.warn({
      origin, host: req.host, proto: req.protocol, publicOrigin: config.publicOrigin, ip: req.ip, method: req.method, path: req.baseUrl + req.path,
    }, `request rejected: ${reason}${config.publicOrigin ? '' : ' (PUBLIC_ORIGIN is not set)'}`)
  }
  return (req, _res, next) => {
    if (SAFE_METHODS.has(req.method)) return next()
    if (req.get(CSRF_HEADER) !== '1') {
      log.debug({ ip: req.ip, method: req.method, path: req.baseUrl + req.path }, `request rejected: missing ${CSRF_HEADER} header`)
      return next(forbidden(`Missing ${CSRF_HEADER} header`))
    }
    const origin = req.get('origin')
    const site = req.get('sec-fetch-site')
    if (origin !== undefined) {
      if (!isAllowedOrigin(config, origin, req.protocol, req.host)) {
        report(req, 'cross-origin', origin)
        return next(forbidden('Cross-origin request rejected'))
      }
    } else if (site !== undefined && site !== 'same-origin') {
      report(req, `cross-site (Sec-Fetch-Site: ${site})`, undefined)
      return next(forbidden('Cross-site request rejected'))
    }
    next()
  }
}
