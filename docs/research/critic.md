# AREA: critic

I found 16 contradictions between the six reports and resolved each one against npm, the docs or a local experiment. The ones that change the build:
- **TypeScript:** pin 6.0.3, not 7.0.2. typescript-eslint 8.70.0 needs TypeScript below 6.1, and the pdf.js prototype type-checks cleanly under 6.0.3.
- **TeX image:** `texlive/texlive:latest` and `:latest-full` are different images on this box. `latest` is the 16 Aug build (sha256:ee8ecc62…); `latest-full` is the 20 Sep build (sha256:7334b00b…). The architecture report said they were the same, which is wrong. Both are TeX Live 2026 with latexmk 4.88, so the findings carry over. Pin `latest-full` by digest.
- **Playwright:** pin @playwright/test 1.61.1, not the latest 1.63.0. 1.61.x is the release that uses the cached chromium-1228; 1.63 needs 1243.
- **Compile directory:** use one writable compile directory per project, filled from the live state. Do not mount the source read-only with a separate output directory. I checked: pdfLaTeX's automatic EPS→PDF conversion (repstopdf) fails with a read-only source (latexmk exit 12), and mounting the live project directory would race with the editor's delayed save to disk.
- **Job name and xr:** keep jobname = the file's basename. But latexmk does not build the `\externaldocument` for xr. A fresh project gets 45+ undefined references, and Overleaf fixes this only through a Perl latexmkrc, which `-norc` switches off. So the clone needs a built-in "pre-build external documents" step. Supplementary 5.5 s then main 3.0 s gives 0 undefined references.
- **`-gt`:** use it only for a manual Recompile. For auto-compile, skip identical builds by content hash on the server; an unchanged latexmk run takes 0.29 s anyway.
- **History snapshots:** do not commit a git snapshot before every compile, because auto-compile would create one about every 5 s.
- **Where the Yjs state file lives:** outside the project directory, keyed by fileId and an epoch number.
- **Libraries:** call the git CLI with execFile, not simple-git. Export zips with yazl or `git archive`, not archiver 8. Use either react-arborist or @dnd-kit, not both. react-resizable-panels v4 renamed its components to Group/Panel/Separator. react-router 8.4.0 requires Node ≥22.22, so use 7.18.4 (or upgrade Node). better-sqlite3 13 ships no types, so add @types/better-sqlite3 9.6.0.

I also researched the gaps, all tested on this box:
- **Vite and Node sharing websockets:** proxying `/ws` with `ws:true` works next to Vite's HMR socket (`/?token=`), and cookies and Origin are passed through. `changeOrigin` must stay false, or Host is rewritten and a Host-vs-Origin CSRF check fails.
- **Auto-compile versus Yjs saving:** the compile must read Y.Text from memory. Comparing state vectors cannot prove the server has the client's latest edit, because deletions do not change the state vector. A custom barrier message on the same y-websocket connection gave 200/200 consistent results, and matches Overleaf's awaitBufferedOps.
- **CRLF files:** CRLF text in a Y.Text makes CodeMirror and Yjs positions drift, and the two copies silently diverge. The user's Definitions/journalnames.tex has 4,770 CRLF lines.
- **Idle connections:** a server that sends nothing makes y-websocket reconnect every 30 s.
- **CSP:** helmet's default CSP blocks pdf.js's WebAssembly colour-profile decoder on the user's PDF; adding `'wasm-unsafe-eval'` fixes it.
- **EPS previews:** Ghostscript in the sandbox renders them to PNG.
- **Importing the user's paper:** exact exclude list, 47 files, 3.45 MB.
- **Tests:** a concrete Playwright and Vitest plan.

The rest of the stack stands: Node 22, Express 5 + ws, React 19.3 + Vite 8.3, CodeMirror 6, pdfjs-dist 6.3.289, yjs 13.6.32 with y-websocket 3.1.0 and our own y-protocols server, better-sqlite3 13, the git CLI, and one hardened `docker run --init` per compile. Hocuspocus 4.7.0 (MIT, yjs ^13.6.8 peer, Node ≥22) is a working fallback server. It is the only ready-made server that shares one websocket across several documents.

**Order to build in:**
1. Server skeleton on one http.Server (REST, `/ws` upgrade routing, pdf.js assets, build outputs).
2. Importer, shared by zip upload and the seed script, with end-of-line normalisation and text/binary classification.
3. Yjs rooms with sidecar state, epoch, keepalive and barrier.
4. Compile coordinator: in-memory snapshot, hash deduplication, single-flight with one queued follow-up, external-document pre-build, writable compile directory.
5. pdf.js viewer with SyncTeX.
6. Log parser.
7. History.
8. Sharing.

The Playwright suite should run against the production build.

## [must] CONTRADICTION: TypeScript 6.0.3 vs 7.0.2
Resolved: pin typescript@~6.0.3.

- npm `latest` is now 7.0.2: a native Go build with a `tsc` bin and 20 platform packages.
- typescript-eslint@8.70.0 and @typescript-eslint/parser both declare the peer range `typescript >=4.8.4 <6.1.0`.
- The pdf-synctex prototype (viteapp: strict, lib ES2023+DOM, skipLibCheck) type-checks with 0 errors under 6.0.3. Its 7.0.2-only claim does not force TS7.
- Use `"typescript": "~6.0.3"` in every workspace, and never run a bare `npm i -D typescript`.
- Pin @types/node@22.20.4 to match the Node 22.19 runtime. The editor prototype used ^24.13.6, and npm `latest` is 26.6.2.
Sources: npm view typescript dist-tags (latest 7.0.2, next 7.1.0-dev.20260920.1), npm view typescript-eslint peerDependencies, local: scratchpad/pdfsync_research/viteapp tsc 6.0.3 --noEmit OK

## [must] CONTRADICTION: TeX Live image tag/digest (latest != latest-full)
`docker images --digests` shows two different images:
- `texlive/texlive:latest`: sha256:ee8ecc627897eabeb42d862d8187546483455e66ce94aa5c2bce1b45a977ab27, image id 3f531b702e1e, built 16 Aug, 5.65 GB.
- `texlive/texlive:latest-full`: sha256:7334b00bf8e7a0996f7ddd65482363aaf7711d372e569f3ea78509619e3083ff, image id 34bda19a0ee9, built 20 Sep, 5.69 GB.

