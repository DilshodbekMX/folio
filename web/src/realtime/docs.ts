/**
 * Collaborative document sessions (SPEC §6.4): one Y.Doc + WebsocketProvider per text file
 * (`/ws/doc/<projectId>/<fileId>?epoch=N`), cached per `fileId:epoch`, ref-counted, with an LRU
 * of at most MAX_IDLE unreferenced sessions kept connected (fast file switching, StrictMode-safe
 * acquire/release pairs). All sessions are destroyed when the project is unloaded, except those
 * with unsynced local edits (see below).
 *
 * - Undo: `session.undoManager` is a Y.UndoManager on the Y.Text tracking y-codemirror.next's
 *   binding origin (the YSyncConfig class, so every editor view created for this session is
 *   tracked); pass it to `yCollab(ytext, awareness, { undoManager })`. Remote edits are never undone.
 *   A server-side replacement (history restore, upload, outside edit) re-inserts text as new
 *   items, so undoing an earlier local deletion would duplicate it: such changes are authored by
 *   the server's own Y client, which never has an awareness state (every collaborator's client
 *   has one), and a remote change by an author never seen in awareness clears the session's undo
 *   history.
 * - Barrier: MSG_BARRIER [100, nonce] round-trip; the server echoes it after applying every
 *   earlier message of the socket, so after `barrierAll()` the server copy has our last keystroke.
 * - Close codes: 4409 STALE_EPOCH / 4410 GONE → session marked stale, `onStale` listeners are told
 *   (for 4409 once the new epoch is known), re-acquire with the new FileEntry. 4401/4403/4404 →
 *   access is re-checked over REST (rate-limited, never skipped); after a successful re-check the
 *   session is reported stale too. The server also closes with 4403 a read-only socket that sent
 *   changes — edits made as an editor, typically offline, before we were made a viewer: the
 *   session is closed before any barrier could confirm them, so they are kept (below), and the
 *   re-check turns the editor read-only on the server's text. Sessions are also reported stale
 *   when the meta room shows the file deleted, its epoch bumped, or our role changed between
 *   viewer and editor (readOnly mismatch).
 *
 * - Unsynced local edits: every local Y update bumps the session's `localSeq`; a barrier sent while
 *   the provider is synced confirms every update made before it (y-websocket has already sent them,
 *   and after a reconnect its SyncStep2 goes out before the 'sync' event), so `ackedSeq` catches up.
 *   A session whose local changes are not confirmed yet ("pending") is never destroyed by the
 *   idle LRU, by release() or by closeAll(): it keeps (re)connecting until the server has them
 *   ("draining" once nothing references it), then it is closed. `useDocSync` publishes the pending
 *   / unsynced file ids, and closing or reloading the tab asks first while anything is pending.
 * - Kept text (INT-1): a session closed for good while it still holds unconfirmed edits — its
 *   file was deleted, deleted and created again, replaced with a new epoch, its server copy
 *   reset, or our access changed; typically after editing offline — hands its whole text to
 *   ./recovered.ts before anything is dropped (reportLostEdits). The layout shows it in a
 *   persistent notice (copy / save as a new file / compare) until the user dismisses it. The
 *   session remembers its file's last known path for that (the file entry is gone by then).
 * - Sessions belong to the user signed in when they were created (`userId`, which also tags
 *   their kept text). Signing out (stores/auth onSignOut) destroys every session at once —
 *   never drains it: a draining socket would reconnect with a session cookie the server may
 *   still accept (logout while offline, SEC2-1) or with the next account's, and send the edits
 *   under that identity. After a logout in this tab (the user agreed to discard them) unconfirmed
 *   edits are dropped; when the session ended otherwise they are kept for that user.
 * - While the browser reports no network every provider is disconnected (./net.ts) and no session
 *   is created connected: an update written into a socket that cannot deliver waits in the
 *   browser's send buffer and would still reach the server when the network returns — after the
 *   logout that was supposed to stop it (SEC2-1). The edits stay local until the browser is back.
 *
 * Deviations (documented, contract unchanged):
 * - For 4409 the onStale notification waits until useProject.files carries the new epoch (at most
 *   STALE_EPOCH_FALLBACK_MS), so an editor re-acquiring immediately does not reconnect with the old
 *   epoch and get closed again in a loop.
 * - Extra API beyond §6.4: DocSession.{projectId,userId,status,stale,closeCode,onStatus,hasPendingChanges},
 *   docSessions.{onClosed,offlineFileIds,list,hasPendingChanges,pendingFileIds,unsyncedFileIds},
 *   useDocSync.
 * - closeAll() keeps sessions that still hold unsynced local edits (they close once synced).
 */
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import type { Awareness } from 'y-protocols/awareness'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import { YSyncConfig } from 'y-codemirror.next'
import type { FileEntry } from '@folio/shared/api'
import { DOC_TEXT_KEY, MSG_BARRIER, MSG_EVENT, MSG_QUERY_AWARENESS, WS_CLOSE, docServerUrl } from '@folio/shared/protocol'
import { randomId } from '../lib/format'
import { registerTestHook } from '../stores/testHooks'
import { onSignOut, useAuth } from '../stores/auth'
import { useProject } from '../stores/project'
import { browserOffline, onBrowserNetwork } from './net'
import { presenceUser } from './presence'
import { hasUnsavedRecovered, keepRecoveredText } from './recovered'
import { useDocSync, type DocSyncState } from './syncState'
import { wsBase } from './url'

