import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import * as encoding from 'lib0/encoding'
import * as decoding from 'lib0/decoding'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { DOC_TEXT_KEY, MAX_DOC_LENGTH, MSG_BARRIER, MSG_SYNC, WS_CLOSE } from '@folio/shared/protocol'
import { countOccurrences, docClient, makeEnv, rawSocket, sleep, waitFor, type Env } from './helpers.ts'

const MAIN = '\\documentclass{article}\n\\begin{document}\nHello world.\n\\end{document}\n'

let env: Env

beforeEach(async () => {
  env = await makeEnv({ withMeta: false })
})

afterEach(async () => {
  await env.cleanup()
})

describe('doc rooms: sync', () => {
  it('two clients converge and the server copy follows', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const collab = env.startCollab()
    const a = docClient(env, f, env.users.alice)
    const b = docClient(env, f, env.users.bob)
    await a.synced()
    await b.synced()
    expect(a.text.toString()).toBe(MAIN)
    expect(b.text.toString()).toBe(MAIN)

    a.text.insert(MAIN.indexOf('world'), 'big ')
    await waitFor(() => b.text.toString().includes('big world'), 5000, 'B sees A')
    b.text.delete(0, '\\documentclass{article}\n'.length)
    b.text.insert(b.text.length, '% end\n')
    await waitFor(() => a.text.toString() === b.text.toString(), 5000, 'convergence')
    await b.barrier()
    await a.barrier()
    const expected = MAIN.replace('world', 'big world').slice('\\documentclass{article}\n'.length) + '% end\n'
    expect(a.text.toString()).toBe(expected)
    expect(await collab.getText(env.projectId, f.id)).toBe(expected)

    await collab.flushProject(env.projectId)
    expect(await env.readDisk('main.tex')).toBe(expected)
    expect(env.db.files.get(f.id)!.size).toBe(Buffer.byteLength(expected))
  })

  it('keeps a viewer in sync; a viewer\'s edit is never applied and closes its connection with 4403 (never confirmed)', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const collab = env.startCollab()
    const a = docClient(env, f, env.users.alice)
    const v = docClient(env, f, env.users.victor)
    await a.synced()
    await v.synced()

    a.text.insert(0, '% alice\n')
    await waitFor(() => v.text.toString().includes('% alice\n'), 5000, 'viewer receives edits')
    await v.barrier() // a viewer's ordinary connection answers barriers
    expect(v.closes).toEqual([])

    // an edit from a read-only connection: dropped, and the connection is told so (4403) instead
    // of being left to believe it was saved — the barrier behind it is never echoed
    v.text.insert(0, '% viewer edit\n')
    await expect(v.barrier(1000)).rejects.toThrow()
    await waitFor(() => v.closes.length > 0, 5000, 'viewer closed')
    expect(v.closes).toEqual([WS_CLOSE.FORBIDDEN])
    expect(v.provider.shouldConnect).toBe(false) // a permanent close: no silent reconnect
    await a.barrier()
    expect(await collab.getText(env.projectId, f.id)).toBe('% alice\n' + MAIN)
    expect(a.text.toString()).toBe('% alice\n' + MAIN)
    await collab.flushProject(env.projectId)
    expect(await env.readDisk('main.tex')).toBe('% alice\n' + MAIN)
    expect(env.noteActivity.every(n => n.userId !== env.users.victor.id)).toBe(true)
  })

  it('a viewer that reconnects with nothing new keeps its connection (its sync only repeats known deletions)', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const collab = env.startCollab()
    const a = docClient(env, f, env.users.alice)
    const v = docClient(env, f, env.users.victor)
    await a.synced()
    await v.synced()
    // deletions and inserts by the editor: the viewer's delete set is non-empty from now on
    a.text.delete(0, '\\documentclass{article}\n'.length)
    a.text.insert(0, '% header\n')
    a.text.delete(a.text.length - 5, 3)
    await a.barrier()
    await waitFor(() => v.text.toString() === a.text.toString(), 5000, 'viewer caught up')

    for (let round = 0; round < 3; round++) {
      v.provider.disconnect()
      await waitFor(() => !v.provider.wsconnected, 5000, 'viewer offline')
      // the doc moves on while the viewer is away (more deletions included)
      a.text.insert(a.text.length, `% round ${round}\n`)
      a.text.delete(0, 2)
      await a.barrier()
      v.provider.connect()
      await waitFor(() => v.provider.synced && v.text.toString() === a.text.toString(), 5000, 'viewer resynced')
      await v.barrier()
    }
    await sleep(200)
    expect(v.closes).toEqual([])
    expect(v.provider.wsconnected).toBe(true)
    expect(collab.stats().rooms[0].connections).toBe(2)
  })

  it('an editor made a viewer while offline: the offline edits are refused with 4403, never applied or confirmed', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const g = env.createTextFile('del.tex', 'delete only: ABCDEFGH\n')
    const collab = env.startCollab()
    const bf = docClient(env, f, env.users.bob)
    const bg = docClient(env, g, env.users.bob)
    await bf.synced()
    await bg.synced()
    bf.provider.disconnect()
    bg.provider.disconnect()
    await waitFor(() => !bf.provider.wsconnected && !bg.provider.wsconnected, 5000, 'bob offline')
    // offline: an insert in one file, a deletion only in the other
    bf.text.insert(bf.text.length, '% bob offline\n')
    bg.text.delete('delete only: '.length, 4)
    // meanwhile the owner makes bob a viewer (his sockets were down: nothing to close then)
    env.db.members.upsert(env.projectId, env.users.bob.id, 'viewer')
    bf.provider.connect()
    bg.provider.connect()
    await waitFor(() => bf.closes.length > 0 && bg.closes.length > 0, 5000, 'refused')
    expect(bf.closes).toEqual([WS_CLOSE.FORBIDDEN])
    expect(bg.closes).toEqual([WS_CLOSE.FORBIDDEN])
    expect(await collab.getText(env.projectId, f.id)).toBe(MAIN)
    expect(await collab.getText(env.projectId, g.id)).toBe('delete only: ABCDEFGH\n')
    expect(collab.editCount(env.projectId)).toBe(0)
    // the same user as a viewer with a fresh copy (what the web app does next) stays connected
    const fresh = docClient(env, f, env.users.bob)
    await fresh.synced()
    await fresh.barrier()
    expect(fresh.text.toString()).toBe(MAIN)
    expect(fresh.closes).toEqual([])
  })

  it('normalises CRLF and a BOM from disk and from setText', async () => {
    const f = env.createTextFile('crlf.tex', '\uFEFFline1\r\nline2\r\nline3\rline4\r\n')
    const collab = env.startCollab()
    const a = docClient(env, f, env.users.alice)
    await a.synced()
    expect(a.text.toString()).toBe('line1\nline2\nline3\nline4\n')
    await collab.setText(env.projectId, f.id, 'x\r\ny\r\n', { userId: env.users.bob.id, reason: 'upload' })
    await waitFor(() => a.text.toString() === 'x\ny\n', 5000, 'setText reaches client')
    expect(await env.readDisk('crlf.tex')).toBe('x\ny\n')
  })

  it('getText reads disk (normalised) when no room is open', async () => {
    const f = env.createTextFile('notes.txt', 'a\r\nb\r\n')
    const collab = env.startCollab()
    expect(await collab.getText(env.projectId, f.id)).toBe('a\nb\n')
    expect(collab.stats().rooms).toEqual([])
    const bin = env.createBinaryFile('fig.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await expect(collab.getText(env.projectId, bin.id)).rejects.toMatchObject({ status: 400 })
    await expect(collab.getText(env.projectId, 'nope')).rejects.toMatchObject({ status: 404 })
  })

  it('tolerates fast connect/disconnect/connect without reloading the room', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const collab = env.startCollab()
    const first = docClient(env, f, env.users.alice)
    first.destroy()
    const second = docClient(env, f, env.users.alice)
    await second.synced()
    second.text.insert(0, 'X')
    await second.barrier()
    expect(collab.stats().rooms).toHaveLength(1)
    expect(await collab.getText(env.projectId, f.id)).toBe('X' + MAIN)
  })
})

