import clsx from 'clsx'
import { Monitor, Moon, Sun } from 'lucide-react'
import type { UserSettings } from '@folio/shared/api'
import { useAuth, useSettings } from '../../stores/auth'
import { errorMessage } from '../../api/client'
import { Tooltip, toast } from '../../ui'

const OPTIONS: { id: UserSettings['theme']; label: string; icon: typeof Sun }[] = [
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
  { id: 'system', label: 'System', icon: Monitor },
]

/** Light / Dark / System segmented control bound to the user's `theme` setting. */
export function ThemeToggle({ labelled = false, className }: { labelled?: boolean; className?: string }) {
  const theme = useSettings().theme
  const set = (id: UserSettings['theme']) => {
    if (id === theme) return
    useAuth.getState().updateSettings({ theme: id }).catch(e => toast(`Couldn’t save the theme: ${errorMessage(e)}`, { tone: 'error' }))
  }
  return (
    <div className={clsx('dash-theme', labelled && 'dash-theme--labelled', className)} role="radiogroup" aria-label="Theme">
      {OPTIONS.map(o => {
        const Icon = o.icon
        const btn = (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={theme === o.id}
            aria-label={labelled ? undefined : o.label}
            className={clsx('dash-theme__opt', theme === o.id && 'is-active')}
            onClick={() => set(o.id)}
            onKeyDown={e => {
              const i = OPTIONS.findIndex(x => x.id === theme)
              let n = -1
              if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % OPTIONS.length
              else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + OPTIONS.length) % OPTIONS.length
              if (n < 0) return
              e.preventDefault()
              set(OPTIONS[n].id)
              e.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('button[role="radio"]')[n]?.focus()
            }}
            tabIndex={theme === o.id ? 0 : -1}
          >
            <Icon size={14} aria-hidden="true" />
            {labelled && <span>{o.label}</span>}
          </button>
        )
        return labelled ? btn : (
          <Tooltip key={o.id} content={`${o.label} theme`} side="top" describe={false}>
            {btn}
          </Tooltip>
        )
      })}
    </div>
  )
}
