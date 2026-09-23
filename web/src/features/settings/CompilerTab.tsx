/**
 * Settings → Compiler: project settings shared by all collaborators (compiler, main document,
 * xr external documents, timeout; editors and the owner may change them, viewers see them
 * read-only) plus this browser's compile options for the project (auto compile, draft mode,
 * stop on first error — stored per project in localStorage by the compile store).
 */
import { useEffect, useId, useMemo, useState, type KeyboardEvent } from 'react'
import { Info, Lock, Play } from 'lucide-react'
import { COMPILERS, type Compiler, type ProjectSettings, type SystemInfo } from '@folio/shared/api'
import { api } from '../../api/endpoints'
import { errorMessage } from '../../api/client'
import { useCompile } from '../../stores/compile'
import { useProject } from '../../stores/project'
import { Button, Checkbox, EmptyState, TextField, toast, type SelectOption } from '../../ui'
import { SelectRow, SettingRow, SettingsGroup, SwitchRow } from './controls'

export const MIN_TIMEOUT = 30
export const MAX_TIMEOUT = 600

let systemInfo: Promise<SystemInfo | null> | null = null
/** Server/TeX Live info (cached for the session). */
function loadSystemInfo(): Promise<SystemInfo | null> {
  systemInfo ??= api.system({ silent: true }).catch(() => {
    systemInfo = null
    return null
  })
  return systemInfo
}

function saveProjectSettings(patch: Partial<ProjectSettings>, what: string): void {
  useProject.getState().updateSettings(patch).catch(e => toast(`Couldn’t change the ${what}: ${errorMessage(e)}`, { tone: 'error' }))
}

const isTexPath = (p: string) => /\.(tex|ltx)$/i.test(p)

