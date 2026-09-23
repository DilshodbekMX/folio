/**
 * Chat rail panel (SPEC §6.7 / §6.8) and useChatUnread().
 *
 *  - Messages grouped by consecutive author (5-minute window) with avatar, name and time; day
 *    separators; own messages on the right; a "New messages" divider for messages that arrived
 *    while the chat was closed.
 *  - Autoscroll while the reader is at the bottom; otherwise a "new messages" pill. Older
 *    messages load when scrolling to the top (the viewport stays anchored).
 *  - Composer: Enter sends, Shift+Enter inserts a newline, 5000-character limit, optimistic
 *    sending with retry for failed messages.
 *  - Content: links (target=_blank, rel=noopener noreferrer), `inline code`, ```code blocks```.
 *
 * useChatUnread() is mounted once by EditorLayout for the whole editor session: it feeds live
 * 'chat:message' events into the chat store and counts messages from others that arrive while
 * the chat panel is not open (useLayout.unreadChat; reset when the panel opens). It loads the
 * newest page up front, and after the project connection comes back it fetches the messages
 * posted meanwhile (their events were missed) and counts them the same way.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { useShallow } from 'zustand/react/shallow'
import clsx from 'clsx'
import { ArrowDown, CircleAlert, MessageSquare, RefreshCw, SendHorizontal, X } from 'lucide-react'
import type { ChatMessage, UserPublic } from '@folio/shared/api'
import { useAuth } from '../../stores/auth'
import { useLayout } from '../../stores/layout'
import { useProject } from '../../stores/project'
import { onMetaResync, projectEvents } from '../../realtime/meta'
import { dayKey, formatDateTime, formatDayLabel, formatTime } from '../../lib/time'
import { Avatar, Button, EmptyState, IconButton, Spinner } from '../../ui'
import { MAX_CHAT_LENGTH, useChat, type PendingMessage } from './store'
import { renderChatContent } from './format'
import './chat.css'

const GROUP_GAP_MS = 5 * 60_000
const NEAR_BOTTOM_PX = 48
const LOAD_OLDER_PX = 120
const COUNTER_FROM = MAX_CHAT_LENGTH - 500
const MAX_COMPOSER_PX = 180

// ---------------------------------------------------------------------------------------------
// useChatUnread
// ---------------------------------------------------------------------------------------------

let detachTimer: ReturnType<typeof setTimeout> | null = null

/** Keeps useLayout.unreadChat (and the chat store) up to date. Mount once per editor session. */
export function useChatUnread(): void {
  const projectId = useProject(s => s.projectId)
  useEffect(() => {
    if (detachTimer !== null) {
      clearTimeout(detachTimer)
      detachTimer = null
    }
    useChat.getState().attach(projectId)
    if (!projectId) return
    void useChat.getState().ensureLoaded()
    const offResync = onMetaResync(pid => {
      if (pid !== projectId) return
      void useChat.getState().catchUp().then(fresh => {
        if (useProject.getState().projectId !== projectId) return
        const meId = useAuth.getState().me?.id
        const missed = fresh.filter(m => m.user.id !== meId)
        const layout = useLayout.getState()
        if (missed.length === 0 || layout.railPanel === 'chat') return
        useChat.getState().markUnseen(missed[0].id)
        layout.setUnreadChat(layout.unreadChat + missed.length)
      })
    })
    const offMessage = projectEvents.on('chat:message', e => {
      if (useProject.getState().projectId !== projectId) return
      const msg = e.message
      const mine = msg.user.id === useAuth.getState().me?.id
      const layout = useLayout.getState()
      const visible = layout.railPanel === 'chat'
      useChat.getState().receive(projectId, msg, { mine, unseen: !mine && !visible })
      if (!mine && !visible) layout.setUnreadChat(layout.unreadChat + 1)
    })
    const offLayout = useLayout.subscribe(s => {
      if (s.railPanel === 'chat' && s.unreadChat !== 0) s.setUnreadChat(0)
    })
    const now = useLayout.getState()
    if (now.railPanel === 'chat' && now.unreadChat !== 0) now.setUnreadChat(0)
    return () => {
      offResync()
      offMessage()
      offLayout()
      // deferred so a StrictMode unmount/remount keeps the loaded history
      detachTimer = setTimeout(() => {
        detachTimer = null
        useChat.getState().attach(null)
      }, 0)
    }
  }, [projectId])
}

