/**
 * Settings modal (SPEC §6.7 / §6.8): tabs Editor / Compiler / Appearance / Account.
 *
 * Every change applies immediately: user settings go through useAuth.updateSettings
 * (optimistic, persisted on the account), project settings through useProject.updateSettings
 * (owner/editor; viewers see them read-only), per-browser compile options through useCompile.
 *
 * A tab can be preselected with useLayout.openModal('settings', { tab: 'compiler' }); otherwise
 * the modal reopens on the tab used last in this session.
 */
import { useRef, useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import { Code, Cpu, Palette, UserRound } from 'lucide-react'
import { useLayout } from '../../stores/layout'
import { useProject } from '../../stores/project'
import { Modal } from '../../ui'
import { EditorTab } from './EditorTab'
import { CompilerTab } from './CompilerTab'
import { AppearanceTab } from './AppearanceTab'
import { AccountTab } from './AccountTab'
import './settings.css'

export type SettingsTab = 'editor' | 'compiler' | 'appearance' | 'account'

const TABS: { id: SettingsTab; label: string; icon: typeof Code }[] = [
  { id: 'editor', label: 'Editor', icon: Code },
  { id: 'compiler', label: 'Compiler', icon: Cpu },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'account', label: 'Account', icon: UserRound },
]

let lastTab: SettingsTab = 'editor'

function isTab(v: unknown): v is SettingsTab {
  return typeof v === 'string' && TABS.some(t => t.id === v)
}

export function SettingsModal({ onClose }: { onClose: () => void }) {
  const hasProject = useProject(s => s.projectId !== null)
  const [tab, setTabState] = useState<SettingsTab>(() => {
    const requested = useLayout.getState().modal?.props?.tab
    return isTab(requested) ? requested : lastTab
  })
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})

  const setTab = (t: SettingsTab) => {
    lastTab = t
    setTabState(t)
  }

  const onNavKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TABS.findIndex(t => t.id === tab)
    let n = -1
    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') n = (i + 1) % TABS.length
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') n = (i - 1 + TABS.length) % TABS.length
    else if (e.key === 'Home') n = 0
    else if (e.key === 'End') n = TABS.length - 1
    if (n < 0) return
    e.preventDefault()
    setTab(TABS[n].id)
    refs.current[TABS[n].id]?.focus()
  }

  const active = TABS.find(t => t.id === tab) ?? TABS[0]

  return (
    <Modal open onClose={onClose} title="Settings" size="lg" className="set-modal" bodyClassName="set-modal__body">
      <div className="set-layout">
        <div className="set-nav" role="tablist" aria-label="Settings sections" aria-orientation="vertical" onKeyDown={onNavKey}>
          {TABS.map(t => {
            const Icon = t.icon
            const selected = t.id === tab
            return (
              <button
                key={t.id}
                ref={el => {
                  refs.current[t.id] = el
                }}
                type="button"
                role="tab"
                id={`set-tab-${t.id}`}
                aria-controls={`set-panel-${t.id}`}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                className={clsx('set-nav__item', selected && 'is-active')}
                onClick={() => setTab(t.id)}
                data-autofocus={selected ? true : undefined}
              >
                <Icon size={16} aria-hidden="true" />
                <span>{t.label}</span>
                {t.id === 'compiler' && !hasProject && <span className="visually-hidden"> (no project open)</span>}
              </button>
            )
          })}
        </div>
        <div
          className="set-panel"
          role="tabpanel"
          id={`set-panel-${active.id}`}
          aria-labelledby={`set-tab-${active.id}`}
          tabIndex={-1}
          key={active.id}
        >
          {active.id === 'editor' && <EditorTab />}
          {active.id === 'compiler' && <CompilerTab />}
          {active.id === 'appearance' && <AppearanceTab onEditorTab={() => setTab('editor')} />}
          {active.id === 'account' && <AccountTab />}
        </div>
      </div>
    </Modal>
  )
}
