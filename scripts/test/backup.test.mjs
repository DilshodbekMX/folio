/**
 * README → "Data and backups": the documented commands, run as printed, restore a working Folio —
 * `npm run backup` (scripts/backup.mjs) and the manual tar / sqlite3 steps.
 *
 * A server gets an account, a project and chat messages. An online backup is taken while it runs
 * (when the sqlite3 CLI is installed), more is written, then the server is killed with SIGKILL so
 * committed rows exist only in db.sqlite-wal (the case ACC-6 lost). The offline backup is taken
 * from that directory. Each backup is restored with the README's steps into a data directory that
 * still holds the crashed state (stale WAL included) and checked: integrity, rows, history, and a
 * server that starts on it with exactly the backed-up data.
 *
 * The commands are read from README.md, so changing them there without keeping them working fails
 * here.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { ROOT, dummyWebDist, freePort, hasCommand, removeTempDirs, session, sh, startServer, tempDir } from './helpers.mjs'

const README = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')

/** the text of a README section, from its heading to the next heading of the same or a higher level */
function section(heading) {
  const start = README.indexOf(`\n${heading}\n`)
  if (start < 0) throw new Error(`README.md has no "${heading}" section`)
  const level = heading.match(/^#+/)[0].length
  const rest = README.slice(start + heading.length + 2)
  const next = rest.search(new RegExp(`\\n#{1,${level}} `))
  return next < 0 ? rest : rest.slice(0, next)
}

function find(text, re, what) {
  const m = re.exec(text)
  if (!m) throw new Error(`README.md: cannot find ${what} (${re})`)
  return m[1]
}

const backingUp = section('### Backing up')
const restoring = section('### Restoring')
const codeSpans = [...restoring.matchAll(/`([^`]+)`/g)].map(m => m[1])
const span = (test, what) => {
  const s = codeSpans.find(test)
  if (!s) throw new Error(`README.md → Restoring: cannot find ${what}`)
  return s
}
const DOC = {
  // cd /path/to/data && tar czf ~/folio-$(date +%F).tgz db.sqlite* projects history ystate
  offline: find(backingUp, /^(cd \/path\/to\/data && tar czf .*)$/m, 'the offline backup command'),
  // sqlite3 data/db.sqlite ".backup data/db.backup.sqlite"   +   tar czf … -C data db.backup.sqlite …
  onlineDb: find(backingUp, /^(sqlite3 data\/db\.sqlite .*\.backup.*)$/m, 'the online database backup'),
  onlineTar: find(backingUp, /^(tar czf .* -C data db\.backup\.sqlite .*)$/m, 'the online backup archive'),
  moveAside: span(s => /^mv data data[.-]/.test(s), 'the "move the current data aside" step'),
  extract: span(s => s.includes('tar xzf'), 'the extract step'),
  rename: span(s => s.startsWith('mv data/db.backup.sqlite'), 'the rename step'),
  integrity: span(s => s.startsWith('sqlite3 data/db.sqlite') && s.includes('integrity_check'), 'the integrity check'),
}

/** a README command with the example archive (`~/folio-$(date +%F).tgz`) and data paths replaced */
function cmd(line, { archive, dataDir }) {
  const out = line
    .replace(/~\/folio-(?:\$\([^)]*\)|[^\s"'`$])*\.tgz/g, JSON.stringify(archive))
    .replace(/\/path\/to\/data/g, JSON.stringify(dataDir ?? '/nonexistent'))
  // never let a README command write into the real home directory
  if (out.includes('~')) throw new Error(`README command still refers to ~ after substitution: ${out}`)
  return out
}