describe('doc rooms: persistence', () => {
  it('writes the file and the sidecar after the debounce', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    env.startCollab({ saveDebounceMs: 100, saveMaxWaitMs: 500 })
    const a = docClient(env, f, env.users.alice)
    await a.synced()
    a.text.insert(0, '% saved\n')
    await waitFor(async () => (await env.readDisk('main.tex')) === '% saved\n' + MAIN, 5000, 'debounced save')
    expect(fs.existsSync(env.sidecar(f.id))).toBe(true)
    // the sidecar holds the same document
    const bytes = fs.readFileSync(env.sidecar(f.id))
    expect(bytes.subarray(0, 8).toString('latin1')).toBe('FOLIOYS1')
    expect(env.db.files.get(f.id)!.size).toBe(Buffer.byteLength('% saved\n' + MAIN))
    expect(env.db.projects.get(env.projectId)!.lastUpdatedBy).toBe(env.users.alice.id)
    // no temp files left in the project directory
    expect(await fsp.readdir(path.dirname(env.abs('main.tex')))).toEqual(['main.tex'])
  })

  it('flushProject writes immediately, and saves follow renames', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const collab = env.startCollab({ saveDebounceMs: 60_000, saveMaxWaitMs: 60_000 })
    const a = docClient(env, f, env.users.alice)
    await a.synced()
    a.text.insert(0, 'A')
    await a.barrier()
    expect(await env.readDisk('main.tex')).toBe(MAIN)
    await collab.flushProject(env.projectId)
    expect(await env.readDisk('main.tex')).toBe('A' + MAIN)

    // rename (as FileService does: move on disk, then update the db)
    await fsp.mkdir(path.dirname(env.abs('chapters/intro.tex')), { recursive: true })
    await fsp.rename(env.abs('main.tex'), env.abs('chapters/intro.tex'))
    env.db.files.update(f.id, { path: 'chapters/intro.tex' })
    a.text.insert(0, 'B')
    await a.barrier()
    await collab.flushProject(env.projectId)
    expect(await env.readDisk('chapters/intro.tex')).toBe('BA' + MAIN)
    expect(fs.existsSync(env.abs('main.tex'))).toBe(false)
  })

  it('repairs a save that raced with a move (stale copy at the old path is removed)', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const collab = env.startCollab({ saveDebounceMs: 60_000, saveMaxWaitMs: 60_000 })
    const a = docClient(env, f, env.users.alice)
    await a.synced()
    // disk rename happened, db not updated yet, and a save lands in between
    await fsp.rename(env.abs('main.tex'), env.abs('moved.tex'))
    a.text.insert(0, 'late ')
    await a.barrier()
    await collab.flushProject(env.projectId)
    expect(await env.readDisk('main.tex')).toBe('late ' + MAIN) // re-created at the old path
    env.db.files.update(f.id, { path: 'moved.tex' })
    await collab.flushProject(env.projectId) // notices the path change
    expect(await env.readDisk('moved.tex')).toBe('late ' + MAIN)
    expect(fs.existsSync(env.abs('main.tex'))).toBe(false)
  })

  it('restarts without duplication: sidecar first, then outside disk edit, stale client merges cleanly', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const svc1 = env.startCollab()
    const a = docClient(env, f, env.users.alice)
    const b = docClient(env, f, env.users.bob)
    await a.synced()
    await b.synced()
    a.text.insert(MAIN.indexOf('Hello'), 'Intro. ')
    await a.barrier()
    await waitFor(() => b.text.toString().includes('Intro. '), 5000, 'B sync')

    // server goes down; clients keep their Y.Docs
    env.collab = null
    await svc1.shutdown()
    await waitFor(() => !a.provider.wsconnected && !b.provider.wsconnected, 5000, 'clients disconnected')
    const beforeRestart = MAIN.replace('Hello', 'Intro. Hello')
    expect(await env.readDisk('main.tex')).toBe(beforeRestart)
    // offline edit by A and an outside edit on disk while the server is down
    a.text.insert(a.text.length, '% offline\n')
    await fsp.writeFile(env.abs('main.tex'), beforeRestart.replace('world', 'external world'))

    const svc2 = env.startCollab()
    await waitFor(() => a.provider.synced && b.provider.synced, 10_000, 'reconnect')
    const expected = beforeRestart.replace('world', 'external world') + '% offline\n'
    await waitFor(async () => (await svc2.getText(env.projectId, f.id)) === expected, 5000, 'server merge')
    await waitFor(() => a.text.toString() === expected && b.text.toString() === expected, 5000, 'client convergence')
    expect(countOccurrences(a.text.toString(), '\\documentclass')).toBe(1)
    expect(countOccurrences(a.text.toString(), 'Intro.')).toBe(1)
    await svc2.flushProject(env.projectId)
    expect(await env.readDisk('main.tex')).toBe(expected)
    expect(a.closes).toEqual([])
  })

  it('a client from a lost document lineage is refused (4409) instead of duplicating', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const svc1 = env.startCollab()
    const a = docClient(env, f, env.users.alice)
    await a.synced()
    env.collab = null
    await svc1.shutdown()
    await waitFor(() => !a.provider.wsconnected, 5000, 'disconnect')
    // the sidecar is lost (e.g. data restored without ystate/)
    await fsp.rm(env.sidecar(f.id))
    const svc2 = env.startCollab()
    await waitFor(() => a.closes.includes(WS_CLOSE.STALE_EPOCH), 10_000, '4409 for the stale client')
    expect(await svc2.getText(env.projectId, f.id)).toBe(MAIN)
    // a fresh client (what the web app does on 4409) gets the text once
    const fresh = docClient(env, f, env.users.alice)
    await fresh.synced()
    expect(fresh.text.toString()).toBe(MAIN)
  })

  it('recovers when the process died between the sidecar and the text write', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const svc1 = env.startCollab()
    const a = docClient(env, f, env.users.alice)
    await a.synced()
    a.text.insert(0, '% newest\n')
    await a.barrier()
    await svc1.flushProject(env.projectId)
    // simulate the crash window: text on disk is one save behind the sidecar
    await fsp.writeFile(env.abs('main.tex'), MAIN)
    a.destroy()
    env.collab = null
    await svc1.shutdown() // nothing unsaved in memory, disk stays stale
    await fsp.writeFile(env.abs('main.tex'), MAIN)
    const svc2 = env.startCollab()
    expect(await svc2.getText(env.projectId, f.id)).toBe(MAIN) // no room open: disk copy
    const b = docClient(env, f, env.users.bob)
    await b.synced()
    expect(b.text.toString()).toBe('% newest\n' + MAIN)
    await svc2.flushProject(env.projectId)
    expect(await env.readDisk('main.tex')).toBe('% newest\n' + MAIN)
  })

  it('a corrupt sidecar bumps the epoch and closes clients with 4409', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const svc1 = env.startCollab()
    const a = docClient(env, f, env.users.alice)
    await a.synced()
    a.destroy()
    env.collab = null
    await svc1.shutdown()
    await fsp.writeFile(env.sidecar(f.id), Buffer.from('FOLIOYS1\x00\x00\x00\x02{}garbage-that-is-not-a-yjs-update'))
    const svc2 = env.startCollab()
    const b = docClient(env, f, env.users.bob)
    await waitFor(() => b.closes.length > 0, 5000, 'close')
    expect(b.closes).toEqual([WS_CLOSE.STALE_EPOCH])
    expect(env.db.files.get(f.id)!.epoch).toBe(1)
    expect(fs.readdirSync(path.dirname(env.sidecar(f.id))).some(n => n.includes('.corrupt-'))).toBe(true)
    const b2 = docClient(env, f, env.users.bob, { epoch: 1 })
    await b2.synced()
    expect(b2.text.toString()).toBe(MAIN)
    expect(await svc2.getText(env.projectId, f.id)).toBe(MAIN)
  })

  it('picks up an outside edit on disk at the next load', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const collab = env.startCollab({ unloadMs: 50 })
    const a = docClient(env, f, env.users.alice)
    await a.synced()
    a.text.insert(0, '% one\n')
    await a.barrier()
    a.destroy()
    await waitFor(() => collab.stats().rooms.length === 0, 5000, 'room unload')
    expect(await env.readDisk('main.tex')).toBe('% one\n' + MAIN)
    await fsp.writeFile(env.abs('main.tex'), '% one\n' + MAIN.replace('Hello', 'Goodbye'))
    const b = docClient(env, f, env.users.bob)
    await b.synced()
    expect(b.text.toString()).toBe('% one\n' + MAIN.replace('Hello', 'Goodbye'))
  })

  it('setText applies a minimal diff that preserves concurrent client edits', async () => {
    const base = 'L1\nL2\nL3\nL4\nL5\n'
    const f = env.createTextFile('doc.tex', base)
    const collab = env.startCollab()
    const a = docClient(env, f, env.users.alice)
    const b = docClient(env, f, env.users.bob)
    await a.synced()
    await b.synced()
    // A edits L3 while disconnected; the server replaces L1 and L5 based on the old text
    a.provider.disconnect()
    const i = a.text.toString().indexOf('L3')
    a.text.delete(i, 2)
    a.text.insert(i, 'L3-client')
    await collab.setText(env.projectId, f.id, base.replace('L1', 'L1-server').replace('L5', 'L5-server'), { userId: env.users.bob.id, reason: 'restore' })
    await waitFor(() => b.text.toString().includes('L5-server'), 5000, 'B sees setText')
    a.provider.connect()
    const expected = 'L1-server\nL2\nL3-client\nL4\nL5-server\n'
    await waitFor(async () => (await collab.getText(env.projectId, f.id)) === expected, 5000, 'merge')
    await waitFor(() => a.text.toString() === expected && b.text.toString() === expected, 5000, 'clients merge')
    await collab.flushProject(env.projectId)
    expect(await env.readDisk('doc.tex')).toBe(expected)
  })

  it('setText loads the room from disk when needed and saves immediately', async () => {
    const f = env.createTextFile('doc.tex', 'one\ntwo\n')
    const collab = env.startCollab({ unloadMs: 50 })
    await collab.setText(env.projectId, f.id, 'one\n2\n', { userId: env.users.alice.id, reason: 'upload' })
    expect(await env.readDisk('doc.tex')).toBe('one\n2\n')
    expect(fs.existsSync(env.sidecar(f.id))).toBe(true)
    await waitFor(() => collab.stats().rooms.length === 0, 5000, 'unload after setText')
    await expect(collab.setText(env.projectId, f.id, 'x'.repeat(MAX_DOC_LENGTH + 1))).rejects.toMatchObject({ status: 413 })
    await expect(collab.setText(env.projectId, 'missing', 'x')).rejects.toMatchObject({ status: 404 })
  })
})