export { useDocSync, type DocSyncState } from './syncState'

export type DocStatus = 'connecting' | 'connected' | 'disconnected'

export interface DocSession {
  fileId: string
  epoch: number
  ydoc: Y.Doc
  ytext: Y.Text
  provider: WebsocketProvider
  awareness: Awareness
  undoManager: Y.UndoManager
  readOnly: boolean
  /** resolves after the first sync with the server (never rejects) */
  synced: Promise<void>
  isSynced(): boolean
  destroy(): void
  projectId: string
  /** the user signed in when the session was created (null: nobody) */
  readonly userId: string | null
  /** socket state of this document */
  readonly status: DocStatus
  /** closed for good with STALE_EPOCH/GONE (or superseded): release it and acquire a new session */
  readonly stale: boolean
  /** code of a permanent close (4401/4403/4404/4409/4410/4413…), null while usable */
  readonly closeCode: number | null
  onStatus(fn: (status: DocStatus) => void): () => void
  /** local edits the server has not confirmed yet (made offline, or just now) */
  hasPendingChanges(): boolean
}

/** Max unreferenced sessions kept alive. */
export const MAX_IDLE_SESSIONS = 8
export const DEFAULT_BARRIER_TIMEOUT_MS = 10_000
/** Delay before a local change is confirmed with a barrier (batches a burst of keystrokes). */
const ACK_DELAY_MS = 300
const ACK_TIMEOUT_MS = 10_000
/** How long to wait for the meta room to announce a new epoch after a 4409 before telling listeners anyway. */
const STALE_EPOCH_FALLBACK_MS = 4000

const ACCESS_CODES: ReadonlySet<number> = new Set([WS_CLOSE.UNAUTHORIZED, WS_CLOSE.FORBIDDEN, WS_CLOSE.NOT_FOUND])
const ACCESS_RECHECK_MIN_INTERVAL_MS = 3000
let lastAccessRecheck = 0

// live sessions by `${fileId}:${epoch}`
const sessions = new Map<string, DocSessionImpl>()
// every non-destroyed session (also stale ones still referenced by an editor)
const allSessions = new Set<DocSessionImpl>()
// unreferenced live sessions, least recently released first
const idle = new Set<DocSessionImpl>()
// fileId → epoch of a 4409-closed session waiting for the meta room to announce the new epoch
const staleWaits = new Map<string, { epoch: number; timer: ReturnType<typeof setTimeout> }>()

const changeListeners = new Set<(fileId: string, local: boolean) => void>()
const staleListeners = new Set<(fileId: string) => void>()
const closedListeners = new Set<(fileId: string, code: number) => void>()

function callAll<A extends unknown[]>(set: Set<(...args: A) => void>, ...args: A): void {
  for (const fn of [...set]) {
    try {
      fn(...args)
    } catch (e) {
      console.error('[docSessions] listener failed', e)
    }
  }
}

