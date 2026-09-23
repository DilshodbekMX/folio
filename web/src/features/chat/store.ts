/**
 * Chat state of the open project: loaded history (ascending by id), live messages from
 * 'chat:message' events, optimistic sends and the "new messages" marker.
 *
 * The store is fed by useChatUnread() (mounted once per editor session) so live messages are
 * kept even while the chat panel is closed; the newest page is loaded when the editor opens (it is
 * the baseline for messages missed while the project connection was down: catchUp()).
 */
import { create } from 'zustand'
import type { ChatMessage } from '@folio/shared/api'
import { api } from '../../api/endpoints'
import { errorMessage } from '../../api/client'

export const CHAT_PAGE_SIZE = 50
export const MAX_CHAT_LENGTH = 5000

export interface PendingMessage {
  /** client-side key */
  tempId: string
  content: string
  createdAt: number
  status: 'sending' | 'failed'
  error?: string
}

export type ChatLoadState = 'idle' | 'loading' | 'ready' | 'error'

export interface ChatState {
  projectId: string | null
  messages: ChatMessage[]
  hasMore: boolean
  loadState: ChatLoadState
  error: string | null
  loadingOlder: boolean
  olderError: string | null
  pending: PendingMessage[]
  /** id of the first message that arrived while the chat was not visible (null = none) */
  unreadFromId: number | null
  /** composer draft (kept per project while the editor is open) */
  draft: string
  /** switch to another project (resets everything) */
  attach(projectId: string | null): void
  /** load the newest page if nothing is loaded yet */
  ensureLoaded(): Promise<void>
  load(): Promise<void>
  loadOlder(): Promise<void>
  /**
   * A live message from the server. `mine`: sent by this user (replaces the matching optimistic
   * entry); `unseen`: arrived while the chat was not visible (sets the "new messages" marker).
   */
  receive(projectId: string, message: ChatMessage, opts: { mine: boolean; unseen: boolean }): void
  /**
   * The project connection came back: fetch the newest page and merge it. Resolves with the
   * messages that were not known before (posted while 'chat:message' events could not arrive).
   */
  catchUp(): Promise<ChatMessage[]>
  /** start the "new messages" marker at `id` unless one is already shown */
  markUnseen(id: number): void
  send(content: string): Promise<void>
  retry(tempId: string): Promise<void>
  discard(tempId: string): void
  clearUnreadMarker(): void
  setDraft(draft: string): void
}

/** Insert messages into an ascending, de-duplicated list (returns the same array when nothing changed). */
export function mergeMessages(list: readonly ChatMessage[], incoming: readonly ChatMessage[]): ChatMessage[] {
  if (incoming.length === 0) return list as ChatMessage[]
  const byId = new Map<number, ChatMessage>()
  for (const m of list) byId.set(m.id, m)
  let changed = false
  for (const m of incoming) {
    if (!byId.has(m.id)) {
      byId.set(m.id, m)
      changed = true
    }
  }
  if (!changed) return list as ChatMessage[]
  return [...byId.values()].sort((a, b) => a.id - b.id)
}

// module-private bookkeeping
/** bumped when another project is attached: results of older requests are dropped */
let projectGen = 0
/** bumped per history load */
let loadGen = 0
/** live messages received while the first page was loading */
let buffered: ChatMessage[] = []
let tempSeq = 0
let loadPromise: Promise<void> | null = null

const EMPTY = {
  messages: [] as ChatMessage[],
  hasMore: false,
  loadState: 'idle' as ChatLoadState,
  error: null,
  loadingOlder: false,
  olderError: null,
  pending: [] as PendingMessage[],
  unreadFromId: null,
  draft: '',
}

