/**
 * Minimal logger contract used by the collab module (pino-compatible: `logger.warn(obj, msg)`).
 * main.ts may inject the application logger through the service options; otherwise a pino
 * child named 'collab' / 'meta' is created lazily.
 */
import pino from 'pino'

export interface CollabLogger {
  debug(obj: object, msg?: string): void
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

export function defaultLogger(name: string, env: 'development' | 'production' | 'test'): CollabLogger {
  const level = process.env.LOG_LEVEL ?? (env === 'test' ? 'warn' : 'info')
  return pino({ name, level })
}

/** Serialisable description of an unknown error for structured logs. */
export function errInfo(err: unknown): { err: { message: string; code?: string; stack?: string } } {
  if (err instanceof Error) {
    return { err: { message: err.message, code: (err as NodeJS.ErrnoException).code, stack: err.stack } }
  }
  return { err: { message: String(err) } }
}
