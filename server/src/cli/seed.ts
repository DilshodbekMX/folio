/**
 * npm run seed -- --src <dir> --owner <email> [--name <project name>] [--main <path>]
 *                 [--compiler pdflatex|latex|xelatex|lualatex] [--external a.tex,b.tex]
 *                 [--exclude ready,*.zip] [--timeout 240]
 *
 * Imports a directory as a new project (same importer as zip uploads). Symlinks are skipped;
 * the application's own directory and data directory, TeX build artefacts and `<root>.pdf`
 * files next to a root .tex are always skipped; `--exclude` (default `ready,*.zip`) adds
 * name patterns (a pattern without '/' matches any path segment).
 * Runs against the data directory directly. It can run while the server is running: the new
 * project is a new database row and directory, which the running server picks up at once.
 */
// must stay the first import: loads .env before config/log read process.env
import '../env.ts'
import path from 'node:path'
import { COMPILERS, type Compiler } from '@folio/shared/api'
import { toPublic } from '../db/index.ts'
import { collectDirectory, DEFAULT_SEED_EXCLUDES, importProject } from '../projects/importer.ts'
import { projectNameSchema } from '../projects/service.ts'
import { parseArgs, runCli, usage, UsageError, type OptionSpec } from './args.ts'
import { openCliServices } from './container.ts'

const spec = {
  src: { required: true, description: 'directory to import' },
  owner: { required: true, description: 'e-mail of the owning account (create it first with create-user)' },
  name: { description: 'project name (default: the directory name)' },
  main: { description: 'main document path inside the directory, e.g. paper.tex' },
  compiler: { description: 'pdflatex (default) | latex | xelatex | lualatex' },
  external: { description: 'comma-separated xr external documents to pre-build, e.g. supp.tex' },
  exclude: { description: `comma-separated name patterns to skip (default: ${DEFAULT_SEED_EXCLUDES.join(',')})` },
  timeout: { description: 'compile timeout in seconds (30..600)' },
} satisfies Record<string, OptionSpec>

const help = usage('seed', 'Import a directory of LaTeX sources as a new Folio project.', spec)

function list(v: string | undefined): string[] | undefined {
  return v === undefined ? undefined : v.split(',').map(x => x.trim()).filter(Boolean)
}

runCli(async () => {
  const args = parseArgs(process.argv.slice(2), spec)
  if (args.help) {
    console.log(help)
    return 0
  }
  const src = path.resolve(args.src!)
  const compiler = (args.compiler ?? 'pdflatex') as Compiler
  if (!COMPILERS.some(c => c.id === compiler)) throw new UsageError(`--compiler must be one of ${COMPILERS.map(c => c.id).join(', ')}`)
  let timeoutSec: number | undefined
  if (args.timeout !== undefined) {
    timeoutSec = Number(args.timeout)
    if (!Number.isInteger(timeoutSec) || timeoutSec < 30 || timeoutSec > 600) throw new UsageError('--timeout must be an integer between 30 and 600')
  }
  const nameCheck = projectNameSchema.safeParse(args.name ?? path.basename(src))
  if (!nameCheck.success) throw new UsageError(`--name: ${nameCheck.error.issues[0]?.message}`)

  const { services, close } = openCliServices({ history: true })
  try {
    const owner = services.db.users.getByEmail(args.owner!)
    if (!owner) throw new Error(`No account with the email ${args.owner}; create it first with: npm run create-user -- --email ${args.owner} --name <name> --password <password>`)
    const source = await collectDirectory(src, {
      exclude: list(args.exclude) ?? DEFAULT_SEED_EXCLUDES,
      skipDirs: [services.config.dataDir],
    })
    const result = await importProject(services, source, {
      owner: toPublic(owner),
      name: nameCheck.data,
      rootPath: args.main ?? null,
      compiler,
      externalDocs: list(args.external) ?? [],
      timeoutSec,
    })
    const bytes = (result.totalBytes / 1024 / 1024).toFixed(2)
    console.log(`Imported "${nameCheck.data}" as project ${result.projectId} for ${owner.email}`)
    console.log(`  files:     ${result.textPaths.length + result.binaryPaths.length} (${result.textPaths.length} text, ${result.binaryPaths.length} binary, ${bytes} MB)`)
    console.log(`  main:      ${result.rootPath ?? '(none — choose it in the project settings)'}`)
    console.log(`  compiler:  ${compiler}`)
    if ((list(args.external) ?? []).length) console.log(`  external:  ${list(args.external)!.join(', ')}`)
    const skipped = new Map<string, number>()
    for (const sk of result.skipped) skipped.set(sk.reason, (skipped.get(sk.reason) ?? 0) + 1)
    if (skipped.size) console.log(`  skipped:   ${[...skipped].map(([r, n]) => `${n} ${r}`).join(', ')}`)
    for (const sk of result.skipped.filter(x => x.reason === 'invalid-path')) console.log(`    invalid: ${sk.path} (${sk.detail})`)
    console.log(`Edits made in Folio live in ${path.join(services.config.dirs.projects, result.projectId)}, not in ${src}.`)
    return 0
  } finally {
    await close()
  }
}, help)
