/**
 * Routes and guards (SPEC §6.1).
 *
 *   /setup              first-run admin account (only while setupStatus.needsSetup)
 *   /login, /register   guests only (/register only when allowSignup); honour ?next=
 *   /                   dashboard (auth)
 *   /project/:projectId editor (auth)
 *   /join/:token        share-link join (auth; unauthenticated → /login?next=…)
 *   /admin              admin only
 *   *                   not found
 *
 * Boot: useAuth.init() loads setup status + the session; while it runs a splash is shown.
 * The resolved theme is mirrored to <html data-theme>, the "Dark mode PDF" preference to
 * <html data-pdf-invert> (styles/base.css inverts the PDF pages while the dark theme is on).
 * Confirm/prompt dialogs belong to the page that opened them: every route change and sign-in /
 * sign-out cancels them (ui/Dialogs cancelAllDialogs); signing out also clears every toast.
 *
 * The editor page and the admin page are loaded on demand (pages/lazy.tsx, PERF-6): this module
 * and everything it imports statically must stay free of the editor's code (CodeMirror, Yjs).
 */
import { Suspense, useEffect, useLayoutEffect, useState, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router'
import { RefreshCw } from 'lucide-react'
import { onSignOut, useAuth, useResolvedTheme } from './stores/auth'
import { usePrefs } from './stores/prefs'
import { Button, ContextMenuHost, DialogHost, FolioMark, Spinner, Toaster, cancelAllDialogs, dismissAllToasts } from './ui'
import { loginPathFor, safeNext } from './pages/nav'
import { SetupPage } from './pages/SetupPage'
import { LoginPage } from './pages/LoginPage'
import { RegisterPage } from './pages/RegisterPage'
import { DashboardPage } from './pages/DashboardPage'
import { JoinPage } from './pages/JoinPage'
import { NotFound } from './pages/NotFound'
import { ProjectLoading } from './pages/ProjectLoading'
import { LazyAdminPage, LazyBackgroundSyncNotice, LazyBoundary, LazyProjectPage, useEditorCodeLoaded } from './pages/lazy'
import './pages/pages.css'

// the previous account's notifications (project names, collaborators…) never outlive its session
onSignOut(() => {
  cancelAllDialogs()
  dismissAllToasts()
})

export function App() {
  const status = useAuth(s => s.status)
  const setup = useAuth(s => s.setup)
  const error = useAuth(s => s.error)
  const theme = useResolvedTheme()
  const pdfInvert = usePrefs(s => s.pdfInvertDark)

  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme
  }, [theme])

  useLayoutEffect(() => {
    if (pdfInvert) document.documentElement.dataset.pdfInvert = ''
    else delete document.documentElement.dataset.pdfInvert
  }, [pdfInvert])

  useEffect(() => {
    void useAuth.getState().init()
  }, [])

  // a pending confirmation must not survive the page (or the session) it was asked for
  const location = useLocation()
  useEffect(() => {
    cancelAllDialogs()
  }, [location.pathname, status])

  const editorCodeLoaded = useEditorCodeLoaded()

  let content: ReactNode
  if (status === 'loading') content = <BootScreen />
  else if (status === 'anonymous' && !setup && error) content = <ServerUnavailable message={error} />
  else content = <AppRoutes />

  return (
    <>
      {content}
      {editorCodeLoaded && (
        <LazyBoundary quiet>
          <Suspense fallback={null}>
            <LazyBackgroundSyncNotice />
          </Suspense>
        </LazyBoundary>
      )}
      <Toaster />
      <DialogHost />
      <ContextMenuHost />
    </>
  )
}

function AppRoutes() {
  return (
    <SetupGate>
      <Routes>
        <Route path="/setup" element={<SetupRoute />} />
        <Route path="/login" element={<GuestOnly><LoginPage /></GuestOnly>} />
        <Route path="/register" element={<GuestOnly><RegisterRoute /></GuestOnly>} />
        <Route path="/" element={<RequireAuth><DashboardPage /></RequireAuth>} />
        <Route path="/project/:projectId" element={<RequireAuth><Lazy fallback={<ProjectLoading />}><LazyProjectPage /></Lazy></RequireAuth>} />
        <Route path="/join/:token" element={<RequireAuth><JoinPage /></RequireAuth>} />
        <Route path="/admin" element={<RequireAuth admin><Lazy><LazyAdminPage /></Lazy></RequireAuth>} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </SetupGate>
  )
}

/** A page loaded on demand: `fallback` while its code loads, a "Reload" page if it cannot be. */
function Lazy({ children, fallback = <BootScreen /> }: { children: ReactNode; fallback?: ReactNode }) {
  return (
    <LazyBoundary>
      <Suspense fallback={fallback}>{children}</Suspense>
    </LazyBoundary>
  )
}

/** While no user exists every route leads to /setup. */
function SetupGate({ children }: { children: ReactNode }) {
  const needsSetup = useAuth(s => s.setup?.needsSetup ?? false)
  const location = useLocation()
  if (needsSetup && location.pathname !== '/setup') return <Navigate to="/setup" replace />
  return <>{children}</>
}

function SetupRoute() {
  const needsSetup = useAuth(s => s.setup?.needsSetup ?? false)
  const status = useAuth(s => s.status)
  if (!needsSetup) return <Navigate to={status === 'authenticated' ? '/' : '/login'} replace />
  return <SetupPage />
}

function RegisterRoute() {
  const allowSignup = useAuth(s => s.setup?.allowSignup ?? false)
  const location = useLocation()
  if (!allowSignup) return <Navigate to={`/login${location.search}`} replace />
  return <RegisterPage />
}

function RequireAuth({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const status = useAuth(s => s.status)
  const isAdmin = useAuth(s => s.me?.isAdmin ?? false)
  const location = useLocation()
  if (status !== 'authenticated') return <Navigate to={loginPathFor(location)} replace />
  if (admin && !isAdmin) return <NotFound />
  return <>{children}</>
}

function GuestOnly({ children }: { children: ReactNode }) {
  const status = useAuth(s => s.status)
  const [params] = useSearchParams()
  if (status === 'authenticated') return <Navigate to={safeNext(params.get('next'))} replace />
  return <>{children}</>
}

function BootScreen() {
  // Avoid flashing a spinner for fast boots.
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const t = window.setTimeout(() => setVisible(true), 250)
    return () => window.clearTimeout(t)
  }, [])
  return (
    <div className="pg-boot" aria-busy="true">
      {visible && (
        <div className="pg-boot__inner">
          <FolioMark size={36} tile />
          <Spinner size={18} label="Loading Folio" />
        </div>
      )}
    </div>
  )
}

function ServerUnavailable({ message }: { message: string }) {
  const [busy, setBusy] = useState(false)
  return (
    <div className="pg-boot">
      <div className="pg-state">
        <FolioMark size={40} tile />
        <h1 className="pg-state__title">Folio can’t reach its server</h1>
        <p className="pg-state__text">{message} If you run Folio yourself, check that the server process is running, then try again.</p>
        <Button
          variant="primary"
          icon={RefreshCw}
          loading={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await useAuth.getState().init()
            } finally {
              setBusy(false)
            }
          }}
        >
          Try again
        </Button>
      </div>
    </div>
  )
}
