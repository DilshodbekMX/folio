/**
 * Shared helpers for the Folio end-to-end suite.
 *
 *   test                       @playwright/test's `test` whose contexts start with auto-compile off
 *   e2eState() / docker()      users, password, project ids, base URL, runner of the server under test
 *   authFile(user)             storage state written by global-setup (use with test.use / newContext)
 *   userContext(browser, u)    a logged-in browser context for alice | bob | carol (auto-compile off)
 *   apiAs(u)                   an API request context (cookie + CSRF header) for setup/assertions
 *   newProject(name, opts)     a throw-away project (files, bob = editor, carol = viewer); removeProject(id)
 *   login(page, email, pw)     log in through the UI
 *   openProject(page, id)      open the editor page and wait until the project is live
 *   folio(page, fn, arg)       run fn(window.__folio, arg) in the page (stores, docSessions…)
 *   openFile / editorText / waitForEditorText / typeInEditor   the CodeMirror editor
 *   setCursor / editorIndex / cursorLine / completionLabels     caret + autocomplete in CodeMirror
 *   acquireDoc / docText / docInsert / barrier                 Yjs doc sessions through docSessions
 *   compile / waitForCompile / waitForPdf / waitForBuild       compile + PDF pane
 *   netSwitch(context)         cut / restore the page's WebSockets (offline editing)
 *   startServer(opts)          an extra, isolated server (e.g. empty for /setup, or restartable)
 *   shot(page, name)           screenshot into E2E_SHOTS (default test-results/e2e-shots)
 */
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { expect, request, test as base, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test'

export const E2E_DIR = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(E2E_DIR, '..')
export const AUTH_DIR = path.join(E2E_DIR, '.auth')
export const STATE_COPY = path.join(AUTH_DIR, 'state.json')

export type UserKey = 'alice' | 'bob' | 'carol'

export interface E2EState {
  base: string
  dataDir: string
  webDist: string
  runner: string
  password: string
  users: Record<string, { email: string; name: string; admin: boolean }>
  projects: { paper: string | null; example: string | null }
  serverLog: string
}

/** State of the server under test (from scripts/e2e-server.mjs via FOLIO_E2E_STATE). */
export function e2eState(): E2EState {
  const file = process.env.FOLIO_E2E_STATE ?? STATE_COPY
  if (!fs.existsSync(file)) throw new Error(`e2e state file not found (${file}); run the suite through playwright.config.ts`)
  return JSON.parse(fs.readFileSync(file, 'utf8')) as E2EState
}

export function authFile(user: string): string {
  return path.join(AUTH_DIR, `${user}.json`)
}

/** True when the server under test compiles with real TeX (COMPILE_RUNNER=docker). */
export function docker(): boolean {
  return e2eState().runner === 'docker'
}

/**
 * Init script: a project page opened in this context starts with "Auto compile" off (the option
 * lives in localStorage per project and browser), unless the test set it already. Keeps
 * background compiles (compile on open, compile after typing) out of tests that do not ask for
 * them; the PDF spec switches it on through the compile menu where it is the point.
 */
const AUTO_COMPILE_OFF = `(() => {
  try {
    const m = /^\\/project\\/([^/?#]+)/.exec(location.pathname)
    if (!m) return
    const key = 'folio:compile:' + m[1]
    if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify({ autoCompile: false, draft: false, stopOnFirstError: false }))
  } catch {}
})()`

export async function noAutoCompile(context: BrowserContext): Promise<void> {
  await context.addInitScript({ content: AUTO_COMPILE_OFF })
}

/** `test` with auto-compile off in every context the fixtures create (see AUTO_COMPILE_OFF). */
export const test = base.extend({
  context: async ({ context }, use) => {
    await noAutoCompile(context)
    await use(context)
  },
})

export async function userContext(
  browser: Browser, user: UserKey, opts: Parameters<Browser['newContext']>[0] & { autoCompile?: boolean } = {},
): Promise<BrowserContext> {
  const st = e2eState()
  const { autoCompile, ...rest } = opts
  const ctx = await browser.newContext({ baseURL: st.base, viewport: { width: 1600, height: 1000 }, storageState: authFile(user), ...rest })
  if (!autoCompile) await noAutoCompile(ctx)
  return ctx
}

/** API client for a seeded user (state-changing requests carry the CSRF header + Origin). */
export async function apiAs(user: UserKey | null, base = e2eState().base): Promise<APIRequestContext> {
  return request.newContext({
    baseURL: base,
    // explicit empty state for anonymous clients: inside a test the default would be the test's storageState
    storageState: user ? authFile(user) : { cookies: [], origins: [] },
    extraHTTPHeaders: { 'X-Folio-Csrf': '1', Origin: base },
  })
}

/** JSON of a successful API response (fails the test with the body otherwise). */
export async function json<T = any>(res: Awaited<ReturnType<APIRequestContext['get']>>): Promise<T> {
  if (!res.ok()) throw new Error(`${res.url()} → ${res.status()} ${await res.text()}`)
  const text = await res.text()
  return (text ? JSON.parse(text) : null) as T
}

export interface NewFile { path: string; content: string | Buffer }

/**
 * Create a throw-away project owned by `owner` (default alice): the template's files plus
 * `files` (text files through the API, Buffers as uploads), bob as editor and carol as viewer
 * (unless `members: false`). Returns its id.
 */
export async function newProject(name: string, opts: { owner?: UserKey; template?: 'blank' | 'example'; files?: NewFile[]; members?: boolean } = {}): Promise<string> {
  const api = await apiAs(opts.owner ?? 'alice')
  try {
    const { id } = await json<{ id: string }>(await api.post('/api/projects', { data: { name, template: opts.template ?? 'blank' } }))
    const detail = await json<{ files: { id: string; path: string }[] }>(await api.get(`/api/projects/${id}`))
    for (const f of opts.files ?? []) {
      const existing = detail.files.find(x => x.path === f.path)
      if (typeof f.content === 'string' && !existing) {
        await json(await api.post(`/api/projects/${id}/files`, { data: { path: f.path, kind: 'text', content: f.content } }))
      } else {
        await uploadFile(api, id, f.path, typeof f.content === 'string' ? Buffer.from(f.content) : f.content)
      }
    }
    if (opts.members !== false) {
      const st = e2eState()
      await json(await api.post(`/api/projects/${id}/members`, { data: { email: st.users.bob.email, role: 'editor' } }))
      await json(await api.post(`/api/projects/${id}/members`, { data: { email: st.users.carol.email, role: 'viewer' } }))
    }
    return id
  } finally {
    await api.dispose()
  }
}

/** Upload (or replace) one file of a project through the multipart upload route. */
export async function uploadFile(api: APIRequestContext, projectId: string, filePath: string, data: Buffer): Promise<void> {
  const folder = filePath.includes('/') ? filePath.slice(0, filePath.lastIndexOf('/')) : ''
  const name = filePath.slice(filePath.lastIndexOf('/') + 1)
  const res = await api.post(`/api/projects/${projectId}/upload`, {
    multipart: { folder, replace: 'true', files: { name, mimeType: 'application/octet-stream', buffer: data } },
  })
  await json(res)
}

export async function removeProject(projectId: string, owner: UserKey = 'alice'): Promise<void> {
  const api = await apiAs(owner)
  try {
    await api.delete(`/api/projects/${projectId}`)
  } finally {
    await api.dispose()
  }
}

/** Current text of a project file as the server serves it (live Yjs text for open documents). */
export async function rawText(projectId: string, fileId: string, user: UserKey = 'alice'): Promise<string> {
  const api = await apiAs(user)
  try {
    return await (await api.get(`/api/projects/${projectId}/files/${fileId}/raw`)).text()
  } finally {
    await api.dispose()
  }
}

/** A small valid PNG (w × h, a colour gradient) for uploads and previews. */
export function png(w: number, h: number, rgb: [number, number, number] = [30, 120, 200]): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    return c >>> 0
  })
  const crc = (buf: Buffer) => {
    let c = 0xffffffff
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8)
    return (c ^ 0xffffffff) >>> 0
  }
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const c = Buffer.alloc(4)
    c.writeUInt32BE(crc(td))
    return Buffer.concat([len, td, c])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const raw = Buffer.alloc((w * 3 + 1) * h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3
      raw[o] = rgb[0]
      raw[o + 1] = Math.round((x * 255) / w)
      raw[o + 2] = rgb[2]
    }
  }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}

