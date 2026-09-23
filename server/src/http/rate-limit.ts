/**
 * Rate limiters (SPEC §4.2): login/setup/register 20 per 15 min per IP; share join 30 per 15 min.
 * In-memory store (single node). Each call creates an independent limiter.
 */
import { rateLimit, type RateLimitRequestHandler } from 'express-rate-limit'
import { moduleLog } from '../log.ts'
import { rateLimited } from './errors.ts'

const WINDOW_MS = 15 * 60 * 1000

const log = moduleLog('http')

function limiter(limit: number, message: string): RateLimitRequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    ipv6Subnet: 56,
    handler: (req, _res, next) => {
      // brute force, or every client behind one proxy address sharing the limit
      log.warn({ ip: req.ip, method: req.method, path: req.originalUrl.split('?')[0], limit }, 'rate limit reached')
      next(rateLimited(message))
    },
  })
}

export function authRateLimiter(): RateLimitRequestHandler {
  return limiter(20, 'Too many attempts. Please wait a few minutes and try again.')
}

export function joinRateLimiter(): RateLimitRequestHandler {
  return limiter(30, 'Too many join attempts. Please wait a few minutes and try again.')
}
