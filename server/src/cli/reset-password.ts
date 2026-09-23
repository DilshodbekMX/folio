/**
 * npm run reset-password -- --email <email> --password <new password>
 * Also signs the account out everywhere (all sessions are deleted).
 */
// must stay the first import: loads .env before config/log read process.env
import '../env.ts'
import { hashPassword } from '../auth/passwords.ts'
import { passwordSchema } from '../auth/routes.ts'
import { parseArgs, runCli, usage, UsageError, type OptionSpec } from './args.ts'
import { openCliServices } from './container.ts'

const spec = {
  email: { required: true, description: 'e-mail address of the account' },
  password: { required: true, description: 'new password (at least 8 characters)' },
} satisfies Record<string, OptionSpec>

const help = usage('reset-password', "Set a new password for an account and sign it out of every session.", spec)

runCli(async () => {
  const args = parseArgs(process.argv.slice(2), spec)
  if (args.help) {
    console.log(help)
    return 0
  }
  const pw = passwordSchema.safeParse(args.password)
  if (!pw.success) throw new UsageError(`--password: ${pw.error.issues[0]?.message ?? 'invalid'}`)
  const { services, close } = openCliServices()
  try {
    const user = services.db.users.getByEmail(args.email ?? '')
    if (!user) throw new Error(`No account with the email ${args.email}`)
    services.db.users.update(user.id, { passwordHash: await hashPassword(pw.data) })
    services.db.sessions.deleteForUser(user.id)
    console.log(`Password updated for ${user.name} <${user.email}>; all of their sessions were signed out.`)
    return 0
  } finally {
    await close()
  }
}, help)
