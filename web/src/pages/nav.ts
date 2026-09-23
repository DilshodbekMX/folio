import { useEffect } from 'react'

/**
 * Validate a `?next=` redirect target: only same-origin, app-relative paths are allowed
 * (never '//host', '/\\host', absolute URLs, or API/websocket endpoints).
 */
export function safeNext(next: string | null | undefined, fallback = '/'): string {
  if (!next) return fallback
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback
  if (/[\u0000-\u001f\u007f]/.test(next)) return fallback
  if (/^\/(api|ws|pdfjs)(\/|$|\?)/.test(next)) return fallback
  try {
    const u = new URL(next, window.location.origin)
    if (u.origin !== window.location.origin) return fallback
    return u.pathname + u.search + u.hash
  } catch {
    return fallback
  }
}

/** `/login?next=<current location>` for redirecting unauthenticated users. */
export function loginPathFor(location: { pathname: string; search: string; hash?: string }): string {
  const here = location.pathname + location.search + (location.hash ?? '')
  return here === '/' || here === '' ? '/login' : `/login?next=${encodeURIComponent(here)}`
}

/** Sets document.title to "<title> · Folio" (or "Folio") while mounted. */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Folio` : 'Folio'
  }, [title])
}
