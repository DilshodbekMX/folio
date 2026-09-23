import { Spinner } from '../ui'

/** "Opening project…" — while the project loads, and while the editor code itself loads (App). */
export function ProjectLoading() {
  return (
    <div className="pg-center pg-center--quiet" aria-busy="true">
      <div className="pg-loading">
        <Spinner size={22} label="Opening project" />
        <span>Opening project…</span>
      </div>
    </div>
  )
}
