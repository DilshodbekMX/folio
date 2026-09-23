/**
 * One collaborative text document (`${projectId}/${fileId}` at a given epoch).
 *
 * Load order (the fix for the verified duplication-on-restart bug): apply the Yjs sidecar FIRST,
 * then reconcile with the file on disk through applyTextDiff; a fresh Y.Doc is only built when
 * no sidecar exists, and its state is persisted before any client sees it.
 *
 * Save: debounced (idle/max-wait) — sidecar first, then the text to the file's CURRENT path
 * (resolved from the db synchronously right before the rename). The sidecar header records the
 * text hashes so a crash between the two writes is recognised on the next load.
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import * as decoding from 'lib0/decoding'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { looksLikeUtf8Text, normalizeText } from '@folio/shared/filetypes'
import { DOC_TEXT_KEY, MAX_DOC_LENGTH, WS_CLOSE } from '@folio/shared/protocol'
import type { Services } from '../services.ts'
import { errInfo, type CollabLogger } from './log.ts'
import { BaseRoom, CLOSE_INTERNAL, Conn } from './room.ts'
import { decodeSidecar, encodeSidecar, readIfExists, sha1, sidecarPath, writeFileAtomic, type SidecarHeader } from './storage.ts'
import { applyTextDiff } from './text-diff.ts'
import { ProtocolError, encodeSyncStep1, encodeSyncStep2, encodeSyncUpdate, inspectTextUpdate } from './wire.ts'

/** How often at most a connection's session is re-checked while it sends updates. */
const SESSION_RECHECK_MS = 5_000

/** transaction origin of the load-time reconcile (never triggers saves or edit notifications) */
export const LOAD_ORIGIN = Symbol('collab-load')
/** transaction origin of CollabService.setText */
export const SERVER_ORIGIN = 'server'

export interface DocRoomTimings {
  saveDebounceMs: number
  saveMaxWaitMs: number
  /** delay before retrying a failed save */
  saveRetryMs: number
}

/** What a room needs from the service that owns it. */
export interface DocRoomHost {
  readonly s: Services
  readonly log: CollabLogger
  readonly timings: DocRoomTimings
  /** a text change was applied (client edit or setText) */
  noteEdit(room: DocRoom, userId: string | null): void
  /** the last connection left */
  roomEmpty(room: DocRoom): void
  /** the file vanished or changed kind/epoch in the db while the room was open */
  roomInvalid(room: DocRoom, code: number, reason: string): void
}

/** Load failure carrying the close code for the room's connections. */
export class RoomLoadError extends Error {
  constructor(readonly code: number, reason: string) {
    super(reason)
    this.name = 'RoomLoadError'
  }
}

type RecordCheck = { ok: true; path: string } | { ok: false; code: number; reason: string }

export class DocRoom extends BaseRoom {
  readonly key: string
  readonly text: Y.Text
  readonly ready: Promise<void>
  state: 'loading' | 'ready' | 'failed' = 'loading'
  /** set when the room was dropped (discardFile, stale epoch, shutdown) — no more saves */
  discarded = false

  /** disk text as last read or written; null = unknown/missing (the next flush writes the file) */
  private lastSavedText: string | null = null
  /** absolute path the text was last read from or written to (null: not on disk yet) */
  private lastPath: string | null = null
  /** the file moved since the last write: write the text even if it did not change */
  private forceTextWrite = false
  private sidecarDirty = false
  /** client id that created the lineage's initial content (see isForeignLineage) */
  private base: number | null = null
  private saveTimer: NodeJS.Timeout | null = null
  private firstDirtyAt = 0
  private saveChain: Promise<void> = Promise.resolve()