// ---------------------------------------------------------------------------------------------
// rows
// ---------------------------------------------------------------------------------------------

interface Entry {
  key: string
  content: string
  createdAt: number
  pending?: PendingMessage
}

type Row =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'unread'; key: string }
  | { kind: 'group'; key: string; user: UserPublic; mine: boolean; items: Entry[] }

function buildRows(messages: readonly ChatMessage[], pending: readonly PendingMessage[], me: UserPublic | null, unreadFromId: number | null): Row[] {
  const rows: Row[] = []
  const now = Date.now()
  let lastDay = ''
  let group: Extract<Row, { kind: 'group' }> | null = null

  const push = (user: UserPublic, entry: Entry, id: number | null) => {
    const day = dayKey(entry.createdAt)
    if (day !== lastDay) {
      rows.push({ kind: 'day', key: `day-${day}`, label: formatDayLabel(entry.createdAt, now) })
      lastDay = day
      group = null
    }
    if (id !== null && id === unreadFromId) {
      rows.push({ kind: 'unread', key: 'unread' })
      group = null
    }
    const prev: Entry | undefined = group ? group.items[group.items.length - 1] : undefined
    if (group && prev && group.user.id === user.id && entry.createdAt - prev.createdAt < GROUP_GAP_MS) {
      group.items.push(entry)
    } else {
      group = { kind: 'group', key: `g-${entry.key}`, user, mine: !!me && user.id === me.id, items: [entry] }
      rows.push(group)
    }
  }

  for (const m of messages) push(m.user, { key: `m${m.id}`, content: m.content, createdAt: m.createdAt }, m.id)
  if (me) for (const p of pending) push(me, { key: p.tempId, content: p.content, createdAt: p.createdAt, pending: p }, null)
  return rows
}

// ---------------------------------------------------------------------------------------------
// ChatPanel
// ---------------------------------------------------------------------------------------------