class DocSessionImpl implements DocSession {
  readonly projectId: string
  readonly userId: string | null
  readonly fileId: string
  readonly epoch: number
  readonly key: string
  readonly readOnly: boolean
  readonly ydoc: Y.Doc
  readonly ytext: Y.Text
  readonly provider: WebsocketProvider
  readonly awareness: Awareness
  readonly undoManager: Y.UndoManager
  readonly synced: Promise<void>
  refs = 0
  destroyed = false
  /** unreferenced but kept alive until its pending local edits reach the server */
  draining = false
  /** unconfirmed edits of this session were given up (closed for good / destroyed) */
  private lostReported = false
  /** accessVersion of the project when an access close (4401/4403/4404) happened */
  closedAtAccessVersion = 0
  /** last known path of the file (kept for the recovery notice once the file entry is gone) */
  path: string
  /** some of the unconfirmed edits were made while the socket was down */
  private offlineEdits = false
  /** local Y updates so far, and how many of them the server confirmed (barrier echo) */
  private localSeq = 0
  private ackedSeq = 0
  private ackTimer: ReturnType<typeof setTimeout> | null = null
  private acking = false
  private resolveSynced: () => void = () => {}
  private syncedOnce = false
  private _status: DocStatus = browserOffline() ? 'disconnected' : 'connecting'
  private _stale = false
  private _closeCode: number | null = null
  private readonly barriers = new Map<string, (ok: boolean) => void>()
  private readonly statusListeners = new Set<(s: DocStatus) => void>()
  /** Y clients that ever had an awareness state here: collaborators (the server never has one) */
  private readonly seenClients = new Set<number>()

  constructor(projectId: string, file: FileEntry, readOnly: boolean) {
    this.projectId = projectId
    this.userId = useAuth.getState().me?.id ?? null
    this.fileId = file.id
    this.epoch = file.epoch
    this.key = sessionKey(file.id, file.epoch)
    this.path = file.path
    this.readOnly = readOnly
    this.ydoc = new Y.Doc()
    this.ytext = this.ydoc.getText(DOC_TEXT_KEY)
    this.undoManager = new Y.UndoManager(this.ytext, {
      captureTimeout: 500,
      // any y-codemirror.next binding (matched by constructor) — never remote/provider updates
      trackedOrigins: new Set<unknown>([YSyncConfig]),
    })
    this.synced = new Promise<void>(resolve => {
      this.resolveSynced = resolve
    })
    this.provider = new WebsocketProvider(docServerUrl(wsBase(), projectId), encodeURIComponent(file.id), this.ydoc, {
      params: { epoch: String(file.epoch) },
      disableBc: true,
      // while the browser has no network nothing is written to a socket (see ./net.ts); the
      // 'online' event connects the session and sends what was typed meanwhile
      connect: !browserOffline(),
    })
    this.awareness = this.provider.awareness
    this.awareness.on('change', ({ added, updated }: { added: number[]; updated: number[] }) => {
      for (const id of added) this.seenClients.add(id)
      for (const id of updated) this.seenClients.add(id)
    })
    this.provider.messageHandlers[MSG_BARRIER] = (_encoder, decoder) => this.onBarrierEcho(decoder)
    // not expected on doc rooms; registered so y-websocket does not log "Unable to compute message"
    this.provider.messageHandlers[MSG_EVENT] = () => {}

    this.provider.on('status', ({ status }) => {
      if (this.destroyed) return
      if (status === 'connected') this.queryAwareness()
      this.setStatus(status)
    })
    this.provider.on('sync', (isSynced: boolean) => {
      if (!isSynced || this.destroyed) return
      // (re)synced: local edits made while offline went out with our SyncStep2 — confirm them
      publishSyncState()
      this.scheduleAck(0)
      if (this.syncedOnce) return
      this.syncedOnce = true
      this.resolveSynced()
    })
    this.ydoc.on('update', (_update: Uint8Array, origin: unknown) => {
      if (origin === this.provider || this.destroyed) return
      const was = this.hasPendingChanges()
      if (!this.provider.wsconnected) this.offlineEdits = true
      this.localSeq++
      if (!was) publishSyncState()
      this.scheduleAck()
    })
    this.provider.on('connection-close', () => {
      // pending barriers can no longer be echoed on this socket
      this.flushBarriers()
      if (!this.destroyed) this.setStatus('disconnected')
    })
    this.provider.on('closed', ({ code, reason }) => {
      if (!this.destroyed) onPermanentClose(this, code, reason)
    })
    this.ytext.observe((_event, transaction) => {
      if (!this.syncedOnce || this.destroyed) return
      if (!transaction.local) this.dropUndoAfterServerChange(transaction)
      callAll(changeListeners, this.fileId, transaction.local)
    })
    this.updateAwarenessUser()
  }

  get status(): DocStatus {
    return this._status
  }

  get stale(): boolean {
    return this._stale
  }

  get closeCode(): number | null {
    return this._closeCode
  }

  isSynced(): boolean {
    return this.syncedOnce
  }

  hasPendingChanges(): boolean {
    return this.localSeq > this.ackedSeq
  }

  /** pending local edits that cannot be sent right now (socket down, or reconnected but not synced) */
  isUnsynced(): boolean {
    return this.hasPendingChanges() && !(this.provider.wsconnected && this.provider.synced)
  }

