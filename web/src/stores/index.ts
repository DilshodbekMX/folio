/**
 * Barrel for the app stores + realtime singletons, and the `window.__folio` test hook.
 */
import { useAuth } from './auth'
import { useProject } from './project'
import { useEditor } from './editor'
import { useCompile } from './compile'
import { useLayout } from './layout'
import { docSessions } from '../realtime/docs'
import { projectEvents } from '../realtime/meta'
import { ensureTestHooks, registerTestHook } from './testHooks'

export * from './auth'
export * from './project'
export * from './editor'
export * from './compile'
export * from './layout'
export { docSessions, projectEvents }

/**
 * Set `window.__folio = { useAuth, useProject, useEditor, useCompile, useLayout, docSessions,
 * projectEvents }`. Each module also registers itself when evaluated, so this is idempotent.
 */
export function installTestHooks(): void {
  ensureTestHooks()
  registerTestHook('useAuth', useAuth)
  registerTestHook('useProject', useProject)
  registerTestHook('useEditor', useEditor)
  registerTestHook('useCompile', useCompile)
  registerTestHook('useLayout', useLayout)
  registerTestHook('docSessions', docSessions)
  registerTestHook('projectEvents', projectEvents)
}

installTestHooks()
