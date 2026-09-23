/**
 * Same-origin rule shared by the REST CSRF guard and the WebSocket upgrade handler:
 * an `Origin` is accepted when it equals `config.publicOrigin` or `${proto}://${Host}`.
 *
 * DNS rebinding: a page on an attacker's domain that resolves to this server has
 * Origin == `${proto}://${Host}` of that domain. Its requests carry no Folio cookie, but anonymous
 * endpoints (first-run /setup, login) would accept them. When PUBLIC_ORIGIN is configured, a
 * Host-derived origin is therefore only trusted for IP literals and localhost (direct/local
 * access); every other name must be the public one.
 */
import type { IncomingMessage } from 'node:http'
import type { TLSSocket } from 'node:tls'
import type { Config } from '../config.ts'

function isLoopback(addr: string | undefined): boolean {
  if (!addr) return false
  return addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.')
}

/** true for Host values that cannot be an attacker-controlled DNS name: IP literals and localhost */
export function isLiteralHost(host: string): boolean {
  const h = host.trim().toLowerCase()
  const name = h.startsWith('[') ? h.slice(1, h.indexOf(']')) : h.replace(/:\d+$/, '')
  return name === 'localhost' || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(name) || (name.includes(':') && /^[0-9a-f:.]+$/.test(name))
}

export function isAllowedOrigin(config: Config, origin: string, proto: string, host: string | undefined): boolean {
  const o = origin.trim().toLowerCase().replace(/\/+$/, '')
  if (config.publicOrigin && o === config.publicOrigin.toLowerCase()) return true
  if (!host || o !== `${proto}://${host}`.toLowerCase()) return false
  return !config.publicOrigin || isLiteralHost(host)
}

/**
 * Protocol of a raw request (WebSocket upgrades don't go through Express): TLS socket → https;
 * X-Forwarded-Proto is honoured only from a loopback reverse proxy (same policy as Express'
 * `trust proxy: 'loopback'` configured in the app).
 */
export function requestProto(req: IncomingMessage): 'http' | 'https' {
  if ((req.socket as TLSSocket).encrypted) return 'https'
  const fwd = req.headers['x-forwarded-proto']
  if (typeof fwd === 'string' && isLoopback(req.socket.remoteAddress)) {
    const first = fwd.split(',')[0].trim().toLowerCase()
    if (first === 'https' || first === 'http') return first
  }
  return 'http'
}

/** Host of a raw request, honouring X-Forwarded-Host from a loopback proxy. */
export function requestHost(req: IncomingMessage): string | undefined {
  const fwd = req.headers['x-forwarded-host']
  if (typeof fwd === 'string' && isLoopback(req.socket.remoteAddress)) return fwd.split(',')[0].trim()
  return req.headers.host
}
