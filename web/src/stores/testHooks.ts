/**
 * `window.__folio` test hook (SPEC §6.4, used by Playwright):
 *   { useAuth, useProject, useEditor, useCompile, useLayout, docSessions, projectEvents }
 *
 * Every store/realtime module registers itself here when it is evaluated, so the hook is always
 * present once any of them has been imported. This module imports nothing from the app, which
 * keeps it free of import cycles.
 */

export type FolioTestHooks = Record<string, unknown>

declare global {
  // eslint-disable-next-line no-var
  var __folio: FolioTestHooks | undefined
}

function hooks(): FolioTestHooks {
  const g = globalThis as { __folio?: FolioTestHooks }
  if (!g.__folio || typeof g.__folio !== 'object') g.__folio = {}
  return g.__folio
}

/** Register (or replace, e.g. after HMR) one entry of `window.__folio`. */
export function registerTestHook(name: string, value: unknown): void {
  hooks()[name] = value
}

/** Ensure `window.__folio` exists (entries are filled by the modules as they load). */
export function ensureTestHooks(): FolioTestHooks {
  return hooks()
}
