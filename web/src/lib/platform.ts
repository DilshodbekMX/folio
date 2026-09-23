/**
 * Platform detection and keyboard-shortcut labels. Shortcut specs use CodeMirror's syntax
 * ('Mod-Shift-z', 'Ctrl-Space', 'Alt-Enter'); 'Mod' is Cmd on macOS and Ctrl elsewhere.
 */

function detectMac(): boolean {
  if (typeof navigator === 'undefined') return false
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData
  const platform = uaData?.platform || navigator.platform || navigator.userAgent || ''
  return /mac|iphone|ipad|ipod/i.test(platform)
}

export const isMac: boolean = detectMac()

/** Glyph/label of the Mod key: '⌘' on macOS, 'Ctrl' elsewhere. */
export const modKey: string = isMac ? '⌘' : 'Ctrl'
/** Spelled-out Mod key label: 'Cmd' / 'Ctrl'. */
export const modKeyName: string = isMac ? 'Cmd' : 'Ctrl'

const MAC_GLYPHS: Record<string, string> = {
  mod: '⌘', cmd: '⌘', meta: '⌘', ctrl: '⌃', alt: '⌥', option: '⌥', shift: '⇧',
  enter: '↩', backspace: '⌫', delete: '⌦', escape: '⎋', esc: '⎋', tab: '⇥',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', space: 'Space',
}
const PC_NAMES: Record<string, string> = {
  mod: 'Ctrl', cmd: 'Ctrl', meta: 'Win', ctrl: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift',
  enter: 'Enter', backspace: 'Backspace', delete: 'Del', escape: 'Esc', esc: 'Esc', tab: 'Tab',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', space: 'Space',
}
// macOS convention orders modifiers ⌃⌥⇧⌘
const MAC_ORDER = ['ctrl', 'alt', 'option', 'shift', 'mod', 'cmd', 'meta']

function splitSpec(spec: string): string[] {
  // 'Mod--' (minus key) → ['Mod', '-']
  const parts = spec.split('-')
  const out: string[] = []
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === '' && i === parts.length - 1 && out.length > 0) out.push('-')
    else if (parts[i] !== '') out.push(parts[i])
  }
  return out
}

/** Individual key labels for a spec, e.g. 'Mod-Shift-z' → ['⇧', '⌘', 'Z'] (mac) / ['Ctrl', 'Shift', 'Z']. */
export function shortcutKeys(spec: string, mac: boolean = isMac): string[] {
  const parts = splitSpec(spec)
  if (parts.length === 0) return []
  const key = parts[parts.length - 1]
  let mods = parts.slice(0, -1).map(m => m.toLowerCase())
  if (mac) mods = [...mods].sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b))
  const names = mac ? MAC_GLYPHS : PC_NAMES
  const keyLabel = names[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key)
  return [...mods.map(m => names[m] ?? m), keyLabel]
}

/** Display string for a shortcut: '⇧⌘Z' on macOS, 'Ctrl+Shift+Z' elsewhere. */
export function formatShortcut(spec: string, mac: boolean = isMac): string {
  return shortcutKeys(spec, mac).join(mac ? '' : '+')
}

/** True when the platform's Mod key is held (Cmd on macOS, Ctrl elsewhere). */
export function isModEvent(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}