  // bookkeeping owned by the service
  unloadTimer: NodeJS.Timeout | null = null
  unloadGen = 0
  docChangedTimer: NodeJS.Timeout | null = null
  docChangedUser: string | null = null
  /** per user id ('' = no user): when history.noteActivity was last called for this file */
  readonly activityNotedAt = new Map<string, number>()
  /** per user id: the trailing noteActivity scheduled for an edit inside the throttle window */
  readonly activityTimers = new Map<string, NodeJS.Timeout>()
  /** user of the latest edit not yet written to disk (db.projects.touchUpdated) */
  lastEditor: string | null = null
  /** origin details of the setText call currently applying its transaction */
  serverOrigin: { userId: string | null; reason: string } | null = null

  constructor(private readonly host: DocRoomHost, readonly projectId: string, readonly fileId: string, readonly epoch: number) {
    super(host.log, `${projectId}/${fileId}@${epoch}`)
    this.key = `${projectId}/${fileId}`
    this.text = this.doc.getText(DOC_TEXT_KEY)
    this.ready = this.load()
    // the service attaches its own handler; avoid unhandled-rejection noise here
    this.ready.catch(() => {})
  }

  private get sidecarFile(): string {
    return sidecarPath(this.host.s.config.dirs.ystate, this.projectId, this.fileId, this.epoch)
  }

  private get tmpDir(): string {
    return this.host.s.config.dirs.tmp
  }

  protected isReady(): boolean {
    return this.state === 'ready'
  }

  protected initialMessages(): Uint8Array[] {
    return [encodeSyncStep1(this.doc)]
  }

  protected onEmpty(): void {
    if (!this.discarded) this.host.roomEmpty(this)
  }

  protected sanitizeState(conn: Conn, state: Record<string, unknown>): Record<string, unknown> | null {
    // cursor etc. pass through; the identity is always the authenticated user's
    return { ...state, user: conn.presence }
  }

  // -------------------------------------------------------------------------
  // Load
  // -------------------------------------------------------------------------

  /** Look up the file in the db; the room is only valid while it is a text file at this epoch. */
  checkRecord(): RecordCheck {
    const rec = this.host.s.db.files.get(this.fileId)
    if (!rec || rec.projectId !== this.projectId) return { ok: false, code: WS_CLOSE.GONE, reason: 'file deleted' }
    if (rec.kind !== 'text') return { ok: false, code: WS_CLOSE.STALE_EPOCH, reason: 'file is no longer a text document' }
    if (rec.epoch !== this.epoch) return { ok: false, code: WS_CLOSE.STALE_EPOCH, reason: 'stale epoch' }
    return { ok: true, path: rec.path }
  }

  private assertLive(): void {
    if (this.discarded) throw new RoomLoadError(WS_CLOSE.GONE, 'room discarded while loading')
  }

