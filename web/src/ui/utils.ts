/** Small helpers shared by the UI primitives. */
import type { Ref, RefCallback, RefObject } from 'react'

/** Combine several refs (callback or object) into one callback ref. */
export function mergeRefs<T>(...refs: (Ref<T> | undefined | null)[]): RefCallback<T> {
  return (value: T | null) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(value)
      else if (ref) (ref as RefObject<T | null>).current = value
    }
  }
}

/** Call every handler in order (used when cloning a child and adding our own handlers). */
export function chain<A extends unknown[]>(...fns: (((...args: A) => void) | undefined | null)[]): (...args: A) => void {
  return (...args: A) => {
    for (const fn of fns) fn?.(...args)
  }
}

const FOCUSABLE = [
  'a[href]',
  'area[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'iframe',
  '[contenteditable="true"]',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

/** Visible, keyboard-focusable descendants of `root` in DOM order. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    el => !el.hasAttribute('inert') && el.getClientRects().length > 0 && el.closest('[inert]') === null,
  )
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max)
}

export const isMac: boolean =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/i.test(
    (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '',
  )

const MAC_KEYS: Record<string, string> = {
  mod: '⌘', cmd: '⌘', meta: '⌘', ctrl: '⌃', control: '⌃', alt: '⌥', option: '⌥', shift: '⇧',
  enter: '↵', return: '↵', backspace: '⌫', delete: '⌦', escape: 'Esc', esc: 'Esc', tab: '⇥',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', up: '↑', down: '↓', left: '←', right: '→',
  space: 'Space', home: 'Home', end: 'End', pageup: 'PgUp', pagedown: 'PgDn',
}
const PC_KEYS: Record<string, string> = {
  mod: 'Ctrl', cmd: 'Ctrl', meta: 'Win', ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', option: 'Alt', shift: 'Shift',
  enter: 'Enter', return: 'Enter', backspace: 'Backspace', delete: 'Del', escape: 'Esc', esc: 'Esc', tab: 'Tab',
  arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', up: '↑', down: '↓', left: '←', right: '→',
  space: 'Space', home: 'Home', end: 'End', pageup: 'PgUp', pagedown: 'PgDn',
}

/**
 * Split a CodeMirror-style key spec ('Mod-Shift-z', 'Ctrl-Space', 'F2', 'Mod--') into display parts
 * for the current platform: ['⌘', '⇧', 'Z'] on macOS, ['Ctrl', 'Shift', 'Z'] elsewhere.
 */
export function shortcutParts(spec: string): string[] {
  const table = isMac ? MAC_KEYS : PC_KEYS
  // Split on '-' but keep a trailing '-' key (e.g. 'Mod--').
  const raw = spec.endsWith('--') ? [...spec.slice(0, -2).split('-'), '-'] : spec.split('-')
  return raw
    .filter(p => p.length > 0)
    .map(p => table[p.toLowerCase()] ?? (p.length === 1 ? p.toUpperCase() : p))
}

/** Human readable shortcut string for the current platform ('⌘⇧Z' / 'Ctrl+Shift+Z'). */
export function formatShortcut(spec: string): string {
  const parts = shortcutParts(spec)
  return isMac ? parts.join('') : parts.join('+')
}

/** True when the keyboard event matches the primary modifier (⌘ on macOS, Ctrl elsewhere) only. */
export function isModKey(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
}
