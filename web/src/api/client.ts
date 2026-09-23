/**
 * HTTP client for the Folio REST API (same origin, JSON, cookie session).
 * Every non-GET request carries `X-Folio-Csrf: 1` (the server additionally checks Origin).
 * Failures reject with `ApiError`; aborted requests reject with the DOMException 'AbortError'.
 */
import { CSRF_HEADER } from '@folio/shared/api'

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
export type QueryValue = string | number | boolean | null | undefined
export type Query = Record<string, QueryValue>

export interface RequestOptions {
  signal?: AbortSignal
  /** extra query parameters (null/undefined values are skipped, booleans become 1/0) */
  query?: Query
  headers?: Record<string, string>
  /** do not notify `onApiError` listeners (e.g. the boot-time session probe) */
  silent?: boolean
}

export class ApiError extends Error {
  /** HTTP status; 0 for network failures */
  readonly status: number
  /** machine-readable code from ApiErrorBody ('not_found', 'forbidden', 'validation', …) or 'network' */
  readonly code: string
  readonly details: unknown

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

/** True when `e` is an ApiError (optionally with the given status or code). */
export function isApiError(e: unknown, statusOrCode?: number | string): e is ApiError {
  if (!(e instanceof ApiError)) return false
  if (statusOrCode === undefined) return true
  return typeof statusOrCode === 'number' ? e.status === statusOrCode : e.code === statusOrCode
}

export function isAbortError(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError'
}

/** Human-readable message for any thrown value (for toasts and inline errors). */
export function errorMessage(e: unknown, fallback = 'Something went wrong'): string {
  if (e instanceof ApiError) return e.message || fallback
  if (e instanceof Error && e.message) return e.message
  if (typeof e === 'string' && e) return e
  return fallback
}

type ErrorListener = (err: ApiError, info: { method: string; path: string }) => void
const errorListeners = new Set<ErrorListener>()

/** Observe every failed request (used by the auth store to notice an expired session). */
export function onApiError(fn: ErrorListener): () => void {
  errorListeners.add(fn)
  return () => {
    errorListeners.delete(fn)
  }
}

function notify(err: ApiError, method: string, path: string, silent?: boolean): void {
  if (silent) return
  for (const fn of [...errorListeners]) {
    try {
      fn(err, { method, path })
    } catch (e) {
      console.error('[api] error listener failed', e)
    }
  }
}

const DEFAULT_CODES: Record<number, string> = {
  400: 'validation', 401: 'unauthorized', 403: 'forbidden', 404: 'not_found', 409: 'conflict',
  413: 'too_large', 429: 'rate_limited',
}

const DEFAULT_MESSAGES: Record<string, string> = {
  validation: 'The request was invalid.',
  unauthorized: 'You are not signed in.',
  forbidden: 'You do not have permission to do that.',
  not_found: 'Not found.',
  conflict: 'That conflicts with the current state. Reload and try again.',
  too_large: 'That is too large.',
  rate_limited: 'Too many requests. Please wait a moment and try again.',
  server_error: 'The server ran into a problem. Please try again.',
  unavailable: 'The server is unavailable. Please try again shortly.',
  network: 'Could not reach the server. Check your connection.',
}

function codeForStatus(status: number): string {
  if (DEFAULT_CODES[status]) return DEFAULT_CODES[status]
  if (status === 502 || status === 503 || status === 504) return 'unavailable'
  if (status >= 500) return 'server_error'
  return 'error'
}

/** Build an ApiError from a non-2xx response body (ApiErrorBody JSON when available). */
export function errorFromResponse(status: number, statusText: string, bodyText: string): ApiError {
  let code = codeForStatus(status)
  let message = ''
  let details: unknown
  if (bodyText) {
    try {
      const parsed = JSON.parse(bodyText) as { error?: { code?: unknown; message?: unknown; details?: unknown } }
      if (parsed && typeof parsed === 'object' && parsed.error && typeof parsed.error === 'object') {
        if (typeof parsed.error.code === 'string' && parsed.error.code) code = parsed.error.code
        if (typeof parsed.error.message === 'string') message = parsed.error.message
        details = parsed.error.details
      }
    } catch {
      // not JSON (proxy error page etc.) — keep the generic message
    }
  }
  if (!message) message = DEFAULT_MESSAGES[code] ?? (statusText || `Request failed (${status})`)
  return new ApiError(status, code, message, details)
}

export function networkError(cause?: unknown): ApiError {
  return new ApiError(0, 'network', DEFAULT_MESSAGES.network, cause)
}

/** Append query parameters to a path (skips null/undefined; booleans → '1'/'0'). */
export function buildUrl(path: string, query?: Query): string {
  if (!query) return path
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null) continue
    params.append(k, typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
  }
  const qs = params.toString()
  if (!qs) return path
  return path + (path.includes('?') ? '&' : '?') + qs
}

function isMutating(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD'
}

