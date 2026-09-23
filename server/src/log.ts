/**
 * Process-wide pino logger.
 *
 *   development → pretty, colourised output through pino-pretty (synchronous stream, no worker thread)
 *   production  → JSON lines on stdout
 *   test        → 'warn' unless LOG_LEVEL says otherwise (keeps vitest output readable)
 *
 * LOG_LEVEL overrides the level in every environment.
 */
import { pino, type Logger } from 'pino'
import pretty from 'pino-pretty'

export type { Logger }

function createLogger(): Logger {
  const env = process.env.NODE_ENV === 'production' ? 'production' : process.env.VITEST || process.env.NODE_ENV === 'test' ? 'test' : 'development'
  const level = process.env.LOG_LEVEL ?? (env === 'test' ? 'warn' : 'info')
  const base = { level, base: { app: 'folio' }, redact: { paths: ['password', 'currentPassword', 'req.headers.cookie'], remove: true } }
  if (env === 'development') {
    return pino(base, pretty({ colorize: true, sync: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,app' }))
  }
  return pino(base)
}

export const log: Logger = createLogger()

/** Child logger tagged with a module name. */
export function moduleLog(module: string): Logger {
  return log.child({ module })
}