  /** usable for editing/barriers: not destroyed, not stale, not closed */
  isLive(): boolean {
    return !this.destroyed && !this._stale && this._closeCode === null
  }

  onStatus(fn: (status: DocStatus) => void): () => void {
    this.statusListeners.add(fn)
    return () => {
      this.statusListeners.delete(fn)
    }
  }

  setClosed(code: number): void {
    if (this._closeCode !== null) return
    this._closeCode = code
    this.reportLostEdits()
    publishSyncState()
  }

  /**
   * Closed for good while holding edits the server never confirmed: count them as lost (once)
   * and keep the text — the server copy plus those edits — for the recovery notice.
   */
  reportLostEdits(): void {
    if (this.lostReported || !this.hasPendingChanges()) return
    this.lostReported = true
    try {
      keepRecoveredText({
        userId: this.userId,
        projectId: this.projectId,
        fileId: this.fileId,
        epoch: this.epoch,
        path: this.path,
        text: this.ytext.toString(),
        code: this._closeCode,
        offline: this.offlineEdits,
      })
    } catch (e) {
      console.error('[docSessions] could not keep the text of a closed document', e)
    }
    const { lost } = useDocSync.getState()
    useDocSync.setState({ lost: { ...lost, [this.projectId]: (lost[this.projectId] ?? 0) + 1 } })
  }

  /** Its unconfirmed edits are given up without keeping them (a logout the user agreed to). */
  discardPendingEdits(): void {
    this.lostReported = true
  }

  markStale(code: number): boolean {
    if (this._stale) return false
    this._stale = true
    this.setClosed(code)
    this.stopConnecting()
    publishSyncState()
    return true
  }

  stopConnecting(): void {
    try {
      this.provider.disconnect()
    } catch {
      // already closed
    }
  }

  /**
   * The browser reports no network: close the socket now instead of writing into a buffer the
   * browser would flush when the network returns — possibly after a logout (SEC2-1, ./net.ts).
   * The edits made meanwhile stay local and go out on the next connection.
   */
  networkLost(): void {
    if (this.destroyed) return
    this.stopConnecting()
  }

  /** The browser has a network again: reconnect (a stale/closed session stays closed). */
  networkBack(): void {
    if (this.destroyed || !this.isLive()) return
    try {
      this.provider.connect()
    } catch (e) {
      console.warn('[docSessions] could not reconnect after the network came back', e)
    }
  }

  updateAwarenessUser(): void {
    if (this.destroyed) return
    const me = useAuth.getState().me
    if (me) this.awareness.setLocalStateField('user', presenceUser(me))
  }