describe('doc rooms: barrier', () => {
  it('echoes only after all earlier messages were applied (50 rounds incl. delete-only edits)', async () => {
    const f = env.createTextFile('main.tex', MAIN.repeat(20))
    const collab = env.startCollab()
    const a = docClient(env, f, env.users.alice)
    await a.synced()
    let seed = 1234
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31)
    for (let round = 0; round < 50; round++) {
      const edits = 1 + Math.floor(rand() * 4)
      for (let e = 0; e < edits; e++) {
        const len = a.text.length
        const pos = Math.floor(rand() * (len - 5))
        if (round % 3 === 2 && e === 0) a.text.insert(pos, 'ins')
        else a.text.delete(pos, 1 + Math.floor(rand() * 3)) // delete-only: the state vector does not move
      }
      await a.barrier()
      expect(await collab.getText(env.projectId, f.id)).toBe(a.text.toString())
    }
  })

  it('queues messages that arrive while the room is loading and answers the barrier in order', async () => {
    const big = ('% padding line to make loading take a moment\n').repeat(20_000) + MAIN
    const f = env.createTextFile('big.tex', big)
    const collab = env.startCollab()
    // an update produced against an empty doc (it merges as an insert at the start)
    const scratch = new Y.Doc()
    scratch.getText(DOC_TEXT_KEY).insert(0, 'QUEUED')
    const update = Y.encodeStateAsUpdate(scratch)
    const upd = encoding.createEncoder()
    encoding.writeVarUint(upd, MSG_SYNC)
    syncProtocol.writeUpdate(upd, update)
    const bar = encoding.createEncoder()
    encoding.writeVarUint(bar, MSG_BARRIER)
    encoding.writeVarString(bar, 'nonce-1')

    const { ws, messages, opened } = rawSocket(env, `/ws/doc/${env.projectId}/${f.id}?epoch=0&u=${env.users.alice.id}`)
    await opened
    ws.send(encoding.toUint8Array(upd))
    ws.send(encoding.toUint8Array(bar))
    expect(collab.stats().rooms[0].state).toBe('loading')
    await waitFor(() => messages.some(m => m[0] === MSG_BARRIER), 10_000, 'barrier echo')
    const echo = messages.find(m => m[0] === MSG_BARRIER)!
    const dec = decoding.createDecoder(echo)
    decoding.readVarUint(dec)
    expect(decoding.readVarString(dec)).toBe('nonce-1')
    const text = await collab.getText(env.projectId, f.id)
    expect(text.length).toBe(big.length + 'QUEUED'.length)
    expect(text.includes('QUEUED')).toBe(true)
    // the initial sync step 1 was sent before the barrier echo
    expect(messages[0][0]).toBe(MSG_SYNC)
    const first = decoding.createDecoder(messages[0])
    decoding.readVarUint(first)
    expect(decoding.readVarUint(first)).toBe(syncProtocol.messageYjsSyncStep1)
    expect(messages.findIndex(m => m[0] === MSG_BARRIER)).toBeGreaterThan(0)
  })
})

