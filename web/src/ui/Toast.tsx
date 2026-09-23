import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import clsx from 'clsx'
import { CircleCheck, CircleX, Info, TriangleAlert, X } from 'lucide-react'
import { Portal } from './Portal'

export type ToastTone = 'info' | 'success' | 'error' | 'warning'

export interface ToastOptions {
  tone?: ToastTone
  /** ms before auto-dismiss; 0 keeps it until closed. Default 4 s (errors 7 s). */
  duration?: number
  /** optional action button */
  action?: { label: string; onClick: () => void }
  /** replace an existing toast with the same id instead of stacking a new one */
  id?: string
}

interface ToastEntry {
  id: string
  message: ReactNode
  tone: ToastTone
  duration: number
  action?: { label: string; onClick: () => void }
  version: number
}

let toasts: ToastEntry[] = []
let counter = 0
const listeners = new Set<() => void>()
const MAX_TOASTS = 5

function emit() {
  for (const l of listeners) l()
}

/** Show a toast; returns its id (pass to `dismissToast`). Requires `<Toaster/>`. */
export function toast(message: ReactNode, opts: ToastOptions = {}): string {
  const tone = opts.tone ?? 'info'
  const id = opts.id ?? `t${++counter}`
  const entry: ToastEntry = {
    id,
    message,
    tone,
    duration: opts.duration ?? (tone === 'error' ? 7000 : 4000),
    action: opts.action,
    version: ++counter,
  }
  const existing = toasts.findIndex(t => t.id === id)
  if (existing >= 0) toasts = toasts.map((t, i) => (i === existing ? entry : t))
  else toasts = [...toasts, entry].slice(-MAX_TOASTS)
  emit()
  return id
}

export function dismissToast(id: string): void {
  const next = toasts.filter(t => t.id !== id)
  if (next.length !== toasts.length) {
    toasts = next
    emit()
  }
}

/** Remove every toast (signing out: nothing of the previous account's session stays on screen). */
export function dismissAllToasts(): void {
  if (toasts.length === 0) return
  toasts = []
  emit()
}

function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}

const ICONS = { info: Info, success: CircleCheck, error: CircleX, warning: TriangleAlert }

function ToastView({ entry }: { entry: ToastEntry }) {
  const timer = useRef<number | undefined>(undefined)
  const remaining = useRef(entry.duration)
  const startedAt = useRef(0)

  const start = () => {
    if (entry.duration <= 0) return
    window.clearTimeout(timer.current)
    startedAt.current = Date.now()
    timer.current = window.setTimeout(() => dismissToast(entry.id), remaining.current)
  }
  const pause = () => {
    if (entry.duration <= 0) return
    window.clearTimeout(timer.current)
    remaining.current = Math.max(1200, remaining.current - (Date.now() - startedAt.current))
  }

  useEffect(() => {
    remaining.current = entry.duration
    start()
    return () => window.clearTimeout(timer.current)
    // Restart the timer when the toast is replaced (same id, new version).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.version])

  const Icon = ICONS[entry.tone]
  return (
    <div
      className={clsx('ui-toast', `ui-toast--${entry.tone}`)}
      role={entry.tone === 'error' ? 'alert' : 'status'}
      onMouseEnter={pause}
      onMouseLeave={start}
      onFocus={pause}
      onBlur={start}
    >
      <Icon className="ui-toast__icon" size={16} aria-hidden="true" />
      <div className="ui-toast__msg">{entry.message}</div>
      {entry.action && (
        <button
          type="button"
          className="ui-toast__action"
          onClick={() => {
            entry.action?.onClick()
            dismissToast(entry.id)
          }}
        >
          {entry.action.label}
        </button>
      )}
      <button type="button" className="ui-toast__close" aria-label="Dismiss" onClick={() => dismissToast(entry.id)}>
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

/** Mount once near the app root. */
export function Toaster() {
  const list = useSyncExternalStore(subscribe, () => toasts, () => toasts)
  return (
    <Portal>
      <div className="ui-toaster" data-ui-layer="toast" aria-live="polite" aria-relevant="additions">
        {list.map(t => (
          <ToastView key={t.id} entry={t} />
        ))}
      </div>
    </Portal>
  )
}
