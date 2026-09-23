/**
 * y-websocket 3.1.0 wire format helpers (varUint message type, then payload) plus the
 * validation applied to client-supplied Yjs updates and awareness updates.
 */
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import type { RawData } from 'ws'
import * as syncProtocol from 'y-protocols/sync'
import * as Y from 'yjs'
import { MSG_AWARENESS, MSG_BARRIER, MSG_EVENT, MSG_SYNC } from '@folio/shared/protocol'

export function toBytes(data: RawData): Uint8Array {
  if (Array.isArray(data)) return new Uint8Array(Buffer.concat(data))
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
}

export function encodeSyncStep1(doc: Y.Doc): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_SYNC)
  syncProtocol.writeSyncStep1(enc, doc)
  return encoding.toUint8Array(enc)
}

export function encodeSyncStep2(doc: Y.Doc, stateVector: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_SYNC)
  syncProtocol.writeSyncStep2(enc, doc, stateVector)
  return encoding.toUint8Array(enc)
}

export function encodeSyncUpdate(update: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_SYNC)
  syncProtocol.writeUpdate(enc, update)
  return encoding.toUint8Array(enc)
}

/** [MSG_AWARENESS, awareness update bytes] */
export function encodeAwarenessMessage(update: Uint8Array): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_AWARENESS)
  encoding.writeVarUint8Array(enc, update)
  return encoding.toUint8Array(enc)
}

/** Empty awareness update: a no-op for clients that still resets y-websocket's 30 s silence timer. */
export const KEEPALIVE_FRAME: Uint8Array = (() => {
  const inner = encoding.createEncoder()
  encoding.writeVarUint(inner, 0)
  return encodeAwarenessMessage(encoding.toUint8Array(inner))
})()

export function encodeBarrierReply(nonce: string): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_BARRIER)
  encoding.writeVarString(enc, nonce)
  return encoding.toUint8Array(enc)
}

export function encodeEventMessage(json: string): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, MSG_EVENT)
  encoding.writeVarString(enc, json)
  return encoding.toUint8Array(enc)
}

// ---------------------------------------------------------------------------
// Awareness updates (y-protocols/awareness encoding, re-implemented so entries can be filtered)
// ---------------------------------------------------------------------------

export interface AwarenessEntry {
  clientID: number
  clock: number
  /** raw JSON of the state ('null' for removals) */
  json: string
}

export const MAX_AWARENESS_ENTRIES = 256
export const MAX_AWARENESS_STATE_BYTES = 32 * 1024

export function decodeAwarenessUpdate(update: Uint8Array): AwarenessEntry[] {
  const dec = decoding.createDecoder(update)
  const len = decoding.readVarUint(dec)
  if (len > MAX_AWARENESS_ENTRIES) throw new ProtocolError(`too many awareness entries (${len})`)
  const out: AwarenessEntry[] = []
  for (let i = 0; i < len; i++) {
    const clientID = decoding.readVarUint(dec)
    const clock = decoding.readVarUint(dec)
    const json = decoding.readVarString(dec)
    out.push({ clientID, clock, json })
  }
  return out
}

export function encodeAwarenessEntries(entries: AwarenessEntry[]): Uint8Array {
  const enc = encoding.createEncoder()
  encoding.writeVarUint(enc, entries.length)
  for (const e of entries) {
    encoding.writeVarUint(enc, e.clientID)
    encoding.writeVarUint(enc, e.clock)
    encoding.writeVarString(enc, e.json)
  }
  return encoding.toUint8Array(enc)
}

// ---------------------------------------------------------------------------
// Client update validation (doc rooms)
// ---------------------------------------------------------------------------

/** A malformed or disallowed client message: the connection is closed with 4400. */
export class ProtocolError extends Error {
  override name = 'ProtocolError'
}

/**
 * Check that a client update only touches the document's Y.Text with plain string content
 * (what y-codemirror.next produces): no other root types, map entries, embeds, formatting,
 * nested types or carriage returns. Returns an upper bound of the number of UTF-16 units the
 * update can add to the text. Throws ProtocolError otherwise.
 */
export function inspectTextUpdate(update: Uint8Array, textKey: string): number {
  let decoded: ReturnType<typeof Y.decodeUpdate>
  try {
    decoded = Y.decodeUpdate(update)
  } catch (err) {
    throw new ProtocolError(`undecodable update: ${(err as Error).message}`)
  }
  let growth = 0
  for (const struct of decoded.structs) {
    if (!(struct instanceof Y.Item)) continue // GC / Skip
    if (struct.parentSub !== null) throw new ProtocolError('map-style entries are not allowed')
    const parent = struct.parent as unknown
    if (typeof parent === 'string') {
      if (parent !== textKey) throw new ProtocolError(`root type "${parent.slice(0, 40)}" is not allowed`)
    } else if (parent !== null) {
      throw new ProtocolError('nested types are not allowed')
    }
    const content = struct.content
    if (content instanceof Y.ContentString) {
      if (content.str.includes('\r')) throw new ProtocolError('carriage returns are not allowed')
      growth += content.str.length
    } else if (!(content instanceof Y.ContentDeleted)) {
      throw new ProtocolError(`content type ${content.constructor.name} is not allowed`)
    }
  }
  return growth
}