describe('doc rooms: access, epochs and limits', () => {
  it('closes with 4401 / 4403 / 4404 / 4410 / 4409 for missing user, missing role, unknown project, unknown or non-text files', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const bin = env.createBinaryFile('fig.pdf', Buffer.from('%PDF-1.5'))
    const other = env.db.projects.create({ name: 'Other', ownerId: env.users.mallory.id })
    const foreign = env.createTextFile('x.tex', 'x', other.id)
    env.startCollab()
    const base = `/ws/doc/${env.projectId}`
    const cases: [string, number][] = [
      [`${base}/${f.id}?epoch=0`, WS_CLOSE.UNAUTHORIZED],
      [`${base}/${f.id}?epoch=0&u=${env.users.mallory.id}`, WS_CLOSE.FORBIDDEN],
      // unknown project → 4404 (an access problem for web-core)
      [`/ws/doc/AAAAAAAAAAAAAAAA/${f.id}?epoch=0&u=${env.users.alice.id}`, WS_CLOSE.NOT_FOUND],
      // the project is accessible but the document does not exist (deleted / another project's id) → 4410
      [`${base}/doesnotexist?epoch=0&u=${env.users.alice.id}`, WS_CLOSE.GONE],
      [`${base}/${foreign.id}?epoch=0&u=${env.users.alice.id}`, WS_CLOSE.GONE],
      // a binary file has no doc room (like a text file that became binary) → 4409
      [`${base}/${bin.id}?epoch=0&u=${env.users.alice.id}`, WS_CLOSE.STALE_EPOCH],
      [`${base}/${f.id}?epoch=3&u=${env.users.alice.id}`, WS_CLOSE.STALE_EPOCH],
      [`${base}/${f.id}?u=${env.users.alice.id}`, WS_CLOSE.STALE_EPOCH],
    ]
    for (const [url, code] of cases) {
      const { closed } = rawSocket(env, url)
      expect(await closed, url).toBe(code)
    }
  })

  it('y-websocket stops reconnecting after an epoch mismatch (4409)', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    env.startCollab()
    const a = docClient(env, f, env.users.alice, { epoch: 7 })
    await waitFor(() => a.closes.length > 0, 5000, 'close')
    expect(a.closes).toEqual([WS_CLOSE.STALE_EPOCH])
    await sleep(500)
    expect(a.provider.shouldConnect).toBe(false)
    expect(a.provider.ws).toBe(null)
    expect(a.statuses.filter(st => st === 'connected')).toHaveLength(1) // no reconnect attempt
  })

  it('discardFile closes 4409 (stale epoch) / 4410 (gone) and deletes sidecars', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const g = env.createTextFile('gone.tex', 'bye')
    const collab = env.startCollab()
    const a = docClient(env, f, env.users.alice)
    const b = docClient(env, g, env.users.bob)
    await a.synced()
    await b.synced()
    expect(fs.existsSync(env.sidecar(f.id))).toBe(true)

    env.db.files.bumpEpoch(f.id)
    await collab.discardFile(env.projectId, f.id, WS_CLOSE.STALE_EPOCH)
    await waitFor(() => a.closes.length > 0, 5000, 'stale close')
    expect(a.closes).toEqual([WS_CLOSE.STALE_EPOCH])
    expect(fs.existsSync(env.sidecar(f.id, 0))).toBe(false)
    // the web app reconnects with the new epoch and gets a fresh doc from disk
    const a2 = docClient(env, f, env.users.alice, { epoch: 1 })
    await a2.synced()
    expect(a2.text.toString()).toBe(MAIN)

    await collab.discardFile(env.projectId, g.id, WS_CLOSE.GONE)
    await waitFor(() => b.closes.length > 0, 5000, 'gone close')
    expect(b.closes).toEqual([WS_CLOSE.GONE])
    expect(fs.existsSync(env.sidecar(g.id))).toBe(false)
  })

  it('discardProject closes every doc socket with 4410 and removes the project ystate dir', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const collab = env.startCollab()
    const a = docClient(env, f, env.users.alice)
    await a.synced()
    await collab.discardProject(env.projectId)
    await waitFor(() => a.closes.length > 0, 5000, 'close')
    expect(a.closes).toEqual([WS_CLOSE.GONE])
    expect(fs.existsSync(path.join(env.config.dirs.ystate, env.projectId))).toBe(false)
  })

  it('disconnectUser closes only that user\'s sockets', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const collab = env.startCollab()
    const a = docClient(env, f, env.users.alice)
    const b = docClient(env, f, env.users.bob)
    await a.synced()
    await b.synced()
    collab.disconnectUser(env.projectId, env.users.bob.id, WS_CLOSE.FORBIDDEN)
    await waitFor(() => b.closes.length > 0, 5000, 'close')
    expect(b.closes).toEqual([WS_CLOSE.FORBIDDEN])
    expect(a.closes).toEqual([])
    a.text.insert(0, 'still here ')
    await a.barrier()
  })

  it('disconnectSessions closes only the sockets of the given sessions (4401); openSessions lists them', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const g = env.createTextFile('other.tex', 'other')
    const collab = env.startCollab()
    // alice in two browsers (sessions s-a1, s-a2), bob in one
    const a1 = docClient(env, f, env.users.alice, { session: 's-a1' })
    const a1g = docClient(env, g, env.users.alice, { session: 's-a1' })
    const a2 = docClient(env, f, env.users.alice, { session: 's-a2' })
    const b = docClient(env, f, env.users.bob, { session: 's-b' })
    for (const c of [a1, a1g, a2, b]) await c.synced()
    expect(collab.openSessions().sort()).toEqual(['s-a1', 's-a2', 's-b'])
    expect(collab.disconnectSessions([], WS_CLOSE.UNAUTHORIZED)).toBe(0)
    expect(collab.disconnectSessions(['s-a1', 'unknown'], WS_CLOSE.UNAUTHORIZED)).toBe(2)
    await waitFor(() => a1.closes.length > 0 && a1g.closes.length > 0, 5000, 'session closed')
    expect(a1.closes).toEqual([WS_CLOSE.UNAUTHORIZED])
    expect(a1g.closes).toEqual([WS_CLOSE.UNAUTHORIZED])
    await sleep(300)
    // y-websocket does not reconnect after 44xx
    expect(a1.provider.wsconnected).toBe(false)
    expect(a2.closes).toEqual([])
    expect(b.closes).toEqual([])
    expect(collab.openSessions().sort()).toEqual(['s-a2', 's-b'])
    a2.text.insert(0, 'still here ')
    await a2.barrier()
    await b.barrier()
    expect(b.text.toString().startsWith('still here ')).toBe(true)
  })

  it('refuses updates that would exceed MAX_DOC_LENGTH (4413) without applying them', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const collab = env.startCollab()
    const a = docClient(env, f, env.users.alice)
    const b = docClient(env, f, env.users.bob)
    await a.synced()
    await b.synced()
    a.text.insert(0, 'x'.repeat(MAX_DOC_LENGTH - MAIN.length + 1))
    await waitFor(() => a.closes.length > 0, 10_000, 'close')
    expect(a.closes).toEqual([WS_CLOSE.TOO_LARGE])
    expect(await collab.getText(env.projectId, f.id)).toBe(MAIN)
    await b.barrier()
    expect(b.text.toString()).toBe(MAIN)
  })

  it('rejects updates touching anything but the document text (4400)', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const collab = env.startCollab()
    const a = docClient(env, f, env.users.alice)
    await a.synced()
    a.doc.getMap('evil').set('k', 'v'.repeat(1000))
    await waitFor(() => a.closes.length > 0, 5000, 'close')
    expect(a.closes).toEqual([4400])
    const b = docClient(env, f, env.users.bob)
    await b.synced()
    expect(b.doc.getMap('evil').size).toBe(0)
    expect(await collab.getText(env.projectId, f.id)).toBe(MAIN)
  })
})