  private async load(): Promise<void> {
    const { s, log } = this.host
    const first = this.checkRecord()
    if (!first.ok) throw new RoomLoadError(first.code, first.reason)

    // 1. CRDT state from the sidecar
    const sidecarBytes = await readIfExists(this.sidecarFile)
    this.assertLive()
    let header: SidecarHeader | null = null
    const hadSidecar = sidecarBytes !== null
    if (sidecarBytes) {
      try {
        const decoded = decodeSidecar(sidecarBytes)
        Y.applyUpdate(this.doc, decoded.update, LOAD_ORIGIN)
        header = decoded.header
      } catch (err) {
        await this.quarantineCorruptSidecar(err)
        throw new RoomLoadError(WS_CLOSE.STALE_EPOCH, 'document state was reset')
      }
    }

    // 2. the file on disk (its current path)
    const rec = this.checkRecord()
    if (!rec.ok) throw new RoomLoadError(rec.code, rec.reason)
    const diskPath = s.files.absPath(this.projectId, rec.path)
    const bytes = await readIfExists(diskPath)
    this.assertLive()
    let disk: string | null = null
    this.lastPath = bytes ? diskPath : null
    if (bytes) {
      if (!looksLikeUtf8Text(bytes)) throw new RoomLoadError(WS_CLOSE.NOT_FOUND, 'file on disk is not UTF-8 text')
      disk = normalizeText(bytes.toString('utf8'))
      if (disk.length > MAX_DOC_LENGTH) throw new RoomLoadError(WS_CLOSE.TOO_LARGE, 'document too large')
    }

    // 3. reconcile
    let persistNow = false
    let flushSoon = false
    if (hadSidecar) {
      this.base = header?.base ?? null
      const current = this.text.toString()
      if (disk === null) {
        // file missing on disk although the db lists it: the Y state is authoritative, write it back
        this.lastSavedText = null
        flushSoon = true
      } else if (disk === current) {
        this.lastSavedText = disk
      } else if (header && header.prevTextHash !== null && header.prevTextHash === sha1(disk) && header.textHash === sha1(current)) {
        // the previous process wrote the sidecar but crashed before the text: keep the newer state
        this.lastSavedText = disk
        flushSoon = true
        log.warn({ room: this.label }, 'recovered unsaved text from sidecar')
      } else {
        // outside edit (or restored backup): apply it as a minimal diff on top of the CRDT history
        applyTextDiff(this.text, disk, LOAD_ORIGIN)
        this.lastSavedText = disk
        persistNow = true
        log.info({ room: this.label }, 'reconciled outside edit from disk')
      }
    } else {
      const initial = disk ?? ''
      if (initial) applyTextDiff(this.text, initial, LOAD_ORIGIN)
      this.base = initial ? this.doc.clientID : null
      this.lastSavedText = initial
      persistNow = true
    }

    // Persist the state before any client can sync it: a client that received content created
    // by this process must find the same items after a crash/restart (otherwise it duplicates).
    if (persistNow) {
      const written = await writeFileAtomic(this.sidecarFile, this.encodeState(this.text.toString()), {
        tmpDir: this.tmpDir, cancelled: () => this.discarded,
      })
      this.assertLive()
      if (!written) throw new RoomLoadError(WS_CLOSE.GONE, 'room discarded while loading')
    }

    this.doc.on('update', (update: Uint8Array, origin: unknown) => this.onDocUpdate(update, origin))
    this.state = 'ready'
    if (flushSoon) this.scheduleSave()
    this.startAll()
  }

  /** Move an unreadable sidecar aside and bump the epoch so every client drops its copy of the old state. */
  private async quarantineCorruptSidecar(err: unknown): Promise<void> {
    const { s, log } = this.host
    const file = this.sidecarFile
    log.error({ room: this.label, file, ...errInfo(err) }, 'corrupt Yjs sidecar; bumping the file epoch')
    try {
      await fsp.rename(file, `${file}.corrupt-${Date.now()}`)
    } catch (e) {
      log.error({ room: this.label, ...errInfo(e) }, 'could not move the corrupt sidecar aside')
    }
    if (this.discarded) return
    const rec = s.db.files.get(this.fileId)
    if (rec && rec.epoch === this.epoch) {
      s.db.files.bumpEpoch(this.fileId)
      try {
        s.meta?.syncFiles(this.projectId)
      } catch (e) {
        log.warn({ room: this.label, ...errInfo(e) }, 'meta.syncFiles failed')
      }
    }
  }

