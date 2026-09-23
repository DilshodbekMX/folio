/**
 * Session + current user (SPEC §6.3). All actions except init() and logout() reject with ApiError
 * on failure.
 *
 * Signing out (SEC2-1). The session cookie is HttpOnly: only the server's answer to
 * POST /api/auth/logout clears it, so a logout the server never received (offline, server
 * restarting, proxy error) leaves this browser holding a valid session. logout() therefore:
 * - signs out locally at once: every onSignOut() listener runs first (the realtime connections go
 *   first — doc sessions are destroyed, never drained, and the meta rooms are closed, so nothing
 *   more reaches the server under this account; per-user caches are dropped), then status becomes
 *   'anonymous';
 * - records 'folio:logout-pending' in localStorage before asking the server, and keeps asking
 *   (backoff, and at once when the browser comes back online) until the server answered;
 * - while that record exists, init() ends the old session before anything else and never signs
 *   in with it (every tab of this browser, and the next start of the app, honour it); other open
 *   tabs sign out too (storage event). `logoutPending` is true meanwhile (the login page says so).
 * A login / registration / setup rotates away whatever session the request carried (the server
 * destroys it), so a successful one also settles a pending logout.
 *
 * Any other end of the session (a request answered 401, a socket closed with 4401, init() no
 * longer finding it, another account signed in) runs the listeners with reason 'ended'.
 */
import { useSyncExternalStore } from 'react'
import { create } from 'zustand'
import {
  DEFAULT_USER_SETTINGS,
  type Me, type RegisterRequest, type SetupStatus, type UpdateMeRequest, type UserSettings,
} from '@folio/shared/api'
import { api } from '../api/endpoints'
import { ApiError, errorMessage, onApiError } from '../api/client'
import { readString, writeString } from '../lib/storage'
import { registerTestHook } from './testHooks'

export type AuthStatus = 'loading' | 'authenticated' | 'anonymous'
export type ThemePreference = UserSettings['theme']
export type ResolvedTheme = 'light' | 'dark'

export interface AuthState {
  status: AuthStatus
  me: Me | null
  setup: SetupStatus | null
  /** set when the server could not be reached during init() */
  error: string | null
  /**
   * Signed out here, but the server has not confirmed the logout yet (it could not be reached):
   * this browser may still hold a valid session cookie, which Folio never uses; retried until the
   * server answers.
   */
  logoutPending: boolean
  init(): Promise<void>
  login(email: string, password: string): Promise<void>
  /** Never rejects: signs out locally at once, then ends the server session (retried until it could). */
  logout(): Promise<void>
  register(req: RegisterRequest): Promise<void>
  setupAdmin(req: RegisterRequest): Promise<void>
  updateMe(req: UpdateMeRequest): Promise<void>
  /** optimistic: applied immediately, reverted if the server rejects it */
  updateSettings(patch: Partial<UserSettings>): Promise<void>
}

/**
 * 'logout': the user logged out in this tab (and agreed to discard unsent changes);
 * 'ended': the session ended otherwise — expired or revoked, logged out in another tab, or
 * another account signed in — so what the user had not saved yet is kept for them.
 */
export type SignOutReason = 'logout' | 'ended'
export interface SignOutInfo { userId: string; reason: SignOutReason }

const THEME_KEY = 'folio:theme'
const THEMES: readonly ThemePreference[] = ['light', 'dark', 'system']
export const LOGOUT_PENDING_KEY = 'folio:logout-pending'
const LOGOUT_TIMEOUT_MS = 8000
const LOGOUT_RETRY_MIN_MS = 2000
const LOGOUT_RETRY_MAX_MS = 60_000

/** Fill settings the server did not send (older rows, new settings keys). */
function normalizeMe(me: Me): Me {
  return { ...me, settings: { ...DEFAULT_USER_SETTINGS, ...(me.settings ?? {}) } }
}

function rememberTheme(me: Me | null): void {
  if (me) writeString(THEME_KEY, me.settings.theme)
}

