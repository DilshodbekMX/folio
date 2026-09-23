/**
 * Collaborators' edits wait while the user composes text with an IME (INT-5).
 *
 * y-codemirror.next dispatches a remote change to CodeMirror the moment it arrives. When that
 * change lands on the line of an active IME composition (Japanese, Chinese, Korean…), the
 * browser's composition gets out of step with the document and the intermediate composition
 * text ("にほ") stays in the document next to the committed one, for everyone.
 *
 * So while `view.composing`, incoming Yjs document updates of this session are held back before
 * they reach the Y.Doc, and applied, in order, as soon as the composition has ended. Holding
 * them before the Y.Doc (rather than only in CodeMirror) keeps the editor, the Y.Text and the
 * remote cursors consistent the whole time: the user's own keystrokes still go out immediately
 * and the server merges them as usual. Only update messages are held; sync step 1/2 (a
 * reconnect) and every other message pass straight through.
 */
import * as Y from 'yjs'
import * as decoding from 'lib0/decoding'
import type { Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { WebsocketProvider } from 'y-websocket'

/** y-websocket / y-protocols message and sync-message types */
const MESSAGE_SYNC = 0
const SYNC_UPDATE = 2

type MessageHandler = WebsocketProvider['messageHandlers'][number]

class CompositionHold {
  private queue: Uint8Array[] = []
  private readonly original: MessageHandler
  private readonly wrapper: MessageHandler
  private timer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  constructor(
    private readonly view: EditorView,
    private readonly provider: WebsocketProvider,
  ) {
    const original = provider.messageHandlers[MESSAGE_SYNC]
    this.original = original
    this.wrapper = (encoder, decoder, prov, emitSynced, messageType) => {
      // keep the order: once something is held, later updates wait too
      if (!this.view.composing && this.queue.length === 0) return original(encoder, decoder, prov, emitSynced, messageType)
      const rest = decoding.readTailAsUint8Array(decoder)
      const peek = decoding.createDecoder(rest)
      if (decoding.readVarUint(peek) !== SYNC_UPDATE) return original(encoder, decoding.createDecoder(rest), prov, emitSynced, messageType)
      this.queue.push(decoding.readVarUint8Array(peek))
      if (!this.view.composing) this.schedule()
    }
    provider.messageHandlers[MESSAGE_SYNC] = this.wrapper
  }

  update(update: ViewUpdate): void {
    if (this.queue.length > 0 && !update.view.composing) this.schedule()
  }

  /** After the composition ended: CodeMirror reads the committed text first (a microtask). */
  schedule(): void {
    if (this.timer !== null || this.destroyed) return
    this.timer = setTimeout(() => {
      this.timer = null
      this.flush(false)
    }, 0)
  }

  flush(force: boolean): void {
    if (this.queue.length === 0) return
    if (!force && this.view.composing) return // a new composition started: wait for its end
    const updates = this.queue
    this.queue = []
    const doc = this.provider.doc
    if (doc.isDestroyed) return
    for (const u of updates) {
      try {
        // exactly what y-protocols does for an update message (origin: the provider)
        Y.applyUpdate(doc, u, this.provider)
      } catch (e) {
        console.error('[editor] applying a held remote update failed', e)
      }
    }
  }

  destroy(): void {
    this.destroyed = true
    if (this.timer !== null) clearTimeout(this.timer)
    if (this.provider.messageHandlers[MESSAGE_SYNC] === this.wrapper) this.provider.messageHandlers[MESSAGE_SYNC] = this.original
    // never lose what was held: the session outlives the view (idle LRU)
    this.flush(true)
  }
}

export function holdRemoteWhileComposing(provider: WebsocketProvider): Extension {
  return ViewPlugin.define(view => new CompositionHold(view, provider), {
    eventHandlers: {
      compositionend() {
        this.schedule()
      },
      blur() {
        this.schedule()
      },
    },
  })
}