// ---------------------------------------------------------------------------
// UI
// ---------------------------------------------------------------------------

export async function login(page: Page, email: string, password = e2eState().password): Promise<void> {
  await page.getByLabel('Email', { exact: true }).fill(email)
  await page.getByLabel('Password', { exact: true }).fill(password)
  await page.getByRole('button', { name: 'Log in' }).click()
}

/**
 * Run `fn(window.__folio, arg)` in the page. `fn` must be self-contained (it is sent as source);
 * it runs through the DevTools protocol, so the app's CSP (no 'unsafe-eval') does not apply.
 */
export async function folio<R, A = undefined>(page: Page, fn: (f: any, arg: A) => R | Promise<R>, arg?: A): Promise<R> {
  await page.waitForFunction(() => !!(window as any).__folio?.useProject)
  return page.evaluate(`(${fn.toString()})(window.__folio, ${arg === undefined ? 'undefined' : JSON.stringify(arg)})`) as Promise<R>
}

/** Open a project's editor page and wait until the REST load and the meta room are ready. */
export async function openProject(page: Page, projectId: string): Promise<void> {
  await page.goto(`/project/${projectId}`)
  await page.waitForFunction(id => {
    const p = (window as any).__folio?.useProject?.getState()
    return p && p.projectId === id && p.loadState === 'ready' && p.connection === 'connected'
  }, projectId, { timeout: 30_000 })
}

