# Folio — self-hosted collaborative LaTeX editor (Overleaf-style)

Status: v1 build spec. Audience: the engineers (agents) building each module in parallel.
Everything here is binding unless a module owner finds a verified reason to deviate — then
document the deviation at the top of the module's main file and keep the public contract.

Research that backs these decisions (read the sections relevant to your module):
`docs/research/{features,architecture,editor-stack,pdf-synctex,logparse,history-collab-platform,critic}.md`.
Verified prototypes from the research live in the session scratchpad
`<scratch>`:
`proto/texlog.ts`, `proto/biblog.ts` (log parser), `pdfsync_research/proto/synctex2.mjs` (SyncTeX parser),
`pdfsync_research/viteapp/src/PdfPreview.ts` (pdf.js viewer), `cmyjs/collab-server.ts` + `cmyjs/web/` (Yjs server/client),
`critic/` (barrier, CSP, xr tests), `compiletest/` (docker compile experiments). You may reuse code from those
(they were written for this project). **Licensing rule:** never copy code from Overleaf (AGPL) — that includes
the scratchpad folders `ol/`, `old/` and `ref/ol-*`. LaTeX-Workshop (MIT, `ref/latexlog.ts`, `lw/`) may be
adapted with attribution in `NOTICE.md`. Never add the AGPL `codemirror-lang-latex`/`lezer-latex` packages.

---------------------------------------------------------------------------------------------------

## 1. Product scope (v1)

A single-machine, multi-user web app that reproduces the Overleaf editing experience:

**Must**
- Accounts: first-run `/setup` creates the admin; login/logout; CLI `create-user`, `reset-password`.
- Dashboard: list/search/sort projects (All, Yours, Shared with you, Archived, Trashed), New project
  (Blank, Example, Upload .zip), rename, copy, archive, trash/restore, delete forever (owner), leave
  (non-owner), download .zip.
- Editor page (Overleaf's redesigned editor layout): top bar (back to projects, menus
  File/Edit/Insert/View/Format/Help, click-to-rename title, online avatars, History, Share, Layout),
  left rail (File tree, Search, Chat; Settings + Help at the bottom), resizable split
  (panel | editor | PDF) with SyncTeX arrows on the editor/PDF divider; layouts: split, editor only,
  PDF only.
- File tree: nested folders, create file/folder, upload (button + drag-and-drop, multiple files, folders),
  rename (F2/double-click), delete (with confirm), drag-to-move, context menu, "Set as main document",
  download, binary preview (images, PDF first page, EPS via Ghostscript).
- Source editor (CodeMirror 6): LaTeX highlighting (stex, MIT), line numbers, active line, bracket
  matching, auto-close brackets, `\begin{x}` auto-inserts `\end{x}`, folding (sections + environments),
  search & replace (regex/case/word), go to line, toggle comment (Mod-/), bold/italic (Mod-b/Mod-i),
  autocomplete (commands, environments, `\ref`/`\eqref`/`\autoref`/`\cref` labels from all project
  files, `\cite*` keys from .bib files **and** `\bibitem`, file paths for `\input`/`\include`/
  `\includegraphics`/`\bibliography`), compile diagnostics in gutter + underline, native spell check
  toggle, vim/emacs keymaps, font size/family/line-height/theme/wrap settings, real-time collaboration
  with remote cursors and names, per-user undo.
- Compile: Recompile split button with dropdown (Auto compile On/Off; Compile mode Normal/Fast [draft];
  Stop on first error / Try to compile despite errors; Stop compilation; Recompile from scratch),
  Mod-Enter / Mod-s shortcuts, per-project compiler (pdfLaTeX/LaTeX/XeLaTeX/LuaLaTeX), main document,
  timeout, xr external-document pre-build, sandboxed TeX Live 2026 in Docker.
- PDF preview (pdf.js PDFViewer): continuous scroll, zoom in/out, fit width/page, page indicator,
  download PDF, open in new tab, keeps scroll position across recompiles, text selection, links.
- Logs & output files pane: Errors/Warnings/Typesetting tabs with counts, entries with file:line,
  "Go to code location", hints, raw log, other output files (.bbl, .blg, .aux, ext. docs), Clear cached files.
- SyncTeX both directions (divider arrows + double-click in PDF → code; code → PDF highlight).
- Outline panel (sections from the open file, click to jump, highlights current section).
- History: version list (auto snapshots + labels) grouped by day with authors & changed files, per-file
  diff (@codemirror/merge unified view), compare two versions, restore file / restore project,
  add/delete label, download version as .zip.
- Sharing: members with roles owner/editor/viewer (add existing user by email, change role, remove),
  link sharing (editor link, view-only link, regenerate/disable), `/join/:token` flow; viewers are
  read-only everywhere (enforced on the server, including the WebSocket).
- Presence: avatars in the top bar, colored dots in the file tree showing who is in which file.
- Project-wide search (rail), word count (texcount), keyboard shortcuts modal, settings modal
  (editor + compiler + theme), dark mode, chat panel with unread badge.

**Nice (only if time permits; not in v1 wave plan)**: comments/review panel, track changes, symbol
palette (editor builder may add a small one), equation preview tooltip (KaTeX), insert figure/table
modals, templates gallery, detached PDF window, git remote access.

**Out of scope**: Visual (rich-text) editor, AI, Dropbox/GitHub/Zotero/Mendeley integrations, email.

The user's real paper (`../antiddos_v2.tex`, 203 KB, `\documentclass{Definitions/mdpi}`, XeLaTeX, 14 TikZ
pictures, 63 inline `\bibitem`, mutual `xr` with `antiddos_v2_supplementary.tex`) is the acceptance
test: it must import, compile with 0 errors and 0 undefined references, sync both ways, and edit smoothly.

---------------------------------------------------------------------------------------------------

## 2. Stack (pinned, already installed — do NOT run `npm install`/add dependencies)

Node 22.19 · npm workspaces `shared/`, `server/`, `web/` · TypeScript 6.0.3 (`npm run typecheck`) ·
server runs TS directly via `tsx` · Vitest 5.0.1 · Playwright 1.61.1 (cached chromium-1228).

server: express 5.2.1, ws 8.21.3 (noServer), better-sqlite3 13.0.3, yjs 13.6.32, y-protocols 1.0.7,
lib0 0.2.117, yauzl 3.4.0, yazl 3.3.1, multer 2.4.0, diff 9.0.0, fast-diff 1.3.0, cookie 2.0.1
(ESM: `parseCookie`/`stringifySetCookie`), helmet 8.3.0, express-rate-limit 8.7.0, zod 4.6.5,
pino 10.3.1 (+pino-pretty), p-limit 7.3.3, lru-cache 11.5.3, mime 4.1.0; dev: y-websocket 3.1.0 (tests).

web: react 19.3, react-dom 19.3, react-router 7.18.4 (declarative `BrowserRouter`/`Routes`), zustand
5.0.15, react-resizable-panels 4.13.1 (**v4 API: `Group` (prop `orientation`), `Panel`, `Separator`,
`useDefaultLayout`**), lucide-react 1.47.0 (icons), clsx, CodeMirror 6 (`@codemirror/*` incl. merge,
legacy-modes, theme-one-dark), @replit/codemirror-vim/emacs, yjs 13.6.32, y-websocket 3.1.0,
y-codemirror.next 0.3.6, pdfjs-dist 6.3.289, katex 0.18.7. Vite 8.3 + @vitejs/plugin-react 6.1.1.

If you truly need a package that is not installed, do not install it: implement the small piece
yourself, or record the need in your final report.

TeX: Docker image `texlive/texlive:latest-full` (TeX Live 2026, latexmk 4.88, synctex, texcount,
biber, gs 10.07) is pulled locally. Docker is usable without sudo.

---------------------------------------------------------------------------------------------------

## 3. Repository layout

