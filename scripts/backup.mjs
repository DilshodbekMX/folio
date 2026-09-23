#!/usr/bin/env node
/**
 * npm run backup — one consistent backup of the data directory, with no external tools
 * (no sqlite3, no tar): SQLite's own online backup for the database, and a gzip-compressed tar
 * written here for `projects/`, `history/` and `ystate/`.
 *
 *   npm run backup                          → ./folio-backup-<date>.tgz
 *   npm run backup -- --out /backups/tonight.tgz
 *   npm run backup -- --out /backups/tonight        (a directory instead of an archive)
 *   node scripts/backup.mjs --data /srv/folio/data --out /backups
 *
 * Safe while Folio is running: the database copy is made with SQLite's backup API (a consistent
 * snapshot, WAL included, no `-wal` file of its own) and the directories are streamed file by
 * file. Documents open in the editor are on disk within 10 seconds of the last keystroke.
 *
 * What it writes is a data directory, so restoring is "extract and start" — the same steps as
 * the README's manual backup, printed again when the backup is done.
 *
 * Reads the same settings as the server: the environment, then `.env` next to package.json (or
 * FOLIO_ENV_FILE; `none` reads no file).
 */
import { once } from 'node:events'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import Database from 'better-sqlite3'

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
/** the directories of the data directory that hold the projects themselves */
const DIRS = ['projects', 'history', 'ystate']
const USAGE = `Usage: npm run backup -- [--data <dir>] [--out <path>] [--force] [--quiet]

  --data <dir>   data directory to back up (default: DATA_DIR from the environment
                 or .env, otherwise ./data)
  --out <path>   .tgz / .tar.gz → write that archive
                 any other path → write a backup directory there
                 (default: ./folio-backup-<date>.tgz)
  --force        overwrite an existing archive, or write into a non-empty directory
  --quiet        only print the path of the backup`

// -- the env file, resolved like server/src/env.ts (variables already set in the environment win)
const envFileSetting = process.env.FOLIO_ENV_FILE?.trim()
if (envFileSetting !== 'none') {
  const envFile = envFileSetting ? path.resolve(envFileSetting) : path.join(ROOT, '.env')
  if (fs.existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile)
    } catch (err) {
      fail(`Could not read ${envFile}: ${err.message}`)
    }
  }
}

function fail(message) {
  console.error(`Backup failed: ${message}`)
  process.exit(1)
}

function parse(argv) {
  const o = { force: false, quiet: false }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--data') o.data = argv[++i]
    else if (a === '--out') o.out = argv[++i]
    else if (a === '--force') o.force = true
    else if (a === '--quiet') o.quiet = true
    else if (a === '--help' || a === '-h') {
      console.log(USAGE)
      process.exit(0)
    } else fail(`unknown option ${a}\n\n${USAGE}`)
  }
  if (o.data === undefined && argv.includes('--data')) fail('--data needs a directory')
  if (o.out === undefined && argv.includes('--out')) fail('--out needs a path')
  return o
}

const opts = parse(process.argv.slice(2))
const log = (...args) => {
  if (!opts.quiet) console.log(...args)
}

// -- what to back up, and where ------------------------------------------------------------------

const dataDir = path.resolve(opts.data ?? process.env.DATA_DIR ?? path.join(ROOT, 'data'))
const dbFile = path.join(dataDir, 'db.sqlite')
if (!fs.existsSync(dbFile)) {
  fail(`${dbFile} does not exist.\nPoint at the right directory with --data, or set DATA_DIR (see the README → Configuration).`)
}

const isArchivePath = p => /\.(tgz|tar\.gz)$/i.test(p)
const stamp = new Date().toISOString().slice(0, 16).replace('T', '-').replace(':', '')
const target = path.resolve(opts.out ?? `folio-backup-${stamp}.tgz`)
const asArchive = opts.out === undefined || isArchivePath(target)

// a backup inside the data directory would end up inside the next backup (and inside a restore)
const inside = path.relative(dataDir, target)
if (inside === '' || (!inside.startsWith('..') && !path.isAbsolute(inside))) {
  fail(`${target} is inside the data directory. Write the backup somewhere else.`)
}
if (asArchive) {
  if (fs.existsSync(target) && !opts.force) fail(`${target} already exists (use --force to overwrite it).`)
  if (!fs.existsSync(path.dirname(target))) fail(`${path.dirname(target)} does not exist.`)
} else if (fs.existsSync(target)) {
  if (!fs.statSync(target).isDirectory()) fail(`${target} exists and is not a directory.`)
  if (fs.readdirSync(target).length > 0 && !opts.force) fail(`${target} is not empty (use --force to write into it).`)
}

