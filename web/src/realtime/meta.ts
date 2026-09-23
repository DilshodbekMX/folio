/**
 * Project meta room (SPEC §6.4): `/ws/project/<projectId>` spoken with y-websocket.
 *
 * - Mirrors the server-authoritative META maps (files, name, settings) into useProject.
 * - Presence: other clients' awareness → useProject.presence; our own awareness is
 *   { user, openFileId } and follows useAuth.me + useEditor.openFileId. Clients of our own user
 *   (the project open in another tab) are left out too: they are not collaborators, and would
 *   show up as an avatar / file-tree dot of ourselves (deviation: "other clients" = other users).
 * - Server events (MSG_EVENT, JSON ProjectEvent) are re-emitted through `projectEvents`.
 * - Connection state for the reconnect banner → useProject.connection.
 *
 * - Catch-up: events are one-shot, so after the room syncs again following a disconnect,
 *   `onMetaResync` listeners run (chat reloads the newest messages, compile fetches the last
 *   build) and the project is re-fetched (our role and the members: a role change made while we
 *   were offline applies now); an open history list is refreshed through a local
 *   'history:changed'.
 *
 * - No network: while the browser reports it has no network (./net.ts) the socket is closed and
 *   none is opened — anything written to a socket that cannot deliver would be flushed when the
 *   network returns, possibly under a session the user has signed out of meanwhile (SEC2-1). The
 *   'online' event reconnects. Signing out closes every meta room at once (closeAllMeta), before
 *   the page that holds it unmounts.
 *
 * Close codes: 4401 → error + session re-check; 4404/4410 → loadState 'error' with a message;
 * 4403 → the role may merely have changed, so access is re-checked over REST first (reload()):
 * still a member → reconnect with the new role, otherwise loadState 'error'. Other codes → reconnect
 * with backoff (the banner shows connection 'disconnected').
 *
 * Deviation (documented): the meta Y.Doc is thrown away on every disconnect and a fresh one is
 * used for the next connection (own backoff instead of y-websocket's reconnect). The doc is
 * server-authoritative and small, and merging a stale client doc into a server doc rebuilt after
 * a restart could resurrect deleted file entries (Y.Map keys set by the old server clientID).
 */
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import type { FileEntry, FileKind, ProjectSettings } from '@folio/shared/api'
import {
  META_FILES_KEY, META_PROJECT_KEY, MSG_EVENT, MSG_QUERY_AWARENESS, WS_CLOSE, metaServerUrl,
  type MetaPresence, type ProjectEvent,
} from '@folio/shared/protocol'
import { isRecord } from '../lib/storage'
import { registerTestHook } from '../stores/testHooks'
import { onSignOut, useAuth } from '../stores/auth'
import { useEditor } from '../stores/editor'
import { useProject, type ConnectionState, type PresenceEntry, type ProjectState } from '../stores/project'
import { browserOffline } from './net'
import { parseMetaPresence, presenceUser } from './presence'
import { isPermanentCloseCode, wsBase } from './url'

export { wsBase } from './url'

// ---------------------------------------------------------------------------------------------
// projectEvents: typed emitter for server → client ProjectEvents
// ---------------------------------------------------------------------------------------------

export type ProjectEventType = ProjectEvent['type']
export type ProjectEventOf<T extends ProjectEventType> = Extract<ProjectEvent, { type: T }>
type AnyListener = (e: ProjectEvent) => void

const eventListeners = new Map<ProjectEventType | '*', Set<AnyListener>>()

function addListener(key: ProjectEventType | '*', fn: AnyListener): () => void {
  let set = eventListeners.get(key)
  if (!set) {
    set = new Set()
    eventListeners.set(key, set)
  }
  set.add(fn)
  return () => {
    eventListeners.get(key)?.delete(fn)
  }
}

