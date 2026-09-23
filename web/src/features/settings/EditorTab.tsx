/** Settings → Editor: per-user editor preferences (applied live, saved to the account). */
import type { ReactNode } from 'react'
import clsx from 'clsx'
import type { EditorFontFamily, UserSettings } from '@folio/shared/api'
import { errorMessage } from '../../api/client'
import { useAuth, useResolvedTheme, useSettings } from '../../stores/auth'
import { useProject } from '../../stores/project'
import { Select, Switch, toast, type SelectOption } from '../../ui'
import { SelectRow, SettingRow, SettingsGroup, SwitchRow } from './controls'

export const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24]

export const FONT_FAMILIES: { value: EditorFontFamily; label: string }[] = [
  { value: 'monospace', label: 'System monospace' },
  { value: 'dejavu', label: 'DejaVu Sans Mono' },
  { value: 'source-code', label: 'Source Code Pro' },
  { value: 'fira-code', label: 'Fira Code' },
  { value: 'jetbrains-mono', label: 'JetBrains Mono' },
]

const EDITOR_THEMES: SelectOption[] = [
  { value: 'auto', label: 'Auto (match the app)' },
  { value: 'light', label: 'Light' },
  { value: 'one-dark', label: 'One Dark' },
]

const LINE_HEIGHTS: SelectOption[] = [
  { value: 'compact', label: 'Compact' },
  { value: 'normal', label: 'Normal' },
  { value: 'wide', label: 'Wide' },
]

const KEYBINDINGS: SelectOption[] = [
  { value: 'default', label: 'Default' },
  { value: 'vim', label: 'Vim' },
  { value: 'emacs', label: 'Emacs' },
]

const PDF_ZOOM: SelectOption[] = [
  { value: 'page-width', label: 'Fit to width' },
  { value: 'page-fit', label: 'Fit to page' },
  { value: 'page-height', label: 'Fit to height' },
  { value: 'auto', label: 'Automatic' },
  { value: '0.5', label: '50%' },
  { value: '0.75', label: '75%' },
  { value: '1', label: '100%' },
  { value: '1.25', label: '125%' },
  { value: '1.5', label: '150%' },
  { value: '2', label: '200%' },
  { value: '3', label: '300%' },
]

/** Spell-check languages offered (BCP 47 tags; the browser's dictionaries do the checking). */
export const SPELL_LANGUAGES: SelectOption[] = [
  { value: 'en', label: 'English' },
  { value: 'en-US', label: 'English (American)' },
  { value: 'en-GB', label: 'English (British)' },
  { value: 'en-CA', label: 'English (Canadian)' },
  { value: 'en-AU', label: 'English (Australian)' },
  { value: 'de', label: 'German' },
  { value: 'fr', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'it', label: 'Italian' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'pt-BR', label: 'Portuguese (Brazilian)' },
  { value: 'nl', label: 'Dutch' },
  { value: 'pl', label: 'Polish' },
  { value: 'cs', label: 'Czech' },
  { value: 'sk', label: 'Slovak' },
  { value: 'hu', label: 'Hungarian' },
  { value: 'ro', label: 'Romanian' },
  { value: 'ru', label: 'Russian' },
  { value: 'uk', label: 'Ukrainian' },
  { value: 'el', label: 'Greek' },
  { value: 'tr', label: 'Turkish' },
  { value: 'sv', label: 'Swedish' },
  { value: 'da', label: 'Danish' },
  { value: 'nb', label: 'Norwegian (Bokmål)' },
  { value: 'fi', label: 'Finnish' },
  { value: 'ca', label: 'Catalan' },
]

/** Save a settings patch (optimistic in the auth store); report failures. */
export function saveSettings(patch: Partial<UserSettings>): void {
  useAuth.getState().updateSettings(patch).catch(e => toast(`Couldn’t save the setting: ${errorMessage(e)}`, { tone: 'error' }))
}

function withCurrent(options: SelectOption[], value: string, label: (v: string) => string): SelectOption[] {
  return options.some(o => o.value === value) ? options : [...options, { value, label: label(value) }]
}

