import { useRef, type KeyboardEvent, type ReactNode } from 'react'
import clsx from 'clsx'

export type BadgeTone = 'neutral' | 'accent' | 'danger' | 'warning' | 'info' | 'success'

export interface TabDef {
  id: string
  label: ReactNode
  badge?: number | string | null
  badgeTone?: BadgeTone
  disabled?: boolean
}

export interface TabsProps {
  tabs: TabDef[]
  active: string
  onChange: (id: string) => void
  className?: string
  /** 'underline' (default) for panes, 'pill' for compact segmented filters */
  variant?: 'underline' | 'pill'
  /** accessible name of the tab list */
  label?: string
  /** prefix for tab element ids: tab ids are `${idPrefix}-tab-${id}`, panels may use `${idPrefix}-panel-${id}` */
  idPrefix?: string
}

/** Tab strip with roving tabindex (←/→/Home/End move and activate). */
export function Tabs({ tabs, active, onChange, className, variant = 'underline', label, idPrefix }: TabsProps) {
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const enabled = tabs.filter(t => !t.disabled)

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = enabled.findIndex(t => t.id === active)
    let next: TabDef | undefined
    if (e.key === 'ArrowRight') next = enabled[(i + 1) % enabled.length]
    else if (e.key === 'ArrowLeft') next = enabled[(i - 1 + enabled.length) % enabled.length]
    else if (e.key === 'Home') next = enabled[0]
    else if (e.key === 'End') next = enabled[enabled.length - 1]
    if (!next) return
    e.preventDefault()
    onChange(next.id)
    refs.current[next.id]?.focus()
  }

  return (
    <div role="tablist" aria-label={label} className={clsx('ui-tabs', `ui-tabs--${variant}`, className)} onKeyDown={onKeyDown}>
      {tabs.map(tab => {
        const selected = tab.id === active
        const showBadge = tab.badge !== undefined && tab.badge !== null && tab.badge !== ''
        return (
          <button
            key={tab.id}
            ref={el => {
              refs.current[tab.id] = el
            }}
            type="button"
            role="tab"
            id={idPrefix ? `${idPrefix}-tab-${tab.id}` : undefined}
            aria-controls={idPrefix ? `${idPrefix}-panel-${tab.id}` : undefined}
            aria-selected={selected}
            tabIndex={selected ? 0 : -1}
            disabled={tab.disabled}
            className={clsx('ui-tab', selected && 'is-active')}
            onClick={() => onChange(tab.id)}
          >
            <span className="ui-tab__label">{tab.label}</span>
            {showBadge && (
              <span className={clsx('ui-badge', `ui-badge--${tab.badgeTone ?? 'neutral'}`)}>{tab.badge}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

/** Standalone count/label badge using the same tones as tab badges. */
export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: BadgeTone; className?: string }) {
  return <span className={clsx('ui-badge', `ui-badge--${tone}`, className)}>{children}</span>
}