export function CompilerTab() {
  const projectId = useProject(s => s.projectId)
  const settings = useProject(s => s.settings)
  const files = useProject(s => s.files)
  const role = useProject(s => s.role)
  const options = useCompile(s => s.options)
  const compiling = useCompile(s => s.status === 'compiling')
  const [system, setSystem] = useState<SystemInfo | null>(null)
  const timeoutId = useId()

  const canEdit = role === 'owner' || role === 'editor'

  useEffect(() => {
    let alive = true
    void loadSystemInfo().then(info => {
      if (alive) setSystem(info)
    })
    return () => {
      alive = false
    }
  }, [])

  const texFiles = useMemo(
    () => Object.values(files).filter(f => f.kind === 'text' && isTexPath(f.path)).sort((a, b) => a.path.localeCompare(b.path)),
    [files],
  )

  if (!projectId || !settings) {
    return (
      <div className="set-tab">
        <EmptyState icon={Info} title="No project open" size="sm">
          Open a project to change its compiler settings.
        </EmptyState>
      </div>
    )
  }

  const root = settings.rootFileId ? files[settings.rootFileId] : undefined
  const rootOptions: SelectOption[] = [
    ...(!root ? [{ value: '', label: settings.rootFileId ? 'Missing file — choose another' : 'Detect automatically' }] : []),
    ...texFiles.map(f => ({ value: f.id, label: f.path })),
  ]
  const compilerOptions: SelectOption[] = COMPILERS.map(c => ({ value: c.id, label: c.label }))

  const externalCandidates = texFiles.filter(f => f.id !== settings.rootFileId)
  const missingExternal = settings.externalDocs.filter(p => !texFiles.some(f => f.path === p))

  const toggleExternal = (path: string, on: boolean) => {
    const cur = settings.externalDocs
    const next = on ? [...cur.filter(p => p !== path), path] : cur.filter(p => p !== path)
    saveProjectSettings({ externalDocs: next }, 'external documents')
  }

  const texLive = system?.texLive ?? 'TeX Live'

  return (
    <div className="set-tab">
      {!canEdit && (
        <p className="set-notice" role="note">
          <Lock size={14} aria-hidden="true" />
          <span>You have view-only access. Only the owner and editors can change how this project is compiled.</span>
        </p>
      )}

      <SettingsGroup title="Project" description="These settings are shared by everyone working on this project.">
        <SelectRow
          label="Compiler"
          description="The TeX engine. XeLaTeX and LuaLaTeX support system fonts and Unicode input."
          value={settings.compiler}
          options={compilerOptions}
          disabled={!canEdit}
          testId="compiler"
          onChange={v => saveProjectSettings({ compiler: v as Compiler }, 'compiler')}
        />
        <SelectRow
          label="Main document"
          description="The file that is compiled. Other files are pulled in with \input or \include."
          value={root ? root.id : ''}
          options={rootOptions}
          disabled={!canEdit || texFiles.length === 0}
          testId="rootFileId"
          onChange={v => {
            if (v) saveProjectSettings({ rootFileId: v }, 'main document')
          }}
        />
        <SettingRow
          label="External documents"
          stacked
          description={
            <>
              Documents your main document references with the <code>xr</code> package’s <code>\externaldocument</code>{' '}
              are compiled first, so references between them (for example to a supplementary file) resolve. Leave all unticked to
              detect them automatically from the main document.
            </>
          }
        >
          <div className="set-checklist" role="group" aria-label="External documents" data-setting="externalDocs">
            {externalCandidates.length === 0 && missingExternal.length === 0 && (
              <p className="set-checklist__empty">There are no other .tex files in this project.</p>
            )}
            {externalCandidates.map(f => (
              <Checkbox
                key={f.id}
                className="set-checklist__item"
                label={<span className="set-mono">{f.path}</span>}
                checked={settings.externalDocs.includes(f.path)}
                disabled={!canEdit}
                onChange={on => toggleExternal(f.path, on)}
              />
            ))}
            {missingExternal.map(p => (
              <Checkbox
                key={p}
                className="set-checklist__item"
                label={<span className="set-mono">{p}</span>}
                description="This file no longer exists."
                checked
                disabled={!canEdit}
                onChange={on => toggleExternal(p, on)}
              />
            ))}
          </div>
        </SettingRow>
        <SettingRow
          label="Compile timeout"
          htmlFor={timeoutId}
          description={`Stop compiles that run longer than this (${MIN_TIMEOUT}–${MAX_TIMEOUT} seconds).`}
        >
          <TimeoutField id={timeoutId} value={settings.timeoutSec} disabled={!canEdit} />
        </SettingRow>
        <SettingRow label="TeX Live" description="The TeX distribution is chosen by the server administrator.">
          <span className="set-readonly" data-setting="image" title={settings.image}>
            <span className="set-readonly__main">{texLive}</span>
            {settings.image && <span className="set-readonly__sub set-mono">{settings.image}</span>}
          </span>
        </SettingRow>
      </SettingsGroup>

      {canEdit && (
        <SettingsGroup
          title="Your compile options"
          description="Only for you, in this browser."
          aside={
            <Button size="sm" variant="secondary" icon={Play} loading={compiling} onClick={() => void useCompile.getState().compile()}>
              Recompile
            </Button>
          }
        >
          <SwitchRow
            label="Auto compile"
            description="Recompile automatically a few seconds after you stop typing."
            checked={options.autoCompile}
            testId="autoCompile"
            onChange={v => useCompile.getState().setOption('autoCompile', v)}
          />
          <SelectRow
            label="Compile mode"
            description="Fast [draft] skips images for quicker compiles."
            value={options.draft ? 'draft' : 'normal'}
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'draft', label: 'Fast [draft]' },
            ]}
            testId="draft"
            onChange={v => useCompile.getState().setOption('draft', v === 'draft')}
          />
          <SwitchRow
            label="Stop on first error"
            description="Stop at the first LaTeX error instead of trying to produce a PDF anyway."
            checked={options.stopOnFirstError}
            testId="stopOnFirstError"
            onChange={v => useCompile.getState().setOption('stopOnFirstError', v)}
          />
        </SettingsGroup>
      )}
    </div>
  )
}

function TimeoutField({ id, value, disabled }: { id: string; value: number; disabled: boolean }) {
  const [draft, setDraft] = useState(String(value))
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setDraft(String(value))
    setError(null)
  }, [value])

  const commit = () => {
    const n = Number(draft.trim())
    if (!Number.isInteger(n) || n < MIN_TIMEOUT || n > MAX_TIMEOUT) {
      setError(`Enter a whole number of seconds between ${MIN_TIMEOUT} and ${MAX_TIMEOUT}.`)
      return
    }
    setError(null)
    if (n !== value) saveProjectSettings({ timeoutSec: n }, 'timeout')
  }

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape' && draft !== String(value)) {
      e.preventDefault()
      e.stopPropagation()
      setDraft(String(value))
      setError(null)
    }
  }

  return (
    <span className="set-timeout">
      <TextField
        id={id}
        size="sm"
        type="number"
        inputMode="numeric"
        min={MIN_TIMEOUT}
        max={MAX_TIMEOUT}
        step={10}
        value={draft}
        invalid={!!error}
        disabled={disabled}
        wrapperClassName="set-timeout__field"
        aria-describedby={error ? `${id}-error` : undefined}
        data-setting="timeoutSec"
        onChange={e => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        trailing={<span className="set-timeout__unit">s</span>}
      />
      {error && (
        <span id={`${id}-error`} className="set-timeout__error" role="alert">
          {error}
        </span>
      )}
    </span>
  )
}