export async function fileIdByPath(page: Page, p: string): Promise<string> {
  const id = await folio(page, (f, q: string) => f.useProject.getState().fileByPath(q)?.id ?? null, p)
  if (!id) throw new Error(`no file ${p} in the open project`)
  return id
}

/** Open a file in the editor and wait until CodeMirror shows its synced text. */
export async function openFile(page: Page, p: string): Promise<void> {
  const id = await fileIdByPath(page, p)
  await folio(page, (f, fileId: string) => f.useEditor.getState().openFile(fileId), id)
  await page.waitForFunction(fileId => {
    const f = (window as any).__folio
    const s = f.docSessions.get(fileId)
    return f.useEditor.getState().openFileId === fileId && !!f.useEditor.getState().view && !!s && s.isSynced()
  }, id, { timeout: 30_000 })
}

export async function editorText(page: Page): Promise<string> {
  return folio(page, f => f.useEditor.getState().view?.state.doc.toString() ?? '')
}

export async function waitForEditorText(page: Page, includes: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(s => ((window as any).__folio.useEditor.getState().view?.state.doc.toString() ?? '').includes(s), includes, { timeout })
}

/** Click into the editor (end of the document) and type. */
export async function typeInEditor(page: Page, text: string): Promise<void> {
  await page.locator('.cm-content').first().click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.type(text)
}

/** Focus the editor and put the caret at document offset `pos` (-1: end of the document). */
export async function setCursor(page: Page, pos: number): Promise<void> {
  await folio(page, (f, p: number) => {
    const v = f.useEditor.getState().view
    v.focus()
    v.dispatch({ selection: { anchor: p < 0 ? v.state.doc.length : p }, scrollIntoView: true })
  }, pos)
}

/** Offset of the first occurrence of `needle` in the editor text (fails when missing). */
export async function editorIndex(page: Page, needle: string): Promise<number> {
  const i = (await editorText(page)).indexOf(needle)
  if (i < 0) throw new Error(`editor text has no ${JSON.stringify(needle)}`)
  return i
}

/** 1-based line of the main selection's head. */
export async function cursorLine(page: Page): Promise<number> {
  return folio(page, f => {
    const v = f.useEditor.getState().view
    return v.state.doc.lineAt(v.state.selection.main.head).number as number
  })
}

/** Labels of the open autocomplete list (waits for it). */
export async function completionLabels(page: Page): Promise<string[]> {
  await expect(page.locator('.cm-tooltip-autocomplete li').first()).toBeVisible()
  return page.locator('.cm-tooltip-autocomplete li .cm-completionLabel').allTextContents()
}

// ---------------------------------------------------------------------------
// Yjs doc sessions (API-level collaboration checks, independent of the editor UI)
// ---------------------------------------------------------------------------

/** Acquire a doc session for a project file and wait for its first sync. */
export async function acquireDoc(page: Page, p: string): Promise<string> {
  const fileId = await fileIdByPath(page, p)
  await folio(page, async (f, id: string) => {
    const w = window as any
    w.__e2eDocs ??= {}
    if (!w.__e2eDocs[id]) {
      const st = f.useProject.getState()
      w.__e2eDocs[id] = f.docSessions.acquire(st.projectId, st.files[id])
    }
    await w.__e2eDocs[id].synced
  }, fileId)
  return fileId
}

