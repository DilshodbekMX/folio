import {
  Children, cloneElement, isValidElement, useId,
  type ChangeEvent, type InputHTMLAttributes, type ReactElement, type ReactNode, type Ref,
  type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react'
import clsx from 'clsx'
import { Check, ChevronDown, Minus } from 'lucide-react'
import { renderIcon, type IconProp } from './icon'

// ---------------------------------------------------------------------------
// TextField / TextArea
// ---------------------------------------------------------------------------

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'size'> {
  /** leading icon inside the field (e.g. Search) */
  icon?: IconProp
  /** trailing content inside the field (e.g. a clear button) */
  trailing?: ReactNode
  invalid?: boolean
  size?: 'sm' | 'md'
  ref?: Ref<HTMLInputElement>
  /** class for the outer wrapper */
  wrapperClassName?: string
}

export function TextField({ icon, trailing, invalid, size = 'md', className, wrapperClassName, ref, type = 'text', ...rest }: TextFieldProps) {
  return (
    <span
      className={clsx(
        'ui-textfield',
        `ui-textfield--${size}`,
        icon !== undefined && 'has-icon',
        trailing !== undefined && 'has-trailing',
        invalid && 'is-invalid',
        rest.disabled && 'is-disabled',
        wrapperClassName,
      )}
    >
      {icon !== undefined && <span className="ui-textfield__icon">{renderIcon(icon, size === 'sm' ? 14 : 16)}</span>}
      <input ref={ref} type={type} aria-invalid={invalid || undefined} className={clsx('ui-input', className)} {...rest} />
      {trailing !== undefined && <span className="ui-textfield__trailing">{trailing}</span>}
    </span>
  )
}

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
  ref?: Ref<HTMLTextAreaElement>
}

export function TextArea({ invalid, className, ref, ...rest }: TextAreaProps) {
  return <textarea ref={ref} aria-invalid={invalid || undefined} className={clsx('ui-input', 'ui-textarea', invalid && 'is-invalid', className)} {...rest} />
}

// ---------------------------------------------------------------------------
// Select (native, styled)
// ---------------------------------------------------------------------------

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'size'> {
  /** options (alternatively pass <option>/<optgroup> children) */
  options?: SelectOption[]
  invalid?: boolean
  size?: 'sm' | 'md'
  ref?: Ref<HTMLSelectElement>
  wrapperClassName?: string
}

export function Select({ options, invalid, size = 'md', className, wrapperClassName, children, ref, ...rest }: SelectProps) {
  return (
    <span className={clsx('ui-select', `ui-select--${size}`, invalid && 'is-invalid', rest.disabled && 'is-disabled', wrapperClassName)}>
      <select ref={ref} aria-invalid={invalid || undefined} className={clsx('ui-select__native', className)} {...rest}>
        {options
          ? options.map(o => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))
          : children}
      </select>
      <ChevronDown className="ui-select__chevron" size={14} aria-hidden="true" />
    </span>
  )
}

// ---------------------------------------------------------------------------
// Checkbox / Switch
// ---------------------------------------------------------------------------

export interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean, event: ChangeEvent<HTMLInputElement>) => void
  label?: ReactNode
  description?: ReactNode
  disabled?: boolean
  indeterminate?: boolean
  id?: string
  className?: string
  /** accessible name when there is no visible label */
  'aria-label'?: string
  name?: string
}

