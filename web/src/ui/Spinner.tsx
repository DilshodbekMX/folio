import clsx from 'clsx'

export interface SpinnerProps {
  /** diameter in px (default 16) */
  size?: number
  /** accessible label; pass null for purely decorative spinners inside labelled controls */
  label?: string | null
  className?: string
}

export function Spinner({ size = 16, label = 'Loading', className }: SpinnerProps) {
  const stroke = size <= 14 ? 2 : size >= 32 ? 3 : 2.25
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  return (
    <span
      className={clsx('ui-spinner', className)}
      role={label ? 'status' : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      style={{ width: size, height: size }}
    >
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <circle className="ui-spinner__track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} fill="none" />
        <circle
          className="ui-spinner__arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          strokeWidth={stroke}
          fill="none"
          strokeLinecap="round"
          strokeDasharray={`${c * 0.28} ${c}`}
        />
      </svg>
    </span>
  )
}