  /**
   * MSG_BARRIER round-trip; resolves true when echoed, false when offline/closed/timed out.
   * An echo of a barrier sent while synced also confirms every local edit made before it.
   */
  barrier(timeoutMs: number): Promise<boolean> {
    const ws = this.provider.ws
    if (!this.isLive() || !this.provider.wsconnected || !ws || ws.readyState !== 1) return Promise.resolve(false)
    const nonce = randomId(20)
    const seq = this.localSeq
    const confirms = this.provider.synced
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => finish(false), Math.max(0, timeoutMs))
      const finish = (ok: boolean) => {
        clearTimeout(timer)
        this.barriers.delete(nonce)
        if (ok && confirms) this.confirm(seq)
        resolve(ok)
      }
      this.barriers.set(nonce, finish)
      const enc = encoding.createEncoder()
      encoding.writeVarUint(enc, MSG_BARRIER)
      encoding.writeVarString(enc, nonce)
      try {
        ws.send(encoding.toUint8Array(enc))
      } catch {
        finish(false)
      }
    })
  }

  /**
   * A remote change that inserted text authored by a client never seen in awareness — the
   * server (restore, upload, outside edit), or collaborators who left before we reconnected —
   * makes the undo history unsafe (see the header): clear it.
   */
  private dropUndoAfterServerChange(tr: Y.Transaction): void {
    const um = this.undoManager
    if (um.undoStack.length === 0 && um.redoStack.length === 0) return
    const current = this.awareness.getStates()
    for (const [client, clock] of tr.afterState) {
      if (clock === (tr.beforeState.get(client) ?? 0)) continue
      if (client === this.ydoc.clientID || this.seenClients.has(client) || current.has(client)) continue
      um.clear()
      return
    }
  }

  /** Send a confirmation barrier for pending local edits (soon, or after `delay` ms). */
  scheduleAck(delay = ACK_DELAY_MS): void {
    if (this.destroyed || !this.hasPendingChanges()) return
    if (this.ackTimer !== null) {
      if (delay > 0) return
      clearTimeout(this.ackTimer)
    }
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null
      void this.runAck()
    }, delay)
  }

  private async runAck(): Promise<void> {
    // not synced: the next 'sync' event schedules the confirmation again
    if (this.acking || this.destroyed || !this.hasPendingChanges() || !this.provider.synced) return
    this.acking = true
    try {
      await this.barrier(ACK_TIMEOUT_MS)
    } finally {
      this.acking = false
    }
    // edits made meanwhile, or a timed-out echo on a live socket
    if (this.hasPendingChanges() && this.provider.synced) this.scheduleAck()
  }

  private confirm(seq: number): void {
    if (seq <= this.ackedSeq) return
    const was = this.hasPendingChanges()
    this.ackedSeq = Math.min(seq, this.localSeq)
    if (!this.hasPendingChanges()) this.offlineEdits = false
    if (was && !this.hasPendingChanges()) onChangesConfirmed(this)
  }

  destroy(): void {
    if (this.destroyed) return
    this.reportLostEdits()
    this.destroyed = true
    // before anything below can throw: this session's socket sends nothing from now on
    this.stopConnecting()
    this.draining = false
    if (this.ackTimer !== null) clearTimeout(this.ackTimer)
    this.ackTimer = null
    if (sessions.get(this.key) === this) sessions.delete(this.key)
    idle.delete(this)
    allSessions.delete(this)
    this.flushBarriers()
    this.statusListeners.clear()
    try {
      this.undoManager.destroy()
    } catch (e) {
      console.warn('[docSessions] undo manager destroy failed', e)
    }
    try {
      // disconnect() inside also tells peers our awareness state is gone
      this.provider.destroy()
    } catch (e) {
      console.warn('[docSessions] provider destroy failed', e)
    }
    // also destroys the Awareness (it listens to the doc's destroy event)
    this.ydoc.destroy()
    publishSyncState()
  }

  private setStatus(status: DocStatus): void {
    if (this._status === status) return
    this._status = status
    callAll(this.statusListeners, status)
    publishSyncState()
  }

  private flushBarriers(): void {
    for (const finish of [...this.barriers.values()]) finish(false)
    this.barriers.clear()
  }

  private onBarrierEcho(decoder: decoding.Decoder): void {
    try {
      const nonce = decoding.readVarString(decoder)
      this.barriers.get(nonce)?.(true)
    } catch (e) {
      console.warn('[docSessions] malformed barrier echo', e)
    }
  }

  private queryAwareness(): void {
    const ws = this.provider.ws
    if (!ws || ws.readyState !== 1) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_QUERY_AWARENESS)
    try {
      ws.send(encoding.toUint8Array(enc))
    } catch {
      // closing
    }
  }
}

function sessionKey(fileId: string, epoch: number): string {
  return `${fileId}:${epoch}`
}

function sameRefs(a: readonly { fileId: string; projectId: string }[], b: readonly { fileId: string; projectId: string }[]): boolean {
  return a.length === b.length && a.every((x, i) => x.fileId === b[i].fileId && x.projectId === b[i].projectId)
}

/** Recompute useDocSync (cheap: a handful of sessions). */
function publishSyncState(): void {
  const pending: DocSyncState['pending'] = []
  const unsynced: DocSyncState['unsynced'] = []
  for (const s of allSessions) {
    if (!s.isLive() || !s.hasPendingChanges()) continue
    pending.push({ fileId: s.fileId, projectId: s.projectId })
    if (s.isUnsynced()) unsynced.push({ fileId: s.fileId, projectId: s.projectId })
  }
  const cur = useDocSync.getState()
  if (sameRefs(cur.pending, pending) && sameRefs(cur.unsynced, unsynced)) return
  useDocSync.setState({ pending, unsynced })
}

/** Keep at most MAX_IDLE_SESSIONS idle sessions; sessions with unsynced edits are never evicted. */
function trimIdle(): void {
  for (const s of [...idle]) {
    if (idle.size <= MAX_IDLE_SESSIONS) break
    if (s.hasPendingChanges()) continue
    idle.delete(s)
    s.destroy()
  }
}

/** The server confirmed every local edit of `s`: finish a drain, or let the LRU trim it again. */
function onChangesConfirmed(s: DocSessionImpl): void {
  publishSyncState()
  if (s.destroyed) return
  if (s.draining && s.refs === 0) {
    s.draining = false
    const current = s.isLive() && sessions.get(s.key) === s && s.projectId === useProject.getState().projectId
    if (!current) {
      s.destroy()
      return
    }
    idle.delete(s)
    idle.add(s)
  }
  trimIdle()
}