// -- tar (ustar, PAX for long paths) --------------------------------------------------------------

const BLOCK = 512
const PAD = Buffer.alloc(BLOCK)

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0').slice(-(length - 1)) + '\0'
}

/** A ustar header block. `name` must already fit (see nameFields). */
function header({ name, prefix = '', size = 0, mode = 0o644, mtime = 0, type = '0', linkname = '' }) {
  const buf = Buffer.alloc(BLOCK)
  buf.write(name, 0, 100, 'utf8')
  buf.write(octal(mode & 0o7777, 8), 100, 8, 'ascii')
  buf.write(octal(0, 8), 108, 8, 'ascii')
  buf.write(octal(0, 8), 116, 8, 'ascii')
  buf.write(octal(size, 12), 124, 12, 'ascii')
  buf.write(octal(Math.max(0, Math.floor(mtime)), 12), 136, 12, 'ascii')
  buf.write('        ', 148, 8, 'ascii') // checksum placeholder
  buf.write(type, 156, 1, 'ascii')
  buf.write(linkname, 157, 100, 'utf8')
  buf.write('ustar\0', 257, 6, 'ascii')
  buf.write('00', 263, 2, 'ascii')
  buf.write('folio', 265, 32, 'ascii')
  buf.write('folio', 297, 32, 'ascii')
  buf.write(prefix, 345, 155, 'utf8')
  let sum = 0
  for (const b of buf) sum += b
  buf.write(octal(sum, 7), 148, 7, 'ascii') // 6 octal digits + NUL …
  buf.write(' ', 155, 1, 'ascii') // … + a space
  return buf
}

/** Split a path over ustar's name (100 B) and prefix (155 B) fields; null when it does not fit. */
function nameFields(name) {
  if (Buffer.byteLength(name) <= 100) return { name, prefix: '' }
  for (let i = name.indexOf('/'); i >= 0 && i < name.length - 1; i = name.indexOf('/', i + 1)) {
    const prefix = name.slice(0, i)
    const rest = name.slice(i + 1)
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(rest) <= 100) return { name: rest, prefix }
  }
  return null
}

/** Cut `s` to at most `max` bytes without splitting a UTF-8 character. */
function truncUtf8(s, max) {
  const b = Buffer.from(s, 'utf8')
  if (b.length <= max) return s
  let end = max
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--
  return b.subarray(0, end).toString('utf8')
}

/** A PAX record: "<total length> key=value\n", the length counting its own digits. */
function paxRecord(key, value) {
  const payload = ` ${key}=${value}\n`
  let len = Buffer.byteLength(payload) + 1
  for (;;) {
    const total = String(len).length + Buffer.byteLength(payload)
    if (total === len) break
    len = total
  }
  return Buffer.concat([Buffer.from(String(len)), Buffer.from(payload)])
}

class Tar {
  constructor(sink) {
    this.sink = sink
  }

  async write(buf) {
    if (!this.sink.write(buf)) await once(this.sink, 'drain')
  }

  async pad(size) {
    const rest = size % BLOCK
    if (rest !== 0) await this.write(PAD.subarray(0, BLOCK - rest))
  }

  /** `entry` without `size` for anything but a regular file. */
  async entry(name, entry) {
    if ((entry.size ?? 0) > 0o77777777777) throw new Error(`${name} is too large for a tar archive`)
    const fields = nameFields(name)
    if (fields) {
      await this.write(header({ ...entry, ...fields }))
      return
    }
    // too long for ustar's fields: a PAX extended header carries the real path, and the entry
    // that follows keeps a truncated one for anything that cannot read the record
    const body = paxRecord('path', name)
    const short = `PaxHeader/${truncUtf8(path.basename(name), 80) || 'long-path'}`
    await this.write(header({ name: short, size: body.length, type: 'x', mtime: entry.mtime ?? 0 }))
    await this.write(body)
    await this.pad(body.length)
    await this.write(header({ ...entry, name: truncUtf8(path.basename(name), 100) || 'long-path', prefix: '' }))
  }