The architecture report said `latest` == `latest-full`. That is not true locally. Both images contain TeX Live 2026, latexmk 4.88 (9 March 2026), XeTeX 0.999998 and Ghostscript 10.07.1, so the measurements in the architecture, logparse and pdf-synctex reports (which used `latest`) still hold.

Decision:
- Set `COMPILE_IMAGE=texlive/texlive:latest-full@sha256:7334b00bf8e7a0996f7ddd65482363aaf7711d372e569f3ea78509619e3083ff`.
- Optionally run `docker tag` to a local name such as `olc-texlive:tl2026-20260920`.
- Record the image id in each build's meta.json.
- The stale `latest` image can be removed to free 5.65 GB. That is the user's decision.
- Both images run as root by default. uid 1000 maps to a user named `texlive` inside the image.
Sources: local: docker images --digests; docker run ... latexmk -v / xetex --version

## [must] CONTRADICTION: Playwright version vs cached browser
~/.cache/ms-playwright contains chromium-1228, chromium_headless_shell-1228 and ffmpeg-1011. Chromium revision for each playwright-core release, read from each release's browsers.json:

| playwright-core | Chromium revision | Chrome version |
|---|---|---|
| 1.60.0 | 1223 | |
| 1.61.0 / 1.61.1 | 1228 | 149.0.7827.55 |
| 1.62.x | 1234 | |
| 1.63.0 (npm latest) | 1243 | 153.0.8010.12 |

- Pin `@playwright/test@1.61.1` and, if Vitest browser mode is used, `playwright@1.61.1`, so no download is needed.
- Upgrading means running `npx playwright install chromium`, which downloads about 170 MB; network access is available.
- The editor-stack and pdf-synctex prototypes used playwright-core ^1.61.0, which is consistent with this.
Sources: npm pack playwright-core@{1.60.0,1.61.0,1.61.1,1.62.0,1.63.0} -> package/browsers.json, ls ~/.cache/ms-playwright

## [must] CONTRADICTION: compile directory model (RO source + outdir vs persistent writable compile dir)
Resolved: use one writable compile directory per project, `data/compile/<projectId>/`, mounted rw at a fixed container path `/compile`. Sources and aux files live together, as in Overleaf's CLSI (`-auxdir=-outdir=$COMPILE_DIR`). Fill it from a snapshot of the live state.

A read-only source mount with a separate `-outdir` breaks pdfLaTeX's EPS conversion. I verified this with `latexmk -norc -cd -pdf -outdir=/out -auxdir=/out /src/main.tex` (src mounted :ro):
- The log shows `runsystem(repstopdf --outfile=img/logo-mdpi-eps-converted-to.pdf ...)...executed safely (allowed)`, then `! Package pdftex.def Error: File img/logo-mdpi-eps-converted-to.pdf not found`, and latexmk exits 12.
- The same document in a writable directory exits 0 and creates `img/logo-mdpi-eps-converted-to.pdf`.

Why a copy rather than mounting the live directory:
- The live `data/projects/<id>` is rewritten by the delayed Yjs save while TeX runs, which is a race.
- The live files can lag behind the in-memory Y.Text.
- Packages that write next to their sources (epstopdf, minted, xr aux lookup in the working directory) need a writable tree.

How to sync:
- Write only files whose sha1 changed.
- Unlink removed files.
- `lstat` and unlink any symlink before writing.
- Write through a temp file plus rename.
- Never follow symlinks when copying outputs back.
Sources: local docker test scratchpad/critic/ro (texlive:latest-full, pdflatex, logo-mdpi.eps), architecture + history-collab reports

## [must] GAP/CONTRADICTION: xr \externaldocument needs a built-in pre-build (Overleaf relies on a Perl latexmkrc, which -norc disables)
Checked on the real paper with XeLaTeX:
- Compiling only `antiddos_v2.tex` in a fresh directory: latexmk exits 0 but reports 45+ `Reference ... undefined` (e.g. `tab:corpora`, `tab:ledger`). latexmk does not build the external document.
- latexmk for `antiddos_v2_supplementary` (5.5 s) then `antiddos_v2` (3.0 s, warm TEXMFVAR): 0 undefined references in both logs.
- latexmk tracks the external .aux through its .fls, so a changed `supp.aux` triggers a rerun of main.
- Overleaf's documented fix is a project latexmkrc with `add_cus_dep('tex','aux',0,'makeexternaldocument')`, which runs arbitrary Perl. Our sandbox uses `-norc`, so implement this in TypeScript instead.

Design:
1. Scan the root doc with `/\\external(?:cite)?document(?:\[[^\]]*\])?\{([^}]+)\}/g`.
2. Resolve `<name>.tex` relative to the root doc's directory.
3. Before the main run, run latexmk with `-jobname=<name>` for that file in the same compile directory. Do this only when `<name>.aux` is missing, or when the sha of `<name>.tex` changed since its last pre-build (stored in compile-dir meta).
4. Do not recurse, to avoid main↔supp loops.
5. Use the project's engine.
6. List `<name>.pdf` and `<name>.log` under "Other logs and files".

For the seeded paper, set `externalDocs=['antiddos_v2_supplementary.tex']` explicitly.
Sources: local docker test scratchpad/critic/xr, https://www.overleaf.com/learn/how-to/Cross_referencing_with_the_xr_package_in_Overleaf (search result), https://docs.overleaf.com/managing-projects-and-files/the-latexmkrc-file.md

