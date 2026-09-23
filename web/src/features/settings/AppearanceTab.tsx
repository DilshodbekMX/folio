/**
 * Settings → Appearance: the UI theme (light / dark / follow the system) and "Dark mode PDF"
 * (a preference of this browser, stores/prefs.ts — the account settings have no such field).
 */
import { useRef, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import { Monitor, Moon, Sun } from 'lucide-react'
import type { UserSettings } from '@folio/shared/api'
import { useResolvedTheme, useSettings, useSystemTheme } from '../../stores/auth'
import { usePrefs } from '../../stores/prefs'
import { SettingsGroup, SwitchRow } from './controls'
import { saveSettings } from './EditorTab'

type Theme = UserSettings['theme']

const THEMES: { id: Theme; label: string; icon: typeof Sun; description: string }[] = [
  { id: 'light', label: 'Light', icon: Sun, description: 'Always light' },
  { id: 'dark', label: 'Dark', icon: Moon, description: 'Always dark' },
  { id: 'system', label: 'System', icon: Monitor, description: 'Follow your device' },
]

export function AppearanceTab({ onEditorTab }: { onEditorTab: () => void }) {
  const theme = useSettings().theme
  const system = useSystemTheme()
  const resolved = useResolvedTheme()
  const pdfInvert = usePrefs(s => s.pdfInvertDark)
  const refs = useRef<(HTMLButtonElement | null)[]>([])

  const choose = (t: Theme) => {
    if (t !== theme) saveSettings({ theme: t })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = THEMES.findIndex(t => t.id === theme)
    let n = -1
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') n = (i + 1) % THEMES.length
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') n = (i - 1 + THEMES.length) % THEMES.length
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = THEMES.length - 1
    if (n < 0) return
    e.preventDefault()
    choose(THEMES[n].id)
    refs.current[n]?.focus()
  }

  return (
    <div className="set-tab">
      <SettingsGroup title="Theme" description="Applies to the whole app on this account, including the dashboard.">
        <div className="set-themes" role="radiogroup" aria-label="Theme" onKeyDown={onKeyDown} data-setting="theme">
          {THEMES.map((t, i) => {
            const Icon = t.icon
            const selected = theme === t.id
            return (
              <button
                key={t.id}
                ref={el => {
                  refs.current[i] = el
                }}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                className={clsx('set-theme', selected && 'is-selected')}
                data-value={t.id}
                onClick={() => choose(t.id)}
              >
                {t.id === 'system' ? (
                  <span className="set-theme__art set-theme__art--split" aria-hidden="true">
                    <ThemeArt look="light" />
                    <ThemeArt look="dark" className="set-theme__half" />
                  </span>
                ) : (
                  <span className="set-theme__art" aria-hidden="true">
                    <ThemeArt look={t.id} />
                  </span>
                )}
                <span className="set-theme__label">
                  <Icon size={14} aria-hidden="true" />
                  {t.label}
                </span>
                <span className="set-theme__desc">
                  {t.id === 'system' ? `${t.description} (now ${system})` : t.description}
                </span>
              </button>
            )
          })}
        </div>
      </SettingsGroup>
      <SettingsGroup title="PDF preview">
        <SwitchRow
          label="Dark mode PDF"
          description={`Show the PDF pages with inverted colours in the dark theme${resolved === 'dark' ? '' : ' (you are using the light theme now)'}. Saved in this browser.`}
          checked={pdfInvert}
          onChange={v => usePrefs.getState().setPdfInvertDark(v)}
          testId="pdfInvertDark"
        />
      </SettingsGroup>
      <p className="set-footnote">
        The source editor’s colours follow this theme unless you pick a fixed editor theme in{' '}
        <button type="button" className="set-textbtn" onClick={onEditorTab}>
          Editor → Theme
        </button>
        .
      </p>
    </div>
  )
}

/** Miniature editor window drawn in the given theme's colours. */
function ThemeArt({ look, className }: { look: 'light' | 'dark'; className?: string }) {
  return (
    <span className={clsx('set-art', `set-art--${look}`, className)}>
      <span className="set-art__bar" />
      <span className="set-art__rail" />
      <span className="set-art__pane">
        <span className="set-art__line" />
        <span className="set-art__line set-art__line--short" />
        <span className="set-art__line set-art__line--accent" />
        <span className="set-art__line" />
        <span className="set-art__line set-art__line--short" />
      </span>
      <span className="set-art__canvas">
        <span className="set-art__page">
          <span className="set-art__ink set-art__ink--title" />
          <span className="set-art__ink" />
          <span className="set-art__ink" />
          <span className="set-art__ink set-art__ink--short" />
        </span>
      </span>
    </span>
  )
}