  async directory(name, stat) {
    await this.entry(`${name}/`, { type: '5', mode: stat.mode, mtime: stat.mtimeMs / 1000 })
  }

  async symlink(name, stat, linkname) {
    await this.entry(name, { type: '2', mode: stat.mode, mtime: stat.mtimeMs / 1000, linkname })
  }

  /**
   * One regular file, exactly `stat.size` bytes (a file the running server grows or truncates
   * while it is read is padded / cut to the size its header announces).
   */
  async file(name, stat, handle) {
    await this.entry(name, { type: '0', size: stat.size, mode: stat.mode, mtime: stat.mtimeMs / 1000 })
    let written = 0
    for await (const chunk of handle.createReadStream({ autoClose: false, start: 0 })) {
      if (written >= stat.size) break
      const take = chunk.subarray(0, Math.min(chunk.length, stat.size - written))
      await this.write(take)
      written += take.length
    }
    while (written < stat.size) {
      const chunk = PAD.subarray(0, Math.min(BLOCK, stat.size - written))
      await this.write(chunk)
      written += chunk.length
    }
    await this.pad(stat.size)
  }

  /** Two zero blocks: the end of the archive. */
  async end() {
    await this.write(PAD)
    await this.write(PAD)
  }
}

// -- walking the data directory --------------------------------------------------------------------

const totals = { files: 0, bytes: 0, dirs: 0, symlinks: 0 }
const warnings = []

/** Every entry of `dir`, depth first, reported as `visit(relative path, stats)`. */
async function walk(dir, rel, visit) {
  let entries
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true })
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    const full = path.join(dir, e.name)
    const name = `${rel}/${e.name}`
    if (e.isDirectory()) {
      await visit('dir', name, full)
      await walk(full, name, visit)
    } else if (e.isSymbolicLink()) {
      await visit('symlink', name, full)
    } else if (e.isFile()) {
      await visit('file', name, full)
    } else {
      warnings.push(`skipped ${name} (not a file, directory or symlink)`)
    }
  }
}

async function addDir(tar, name) {
  const src = path.join(dataDir, name)
  if (!fs.existsSync(src)) {
    warnings.push(`${name}/ does not exist in ${dataDir} — nothing to back up from it`)
    return
  }
  await tar.directory(name, await fsp.stat(src))
  totals.dirs++
  await walk(src, name, async (kind, rel, full) => {
    const stat = await fsp.lstat(full).catch(() => null)
    if (!stat) return // vanished while we walked (a compile or a delete): nothing to store
    if (kind === 'dir') {
      await tar.directory(rel, stat)
      totals.dirs++
    } else if (kind === 'symlink') {
      await tar.symlink(rel, stat, await fsp.readlink(full))
      totals.symlinks++
    } else {
      let handle
      try {
        handle = await fsp.open(full, 'r')
      } catch (err) {
        if (err.code === 'ENOENT') return
        throw err
      }
      try {
        const st = await handle.stat()
        await tar.file(rel, st, handle)
        totals.files++
        totals.bytes += st.size
      } finally {
        await handle.close()
      }
    }
  })
}

/** The same walk into a directory instead of an archive (files that vanish meanwhile are skipped). */
async function copyDir(name, dest) {
  const src = path.join(dataDir, name)
  if (!fs.existsSync(src)) {
    warnings.push(`${name}/ does not exist in ${dataDir} — nothing to back up from it`)
    return
  }
  await fsp.mkdir(path.join(dest, name), { recursive: true })
  totals.dirs++
  await walk(src, name, async (kind, rel, full) => {
    const to = path.join(dest, rel)
    try {
      if (kind === 'dir') {
        await fsp.mkdir(to, { recursive: true })
        totals.dirs++
      } else if (kind === 'symlink') {
        await fsp.symlink(await fsp.readlink(full), to)
        totals.symlinks++
      } else {
        await fsp.copyFile(full, to)
        totals.files++
        totals.bytes += (await fsp.stat(to)).size
      }
    } catch (err) {
      if (err.code !== 'ENOENT') throw err // vanished while we walked (a delete, a rename)
    }
  })
}

// -- the database ------------------------------------------------------------------------------------

