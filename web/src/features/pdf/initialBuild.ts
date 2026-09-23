/**
 * The latest build of the project is fetched once when the project opens; the PDF pane (first
 * display) and auto-compile (compile on open) share that request.
 */
import { useCompile } from '../../stores/compile'
import { useProject } from '../../stores/project'

let current: { pid: string; promise: Promise<void> } | null = null
let wired = false

/** Resolves once the build that existed when project `pid` was opened is in useCompile. */
export function loadInitialBuild(pid: string): Promise<void> {
  if (!wired) {
    wired = true
    // leaving the project (or opening another one) starts over
    useProject.subscribe((s, prev) => {
      if (s.projectId !== prev.projectId) current = null
    })
  }
  if (current?.pid !== pid) current = { pid, promise: useCompile.getState().loadLast() }
  return current.promise
}