describe('doc rooms: awareness and notifications', () => {
  it('relays awareness with the authenticated identity and removes it on close', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    env.startCollab()
    const a = docClient(env, f, env.users.alice)
    const b = docClient(env, f, env.users.bob)
    await a.synced()
    await b.synced()
    b.provider.awareness.setLocalStateField('user', { id: env.users.alice.id, name: 'Not Bob', color: '#000000', colorLight: '#00000033' })
    b.provider.awareness.setLocalStateField('cursor', { anchor: 1, head: 2 })
    const bId = b.doc.clientID
    let awarenessFramesToB = 0
    const handler = b.provider.messageHandlers[1]
    b.provider.messageHandlers[1] = (...args) => {
      awarenessFramesToB++
      handler(...args)
    }
    await waitFor(() => (a.provider.awareness.getStates().get(bId) as { cursor?: unknown } | undefined)?.cursor !== undefined, 5000, 'A sees B')
    const seen = a.provider.awareness.getStates().get(bId) as { user: { id: string; name: string; color: string; colorLight: string }; cursor: unknown }
    expect(seen.user).toEqual({ id: env.users.bob.id, name: 'Bob', color: env.users.bob.color, colorLight: env.users.bob.color + '33' })
    expect(seen.cursor).toEqual({ anchor: 1, head: 2 })
    // the sender also receives the rebroadcast of its own update (y-websocket's liveness signal)
    await waitFor(() => awarenessFramesToB >= 2, 5000, 'echo to sender')

    b.destroy()
    await waitFor(() => !a.provider.awareness.getStates().has(bId), 5000, 'removal on close')
  })

  it('tracks editors, notes history activity and emits throttled doc:changed events', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const collab = env.startCollab({ docChangedMs: 200 })
    const changes: { fileId: string; userId: string | null }[] = []
    const off = collab.onDocChanged(e => changes.push({ fileId: e.fileId, userId: e.userId }))
    const a = docClient(env, f, env.users.alice)
    const v = docClient(env, f, env.users.victor)
    await a.synced()
    await v.synced()
    for (let i = 0; i < 5; i++) {
      a.text.insert(0, `${i}`)
      await a.barrier()
    }
    v.text.insert(0, 'viewer') // refused (4403): no change, no activity, not an editor
    await waitFor(() => v.closes.length > 0, 5000, 'viewer closed')
    await waitFor(() => changes.length >= 1, 5000, 'doc changed')
    await sleep(400)
    expect(changes.length).toBeLessThanOrEqual(2)
    expect(changes[0]).toEqual({ fileId: f.id, userId: env.users.alice.id })
    expect(env.events.map(e => e.event)).toContainEqual({ type: 'doc:changed', fileId: f.id, userId: env.users.alice.id })
    expect(env.noteActivity).toContainEqual({ projectId: env.projectId, userId: env.users.alice.id })
    expect(collab.takeEditors(env.projectId)).toEqual([env.users.alice.id])
    expect(collab.takeEditors(env.projectId)).toEqual([])
    off()
    await collab.setText(env.projectId, f.id, 'replaced\n', { userId: env.users.bob.id, reason: 'restore' })
    expect(collab.takeEditors(env.projectId)).toEqual([env.users.bob.id])
    await sleep(400)
    expect(changes.every(c => c.userId === env.users.alice.id)).toBe(true)
  })

  it('reports history activity on the trailing edge: an edit inside the throttle window is reported at its end', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const collab = env.startCollab({ activityThrottleMs: 600 })
    const a = docClient(env, f, env.users.alice)
    await a.synced()
    const noted = () => env.noteActivity.filter(n => n.userId === env.users.alice.id).length
    a.text.insert(0, '1')
    await a.barrier()
    expect(noted()).toBe(1) // the first edit is reported at once
    a.text.insert(0, '2')   // inside the window: not now …
    await a.barrier()
    expect(noted()).toBe(1)
    await waitFor(() => noted() === 2, 3000, 'trailing report') // … but at its end, with nobody typing
    // a burst inside one window: exactly one more report
    for (const ch of '345') {
      a.text.insert(0, ch)
      await a.barrier()
    }
    await sleep(1200)
    expect(noted()).toBe(3)
    // every applied change is counted, reported or not
    expect(collab.editCount(env.projectId)).toBe(5)
    await collab.setText(env.projectId, f.id, 'replaced\n', { userId: env.users.bob.id, reason: 'restore' })
    expect(collab.editCount(env.projectId)).toBe(6)
    expect(collab.editCount('someotherproject')).toBe(0)
    // a room dropped with a report still scheduled reports it right away
    a.text.insert(0, 'A')
    await a.barrier()
    a.text.insert(0, 'B')
    await a.barrier()
    const before = noted()
    await collab.discardFile(env.projectId, f.id, WS_CLOSE.GONE)
    expect(noted()).toBe(before + 1)
  })

  it('shutdown flushes unsaved edits and closes sockets with 1012 (clients keep reconnecting)', async () => {
    const f = env.createTextFile('main.tex', MAIN)
    const collab = env.startCollab({ saveDebounceMs: 60_000, saveMaxWaitMs: 60_000 })
    const a = docClient(env, f, env.users.alice)
    await a.synced()
    a.text.insert(0, '% unsaved\n')
    await a.barrier()
    env.collab = null
    await collab.shutdown()
    expect(await env.readDisk('main.tex')).toBe('% unsaved\n' + MAIN)
    await waitFor(() => !a.provider.wsconnected, 5000, 'disconnect')
    expect(a.closes).toEqual([]) // 1012 is not a permanent close
  })
})