describe('README backup and restore', () => {
  const EMAIL = 'admin@example.com'
  let parent, dataDir, webDist, crashed
  const expected = {}

  beforeAll(async () => {
    parent = tempDir('backup')
    dataDir = path.join(parent, 'data')
    webDist = dummyWebDist()
    const server = await startServer({ dataDir, port: await freePort(), webDist })
    const { api } = await session(server.base, { email: EMAIL, name: 'Admin', setup: true })
    const { id } = await api('POST', '/api/projects', { name: 'Backed up', template: 'example' })
    await api('POST', `/api/projects/${id}/chat`, { content: 'before the online backup' })
    expected.projectId = id
    expected.versions = (await api('GET', `/api/projects/${id}/history/versions`)).versions.length

    if (hasCommand('sqlite3')) {
      expected.onlineArchive = path.join(parent, 'online.tgz')
      sh(cmd(DOC.onlineDb, {}), parent)
      sh(cmd(DOC.onlineTar, { archive: expected.onlineArchive }), parent)
      fs.rmSync(path.join(dataDir, 'db.backup.sqlite'))
    }

    // written after the online backup: the offline backup has it, the online one must not
    const late = await api('POST', '/api/projects', { name: 'Created after the online backup', template: 'blank' })
    await api('POST', `/api/projects/${id}/chat`, { content: 'after the online backup' })
    expected.lateProjectId = late.id

    await server.kill()
    const wal = path.join(dataDir, 'db.sqlite-wal')
    // the premise of this test: after a crash, committed rows live only in the WAL
    expect(fs.existsSync(wal) && fs.statSync(wal).size > 0, 'a SIGKILLed server leaves a non-empty db.sqlite-wal').toBe(true)
    crashed = path.join(parent, 'crashed')
    fs.cpSync(dataDir, crashed, { recursive: true })

    expected.offlineArchive = path.join(parent, 'offline.tgz')
    sh(cmd(DOC.offline, { archive: expected.offlineArchive, dataDir }), parent)
  })

  afterAll(() => removeTempDirs())

  /**
   * follow README → Restoring in a fresh directory whose data/ still holds the crashed state (its
   * stale db.sqlite-wal included): the extract step fails unless the old data was moved aside
   */
  function restore(archive, { online }) {
    const where = tempDir('restore')
    fs.cpSync(crashed, path.join(where, 'data'), { recursive: true })
    sh(cmd(DOC.moveAside, { archive }), where)
    sh(cmd(DOC.extract, { archive }), where)
    if (online) sh(DOC.rename, where)
    const restored = path.join(where, 'data')
    expect(fs.existsSync(path.join(restored, 'db.sqlite'))).toBe(true)
    if (hasCommand('sqlite3')) expect(sh(DOC.integrity, where).trim()).toBe('ok')
    const db = new Database(path.join(restored, 'db.sqlite'))
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally {
      db.close()
    }
    return restored
  }

  async function check(restored, { late }) {
    const server = await startServer({ dataDir: restored, port: await freePort(), webDist })
    try {
      const { api } = await session(server.base, { email: EMAIL })
      const projects = (await api('GET', '/api/projects')).map(p => p.id)
      expect(projects).toContain(expected.projectId)
      expect(projects.includes(expected.lateProjectId)).toBe(late)
      const chat = (await api('GET', `/api/projects/${expected.projectId}/chat`)).messages.map(m => m.content)
      expect(chat).toEqual(late ? ['before the online backup', 'after the online backup'] : ['before the online backup'])
      const versions = (await api('GET', `/api/projects/${expected.projectId}/history/versions`)).versions
      expect(versions.length).toBeGreaterThanOrEqual(expected.versions)
      const { files } = await api('GET', `/api/projects/${expected.projectId}`)
      expect(files.map(f => f.path)).toContain('main.tex')
    } finally {
      const { code } = await server.stop()
      expect(code).toBe(0)
    }
  }

  it('the offline backup (db.sqlite*) keeps what was only in the WAL after a crash', async () => {
    const tar = sh(`tar tzf ${JSON.stringify(expected.offlineArchive)}`, parent).split('\n')
    expect(tar).toContain('db.sqlite-wal')
    await check(restore(expected.offlineArchive, { online: false }), { late: true })
  })

  it.skipIf(!hasCommand('sqlite3'))('the online backup restores the state at backup time, not the crashed one', async () => {
    await check(restore(expected.onlineArchive, { online: true }), { late: false })
  })
})

/**
 * `npm run backup` (scripts/backup.mjs): the command from package.json, run against a server
 * that keeps writing, then restored with the README's steps into a directory that still holds
 * an older state. The archive must hold the data as of the backup, not what was written after
 * it, and a server must start on the restored directory with exactly that data.
 */