  private encodeState(text: string): Buffer {
    const header: SidecarHeader = {
      v: 1,
      textHash: sha1(text),
      prevTextHash: this.lastSavedText === null ? null : sha1(this.lastSavedText),
      base: this.base,
      savedAt: Date.now(),
    }
    return encodeSidecar(header, Y.encodeStateAsUpdate(this.doc))
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  protected onSyncMessage(conn: Conn, dec: decoding.Decoder): void {
    const sub = decoding.readVarUint(dec)
    switch (sub) {
      case syncProtocol.messageYjsSyncStep1: {
        const sv = decoding.readVarUint8Array(dec)
        if (this.isForeignLineage(sv)) {
          this.log.warn({ room: this.label, user: conn.user.id }, 'client holds state of a lost document lineage; forcing a fresh copy')
          this.closeConn(conn, WS_CLOSE.STALE_EPOCH, 'stale document state')
          return
        }
        this.send(conn, encodeSyncStep2(this.doc, sv))
        return
      }
      case syncProtocol.messageYjsSyncStep2:
      case syncProtocol.messageYjsUpdate: {
        const update = decoding.readVarUint8Array(dec)
        if (!this.sessionStillOpen(conn)) return
        if (conn.readOnly) {
          this.refuseReadOnlyUpdate(conn, update)
          return
        }
        this.applyClientUpdate(conn, update)
        return
      }
      default:
        throw new ProtocolError(`unknown sync message type ${sub}`)
    }
  }

  /**
   * Viewers' content is never applied. Their ordinary sync — the SyncStep2 every client sends
   * after connecting, holding nothing the server lacks (its delete set only repeats deletions
   * the server has) — is simply ignored. An update that does hold something new is an edit the
   * client believes it made: typically typed offline by an editor who was made a viewer
   * meanwhile (the role change could not close a socket that was down). Dropping it silently
   * would let that client believe it was saved (its next barrier would be echoed), so the
   * connection is closed with 4403 instead: the client re-checks its role, keeps its text aside
   * and reopens the document read-only. Nothing received on this socket afterwards (a barrier
   * in particular) is answered.
   */
  private refuseReadOnlyUpdate(conn: Conn, update: Uint8Array): void {
    let known: boolean
    try {
      known = Y.snapshotContainsUpdate(Y.snapshot(this.doc), update)
    } catch (err) {
      throw new ProtocolError(`undecodable update: ${(err as Error).message}`)
    }
    if (known) return
    this.log.info({ room: this.label, user: conn.user.id }, 'read-only connection sent changes; closing it so the client re-checks its role')
    this.closeConn(conn, WS_CLOSE.FORBIDDEN, 'read-only: changes not accepted')
  }

  /**
   * Belt and braces for SEC2-1: a connection whose session has ended writes nothing more. The
   * session's sockets are closed the moment it is revoked (auth/live.ts) and the sweeper closes
   * the sockets of sessions that ended otherwise every minute, so this only catches a socket
   * those missed — one whose close could not be delivered, for example. Costs one indexed
   * lookup per connection and SESSION_RECHECK_MS at most, never one per keystroke.
   */
  private sessionStillOpen(conn: Conn): boolean {
    const tokenHash = conn.session
    if (tokenHash === null) return true
    const now = Date.now()
    if (now - conn.sessionCheckedAt < SESSION_RECHECK_MS) return true
    conn.sessionCheckedAt = now
    if (this.host.s.db.sessions.get(tokenHash)) return true
    this.log.info({ room: this.label, user: conn.user.id }, 'update from a socket whose session has ended; closing it')
    this.closeConn(conn, WS_CLOSE.UNAUTHORIZED, 'session ended')
    return false
  }

  /**
   * A client whose state vector is non-empty but does not contain the client that created this
   * document's initial content synced with a different Y.Doc for the same file (its sidecar was
   * lost). Merging it would duplicate the text, so it must start over with an empty doc.
   */
  private isForeignLineage(sv: Uint8Array): boolean {
    if (this.base === null) return false
    let vector: Map<number, number>
    try {
      vector = Y.decodeStateVector(sv)
    } catch {
      throw new ProtocolError('invalid state vector')
    }
    return vector.size > 0 && !vector.has(this.base)
  }

  private applyClientUpdate(conn: Conn, update: Uint8Array): void {
    const growth = inspectTextUpdate(update, DOC_TEXT_KEY)
    if (this.text.length + growth > MAX_DOC_LENGTH && this.lengthWith(update) > MAX_DOC_LENGTH) {
      this.log.warn({ room: this.label, user: conn.user.id }, 'rejected update: document would exceed MAX_DOC_LENGTH')
      this.closeConn(conn, WS_CLOSE.TOO_LARGE, 'document too large')
      return
    }
    Y.applyUpdate(this.doc, update, conn)
    if (this.text.length > MAX_DOC_LENGTH) {
      this.log.warn({ room: this.label, user: conn.user.id, length: this.text.length }, 'document exceeds MAX_DOC_LENGTH')
      this.closeConn(conn, WS_CLOSE.TOO_LARGE, 'document too large')
    }
  }

  /** Exact text length after applying `update` (computed on a scratch copy; only used near the limit). */
  private lengthWith(update: Uint8Array): number {
    const probe = new Y.Doc({ gc: true })
    try {
      Y.applyUpdate(probe, Y.encodeStateAsUpdate(this.doc))
      Y.applyUpdate(probe, update)
      return probe.getText(DOC_TEXT_KEY).length
    } finally {
      probe.destroy()
    }
  }

  private onDocUpdate(update: Uint8Array, origin: unknown): void {
    if (this.destroyed) return
    this.broadcast(encodeSyncUpdate(update))
    if (origin === LOAD_ORIGIN) return
    this.sidecarDirty = true
    this.scheduleSave()
    try {
      if (origin instanceof Conn) this.host.noteEdit(this, origin.user.id)
      else if (origin === SERVER_ORIGIN) this.host.noteEdit(this, this.serverOrigin?.userId ?? null)
      else this.host.noteEdit(this, null)
    } catch (err) {
      this.log.error({ room: this.label, ...errInfo(err) }, 'edit notification failed')
    }
  }

  // -------------------------------------------------------------------------
  // Save
  // -------------------------------------------------------------------------

  scheduleSave(delayMs?: number): void {
    if (this.discarded || this.state !== 'ready') return
    const now = Date.now()
    if (this.saveTimer === null) this.firstDirtyAt = now
    else clearTimeout(this.saveTimer)
    const { saveDebounceMs, saveMaxWaitMs } = this.host.timings
    const wait = delayMs ?? Math.max(0, Math.min(saveDebounceMs, this.firstDirtyAt + saveMaxWaitMs - now))
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.flush().catch(() => { /* logged in doFlush; retry scheduled */ })
    }, wait)
    this.saveTimer.unref()
  }

  private clearSaveTimer(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
  }

  /** Write text + sidecar if anything changed. Serialised; rejects when the write failed. */
  flush(): Promise<void> {
    this.clearSaveTimer()
    const run = this.saveChain.then(() => this.doFlush())
    this.saveChain = run.catch(() => {})
    return run
  }

  /** Resolves once loading and any in-flight save have settled. */
  async settled(): Promise<void> {
    await this.ready.catch(() => {})
    await this.saveChain
  }

  get hasUnsavedChanges(): boolean {
    return this.state === 'ready' && (this.sidecarDirty || this.forceTextWrite || this.text.toString() !== this.lastSavedText)
  }

  private async doFlush(): Promise<void> {
    if (this.state !== 'ready' || this.discarded) return
    const text = this.text.toString()
    const contentChanged = text !== this.lastSavedText
    const writeText = contentChanged || this.forceTextWrite
    if (!writeText && !this.sidecarDirty) return
    const check = this.checkRecord()
    if (!check.ok) {
      this.host.roomInvalid(this, check.code, check.reason)
      return
    }
    const state = this.encodeState(text)
    this.sidecarDirty = false
    const editor = this.lastEditor
    const prevText = this.lastSavedText
    const prevPath = this.lastPath
    try {
      // sidecar first: the Y state is always at least as new as the disk text
      const cancelled = () => this.discarded
      if (!(await writeFileAtomic(this.sidecarFile, state, { tmpDir: this.tmpDir, cancelled }))) return
      if (!writeText) return
      const { s } = this.host
      // resolved synchronously right before the rename, so a move/delete in between is honoured
      const target = () => {
        if (this.discarded) return null
        const now = this.checkRecord()
        return now.ok ? s.files.absPath(this.projectId, now.path) : null
      }
      const written = await writeFileAtomic(target, text, { tmpDir: this.tmpDir })
      if (!written) return
      this.lastSavedText = text
      this.lastPath = written
      this.forceTextWrite = false
      if (this.lastEditor === editor) this.lastEditor = null
      if (prevPath && prevPath !== written && prevText !== null) await this.removeStaleCopy(prevPath, prevText)
      if (!contentChanged) return
      try {
        s.db.files.update(this.fileId, { size: Buffer.byteLength(text, 'utf8') })
        const who = editor ?? s.db.projects.get(this.projectId)?.lastUpdatedBy ?? null
        s.db.projects.touchUpdated(this.projectId, who)
      } catch (err) {
        this.log.warn({ room: this.label, ...errInfo(err) }, 'could not update file metadata after save')
      }
    } catch (err) {
      this.sidecarDirty = true
      this.log.error({ room: this.label, ...errInfo(err) }, 'saving document failed; will retry')
      this.scheduleSave(this.host.timings.saveRetryMs)
      throw err
    }
  }

  /**
   * Notice a move (or delete/kind change) recorded in the db behind the room's back: the text is
   * rewritten at the new path. Called periodically and before explicit flushes.
   */
  verifyPath(): void {
    if (this.state !== 'ready' || this.discarded) return
    const check = this.checkRecord()
    if (!check.ok) {
      this.host.roomInvalid(this, check.code, check.reason)
      return
    }
    if (this.lastPath === null) return
    const abs = this.host.s.files.absPath(this.projectId, check.path)
    if (abs !== this.lastPath && !this.forceTextWrite) {
      this.forceTextWrite = true
      this.scheduleSave(0)
    }
  }

  /**
   * A save that raced with a move can re-create the file at its old path (the move renamed it on
   * disk before the db changed). Remove that copy when nothing else owns the path and it still
   * holds exactly what this room wrote there.
   */
  private async removeStaleCopy(oldAbs: string, expected: string): Promise<void> {
    const { s } = this.host
    try {
      const rel = path.relative(s.files.projectDir(this.projectId), oldAbs)
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return
      if (s.db.files.getByPath(this.projectId, rel.split(path.sep).join('/'))) return
      const bytes = await readIfExists(oldAbs)
      if (!bytes || normalizeText(bytes.toString('utf8')) !== expected) return
      if (s.db.files.getByPath(this.projectId, rel.split(path.sep).join('/'))) return
      await fsp.rm(oldAbs, { force: true })
      this.log.info({ room: this.label, file: oldAbs }, 'removed a stale copy left at the previous path')
    } catch (err) {
      this.log.warn({ room: this.label, ...errInfo(err) }, 'could not check the previous path for a stale copy')
    }
  }

  // -------------------------------------------------------------------------
  // Teardown
  // -------------------------------------------------------------------------

  /** Stop all activity: no more saves, timers cleared. Connections are closed with `code` when given. */
  discard(code?: number, reason?: string): void {
    this.discarded = true
    this.clearTimers()
    if (code !== undefined) this.closeAll(code, reason ?? '')
    this.destroy()
  }

  /** Unload after a final flush (connections already gone). */
  dispose(): void {
    this.clearTimers()
    this.destroy()
  }

  private clearTimers(): void {
    this.clearSaveTimer()
    if (this.unloadTimer) clearTimeout(this.unloadTimer)
    this.unloadTimer = null
    if (this.docChangedTimer) clearTimeout(this.docChangedTimer)
    this.docChangedTimer = null
  }

  fail(err: unknown): void {
    this.state = 'failed'
    const code = err instanceof RoomLoadError ? err.code : CLOSE_INTERNAL
    const reason = err instanceof RoomLoadError ? err.message : 'could not open document'
    this.discard(code, reason)
  }
}