let initPromise: Promise<void> | null = null
// optimistic settings bookkeeping: only the newest request may commit or revert
let settingsSeq = 0
let confirmedSeq = 0
let confirmedSettings: UserSettings | null = null

// -- sign-out listeners ------------------------------------------------------------------------------

const signOutListeners = new Set<(info: SignOutInfo) => void>()
let signingOut = false

/**
 * Run `fn` when a signed-in user signs out or their session ends, before the store turns
 * anonymous (and before any page unmounts): drop everything that belongs to that account.
 */
export function onSignOut(fn: (info: SignOutInfo) => void): () => void {
  signOutListeners.add(fn)
  return () => {
    signOutListeners.delete(fn)
  }
}

/** True while the onSignOut() listeners run (store updates they cause are part of signing out). */
export function isSigningOut(): boolean {
  return signingOut
}

function runSignOutListeners(info: SignOutInfo): void {
  const was = signingOut
  signingOut = true
  try {
    for (const fn of [...signOutListeners]) {
      try {
        fn(info)
      } catch (e) {
        console.error('[auth] sign-out listener failed', e)
      }
    }
  } finally {
    signingOut = was
  }
}

// -- pending server logout ---------------------------------------------------------------------------

function logoutRecorded(): boolean {
  return readString(LOGOUT_PENDING_KEY) !== null
}

let logoutAttempt: Promise<boolean> | null = null

/** POST /api/auth/logout (bounded). True once the server holds no session for this browser. */
function endServerSession(): Promise<boolean> {
  if (logoutAttempt) return logoutAttempt
  const attempt = (async () => {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), LOGOUT_TIMEOUT_MS)
    try {
      await api.logout({ signal: ctrl.signal, silent: true })
      return true
    } catch (e) {
      // 401: there is no session to end
      return e instanceof ApiError && e.status === 401
    } finally {
      clearTimeout(timer)
    }
  })()
  logoutAttempt = attempt
  void attempt.finally(() => {
    if (logoutAttempt === attempt) logoutAttempt = null
  })
  return attempt
}

let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = LOGOUT_RETRY_MIN_MS
let retrying = false

function onOnline(): void {
  if (!retrying) return
  retryDelay = LOGOUT_RETRY_MIN_MS
  if (retryTimer !== null) clearTimeout(retryTimer)
  retryTimer = null
  void retryLogout()
}

function scheduleLogoutRetry(): void {
  if (!retrying) return
  if (retryTimer !== null) clearTimeout(retryTimer)
  retryTimer = setTimeout(() => {
    retryTimer = null
    void retryLogout()
  }, retryDelay)
  retryDelay = Math.min(LOGOUT_RETRY_MAX_MS, retryDelay * 2)
}

/** This tab keeps asking the server to end the session (until it answers, or another tab did). */
function startLogoutRetries(): void {
  if (typeof window === 'undefined') return
  if (!retrying) {
    retrying = true
    retryDelay = LOGOUT_RETRY_MIN_MS
    window.addEventListener('online', onOnline)
  }
  scheduleLogoutRetry()
}

function stopLogoutRetries(): void {
  if (retryTimer !== null) clearTimeout(retryTimer)
  retryTimer = null
  if (retrying && typeof window !== 'undefined') window.removeEventListener('online', onOnline)
  retrying = false
}

async function retryLogout(): Promise<void> {
  if (!retrying) return
  // settled meanwhile (by another tab, or a new login): never send a logout for a newer session
  if (!logoutRecorded()) {
    logoutSettled()
    return
  }
  if (await endServerSession()) logoutSettled()
  else scheduleLogoutRetry()
}

function recordLogout(): void {
  writeString(LOGOUT_PENDING_KEY, String(Date.now()))
  useAuth.setState({ logoutPending: true })
}

/** The server holds no session of the signed-out user any more. */
function logoutSettled(): void {
  stopLogoutRetries()
  writeString(LOGOUT_PENDING_KEY, null)
  if (useAuth.getState().logoutPending) useAuth.setState({ logoutPending: false })
}

