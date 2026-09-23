/** Layout pieces shared by the settings tabs: groups and label/description/control rows. */
import { useId, type ReactNode } from 'react'
import clsx from 'clsx'
import { Select, Switch, type SelectOption } from '../../ui'

export function SettingsGroup({ title, description, children, aside }: { title: string; description?: ReactNode; children: ReactNode; aside?: ReactNode }) {
  const id = useId()
  return (
    <section className="set-group" aria-labelledby={id}>
      <div className="set-group__head">
        <div>
          <h3 id={id} className="set-group__title">{title}</h3>
          {description && <p className="set-group__desc">{description}</p>}
        </div>
        {aside}
      </div>
      <div className="set-group__rows">{children}</div>
    </section>
  )
}

export function SettingRow({ label, description, htmlFor, children, stacked, className }: {
  label: ReactNode
  description?: ReactNode
  htmlFor?: string
  children: ReactNode
  /** control below the text (wide controls such as lists) */
  stacked?: boolean
  className?: string
}) {
  return (
    <div className={clsx('set-row', stacked && 'set-row--stacked', className)}>
      <div className="set-row__text">
        {htmlFor ? (
          <label className="set-row__label" htmlFor={htmlFor}>
            {label}
          </label>
        ) : (
          <span className="set-row__label">{label}</span>
        )}
        {description && <p className="set-row__desc">{description}</p>}
      </div>
      <div className="set-row__control">{children}</div>
    </div>
  )
}

export function SelectRow<T extends string>({ label, description, value, options, onChange, disabled, testId }: {
  label: ReactNode
  description?: ReactNode
  value: T
  options: SelectOption[]
  onChange: (v: T) => void
  disabled?: boolean
  testId?: string
}) {
  const id = useId()
  return (
    <SettingRow label={label} description={description} htmlFor={id}>
      <Select
        id={id}
        size="sm"
        value={value}
        options={options}
        disabled={disabled}
        wrapperClassName="set-select"
        data-setting={testId}
        onChange={e => onChange(e.target.value as T)}
      />
    </SettingRow>
  )
}

export function SwitchRow({ label, description, checked, onChange, disabled, testId }: {
  label: ReactNode
  description?: ReactNode
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
  testId?: string
}) {
  const id = useId()
  return (
    <SettingRow label={label} description={description} htmlFor={id}>
      <span data-setting={testId} className="set-switch">
        <Switch id={id} checked={checked} disabled={disabled} onChange={onChange} />
      </span>
    </SettingRow>
  )
}