/**
 * SQLite's online backup: a consistent copy, whatever the server is doing meanwhile. The copy is
 * checkpointed (everything in one file, no journal to carry along or to replay on a restore) and
 * checked before it is handed on.
 */
async function backupDatabase(dest) {
  const db = new Database(dbFile, { readonly: true, fileMustExist: true })
  try {
    await db.backup(dest)
  } finally {
    db.close()
  }
  const copy = new Database(dest, { fileMustExist: true })
  let result
  try {
    copy.pragma('wal_checkpoint(TRUNCATE)')
    const check = copy.pragma('quick_check', { simple: true })
    if (check !== 'ok') throw new Error(`the database copy failed its check: ${check}`)
    const count = table => {
      try {
        return copy.prepare(`SELECT count(*) AS n FROM ${table}`).get().n
      } catch {
        return null
      }
    }
    result = { users: count('users'), projects: count('projects'), bytes: fs.statSync(dest).size }
  } finally {
    copy.close()
  }
  // closing the last connection removes them; make sure a restore never finds a journal here
  for (const suffix of ['-wal', '-shm']) await fsp.rm(`${dest}${suffix}`, { force: true })
  return result
}

// -- run ---------------------------------------------------------------------------------------------

function human(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`
  return `${bytes} B`
}

const started = Date.now()
log(`Backing up ${dataDir}`)
let db
let written

if (asArchive) {
  const partial = `${target}.part`
  const tmpDir = await fsp.mkdtemp(path.join(path.dirname(target), '.folio-backup-'))
  try {
    db = await backupDatabase(path.join(tmpDir, 'db.sqlite'))
    log(`  db.sqlite   ${human(db.bytes)}${db.projects === null ? '' : `, ${db.projects} projects, ${db.users} users`} (checked)`)
    const gzip = zlib.createGzip({ level: 6 })
    const out = fs.createWriteStream(partial)
    const done = pipeline(gzip, out)
    const tar = new Tar(gzip)
    const handle = await fsp.open(path.join(tmpDir, 'db.sqlite'), 'r')
    try {
      await tar.file('db.sqlite', await handle.stat(), handle)
    } finally {
      await handle.close()
    }
    totals.files++
    totals.bytes += db.bytes
    for (const name of DIRS) {
      const before = totals.files
      await addDir(tar, name)
      log(`  ${name.padEnd(11)} ${totals.files - before} files`)
    }
    await tar.end()
    gzip.end()
    await done
    await fsp.rename(partial, target)
    written = fs.statSync(target).size
  } catch (err) {
    await fsp.rm(partial, { force: true })
    throw err
  } finally {
    await fsp.rm(tmpDir, { recursive: true, force: true })
  }
} else {
  await fsp.mkdir(target, { recursive: true })
  db = await backupDatabase(path.join(target, 'db.sqlite'))
  log(`  db.sqlite   ${human(db.bytes)}${db.projects === null ? '' : `, ${db.projects} projects, ${db.users} users`} (checked)`)
  totals.files++
  totals.bytes += db.bytes
  for (const name of DIRS) {
    const before = totals.files
    await copyDir(name, target)
    log(`  ${name.padEnd(11)} ${totals.files - before} files`)
  }
  written = totals.bytes
}

const seconds = ((Date.now() - started) / 1000).toFixed(1)
for (const w of warnings) log(`  note: ${w}`)
if (opts.quiet) {
  console.log(target)
} else {
  const what = asArchive ? `${human(written)} archive` : `backup directory (${human(written)})`
  console.log(`\n✓ ${target}\n  ${what} — ${totals.files} files, ${human(totals.bytes)} of data, in ${seconds}s`)
  console.log(`  db.sqlite + ${DIRS.join('/, ')}/ — everything Folio cannot recreate.`)
  console.log('  Caches (builds/, compiles/, texcache/, previews/) are left out; Folio rebuilds them.')
  console.log('\nTo restore it, with Folio stopped:')
  console.log('  mv data data.before-restore-$(date +%F)')
  if (asArchive) console.log(`  mkdir data && tar xzf ${JSON.stringify(target)} -C data`)
  else console.log(`  cp -a ${JSON.stringify(target)} data`)
  console.log('  …then start Folio again. See the README → Data and backups.')
}