describe('npm run backup', () => {
  const EMAIL = 'admin@example.com'
  const BACKUP = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.backup
  let parent, dataDir, webDist, server, api
  const expected = {}

  beforeAll(async () => {
    expect(BACKUP, 'package.json has a "backup" script').toBeTruthy()
    parent = tempDir('npm-backup')
    dataDir = path.join(parent, 'data')
    webDist = dummyWebDist()
    server = await startServer({ dataDir, port: await freePort(), webDist })
    api = (await session(server.base, { email: EMAIL, name: 'Admin', setup: true })).api
    const { id } = await api('POST', '/api/projects', { name: 'Backed up live', template: 'example' })
    await api('POST', `/api/projects/${id}/chat`, { content: 'before the backup' })
    expected.projectId = id
  })

  afterAll(async () => {
    if (server) await server.stop()
    removeTempDirs()
  })

  /** run the documented command with extra arguments, from the app root */
  const backup = args => sh(`${BACKUP} ${args}`, ROOT)

  it('backs up a running server, and the restored copy holds the data as of the backup', async () => {
    const archive = path.join(parent, 'live.tgz')
    const out = backup(`--data ${JSON.stringify(dataDir)} --out ${JSON.stringify(archive)}`)
    expect(out).toContain('db.sqlite')
    expect(fs.existsSync(archive)).toBe(true)

    // written after the backup: the restored copy must not have it
    const late = await api('POST', '/api/projects', { name: 'Created after the backup', template: 'blank' })
    await api('POST', `/api/projects/${expected.projectId}/chat`, { content: 'after the backup' })

    const entries = sh(`tar tzf ${JSON.stringify(archive)}`, parent).split('\n')
    expect(entries).toContain('db.sqlite')
    // a copy made with SQLite's backup API needs no journal of its own
    expect(entries.some(e => e.startsWith('db.sqlite-'))).toBe(false)
    for (const dir of ['projects/', 'history/', 'ystate/']) expect(entries).toContain(dir)

    // the README's restore steps, in a directory that still holds an older data directory
    const where = tempDir('npm-restore')
    fs.cpSync(dataDir, path.join(where, 'data'), { recursive: true })
    sh(cmd(DOC.moveAside, { archive }), where)
    sh(cmd(DOC.extract, { archive }), where)
    const restored = path.join(where, 'data')
    if (hasCommand('sqlite3')) expect(sh(DOC.integrity, where).trim()).toBe('ok')

    const copy = await startServer({ dataDir: restored, port: await freePort(), webDist })
    try {
      const { api: restoredApi } = await session(copy.base, { email: EMAIL })
      const projects = (await restoredApi('GET', '/api/projects')).map(p => p.id)
      expect(projects).toContain(expected.projectId)
      expect(projects).not.toContain(late.id)
      const chat = (await restoredApi('GET', `/api/projects/${expected.projectId}/chat`)).messages.map(m => m.content)
      expect(chat).toEqual(['before the backup'])
      const { files } = await restoredApi('GET', `/api/projects/${expected.projectId}`)
      expect(files.map(f => f.path)).toContain('main.tex')
      expect((await restoredApi('GET', `/api/projects/${expected.projectId}/history/versions`)).versions.length).toBeGreaterThan(0)
    } finally {
      const { code } = await copy.stop()
      expect(code).toBe(0)
    }
  })

  it('--out <directory> writes a data directory a server starts on', async () => {
    const dir = path.join(parent, 'as-directory')
    const out = backup(`--data ${JSON.stringify(dataDir)} --out ${JSON.stringify(dir)}`)
    expect(out).toContain(dir)
    for (const name of ['db.sqlite', 'projects', 'history', 'ystate']) {
      expect(fs.existsSync(path.join(dir, name)), `${name} is in the backup directory`).toBe(true)
    }
    expect(fs.existsSync(path.join(dir, 'db.sqlite-wal'))).toBe(false)
    const db = new Database(path.join(dir, 'db.sqlite'), { readonly: true })
    try {
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok')
    } finally {
      db.close()
    }
    const copy = await startServer({ dataDir: dir, port: await freePort(), webDist })
    try {
      const { api: restoredApi } = await session(copy.base, { email: EMAIL })
      expect((await restoredApi('GET', '/api/projects')).map(p => p.id)).toContain(expected.projectId)
    } finally {
      const { code } = await copy.stop()
      expect(code).toBe(0)
    }
  })

  it('refuses to overwrite a backup, or to write inside the data directory', () => {
    const archive = path.join(parent, 'live.tgz')
    expect(() => backup(`--data ${JSON.stringify(dataDir)} --out ${JSON.stringify(archive)}`)).toThrow(/already exists/)
    backup(`--data ${JSON.stringify(dataDir)} --out ${JSON.stringify(archive)} --force`)
    expect(() => backup(`--data ${JSON.stringify(dataDir)} --out ${JSON.stringify(path.join(dataDir, 'inside.tgz'))}`))
      .toThrow(/inside the data directory/)
  })
})
