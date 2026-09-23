/**
 * Per-project async mutex: file-tree mutations (create/upload/move/delete/import/delete project)
 * of one project run one after another so the db rows and the directory never disagree.
 * Not re-entrant — never call a locked FileService method from inside `withProjectLock`.
 * Lock order: the history lock (history/index.ts `ops`) is always taken BEFORE this one — never
 * wait for a history operation while holding the project lock.
 */
const chains = new Map<string, Promise<unknown>>()

export function withProjectLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(projectId) ?? Promise.resolve()
  const next = prev.catch(() => {}).then(fn)
  const tail = next.catch(() => {})
  chains.set(projectId, tail)
  void tail.then(() => {
    if (chains.get(projectId) === tail) chains.delete(projectId)
  })
  return next
}
