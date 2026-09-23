/**
 * Download helpers. Server downloads (zip, PDF, raw files) use same-origin URLs from
 * `api.<route>Url(...)`; the server sets Content-Disposition, `filename` only overrides it
 * for same-origin URLs (browsers ignore the download attribute cross-origin) that do not name
 * the file themselves — use downloadAs() when the name matters (a build's PDF is served as
 * "<jobname>.pdf").
 */
import { getBlob } from '../api/client'

/** Trigger a browser download of `url` without navigating away from the app. */
export function downloadUrl(url: string, filename?: string): void {
  if (typeof document === 'undefined') return
  const a = document.createElement('a')
  a.href = url
  a.download = filename ?? ''
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

/** Save an in-memory Blob as a file. */
export function downloadBlob(blob: Blob, filename: string): void {
  if (typeof URL === 'undefined' || typeof document === 'undefined') return
  const url = URL.createObjectURL(blob)
  downloadUrl(url, filename)
  // revoke after the browser had a chance to start the download
  setTimeout(() => URL.revokeObjectURL(url), 30_000)
}

/**
 * Save a same-origin URL under `filename`, whatever name the server's Content-Disposition
 * suggests (the bytes are fetched first; falls back to a plain link download).
 */
export async function downloadAs(url: string, filename: string): Promise<void> {
  let blob: Blob
  try {
    blob = await getBlob(url)
  } catch (e) {
    console.warn('[download] fetching the file failed, falling back to a direct download', e)
    downloadUrl(url, filename)
    return
  }
  downloadBlob(blob, filename)
}

export function downloadText(text: string, filename: string, type = 'text/plain;charset=utf-8'): void {
  downloadBlob(new Blob([text], { type }), filename)
}

/** Open a URL in a new tab without giving the new page access to window.opener. */
export function openInNewTab(url: string): void {
  if (typeof window === 'undefined') return
  const w = window.open(url, '_blank', 'noopener,noreferrer')
  if (w) w.opener = null
}

/** Make a string safe to use as a download file name (keeps unicode, drops path separators and control characters). */
export function safeFilename(name: string, fallback = 'download'): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim()
  return cleaned.length > 0 ? cleaned.slice(0, 180) : fallback
}