```
overleaf/                         (app root; "Folio")
  package.json  tsconfig.base.json  vitest.config.ts  playwright.config.ts  .env.example
  docs/SPEC.md  docs/research/*.md  NOTICE.md
  shared/src/
    api.ts            REST DTOs + ROUTES table            (contract — owned by lead)
    protocol.ts       realtime protocol constants/types   (contract — owned by lead)
    paths.ts          path validation                      (lead)
    filetypes.ts      text/binary classification, normalizeText  (lead)
    texlog/           LaTeX/BibTeX/Biber log parser        (shared-parsers)
    synctex/          .synctex(.gz) parser + search        (shared-parsers)
    latex/            LaTeX source helpers: outline, labels, bib keys, bibitems, \documentclass detection,
                      xr externaldocument detection      (shared-parsers)
  shared/test/        vitest suites + fixtures             (shared-parsers)
  server/src/
    main.ts           boot, http server, upgrade routing, shutdown            (server-foundation)
    config.ts         env config                                             (lead — done)
    services.ts       service interfaces + container                          (lead — done)
    log.ts            pino logger                                            (server-foundation)
    db/index.ts       SQLite schema + repositories                           (lead — done)
    http/             app.ts (express factory, middleware, static, errors), errors.ts, request.ts (lead: errors/request)
    auth/             passwords.ts, sessions.ts, middleware.ts, routes.ts    (server-foundation)
    access/           roles.ts (resolveRole)                                 (server-foundation)
    projects/         service.ts, routes.ts, importer.ts, exporter.ts, templates.ts (server-foundation)
    files/            service.ts (FileService), routes.ts, storage.ts        (server-foundation)
    share/ chat/ search/ admin/  routes.ts                                   (server-foundation)
    cli/              seed.ts, create-user.ts, reset-password.ts, doctor.ts  (server-foundation)
    collab/           CollabService + MetaService (Yjs)                      (server-collab)
    compile/          CompileService, runner, coordinator, outputs, wordcount, previews, routes.ts (server-compile)
    synctex/          SynctexService + routes.ts                             (shared-parsers)
    history/          HistoryService (git) + routes.ts                       (server-history)
  server/test/        vitest suites per module (each owner writes its own)
  web/
    index.html  vite.config.ts  public/
    src/main.tsx App.tsx
    src/styles/       tokens.css, base.css                                   (web-shell)
    src/ui/           primitives (§6.4)                                      (web-shell)
    src/api/          client.ts, endpoints.ts                                (web-core)
    src/stores/       auth.ts project.ts editor.ts compile.ts layout.ts      (web-core)
    src/realtime/     meta.ts docs.ts                                        (web-core)
    src/lib/          small utils (time formatting, debounce, colors)        (web-core)
    src/pages/        Setup/Login/Register/Dashboard/Project/Join/NotFound   (web-shell); AdminPage (web-collab-ui)
    src/features/layout/      EditorLayout, TopBar, Rail, menus, divider    (web-shell)
    src/features/dashboard/   dashboard components                           (web-shell)
    src/features/editor/      CodeMirror editor, extensions, commands, outline data, symbols (web-editor)
    src/features/outline/     OutlinePanel                                   (web-editor)
    src/features/pdf/         PdfPane, viewer, compile button, synctex, auto-compile (web-pdf)
    src/features/logs/        LogsPane                                       (web-pdf)
    src/features/wordcount/   WordCountModal                                 (web-pdf)
    src/features/filetree/    FileTreePanel, BinaryPreview, upload          (web-files-history)
    src/features/history/     HistoryView                                    (web-files-history)
    src/features/share/ chat/ search/ settings/ shortcuts/                   (web-collab-ui)
  e2e/                Playwright specs                                       (integration)
  scripts/            setup.mjs, dev-instance.mjs, e2e-server.mjs; test/ (npm run test:scripts) (integration)
  data/               runtime data (gitignored)
```

Rules for parallel work: **only create/modify files inside the directories you own.** You may read
anything. If a contract (api.ts, protocol.ts, services.ts, db/index.ts, config.ts, http/errors.ts,
http/request.ts) seems wrong, don't edit it — work around it and report the issue.

---------------------------------------------------------------------------------------------------

## 4. Server

### 4.1 Boot (`main.ts`, server-foundation)

```
const config = loadConfig(); mkdir all config.dirs; const db = openDb(config.dbFile)
const services = { config, db } as Services           // filled below; factories receive the container
services.files   = createFileService(services)        // files/service.ts
services.collab  = createCollabService(services)      // collab/index.ts   (server-collab)
services.meta    = createMetaService(services)        // collab/index.ts   (server-collab)
services.compile = createCompileService(services)     // compile/index.ts  (server-compile)
services.synctex = createSynctexService(services)     // synctex/index.ts  (server-compile)
services.history = createHistoryService(services)     // history/index.ts  (server-history)
const app = createApp(services)                        // http/app.ts
const server = http.createServer(app); server.on('upgrade', createUpgradeHandler(services))
listen(config.port, config.host); on SIGINT/SIGTERM: stop accepting, collab.flushProject(each dirty),
history.snapshot(each dirty,'shutdown'), history.shutdown() (before collab: its pending idle snapshots
flush live docs through collab), collab.shutdown(), meta.shutdown(), compile.shutdown(), db.close()
```
Factories must not call other services during construction (the container is being filled); access
`services.x` lazily inside methods. Factory names above are the contract.
Shutdown: every step has its own time limit. The same signal again within 3 s is ignored (`npm run
dev` delivers Ctrl+C twice); a later second signal, or 30 s, force the exit after `db.close()`
(which checkpoints the WAL). `npm start` execs tsx, so a signal sent to the npm process reaches
the server; the service unit in the README runs `node --import tsx server/src/main.ts` directly.

### 4.2 HTTP conventions (`http/app.ts`, server-foundation)

- Middleware order: helmet (CSP below) → `express.json({limit:'4mb'})` → session loader (cookie
  `folio_session`, opaque 256-bit token, sha256 stored in `sessions`) → CSRF guard for non-GET/HEAD
  under `/api` (require header `X-Folio-Csrf: 1` AND `Origin` equal to `config.publicOrigin` or
  `${proto}://${Host}` — with X-Forwarded-Host/-Proto (port included) from a loopback proxy, exactly
  like the WebSocket upgrade; missing Origin allowed only when `Sec-Fetch-Site` is `same-origin` or
  absent on non-browser clients with the header; rejections are logged as warn
  `request rejected: cross-origin`, at most once a minute per origin/host) → route modules → `/pdfjs/*` static (from
  `config.pdfjsDir` subfolders `cmaps`, `standard_fonts`, `wasm`, `iccs`, immutable caching) → SPA
  static + fallback `index.html` for non-`/api`, non-`/ws`, non-`/pdfjs` GETs (when `config.webDist` exists)
  → 404 JSON for `/api/*` → error handler (HttpError → its status; zod errors → 400 'validation';
  others → 500 logged).
- helmet: `contentSecurityPolicy.directives = { 'script-src': ["'self'", "'wasm-unsafe-eval'"],
  'img-src': ["'self'", 'data:', 'blob:'], 'worker-src': ["'self'", 'blob:'], 'connect-src': ["'self'"],
  'upgrade-insecure-requests': null }`, `strictTransportSecurity: false`, `crossOriginEmbedderPolicy: false`.
- Route modules export `function xxxRoutes(s: Services): express.Router` with full `/api/...` paths
  (mounted at root). Auth: `requireUser`, `requireProjectRole(min: Role)` from `auth/middleware.ts`
  (non-member → 404 'not_found'; insufficient role → 403). They populate `req.user/project/role`
  (see `http/request.ts`). Validate bodies with zod. Params via `param(req,'pid')`.
- Uploaded/raw files: `X-Content-Type-Options: nosniff`; Content-Type by extension; SVG/HTML and every
  non-image type are served with `Content-Disposition: attachment` unless it's a PDF or browser image,
  and SVG always gets `Content-Security-Policy: sandbox`.
- Rate limits (express-rate-limit): login/setup/register 20/15 min per IP; share join 30/15 min
  (warn `rate limit reached`; a failed login logs info `login failed`).
- Compression (`http/compression.ts`, no dependency): static assets are served brotli/gzip
  (compressed once, cached), JSON answers of 1 kB or more are compressed on the fly; a reverse
  proxy's gzip is optional.
- Logout answers `Clear-Site-Data: "cache"`: build files are `private, immutable` and would stay in
  the browser's HTTP cache.
