/**
 * Periodic housekeeping (maintenance.ts): the hourly run purges expired sessions, runs the compile
 * service's sweep and removes stale temp files; the minute timer closes sockets of ended sessions.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WS_CLOSE } from '@folio/shared/protocol'
import { createSession } from '../../src/auth/sessions.ts'
import { cleanTmpDir, startMaintenance } from '../../src/maintenance.ts'
import { createTestServices, type TestContext } from './fakes.ts'
import { makeUser } from './helpers.ts'

describe('maintenance', () => {
  let t: TestContext
  beforeAll(async () => {
    t = await createTestServices()
  })
  afterAll(async () => {
    await t.cleanup()
  })

  it('hourly: purges expired sessions, sweeps compile outputs, removes stale temp files', async () => {
    const u = await makeUser(t.services, 'm@example.com')
    const live = createSession(t.services.db, t.services.config, u.id).tokenHash
    const old = createSession(t.services.db, t.services.config, u.id).tokenHash
    t.services.db.raw.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(Date.now() - 1, old)
    let sweeps = 0
    ;(t.services.compile as unknown as { sweep: () => Promise<void> }).sweep = async () => { sweeps++ }
    const tmp = t.services.config.dirs.tmp
    fs.writeFileSync(path.join(tmp, 'upload-stale'), 'x')
    fs.mkdirSync(path.join(tmp, 'import-stale'))
    fs.writeFileSync(path.join(tmp, 'upload-fresh'), 'x')
    const past = new Date(Date.now() - 7 * 60 * 60 * 1000)
    fs.utimesSync(path.join(tmp, 'upload-stale'), past, past)
    fs.utimesSync(path.join(tmp, 'import-stale'), past, past)

    const m = startMaintenance(t.services, { firstHourlyDelayMs: 60_000, hourlyMs: 60_000, sessionSweepMs: 60_000 })
    try {
      await m.runHourly()
    } finally {
      m.stop()
    }
    expect(sweeps).toBe(1)
    const rows = (t.services.db.raw.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[]).map(r => r.token_hash)
    expect(rows).toContain(live)
    expect(rows).not.toContain(old)
    expect(fs.readdirSync(tmp).sort()).toEqual(['upload-fresh'])
    expect(await cleanTmpDir(path.join(tmp, 'missing'), 0)).toBe(0)
  })

  it('the session timer closes sockets of ended sessions', async () => {
    const u = await makeUser(t.services, 'n@example.com')
    const gone = createSession(t.services.db, t.services.config, u.id).tokenHash
    t.services.db.sessions.delete(gone)
    t.collab.liveSessions = [gone]
    t.collab.sessionCloses.length = 0
    const m = startMaintenance(t.services, { sessionSweepMs: 20, firstHourlyDelayMs: 60_000 })
    try {
      await new Promise(r => setTimeout(r, 120))
    } finally {
      m.stop()
    }
    expect(t.collab.sessionCloses[0]).toEqual({ tokenHashes: [gone], code: WS_CLOSE.UNAUTHORIZED })
  })
})
