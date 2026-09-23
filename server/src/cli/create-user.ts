/**
 * npm run create-user -- --email <email> --name <name> --password <password> [--admin]
 */
// must stay the first import: loads .env before config/log read process.env
import '../env.ts'
import type { z } from 'zod'
import { toPublic } from '../db/index.ts'
import { hashPassword } from '../auth/passwords.ts'
import { displayNameSchema, emailSchema, passwordSchema } from '../auth/routes.ts'
import { parseArgs, runCli, usage, UsageError, type OptionSpec } from './args.ts'
import { openCliServices } from './container.ts'

const spec = {
  email: { required: true, description: 'e-mail address (login name)' },
  name: { required: true, description: 'display name' },
  password: { required: true, description: `password (at least 8 characters)` },
  admin: { type: 'boolean', description: 'make the user an administrator' },
} satisfies Record<string, OptionSpec>

const help = usage('create-user', 'Create a Folio account.', spec)

function check<T>(schema: z.ZodType<T>, value: unknown, what: string): T {
  const r = schema.safeParse(value)
  if (!r.success) throw new UsageError(`${what}: ${r.error.issues[0]?.message ?? 'invalid'}`)
  return r.data
}

runCli(async () => {
  const args = parseArgs(process.argv.slice(2), spec)
  if (args.help) {
    console.log(help)
    return 0
  }
  const email = check(emailSchema, args.email, '--email')
  const name = check(displayNameSchema, args.name, '--name')
  const password = check(passwordSchema, args.password, '--password')
  const { services, close } = openCliServices()
  try {
    if (services.db.users.getByEmail(email)) throw new Error(`An account with the email ${email} already exists (use reset-password to change its password)`)
    const user = services.db.users.create({ email, name, passwordHash: await hashPassword(password), isAdmin: args.admin })
    const pub = toPublic(user)
    console.log(`Created ${user.isAdmin ? 'administrator' : 'user'} ${pub.name} <${pub.email}> (id ${pub.id})`)
    return 0
  } finally {
    await close()
  }
}, help)