export async function docText(page: Page, fileId: string): Promise<string> {
  return page.evaluate(id => (window as any).__e2eDocs[id].ytext.toString() as string, fileId)
}

export async function docInsert(page: Page, fileId: string, index: number, text: string): Promise<void> {
  await page.evaluate(([id, i, t]) => { (window as any).__e2eDocs[id].ytext.insert(i, t) }, [fileId, index, text] as const)
}

export async function docReadOnly(page: Page, fileId: string): Promise<boolean> {
  return page.evaluate(id => (window as any).__e2eDocs[id].readOnly as boolean, fileId)
}

/** MSG_BARRIER round trip on every doc session: the server has applied everything sent before. */
export async function barrier(page: Page): Promise<void> {
  await folio(page, f => f.docSessions.barrierAll())
}

export async function waitForDocText(page: Page, fileId: string, includes: string, timeout = 20_000): Promise<void> {
  await page.waitForFunction(([id, s]) => ((window as any).__e2eDocs[id]?.ytext.toString() ?? '').includes(s), [fileId, includes] as const, { timeout })
}

// ---------------------------------------------------------------------------
// Compile / PDF
// ---------------------------------------------------------------------------

/** Compile through the compile store (barrier first, like the Recompile button). */
export async function compile(page: Page, opts: { fromScratch?: boolean } = {}): Promise<{ status: string; buildId: string | null }> {
  return folio(page, async (f, o: { fromScratch?: boolean }) => {
    const r = await f.useCompile.getState().compile(o)
    return { status: r?.status ?? 'none', buildId: r?.buildId ?? null }
  }, opts)
}

export async function waitForCompile(page: Page, timeout = 180_000): Promise<{ status: string }> {
  await page.waitForFunction(() => {
    const c = (window as any).__folio.useCompile.getState()
    return c.status === 'idle' && !!c.last
  }, undefined, { timeout })
  return folio(page, f => ({ status: f.useCompile.getState().last.status as string }))
}

/** The PDF viewer shows at least one rendered page. */
export async function waitForPdf(page: Page, timeout = 180_000): Promise<void> {
  await expect(page.locator('.pdfViewer .page canvas, .pdfViewer .page img').first()).toBeVisible({ timeout })
}

export async function lastBuildId(page: Page): Promise<string | null> {
  return folio(page, f => (f.useCompile.getState().last?.buildId as string | undefined) ?? null)
}

/**
 * Wait until a compile newer than `prevBuildId` has finished and — when it made a PDF — the
 * viewer shows that build. Returns the new build's status.
 */
export async function waitForBuild(page: Page, prevBuildId: string | null, timeout = 180_000): Promise<string> {
  await page.waitForFunction(prev => {
    const f = (window as any).__folio
    const c = f.useCompile.getState()
    const v = f.usePdfView.getState()
    if (c.status !== 'idle' || !c.last || c.last.buildId === prev) return false
    return !c.last.pdfUrl || (v.buildId === c.last.buildId && v.status === 'ready')
  }, prevBuildId, { timeout, polling: 100 })
  return folio(page, f => f.useCompile.getState().last.status as string)
}

/** State of the PDF viewer (usePdfView): build shown, page, pages, zoom. */
export async function pdfView(page: Page): Promise<{ status: string; buildId: string | null; page: number; pages: number; scale: number; scaleValue: string }> {
  return folio(page, f => {
    const v = f.usePdfView.getState()
    return { status: v.status, buildId: v.buildId, page: v.page, pages: v.pages, scale: v.scale, scaleValue: v.scaleValue }
  })
}

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export interface NetSwitch {
  /** close every WebSocket of the context and refuse new ones */
  down(): void
  /** let new WebSockets through again (the app reconnects by itself) */
  up(): void
}

/**
 * Route the context's `/ws/` sockets through a switch. Application close codes (4403, 4410…)
 * are forwarded both ways, so the app behaves as with a direct connection.
 */
export async function netSwitch(context: BrowserContext): Promise<NetSwitch> {
  let blocked = false
  const live = new Set<{ ws: any; server: any }>()
  await context.routeWebSocket(/\/ws\//, ws => {
    if (blocked) {
      ws.close({ code: 3000, reason: 'blocked' })
      return
    }
    const server = ws.connectToServer()
    const entry = { ws, server }
    live.add(entry)
    const forward = (code: number | undefined, reason: string | undefined) => (code !== undefined && code >= 3000 && code < 5000 ? { code, reason } : undefined)
    ws.onClose((code, reason) => {
      live.delete(entry)
      try { server.close(forward(code, reason)) } catch { /* already closed */ }
    })
    server.onClose((code, reason) => {
      live.delete(entry)
      try { ws.close(forward(code, reason)) } catch { /* already closed */ }
    })
  })
  return {
    down() {
      blocked = true
      for (const e of [...live]) {
        try { e.server.close() } catch { /* already closed */ }
        try { e.ws.close({ code: 3000, reason: 'drop' }) } catch { /* already closed */ }
      }
    },
    up() {
      blocked = false
    },
  }
}