## [should] POLICY: -gt only for manual Recompile; hash dedupe for auto-compile
Measured: re-running latexmk without `-gt` on an unchanged tree takes 0.29 s (`All targets (antiddos_v2.xdv antiddos_v2.pdf) are up-to-date`). With `-gt` (Overleaf's `$go_mode=3`) it always does full passes, several seconds.

Overleaf needs `-gt` only because it deletes output.pdf and output.log before every run.

Recommendation:
1. Compute a snapshot hash: sha256 over the compiler, draft, stopOnFirstError, root path, externalDocs, and a sorted list of (path, sha1(content)).
2. If it equals the last successful build's hash, return that build without starting Docker. This saves about 250 ms of `docker run` time, and it deduplicates N collaborators whose auto-compiles fire on the same edit.
3. Otherwise run latexmk without `-gt` for auto-compiles, and with `-gt` for an explicit Recompile click.
4. For 'Recompile from scratch', `rm -rf` the compile directory.
5. Keep previous build outputs by copying each finished build to `data/builds/<pid>/<buildId>/`, instead of deleting `<job>.pdf` before the run.
Sources: local docker test scratchpad/critic/xr (third run 0.29 s), ol/services/web/app/src/Features/Compile/CompileManager.mjs

## [must] CONTRADICTION: git snapshot 'before each compile' vs auto-compile
The history report snapshots before each compile. With auto-compile (a 2500 ms debounce, 5000 ms maximum wait, triggered by local and remote edits) that means a commit every few seconds while typing.

Resolution:
- Snapshot on 30 s idle, or at most every 5 min of continuous editing.
- Also snapshot before restore, label and download-version.
- Never snapshot per compile. Overleaf's history is independent of compiles.
- Snapshots read from live Y.Docs: flush first, then commit.
Sources: history-collab + features digests, ol/services/web/frontend/js/features/pdf-preview/util/compiler.ts (AUTO_COMPILE_DEBOUNCE=2500, MAX_WAIT=5000)

## [should] CONTRADICTIONS: small library choices
- **Draft mode:** use `latexmk -usepretex='\PassOptionsToPackage{draft}{graphicx}\PassOptionsToPackage{draft}{graphics}'`. Do not edit line 1 of the file in the compile dir.
- **Yjs server:** write our own on y-protocols@1.0.7 + lib0@0.2.117 + ws@8.21.3.
  - @y/websocket-server@0.1.5 depends on yjs ^14.0.0-7, @y/protocols and ws ^6. 0.1.1 has load/unload races.
  - Fallback: @hocuspocus/server@4.7.0 (peer yjs ^13.6.8, y-protocols ^1.0.6, node >=22, uses crossws).
- **Git:** call the git CLI with execFile. Drop simple-git@3.36.0.
- **Zip:**
  - Export with yazl@3.3.1.
  - Download past versions with `git archive --format=zip <sha>`.
  - Drop archiver@8.0.0.
- **Drag and drop:** react-arborist@3.16.0 (maintained, July 2026) brings react-dnd 14 with the HTML5 backend. Do not add @dnd-kit/core as well. OS file drops onto the tree may be captured by the react-dnd HTML5Backend (NativeTypes.FILE) and conflict with react-dropzone; test this in Playwright.
- **Panels:** react-resizable-panels@4.13.1 exports `Group` (prop `orientation`), `Panel`, `Separator` and `useDefaultLayout`. It does not export PanelGroup or PanelResizeHandle, and older tutorials will not compile.
- **Router:** react-router@8.4.0 has `engines.node >=22.22.0`, while we run 22.19. Use react-router@7.18.4 (node >=20) or wouter@3.11.0.
- **SQLite types:** better-sqlite3@13.0.3 ships no .d.ts; add @types/better-sqlite3@9.6.0.
- **Offline cache:** skip y-indexeddb in v1. It makes the duplicate-on-fresh-Y.Doc hazard persistent across browser restarts.
Sources: npm view (versions/peerDependencies/engines) run 2026-09-21, npm pack react-resizable-panels@4.13.1 (dist/*.d.ts)

## [must] GAP: Vite dev server + Node server sharing websockets (verified)
Tested with Vite 8.3.0 `createServer` and a Node http + ws(noServer) backend, driven by Playwright chromium-1228.

Config:
```ts
server:{host:'127.0.0.1',port:5173,strictPort:true,proxy:{
  '/api':{target:'http://127.0.0.1:3100'},
  '/ws':{target:'ws://127.0.0.1:3100',ws:true},
  '/pdfjs':{target:'http://127.0.0.1:3100'},
  '/project':{target:'http://127.0.0.1:3100'}}}
```

Results:
- Browser `new WebSocket('ws://'+location.host+'/ws/project/p1')` echoes through the proxy.
- Vite HMR still connects at `ws://127.0.0.1:5173/?token=…` (console: `[vite] connected.`). The HMR socket and an app prefix such as `/ws` do not collide. Never proxy `/` with `ws:true`.
- Cookie and Origin reach the backend unchanged. Set-Cookie comes back to the browser.
- **changeOrigin must stay false (the default).** With `changeOrigin:true`, the backend sees `Host: 127.0.0.1:3100` but `Origin: http://127.0.0.1:5173`, so an Origin==Host CSRF check fails.
- Vite docs: do not use `rewriteWsOrigin` (a CSRF risk), and Vite does not check the Origin of proxied websockets. Our server must check it on `upgrade`.
- In Vite 8, `server.hmr` websocket options are deprecated in favour of `server.ws`.

Production uses one http.Server:
```ts
const server = app.listen(PORT, HOST)
server.on('upgrade', (req, sock, head) => {
  // check Origin against PUBLIC_ORIGIN or Host
  // route /ws/doc/:pid/:fileId -> docWss.handleUpgrade(...)
  // route /ws/project/:pid -> metaWss
  // anything else -> sock.destroy()
})
```

Handling auth failures:
- Accept the upgrade, then `ws.close(4401|4403|4404, reason)`. y-websocket 3.1.0's `defaultShouldReconnect = e => !(e.code>=4400 && e.code<4500)`, so these codes stop reconnection.
- An HTTP 403 at upgrade appears as close code 1006, and the client retries forever with backoff (`maxBackoffTime` 2500 ms).

Serve `/pdfjs/*` from Express in dev too, through the proxy. Otherwise Vite's single-page-app fallback returns index.html for missing wasm, cmaps or iccs.
Sources: local test scratchpad/critic/vt/test.mjs + hmr.mjs, https://vite.dev/config/server-options, node_modules/y-websocket/src/y-websocket.js (defaultShouldReconnect, constructor defaults)

## [must] GAP: auto-compile debounce vs Yjs persistence — compile from memory + ordered barrier
Facts from the Overleaf source (read only to learn the behaviour):
- `AUTO_COMPILE_DEBOUNCE=2500`, `AUTO_COMPILE_MAX_WAIT=5000`, `PENDING_OP_MAX_WAIT=10000`.
- `compile()` awaits `openDocs.awaitBufferedOps()` before POSTing.
- `changedAt` is set from the doc 'change' event with a 50 ms timeout. ShareJS emits `'change'` for remote ops too (sharejs.js:976 `this.emit('change', docOp, oldSnapshot, msg, isRemote)`), so collaborators' edits trigger your auto-compile.
- If a compile is already running, an auto-compile re-arms the debounce.
- Server side: a 1 s per-(project,user) guard returns `too-recently-compiled`, and a global auto-compile limit of 25 points per 20 s returns `autocompile-backoff`. On backoff the UI turns auto-compile off and shows 'autocompile-disabled'.

Clone design:
1. The client observes Y.Text for the open doc(s) once provider 'sync' is true, for local and remote transactions, then runs a debounce of 2500 ms with a 5000 ms maximum wait.
2. **Barrier.** Before the POST, send a custom message type 100 with a random nonce on each open doc's `provider.ws`. The server echoes it after processing everything that arrived before it on that socket. The client awaits the echo with a 10 s timeout.
   - Client registration: `provider.messageHandlers[100] = (_enc, dec) => resolve(decoding.readVarString(dec))`.
   - Server: `case 100: send([100, readVarString(dec)])` inside the same ordered per-connection handler as sync messages. If the room is still loading, queue the barrier with the other messages.
   - Verified 200/200: after the echo, server text equalled client text, including delete-only edits.
   - A state-vector comparison is not enough: `Y.encodeStateVector` does not change on deletions (verified). If you use snapshots instead, compare delete sets via `Y.snapshot` / `Y.isDeleted`.
   - If `!provider.wsconnected`, compile the server's copy and label it "offline – compiling last synced version".
3. The server snapshot reads `room.ytext.toString()` for loaded rooms and the disk for the rest. It never waits for the delayed disk save or the sidecar save; those stay on their own schedule (for example 2 s idle, 10 s maximum).
4. Keep one coordinator per project:
   - single-flight plus one queued follow-up;
   - hash deduplication;
   - 1 s per-user guard;
   - global auto-compile rate limit;
   - global concurrency limit via p-limit or p-queue.
5. Optional: the project meta channel broadcasts a debounced 'docChanged' so edits in files that are not open can also trigger auto-compile.
Sources: ol/services/web/frontend/js/features/pdf-preview/util/compiler.ts, ol/services/web/frontend/js/features/ide-react/editor/document-container.ts:840-860, ol/services/web/frontend/js/vendor/libs/sharejs.js:976, ol/services/web/app/src/Features/Compile/CompileManager.mjs:279-330, local test: yjs 13.6.32 state vector + barrier (scratchpad/critic/sv.mjs, zz_barrier)

## [must] GAP: CRLF in Y.Text silently corrupts collaboration (verified) — normalize EOL at every entry point
CodeMirror 6 treats `\r\n` as one line break (length 1), but Y.Text counts 2 characters. y-codemirror.next maps positions 1:1 between them.

Playwright test with `'line1\r\nline2\r\nline3\r\n'`:
- A local insert of 'X' at the start of CodeMirror line 3 landed in Y as `Rline2X\r\n`.
- A remote insert of 'R' before 'line2' landed in CodeMirror as `lRine2`.
- CodeMirror length was 20 against Y length 23. The copies diverge with no error.
- After normalising to LF, both copies are identical.

The user's `Definitions/journalnames.tex` has 4,770 CRLF line endings.

Fix: apply `s.replace(/\r\n?/g, '\n')` wherever text enters the system:
- zip import and directory seed;
- upload replacing a doc;
- file-watcher reconcile (applyTextDiff input);
- REST text writes;
- git restore input.

Overleaf does the same: FileSystemImportManager splits on `/\r\n|\n|\r/`.

Also:
- Strip a leading U+FEFF (byte-order mark).
- Treat files that are not valid UTF-8 as binary and read-only, offering an explicit 'convert to UTF-8' action. Overleaf silently decodes them as latin1 and rewrites them as UTF-8, which breaks `\usepackage[latin1]{inputenc}` documents.
Sources: local Playwright test scratchpad/critic/vt/crlf, python byte scan of paper_v2/Definitions, ol/services/web/app/src/Features/Uploads/FileSystemImportManager.mjs:200-203, FileTypeManager.mjs

## [should] GAP: text/binary classification edge cases in the user's files
Overleaf's rules:
- Text extensions (libraries/overleaf-editor-core/lib/text_file_defaults.js): tex latex sty cls bst bib bibtex txt tikz mtx rtex md asy lbx bbx cbx m lco dtx ins ist def clo ldf rmd qmd lua py gv mf yml yaml lhs lean lean4 hs mk xmpdata cfg rnw ltx inc.
- `max_doc_length` is 2 MB; the detection limit is 3× that.
- UTF-8 is checked with utf-8-validate, falling back to latin1.
- A NUL byte or a non-BMP surrogate makes a file binary. That rule exists only for their history service; Yjs does not need it.
- `maxUploadSize` is 50 MB.

The user's files:
- `Definitions/mdpi.cls` contains one 0x1C byte at offset 763, and `file` calls it application/octet-stream. Classify by extension first, not by libmagic or isbinaryfile. CodeMirror shows the byte as a special-character placeholder, and Yjs keeps it intact.
- `inst` (86 KB UTF-8 text) has no extension, and `figures/regenerate_figures.sh` has a `.sh` extension. Overleaf would make both binary. Recommended: for unknown or missing extensions, sniff the content (valid UTF-8, no NUL, ≤2 MB → text). Keep an always-binary list: pdf png jpg jpeg gif eps ps svg zip gz tif tiff.
- The EPS logos are DOS-EPS binaries (header C5 D0 D3 C6), so treat them as binary.

A type change (binary→text or back) or a >2 MB growth must bump the file's Yjs epoch (see the epoch finding).
Sources: ol/libraries/overleaf-editor-core/lib/text_file_defaults.js, ol/services/web/config/settings.defaults.js:351,722,863-872, local python scan of paper_v2

## [should] GAP: binary file preview + serving
Preview matrix:
- **png/jpg/gif/webp:** show in an `<img>` from `/api/projects/:pid/files/:fileId/raw` with `X-Content-Type-Options: nosniff`.
- **svg:** show only through `<img>`. For direct navigation send `Content-Security-Policy: sandbox` and `Content-Disposition: attachment`.
- **pdf:** render the first page with the same pdf.js module.
- **eps/ps:** render to PNG in the sandbox and cache by content sha1. Verified in `latest-full` (Ghostscript 10.07.1), with `--network none --read-only --tmpfs /tmp --cap-drop ALL --user 1000:1000`:
  ```
  gs -q -dSAFER -dBATCH -dNOPAUSE -dEPSCrop -sDEVICE=png16m -r96 -sOutputFile=- /in/logo-mdpi.eps > out.png
  ```
  This produced a 97x64 PNG of the MDPI logo. Use `-r150` for a sharper result.
- **Everything else:** show a 'No preview – Download' panel.

The image has no pdftoppm, mutool or ImageMagick. `epstopdf` and `rungs` are present.

Ghostscript prints `Fontconfig error: No writable cache directories /var/cache/fontconfig` with a read-only root filesystem. Always pass `-e XDG_CACHE_HOME=/cache/xdg` (persistent volume) or `/tmp`. XeLaTeX font lookup also goes through fontconfig.

Replacing a binary file creates a new git blob in history. Uploading a text file over an open doc goes through applyTextDiff on the live Y.Text, not a file replace.

Content-Type comes from the extension (mime@4.1.0 or mime-types@3.0.2), never from sniffing.
Sources: local docker test scratchpad/critic/eps (PNG verified visually)

## [must] GAP: seeding the user's paper as a project (exact rules)
Build a CLI on the same importer as zip upload:
```
npm run seed -- --src <paper directory> --name 'AntiDDoS Shield v2' --owner <email> --main antiddos_v2.tex --compiler xelatex --external antiddos_v2_supplementary.tex
```

Walk the tree with `lstat` and skip symlinks. Exclude:
1. **`overleaf/`.** This is the app itself, with node_modules and data/. Importing it would recurse into the app's own data.
2. **`ready/`.** A duplicate copy of the submission.
3. **Overleaf's ignore pattern:** `**/{{__MACOSX,.git,.texpadtmp,.R,.venv,venv}{,/**},.!(latexmkrc),*.{dvi,aux,log,toc,out,pdfsync,synctex,synctex(busy),fdb_latexmk,fls,nlo,ind,glo,gls,glg,bbl,blg,doc,docx,gz,swp}}`, plus xdv.
4. **`<root>.pdf` next to each root `.tex`:** antiddos_v2.pdf and antiddos_v2_supplementary.pdf.
5. **`*.zip`:** antiddos_v2_submission.zip (2.07 MB) and MDPI_template_ACS.zip (681 KB).

Result: 47 files, 3,454,304 bytes.

Nine .tex files contain `\documentclass`: the 2 papers and 7 `figures/*_standalone.tex`. So the root doc must be set explicitly, not guessed.

In each text file, normalise line endings to LF and strip any byte-order mark. Normalise names to NFC. Then:
1. Insert rows in SQLite.
2. Make the initial git commit 'Import from paper_v2'.
3. Set compiler=xelatex, timeout=240 s and externalDocs.
4. Optionally run the first compile: supplementary pre-build, then main. That is about 9.5 s cold and about 8.5 s warm in total.

Tell the user that edits made in the app live in `data/projects/<id>`, not in the original folder. Offer an `export-project --to <dir>` command with a dry-run diff for syncing back.
Sources: local: find/du over paper_v2 (scratchpad/critic/seedlist.txt), ol/services/web/config/settings.defaults.js fileIgnorePattern

## [must] GAP: y-websocket keepalive, BroadcastChannel, payload limits (verified)
**Keepalive.** y-websocket 3.1.0 closes and reconnects when no message arrives for 30 s (`messageReconnectTimeout = 30000`). Browser pings do not count.
- Measured: a server that sends nothing after sync caused 2 connections in 45 s. A server sending an empty awareness update every 10 s kept 1 connection.
- Our server must do one of two things:
  - rebroadcast awareness updates to all connections, including the sender (clients renew awareness every 15 s); or
  - send a keepalive every 10–15 s: `[1, encodeAwarenessUpdate(awareness, [])]`.
- Clients that set no awareness state (viewers) need the keepalive.
- Also run a ws-level ping/terminate every 30 s to drop dead sockets and clear stale presence.

**BroadcastChannel.** Construct providers with `disableBc: true`. y-websocket otherwise syncs tabs of the same browser directly, bypassing server permission checks, the barrier ordering and read-only enforcement.

**Payload limits.** ws 8.21.3 defaults to `maxPayload: 100*1024*1024`. Set `new WebSocketServer({noServer:true, maxPayload: 8*1024*1024})`.

**Document size.** After applying an update, if `ytext.length > 2*1024*1024`, close the connection with 4413 and mark the doc too large.
Sources: local test scratchpad/cmyjs zz_idle (silent=2 conns, keepalive=1), node_modules/y-websocket/src/y-websocket.js:99,229,317-326, node_modules/ws/lib/websocket-server.js:74

## [should] GAP: Yjs room epoch — the only safe way to discard server Y state
The editor-stack report showed that a fresh Y.Doc built from disk gets duplicated when stale clients reconnect.

Whenever the server must throw Y state away, bump the file's epoch instead of reusing the room. Cases:
- corrupt or missing sidecar;
- binary↔text type change;
- a file deleted and re-created at the same path;
- restoring a backup that is older than connected clients;
- a future compaction.

How it works:
- Room name = `${projectId}/${fileId}:${epoch}`, with `epoch INTEGER` in the files table.
- On a bump, close old-epoch sockets with code 4409 ('stale doc').
- The client does not auto-reconnect, because the code is in 4400–4499. It refetches file metadata and opens a new Y.Doc and provider for the new room.

The sidecar lives at `data/ystate/<projectId>/<fileId>.<epoch>.ybin`. It is outside the project directory, so it never enters compiles, git or zip export. This resolves the editor-stack report's own contradiction ('next to each .tex' versus 'outside the project dir').
Sources: editor-stack + history digests, y-websocket defaultShouldReconnect

## [should] GAP: real-time file tree, presence and project events channel
No report specifies how collaborators see file create/rename/move/delete, root-doc changes or project settings changes live. Overleaf pushes socket events for these (reciveNewDoc, reciveEntityRename, and so on).

Recommended: a project meta room on the same websocket stack, `/ws/project/:pid`.
- A server-authoritative Y.Doc holds Y.Map 'tree' (fileId → {path, type, size, epoch}) and Y.Map 'settings' (rootFileId, compiler, externalDocs).
- The server drops all client document updates on this room; everyone is read-only. Mutations go through REST, are validated, then the server applies them in a `Y.transact`.
- Its Awareness carries project-wide presence: {userId, name, color, openFileId}, which drives the avatars and the 'who is in which file' dots.
- Stateless JSON events can use custom message type 101, for example `{type:'compile:done', buildId}` (optional) or `'doc:changed'` for auto-compile on files that are not open.

This reuses the tested sync, awareness and keepalive code, and it gives reconnect catch-up for free.
Sources: ol real-time event names (features/architecture reports), design

## [must] GAP: CSP — helmet 8.3.0 defaults break pdf.js wasm (verified)
helmet 8.3.0 `getDefaultDirectives()`:
```
default-src 'self'; script-src 'self'; img-src 'self' data:; object-src 'none';
style-src 'self' https: 'unsafe-inline'; upgrade-insecure-requests
```

I served the pdf-synctex viteapp dist plus pdfjs-dist 6.3.289 assets and loaded the user's paper in chromium-1228:
- **With helmet's CSP:** `Warning: ICCBased color space: "CompileError: WebAssembly.Module(): Compiling or instantiating WebAssembly module violates the following Content Security policy"`.
- **With `script-src 'self' 'wasm-unsafe-eval'`:** no warnings.

The settings to use:
```
helmet({
  contentSecurityPolicy: {
    directives: {
      'script-src': ["'self'", "'wasm-unsafe-eval'"],
      'img-src': ["'self'", 'data:', 'blob:'],
      'upgrade-insecure-requests': null
    }
  },
  strictTransportSecurity: false
})
```
- Turn HSTS off unless serving over HTTPS.
- The pdf.js worker is a same-origin module file, so the default worker-src (falling back to 'self') is fine.
- `connect-src 'self'` covers same-origin ws: in current browsers.
- pdf.js wasm modules: qcms_bg.wasm (no JS fallback), openjpeg.wasm and jbig2.wasm (these have *_nowasm_fallback.js).
Sources: npm pack helmet@8.3.0 (index.mjs getDefaultDirectives), local Playwright test scratchpad/critic/csp.mjs

## [must] GAP: testing strategy — Playwright e2e
**Setup**
- Pin `@playwright/test@1.61.1` (cached chromium-1228).
- Run e2e against the PRODUCTION build served by Express, one origin exactly as deployed. This catches pdf.js asset and single-page-app fallback bugs that Vite dev hides.
- playwright.config.ts: `webServer: {command: 'npm run build && node server/dist/main.js', url: 'http://127.0.0.1:3199/healthz', env: {PORT: '3199', DATA_DIR: <tmp>, COMPILE_RUNNER: 'docker'|'fake'}, timeout: 180_000, reuseExistingServer: false}`.
- Two projects:
  - `fast`: a fake CompileRunner that returns fixture PDF, synctex and log files.
  - `docker` (tag `@docker`): the real image, `workers: 2`.
- globalSetup creates alice, bob and carol through a CLI or REST and saves a storageState for each.
- For the collaboration tests, make the server a fixture-managed child process instead of a webServer, so a test can SIGTERM and restart it mid-session.

**Test hooks**
- In test builds, expose `window.__olc = {views, providers, compiler}`. The editor prototype already used `window.__views`.
- Read text with `view.state.doc.toString()`. CodeMirror virtualises lines, so `.cm-content` innerText misses off-screen lines of the 200 KB paper.
- Type with `keyboard.type` or `insertText` after clicking `.cm-content`.

**Other tools**
- Auto-compile debounce: `page.clock.install()` / `runFor(2600)`.
- Offline and reconnect: `page.routeWebSocket('**/ws/doc/**', ws => { const s = ws.connectToServer(); … s.close() })` (v1.48+). Do not rely on `context.setOffline` for websockets.
- PDF ready: `.pdfViewer .page[data-loaded="true"]`. pdf_viewer.mjs sets that attribute, and the eventBus fires 'pagesloaded', 'pagerendered' and 'textlayerrendered'.
- SyncTeX: `page.locator('.page').first().dblclick({position})`, then assert the editor cursor line. For code→PDF, assert that the highlight box overlaps a text-layer span.
- Clipboard: `context.grantPermissions(['clipboard-read','clipboard-write'])`.

**Must-have specs**
- two-user typing, presence and undo isolation;
- server restart gives no duplication;
- CRLF import round-trip;
- barrier: compile right after typing includes the last keystroke;
- viewer read-only, including a DevTools-forced edit being dropped by the server;
- zip upload, including zip-slip and symlink entries being rejected;
- compile, then the logs pane counts on fixtures;
- SyncTeX both ways;
- history restore through live docs;
- share-link join;
- the seeded paper compiles with 0 errors and 0 undefined references (docker project).
Sources: https://playwright.dev/docs/api/class-websocketroute, pdfjs-dist 6.3.289 web/pdf_viewer.mjs:5350,7313,8450, scratchpad/cmyjs/e2e.mjs

## [must] GAP: testing strategy — unit/integration (Vitest 5.0.1)
- vitest@5.0.1 needs node ^22.12 and peers vite ^6.4, ^7 or ^8.
- Set up two Vitest projects: `server` (environment node) and `shared` (log and synctex parsers, path rules).
- If browser-mode component tests are wanted, use @vitest/browser-playwright@5.0.1 with playwright@1.61.1.
- Node-side pdf.js must import `pdfjs-dist/legacy/build/pdf.mjs`, because Node 22.19 lacks Promise.try.

Required suites:
1. Log parser against the two real logs and synthetic fixtures (logparse report).
2. JS SyncTeX parser against golden JSON produced by the synctex CLI (pdf-synctex report).
3. Collaboration server with the real y-websocket client in Node (`{WebSocketPolyfill: WebSocket from 'ws', disableBc: true}`):
   - sync;
   - restart without duplication;
   - sidecar load plus disk reconcile;
   - barrier;
   - keepalive;
   - read-only drop;
   - epoch bump closes with 4409.
4. applyTextDiff and EOL normalisation.
5. Path and filename validation, following Overleaf's SafePath behaviour:
   - reject `/ \ *`, C0/C1 control characters, U+007F and lone surrogates;
   - reject names equal to `.` or `..`, and leading or trailing whitespace;
   - reject JS prototype property names such as `__proto__` and `constructor`;
   - maximum path length 1024.
   Additionally apply NFC normalisation and reserve `.git*` names.
6. Zip import: `../` names, symlink entries, size and ratio bombs.
7. Compile coordinator with a fake runner: single-flight plus one queued run, hash deduplication, per-user 1 s guard, auto-compile backoff, timeout leading to `docker kill`.
8. Git history on temporary repos.
9. A docker-tagged CompileRunner integration test: hello.tex, an error document, an xr pair, a biber document, and a lualatex run with a warm TEXMFVAR.

`npm ls yjs @codemirror/state @lezer/common` must print a single version each; run it in the test script.
Sources: npm view vitest@5.0.1 engines/peerDependencies, npm view @vitest/browser-playwright@5.0.1, ol/services/web/app/src/Features/Project/SafePath.mjs (behaviour only)

## [should] GAP: repo layout, scripts, runtime (Node 22.19 type stripping verified)
Layout:
- npm workspaces: `server/`, `web/`, `shared/` (log parser, synctex parser, path rules, API types).
- `data/` (gitignored, or `DATA_DIR`) holds projects, ystate, history, compile, builds, db.sqlite and the texcache volume directory.

Scripts:
- `dev`: `concurrently -k "tsx watch server/src/main.ts" "vite --config web/vite.config.ts"` (concurrently@10.0.5, tsx@4.23.15).
- `build`: `vite build` plus `tsc -p server` (or run the TypeScript directly).
- `start`: `node --env-file-if-exists=.env server/dist/main.js`.
- `seed`, `create-user`, `doctor`.

Running TypeScript without a build step:
- Node 22.19 strips types natively with no flag and no warning.
- Enums fail; they would need --experimental-transform-types.
- It also works for workspace packages symlinked into node_modules, because the realpath is outside node_modules (verified).
- So the server can run `node --watch server/src/main.ts` if the code uses `erasableSyntaxOnly: true`, `verbatimModuleSyntax: true`, `.ts` import extensions and `rewriteRelativeImportExtensions: true`. tsx remains the lower-friction choice.

`doctor` checks:
- `docker info` works;
- the image digest is present;
- git ≥ 2.24 (local 2.34.1);
- `DATA_DIR` is writable;
- the TeX cache is pre-warmed (`luaotfload-tool -u`, `fc-cache` with TEXMFVAR and XDG_CACHE_HOME on the cache volume).

Bind to 127.0.0.1 by default. For LAN or HTTPS use a reverse proxy, with a `PUBLIC_ORIGIN` env var for the Origin check.
Sources: local: node ts1.ts / ts2.ts / wsx workspace test, npm view concurrently/tsx dist-tags

## [should] GAP: compile container lifecycle hygiene
- Run each compile with `docker run --rm --init --name olc-<buildId> --label olc.kind=compile --label olc.project=<pid> …`.
- Stop or time out by name with `docker kill olc-<buildId>`. Killing the CLI child process does not stop the container.
- On startup and shutdown, reap orphans: `docker ps -q --filter label=olc.kind=compile | xargs -r docker kill`.
- Environment for every run:
  - `HOME=/tmp`
  - `TEXMFVAR=/cache/texmf-var` (persistent volume; without it, LuaLaTeX segfaults as uid 1000)
  - `XDG_CACHE_HOME=/cache/xdg`
  - `max_print_line=10000`, `error_line=254`, `half_error_line=238`
  - no secrets: TeX Live 2026 openin_any does not restrict reads, and /proc/self/environ is readable.
- The warm SyncTeX fallback container (`docker exec`) uses the same labels and a read-only mount of `data/builds`.
- On SIGTERM:
  1. Stop accepting connections.
  2. Flush all Y.Docs and sidecars.
  3. Take a final git snapshot.
  4. Kill running compiles.
  5. Close sockets with 1012 (service restart), which clients retry.
Sources: architecture/history reports (verified PID1 timeout, docker exec kill), local gs run showing fontconfig cache error under --read-only

## [should] GAP: first-run bootstrap and single-user mode
None of the reports covers how the first account is created.

Recommended:
- `npm run create-user -- --email ababab… --admin`, or a `/setup` page that is enabled only while the users table is empty (like Overleaf CE's /launchpad).
- Close public signup afterwards (`ALLOW_SIGNUP=false`). Collaborators join through admin-created accounts or share links that require login.
- With no SMTP, password reset is a CLI command (`npm run reset-password`). Email invites are skipped; share links replace them.
Sources: Overleaf CE launchpad behaviour (features report); design

## [nice] GAP: React dev-mode double mount with providers
React 19 StrictMode runs effects twice in dev: mount, unmount, mount. The editor component must fully clean up:
- `provider.destroy()`
- `view.destroy()`
- `ydoc.destroy()`
- the UndoManager

The server then sees a fast connect, disconnect, connect for the same room. The delayed room unload (flush, then a 30 s grace period) must tolerate that without reloading from disk.

Keep one Y.Doc per (fileId, epoch) in a small client-side cache keyed by room name. Otherwise HMR or StrictMode can create two providers for the same room.
Sources: design; React StrictMode semantics

## Packages
- typescript@6.0.3 (Apache-2.0) — type checking (resolved vs 7.0.2) typescript-eslint 8.70.0 peer <6.1.0; npm latest is 7.0.2 — pin ~6.0.3
- @playwright/test@1.61.1 (Apache-2.0) — e2e tests matches cached chromium-1228; 1.63.0 needs chromium 1243
- vitest@5.0.1 (MIT) — unit/integration tests node ^22.12; @vitest/browser-playwright 5.0.1 optional
- vite@8.3.0 (MIT) — frontend dev/build proxy /api,/ws(ws:true),/pdfjs,/project; changeOrigin false
- @vitejs/plugin-react@6.1.1 (MIT) — React plugin 
- react@19.3.0 (MIT) — UI 
- react-router@7.18.4 (MIT) — routing 8.4.0 has engines node>=22.22.0 (we run 22.19)
- react-resizable-panels@4.13.1 (MIT) — editor/PDF split v4 API: Group(orientation)/Panel/Separator/useDefaultLayout
- react-arborist@3.16.0 (MIT) — file tree uses react-dnd 14 HTML5 backend; don't add @dnd-kit too
- yjs@13.6.32 (MIT) — CRDT avoid 14.x prereleases
- y-websocket@3.1.0 (MIT) — client provider disableBc:true; close codes 4400-4499 stop reconnect; 30s idle reconnect
- y-protocols@1.0.7 (MIT) — server sync/awareness 
- lib0@0.2.117 (MIT) — encoding 
- y-codemirror.next@0.3.6 (MIT) — CM6 binding positions 1:1 with Y.Text — requires LF-only text
- ws@8.21.3 (MIT) — websocket server default maxPayload 100 MiB — lower it
- @hocuspocus/server@4.7.0 (MIT) — fallback collab server peer yjs ^13.6.8, node>=22; supports multiplexing
- express@5.2.1 (MIT) — HTTP server 
- @types/express@5.0.6 (MIT) — types 
- @types/node@22.20.4 (MIT) — types matching Node 22 latest is 26.6.2 — pin 22.x
- better-sqlite3@13.0.3 (MIT) — metadata DB no bundled types
- @types/better-sqlite3@9.6.0 (MIT) — types 
- helmet@8.3.0 (MIT) — security headers must add 'wasm-unsafe-eval'; disable upgrade-insecure-requests/HSTS on http
- cookie@2.0.1 (MIT) — cookie parsing on WS upgrade ESM; parseCookie/stringifySetCookie
- yauzl@3.4.0 (MIT) — zip import 
- yazl@3.3.1 (MIT) — zip export instead of archiver 8
- multer@2.4.0 (MIT) — uploads 
- chokidar@5.0.0 (MIT) — outside-edit watcher ESM, node>=20.19
- tsx@4.23.15 (MIT) — dev runner optional: Node 22.19 native type stripping works
- concurrently@10.0.5 (MIT) — dev script 
- pino@10.3.1 (MIT) — logging 
- pdfjs-dist@6.3.289 (Apache-2.0) — PDF viewer needs CSP wasm-unsafe-eval for qcms
- p-limit@7.3.3 (MIT) — global compile concurrency 
- mime@4.1.0 (MIT) — Content-Type by extension 
- texlive/texlive (Docker)@latest-full@sha256:7334b00bf8e7a0996f7ddd65482363aaf7711d372e569f3ea78509619e3083ff (various (TeX Live)) — sandboxed TeX Live 2026 differs from local :latest (sha256:ee8ecc62…, 16 Aug build)

## Risks
- CRLF text inside a Y.Text makes CodeMirror and Yjs silently diverge (verified). Normalise line endings at every point where text enters the system; Definitions/journalnames.tex has 4,770 CRLF line endings.
- A state-vector check cannot prove the server has a client's edits, because deletions do not change the state vector (verified). Use the ordered barrier message or compare delete sets.
- A read-only source mount with a separate output directory breaks pdfLaTeX's EPS→PDF conversion (latexmk exit 12, verified). Use one writable compile directory per project, filled by a symlink-safe sync.
- xr `\externaldocument` references stay undefined unless the external document is pre-built. Overleaf solves this with a Perl latexmkrc, which `-norc` blocks, so the clone needs its own pre-build step.
- The local `texlive/texlive:latest` and `:latest-full` are different images, contrary to one report. An unpinned tag gives different TeX outputs across machines and over time.
- Setting `changeOrigin: true` in the Vite proxy rewrites Host and breaks an Origin==Host CSRF check in dev. Setting `rewriteWsOrigin` opens CSRF on websockets.
- helmet's default CSP blocks pdf.js's WebAssembly colour-profile decoder (verified on the user's paper), and its upgrade-insecure-requests and HSTS break plain-HTTP LAN use.
- A server that sends nothing makes y-websocket clients reconnect every 30 s, which re-syncs and makes presence flicker. A keepalive or rebroadcasting awareness to the sender is required.
- Rejecting a websocket upgrade over HTTP makes y-websocket retry forever. Accept the upgrade, then close with a 4400–4499 code.
- y-websocket's default BroadcastChannel lets tabs of the same browser exchange edits without the server, bypassing permission checks and barrier ordering. Set disableBc: true.
- ws accepts messages up to 100 MiB by default, so a malicious client can bloat server memory. Set maxPayload and enforce a document-size limit.
- If Playwright is upgraded to 1.63 without running `playwright install`, e2e tests fail, because the cached browser is chromium-1228.
- react-router 8.4.0's engine requirement (Node ≥22.22) conflicts with Node 22.19.
- react-arborist (react-dnd HTML5 backend) may intercept OS file drops meant for react-dropzone; this needs a Playwright test.
- Throwing away Y state without bumping the room epoch (corrupt sidecar, type change, backup restore) reintroduces the document-duplication bug. y-indexeddb would make it outlive browser restarts.
- Committing a git snapshot on every auto-compile would flood the history. Snapshot on idle or at a maximum interval only.
- Auto-compile fires on collaborators' edits too, as in Overleaf, so N open clients can each trigger compiles. Server-side hash deduplication and rate limits are required.