async function doFetch(method: string, path: string, init: RequestInit, silent?: boolean): Promise<Response> {
  let res: Response
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init, method })
  } catch (e) {
    if (isAbortError(e)) throw e
    const err = networkError(e)
    notify(err, method, path, silent)
    throw err
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    const err = errorFromResponse(res.status, res.statusText, text)
    notify(err, method, path, silent)
    throw err
  }
  return res
}

/**
 * JSON request. Resolves with the parsed body, or `undefined` for empty responses (204).
 * `body` is sent as JSON unless it is FormData / Blob / string.
 */
export async function request<T>(method: HttpMethod, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const url = buildUrl(path, opts.query)
  const headers: Record<string, string> = { Accept: 'application/json', ...opts.headers }
  if (isMutating(method)) headers[CSRF_HEADER] = '1'
  let payload: BodyInit | undefined
  if (body !== undefined) {
    if (body instanceof FormData || body instanceof Blob || typeof body === 'string') {
      payload = body
    } else {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
  }
  const res = await doFetch(method, url, { headers, body: payload, signal: opts.signal }, opts.silent)
  if (res.status === 204 || res.status === 205) return undefined as T
  const text = await res.text()
  if (!text) return undefined as T
  const type = res.headers.get('content-type') ?? ''
  if (type.includes('json')) {
    try {
      return JSON.parse(text) as T
    } catch {
      throw new ApiError(res.status, 'bad_response', 'The server sent an invalid response.')
    }
  }
  return text as unknown as T
}

/** GET a same-origin URL as text (build logs, raw files). */
export async function getText(url: string, opts: RequestOptions = {}): Promise<string> {
  const res = await doFetch('GET', buildUrl(url, opts.query), { headers: opts.headers, signal: opts.signal }, opts.silent)
  return res.text()
}

/** GET a same-origin URL as a Blob. */
export async function getBlob(url: string, opts: RequestOptions = {}): Promise<Blob> {
  const res = await doFetch('GET', buildUrl(url, opts.query), { headers: opts.headers, signal: opts.signal }, opts.silent)
  return res.blob()
}

/** GET a same-origin URL as bytes. */
export async function getArrayBuffer(url: string, opts: RequestOptions = {}): Promise<ArrayBuffer> {
  const res = await doFetch('GET', buildUrl(url, opts.query), { headers: opts.headers, signal: opts.signal }, opts.silent)
  return res.arrayBuffer()
}

export interface UploadProgressInfo {
  loaded: number
  total: number
}

/**
 * Upload progress callback: `fraction` is 0..1 of the request body sent (1 once the body is
 * fully uploaded and the server is processing it).
 */
export type UploadProgress = (fraction: number, info: UploadProgressInfo) => void

/**
 * multipart/form-data POST through XMLHttpRequest so upload progress can be reported.
 * Resolves with the parsed JSON response; rejects with ApiError (or AbortError when aborted).
 */
export function upload<T>(
  path: string,
  formData: FormData,
  onProgress?: UploadProgress,
  opts: { signal?: AbortSignal; method?: 'POST' | 'PUT'; query?: Query; silent?: boolean } = {},
): Promise<T> {
  const method = opts.method ?? 'POST'
  const url = buildUrl(path, opts.query)
  return new Promise<T>((resolve, reject) => {
    if (opts.signal?.aborted) {
      reject(new DOMException('Upload aborted', 'AbortError'))
      return
    }
    const xhr = new XMLHttpRequest()
    let settled = false
    const onAbortSignal = () => xhr.abort()
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      opts.signal?.removeEventListener('abort', onAbortSignal)
      fn()
    }
    xhr.open(method, url)
    xhr.responseType = 'text'
    xhr.setRequestHeader('Accept', 'application/json')
    xhr.setRequestHeader(CSRF_HEADER, '1')
    if (onProgress) {
      xhr.upload.onprogress = e => {
        const total = e.lengthComputable ? e.total : 0
        const fraction = total > 0 ? Math.min(1, e.loaded / total) : 0
        onProgress(fraction, { loaded: e.loaded, total })
      }
      xhr.upload.onload = () => onProgress(1, { loaded: 1, total: 1 })
    }
    xhr.onload = () => finish(() => {
      const text = typeof xhr.responseText === 'string' ? xhr.responseText : ''
      if (xhr.status >= 200 && xhr.status < 300) {
        if (!text || xhr.status === 204) {
          resolve(undefined as T)
          return
        }
        try {
          resolve(JSON.parse(text) as T)
        } catch {
          reject(new ApiError(xhr.status, 'bad_response', 'The server sent an invalid response.'))
        }
        return
      }
      const err = errorFromResponse(xhr.status, xhr.statusText, text)
      notify(err, method, url, opts.silent)
      reject(err)
    })
    xhr.onerror = () => finish(() => {
      const err = networkError()
      notify(err, method, url, opts.silent)
      reject(err)
    })
    xhr.ontimeout = xhr.onerror
    xhr.onabort = () => finish(() => reject(new DOMException('Upload aborted', 'AbortError')))
    opts.signal?.addEventListener('abort', onAbortSignal, { once: true })
    xhr.send(formData)
  })
}
