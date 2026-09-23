import clsx from 'clsx'

/**
 * The Folio mark: a leaf — in bookbinding a "leaf" is also a sheet of a book, which is
 * what a folio is. The vein doubles as the page's spine.
 */
export function FolioMark({ size = 20, className, tile = false }: { size?: number; className?: string; tile?: boolean }) {
  if (tile) {
    return (
      <svg className={clsx('ui-logo-mark', className)} width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="7.5" fill="var(--accent)" />
        <path d="M7.5 24.5C7.5 14.6 13.4 8.1 24.5 7.5C24.5 18.3 18.2 24.3 7.5 24.5Z" fill="var(--accent-fg)" />
        <path d="M7.5 24.5L19 13" fill="none" stroke="var(--accent)" strokeWidth="1.9" strokeLinecap="round" />
      </svg>
    )
  }
  return (
    <svg className={clsx('ui-logo-mark', className)} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 20.5C3.5 10.4 9.5 3.9 20.5 3.5C20.5 14.4 14.2 20.3 3.5 20.5Z" fill="var(--accent)" />
      <path d="M3.5 20.5L15 9" fill="none" stroke="var(--bg)" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  )
}

/** Mark + wordmark. */
export function FolioLogo({ size = 20, className }: { size?: number; className?: string }) {
  return (
    <span className={clsx('ui-logo', className)} style={{ fontSize: Math.round(size * 0.86) }}>
      <FolioMark size={size} />
      <span className="ui-logo__word">Folio</span>
    </span>
  )
}
