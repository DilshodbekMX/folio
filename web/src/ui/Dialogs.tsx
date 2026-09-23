/**
 * Promise-based confirm/prompt dialogs. Requests queue up and are shown one at a time by
 * `<DialogHost/>` (mounted once near the app root).
 *
 * A dialog belongs to the page that asked: `cancelAllDialogs()` (called on every route change,
 * project switch and sign-out) answers every open or queued request with "cancel", so a
 * confirmation can never act on a project the user already left.
 * Destructive confirmations (`danger`) start with the focus on Cancel.
 */
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react'
import { Button } from './Button'
import { Field, TextField } from './Form'
import { Modal } from './Modal'

export interface ConfirmOptions {
  title: ReactNode
  message: ReactNode
  confirmLabel?: string
  cancelLabel?: string
  /** red confirm button for destructive actions (the focus then starts on Cancel) */
  danger?: boolean
  /** false: a single acknowledge button (an informational dialog) */
  showCancel?: boolean
}

export interface PromptOptions {
  title: ReactNode
  label: ReactNode
  initial?: string
  /** return an error message, or null when the value is acceptable */
  validate?: (value: string) => string | null
  confirmLabel?: string
  cancelLabel?: string
  /** text above the field */
  message?: ReactNode
  placeholder?: string
  /**
   * Initial selection: 'basename' selects the name without its extension (file names),
   * 'all' selects everything (default), 'end' puts the caret at the end.
   */
  select?: 'basename' | 'all' | 'end'
  /** trim the value before validation/return (default true) */
  trim?: boolean
}

type Request =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (v: boolean) => void; id: number }
  | { kind: 'prompt'; opts: PromptOptions; resolve: (v: string | null) => void; id: number }

let queue: Request[] = []
let nextId = 1
const listeners = new Set<() => void>()

function emit() {
  for (const l of listeners) l()
}
function subscribe(l: () => void) {
  listeners.add(l)
  return () => {
    listeners.delete(l)
  }
}
function finish(id: number) {
  queue = queue.filter(r => r.id !== id)
  emit()
}

/** Answer every open or queued dialog with "cancel" (false / null) and close it. */
export function cancelAllDialogs(): void {
  if (queue.length === 0) return
  const pending = queue
  queue = []
  emit()
  for (const r of pending) {
    if (r.kind === 'confirm') r.resolve(false)
    else r.resolve(null)
  }
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    queue = [...queue, { kind: 'confirm', opts, resolve, id: nextId++ }]
    emit()
  })
}

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise(resolve => {
    queue = [...queue, { kind: 'prompt', opts, resolve, id: nextId++ }]
    emit()
  })
}

export function DialogHost() {
  const q = useSyncExternalStore(subscribe, () => queue, () => queue)
  const current = q[0]
  if (!current) return null
  if (current.kind === 'confirm') return <ConfirmView key={current.id} req={current} />
  return <PromptView key={current.id} req={current} />
}

function ConfirmView({ req }: { req: Extract<Request, { kind: 'confirm' }> }) {
  const { opts } = req
  const done = (v: boolean) => {
    finish(req.id)
    req.resolve(v)
  }
  return (
    <Modal
      open
      size="sm"
      title={opts.title}
      onClose={() => done(false)}
      footer={
        <>
          {opts.showCancel !== false && (
            <Button variant="ghost" onClick={() => done(false)} data-autofocus={opts.danger ? true : undefined}>
              {opts.cancelLabel ?? 'Cancel'}
            </Button>
          )}
          <Button
            variant={opts.danger ? 'danger' : 'primary'}
            onClick={() => done(true)}
            data-autofocus={opts.danger && opts.showCancel !== false ? undefined : true}
          >
            {opts.confirmLabel ?? 'OK'}
          </Button>
        </>
      }
    >
      <div className="ui-dialog__message">{opts.message}</div>
    </Modal>
  )
}

function PromptView({ req }: { req: Extract<Request, { kind: 'prompt' }> }) {
  const { opts } = req
  const trim = opts.trim ?? true
  const [value, setValue] = useState(opts.initial ?? '')
  const [touched, setTouched] = useState(false)
  const inputRef = useRef<HTMLInputElement | null>(null)

  const normalized = trim ? value.trim() : value
  const error = opts.validate ? opts.validate(normalized) : normalized.length === 0 ? 'Required' : null

  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    const mode = opts.select ?? 'all'
    if (mode === 'basename') {
      const dot = el.value.lastIndexOf('.')
      el.setSelectionRange(0, dot > 0 ? dot : el.value.length)
    } else if (mode === 'end') {
      el.setSelectionRange(el.value.length, el.value.length)
    } else {
      el.select()
    }
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const done = (v: string | null) => {
    finish(req.id)
    req.resolve(v)
  }
  const submit = (e?: FormEvent) => {
    e?.preventDefault()
    setTouched(true)
    if (error) {
      inputRef.current?.focus()
      return
    }
    done(normalized)
  }
  const showError = touched && error

  return (
    <Modal
      open
      size="sm"
      title={opts.title}
      onClose={() => done(null)}
      initialFocus={inputRef}
      footer={
        <>
          <Button variant="ghost" onClick={() => done(null)}>
            {opts.cancelLabel ?? 'Cancel'}
          </Button>
          <Button variant="primary" onClick={() => submit()} disabled={touched && !!error}>
            {opts.confirmLabel ?? 'OK'}
          </Button>
        </>
      }
    >
      <form className="ui-dialog__form" onSubmit={submit} noValidate>
        {opts.message && <div className="ui-dialog__message">{opts.message}</div>}
        <Field label={opts.label} error={showError ? error : undefined}>
          <TextField
            ref={inputRef}
            value={value}
            placeholder={opts.placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={e => {
              setValue(e.target.value)
              setTouched(true)
            }}
          />
        </Field>
      </form>
    </Modal>
  )
}
