/**
 * Connection + room plumbing shared by the doc rooms (CollabService) and the project meta rooms
 * (MetaService): per-connection ordered message queue, y-websocket message dispatch, awareness
 * relay (rebroadcast to every connection including the sender, filtered so a connection can only
 * publish/remove its own clients' states and always under its authenticated identity), barrier
 * echo, keepalive frames and ws-level ping/terminate.
 */
import * as decoding from 'lib0/decoding'
import type { WebSocket } from 'ws'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import type { Role, UserPublic } from '@folio/shared/api'
import { MSG_AWARENESS, MSG_BARRIER, MSG_QUERY_AWARENESS, MSG_SYNC, WS_CLOSE, type PresenceUser } from '@folio/shared/protocol'
import { errInfo, type CollabLogger } from './log.ts'
import {
  KEEPALIVE_FRAME, MAX_AWARENESS_STATE_BYTES, ProtocolError, decodeAwarenessUpdate, encodeAwarenessEntries,
  encodeAwarenessMessage, encodeBarrierReply, toBytes, type AwarenessEntry,
} from './wire.ts'

/** Close codes used locally (1011 / 1013 are listed in WS_CLOSE, protocol.ts). */
export const CLOSE_BAD_MESSAGE = 4400
export const CLOSE_INTERNAL = WS_CLOSE.INTERNAL
export const CLOSE_TRY_AGAIN = WS_CLOSE.TRY_AGAIN

const MAX_QUEUED_MESSAGES = 2000
const MAX_QUEUED_BYTES = 32 * 1024 * 1024
/** a connection whose unsent buffer exceeds this is too slow to keep */
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024
const MAX_NONCE_LENGTH = 256

export function presenceOf(user: UserPublic): PresenceUser {
  return { id: user.id, name: user.name, color: user.color, colorLight: `${user.color}33` }
}

export class Conn {
  readonly clientIds = new Set<number>()
  readonly presence: PresenceUser
  queue: Uint8Array[] = []
  queuedBytes = 0
  /** initial sync messages sent (the room is ready for this connection) */
  started = false
  closed = false
  alive = true
  /** when this connection's session was last checked against the database (see DocRoom) */
  sessionCheckedAt = Date.now()

  constructor(
    readonly ws: WebSocket,
    readonly user: UserPublic,
    readonly role: Role,
    readonly readOnly: boolean,
    /** sha256 of the session token the socket was opened with (null: unknown) */
    readonly session: string | null = null,
  ) {
    this.presence = presenceOf(user)
  }
}

export abstract class BaseRoom {
  readonly doc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  readonly conns = new Set<Conn>()
  destroyed = false
  /** set once the room is being dropped (connections are closed without per-connection side effects) */
  protected tearingDown = false

