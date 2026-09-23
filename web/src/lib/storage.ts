/**
 * localStorage helpers that never throw (private mode, disabled storage, quota errors,
 * non-browser environments) and never trust stored JSON blindly.
 */

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

export function readString(key: string): string | null {
  try {
    return storage()?.getItem(key) ?? null
  } catch {
    return null
  }
}

export function writeString(key: string, value: string | null): void {
  const s = storage()
  if (!s) return
  try {
    if (value === null) s.removeItem(key)
    else s.setItem(key, value)
  } catch {
    // quota exceeded or storage disabled — persistence is best effort
  }
}

export function removeItem(key: string): void {
  writeString(key, null)
}

/**
 * Read a JSON value. `sanitize` receives the parsed value and returns the value to use
 * (or undefined to fall back), so callers can validate and fill defaults.
 */
export function readJSON<T>(key: string, fallback: T, sanitize?: (value: unknown) => T | undefined): T {
  const raw = readString(key)
  if (raw === null) return fallback
  try {
    const parsed: unknown = JSON.parse(raw)
    if (sanitize) return sanitize(parsed) ?? fallback
    return parsed as T
  } catch {
    return fallback
  }
}

export function writeJSON(key: string, value: unknown): void {
  try {
    writeString(key, JSON.stringify(value))
  } catch {
    // unserialisable value — ignore
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