export const projectEvents = {
  /** Subscribe to one event type of the open project; returns the unsubscribe function. */
  on<T extends ProjectEventType>(type: T, fn: (e: ProjectEventOf<T>) => void): () => void {
    return addListener(type, fn as AnyListener)
  },
  /** Subscribe to every event. */
  onAny(fn: (e: ProjectEvent) => void): () => void {
    return addListener('*', fn)
  },
  /** Dispatch an event to the listeners (used for server events; also handy in tests). */
  emit(e: ProjectEvent): void {
    const targets = [...(eventListeners.get(e.type) ?? []), ...(eventListeners.get('*') ?? [])]
    for (const fn of targets) {
      try {
        fn(e)
      } catch (err) {
        console.error(`[projectEvents] listener for '${e.type}' failed`, err)
      }
    }
  },
}

registerTestHook('projectEvents', projectEvents)

const resyncListeners = new Set<(projectId: string) => void>()

/**
 * Called when the project's meta room synced again after a disconnect: server events sent in
 * between were missed, so state that only events keep fresh must be re-fetched.
 */
export function onMetaResync(fn: (projectId: string) => void): () => void {
  resyncListeners.add(fn)
  return () => {
    resyncListeners.delete(fn)
  }
}

function emitResync(projectId: string): void {
  for (const fn of [...resyncListeners]) {
    try {
      fn(projectId)
    } catch (err) {
      console.error('[meta] resync listener failed', err)
    }
  }
}

// ---------------------------------------------------------------------------------------------
// validation helpers (the meta doc and awareness come from the network)
// ---------------------------------------------------------------------------------------------

const FILE_KINDS: readonly FileKind[] = ['text', 'binary', 'folder']

function toFileEntry(key: string, v: unknown): FileEntry | null {
  if (!isRecord(v)) return null
  const id = typeof v.id === 'string' && v.id ? v.id : key
  if (typeof v.path !== 'string' || !v.path) return null
  if (!FILE_KINDS.includes(v.kind as FileKind)) return null
  const num = (x: unknown, d: number) => (typeof x === 'number' && Number.isFinite(x) ? x : d)
  return { id, path: v.path, kind: v.kind as FileKind, size: num(v.size, 0), epoch: num(v.epoch, 0), updatedAt: num(v.updatedAt, 0) }
}

function sameFileEntry(a: FileEntry, b: FileEntry): boolean {
  return a.id === b.id && a.path === b.path && a.kind === b.kind && a.size === b.size && a.epoch === b.epoch && a.updatedAt === b.updatedAt
}

function sameJSON(a: unknown, b: unknown): boolean {
  if (a === b) return true
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

function samePresence(a: readonly PresenceEntry[], b: readonly PresenceEntry[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.clientId !== y.clientId || x.openFileId !== y.openFileId) return false
    if (x.user.id !== y.user.id || x.user.name !== y.user.name || x.user.color !== y.user.color || x.user.colorLight !== y.user.colorLight) return false
  }
  return true
}

function isProjectEvent(v: unknown): v is ProjectEvent {
  return isRecord(v) && typeof v.type === 'string'
}

// ---------------------------------------------------------------------------------------------
// MetaConnection
// ---------------------------------------------------------------------------------------------

const RECONNECT_BASE_MS = 250
const RECONNECT_MAX_MS = 5000

