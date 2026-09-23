/**
 * Typed HTTP errors. Throw (or reject with) an HttpError anywhere in a route handler —
 * Express 5 forwards async errors to the error handler in http/app.ts, which renders
 * ApiErrorBody { error: { code, message, details? } } with `status`.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message)
    this.name = 'HttpError'
  }
}

export const badRequest = (message: string, details?: unknown) => new HttpError(400, 'validation', message, details)
export const unauthorized = (message = 'Not logged in') => new HttpError(401, 'unauthorized', message)
export const forbidden = (message = 'You do not have permission to do that') => new HttpError(403, 'forbidden', message)
export const notFound = (message = 'Not found') => new HttpError(404, 'not_found', message)
export const conflict = (message: string, details?: unknown) => new HttpError(409, 'conflict', message, details)
export const tooLarge = (message = 'Too large') => new HttpError(413, 'too_large', message)
export const rateLimited = (message = 'Too many requests') => new HttpError(429, 'rate_limited', message)
