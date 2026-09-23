/**
 * Password hashing with node:crypto scrypt (SPEC §4.2).
 *
 * Format: `scrypt$N$r$p$saltB64$hashB64` (N = 2^16, r = 8, p = 1, 16-byte salt, 32-byte key).
 * scrypt with these parameters needs ~64 MiB per hash, so `maxmem` must be raised (Node's
 * default cap is 32 MiB) and concurrent hashes are capped to keep a login flood from
 * exhausting memory / the libuv threadpool.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto'

export const MIN_PASSWORD_LENGTH = 8
export const MAX_PASSWORD_LENGTH = 256

const PARAMS = { N: 2 ** 16, r: 8, p: 1 }
const KEY_LEN = 32
const SALT_LEN = 16
const MAXMEM = 256 * 1024 * 1024
const MAX_CONCURRENT = 2

let active = 0
const waiters: (() => void)[] = []

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>(resolve => waiters.push(resolve))
  else active++
  try {
    return await fn()
  } finally {
    const next = waiters.shift()
    if (next) next()
    else active--
  }
}

function scrypt(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return withSlot(() => new Promise<Buffer>((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)))
  }))
}

/** Returns an error message when the password violates the policy, else null. */
export function passwordPolicyError(password: string): string | null {
  if (typeof password !== 'string') return 'Password is required'
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`
  if (password.length > MAX_PASSWORD_LENGTH) return `Password must be at most ${MAX_PASSWORD_LENGTH} characters`
  return null
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN)
  const key = await scrypt(password, salt, KEY_LEN, { ...PARAMS, maxmem: MAXMEM })
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

interface ParsedHash { N: number; r: number; p: number; salt: Buffer; key: Buffer }

function parseHash(stored: string): ParsedHash | null {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null
  const [N, r, p] = parts.slice(1, 4).map(Number)
  if (![N, r, p].every(n => Number.isInteger(n) && n > 0)) return null
  // refuse absurd parameters from a tampered row (memory = 128 * N * r bytes)
  if (N > 2 ** 20 || r > 32 || p > 16 || 128 * N * r > MAXMEM) return null
  const salt = Buffer.from(parts[4], 'base64')
  const key = Buffer.from(parts[5], 'base64')
  if (salt.length < 8 || key.length < 16) return null
  return { N, r, p, salt, key }
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const h = parseHash(stored)
  if (!h || typeof password !== 'string' || password.length > MAX_PASSWORD_LENGTH) return false
  const key = await scrypt(password, h.salt, h.key.length, { N: h.N, r: h.r, p: h.p, maxmem: MAXMEM })
  return key.length === h.key.length && timingSafeEqual(key, h.key)
}

/** true when the stored hash uses weaker/other parameters than the current ones (rehash on login). */
export function needsRehash(stored: string): boolean {
  const h = parseHash(stored)
  return !h || h.N !== PARAMS.N || h.r !== PARAMS.r || h.p !== PARAMS.p || h.key.length !== KEY_LEN
}

let dummyHash: Promise<string> | null = null

/**
 * Spend the same time as a real verification when the account does not exist, so response
 * timing does not reveal which e-mail addresses are registered.
 */
export async function burnVerification(password: string): Promise<false> {
  dummyHash ??= hashPassword('folio-dummy-password')
  await verifyPassword(typeof password === 'string' ? password : '', await dummyHash)
  return false
}