class MetaConnection {
  readonly projectId: string
  refs = 0
  private doc: Y.Doc | null = null
  private provider: WebsocketProvider | null = null
  private synced = false
  private everSynced = false
  private attempts = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private releaseTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private unsubs: Array<() => void> = []
  private readonly onOnline = () => {
    if (this.retryTimer !== null && !this.destroyed) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
      this.open()
    }
  }
  /**
   * The browser reports no network: close the socket at once (./net.ts). Presence and awareness
   * written into a socket that cannot deliver would wait in the browser's send buffer and be
   * flushed when the network returns, possibly after the user signed out (SEC2-1). The usual
   * close handling takes over from here: the banner shows "disconnected" and onOnline reopens.
   */
  private readonly onOffline = () => {
    if (!this.destroyed) this.provider?.disconnect()
  }

  constructor(projectId: string) {
    this.projectId = projectId
  }

  start(): void {
    this.setConnection('connecting')
    this.unsubs.push(
      useEditor.subscribe((s, prev) => {
        if (s.openFileId !== prev.openFileId) this.publishPresence()
      }),
      useAuth.subscribe((s, prev) => {
        if (s.me === prev.me) return
        this.publishPresence()
        this.mirrorPresence()
      }),
    )
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.onOnline)
      window.addEventListener('offline', this.onOffline)
    }
    this.open()
  }

  retain(): void {
    this.refs++
    if (this.releaseTimer !== null) {
      clearTimeout(this.releaseTimer)
      this.releaseTimer = null
    }
  }

  release(): void {
    this.refs = Math.max(0, this.refs - 1)
    if (this.refs > 0 || this.releaseTimer !== null) return
    // deferred: a synchronous release/retain pair (React StrictMode) keeps the socket
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = null
      if (this.refs === 0) this.destroy()
    }, 0)
  }

  isSynced(): boolean {
    return this.synced
  }

  /** Reconnect a connection that gave up (permanent close) when it is requested again. */
  revive(): void {
    if (this.destroyed || this.provider || this.retryTimer !== null) return
    this.attempts = 0
    this.setConnection('connecting')
    this.open()
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    if (connections.get(this.projectId) === this) connections.delete(this.projectId)
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer)
    this.retryTimer = null
    this.releaseTimer = null
    for (const u of this.unsubs.splice(0)) u()
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.onOnline)
      window.removeEventListener('offline', this.onOffline)
    }
    // stop writing to the socket now: dropProvider() destroys it one macrotask later, and a
    // frame handed to it after a sign-out would flush under the old session (SEC2-1)
    try {
      this.provider?.disconnect()
    } catch {
      // already closing
    }
    this.dropProvider()
  }

  /** Mirror everything we know into the store (after a REST load replaced the data). */
  mirrorAll(): void {
    if (!this.synced) return
    this.mirrorFiles()
    this.mirrorProject()
    this.mirrorPresence()
    this.setConnection('connected')
  }

  private open(): void {
    if (this.destroyed || this.provider) return
    this.retryTimer = null
    // no network: wait for the browser's 'online' event instead of opening a socket that could
    // only buffer what we write into it (./net.ts)
    if (browserOffline()) {
      this.scheduleReconnect()
      return
    }
    const doc = new Y.Doc()
    let provider: WebsocketProvider
    try {
      provider = new WebsocketProvider(metaServerUrl(wsBase()), encodeURIComponent(this.projectId), doc, {
        connect: false,
        disableBc: true,
      })
    } catch (e) {
      console.error('[meta] cannot create provider', e)
      doc.destroy()
      this.scheduleReconnect()
      return
    }
    this.doc = doc
    this.provider = provider
    this.synced = false

    provider.messageHandlers[MSG_EVENT] = (_encoder, decoder) => this.onEventMessage(provider, decoder)
    doc.getMap(META_FILES_KEY).observe(() => {
      if (this.provider === provider && this.synced) this.mirrorFiles()
    })
    doc.getMap(META_PROJECT_KEY).observe(() => {
      if (this.provider === provider && this.synced) this.mirrorProject()
    })
    provider.awareness.on('change', () => {
      if (this.provider === provider) this.mirrorPresence()
    })
    provider.on('status', ({ status }) => {
      if (this.provider === provider && status === 'connected') this.queryAwareness(provider)
    })
    provider.on('sync', (isSynced: boolean) => {
      if (this.provider !== provider || !isSynced) return
      const resync = this.everSynced
      this.synced = true
      this.everSynced = true
      this.attempts = 0
      this.mirrorAll()
      if (resync) this.catchUp()
    })
    provider.on('connection-close', event => {
      if (this.provider !== provider) return
      this.onClose(event?.code ?? null, event?.reason ?? '')
    })
    this.publishPresence()
    provider.connect()
  }

  /** Detach and destroy the current provider + doc (outside y-websocket's own close handling). */
  private dropProvider(): void {
    const provider = this.provider
    const doc = this.doc
    this.provider = null
    this.doc = null
    this.synced = false
    if (!provider || !doc) return
    setTimeout(() => {
      try {
        provider.destroy()
      } finally {
        doc.destroy()
      }
    }, 0)
  }

  private onClose(code: number | null, reason: string): void {
    this.dropProvider()
    if (this.destroyed) return
    this.setStore({ presence: [] })
    if (isPermanentCloseCode(code)) {
      this.onPermanentClose(code as number, reason)
      return
    }
    // before the first sync a couple of failed attempts are still "connecting"
    this.setConnection(this.everSynced || this.attempts >= 2 ? 'disconnected' : 'connecting')
    this.scheduleReconnect()
  }

  private scheduleReconnect(): void {
    if (this.destroyed || this.retryTimer !== null) return
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** this.attempts) * (0.75 + Math.random() * 0.5)
    this.attempts++
    this.retryTimer = setTimeout(() => this.open(), delay)
  }

  private onPermanentClose(code: number, reason: string): void {
    switch (code) {
      case WS_CLOSE.FORBIDDEN:
        // role changed or access revoked: re-check over REST, reconnect when still a member
        this.setConnection('disconnected')
        void this.recheckAccess()
        return
      case WS_CLOSE.UNAUTHORIZED:
        this.fail('Your session has expired. Please sign in again.')
        void useAuth.getState().init()
        return
      case WS_CLOSE.NOT_FOUND:
        this.fail('This project does not exist or you do not have access to it.')
        return
      case WS_CLOSE.GONE:
        this.fail('This project has been deleted.')
        return
      default:
        this.fail(`The connection to this project was closed by the server${reason ? `: ${reason}` : ''} (code ${code}). Reload the page to reconnect.`)
    }
  }

  private async recheckAccess(): Promise<void> {
    try {
      await useProject.getState().reload()
    } catch {
      // server unreachable: try the socket again later
      this.scheduleReconnect()
      return
    }
    if (this.destroyed) return
    const st = useProject.getState()
    if (st.projectId === this.projectId && st.loadState === 'ready' && st.role) {
      this.attempts = 0
      this.open()
    }
  }

  private fail(message: string): void {
    this.setStore({ loadState: 'error', error: message, connection: 'disconnected', presence: [] })
  }

  private onEventMessage(provider: WebsocketProvider, decoder: decoding.Decoder): void {
    let event: unknown
    try {
      event = JSON.parse(decoding.readVarString(decoder))
    } catch (e) {
      console.warn('[meta] malformed event message', e)
      return
    }
    if (provider !== this.provider || !isProjectEvent(event)) return
    try {
      this.handleEvent(event)
    } catch (e) {
      console.error('[meta] event handling failed', e)
    }
  }

  private handleEvent(ev: ProjectEvent): void {
    const st = useProject.getState()
    if (st.projectId !== this.projectId) return
    switch (ev.type) {
      case 'members:changed':
        st.reloadMembers().catch(err => console.warn('[meta] reloading members failed', err))
        break
      case 'access:changed':
        if (ev.userId === useAuth.getState().me?.id) {
          st.reload().catch(err => console.warn('[meta] access re-check failed', err))
        }
        break
      case 'project:deleted':
        this.fail('This project has been deleted.')
        break
      case 'project:renamed':
        if (typeof ev.name === 'string' && ev.name !== st.name) useProject.setState({ name: ev.name })
        break
      case 'project:settings':
        if (isRecord(ev.settings) && !sameJSON(ev.settings, st.settings)) useProject.setState({ settings: ev.settings })
        break
      default:
        break
    }
    projectEvents.emit(ev)
  }

  /** Re-fetch what only one-shot events keep fresh (they were missed while disconnected). */
  private catchUp(): void {
    const st = useProject.getState()
    if (st.projectId !== this.projectId || st.loadState !== 'ready') return
    // our role and the members ('access:changed' / 'members:changed' may have been missed — e.g.
    // made a viewer while offline): reload() refreshes both, and a changed role turns the open
    // documents read-only (docs.ts revalidate keeps their unconfirmed edits aside)
    st.reload().catch(err => console.warn('[meta] re-checking the project after a reconnect failed', err))
    // an open history list refreshes itself on this event
    projectEvents.emit({ type: 'history:changed', versionId: null })
    emitResync(this.projectId)
  }

  private queryAwareness(provider: WebsocketProvider): void {
    const ws = provider.ws
    if (!ws || ws.readyState !== 1) return
    const enc = encoding.createEncoder()
    encoding.writeVarUint(enc, MSG_QUERY_AWARENESS)
    try {
      ws.send(encoding.toUint8Array(enc))
    } catch {
      // the close handler takes care of it
    }
  }

  private publishPresence(): void {
    const provider = this.provider
    if (!provider) return
    const me = useAuth.getState().me
    if (!me) {
      if (provider.awareness.getLocalState() !== null) provider.awareness.setLocalState(null)
      return
    }
    const state: MetaPresence = { user: presenceUser(me), openFileId: useEditor.getState().openFileId }
    if (sameJSON(provider.awareness.getLocalState(), state)) return
    provider.awareness.setLocalState(state)
  }

  private setStore(patch: Partial<ProjectState>): void {
    if (useProject.getState().projectId === this.projectId) useProject.setState(patch)
  }

  private setConnection(connection: ConnectionState): void {
    const st = useProject.getState()
    if (st.projectId === this.projectId && st.connection !== connection) useProject.setState({ connection })
  }

  private mirrorFiles(): void {
    const doc = this.doc
    const st = useProject.getState()
    if (!doc || st.projectId !== this.projectId) return
    const prev = st.files
    const next: Record<string, FileEntry> = {}
    let changed = false
    let count = 0
    doc.getMap<unknown>(META_FILES_KEY).forEach((value, key) => {
      const entry = toFileEntry(key, value)
      if (!entry || next[entry.id]) return
      const old = prev[entry.id]
      const keep = old && sameFileEntry(old, entry) ? old : entry
      if (keep !== old) changed = true
      next[entry.id] = keep
      count++
    })
    if (!changed && count === Object.keys(prev).length) return
    useProject.setState({ files: next })
  }

  private mirrorProject(): void {
    const doc = this.doc
    const st = useProject.getState()
    if (!doc || st.projectId !== this.projectId) return
    const map = doc.getMap<unknown>(META_PROJECT_KEY)
    const name = map.get('name')
    const settings = map.get('settings')
    const patch: Partial<ProjectState> = {}
    if (typeof name === 'string' && name !== st.name) patch.name = name
    if (isRecord(settings)) {
      const merged = { ...(st.settings ?? {}), ...settings } as ProjectSettings
      if (!sameJSON(merged, st.settings)) patch.settings = merged
    }
    if (Object.keys(patch).length > 0) useProject.setState(patch)
  }

  private mirrorPresence(): void {
    const provider = this.provider
    const st = useProject.getState()
    if (!provider || st.projectId !== this.projectId) return
    const self = provider.awareness.clientID
    const meId = useAuth.getState().me?.id
    const list: PresenceEntry[] = []
    provider.awareness.getStates().forEach((state, clientId) => {
      if (clientId === self) return
      const p = parseMetaPresence(state)
      if (p && p.user.id !== meId) list.push({ clientId, user: p.user, openFileId: p.openFileId })
    })
    list.sort((a, b) => a.clientId - b.clientId)
    if (!samePresence(st.presence, list)) useProject.setState({ presence: list })
  }
}