export function ChatPanel() {
  const projectId = useProject(s => s.projectId)
  const me = useAuth(s => s.me)
  const visible = useLayout(s => s.railPanel === 'chat')
  const setRailPanel = useLayout(s => s.setRailPanel)
  const { messages, hasMore, loadState, error, loadingOlder, olderError, pending, unreadFromId } = useChat(
    useShallow(s => ({
      messages: s.messages, hasMore: s.hasMore, loadState: s.loadState, error: s.error, loadingOlder: s.loadingOlder,
      olderError: s.olderError, pending: s.pending, unreadFromId: s.unreadFromId,
    })),
  )

  const listRef = useRef<HTMLDivElement | null>(null)
  const composerRef = useRef<HTMLTextAreaElement | null>(null)
  const stickRef = useRef(true)
  const lastTopRef = useRef(0)
  const anchorRef = useRef<{ height: number; top: number } | null>(null)
  const lastKeyRef = useRef<string | null>(null)
  const [newCount, setNewCount] = useState(0)

  useEffect(() => {
    if (!projectId) return
    useChat.getState().attach(projectId)
    void useChat.getState().ensureLoaded()
  }, [projectId])

  const meUser = useMemo<UserPublic | null>(() => (me ? { id: me.id, name: me.name, email: me.email, color: me.color } : null), [me])
  const rows = useMemo(() => buildRows(messages, pending, meUser, unreadFromId), [messages, pending, meUser, unreadFromId])
  const lastKey = pending.length > 0 ? pending[pending.length - 1].tempId : messages.length > 0 ? `m${messages[messages.length - 1].id}` : null
  const lastIsMine = pending.length > 0 || (messages.length > 0 && messages[messages.length - 1].user.id === me?.id)

  const scrollToBottom = (smooth = false) => {
    const el = listRef.current
    if (!el) return
    if (smooth) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
    else el.scrollTop = el.scrollHeight
    stickRef.current = true
    setNewCount(0)
  }

  const requestOlder = () => {
    const st = useChat.getState()
    const el = listRef.current
    if (!el || !st.hasMore || st.loadingOlder || st.loadState !== 'ready') return
    anchorRef.current = { height: el.scrollHeight, top: el.scrollTop }
    void st.loadOlder()
  }

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight
    stickRef.current = distance < NEAR_BOTTOM_PX
    lastTopRef.current = el.scrollTop
    if (stickRef.current && newCount > 0) setNewCount(0)
    if (el.scrollTop < LOAD_OLDER_PX && el.scrollHeight > el.clientHeight) requestOlder()
  }

  // Keep the viewport anchored when older messages are prepended; follow new messages.
  useLayoutEffect(() => {
    const el = listRef.current
    if (!el) return
    if (anchorRef.current && !loadingOlder) {
      const a = anchorRef.current
      anchorRef.current = null
      el.scrollTop = el.scrollHeight - a.height + a.top
      lastTopRef.current = el.scrollTop
    }
    if (lastKey !== lastKeyRef.current) {
      const first = lastKeyRef.current === null
      lastKeyRef.current = lastKey
      if (first || stickRef.current || lastIsMine) {
        el.scrollTop = el.scrollHeight
        stickRef.current = true
        setNewCount(0)
      } else {
        setNewCount(c => c + 1)
      }
    }
  }, [rows, loadingOlder, lastKey, lastIsMine])

  // A short history may not fill the panel: keep loading until it scrolls (or nothing is left).
  useEffect(() => {
    const el = listRef.current
    if (!el || !visible || loadState !== 'ready' || !hasMore || loadingOlder || olderError) return
    if (el.scrollHeight <= el.clientHeight + LOAD_OLDER_PX) requestOlder()
  }, [visible, loadState, hasMore, loadingOlder, olderError, rows])

  // Opened from the rail (first use mounts the panel): move focus into the composer.
  useEffect(() => {
    if (visible && document.activeElement instanceof HTMLElement && document.activeElement.closest('.lay-rail')) {
      composerRef.current?.focus({ preventScroll: true })
    }
    // mount only
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Restore the scroll position when the panel is shown again; clear the unread divider when it is hidden.
  const wasVisible = useRef(visible)
  useLayoutEffect(() => {
    const el = listRef.current
    if (visible && !wasVisible.current) {
      if (el) {
        if (stickRef.current) el.scrollTop = el.scrollHeight
        else el.scrollTop = lastTopRef.current
      }
      composerRef.current?.focus({ preventScroll: true })
    } else if (!visible && wasVisible.current) {
      useChat.getState().clearUnreadMarker()
    }
    wasVisible.current = visible
  }, [visible])

  // Stay at the bottom while the list resizes (panel resize, composer growing, fonts loading).
  useEffect(() => {
    const el = listRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(() => {
      if (stickRef.current) el.scrollTop = el.scrollHeight
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  let body: ReactNode
  if (loadState === 'error') {
    body = (
      <EmptyState
        icon={CircleAlert}
        title="Couldn’t load the chat"
        size="sm"
        actions={
          <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => void useChat.getState().load()}>
            Try again
          </Button>
        }
      >
        {error}
      </EmptyState>
    )
  } else if (loadState !== 'ready') {
    body = (
      <div className="chat-center">
        <Spinner size={18} label="Loading messages" />
      </div>
    )
  } else if (rows.length === 0) {
    body = (
      <EmptyState icon={MessageSquare} title="No messages yet" size="sm">
        Start the conversation by saying hello or sharing an update with your collaborators.
      </EmptyState>
    )
  } else {
    body = (
      <>
        <div className="chat-history">
          {hasMore ? (
            loadingOlder ? (
              <Spinner size={14} label="Loading earlier messages" />
            ) : olderError ? (
              <span className="chat-history__error">
                {olderError}{' '}
                <button type="button" className="chat-textbtn" onClick={requestOlder}>
                  Retry
                </button>
              </span>
            ) : (
              <button type="button" className="chat-textbtn" onClick={requestOlder}>
                Load earlier messages
              </button>
            )
          ) : (
            <span>This is the beginning of the chat.</span>
          )}
        </div>
        {rows.map(row => {
          if (row.kind === 'day') {
            return (
              <div key={row.key} className="chat-sep" role="separator">
                <span>{row.label}</span>
              </div>
            )
          }
          if (row.kind === 'unread') {
            return (
              <div key={row.key} className="chat-sep chat-sep--unread" role="separator">
                <span>New messages</span>
              </div>
            )
          }
          return <MessageGroup key={row.key} user={row.user} mine={row.mine} items={row.items} />
        })}
      </>
    )
  }

  return (
    <section className="chat" aria-label="Chat">
      <header className="chat-head">
        <h2 className="chat-head__title">Chat</h2>
        <IconButton icon={X} label="Close chat" size="sm" tooltipSide="bottom" onClick={() => setRailPanel(null)} />
      </header>
      <div className="chat-main">
        <div
          ref={listRef}
          className={clsx('chat-list', loadState === 'ready' && rows.length > 0 && 'has-messages')}
          role="log"
          aria-live="polite"
          aria-relevant="additions"
          aria-label="Messages"
          tabIndex={0}
          onScroll={onScroll}
        >
          {body}
        </div>
        {newCount > 0 && (
          <button type="button" className="chat-pill" onClick={() => scrollToBottom(true)}>
            <ArrowDown size={14} aria-hidden="true" />
            {newCount === 1 ? '1 new message' : `${newCount} new messages`}
          </button>
        )}
      </div>
      <Composer inputRef={composerRef} disabled={!projectId} />
    </section>
  )
}

function MessageGroup({ user, mine, items }: { user: UserPublic; mine: boolean; items: Entry[] }) {
  const first = items[0]
  return (
    <div className={clsx('chat-group', mine && 'chat-group--mine')}>
      {!mine && <Avatar user={user} size={28} decorative className="chat-group__avatar" />}
      <div className="chat-group__body">
        <div className="chat-group__meta">
          {!mine && <span className="chat-group__name">{user.name}</span>}
          <time className="chat-group__time" dateTime={new Date(first.createdAt).toISOString()} title={formatDateTime(first.createdAt)}>
            {formatTime(first.createdAt)}
          </time>
        </div>
        {items.map(it => (
          <div
            key={it.key}
            className={clsx('chat-msg', it.pending?.status === 'sending' && 'is-sending', it.pending?.status === 'failed' && 'is-failed')}
            title={it.pending ? undefined : formatDateTime(it.createdAt)}
          >
            <div className="chat-msg__text">{renderChatContent(it.content)}</div>
            {it.pending?.status === 'sending' && <div className="chat-msg__status">Sending…</div>}
            {it.pending?.status === 'failed' && (
              <div className="chat-msg__status chat-msg__status--error" role="alert">
                Not sent{it.pending.error ? `: ${it.pending.error}` : '.'}{' '}
                <button type="button" className="chat-textbtn" onClick={() => void useChat.getState().retry(it.key)}>
                  Retry
                </button>
                {' · '}
                <button type="button" className="chat-textbtn" onClick={() => useChat.getState().discard(it.key)}>
                  Delete
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------------------------

function Composer({ inputRef, disabled }: { inputRef: RefObject<HTMLTextAreaElement | null>; disabled: boolean }) {
  const draft = useChat(s => s.draft)
  const length = draft.trim().length
  const over = length > MAX_CHAT_LENGTH
  const empty = length === 0

  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, MAX_COMPOSER_PX)}px`
  }, [draft, inputRef])

  const send = () => {
    const text = useChat.getState().draft.trim()
    if (!text || text.length > MAX_CHAT_LENGTH || disabled) return
    useChat.getState().setDraft('')
    void useChat.getState().send(text)
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || e.altKey || e.ctrlKey || e.metaKey || e.nativeEvent.isComposing) return
    e.preventDefault()
    send()
  }

  return (
    <form
      className={clsx('chat-composer', over && 'is-over')}
      onSubmit={e => {
        e.preventDefault()
        send()
      }}
    >
      <textarea
        ref={inputRef}
        className="chat-composer__input"
        rows={1}
        value={draft}
        disabled={disabled}
        placeholder="Message your collaborators…"
        aria-label="Message"
        aria-invalid={over || undefined}
        aria-describedby={length >= COUNTER_FROM ? 'chat-counter' : undefined}
        onChange={e => useChat.getState().setDraft(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="chat-composer__bar">
        <span className="chat-composer__hint">
          {length >= COUNTER_FROM ? (
            <span id="chat-counter" className={clsx('chat-composer__count', over && 'is-over')} aria-live="polite">
              {over ? `${length - MAX_CHAT_LENGTH} characters over the limit` : `${MAX_CHAT_LENGTH - length} characters left`}
            </span>
          ) : (
            <span title="Enter sends the message; Shift+Enter starts a new line">
              <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
            </span>
          )}
        </span>
        <IconButton
          type="submit"
          icon={SendHorizontal}
          label="Send message"
          size="sm"
          variant="secondary"
          className="chat-composer__send"
          disabled={empty || over || disabled}
        />
      </div>
    </form>
  )
}