/** Unreferenced session that must not be dropped yet: it keeps syncing, then closes itself. */
function drain(s: DocSessionImpl): void {
  idle.delete(s)
  s.draining = true
  if (s.awareness.getLocalState()?.cursor != null) s.awareness.setLocalStateField('cursor', null)
  s.scheduleAck(0)
}

/** Remove a session from the cache (a later acquire creates a fresh one); destroy it when unreferenced. */
function retire(s: DocSessionImpl): void {
  if (sessions.get(s.key) === s) sessions.delete(s.key)
  if (s.refs === 0) s.destroy()
}

function notifyStale(fileId: string): void {
  const wait = staleWaits.get(fileId)
  if (wait) {
    clearTimeout(wait.timer)
    staleWaits.delete(fileId)
  }
  callAll(staleListeners, fileId)
}

/** After a 4409 the meta room usually announces the new epoch a moment later; notify once it has. */
function notifyWhenNewEpochKnown(s: DocSessionImpl): void {
  const known = useProject.getState().files[s.fileId]
  if (!known || known.kind !== 'text' || known.epoch > s.epoch) {
    notifyStale(s.fileId)
    return
  }
  const prev = staleWaits.get(s.fileId)
  if (prev) clearTimeout(prev.timer)
  const timer = setTimeout(() => {
    staleWaits.delete(s.fileId)
    callAll(staleListeners, s.fileId)
  }, STALE_EPOCH_FALLBACK_MS)
  staleWaits.set(s.fileId, { epoch: s.epoch, timer })
}

function onPermanentClose(s: DocSessionImpl, code: number, _reason: string): void {
  if (code === WS_CLOSE.STALE_EPOCH || code === WS_CLOSE.GONE) {
    if (!s.markStale(code)) return
    retire(s)
    if (code === WS_CLOSE.GONE) notifyStale(s.fileId)
    else notifyWhenNewEpochKnown(s)
    return
  }
  s.setClosed(code)
  s.stopConnecting()
  retire(s)
  callAll(closedListeners, s.fileId, code)
  // a draining session of a project that is no longer open: nothing to re-check
  if (ACCESS_CODES.has(code) && s.projectId === useProject.getState().projectId) {
    s.closedAtAccessVersion = useProject.getState().accessVersion
    scheduleAccessRecheck(code === WS_CLOSE.UNAUTHORIZED ? 'session' : 'project')
  }
}

let accessRecheckTimer: ReturnType<typeof setTimeout> | null = null
let recheckSession = false
let recheckProject = false

/**
 * Re-check access over REST after an access close (4401/4403/4404) — typically our role changed
 * (a viewer's socket refusing edits made while we were still an editor). Rate-limited so a
 * misbehaving server cannot drive a reconnect/re-check loop, but never dropped: a close inside
 * the interval runs one re-check at its end (a session closed after the previous re-check
 * completed would otherwise wait for a later access change to become stale and reopen).
 */
function scheduleAccessRecheck(what: 'session' | 'project'): void {
  if (what === 'session') recheckSession = true
  else recheckProject = true
  if (accessRecheckTimer !== null) return
  const wait = lastAccessRecheck + ACCESS_RECHECK_MIN_INTERVAL_MS - Date.now()
  if (wait > 0) {
    accessRecheckTimer = setTimeout(() => {
      accessRecheckTimer = null
      runAccessRecheck()
    }, wait)
    return
  }
  runAccessRecheck()
}

function runAccessRecheck(): void {
  lastAccessRecheck = Date.now()
  const session = recheckSession
  const project = recheckProject
  recheckSession = false
  recheckProject = false
  if (session) void useAuth.getState().init()
  // a successful re-check bumps accessVersion → revalidate() reports the closed sessions stale
  if (project && useProject.getState().projectId) {
    useProject.getState().reload().catch(e => console.warn('[docSessions] access re-check failed', e))
  }
}