const connections = new Map<string, MetaConnection>()

/**
 * Close every meta room at once (signing out): the page that holds them unmounts a moment later,
 * and until then the socket would keep sending presence under the account that just signed out
 * (SEC2-1). A project opened again creates a fresh connection.
 */
export function closeAllMeta(): void {
  for (const conn of [...connections.values()]) conn.destroy()
  connections.clear()
}

onSignOut(() => closeAllMeta())

/**
 * Connect to the project's meta room (ref-counted per project; useProject.load() holds one
 * reference itself, so calling this from a component is optional). Returns the disconnect fn.
 */
export function connectMeta(projectId: string): () => void {
  let conn = connections.get(projectId)
  if (!conn) {
    conn = new MetaConnection(projectId)
    connections.set(projectId, conn)
    conn.start()
  }
  const c = conn
  c.retain()
  c.revive()
  let released = false
  return () => {
    if (released) return
    released = true
    c.release()
  }
}

/** Re-apply the meta room's state to useProject (used after a REST load replaced the data). */
export function refreshFromMeta(projectId: string): void {
  connections.get(projectId)?.mirrorAll()
}

/** True when the project's meta room is connected and synced. */
export function isMetaSynced(projectId: string): boolean {
  return connections.get(projectId)?.isSynced() ?? false
}
