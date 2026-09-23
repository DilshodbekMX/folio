/**
 * Colour helpers for user colours (cursors, avatars, presence dots).
 * User colours from the server are 6-digit hex ('#0072B2'); y-codemirror.next needs a
 * 6-digit colour so it can append an alpha byte for selection backgrounds.
 */

const HEX3 = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i
const HEX6 = /^#[0-9a-f]{6}$/i
const HEX8 = /^#([0-9a-f]{6})[0-9a-f]{2}$/i

export const FALLBACK_COLOR = '#6b7280'

/** '#abc' → '#aabbcc', '#AABBCC' → '#aabbcc', '#aabbccdd' → '#aabbcc'; anything else → null. */
export function normalizeHex(color: string): string | null {
  const c = color.trim()
  if (HEX6.test(c)) return c.toLowerCase()
  const m3 = HEX3.exec(c)
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`.toLowerCase()
  const m8 = HEX8.exec(c)
  if (m8) return `#${m8[1]}`.toLowerCase()
  return null
}

/** A safe 6-digit user colour (falls back to neutral grey for invalid input). */
export function safeColor(color: string | null | undefined): string {
  return (color && normalizeHex(color)) || FALLBACK_COLOR
}

/**
 * Translucent variant of a user colour for selection backgrounds: `color + '33'` (20 % alpha),
 * as the realtime protocol specifies for PresenceUser.colorLight.
 */
export function colorLight(color: string, alphaHex = '33'): string {
  return safeColor(color) + alphaHex
}

export function hexToRgb(color: string): { r: number; g: number; b: number } | null {
  const hex = normalizeHex(color)
  if (!hex) return null
  const n = parseInt(hex.slice(1), 16)
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff }
}

/** 'rgba(r, g, b, a)' for CSS; `alpha` in 0..1. */
export function withAlpha(color: string, alpha: number): string {
  const rgb = hexToRgb(color) ?? hexToRgb(FALLBACK_COLOR)!
  const a = Math.min(1, Math.max(0, alpha))
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${a})`
}

/** HSL (h 0..360, s/l 0..100) → '#rrggbb'. */
export function hslToHex(h: number, s: number, l: number): string {
  const sat = Math.min(100, Math.max(0, s)) / 100
  const lig = Math.min(100, Math.max(0, l)) / 100
  const k = (n: number) => (n + h / 30) % 12
  const a = sat * Math.min(lig, 1 - lig)
  const f = (n: number) => lig - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))
  const to = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0')
  return `#${to(f(0))}${to(f(8))}${to(f(4))}`
}

/** Stable, readable colour derived from any id (for users without a stored colour). */
export function colorForId(id: string): string {
  let hash = 0
  for (let i = 0; i < id.length; i++) hash = (Math.imul(hash, 31) + id.charCodeAt(i)) | 0
  const hue = ((hash % 360) + 360) % 360
  return hslToHex(hue, 65, 45)
}

/** Relative luminance (WCAG) of a hex colour, 0..1. */
export function luminance(color: string): number {
  const rgb = hexToRgb(color)
  if (!rgb) return 0.5
  const lin = (v: number) => {
    const c = v / 255
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b)
}

/** Black or white, whichever reads better on `background` (e.g. avatar initials). */
export function readableTextColor(background: string): '#000000' | '#ffffff' {
  return luminance(background) > 0.42 ? '#000000' : '#ffffff'
}