/** Compare live sessions with the project state (files, epochs, role) after it changed. */
function revalidate(): void {
  const st = useProject.getState()
  if (st.loadState !== 'ready') return
  for (const [fileId, wait] of [...staleWaits]) {
    const f = st.files[fileId]
    if (!f || f.kind !== 'text' || f.epoch > wait.epoch) notifyStale(fileId)
  }
  const readOnly = st.role === 'viewer'
  const toNotify = new Set<string>()
  for (const s of [...allSessions]) {
    if (s.destroyed || s.stale || s.projectId !== st.projectId) continue
    const f = st.files[s.fileId]
    // renamed/moved: follow it (the session stays valid)
    if (f && f.kind !== 'folder') s.path = f.path
    let code: number | null = null
    if (!f || f.kind !== 'text') code = WS_CLOSE.GONE
    else if (f.epoch > s.epoch) code = WS_CLOSE.STALE_EPOCH
    else if (s.closeCode !== null && ACCESS_CODES.has(s.closeCode)) {
      if (st.accessVersion > s.closedAtAccessVersion) code = s.closeCode
    } else if (s.closeCode === null && s.readOnly !== readOnly) code = WS_CLOSE.FORBIDDEN
    if (code === null) continue
    s.markStale(code)
    retire(s)
    toNotify.add(s.fileId)
  }
  for (const fileId of toNotify) notifyStale(fileId)
}

/**
 * Close every session (project unload/switch) — except those still holding local edits the
 * server has not confirmed: they stay connected (reconnecting) until it has, then close.
 * Opening the same project again picks them up with the edits.
 */
function closeAll(): void {
  for (const s of [...allSessions]) {
    if (s.isLive() && s.hasPendingChanges()) drain(s)
    else s.destroy()
  }
  idle.clear()
  for (const w of staleWaits.values()) clearTimeout(w.timer)
  staleWaits.clear()
  publishSyncState()
}

/**
 * Signing out: destroy every session now — never drain one (see the header). `discard`: the
 * unconfirmed edits are dropped (the user logged out knowing it); otherwise they are kept.
 */
function destroyAll(discard: boolean): void {
  for (const s of [...allSessions]) {
    if (discard) s.discardPendingEdits()
    s.destroy()
  }
  sessions.clear()
  idle.clear()
  for (const w of staleWaits.values()) clearTimeout(w.timer)
  staleWaits.clear()
  if (accessRecheckTimer !== null) clearTimeout(accessRecheckTimer)
  accessRecheckTimer = null
  recheckSession = false
  recheckProject = false
  useDocSync.setState({ pending: [], unsynced: [], lost: {} })
}

/** Live sessions with local edits the server has not confirmed yet. */
function pendingSessions(projectId?: string): DocSessionImpl[] {
  return [...allSessions].filter(s => s.isLive() && s.hasPendingChanges() && (projectId === undefined || s.projectId === projectId))
}

function onBeforeUnload(e: BeforeUnloadEvent): void {
  // kept texts survive a reload (sessionStorage), not closing the tab
  if (pendingSessions().length === 0 && !hasUnsavedRecovered()) return
  // try once more; the prompt gives the socket a moment
  for (const s of pendingSessions()) s.scheduleAck(0)
  e.preventDefault()
  // legacy browsers need returnValue set to show the prompt
  e.returnValue = ''
}

/** Usable sessions of the open project (sessions of a project left earlier may still be draining). */
function liveSessions(): DocSessionImpl[] {
  const projectId = useProject.getState().projectId
  return [...allSessions].filter(s => s.isLive() && s.projectId === projectId)
}

let wired = false
export function wireDocs(): void {
  if (wired) return
  wired = true
  useProject.subscribe((s, prev) => {
    if (s.projectId !== prev.projectId) {
      closeAll()
      return
    }
    if (s.files !== prev.files || s.role !== prev.role || s.accessVersion !== prev.accessVersion || s.loadState !== prev.loadState) revalidate()
  })
  useAuth.subscribe((s, prev) => {
    if (s.me !== prev.me) for (const x of allSessions) x.updateAwarenessUser()
  })
  onSignOut(({ reason }) => destroyAll(reason === 'logout'))
  // the browser lost / regained its network: never write into a socket that cannot deliver
  onBrowserNetwork(offline => {
    for (const s of [...allSessions]) {
      if (offline) s.networkLost()
      else s.networkBack()
    }
  })
  if (typeof window !== 'undefined') {
    // replaced, not duplicated, when this module is hot-reloaded
    const g = window as Window & { __folioDocsUnload?: (e: BeforeUnloadEvent) => void }
    if (g.__folioDocsUnload) window.removeEventListener('beforeunload', g.__folioDocsUnload)
    g.__folioDocsUnload = onBeforeUnload
    window.addEventListener('beforeunload', onBeforeUnload)
  }
}
queueMicrotask(wireDocs)