/**
 * Sign in through `start` (login, registration, setup). A pending logout is settled first (best
 * effort: the server rotates away whatever session the request carries anyway) and its retries
 * are paused meanwhile — a retry sent after the new session's cookie arrived would end it.
 */
async function signIn(start: () => Promise<Me>): Promise<Me> {
  if (logoutRecorded()) {
    stopLogoutRetries()
    if (await endServerSession()) logoutSettled()
  }
  try {
    return await start()
  } catch (e) {
    if (logoutRecorded()) startLogoutRetries()
    throw e
  }
}

export const useAuth = create<AuthState>()((set, get) => {
  const setMe = (me: Me) => {
    const normalized = normalizeMe(me)
    const prev = get().me
    // another account now holds this browser's session: the previous one's state goes first
    if (prev && prev.id !== normalized.id) runSignOutListeners({ userId: prev.id, reason: 'ended' })
    confirmedSettings = normalized.settings
    rememberTheme(normalized)
    set({ me: normalized, status: 'authenticated', error: null })
  }

  /** A new session replaced whatever this browser held (login, registration, setup). */
  const sessionStarted = (me: Me) => {
    logoutSettled()
    setMe(me)
  }

  return {
    status: 'loading',
    me: null,
    setup: null,
    error: null,
    logoutPending: logoutRecorded(),

    init() {
      if (initPromise) return initPromise
      initPromise = (async () => {
        if (logoutRecorded()) {
          // a logout the server has not confirmed: end that session before anything else, and
          // never sign in with it
          if (!get().logoutPending) set({ logoutPending: true })
          if (await endServerSession()) {
            logoutSettled()
          } else {
            let setup = get().setup
            try {
              setup = await api.setupStatus({ silent: true })
            } catch {
              // unreachable: the "can't reach its server" page offers to try again
            }
            endLocalSession('ended')
            set({ status: 'anonymous', me: null, setup, error: setup ? null : 'Could not reach the server.' })
            startLogoutRetries()
            return
          }
        }
        const [setupRes, meRes] = await Promise.allSettled([
          api.setupStatus({ silent: true }),
          api.me({ silent: true }),
        ])
        const setup = setupRes.status === 'fulfilled' ? setupRes.value : get().setup
        if (meRes.status === 'fulfilled') {
          if (logoutRecorded()) {
            // another tab logged out while this answer was on its way: that session is over here
            endLocalSession('ended')
            set({ status: 'anonymous', me: null, setup, error: null, logoutPending: true })
            return
          }
          set({ setup })
          setMe(meRes.value)
          return
        }
        const reason: unknown = meRes.reason
        const loggedOut = reason instanceof ApiError && reason.status === 401
        endLocalSession('ended')
        set({
          status: 'anonymous',
          me: null,
          setup,
          error: loggedOut ? null : errorMessage(reason, 'Could not reach the server.'),
        })
      })().finally(() => {
        initPromise = null
      })
      return initPromise
    },

    async login(email, password) {
      sessionStarted(await signIn(() => api.login({ email: email.trim(), password })))
    },

    async logout() {
      // recorded first: a tab closed before the server answered still ends the session later
      recordLogout()
      endLocalSession('logout')
      set({ status: 'anonymous', me: null, error: null })
      if (await endServerSession()) logoutSettled()
      else startLogoutRetries()
    },

    async register(req) {
      sessionStarted(await signIn(() => api.register(req)))
    },

    async setupAdmin(req) {
      const me = await signIn(() => api.setup(req))
      const setup = get().setup
      set({ setup: setup ? { ...setup, needsSetup: false } : setup })
      sessionStarted(me)
    },

    async updateMe(req) {
      setMe(await api.updateMe(req))
    },

    async updateSettings(patch) {
      const me = get().me
      if (!me) throw new ApiError(401, 'unauthorized', 'You are not signed in.')
      if (confirmedSettings === null) confirmedSettings = me.settings
      const seq = ++settingsSeq
      const optimistic: Me = { ...me, settings: { ...me.settings, ...patch } }
      rememberTheme(optimistic)
      set({ me: optimistic })
      try {
        const res = normalizeMe(await api.updateMe({ settings: patch }))
        if (seq > confirmedSeq) {
          confirmedSeq = seq
          confirmedSettings = res.settings
        }
        // a newer optimistic patch is still in flight — its response will commit
        if (seq === settingsSeq) {
          rememberTheme(res)
          set({ me: res })
        }
      } catch (e) {
        if (seq === settingsSeq) {
          const cur = get().me
          if (cur && confirmedSettings) {
            const reverted = { ...cur, settings: confirmedSettings }
            rememberTheme(reverted)
            set({ me: reverted })
          }
        }
        throw e
      }
    },
  }
})