- `PUBLIC_ORIGIN` is validated at start-up (scheme + host[:port] only): a malformed value stops the
  server, and `doctor` reports it. As root with the docker runner and no `COMPILE_USER`, the server
  refuses to start (`doctor`: "compile user").
- Passwords: scrypt (node:crypto) N=2^16,r=8,p=1, `maxmem: 256*1024*1024`, 16-byte salt, stored as
  `scrypt$N$r$p$saltB64$hashB64`; min length 8. Cookie: HttpOnly, SameSite=Lax, Path=/, Secure when
  publicOrigin is https, Max-Age = sessionTtlDays.

### 4.3 WebSocket upgrade (`main.ts`, server-foundation)

`server.on('upgrade')`: check Origin (same rule as CSRF; mismatch → `socket.destroy()`), parse
`folio_session` cookie → user (may be null), route:
- `/ws/doc/:projectId/:fileId?epoch=N` → `collab.handleUpgrade(req, socket, head, {user, role, projectId, fileId, epoch})`
- `/ws/project/:projectId` → `meta.handleUpgrade(req, socket, head, {user, role, projectId})`
- anything else → `socket.destroy()`.
`role = user ? db.members.roleOf(projectId, user.id) : null`. The services accept the socket, then close
(so y-websocket stops reconnecting) with 4401 without a user, 4404 for an unknown project, 4403 when the
user has no role, and — doc rooms — 4410 when the project is accessible but the file does not exist
(deleted, or an id of another project) and 4409 for a non-text file or a stale epoch; 1011 (INTERNAL:
the document could not be loaded) and 1013 (TRY_AGAIN: the account holds too many connections) make
clients reconnect later, like 1012 on a restart. The handler also
passes `sessionTokenHash` (sha256 of the session cookie): sockets remember their session (see §4.8).

### 4.4 Collaboration (`collab/`, server-collab) — CollabService + MetaService

Implement our own y-websocket–compatible server on y-protocols + lib0 + ws (see
`scratchpad/cmyjs/collab-server.ts`, verified). Requirements (all verified in research):
- One `WebSocketServer({ noServer: true, maxPayload: MAX_WS_PAYLOAD })` per service.
- Room key `${projectId}/${fileId}`; room holds `Y.Doc`, `Awareness`, connections, epoch, dirty flags.
- **Load**: if sidecar `ystate/<pid>/<fileId>.<epoch>.ybin` exists → `Y.applyUpdate`; then reconcile with
  the file on disk (`normalizeText`) via `applyTextDiff` (prefix/suffix + fast-diff minimal edits) so
  outside edits are picked up; if no sidecar → create from disk. Never build a fresh Y.Doc when a
  sidecar exists (prevents duplication on restart). Epoch in the URL must equal `db.files.epoch`,
  otherwise close 4409.
- **Save**: debounced (2 s idle, 10 s max) atomic write of `ytext.toString()` to the file's current path
  (`files.absPath(pid, db.files.get(fileId).path)` resolved at write time) via temp+rename, update
  `db.files.size` and `db.projects.touchUpdated`; write the sidecar (`Y.encodeStateAsUpdate`) atomically.
  Unload the room 30 s after the last connection leaves (after flushing). Tolerate fast
  connect/disconnect/connect (React StrictMode).
- **Messages**: sync (viewers: never apply SyncStep2 and Update; one that holds changes the server
  does not have — edits made as an editor before a role change, typically offline — closes that
  connection with 4403 so the client re-checks its role and keeps its text; a viewer's ordinary
  SyncStep2 with nothing new is ignored), awareness (rebroadcast to all incl. sender;
  remove states of closed connections), keepalive empty awareness every `KEEPALIVE_MS`, ws ping every
  30 s + terminate dead sockets, **barrier** (MSG_BARRIER: echo nonce after processing all earlier
  messages of that socket, including while the room is loading — queue messages per connection).
- Size guard: after applying an update, if `ytext.length > MAX_DOC_LENGTH` close 4413.
- Track editing user ids per project for `takeEditors`, fire `onDocChanged` (≤1/s per file), and call
  `services.history.noteActivity(pid, userId)` on edits (≤1/s per file and user, trailing edge: an
  edit inside the window is reported at its end); `editCount(pid)` counts every applied change.