export const useChat = create<ChatState>()((set, get) => {
  const post = async (pid: string, tempId: string, content: string) => {
    const gen = projectGen
    try {
      const msg = await api.chatPost(pid, { content })
      if (gen !== projectGen) return
      set(s => ({
        pending: s.pending.filter(p => p.tempId !== tempId),
        messages: s.loadState === 'ready' || s.loadState === 'loading' ? mergeMessages(s.messages, [msg]) : s.messages,
      }))
    } catch (e) {
      if (gen !== projectGen) return
      set(s => ({
        pending: s.pending.map(p => (p.tempId === tempId ? { ...p, status: 'failed', error: errorMessage(e, 'Not sent.') } : p)),
      }))
    }
  }

  return {
    projectId: null,
    ...EMPTY,

    attach(projectId) {
      if (get().projectId === projectId) return
      projectGen++
      loadGen++
      buffered = []
      loadPromise = null
      set({ projectId, ...EMPTY })
    },

    ensureLoaded() {
      const s = get()
      if (!s.projectId) return Promise.resolve()
      if (s.loadState === 'ready') return Promise.resolve()
      if (s.loadState === 'loading' && loadPromise) return loadPromise
      return get().load()
    },

    load() {
      const pid = get().projectId
      if (!pid) return Promise.resolve()
      const gen = ++loadGen
      set({ loadState: 'loading', error: null })
      const p = (async () => {
        try {
          const res = await api.chatList(pid, { limit: CHAT_PAGE_SIZE })
          if (gen !== loadGen) return
          const merged = mergeMessages(mergeMessages(get().messages, res.messages), buffered)
          buffered = []
          set({ messages: merged, hasMore: res.hasMore, loadState: 'ready', error: null })
        } catch (e) {
          if (gen !== loadGen) return
          set({ loadState: 'error', error: errorMessage(e, 'Couldn’t load the chat messages.') })
        } finally {
          if (gen === loadGen) loadPromise = null
        }
      })()
      loadPromise = p
      return p
    },

    async loadOlder() {
      const s = get()
      const pid = s.projectId
      if (!pid || s.loadingOlder || !s.hasMore || s.loadState !== 'ready' || s.messages.length === 0) return
      const gen = projectGen
      set({ loadingOlder: true, olderError: null })
      try {
        const res = await api.chatList(pid, { before: s.messages[0].id, limit: CHAT_PAGE_SIZE })
        if (gen !== projectGen) return
        set(st => ({ messages: mergeMessages(st.messages, res.messages), hasMore: res.hasMore, loadingOlder: false }))
      } catch (e) {
        if (gen !== projectGen) return
        set({ loadingOlder: false, olderError: errorMessage(e, 'Couldn’t load earlier messages.') })
      }
    },

    receive(projectId, message, opts) {
      const s = get()
      if (s.projectId !== projectId) return
      const patch: Partial<ChatState> = {}
      if (s.loadState === 'ready') patch.messages = mergeMessages(s.messages, [message])
      else if (s.loadState === 'loading') buffered.push(message)
      if (opts.mine) {
        // our own message came back through the room before the POST answered
        const i = s.pending.findIndex(p => p.status === 'sending' && p.content === message.content)
        if (i >= 0) patch.pending = s.pending.filter((_, j) => j !== i)
      }
      if (opts.unseen && s.unreadFromId === null) patch.unreadFromId = message.id
      if (Object.keys(patch).length > 0) set(patch)
    },

    async catchUp() {
      const s = get()
      const pid = s.projectId
      if (!pid) return []
      if (s.loadState !== 'ready') {
        // nothing loaded to compare with: (re)load the newest page
        if (s.loadState !== 'loading') await get().load()
        return []
      }
      const gen = projectGen
      const known = s.messages.length > 0 ? s.messages[s.messages.length - 1].id : 0
      let res: Awaited<ReturnType<typeof api.chatList>>
      try {
        res = await api.chatList(pid, { limit: CHAT_PAGE_SIZE })
      } catch (e) {
        console.warn('[chat] catching up failed', e)
        return []
      }
      if (gen !== projectGen || get().loadState !== 'ready') return []
      // live messages that arrived during the request are already in the list
      const have = new Set(get().messages.map(m => m.id))
      const fresh = res.messages.filter(m => m.id > known && !have.has(m.id))
      // more missed messages than one page: continue from the newest page (older ones load on scroll)
      const gap = res.hasMore && res.messages.length > 0 && res.messages[0].id > known && known > 0
      set(st => (gap ? { messages: mergeMessages([], res.messages), hasMore: true } : { messages: mergeMessages(st.messages, res.messages) }))
      return fresh
    },

    markUnseen(id) {
      if (get().unreadFromId === null) set({ unreadFromId: id })
    },

    async send(content) {
      const pid = get().projectId
      const text = content.trim()
      if (!pid || !text) return
      const tempId = `tmp-${++tempSeq}`
      set(s => ({
        pending: [...s.pending, { tempId, content: text, createdAt: Date.now(), status: 'sending' }],
        unreadFromId: null,
      }))
      await post(pid, tempId, text)
    },

    async retry(tempId) {
      const pid = get().projectId
      const p = get().pending.find(x => x.tempId === tempId)
      if (!pid || !p) return
      set(s => ({ pending: s.pending.map(x => (x.tempId === tempId ? { ...x, status: 'sending', error: undefined } : x)) }))
      await post(pid, tempId, p.content)
    },

    discard(tempId) {
      set(s => ({ pending: s.pending.filter(x => x.tempId !== tempId) }))
    },

    clearUnreadMarker() {
      if (get().unreadFromId !== null) set({ unreadFromId: null })
    },

    setDraft(draft) {
      set({ draft })
    },
  }
})