/**
 * The signed-in user's session is over for this tab: run the onSignOut() listeners (nothing of
 * that account may keep talking to the server or stay on screen) and forget the settings
 * bookkeeping. The caller then sets the anonymous state.
 */
function endLocalSession(reason: SignOutReason): void {
  const me = useAuth.getState().me
  confirmedSettings = null
  if (me) runSignOutListeners({ userId: me.id, reason })
}

// Any request answered with 401 outside the auth routes means the session expired.
onApiError((err, info) => {
  if (err.status !== 401 || info.path.startsWith('/api/auth/')) return
  if (useAuth.getState().status === 'authenticated') {
    endLocalSession('ended')
    useAuth.setState({ status: 'anonymous', me: null })
  }
})

// Another tab logged out (its logout is pending until the server confirms): this tab shares the
// cookie, so it signs out too; the other tab settles it (or the next start of the app does).
if (typeof window !== 'undefined') {
  window.addEventListener('storage', e => {
    if (e.key !== LOGOUT_PENDING_KEY) return
    if (e.newValue !== null) {
      const st = useAuth.getState()
      if (st.me) {
        endLocalSession('ended')
        useAuth.setState({ status: 'anonymous', me: null, logoutPending: true })
      } else if (!st.logoutPending) {
        useAuth.setState({ logoutPending: true })
      }
    } else {
      stopLogoutRetries()
      if (useAuth.getState().logoutPending) useAuth.setState({ logoutPending: false })
    }
  })
}

registerTestHook('useAuth', useAuth)

/** Current user settings (defaults while logged out). Stable reference between changes. */
export function useSettings(): UserSettings {
  return useAuth(s => s.me?.settings) ?? DEFAULT_USER_SETTINGS
}

/** Non-hook access to the current settings. */
export function getSettings(): UserSettings {
  return useAuth.getState().me?.settings ?? DEFAULT_USER_SETTINGS
}

// -- theme ----------------------------------------------------------------------------------------

const darkQuery: MediaQueryList | null =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null

function subscribeSystemTheme(onChange: () => void): () => void {
  if (!darkQuery) return () => {}
  darkQuery.addEventListener('change', onChange)
  return () => darkQuery.removeEventListener('change', onChange)
}

function systemIsDark(): boolean {
  return darkQuery?.matches ?? false
}

/** Theme stored by the last signed-in session on this browser (used on the login page). */
function cachedTheme(): ThemePreference {
  const v = readString(THEME_KEY)
  return v && (THEMES as readonly string[]).includes(v) ? (v as ThemePreference) : 'system'
}

export function resolveTheme(pref: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (pref === 'system') return systemDark ? 'dark' : 'light'
  return pref
}

/** Non-hook: the effective UI theme right now. */
export function getResolvedTheme(): ResolvedTheme {
  return resolveTheme(useAuth.getState().me?.settings.theme ?? cachedTheme(), systemIsDark())
}

/** 'dark' when the OS prefers dark mode (live). */
export function useSystemTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeSystemTheme, systemIsDark, () => false) ? 'dark' : 'light'
}

/** The effective UI theme: the user's preference, following prefers-color-scheme for 'system'. */
export function useResolvedTheme(): ResolvedTheme {
  const pref = useAuth(s => s.me?.settings.theme) ?? cachedTheme()
  const systemDark = useSyncExternalStore(subscribeSystemTheme, systemIsDark, () => false)
  return resolveTheme(pref, systemDark)
}
