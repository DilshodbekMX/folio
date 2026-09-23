/**
 * Copy text to the clipboard. Uses the async Clipboard API when it is available (secure
 * contexts) and falls back to a temporary textarea + execCommand('copy') otherwise
 * (plain-http self-hosted installs, older browsers). Resolves false when both fail.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // permission denied / not focused — try the fallback
  }
  return legacyCopy(text)
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const ta = document.createElement('textarea')
  ta.value = text
  ta.setAttribute('readonly', '')
  ta.style.position = 'fixed'
  ta.style.top = '0'
  ta.style.left = '0'
  ta.style.width = '1px'
  ta.style.height = '1px'
  ta.style.opacity = '0'
  // inside an open modal the rest of the page is inert: append next to the focused element
  const host = active?.closest('[data-ui-layer]') ?? document.body
  host.appendChild(ta)
  ta.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  ta.remove()
  active?.focus({ preventScroll: true })
  return ok
}