export function Checkbox({ checked, onChange, label, description, disabled, indeterminate, id, className, name, ...aria }: CheckboxProps) {
  const autoId = useId()
  const inputId = id ?? autoId
  return (
    <label className={clsx('ui-check', disabled && 'is-disabled', className)} htmlFor={inputId}>
      <span className="ui-check__box-wrap">
        <input
          id={inputId}
          name={name}
          type="checkbox"
          className="ui-check__input"
          checked={checked}
          disabled={disabled}
          aria-label={aria['aria-label']}
          aria-checked={indeterminate ? 'mixed' : undefined}
          ref={el => {
            if (el) el.indeterminate = !!indeterminate
          }}
          onChange={e => onChange(e.target.checked, e)}
        />
        <span className="ui-check__box" aria-hidden="true">
          {indeterminate ? <Minus size={12} strokeWidth={3} /> : checked ? <Check size={12} strokeWidth={3} /> : null}
        </span>
      </span>
      {(label || description) && (
        <span className="ui-check__text">
          {label && <span className="ui-check__label">{label}</span>}
          {description && <span className="ui-check__desc">{description}</span>}
        </span>
      )}
    </label>
  )
}

export interface SwitchProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: ReactNode
  description?: ReactNode
  disabled?: boolean
  id?: string
  className?: string
  'aria-label'?: string
}

export function Switch({ checked, onChange, label, description, disabled, id, className, ...aria }: SwitchProps) {
  const autoId = useId()
  const btnId = id ?? autoId
  const labelId = `${btnId}-label`
  const descId = `${btnId}-desc`
  return (
    <div className={clsx('ui-switch-row', disabled && 'is-disabled', className)}>
      {(label || description) && (
        <span className="ui-switch-row__text">
          {label && (
            <label id={labelId} htmlFor={btnId} className="ui-switch-row__label">
              {label}
            </label>
          )}
          {description && <span id={descId} className="ui-switch-row__desc">{description}</span>}
        </span>
      )}
      <button
        id={btnId}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={label ? labelId : undefined}
        aria-describedby={description ? descId : undefined}
        aria-label={label ? undefined : aria['aria-label']}
        disabled={disabled}
        className={clsx('ui-switch', checked && 'is-on')}
        onClick={() => onChange(!checked)}
      >
        <span className="ui-switch__thumb" />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Field (label + control + hint/error)
// ---------------------------------------------------------------------------

export interface FieldProps {
  label: ReactNode
  hint?: ReactNode
  /** error message; also marks the control invalid via aria-invalid when it supports `invalid` */
  error?: ReactNode
  children: ReactNode
  /** id of the control; generated and injected into a single child element when omitted */
  htmlFor?: string
  className?: string
  /** place label and control side by side (settings rows) */
  inline?: boolean
  /** extra content right-aligned in the label row (e.g. "Forgot?" link) */
  aside?: ReactNode
}

type ControlProps = { id?: string; 'aria-describedby'?: string; invalid?: boolean; 'aria-invalid'?: boolean }

export function Field({ label, hint, error, children, htmlFor, className, inline, aside }: FieldProps) {
  const autoId = useId()
  const child = Children.count(children) === 1 && isValidElement(children) ? (children as ReactElement<ControlProps>) : null
  const controlId = htmlFor ?? child?.props.id ?? `${autoId}-control`
  const hintId = `${autoId}-hint`
  const errorId = `${autoId}-error`
  const describedBy = clsx(child?.props['aria-describedby'], hint && hintId, error && errorId) || undefined
  const control = child
    ? cloneElement(child, {
        id: controlId,
        'aria-describedby': describedBy,
        // Our controls take `invalid`; plain DOM elements get aria-invalid instead.
        ...(error ? (typeof child.type === 'string' ? { 'aria-invalid': true } : { invalid: true }) : {}),
      })
    : children
  return (
    <div className={clsx('ui-field', inline && 'ui-field--inline', error && 'has-error', className)}>
      <div className="ui-field__labelrow">
        <label className="ui-field__label" htmlFor={controlId}>
          {label}
        </label>
        {aside && <span className="ui-field__aside">{aside}</span>}
      </div>
      <div className="ui-field__control">
        {control}
        {hint && !error && <p id={hintId} className="ui-field__hint">{hint}</p>}
        {error && (
          <p id={errorId} className="ui-field__error" role="alert">
            {error}
          </p>
        )}
      </div>
    </div>
  )
}
