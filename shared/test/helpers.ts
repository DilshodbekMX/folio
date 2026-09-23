import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LogEntry, ParsedLog } from '../src/api.ts'

export const FIXTURES = fileURLToPath(new URL('./fixtures/', import.meta.url))

export function fixture(rel: string): Buffer {
  return readFileSync(path.join(FIXTURES, rel))
}

export function fixtureText(rel: string): string {
  return readFileSync(path.join(FIXTURES, rel), 'utf8')
}

/** true when a fixture exists (paper-derived fixtures are not distributed: see README → Development) */
export function hasFixture(rel: string): boolean {
  return existsSync(path.join(FIXTURES, rel))
}

/** fixture bytes, or an empty buffer when it is not distributed (guard the suite with hasFixture) */
export function optionalFixture(rel: string): Buffer {
  return hasFixture(rel) ? fixture(rel) : Buffer.alloc(0)
}

/** fixture text, or '' when it is not distributed (guard the suite with hasFixture) */
export function optionalFixtureText(rel: string): string {
  return hasFixture(rel) ? fixtureText(rel) : ''
}

/** getSource over a fixture directory (project path → file text) */
export function sourcesIn(dir: string): (p: string) => string | null {
  return p => {
    try {
      return readFileSync(path.join(FIXTURES, dir, p), 'utf8')
    } catch {
      return null
    }
  }
}

export function all(log: ParsedLog): LogEntry[] {
  return [...log.errors, ...log.warnings, ...log.typesetting, ...log.info]
}

export type Brief = [level: string, kind: string | undefined, file: string | null, line: number | null]

export function brief(entries: LogEntry[]): Brief[] {
  return entries.map(e => [e.level, e.kind, e.file, e.line])
}

export function counts(log: ParsedLog): { errors: number; warnings: number; typesetting: number; info: number } {
  return { errors: log.errors.length, warnings: log.warnings.length, typesetting: log.typesetting.length, info: log.info.length }
}