export const docSessions = {
  /**
   * Get (or create) the session of a text file, cached per fileId:epoch and ref-counted.
   * Every acquire must be paired with one release.
   */
  acquire(projectId: string, file: FileEntry): DocSession {
    wireDocs()
    if (file.kind !== 'text') throw new Error(`docSessions.acquire: "${file.path}" is not a text file`)
    const key = sessionKey(file.id, file.epoch)
    let s = sessions.get(key)
    if (s && (!s.isLive() || s.projectId !== projectId || s.userId !== (useAuth.getState().me?.id ?? null))) {
      retire(s)
      s = undefined
    }
    if (!s) {
      // older epochs of the same file are superseded
      for (const other of [...allSessions]) {
        if (other.fileId === file.id && other.epoch < file.epoch && !other.stale) {
          other.markStale(WS_CLOSE.STALE_EPOCH)
          retire(other)
        }
      }
      s = new DocSessionImpl(projectId, file, useProject.getState().role === 'viewer')
      sessions.set(key, s)
      allSessions.add(s)
    }
    idle.delete(s)
    s.draining = false
    s.path = file.path
    s.refs++
    return s
  },

  /**
   * Drop one reference; unreferenced sessions stay connected in a small LRU (≤ 8, plus any that
   * still hold unsynced edits — those are never evicted before the server has confirmed them).
   */
  release(session: DocSession): void {
    const s = session as DocSessionImpl
    if (s.destroyed || s.refs === 0) return
    s.refs--
    if (s.refs > 0) return
    if (!s.isLive()) {
      s.destroy()
      return
    }
    if (sessions.get(s.key) !== s || s.projectId !== useProject.getState().projectId) {
      if (s.hasPendingChanges()) drain(s)
      else s.destroy()
      return
    }
    // no editor shows this file any more: stop showing our caret to collaborators
    // (y-codemirror.next does not clear the awareness cursor when its view is destroyed)
    if (s.awareness.getLocalState()?.cursor != null) s.awareness.setLocalStateField('cursor', null)
    s.draining = false
    idle.delete(s)
    idle.add(s)
    trimIdle()
  },

  /** The live session of a file (newest epoch), whether referenced or idle. */
  get(fileId: string): DocSession | undefined {
    let best: DocSessionImpl | undefined
    for (const s of allSessions) {
      if (s.fileId === fileId && s.isLive() && (!best || s.epoch > best.epoch)) best = s
    }
    return best
  },

  /**
   * MSG_BARRIER round-trip on every connected session. Resolves when all were echoed, or
   * immediately for none/offline sessions, or after `timeoutMs`. Never rejects.
   */
  async barrierAll(timeoutMs: number = DEFAULT_BARRIER_TIMEOUT_MS): Promise<void> {
    await Promise.all(liveSessions().map(s => s.barrier(timeoutMs)))
  },

  /** Files whose session is synced but currently offline (their latest edits may not be on the server). */
  offlineFileIds(): string[] {
    return liveSessions().filter(s => s.isSynced() && !s.provider.wsconnected).map(s => s.fileId)
  },

  /** True while some session (of `projectId`, or any) holds local edits the server has not confirmed. */
  hasPendingChanges(projectId?: string): boolean {
    return pendingSessions(projectId).length > 0
  },

  /** Files with local edits the server has not confirmed yet (of `projectId`, or any project). */
  pendingFileIds(projectId?: string): string[] {
    return pendingSessions(projectId).map(s => s.fileId)
  },

  /** Files with unconfirmed local edits that cannot be sent right now (socket down / not synced). */
  unsyncedFileIds(projectId?: string): string[] {
    return pendingSessions(projectId).filter(s => s.isUnsynced()).map(s => s.fileId)
  },

  /** Any Y.Text change after the initial sync; `local` = made by this client. */
  onChange(fn: (fileId: string, local: boolean) => void): () => void {
    changeListeners.add(fn)
    return () => {
      changeListeners.delete(fn)
    }
  },

  /** The file's session was closed with STALE_EPOCH/GONE (or superseded): release it and re-acquire. */
  onStale(fn: (fileId: string) => void): () => void {
    staleListeners.add(fn)
    return () => {
      staleListeners.delete(fn)
    }
  },

  /** Any other permanent close (4401/4403/4404/4413…) of a file's socket. */
  onClosed(fn: (fileId: string, code: number) => void): () => void {
    closedListeners.add(fn)
    return () => {
      closedListeners.delete(fn)
    }
  },

  /** Every session currently open (debugging/tests). */
  list(): DocSession[] {
    return [...allSessions]
  },

  /** Destroy every session (project unload); sessions with unsynced edits close once synced. */
  closeAll,
}

registerTestHook('docSessions', docSessions)
registerTestHook('useDocSync', useDocSync)
