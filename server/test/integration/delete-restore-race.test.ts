/**
 * "Delete forever" racing a history restore of the same project (REG-2): the restore holds the
 * history lock while it writes files through FileService (project lock); the delete used to hold
 * the project lock while it waited for the history lock — both requests hung, and every later
 * file operation of the project waited on the stuck lock. Both must settle, whatever the gap.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { HistoryListResponse } from '@folio/shared/api'
import type { UserRecord } from '../../src/db/index.ts'
import { Client } from '../foundation/helpers.ts'
import { startFullServer, type FullServer } from './harness.ts'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('project delete racing a history restore', () => {
  let t: FullServer
  let alice: UserRecord
  let A: Client

  beforeAll(async () => {
    t = await startFullServer()
    alice = await t.makeUser('alice@example.com', 'Alice Admin')
    A = Client.as(t, alice)
  })
  afterAll(async () => {
    await t.close()
  })

  /** A project whose restore to its first version removes 30 files (30 project-lock round trips). */
  async function projectWithManyLaterFiles(name: string): Promise<{ pid: string; v1: string }> {
    const r = await A.post('/api/projects', { name, template: 'example' })
    expect(r.status).toBe(201)
    const pid = r.body.id as string
    const v1 = (await A.get<HistoryListResponse>(`/api/projects/${pid}/history/versions`)).body.versions[0].id
    for (let i = 0; i < 30; i++) {
      expect((await A.post(`/api/projects/${pid}/files`, { path: `extra/f${i}.tex`, kind: 'text', content: `file ${i}\n` })).status).toBe(201)
    }
    return { pid, v1 }
  }

  for (const gap of [0, 15, 40]) {
    it(`both requests answer (gap ${gap} ms) and the project is gone`, async () => {
      const { pid, v1 } = await projectWithManyLaterFiles(`Race ${gap}`)
      const restore = A.post(`/api/projects/${pid}/history/restore`, { versionId: v1 })
      await sleep(gap)
      const del = A.del(`/api/projects/${pid}`)
      const done = await Promise.race([Promise.all([restore, del]), sleep(15_000).then(() => 'timeout' as const)])
      expect(done).not.toBe('timeout')
      const [rs, ds] = done as Awaited<typeof restore>[]
      expect(ds.status).toBe(204)
      // the restore either finished first or stopped because the project was being deleted
      expect([200, 404]).toContain(rs.status)
      expect((await A.get(`/api/projects/${pid}`)).status).toBe(404)
      // nothing is left waiting on the project's locks
      const later = await Promise.race([A.post(`/api/projects/${pid}/files`, { path: 'x.tex', kind: 'text' }), sleep(5000).then(() => null)])
      expect(later?.status).toBe(404)
      expect(t.services.db.projects.get(pid)).toBeNull()
    })
  }
})