- `setText`: load room if needed, `applyTextDiff` in a transaction with origin `'server'`, save.
- MetaService: room per project with server-authoritative Y.Doc (`META_FILES_KEY` map of FileEntry by id,
  `META_PROJECT_KEY` map with name/settings/updatedAt), built from db on first connection and updated by
  `syncFiles`/`syncProject` (diff-apply; don't recreate the doc). Client updates are dropped. Awareness
  carries `MetaPresence`. `broadcast` sends MSG_EVENT JSON. Collab also emits `doc:changed` events
  (debounced 1 s per file) through `meta.broadcast`.
- Tests (vitest, real `y-websocket` client in Node with `WebSocketPolyfill: ws`, `disableBc: true`):
  two clients converge; viewer edits never applied (a real one closes 4403, a plain viewer sync does
  not); restart without duplication (sidecar); outside disk edit
  reconciled; barrier ordering incl. delete-only edits; keepalive keeps one connection for 45 s (can use
  fake timers or a shortened constant); epoch mismatch → 4409; CRLF input normalised.

### 4.5 Compile (`compile/`, server-compile; `synctex/` service is owned by shared-parsers)

- **Runner** (`COMPILE_RUNNER`): `docker` (default), `local` (latexmk on PATH, unsandboxed, for
  machines with TeX), `fake` (tests: copies fixture outputs from `server/test/fixtures/fake-build/`).
- **Docker argv** (spawn, never a shell): `docker run --rm --init --name folio-c-<buildId>
  --label folio.kind=compile --label folio.project=<pid> --network none --cap-drop ALL
  --security-opt no-new-privileges --pids-limit 512 --memory <memory> --memory-swap <memory>
  --cpus <cpus> --read-only --tmpfs /tmp:rw,exec,nosuid,nodev,size=256m (exec is required: biber unpacks and runs from /tmp) --user <uid:gid>
  -e HOME=/tmp -e XDG_CACHE_HOME=/cache/xdg -e TEXMFVAR=/cache/texmf-var -e max_print_line=10000
  -e error_line=254 -e half_error_line=238 -v <compileDir>:/compile:rw -v <texcache>:/cache:rw
  -w /compile <image> latexmk -norc -cd -jobname=<job> -synctex=1 -interaction=batchmode
  -file-line-error -time [-gt if manual] (-halt-on-error | -f) [-usepretex=\PassOptionsToPackage{draft}{graphicx}\PassOptionsToPackage{draft}{graphics}]
  (-pdf | -pdfdvi | -xelatex | -lualatex) /compile/<rootPath>`. jobname = root basename (NOT `output`,
  it breaks xr). No shell-escape in v1 (restricted `\write18` stays default, which covers repstopdf).
- Wall-clock timeout (`settings.timeoutSec`) → `docker kill folio-c-<buildId>`; stop → same. Reap orphans
  on startup/shutdown (`docker ps -q --filter label=folio.kind=compile` → kill).
- **Compile dir** `compiles/<pid>/` (persistent, writable): sync the snapshot — write only changed files
  (sha1 compare stored in `compiles/<pid>/.folio-sync.json`), unlink files no longer in the project
  (except TeX aux outputs), `lstat` and unlink symlinks before writing, write via temp+rename.
  Text comes from `collab.getText` (live memory), binaries from disk.
- **Coordinator**: per project single-flight + one queued follow-up per root document (key
  `rootFileId ?? ''`; newest request for that root wins, waiting callers share its result; different
  roots queue in arrival order and are never merged, so a POST /compile answer is always a build of
  the requested root); snapshot hash (compiler, options, root, externalDocs, sorted path→sha1)
  equal to the last successful build of that root → return it with `cached: true` (for auto
  compiles; a manual compile still reruns latexmk with `-gt`); per-user 1 s guard →
  'too-recently-compiled'; global `p-limit(maxConcurrent)`; broadcast `compile:started` (with
  `rootPath`) / `compile:done` (with `rootPath`, `jobname`) via meta.
- **xr pre-build**: for the root doc detect `\externaldocument[...]{name}` (shared/latex helper) or use
  `settings.externalDocs`; pre-build each external `<name>.tex` in the same compile dir with its own
  jobname only when `<name>.aux` is missing or its content hash changed since its last pre-build; no
  recursion. Report in `externalBuilds`.
- **Outputs**: after the run copy `<job>.pdf/.log/.synctex.gz/.aux/.bbl/.blg/.out/.toc/.fls` + external
  docs' pdf/log into `builds/<pid>/<buildId>/` (copied, never hard-linked from the compile dir; only
  regular files — lstat; an output unchanged since the previous build — usually an external
  document's pdf/log — is hard-linked to that build's copy, builds being immutable) + `meta.json`
  (CompileResponse). An external document whose jobname is taken (by the main document or another
  external) is published under a path-derived name (`supp/main.tex` → `supp__main.pdf/.log`): use
  `pdfUrl`/`logUrl`, never guess names. buildId = `${Date.now().toString(16)}-${randomBytes(8).hex}`.
  **Retention**: newest 5 builds, builds < 30 min old up to 20 in all, plus pinned builds (each root
  document's last and last successful build, builds a client fetched in the last 10 min). At
  start-up the builds of each root are read back from their meta.json (≤ 60 per project).
  Serve via `GET /api/projects/:pid/builds/:buildId/:file`
  (viewer+, validate buildId `/^[0-9a-f]{8,}-[0-9a-f]{16}$/` and file name `/^[\w.\-]+$/`, Range support
  via `res.sendFile`, `Cache-Control: private, max-age=31536000, immutable`).
- **Status**: pdf exists & size>0 → 'success'; else stopOnFirstError → 'stopped-on-first-error'; killed by
  timeout → 'timedout'; killed by stop → 'terminated'; docker failure → 'error'.
- **Log**: parse `<job>.log` + `<job>.blg` with `@folio/shared/texlog` (map `/compile/...` and `./...`
  to project paths using the project file list), `stdout` = tail of latexmk output.
- **Font cache warm-up**: on first compile per image (marker `texcache/.warm-<image-hash>`), run
  `luaotfload-tool -u; fc-cache` in the sandbox before compiling.
- **wordCount**: `texcount -nocol -inc -sum=0 -brief?` … run in the sandbox against the synced compile
  dir; parse texcount's "Words in text / headers / outside text / Number of headers / floats / math
  inlines / math displayed".
- **renderPreview**: `gs -q -dSAFER -dBATCH -dNOPAUSE -dEPSCrop -sDEVICE=png16m -r150 -sOutputFile=- /in/<file>`
  in the sandbox (read-only mount of the file's dir); cache `previews/<pid>/<sha1>.png`.
- **SyncTeX** (`synctex/`): parse `<job>.synctex.gz` of the requested build with `@folio/shared/synctex`
  (LRU cache by buildId); forward: map project path → the synctex Input path; return PdfRects
  (top-left origin). Inverse: map Input path back to project path + fileId. Fallback to the `synctex`
  CLI in a sandbox container (build dir mounted read-only at `/compile` so recorded paths resolve) when
  the JS parser finds nothing.
- Routes (`compile/routes.ts` exports `compileRoutes(s)`, `synctex/routes.ts` exports `synctexRoutes(s)`):
  compile (viewer+; `fromScratch` editor+ — viewers may recompile by hand, auto-compile stays editor-only on the client),
  stop (editor+), clearCache (editor+; 409 `compile_running` while a compile of the project runs), last (viewer+;
  newest build of any root, `?rootFileId=` → of that root document (204 when none, unknown or not a text
  file), `?main=1` → of the main document; adds `lastWithPdf`, always of the same root, when that build
  has no PDF), buildFile (viewer+),
  wordcount (viewer+), previewFile (viewer+). synctex code/pdf (viewer+) live in `synctex/routes.ts` (shared-parsers).
  The SyncTeX CLI fallback needs a sandbox runner: compile exports `runSandboxed(opts)` from `compile/sandbox.ts`
  (`{ image, mounts: {host, container, ro}[], argv: string[], timeoutMs, workdir? } → Promise<{code, stdout, stderr}>`) for synctex/ to reuse.
- Tests: coordinator with fake runner (single-flight, queued follow-up, dedupe, guard, timeout kill);
  docker-tagged tests (run only when `FOLIO_DOCKER_TESTS=1`): hello world, error document, xr pair,
  bibtex document, draft; and the real paper (copy from `../` into a temp project).

### 4.6 History (`history/`, server-history)

- git CLI via `execFile` (never shell), separate git dir `history/<pid>.git` created with
  `git init --bare` + `core.bare=false`, always invoked as `git --git-dir=<gd> --work-tree=<projectDir>`
  with `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.autocrlf=false -c gc.auto=0
  -c user.name=Folio -c user.email=folio@localhost` and `GIT_CONFIG_NOSYSTEM=1`, `HOME=<tmp>`,
  `GIT_TERMINAL_PROMPT=0`. `info/exclude` ignores nothing (project dir contains only user files).
- Snapshot policy: `noteActivity` → commit after 30 s idle, at most every 5 min while editing; also
  before restore, label and version download, and — `snapshotBeforeDelete(pid, paths, {replace?})`,
  called by FileService before it deletes or overwrites entries — a 'file-op' commit ("Before
  deleting <path>") when those paths differ from HEAD (free while nothing was noted since the
  last snapshot and `collab.editCount(pid)` is unchanged since then; returns at once inside a
  restore, which snapshots first); never per compile. Snapshot = `collab.flushProject(pid)`
  then `git add -A` + commit if the index differs. Author = first editor, others as
  `Co-authored-by:` trailers (from `collab.takeEditors` + explicit user), trailer `Folio-Reason: <reason>`
  and `Folio-User-Ids: id1,id2`. Housekeeping: a real `git gc` every 200 commits of a project, or
  daily when it has 100 or more loose objects (not `gc --auto`, which estimates from one objects/
  subdirectory and often declines); the counters live in `<gitdir>/folio-gc.json`.
- list: `git log --format=... --name-status -M` paginated (`before` sha exclusive), map authors to
  UserPublic via ids trailer (fallback name/email), attach labels from db.
- diff: `git show <sha>:<path>` for both sides (binary detection via NUL / classifyByName), return texts.
- restore: snapshot('restore' pre) → for each file at version: text files that exist → `collab.setText`;
  missing files → `files.writeFile`; files that exist now but not at version (project restore only) →
  `files.remove`; then snapshot('restore') and broadcast `history:changed`. Never write files behind
  a live Y.Doc.
- labels: db.labels + (optional) git tag; archive: `git archive --format=zip <sha>` streamed, named
  `<project> - <newest label>.zip`, else `<project> - YYYY-MM-DD HH.MM.zip` (commit time; the web app
  saves it under the same name, in local time). A restore answers `skipped` (files of the version
  that could not be written).
- Routes `history/routes.ts` exports `historyRoutes(s)`: versions/files/file/diff/download (viewer+),
  restore/snapshot/labels create+delete (editor+).
- Tests on temp dirs with a fake collab (flushProject no-op, setText writes file).

### 4.7 Projects, files, sharing, chat, search, admin, CLI (server-foundation)

- Importer (`projects/importer.ts`) shared by zip upload, directory seed and templates: walk entries,
  `normalizePath` + `validatePath` (skip invalid, report), skip ignore list (`__MACOSX`, `.git`, `.DS_Store`,
  `*.aux,log,out,toc,synctex.gz,synctex(busy),fdb_latexmk,fls,bbl,blg,xdv,dvi` etc., `<root>.pdf` next to a
  root .tex), strip a single common top-level folder of a zip, classify (`classifyFile`), text →
  `normalizeText` UTF-8, write files, insert db rows, set root doc (explicit, else `main.tex` with
  `\documentclass`, else first .tex with `\documentclass`), then `history.init`. Zip safety (yauzl):
  reject absolute/`..` names, symlink entries, > 2000 entries, > 300 MB uncompressed total, per-entry
  ratio > 200:1 bombs; stream with byte counting.
- Exporter: `collab.flushProject` then yazl stream of every non-folder entry using live bytes.
- Templates: blank (`main.tex` minimal article) and example (`main.tex` with sections, math, a TikZ
  figure, a table, `\cite` to `references.bib`, `\ref`s; compiles with pdfLaTeX).
- FileService (see services.ts): all disk writes go under `projectDir` with realpath checks; renames of
  folders move descendants (db + disk) in one transaction; after any tree change: `meta.syncFiles(pid)`,
  `meta.broadcast({type:'files:changed',...})`, `history.noteActivity`, `db.projects.touchUpdated`.
  Deleting the root doc clears `rootFileId`. Text writes to existing text files → `collab.setText`.
  kind changes → `db.files.bumpEpoch` + `collab.discardFile(..., STALE_EPOCH)`; deletes →
  `history.snapshotBeforeDelete` (before the project lock; a failure refuses the delete) then
  `collab.discardFile(..., GONE)`; replacing uploads snapshot the same way. 'files:changed' carries
  `by` (the acting user) for collaborators' notices.
- Project delete (owner): `collab.discardProject`, `meta.closeProject(GONE)`, `compile.deleteProject`,
  `history.deleteProject`, remove dir, db delete. Non-owner "delete" = leave (remove membership).
- Sharing: owner manages members & links; tokens = 18 random bytes base64url; join adds membership
  with the link's role (never downgrades); role change/removal → `collab.disconnectUser` +
  `meta.disconnectUser` (code 4403) + broadcast `access:changed` and `members:changed`.
- Chat: store, then `meta.broadcast({type:'chat:message'})`. Max 5000 chars.
- Search: over text files via `collab.getText`; options regex/caseSensitive/wholeWord; cap 2000 matches;
  preview = the line trimmed to 200 chars.
- Admin: list/create/delete users (admin only; cannot delete self).
- CLI (`tsx server/src/cli/*.ts`, using the same services without HTTP where possible):
  `create-user --email --name --password [--admin]`; `reset-password --email --password`;
  `seed --src <dir> --owner <email> [--name] [--main <path>] [--compiler xelatex] [--external a.tex,b.tex]
  [--exclude overleaf,ready,*.zip]` (skip symlinks; always skip the app's own directory); `doctor`
  (docker info, image present, git version, data dir writable, cache warm, database `quick_check` —
  the integrity check belongs here, never in the server's start-up).

### 4.8 Sessions, housekeeping and limits (integration, wave 2)

- **Sliding sessions**: a session used more than 1 h after its last extension is extended to
  `sessionTtlDays` from now (`db.sessions.extend`) and the REST response re-sends the cookie.
  Cookies are `Secure` when PUBLIC_ORIGIN is https or the request came over TLS.
- **Sockets follow their session** (`auth/live.ts`): Collab/MetaService take `ctx.sessionTokenHash`
  and expose `disconnectSessions(hashes, code)` / `openSessions()`. Logout closes that session's
  sockets with 4401; a password change closes every *other* session's; deleting a user closes all of
  theirs first; a one-minute sweep closes sockets of expired/deleted sessions (CLI reset-password).
  Belt and braces for a socket a close never reached: a doc room re-checks the session of a
  connection that sends an update (at most once every 5 s per connection) and closes it with 4401
  when the session is gone.
- **Housekeeping** (`maintenance.ts`, hourly, first run 2 min after boot): expired sessions purged;
  `CompileService.sweep()` keeps the builds of §4.5 "Retention" and, for projects idle > 3 days, only
  the newest plus the pinned ones; deletes compile dirs idle > 3 days, leftovers of deleted projects
  and EPS previews older than 30 days; temp files older than 6 h.
- **File moves**: after `collab.flushProject`, all asynchronous preparation happens first, then the
  disk rename and the db path update run in one synchronous block (a collab save resolves its target
  from the db synchronously, so it can never re-create the file at the old path).
- **Zip names** are decoded by the importer itself (yauzl `decodeStrings: false`): `a:b.tex` is legal;
  absolute, `..` and NUL names are refused. The exporter writes such names too. The zip upload returns
  `CreateProjectResponse.skipped` (`{path, reason}` of ignored/invalid entries).
- **Limits**: multipart uploads must declare Content-Length (411) and are capped per request
  (files route: max(MAX_UPLOAD_MB, 300 MB), zip route: MAX_UPLOAD_MB) before anything is stored;
  texcount and Ghostscript containers share 2 slots with ≤ 16 waiting (503 beyond), identical word
  counts are coalesced; ≤ 8 SyncTeX CLI fallbacks wait; ≤ 2 regex-search workers run (≤ 8 waiting).
  `@folio/shared/latex` helpers are linear on hostile input (brace index, bounded optional arguments,
  capped matches). The local runner passes only TeX-related environment variables.
- **Origin rule**: with PUBLIC_ORIGIN set, an origin derived from the Host header is only trusted for
  IP literals and localhost (DNS rebinding); without it the Host rule of §4.2 applies.
- **Docker failures** (daemon down, socket permission, image missing — recent docker CLIs exit 1, not
  125) are recognised from docker's output: the compile ends with status `error` and an actionable
  `[Folio] …` line; `/api/system` reports `dockerOk: false`; the start-up log warns early.
- **Operations**: `.env` (or FOLIO_ENV_FILE; `FOLIO_ENV_FILE=none` reads no file) is loaded by
  main.ts and the CLI tools (process env wins), and read with the same rules by web/vite.config.ts
  (PORT/HOST → proxy target unless FOLIO_API is set; VITE_PORT → dev-server port, also used by the
  server's dev banner) and scripts/setup.mjs (PORT, COMPILE_IMAGE, COMPILE_RUNNER). Throw-away
  servers (scripts/dev-instance.mjs, scripts/e2e-server.mjs, e2e `startServer()`) set
  `FOLIO_ENV_FILE=none`, so a developer's `.env` never reaches them. The server prints a start-up
  banner with the URL to open; `npm run doctor [-- --compile]` explains every problem with its fix;
  `node scripts/setup.mjs [--pull]` checks, builds and prints next steps; `npm run backup`
  (scripts/backup.mjs, no external tools) writes a consistent backup while the server runs —
  SQLite's online backup for the database (checkpointed and `quick_check`ed) plus `projects/`,
  `history/` and `ystate/` streamed into a dated `.tgz`, or into a directory with `--out`. tsx is a runtime
  dependency (`npm start`, the CLI tools); vite is a dev dependency (`npm run build`).
- `LogEntry` has optional `logLine` (line in the raw .log/.blg) and `page` (page being typeset).

---------------------------------------------------------------------------------------------------

## 5. Shared parsers (shared-parsers)

- `@folio/shared/texlog`: `parseLatexLog(text: string, opts: { projectFiles: string[]; compileDir?: string /* '/compile' */ }): ParsedLog`,
  `parseBibtexLog(text, opts)`, `parseBiberLog(text, opts)`, `mergeLogs(...logs: ParsedLog[]): ParsedLog`,
  `unwrapLog(text, engine?)`. Types `ParsedLog`/`LogEntry` from api.ts. Hints: our own text, keyed by
  regex (undefined control sequence, missing $, undefined reference/citation, file not found, overfull
  hbox, rerun, font shape, missing character). Fixtures: `../antiddos_v2.log`,
  `../antiddos_v2_supplementary.log` (copy into `shared/test/fixtures/`), expectations from
  `docs/research/logparse.md` "TEST FIXTURE" sections, plus synthetic logs generated with the docker
  image (error doc, bibtex doc, biber doc).
- `@folio/shared/synctex`: `parseSynctex(data: Uint8Array | string): SynctexIndex` (accept gz bytes →
  use `node:zlib` only via an injected `gunzip` option, since this module must also be importable by
  the web; simplest: export `parseSynctexText(text)` and let the server gunzip), `forwardSearch(idx,
  inputPath, line, column?): PdfRect[]`, `inverseSearch(idx, page, x, y): { input: string; line: number; column: number }[]`,
  `listInputs(idx): string[]`. Coordinates: PdfRect as in api.ts. Golden tests against the `synctex`
  CLI on the real paper (generate goldens once with docker and commit them as JSON fixtures).
- `@folio/shared/latex`: `extractOutline(text): OutlineItem[]` (`{level, title, line, command}` for
  part/chapter/section/subsection/subsubsection/paragraph incl. starred, ignoring comments),
  `extractLabels(text): {label, line}[]`, `extractBibitems(text): {key, line}[]`,
  `extractBibKeys(bibText): {key, type, title?, author?, year?}[]`, `hasDocumentclass(text): boolean`,
  `extractExternalDocuments(text): {name, prefix?}[]`, `extractIncludes(text)`.

---------------------------------------------------------------------------------------------------

## 6. Web

### 6.1 Routes (`App.tsx`, web-shell)
`/setup` (only when setupStatus.needsSetup — otherwise redirect), `/login`, `/register` (when
allowSignup), `/` Dashboard (auth), `/project/:projectId` ProjectPage (auth), `/join/:token` JoinPage
(auth; redirect to login with `?next=`), `/admin` AdminPage (admin), `*` NotFound. On boot load
`setupStatus` + `me`; unauthenticated → `/login?next=...`; needsSetup → `/setup`.
`/project/:id` and `/admin` load on demand (`pages/lazy.tsx`; a failed download shows a Reload page)
and the dashboard fetches the editor code when idle. The app shell (App, login pages, dashboard,
UserMenu) must not import stores/project, realtime/docs|meta|recovered or features/editor|pdf|history
(pure helpers such as features/pdf/downloadName.ts excepted):
it uses realtime/syncState, realtime/recoveredStore and stores/compileStatus (initial JS ≈ 380 KiB,
no Yjs or CodeMirror).

### 6.2 API client (`api/`, web-core)
`api/client.ts`: `request<T>(method, path, body?, opts?)` — same-origin fetch, JSON, adds
`X-Folio-Csrf: 1` for non-GET, throws `ApiError {status, code, message, details}`; `upload<T>(path,
formData, onProgress?)` (XHR for progress). `api/endpoints.ts`: `export const api = {...}` with **one
method per ROUTES key, same name** (e.g. `api.listProjects()`, `api.compile(pid, req)`,
`api.historyDiff(pid, {to, from?, path})`). Signature rule: path params positional in path order, then
the JSON body (or a query object for GETs with query params), then options. Byte/stream routes
(`downloadProject`, `rawFile`, `previewFile`, `buildFile`, `historyFile`, `historyDownload`) are exposed
as URL builders named `<key>Url(...)` returning a string (e.g. `api.rawFileUrl(pid, fileId, {download?})`,
`api.buildFileUrl(pid, buildId, file)`, `api.historyFileUrl(pid, versionId, path)`). Uploads:
`api.uploadProject(file: File, name?: string, onProgress?)`, `api.uploadFiles(pid, items: {file: File;
relativePath?: string}[], folder: string, replace: boolean, onProgress?)`. `lastCompile(pid, {rootFileId?,
main?} = {}, opts?)` returns `CompileResponse | null` (204 → null). `ApiError` is exported from `api/client.ts`.

### 6.3 Stores (zustand, web-core) — exact shapes other modules rely on

```ts
// stores/auth.ts
useAuth: { status: 'loading'|'authenticated'|'anonymous'; me: Me|null; setup: SetupStatus|null;
  logoutPending: boolean;   // signed out here, the server not told yet (retried until it answers)
  init(): Promise<void>; login(email, password): Promise<void>;
  logout(): Promise<void>;  // never rejects: onSignOut listeners, then anonymous at once; the server
                            // logout is kept in localStorage 'folio:logout-pending' and retried
                            // (online, backoff, first thing in init(); other tabs follow)
  register(req: RegisterRequest): Promise<void>; setupAdmin(req: RegisterRequest): Promise<void>;
  updateMe(req: UpdateMeRequest): Promise<void>; updateSettings(patch: Partial<UserSettings>): Promise<void> /* optimistic */ }
// derived hook: useSettings(): UserSettings; useResolvedTheme(): 'light'|'dark'
// onSignOut(fn({userId, reason: 'logout'|'ended'})): runs before the store turns anonymous — drop
// everything of that account (doc sessions, dashboard, toasts, dialogs, caches); isSigningOut()

// stores/project.ts — the open project (populated by REST load, then kept live by realtime/meta.ts)
useProject: { projectId: string|null; loadState: 'idle'|'loading'|'ready'|'error'; error: string|null;
  name: string; role: Role|null; owner: UserPublic|null; settings: ProjectSettings|null;
  files: Record<string, FileEntry>; members: Member[];
  presence: { clientId: number; user: PresenceUser; openFileId: string|null }[];   // other clients only
  connection: 'connecting'|'connected'|'disconnected';
  load(projectId): Promise<void>; unload(): void; reloadMembers(): Promise<void>;
  rename(name): Promise<void>; updateSettings(patch: Partial<ProjectSettings>): Promise<void>;
  canEdit(): boolean; fileByPath(path): FileEntry|undefined; rootFile(): FileEntry|undefined;
  textFiles(): FileEntry[] }

// stores/editor.ts
useEditor: { openFileId: string|null; openFile(fileId: string): void;
  jumpRequest: { fileId: string; line: number; column?: number; nonce: number }|null;
  jumpTo(t: { fileId?: string; path?: string; line: number; column?: number }): void;  // opens file, then editor scrolls/selects
  cursor: { fileId: string; line: number; column: number }|null; setCursor(c): void;
  view: import('@codemirror/view').EditorView|null; setView(v): void }

// stores/compile.ts
useCompile: { status: 'idle'|'compiling'; last: CompileResponse|null; error: string|null;
  options: { autoCompile: boolean; draft: boolean; stopOnFirstError: boolean };   // persisted per project in localStorage 'folio:compile:<pid>'
  setOption<K extends keyof options>(k, v): void;
  compile(o?: { auto?: boolean; fromScratch?: boolean; rootFileId?: string }): Promise<CompileResponse|null>; // barrierAll() → POST; ignores 'too-recently-compiled' for auto
  stop(): Promise<void>; clearCache(): Promise<void>; loadLast(): Promise<void>;
  lastWithPdf: CompileResponse|null;
  root: string|null; follow(rootPath): Promise<void>;   // the ONE root document this client shows:
     // the one it compiled last, or the root document open in the editor; builds and events of
     // other roots (rootPath) never replace its PDF nor end its "out of date".
  changedSinceCompile: boolean; markChanged(): void;
  logsOpen: boolean; setLogsOpen(open: boolean): void; reset(): void }
// Also listens to projectEvents 'compile:done' from others → fetch lastCompile(?rootFileId=root) so
// collaborators' PDFs of the same root document refresh. PDF downloads: the main document as
// "<project>.pdf", other roots as "<project> - <jobname>.pdf" (features/pdf/downloadName.ts).

// stores/layout.ts
useLayout: { view: 'split'|'editor'|'pdf'; setView(v): void;
  railPanel: 'files'|'search'|'chat'|null; setRailPanel(p): void; toggleRailPanel(p): void;   // clicking active icon collapses
  historyOpen: boolean; setHistoryOpen(o): void;
  modal: { type: 'share'|'settings'|'wordcount'|'shortcuts'|'upload'|'newfile'|'newfolder'|'symbols'; props?: Record<string, unknown> }|null;
  openModal(type, props?): void; closeModal(): void;
  unreadChat: number; setUnreadChat(n): void }
```

### 6.4 Realtime (`realtime/`, web-core)

```ts
// realtime/meta.ts
connectMeta(projectId: string): () => void   // creates Y.Doc + WebsocketProvider(metaServerUrl(wsBase), projectId, doc, {disableBc:true});
   // mirrors META maps into useProject (files, name, settings), presence from awareness (excluding self),
   // sets own awareness {user: PresenceUser, openFileId} (follows useEditor.openFileId), connection state,
   // emits ProjectEvents; returns disconnect fn.
projectEvents: { on<T extends ProjectEvent['type']>(type: T, fn: (e: Extract<ProjectEvent,{type:T}>) => void): () => void }
wsBase(): string   // ws(s)://host

// realtime/docs.ts
interface DocSession { fileId: string; epoch: number; userId: string; ydoc: Y.Doc; ytext: Y.Text; provider: WebsocketProvider;
  awareness: Awareness; undoManager: Y.UndoManager; readOnly: boolean;
  synced: Promise<void>; isSynced(): boolean; destroy(): void }
docSessions: {
  acquire(projectId: string, file: FileEntry): DocSession;   // cached per fileId:epoch, ref-counted; LRU keeps ≤ 8 idle sessions
  release(session: DocSession): void;
  get(fileId: string): DocSession|undefined;
  barrierAll(timeoutMs?: number): Promise<void>;  // MSG_BARRIER round-trip on every connected session (resolve immediately for none/offline)
  onChange(fn: (fileId: string, local: boolean) => void): () => void;  // any Y.Text change after sync
  onStale(fn: (fileId: string) => void): () => void;  // closed with STALE_EPOCH/GONE
  closeAll(): void }
```
A session closed for good while holding unconfirmed local edits (file deleted / re-created /
replaced, reset, access lost or role changed to viewer — the server closes a read-only socket
that sends changes with 4403) hands its whole text to `realtime/recovered.ts`; the layout shows
it in a persistent notice (copy, save as a new file — viewers: download as a file —, compare
with the file now at that path) until dismissed (kept in memory + sessionStorage; closing the
tab asks first). Kept texts belong to the user who typed them (`realtime/recoveredStore.ts`): another
account never sees them; logging out discards them, any other end of the session keeps them hidden
until that user is back. Signing out destroys every document session and closes every meta room at
once (never drained: nothing more is sent under that account). While the browser reports no network
(`realtime/net.ts`: the 'offline' event / `navigator.onLine === false`) every provider is
disconnected and none is created connected — a frame written into a socket that cannot deliver waits
in the browser's send buffer and would still reach the server when the network returns, after the
logout that was meant to stop it; edits made meanwhile stay local until the 'online' event
reconnects. `useDocSync` lives in `realtime/syncState.ts` (re-exported by docs.ts).
The meta room's reconnect catch-up re-fetches the project (role, members).
Awareness user for doc rooms: `{ name, color, colorLight: color + '33', id }` from `useAuth.me`.
Viewers: construct the session anyway (read-only editor). Test hook: `window.__folio = { useAuth,
useProject, useEditor, useCompile, useLayout, docSessions, projectEvents }` (always set).

### 6.5 UI primitives (`ui/`, web-shell) — imported by all features

`Button({variant: 'primary'|'secondary'|'ghost'|'danger', size?: 'sm'|'md', icon?, loading?, ...})`,
`IconButton({icon, label, active?, size?, tooltipSide?, ...})` (label → aria-label + Tooltip),
`Modal({open, onClose, title, size?: 'sm'|'md'|'lg'|'xl', footer?, children})`,
`DropdownMenu({trigger: ReactElement, items: MenuItem[], align?: 'start'|'end'})` with
`MenuItem = {type?: 'item'|'separator'|'header'|'checkbox'|'radio', label?, icon?, shortcut?, checked?, disabled?, danger?, onSelect?, items?: MenuItem[] /* submenu */}`,
`showContextMenu(event, items)` + `<ContextMenuHost/>`, `Tooltip({content, side?, children})`,
`Tabs({tabs: {id, label, badge?, badgeTone?}[], active, onChange})`, `toast(msg, {tone?: 'info'|'success'|'error'|'warning', duration?})` + `<Toaster/>`,
`confirmDialog({title, message, confirmLabel?, danger?}): Promise<boolean>`, `promptDialog({title, label, initial?, validate?, confirmLabel?}): Promise<string|null>` + `<DialogHost/>`,
`Spinner({size?})`, `TextField`, `Select`, `Checkbox`, `Switch`, `Field({label, hint?, children})`,
`Avatar({user: {name, color}, size?})`, `AvatarStack({users, max?})`, `EmptyState({icon?, title, children?})`, `Kbd`,
`ResizeSplit` is not needed (use react-resizable-panels). All exported from `ui/index.ts`.

### 6.6 Visual design (web-shell sets the system; all features follow it)

Clean, dense, professional editor UI in the spirit of Overleaf's redesigned editor (our own brand:
**Folio**, accent a deep leaf green). `styles/tokens.css` defines CSS variables on `:root` for light and
`[data-theme="dark"]` for dark: `--bg`, `--bg-subtle`, `--bg-elevated`, `--bg-sunken`, `--bg-hover`,
`--bg-active`, `--fg`, `--fg-muted`, `--fg-subtle`, `--border`, `--border-strong`, `--accent`,
`--accent-hover`, `--accent-fg`, `--accent-subtle`, `--danger`, `--warning`, `--success`, `--info`,
(+ `-subtle` variants), `--radius-sm/md/lg`, `--shadow-sm/md/lg`, `--font-ui` (system UI stack),
`--font-mono`, `--topbar-h: 44px`, `--rail-w: 44px`, `--z-*`. Components use only tokens. Each feature
has its own CSS file with a unique class prefix (`ft-` file tree, `pdf-`, `logs-`, `hist-`, `ed-`,
`share-`, `chat-`, `srch-`, `set-`, `dash-`, `lay-`, `ui-`). Icons: lucide-react, 16 px. Font sizes 12–14 px
in the chrome. Keyboard accessible (focus rings), `aria-label`s on icon buttons.

### 6.7 Feature components (contract: file path + export + props)

| Path | Export | Owner |
|---|---|---|
| features/layout/EditorLayout.tsx | `EditorLayout()` — the whole editor page | web-shell |
| features/filetree/FileTreePanel.tsx | `FileTreePanel()` | web-files-history |
| features/filetree/BinaryPreview.tsx | `BinaryPreview({ file }: { file: FileEntry })` | web-files-history |
| features/filetree/UploadModal.tsx | `UploadModal({ onClose, folder? })` | web-files-history |
| features/outline/OutlinePanel.tsx | `OutlinePanel()` | web-editor |
| features/editor/EditorPane.tsx | `EditorPane()` — breadcrumb + SourceEditor or BinaryPreview for `useEditor.openFileId` | web-editor |
| features/editor/commands.ts | `runEditorCommand(name: EditorCommand): boolean`, `type EditorCommand` | web-editor |
| features/editor/SymbolPalette.tsx | `SymbolPalette({ onClose })` | web-editor |
| features/pdf/PdfPane.tsx | `PdfPane()` — toolbar (compile button, logs toggle w/ counts, download, zoom, page), viewer, logs overlay | web-pdf |
| features/pdf/synctex.ts | `syncCodeToPdf(): Promise<void>`, `syncPdfToCode(): Promise<void>` (divider arrows) | web-pdf |
| features/pdf/autoCompile.ts | `useAutoCompile()` hook (mounted once by EditorLayout) | web-pdf |
| features/logs/LogsPane.tsx | `LogsPane()` | web-pdf |
| features/wordcount/WordCountModal.tsx | `WordCountModal({ onClose })` | web-pdf |
| features/history/HistoryView.tsx | `HistoryView()` — replaces the editor+PDF area while `useLayout.historyOpen` | web-files-history |
| features/share/ShareModal.tsx | `ShareModal({ onClose })` | web-collab-ui |
| features/chat/ChatPanel.tsx | `ChatPanel()` (+ `useChatUnread()` hook updating `useLayout.unreadChat`) | web-collab-ui |
| features/search/SearchPanel.tsx | `SearchPanel()` | web-collab-ui |
| features/settings/SettingsModal.tsx | `SettingsModal({ onClose })` — tabs Editor / Compiler / Appearance / Account | web-collab-ui |
| features/shortcuts/ShortcutsModal.tsx | `ShortcutsModal({ onClose })` | web-collab-ui |
| pages/AdminPage.tsx | `AdminPage()` | web-collab-ui |

`EditorCommand` = `'undo'|'redo'|'find'|'replace'|'gotoLine'|'selectAll'|'toggleComment'|'bold'|'italic'|'inlineMath'|'displayMath'|'bulletList'|'numberedList'|'section'|'subsection'|'subsubsection'|'paragraph'|'insertFigure'|'insertTable'|'insertCitation'|'insertRef'|'insertLink'|'indentMore'|'indentLess'|'foldAll'|'unfoldAll'`.

Wave-1 web-shell creates placeholder versions of every wave-2 component above (same export + props,
rendering a simple "coming soon" box) so the app builds; wave-2 owners replace them completely.

Editor page composition (web-shell): `TopBar` / body = `Rail` + `Group(horizontal)[ Panel(rail panel:
Files → FileTreePanel over OutlinePanel (vertical Group), Search → SearchPanel, Chat → ChatPanel) |
Panel(EditorPane) | Separator with SyncTeX arrow buttons | Panel(PdfPane) ]`, layouts via `useLayout.view`,
`HistoryView` over the editor+pdf area when open, modals from `useLayout.modal`, `<Toaster/>`,
`<DialogHost/>`, `<ContextMenuHost/>`. Global shortcuts (outside CodeMirror): Mod-Enter/Mod-s compile,
Mod-Shift-f? no. Menus call `runEditorCommand`, `useCompile`, `useLayout.openModal`, api downloads.
Connection banner when meta connection is lost ("Reconnecting…"). Read-only badge for viewers.

### 6.8 Behaviour details owners must implement

- **Editor (web-editor)**: plain CodeMirror (no basicSetup, no `history()` — undo is `Y.UndoManager` via
  `yUndoManagerKeymap`); `yCollab(ytext, awareness, { undoManager })`; `EditorState.readOnly` for
  viewers; compartments for theme/font/keymap/wrap/spellcheck/autocomplete/closeBrackets; LaTeX mode
  `StreamLanguage.define(stex)`; BibTeX files: simple stream mode; completions: one `autocompletion({
  override: [...] })` combining sources; completion data for commands/environments in
  `features/editor/data/*.ts` (write your own lists: ~400 common commands, ~80 environments; you may
  adapt LaTeX-Workshop MIT data with attribution); project index (labels, bib keys, bibitems, files)
  rebuilt from `useProject.files` + live texts (docSessions or `api.rawFile`) debounced;
  diagnostics from `useCompile.last.log` filtered by current path → `setDiagnostics`; keymap Mod-Enter /
  Mod-s → `useCompile.getState().compile()`; `jumpRequest` handling (scroll into view + select line,
  flash highlight); cursor → `useEditor.setCursor`; set `useEditor.setView(view)`; handle `onStale` by
  re-acquiring with the new epoch; show a spinner until `session.synced`; large files must stay fast.
  Each file's cursor and first visible line are kept in localStorage `folio:editorpos:<pid>` (≤ 60
  files per project, deleted files pruned; written about once a second, on unmount and on
  pagehide; restored after sync unless a jump is pending, scrolled with no margin so it never
  creeps). Collaborators' name labels show for 2 s after their caret moves and on hover. The
  breadcrumb folds outer sections into a "…" menu when narrow.
  Outline panel uses `@folio/shared/latex` `extractOutline` on the open text file (live).
- **PDF (web-pdf)**: `pdfjs-dist` PDFViewer with EventBus + PDFLinkService, worker via
  `import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'`, `cMapUrl: '/pdfjs/cmaps/'`,
  `standardFontDataUrl: '/pdfjs/standard_fonts/'`, `wasmUrl: '/pdfjs/wasm/'`, `iccUrl: '/pdfjs/iccs/'`
  (check exact option names in pdfjs-dist 6.3.289 types); import `pdfjs-dist/web/pdf_viewer.css`; set
  `globalThis.pdfjsLib` before importing `pdf_viewer.mjs`; keep scroll position across reloads (save
  `currentScaleValue` + top-of-viewport destination, restore after `pagesinit`); double-click →
  `synctex/pdf` → `useEditor.jumpTo`; code→pdf → highlight rects (fade out after 2 s) + scroll; auto-compile
  (2500 ms debounce, 5000 ms max wait, triggered by `docSessions.onChange` and `doc:changed` events,
  only when option on and user can edit); compile button states; logs pane with counts badge;
  "PDF out of date" subtle indicator when `changedSinceCompile`; first load → `loadLast()`; errors
  (compile failed/timeout/docker error) shown in the PDF pane with the stdout tail. A toolbar chip
  names the document shown when it is not the main one; a collaborator's build shows an in-pane
  "PDF updated by X" pill (once per burst, never while you typed in the last 4 s). The PDF position
  is kept per document: `folio:pdfpos:<pid>` (main) and `folio:pdfpos:<pid>:<rootPath>`.
- **Files & history (web-files-history)**: tree built from `useProject.files` (folders first, natural
  sort), expand state persisted in localStorage, selection, keyboard (arrows, Enter, F2, Delete),
  inline rename, context menu (New file, New folder, Upload, Rename, Delete, Download, Set as main
  document), drag-to-move (HTML5 DnD, validate not into itself), OS file drop (upload to the folder under
  the cursor), presence dots, root doc marker, "binary" icon types. HistoryView: left = diff viewer,
  right = version list (infinite scroll, labels, "Compare" range selection, per-version file list, restore
  buttons with confirm, add label), diff via `@codemirror/merge` `unifiedMergeView` read-only; the
  diff is computed line by line first, then by character inside changed lines (2 s limit). The diff
  bar names who changed the file; a version's .zip is saved as "<project> - <label or date>.zip".
- **Collab UI (web-collab-ui)**: Share modal (members list w/ role select + remove, add by email, link
  sharing section with copy buttons, owner-only controls, viewers see read-only list), Chat panel
  (messages grouped by user/time, markdown-lite: links, `code`; send on Enter; unread badge via
  `projectEvents`), Search panel (query, regex/case/word toggles, results grouped by file, click → jumpTo;
  also "Replace all" is out of scope), Settings modal (Editor: theme, font size, font family, line height,
  keybindings, autocomplete, auto-close brackets, spell check, line wrapping, equation preview;
  Compiler: compiler, main document, external documents, timeout (owner/editor); Appearance: UI theme;
  Account: name, change password), Shortcuts modal, Admin page (users table, create user, delete).

---------------------------------------------------------------------------------------------------

## 7. Testing & acceptance

- `npm run typecheck` clean; `npm test` (vitest) green; `npm run check:dedupe` single versions.
- Every owner writes unit/integration tests for their module (see sections above) and runs them.
- Integration (after wave 2): production build served by the server, Playwright e2e covering: setup →
  create project → edit → compile → PDF visible; two users typing in the same file (presence, no
  duplication); server restart mid-session (no duplication); upload zip; logs pane counts; SyncTeX both
  ways; history restore; share link join as viewer (read-only enforced); the seeded real paper compiles
  (xelatex, 0 errors, 0 undefined refs).
- Test hooks: `window.__folio` (web-core). Read editor text with `view.state.doc.toString()`.
- E2E harness (`npm run e2e`): `scripts/e2e-server.mjs` builds web/dist when stale (atomically), starts a
  server on a fresh temp DATA_DIR (COMPILE_RUNNER from env, default docker) with alice/bob/carol, the real
  paper and an Example project, and prints `FOLIO_E2E_READY <state.json>` (Playwright `webServer.wait`
  → `FOLIO_E2E_STATE`). `e2e/global-setup.ts` saves storage states to `e2e/.auth/<user>.json`;
  `e2e/helpers.ts` has login/openProject/editor/docSessions/compile/PDF helpers and `startServer()` for
  extra isolated (empty or restartable) servers; `startServer({env})` adds variables to the launcher's
  environment (env-isolation.spec hands it an env file and PUBLIC_ORIGIN, which the server must
  ignore). Server-level suites live in `server/test/integration/`
  (whole server in-process: route access matrix, CSRF, IDOR, move race).
- Script checks (`npm run test:scripts`, scripts/vitest.config.mjs, not part of `npm test`): real
  servers on temp data dirs run `npm run backup` and the README backup and restore commands as
  printed (`npm run backup` against a running server, restored with the README's steps; offline
  backup after a SIGKILL keeps the WAL; online backup restores the backed-up state over a crashed
  data dir),
  a SIGTERM to the `npm start` process shuts the server down gracefully, web/vite.config.ts and
  scripts/setup.mjs follow PORT/VITE_PORT from the env and the env file, and scripts/e2e-server.mjs
  and scripts/dev-instance.mjs ignore a developer's env file and PUBLIC_ORIGIN.