export function EditorTab() {
  const s = useSettings()
  const resolvedTheme = useResolvedTheme()
  const projectId = useProject(p => p.projectId)
  const spellLang = useProject(p => p.settings?.spellLang ?? 'en')
  const canEditProject = useProject(p => p.role === 'owner' || p.role === 'editor')

  const zoomOptions = withCurrent(PDF_ZOOM, s.pdfZoom, v => (Number.isFinite(Number(v)) ? `${Math.round(Number(v) * 100)}%` : v))
  const sizeOptions = withCurrent(FONT_SIZES.map(n => ({ value: String(n), label: `${n} px` })), String(s.fontSize), v => `${v} px`)
  const langOptions = withCurrent(SPELL_LANGUAGES, spellLang, v => v)

  const setSpellLang = (lang: string) => {
    useProject.getState().updateSettings({ spellLang: lang }).catch(e => toast(`Couldn’t change the language: ${errorMessage(e)}`, { tone: 'error' }))
  }

  return (
    <div className="set-tab">
      <EditorPreview settings={s} palette={s.editorTheme === 'auto' ? resolvedTheme : s.editorTheme} />

      <SettingsGroup title="Display">
        <SelectRow
          label="Theme"
          description="Auto follows the app theme, light or dark."
          value={s.editorTheme}
          options={EDITOR_THEMES}
          testId="editorTheme"
          onChange={v => saveSettings({ editorTheme: v as UserSettings['editorTheme'] })}
        />
        <SelectRow
          label="Font size"
          value={String(s.fontSize)}
          options={sizeOptions}
          testId="fontSize"
          onChange={v => saveSettings({ fontSize: Number(v) })}
        />
        <SelectRow
          label="Font family"
          description="Fonts that aren’t installed on this computer fall back to the system monospace font."
          value={s.fontFamily}
          options={FONT_FAMILIES}
          testId="fontFamily"
          onChange={v => saveSettings({ fontFamily: v as EditorFontFamily })}
        />
        <SelectRow
          label="Line height"
          value={s.lineHeight}
          options={LINE_HEIGHTS}
          testId="lineHeight"
          onChange={v => saveSettings({ lineHeight: v as UserSettings['lineHeight'] })}
        />
        <SwitchRow
          label="Line wrapping"
          description="Wrap long lines to the width of the editor."
          checked={s.lineWrapping}
          testId="lineWrapping"
          onChange={v => saveSettings({ lineWrapping: v })}
        />
      </SettingsGroup>

      <SettingsGroup title="Editing">
        <SelectRow
          label="Keybindings"
          description={s.keybindings === 'vim' ? 'Vim key bindings in the source editor. :w compiles.' : 'Use the key bindings of Vim or Emacs in the source editor.'}
          value={s.keybindings}
          options={KEYBINDINGS}
          testId="keybindings"
          onChange={v => saveSettings({ keybindings: v as UserSettings['keybindings'] })}
        />
        <SwitchRow
          label="Auto-complete"
          description="Suggest commands, environments, labels, citations and file names as you type."
          checked={s.autoComplete}
          testId="autoComplete"
          onChange={v => saveSettings({ autoComplete: v })}
        />
        <SwitchRow
          label="Auto-close brackets"
          description="Insert the closing bracket, brace or $ automatically."
          checked={s.autoCloseBrackets}
          testId="autoCloseBrackets"
          onChange={v => saveSettings({ autoCloseBrackets: v })}
        />
        <SettingRow
          label="Spell check"
          description={
            projectId
              ? `Uses your browser’s dictionary. The language is shared by everyone in this project${canEditProject ? '' : ' and can be changed by editors'}.`
              : 'Uses your browser’s dictionary.'
          }
        >
          <span className="set-inline">
            {projectId && (
              <Select
                size="sm"
                aria-label="Spell check language"
                value={spellLang}
                options={langOptions}
                disabled={!canEditProject}
                wrapperClassName="set-select set-select--narrow"
                data-setting="spellLang"
                onChange={e => setSpellLang(e.target.value)}
              />
            )}
            <span data-setting="spellCheck" className="set-switch">
              <Switch aria-label="Spell check" checked={s.spellCheck} onChange={v => saveSettings({ spellCheck: v })} />
            </span>
          </span>
        </SettingRow>
        <SwitchRow
          label="Equation preview"
          description="Show a rendered preview of the math under the cursor."
          checked={s.equationPreview}
          testId="equationPreview"
          onChange={v => saveSettings({ equationPreview: v })}
        />
      </SettingsGroup>

      <SettingsGroup title="PDF viewer">
        <SelectRow
          label="Default zoom"
          description="Zoom used when a PDF is opened. Changing the zoom in the viewer updates it."
          value={s.pdfZoom}
          options={zoomOptions}
          testId="pdfZoom"
          onChange={v => saveSettings({ pdfZoom: v })}
        />
      </SettingsGroup>
    </div>
  )
}

/** Same values as the source editor (features/editor/ext/theme.ts). */
const LINE_HEIGHT_VALUES: Record<UserSettings['lineHeight'], number> = { compact: 1.33, normal: 1.6, wide: 2 }

/** A small static rendering of LaTeX source in the chosen editor font, size, line height and theme. */
function EditorPreview({ settings, palette }: { settings: UserSettings; palette: 'light' | 'dark' | 'one-dark' }) {
  const lines: { key: string; content: ReactNode }[] = [
    { key: '1', content: <><span className="t-cmd">\section</span><span className="t-br">{'{'}</span>Rate limiting<span className="t-br">{'}'}</span></> },
    {
      key: '2',
      content: (
        <>
          Each flow’s rate is smoothed with an EWMA, <span className="t-math">$\hat r_t$</span>, before it is compared with the threshold <span className="t-math">$\theta$</span>.
        </>
      ),
    },
    { key: '3', content: <span className="t-comment">% alpha was tuned on the CESNET trace</span> },
    { key: '4', content: <><span className="t-cmd">\begin</span><span className="t-br">{'{'}</span><span className="t-env">equation</span><span className="t-br">{'}'}</span><span className="t-cmd">\label</span><span className="t-br">{'{'}</span>eq:ewma<span className="t-br">{'}'}</span></> },
    { key: '5', content: <span className="t-math">{'  \\hat r_t \\le \\theta'}</span> },
    { key: '6', content: <><span className="t-cmd">\end</span><span className="t-br">{'{'}</span><span className="t-env">equation</span><span className="t-br">{'}'}</span></> },
  ]
  return (
    <figure className="set-preview-wrap" aria-label="Editor preview">
      <div
        className={clsx('set-preview', `set-preview--${palette}`, settings.lineWrapping && 'is-wrapping')}
        style={{
          fontFamily: `var(--font-editor-${settings.fontFamily})`,
          fontSize: `${settings.fontSize}px`,
          lineHeight: LINE_HEIGHT_VALUES[settings.lineHeight],
        }}
        aria-hidden="true"
      >
        {lines.map(l => (
          <div key={l.key} className="set-preview__line">
            <span className="set-preview__num">{l.key}</span>
            <span className="set-preview__text">{l.content}</span>
          </div>
        ))}
      </div>
      <figcaption className="set-preview__caption">Preview</figcaption>
    </figure>
  )
}