  constructor(protected readonly log: CollabLogger, readonly label: string) {
    this.doc = new Y.Doc({ gc: true })
    this.awareness = new awarenessProtocol.Awareness(this.doc)
    this.awareness.setLocalState(null) // the server itself publishes no presence
    // the outdated-state check timer must not keep a CLI process alive
    this.awareness._checkInterval?.unref?.()
    this.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }) => {
      const changed = added.concat(updated, removed)
      if (changed.length === 0 || this.destroyed) return
      this.broadcast(encodeAwarenessMessage(awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed)))
    })
  }

  /** true once the room's document is loaded and messages can be applied */
  protected abstract isReady(): boolean
  /** handle a MSG_SYNC message (the type byte has been consumed) */
  protected abstract onSyncMessage(conn: Conn, dec: decoding.Decoder): void
  /** turn a client's awareness state into the state stored/relayed by the server (null = drop the entry) */
  protected abstract sanitizeState(conn: Conn, state: Record<string, unknown>): Record<string, unknown> | null
  /** called when the last connection left */
  protected abstract onEmpty(): void
  /** first messages sent to a connection once the room is ready */
  protected abstract initialMessages(conn: Conn): Uint8Array[]

  // -------------------------------------------------------------------------
  // Connections
  // -------------------------------------------------------------------------

  addConn(conn: Conn): void {
    this.conns.add(conn)
    conn.ws.on('message', (data, isBinary) => this.onRaw(conn, data, isBinary))
    conn.ws.on('pong', () => { conn.alive = true })
    conn.ws.on('close', () => this.closeConn(conn))
    conn.ws.on('error', err => this.log.debug({ room: this.label, ...errInfo(err) }, 'websocket error'))
    if (this.isReady()) this.start(conn)
  }

  /** Called by subclasses once the document finished loading. */
  protected startAll(): void {
    for (const conn of [...this.conns]) this.start(conn)
  }

  private start(conn: Conn): void {
    if (conn.closed || conn.started) return
    conn.started = true
    for (const msg of this.initialMessages(conn)) this.send(conn, msg)
    const states = this.awareness.getStates()
    if (states.size > 0) {
      this.send(conn, encodeAwarenessMessage(awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()])))
    }
    this.drain(conn)
  }

  private onRaw(conn: Conn, data: Parameters<typeof toBytes>[0], isBinary: boolean): void {
    if (conn.closed) return
    conn.alive = true
    if (!isBinary) {
      this.closeConn(conn, CLOSE_BAD_MESSAGE, 'binary frames only')
      return
    }
    const bytes = toBytes(data)
    if (conn.started && conn.queue.length === 0) {
      this.handle(conn, bytes)
      return
    }
    // room still loading: keep the socket's messages in arrival order
    conn.queue.push(bytes)
    conn.queuedBytes += bytes.byteLength
    if (conn.queue.length > MAX_QUEUED_MESSAGES || conn.queuedBytes > MAX_QUEUED_BYTES) {
      this.closeConn(conn, CLOSE_TRY_AGAIN, 'too many pending messages')
    }
  }

  private drain(conn: Conn): void {
    while (!conn.closed && conn.queue.length > 0) {
      const msg = conn.queue.shift()!
      conn.queuedBytes -= msg.byteLength
      this.handle(conn, msg)
    }
    conn.queuedBytes = 0
  }

  /** Process one message synchronously; everything received earlier on this socket has been applied. */
  private handle(conn: Conn, msg: Uint8Array): void {
    if (conn.closed || this.destroyed) return
    try {
      const dec = decoding.createDecoder(msg)
      const type = decoding.readVarUint(dec)
      switch (type) {
        case MSG_SYNC:
          this.onSyncMessage(conn, dec)
          break
        case MSG_AWARENESS:
          this.onAwareness(conn, decoding.readVarUint8Array(dec))
          break
        case MSG_QUERY_AWARENESS:
          this.send(conn, encodeAwarenessMessage(awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...this.awareness.getStates().keys()])))
          break
        case MSG_BARRIER: {
          const nonce = decoding.readVarString(dec)
          if (nonce.length > MAX_NONCE_LENGTH) throw new ProtocolError('barrier nonce too long')
          this.send(conn, encodeBarrierReply(nonce))
          break
        }
        default:
          // unknown / server-only message types (auth, events) are ignored
          break
      }
    } catch (err) {
      if (err instanceof ProtocolError) {
        this.log.warn({ room: this.label, user: conn.user.id, reason: err.message }, 'rejected client message')
      } else {
        this.log.warn({ room: this.label, user: conn.user.id, ...errInfo(err) }, 'bad client message')
      }
      this.closeConn(conn, CLOSE_BAD_MESSAGE, 'bad message')
    }
  }

  private onAwareness(conn: Conn, update: Uint8Array): void {
    const entries = decodeAwarenessUpdate(update)
    const accepted: AwarenessEntry[] = []
    const removals: number[] = []
    for (const e of entries) {
      if (e.clientID === this.awareness.clientID) continue
      const owner = this.ownerOf(e.clientID)
      // another user's client id: ignore (clients echo every state they receive back to the server);
      // the same user reconnecting before its old socket was reaped takes the id over
      if (owner && owner !== conn && owner.user.id !== conn.user.id) continue
      if (e.json.length > MAX_AWARENESS_STATE_BYTES) continue
      let state: unknown
      try {
        state = JSON.parse(e.json)
      } catch {
        throw new ProtocolError('invalid awareness state JSON')
      }
      let json: string
      if (state === null) {
        // only the owner may remove a state (unowned removals are echoes of removals we sent)
        if (!owner) continue
        removals.push(e.clientID)
        json = 'null'
      } else {
        if (typeof state !== 'object' || Array.isArray(state)) continue
        const clean = this.sanitizeState(conn, state as Record<string, unknown>)
        if (!clean) continue
        json = JSON.stringify(clean)
      }
      if (owner && owner !== conn) owner.clientIds.delete(e.clientID)
      conn.clientIds.add(e.clientID)
      accepted.push({ clientID: e.clientID, clock: e.clock, json })
    }
    if (accepted.length === 0) return
    awarenessProtocol.applyAwarenessUpdate(this.awareness, encodeAwarenessEntries(accepted), conn)
    for (const id of removals) conn.clientIds.delete(id)
  }

  private ownerOf(clientID: number): Conn | undefined {
    for (const c of this.conns) if (c.clientIds.has(clientID)) return c
    return undefined
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  send(conn: Conn, msg: Uint8Array): void {
    if (conn.closed) return
    const ws = conn.ws
    if (ws.readyState !== ws.OPEN) {
      if (ws.readyState !== ws.CONNECTING) this.closeConn(conn)
      return
    }
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      // a close frame would queue behind the backlog: drop the socket outright
      this.log.warn({ room: this.label, user: conn.user.id }, 'dropping slow connection')
      this.closeConn(conn)
      ws.terminate()
      return
    }
    ws.send(msg, err => {
      if (err) this.closeConn(conn)
    })
  }

  /** Send to every started connection (connections still waiting for the load get the state in their initial sync). */
  broadcast(msg: Uint8Array): void {
    for (const conn of this.conns) if (conn.started) this.send(conn, msg)
  }

  keepalive(): void {
    for (const conn of this.conns) if (conn.started) this.send(conn, KEEPALIVE_FRAME)
  }

  /** ws-level heartbeat: terminate sockets that did not answer the previous ping. */
  heartbeat(): void {
    for (const conn of [...this.conns]) {
      if (!conn.alive) {
        this.log.debug({ room: this.label, user: conn.user.id }, 'terminating unresponsive socket')
        this.closeConn(conn)
        conn.ws.terminate()
        continue
      }
      conn.alive = false
      try {
        conn.ws.ping()
      } catch {
        this.closeConn(conn)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Closing
  // -------------------------------------------------------------------------

  /**
   * Detach a connection: stop processing its messages, drop its awareness states (broadcasting
   * the removal) and close the socket with `code` when given.
   */
  closeConn(conn: Conn, code?: number, reason?: string): void {
    if (conn.closed) return
    conn.closed = true
    conn.queue = []
    conn.queuedBytes = 0
    this.conns.delete(conn)
    const ids = [...conn.clientIds]
    conn.clientIds.clear()
    if (ids.length > 0 && !this.destroyed && !this.tearingDown) {
      awarenessProtocol.removeAwarenessStates(this.awareness, ids, null)
      // forget the clocks so the same client re-announcing itself after a reconnect is accepted
      for (const id of ids) this.awareness.meta.delete(id)
    }
    const ws = conn.ws
    if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
      try {
        if (code !== undefined) ws.close(code, (reason ?? '').slice(0, 120))
        else ws.close()
      } catch {
        ws.terminate()
      }
    }
    if (this.conns.size === 0 && !this.destroyed && !this.tearingDown) this.onEmpty()
  }

  /**
   * Close every connection with `code` as part of dropping the room: no awareness broadcasts
   * and no onEmpty callback. The room must be destroyed afterwards.
   */
  closeAll(code: number, reason: string): void {
    this.tearingDown = true
    for (const conn of [...this.conns]) this.closeConn(conn, code, reason)
  }

  destroy(): void {
    if (this.destroyed) return
    this.tearingDown = true
    for (const conn of [...this.conns]) this.closeConn(conn)
    this.destroyed = true
    this.awareness.destroy()
    this.doc.destroy()
  }
}
