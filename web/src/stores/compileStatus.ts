/**
 * Words for a build's status — its own module (no store, no realtime code) so the dashboard can
 * use it without loading the editor. stores/compile.ts re-exports it.
 */
import type { CompileStatus } from '@folio/shared/api'

/** Message shown for a finished build; null for success. */
export function compileStatusMessage(status: CompileStatus): string | null {
  switch (status) {
    case 'success': return null
    case 'failure': return 'No PDF was produced. Check the logs for errors.'
    case 'stopped-on-first-error': return 'Compilation stopped on the first error (“Stop on first error” is enabled).'
    case 'timedout': return 'The compile timed out. Large images, TikZ figures or a fatal error can make it take too long.'
    case 'terminated': return 'Compilation cancelled.'
    case 'error': return 'Server error: the compiler could not be run.'
    case 'too-recently-compiled': return 'You compiled very recently. Please wait a moment and try again.'
    case 'unavailable': return 'The compile server is busy. Please try again in a moment.'
    case 'no-root': return 'Unknown main document. Choose it in Settings → Compiler, or right-click a .tex file and choose “Set as main document”.'
    default: return `Compilation finished with status "${String(status)}".`
  }
}
