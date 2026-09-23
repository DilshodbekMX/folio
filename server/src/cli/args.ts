/**
 * Minimal command-line parsing for the CLI tools (no dependencies):
 *   --key value · --key=value · --flag (boolean) · --help
 */
export interface OptionSpec {
  /** takes a value (default) or is a boolean flag */
  type?: 'string' | 'boolean'
  required?: boolean
  description: string
}

export class UsageError extends Error {}

export function parseArgs<T extends Record<string, OptionSpec>>(argv: string[], spec: T): { [K in keyof T]: T[K]['type'] extends 'boolean' ? boolean : string | undefined } & { help: boolean } {
  const out: Record<string, string | boolean | undefined> = { help: false }
  for (const [k, o] of Object.entries(spec)) out[k] = o.type === 'boolean' ? false : undefined
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      out.help = true
      continue
    }
    if (!arg.startsWith('--')) throw new UsageError(`Unexpected argument "${arg}"`)
    const eq = arg.indexOf('=')
    const key = arg.slice(2, eq === -1 ? undefined : eq)
    const o = spec[key]
    if (!o) throw new UsageError(`Unknown option --${key}`)
    if (o.type === 'boolean') {
      if (eq !== -1) {
        const v = arg.slice(eq + 1)
        if (!['true', 'false', '1', '0'].includes(v)) throw new UsageError(`--${key} is a flag (true/false)`)
        out[key] = v === 'true' || v === '1'
      } else out[key] = true
      continue
    }
    let value: string | undefined
    if (eq !== -1) value = arg.slice(eq + 1)
    else {
      value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) throw new UsageError(`--${key} needs a value`)
      i++
    }
    out[key] = value
  }
  if (!out.help) {
    for (const [k, o] of Object.entries(spec)) {
      if (o.required && (out[k] === undefined || out[k] === '')) throw new UsageError(`Missing required option --${k}`)
    }
  }
  return out as never
}

export function usage(command: string, summary: string, spec: Record<string, OptionSpec>): string {
  const lines = [`Usage: npm run ${command} -- [options]`, '', summary, '', 'Options:']
  for (const [k, o] of Object.entries(spec)) {
    const flag = o.type === 'boolean' ? `--${k}` : `--${k} <value>`
    lines.push(`  ${flag.padEnd(26)} ${o.description}${o.required ? ' (required)' : ''}`)
  }
  lines.push(`  ${'--help'.padEnd(26)} show this help`)
  return lines.join('\n')
}

/** Run a CLI main function: usage errors → exit 2, other errors → exit 1. */
export function runCli(main: () => Promise<number | void>, help: string): void {
  main().then(
    code => process.exit(code ?? 0),
    err => {
      if (err instanceof UsageError) {
        console.error(`error: ${err.message}\n\n${help}`)
        process.exit(2)
      }
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`)
      if (process.env.FOLIO_DEBUG) console.error(err)
      process.exit(1)
    },
  )
}
