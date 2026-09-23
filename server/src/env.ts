/**
 * Load `<app root>/.env` (or FOLIO_ENV_FILE) into process.env before anything reads it — imported
 * first by main.ts and the CLI entry points, so `npm start`, `npm run dev` and the CLI tools all
 * honour the same file. Variables already set in the environment win (process.loadEnvFile keeps
 * them). Tests never load it.
 *
 * FOLIO_ENV_FILE=none loads no file at all: throw-away servers (scripts/dev-instance.mjs,
 * scripts/e2e-server.mjs, e2e helpers) use it so a developer's .env (PUBLIC_ORIGIN,
 * ALLOW_SIGNUP, limits…) never leaks into them — a variable they delete from their environment
 * would otherwise be filled in again from the file.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_ROOT = path.resolve(fileURLToPath(new URL('../..', import.meta.url)))

/** FOLIO_ENV_FILE value that disables loading any env file */
export const NO_ENV_FILE = 'none'

const requested = process.env.FOLIO_ENV_FILE?.trim()

/** the env file Folio reads, or null when disabled (FOLIO_ENV_FILE=none) */
export const ENV_FILE: string | null = requested === NO_ENV_FILE ? null : requested ? path.resolve(requested) : path.join(APP_ROOT, '.env')

export let envFileLoaded = false

if (ENV_FILE && !process.env.VITEST && process.env.NODE_ENV !== 'test' && fs.existsSync(ENV_FILE)) {
  try {
    process.loadEnvFile(ENV_FILE)
    envFileLoaded = true
  } catch (err) {
    process.stderr.write(`Folio: could not read ${ENV_FILE}: ${(err as Error).message}\n`)
  }
}