// ---------------------------------------------------------------------------
// Extra servers
// ---------------------------------------------------------------------------

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address() as net.AddressInfo
      srv.close(() => resolve(port))
    })
  })
}

export interface ExtraServer {
  base: string
  port: number
  dataDir: string
  state: E2EState
  /** stop gracefully (keeps the data dir when `keepData`) */
  stop(): Promise<void>
  /** stop, then start again on the same port and data dir (`whileDown` runs in between) */
  restart(whileDown?: () => Promise<void>): Promise<void>
}

/**
 * Start another server with scripts/e2e-server.mjs (reusing the already built web app).
 * `empty: true` → no accounts (first-run setup); otherwise seeded like the main server.
 * `env` adds variables to the launcher's environment (after FOLIO_ENV_FILE=none, so a test can
 * hand it an env file and check that the server still ignores it).
 */
export async function startServer(opts: { empty?: boolean; paper?: boolean; runner?: string; env?: Record<string, string> } = {}): Promise<ExtraServer> {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-e2e-extra-'))
  const main = e2eState()
  let child: ChildProcess | null = null
  let state!: E2EState
  const launch = () => new Promise<void>((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(ROOT, 'scripts/e2e-server.mjs')], {
      cwd: ROOT,
      env: {
        ...process.env,
        // never the developer's .env (e2e-server.mjs sets this for the server too)
        FOLIO_ENV_FILE: 'none',
        E2E_PORT: String(port),
        E2E_DATA_DIR: dataDir,
        E2E_WEB_DIST: main.webDist,
        E2E_BUILD: 'never',
        E2E_EMPTY: opts.empty ? '1' : '0',
        E2E_PAPER: opts.paper ? '1' : '0',
        COMPILE_RUNNER: opts.runner ?? main.runner,
        ...opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child = proc
    let out = ''
    const onData = (d: Buffer) => {
      out += d.toString()
      const m = /FOLIO_E2E_READY (\S+)/.exec(out)
      if (m) {
        proc.stdout!.off('data', onData)
        state = JSON.parse(fs.readFileSync(m[1], 'utf8')) as E2EState
        resolve()
      }
    }
    proc.stdout!.on('data', onData)
    proc.stderr!.on('data', (d: Buffer) => { out += d.toString() })
    proc.once('exit', code => reject(new Error(`extra server exited early (code ${code}):\n${out}`)))
  })
  const stopChild = () => new Promise<void>(resolve => {
    const c = child
    if (!c || c.exitCode !== null) return resolve()
    c.once('exit', () => resolve())
    c.kill('SIGTERM')
  })
  try {
    await launch()
  } catch (err) {
    fs.rmSync(dataDir, { recursive: true, force: true })
    throw err
  }
  return {
    base: `http://127.0.0.1:${port}`,
    port,
    dataDir,
    get state() { return state },
    async stop() {
      await stopChild()
      fs.rmSync(dataDir, { recursive: true, force: true })
    },
    async restart(whileDown?: () => Promise<void>) {
      await stopChild()
      if (whileDown) await whileDown()
      await launch()
    },
  }
}

// ---------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------

export const SHOTS_DIR = path.resolve(ROOT, process.env.E2E_SHOTS ?? 'test-results/e2e-shots')

export async function shot(page: Page, name: string, opts: { fullPage?: boolean } = {}): Promise<string> {
  fs.mkdirSync(SHOTS_DIR, { recursive: true })
  const file = path.join(SHOTS_DIR, `${name}.png`)
  // finite CSS animations/transitions are fast-forwarded: no half-faded modals in the pictures
  await page.screenshot({ path: file, fullPage: opts.fullPage ?? false, animations: 'disabled' })
  return file
}

/** Switch the UI theme for the current page (the web app mirrors it to <html data-theme>). */
export async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.evaluate(t => { document.documentElement.dataset.theme = t }, theme)
}
