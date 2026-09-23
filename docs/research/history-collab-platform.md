# AREA: Project storage, versioning/history, sharing/auth, zip import/export, server framework choice, and LaTeX sandbox security for a single-node Overleaf-like clone

Recommended backend: Express 5.2.1 with ws 8.21.3 in noServer mode, and better-sqlite3 13.0.3 for all metadata (users, sessions, projects, members, share links, labels, file IDs). better-sqlite3 13 moved to Node-API and ships prebuilt .node files for linux-x64/arm64/musl/darwin/win32 inside the npm tarball, with no install script and no node-gyp. It installed in 7 s on this box and bundles SQLite 3.53.4. Its defaults are foreign_keys=1 and busy_timeout=5000, and it has db.transaction()/backup(). I rejected node:sqlite: on 22.19 it is unflagged but still Stability 1.1 and prints an ExperimentalWarning (checked locally). It also has no transaction helper and only became a release candidate in Node 25.7. Each project is one real directory (data/projects/<id>) holding only source files. Its git history lives in a separate git dir (data/history/<id>.git, created with --bare and core.bare=false, always called with --git-dir/--work-tree), so the compiler and zip export never see .git. History uses the git CLI through execFile, not isomorphic-git. isomorphic-git has no diff, archive or gc: 200 snapshots of the 200 KB paper made 21 MB of loose objects, and `git gc` shrank that to 2.3 MB. A git commit takes about 7 ms. Snapshots run after 30 s idle, at most every 5 minutes of continuous editing, and before each compile, restore or label. Each commit carries the author, Co-authored-by trailers and a reason trailer. Restores always add a new commit and are applied through live Yjs docs.

Auth uses scrypt from node:crypto with N=2^17,r=8,p=1 (or N=2^16,r=8,p=2) and an explicit maxmem. Without maxmem, Node 22 throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS even at N=2^15. One hash takes about 190 ms. Sessions are an opaque 256-bit cookie token with sha256(token) stored in a SQLite sessions table, rather than express-session. The cookie is HttpOnly and SameSite=Lax. CSRF protection has three layers: a Sec-Fetch-Site check, an Origin check and a required custom header. Sec-Fetch-* headers are only sent to HTTPS or localhost origins, so a plain-HTTP LAN deploy relies on the Origin check and the custom header. Roles are owner, editor and viewer. They are enforced by one resolveRole() used by REST middleware and the WebSocket upgrade handler. Read-only sockets drop Yjs sync-step-2/update messages. Share links follow Overleaf's split between a view link and an edit link. Tokens are 128-bit, stored hashed, accepted by a POST from an interstitial page, and can be revoked.

Zip import uses yauzl 3.4.0 (openPromise and eachEntry). I verified that it rejects the whole archive on `../` names. It exposes symlink mode bits (skip those entries) and enforces declared uncompressedSize, so size and ratio limits can be checked from the central directory before extracting. Zip export uses yazl 3.3.1, and `git archive --format=zip <sha>` downloads a past version. archiver 8.0.0 is now ESM-only with a new `new ZipArchive()` API and 9 dependencies, and adm-zip and unzipper are worse fits. Uploads use multer 2.4.0, which has had many CVEs in 2025–26 so use only the latest, with defParamCharset:'utf8'.

LaTeX sandbox findings, all tested against the local texlive/texlive:latest image (TeX Live 2026, latexmk 4.88):
- In TeX Live 2026, openin_any is officially a no-op (texmf.cnf says so). The default and 'p' both let a document read /etc/passwd and /proc/self/environ, and an env var I passed as a test secret showed up in the .log. Container isolation is the only read boundary, so never put secrets in the container env.
- openout_any=p is the default and blocks writes outside the working directory (tested).
- A project `latexmkrc` runs arbitrary Perl unless latexmk gets `-norc` (tested: it ran as uid 1000).
- GNU `timeout` as PID 1 in a container silently exits 125, so use `--init`.
- The image runs as root by default. Use `--user`.
- A hardened run compiled the user's MDPI paper with XeLaTeX in about 10 s. The flags were --network none, --read-only, a tmpfs /tmp, --cap-drop ALL, no-new-privileges, pids/memory/cpu/fsize limits, --user, --init and --log-driver none.
- A read-only source mount plus a separate writable -outdir works, including `\include` of subdirectory files, because latexmk creates the output subdirectories.

## [must] On-disk layout (single node)
DATA_DIR (default ./data, chmod 700):
  app.db (+ -wal/-shm)        SQLite metadata
  projects/<pid>/            canonical working tree: ONLY real source files (tex, bib, cls, sty, images, ...); never mounted into containers read-write, never contains .git
  history/<pid>.git/         git dir for that project (separate from working tree)
  compiles/<pid>/src/        consistent snapshot of sources synced before each compile (mounted :ro)
  compiles/<pid>/out/        latexmk -outdir (aux, log, pdf, synctex; persisted for incremental compiles; mounted :rw)
  output/<pid>/<buildId>/    copied artifacts served to clients (output.pdf, output.log, output.synctex.gz, .blg); keep last 2-3 builds
  uploads-tmp/               multer temp files (cleaned on every request end + at startup)
  tmp/                       staging for atomic writes and zip imports (same filesystem as projects/ so rename() is atomic)
  trash/<pid>/               soft-deleted projects, purged after N days.
Project ids: crypto.randomBytes(12).toString('hex') (24 hex chars); validate every :projectId route param with /^[0-9a-f]{24}$/ before touching the filesystem. Never derive directory names from user input (project names live only in SQLite).
Sources: local test in scratch: separate git dir + work tree, compile with ro src and rw out

## [must] SQLite driver: better-sqlite3 13.0.3 (recommended) vs node:sqlite
better-sqlite3@13.0.3 (published 2026-08-05, engines node>=22, MIT). v13 migrated to Node-API: package.json has gypfile:false, no install script, and ships prebuilds/{linux-x64,linux-arm64,linuxmusl-x64,linuxmusl-arm64,darwin-*,win32-*}.node inside the tarball (27 MB installed). `npm i better-sqlite3@13.0.3` took 7 s here with no compiler. Bundled SQLite = 3.53.4. Verified defaults: foreign_keys=1, busy_timeout=5000, synchronous=2(FULL); has db.transaction(fn), db.pragma(), db.backup(file), and a new db.explain(). No bundled .d.ts, so add @types/better-sqlite3@9.6.0 (still the current typings; API unchanged). Init:
  const db = new Database(path.join(DATA_DIR,'app.db'));
  db.pragma('journal_mode = WAL'); db.pragma('synchronous = NORMAL'); db.pragma('foreign_keys = ON'); db.pragma('busy_timeout = 5000');
node:sqlite on Node 22.19: works unflagged (since 22.13) but is still 'Stability 1.1 Active development' and prints `ExperimentalWarning: SQLite is an experimental feature` (verified locally; suppress only with --disable-warning=ExperimentalWarning). It has no transaction helper (manual BEGIN/COMMIT) and bundles SQLite 3.50.4. It only reached 'release candidate' in Node 25.7. Use it only if you need zero dependencies. Migrations: keep an array of SQL strings and apply those with index >= PRAGMA user_version inside db.transaction, then `PRAGMA user_version = n`. Backups: `await db.backup(`backups/app-${date}.db`)` nightly, plus a tar of projects/ and history/.
Sources: npm view better-sqlite3 (13.0.3, engines >=22), https://github.com/WiseLibs/better-sqlite3/releases, https://nodejs.org/docs/latest-v22.x/api/sqlite.html, https://nodejs.org/docs/latest/api/sqlite.html, local: node sq.mjs printed ExperimentalWarning on v22.19.0

## [must] Metadata: SQLite schema (not per-project JSON)
Per-project JSON files can't be queried across projects ("shared with me", session lookup, token lookup) and race under concurrent writes, so put all metadata in SQLite. Suggested schema:
CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, password_hash TEXT NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, disabled_at INTEGER);
CREATE TABLE sessions(id_hash BLOB PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, anon_grants TEXT /* JSON {projectId: tokenHashHex} for anonymous view-link sessions */, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, ip TEXT, user_agent TEXT);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_id TEXT NOT NULL REFERENCES users(id), root_doc_id TEXT, compiler TEXT NOT NULL DEFAULT 'pdflatex' CHECK(compiler IN ('pdflatex','xelatex','lualatex')), tex_image TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, head_sha TEXT);
CREATE TABLE project_members(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('editor','viewer')), source TEXT NOT NULL DEFAULT 'invite' CHECK(source IN ('invite','link')), added_at INTEGER NOT NULL, PRIMARY KEY(project_id,user_id));
CREATE TABLE share_links(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('editor','viewer')), token TEXT NOT NULL, token_hash BLOB NOT NULL UNIQUE, created_at INTEGER NOT NULL, revoked_at INTEGER, PRIMARY KEY(project_id, role));
CREATE TABLE files(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, path TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('doc','binary')), size INTEGER, mtime INTEGER, UNIQUE(project_id, path));
CREATE TABLE labels(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, commit_sha TEXT NOT NULL, name TEXT NOT NULL, created_by TEXT REFERENCES users(id), created_at INTEGER NOT NULL);
CREATE TABLE invites(token_hash BLOB PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, email TEXT NOT NULL, role TEXT NOT NULL, created_by TEXT, expires_at INTEGER NOT NULL);
The files table gives stable ids, so Yjs room names (`${projectId}:${fileId}`) survive renames. The filesystem stays the content store. Reconcile at project open with `await fs.promises.readdir(dir, { recursive: true, withFileTypes: true })`: new files get ids, and rows whose files are missing are removed.
Sources: local test: better-sqlite3 pragmas/transaction

## [must] Atomic file writes and the Yjs flush contract
The files on disk are the source of truth. A Y.Doc is created from the file text when the first client opens that file. Flush it to disk 2 s after the last update, when the last client disconnects, before any snapshot or compile, and on SIGTERM. Write atomically: `const tmp = path.join(DATA_DIR,'tmp',randomUUID()); await fh.writeFile(text); await fh.sync(); await fs.promises.rename(tmp, abs)`. Staging lives in DATA_DIR/tmp on the same filesystem, so temp files never appear in the project tree, the compile sync or git. Read project files with `fs.promises.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW)` and create them with flag 'wx' when they must not already exist. Mark a text file 'doc' (editable) if its extension is in a text list (tex, latex, ltx, sty, cls, clo, bst, bib, bbl, bbx, cbx, lbx, dtx, ins, def, cfg, ldf, tikz, txt, md, csv, dat, lua, asy, yml, yaml, rnw, Rtex, mtx, ist, gv), it is at most 2 MB (Overleaf's max_doc_length), and `new TextDecoder('utf-8', { fatal: true }).decode(buf)` does not throw. Everything else is 'binary': uploaded and replaced whole, never opened in CodeMirror.
Sources: https://raw.githubusercontent.com/overleaf/overleaf/main/services/web/config/settings.defaults.js (max_doc_length 2MB, maxEntitiesPerProject 2000, maxUploadSize 50MB, compile timeout 180s)

## [must] Path validation (Express 5 wildcard params are arrays; %2F decodes inside a segment)
Tested with express@5.2.1: in `app.get('/api/p/:pid/files/*filepath')`, req.params.filepath is an ARRAY of decoded segments, and a request to `/files/..%2Fsecret` yields ['../secret']. A naive join is therefore path traversal. Validate everything through one function:
const BAD = /[\u0000-\u001f\u007f\\:*?"<>|]/;
export function toProjectPath(input: string|string[]): string {
  const raw = (Array.isArray(input) ? input.join('/') : input).normalize('NFC');
  const segs = raw.split('/');
  if (!raw || raw.length > 1024 || segs.length > 20) throw httpError(400,'bad path');
  for (const s of segs) if (!s || s === '.' || s === '..' || s.length > 150 || BAD.test(s) || /^\s|\s$/.test(s) || s.startsWith('-') || /^\.git/i.test(s)) throw httpError(400,'bad path');
  return segs.join('/');
}
export function resolveInside(root: string, rel: string) { const abs = path.resolve(root, rel); if (!abs.startsWith(root + path.sep)) throw httpError(400,'bad path'); return abs; }
Why these rules: NFC merges macOS-NFD names from zips. A leading '-' would be read as an option by latexmk and git. The .git* names are reserved because an uploaded .gitignore would hide files from `git add`, and .gitattributes could rewrite EOLs or select diff/filter drivers. Warn, but don't block, on LaTeX-hostile characters (#%$&~^{} and spaces).
Sources: local test ex.mjs with express 5.2.1: {"fp":["../secret"]}, https://expressjs.com/en/guide/migrating-5.html

## [must] Per-project serialization
Run all mutating git operations, file-tree operations (rename/move/delete/upload/import/restore), snapshot and compile-sync for one project through a per-project async mutex. Concurrent `git add`/`commit` otherwise fails with index.lock errors, and restores could interleave with edits. A tiny implementation: `const chains = new Map<string, Promise<unknown>>(); function withProjectLock<T>(pid: string, fn: () => Promise<T>): Promise<T> { const prev = chains.get(pid) ?? Promise.resolve(); const next = prev.catch(() => {}).then(fn); chains.set(pid, next.finally(() => { if (chains.get(pid) === next) chains.delete(pid); })); return next; }`. Alternatives are p-queue@9.3.3 (concurrency 1 per project) or async-mutex@0.5.0. Read-only git commands (log, show, diff) can run outside the lock with GIT_OPTIONAL_LOCKS=0.

## [must] History engine: shell out to git CLI (not isomorphic-git, not simple-git)
Benchmark here (git 2.34.1, the 200 KB antiddos_v2.tex plus figures, 200 snapshot commits): CLI add+commit took 1466 ms total (about 7 ms each). `git log -- main.tex` took 8 ms. The repo had 21 MB of loose objects, and `git gc` brought it to 2.3 MB. isomorphic-git@1.42.2 took 38 ms for log with filepath. Its exports have NO diff, archive, gc or repack (only log/walk/statusMatrix/readBlob/...), so repos would grow without bound and every diff would have to be built by hand. simple-git@3.36.0 is only a CLI wrapper with past argument-injection CVEs. Write a ~100-line wrapper instead:
execFile('git', ['--git-dir', gd, '--work-tree', wt, '-c','core.hooksPath=/dev/null', '-c','core.fsmonitor=false', '-c','core.quotepath=false', '-c','gc.autoDetach=false', ...args], { env: GIT_ENV, maxBuffer: 64<<20, timeout: 30000 })
with GIT_ENV = { PATH, HOME: DATA_DIR, LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' (read commands only) }. Use spawn for streaming output (cat-file, archive). Always put `--end-of-options` before revisions and `--` before paths. Tested: `git log --end-of-options --output=/tmp/x` is refused. Also validate revisions with /^[0-9a-f]{40}$/ (or {64} for sha256 repos). If the app process uid differs from the repo owner, add `-c safe.directory=*` because of git's dubious-ownership check.
Sources: local benchmark in scratch/bench (git 2.34.1, isomorphic-git 1.42.2), npm view isomorphic-git/simple-git versions

## [must] Git repo initialisation (separate git dir, tested)
Create the repo with: `git init --quiet --bare --initial-branch=main history/<pid>.git`. Then run `git --git-dir=... config core.bare false`, `config core.filemode false`, `config core.autocrlf false`, `config user.name 'LaTeX Editor'`, `config user.email 'system@olc.invalid'` (fallback identity, needed because annotated tags use the committer ident and fail otherwise), `config gc.auto 256` and `config gc.autoDetach false`. Every command passes both --git-dir and --work-tree. Do NOT use `git init --separate-git-dir`: it writes a `.git` file into the working tree, which would be visible to the compiler and zip export. The first commit happens right after creation or import with reason=import. Tested flow: add -A, then `diff --cached --quiet` (exit code 1 means there are changes), then commit.
Sources: local test scratch/gt

## [must] Automatic snapshot policy and commit format
SnapshotScheduler per project tracks: dirtySince, a Map<userId, editCount>, and an idle timer. On each Yjs update or file operation: markDirty(pid, userId), which resets a 30 s idle timer. If now - dirtySince > 5 min, snapshot immediately so continuous typing is still captured. Also snapshot synchronously (inside the project lock) before a compile, before a restore, when a label is created, and on SIGTERM. A snapshot is: flushDocs(pid), then `git add --all --force -- .`, then `git diff --cached --quiet` (exit 0 means nothing to commit, so skip), then `git commit --quiet --no-verify --no-gpg-sign -F -` with GIT_AUTHOR_NAME/EMAIL = the top editor and GIT_COMMITTER_* = the same. Message:
`Edits by Alice, Bob\n\nOlc-Reason: idle|compile|restore|label|upload|import\nCo-authored-by: Bob <u-<bobId>@users.olc.invalid>`
Use synthetic emails u-<userId>@users.olc.invalid and map them back to current display names from SQLite, so renamed users and privacy both work. Store the new HEAD in projects.head_sha. Heavy editing gives on the order of 50-200 commits a day, which git handles easily. Run `git gc --quiet` nightly or every 200 commits (gc.auto=256 also triggers it).
Sources: local test: Co-authored-by trailer parsed with %(trailers:key=Co-authored-by,valueonly)

## [must] Listing versions (exact command + parser)
GET /api/projects/:pid/history?before=<sha>&limit=50. Command:
`git log -z -n 51 -M --name-status --format=%x1e%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%s%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)%x1f%(trailers:key=Olc-Reason,valueonly) --end-of-options <before or HEAD>`
Parse: split stdout on '\x1e' and drop the empty first chunk. In each record, the header runs up to the first '\0' or '\n', and its fields split on '\x1f'. The rest is `.split('\0').filter(Boolean)` tokens: a status token /^[AMDT]$/ is followed by 1 path, and /^[RC]\d+$/ by 2 paths (old, new). The root commit lists every file as A (verified). Return [{sha, parents[], author:{id,name}, coAuthors[], time, reason, files:[{status,path,oldPath?}], labels:[...]}], joining labels from SQLite by commit_sha. Use the 51st row as the next cursor. For single-file history add `--follow -- <path>`. For a range, list files with `git diff -z -M --name-status --end-of-options <from> <to>` and get per-file +/- counts from `git diff -z --numstat -M <from> <to>`. numstat prints '-\t-' for binary files.
Sources: local test scratch/gt (git 2.34.1)

## [must] Per-file diff between versions: server contract + jsdiff 9 notes
GET /api/projects/:pid/history/diff?from=<sha>&to=<sha|HEAD>&path=<p>. Fetch both sides with `git cat-file blob <sha>:<path>`, where a missing side means the file was added or deleted. Detect binary by NUL bytes or failed fatal UTF-8 decode. Return {binary:false, oldText, newText} capped at 2 MB, or {binary:true, oldSize, newSize, mime} and let the UI preview images through GET /history/blob?sha&path. Summary counts come from numstat. If a unified patch is needed (export, email), `git diff --no-color --no-ext-diff --no-textconv -U3 --end-of-options A B -- path` gives it directly, or jsdiff: `import { structuredPatch, createTwoFilesPatch, diffLines, diffChars } from 'diff'` (diff@9.0.0, BSD-3-Clause). Notes on diff 9: it ships its own types, so do NOT install @types/diff (8.0.0 is a stale stub). It is dual ESM/CJS, ES5 support was dropped, parsePatch now handles git-style patches, and formatPatch omits file headers when names are undefined. Verified output: structuredPatch('a.tex','a.tex',old,new,'v1','v2',{context:3}) gives hunks [{oldStart,oldLines,newStart,newLines,lines:[' x','-y','+Y',' z']}]. Pass `timeout` or `maxEditLength` for huge documents.
Sources: https://github.com/kpdecker/jsdiff (release-notes.md in diff@9.0.0 tarball), npm view diff@9.0.0 exports

## [should] Diff rendering in the UI: @codemirror/merge 6.12.2
The editor already uses CodeMirror 6, so render history diffs with @codemirror/merge@6.12.2 (MIT). Inline, Overleaf-like view: `new EditorView({ doc: newText, extensions: [basicSetup, latex(), EditorState.readOnly.of(true), unifiedMergeView({ original: oldText, mergeControls: false, highlightChanges: true, gutter: true, syntaxHighlightDeletions: true, collapseUnchanged: { margin: 3, minSize: 4 } })] })`. Side-by-side toggle: `new MergeView({ a: { doc: oldText, extensions: [...readOnly] }, b: { doc: newText, extensions: [...readOnly] }, parent, orientation: 'a-b', highlightChanges: true, gutter: true, collapseUnchanged: { margin: 3, minSize: 4 } })`. Other exports: getChunks(state), diff(a,b,config), presentableDiff. The config types are MergeConfig, DirectMergeConfig and UnifiedMergeConfig (checked in index.d.ts). diff2html@3.4.56 or react-diff-view@3.3.3 are fallbacks if you want to render raw unified patches instead.
Sources: npm view @codemirror/merge (6.12.2); dist/index.d.ts inspected locally

## [must] Restore file / restore whole project (forward-only, through live Yjs docs)
Never rewrite history (no reset or rebase). Restore always adds a new commit, like Overleaf.
Restore file (editor+): take the lock, snapshot with reason=pre-restore, then content = `git cat-file blob <sha>:<path>`. If a Y.Doc for that file is loaded, apply a minimal edit in `ydoc.transact(() => {...}, 'restore')` computed with diffChars (jsdiff) or fast-diff@1.3.0, so connected cursors survive. Otherwise write it atomically. Recreate the files row if the path had been deleted. Then snapshot with reason=restore and message `Restored <path> from <date> (<short sha>)`.
Restore project: target list = `git ls-tree -r -z --name-only <sha>`. Write every target file as above. Delete current files not in the target: destroy their Y.Docs and tell clients the file tree changed. Rebuild the files table, then commit. `git restore --source=<sha> --staged --worktree -- .` also works (tested: it removed a file absent in the source) but it bypasses live Yjs state, so use it only when no clients are connected. Downgrade: empty directories are not tracked by git and disappear on restore.
Sources: local test: git restore --source removed n.bib, https://docs.overleaf.com/writing-and-editing/history-and-versioning

## [should] Labels (named versions)
The source of truth is the SQLite labels table (free Unicode text, several labels per commit, as in Overleaf). Creating a label first snapshots so the label points at the latest state, then INSERT (id, project_id, commit_sha=HEAD, name, created_by). Editors and owners can add labels. The creator or the owner can delete them. Viewers cannot. Tags are optional: mirror a label as an annotated tag `refs/tags/olc/label-<id>` with `git tag -a olc/label-<id> -m <name> <sha>`, which needs GIT_COMMITTER_NAME/EMAIL or the repo user.* fallback (tested: without an identity it fails with 'Committer identity unknown'). Tags are not needed to protect commits from gc because history is never rewritten. List tags with `git for-each-ref --format='%(refname:short)%09%(*objectname)%09%(contents:subject)' refs/tags/olc`.
Sources: local test (annotated tag identity error), https://docs.overleaf.com/writing-and-editing/history-and-versioning.md

## [should] Download a past version = git archive (no zip library needed)
GET /api/projects/:pid/history/:sha/zip (viewer+, but not anonymous link viewers). Run `spawn('git', [...base, 'archive', '--format=zip', `--prefix=${safeName}/`, '--end-of-options', sha])`, pipe stdout to res, and set `res.attachment(`${safeName}-${sha.slice(0,7)}.zip`)` (Express builds RFC 6266 filename*). Tested: output is a valid zip with the commit id as the zip comment. On client abort, kill the child process.
Sources: local test: git archive --format=zip produced valid zip

## [should] Overleaf history UX to emulate
From the Overleaf docs, the parts worth copying:
- History is a separate mode reached by a History button above the PDF panel.
- The right-hand list has 'All history' and 'Labels' tabs. The newest entry is labelled 'Current state'.
- The per-version three-dot menu offers 'Label this version', 'Download this version' (zip) and 'Restore project to this version' (with a confirmation).
- Compare picks a range with 'compare from / compare up to' handles on version cards.
- The left file tree marks files as edited, added or deleted. Deleted files show with strikethrough and can be restored.
- The centre is a read-only document view with changes highlighted inline, coloured by author. 'Restore this version' is available per file.
- Free Overleaf plans limit history to 24 h plus labelled versions. We keep everything.
- Link-sharing viewers cannot see history.
With git snapshots, author colour works per commit: colour hunks by commit author when comparing adjacent versions, and use plain green/red for multi-version ranges. In the list, group by day and merge consecutive snapshots by the same author set within 1 h into one card that expands. Character-level authorship like Overleaf's (OT-level history) would need Yjs PermanentUserData or snapshots with gc:false. Leave that for later.
Sources: https://docs.overleaf.com/writing-and-editing/history-and-versioning.md, https://docs.overleaf.com/on-premises/user-and-project-management/roles-and-permissions

## [must] Password hashing with node:crypto scrypt (verified params + gotchas)
OWASP scrypt settings: N=2^17 (128 MiB), r=8, p=1, or the equal-cost N=2^16, r=8, p=2 (64 MiB). On Node 22.19 you MUST pass maxmem: without it even N=2^15, r=8 throws ERR_CRYPTO_INVALID_SCRYPT_PARAMS 'memory limit exceeded' (tested; the default cap is 32 MiB and 128*N*r must be below it). Timing here: N=2^17 about 197 ms, N=2^16/p=2 about 177 ms. Code:
const scryptAsync = promisify(crypto.scrypt) as (pw: string|Buffer, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const P = { N: 2**17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
hash: salt = randomBytes(16); dk = await scryptAsync(pw.normalize('NFKC'), salt, 32, P); store `$scrypt$ln=17,r=8,p=1$${salt.toString('base64url')}$${dk.toString('base64url')}`.
verify: parse the params, recompute, then `crypto.timingSafeEqual(dk, stored)`. Rehash on login if the params are outdated. If the email is not found, still run scrypt against a fixed dummy hash so response time doesn't reveal which accounts exist. Policy (NIST-style): at least 8 characters, at most 256, no composition rules. scrypt runs on the libuv threadpool (4 threads by default) at 128 MiB each, so cap concurrent hashes with a semaphore (for example 2) and rate-limit login. Node 22 has no crypto.argon2, so scrypt is the right built-in.
Sources: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html, https://nodejs.org/docs/latest-v22.x/api/crypto.html, local test sc.mjs / sc2.mjs

## [must] Sessions: opaque token + SQLite table (recommended over express-session)
On login: token = randomBytes(32).toString('base64url'). INSERT sessions(id_hash=sha256(token), user_id, created_at, expires_at=now+30d, last_seen_at). Rotate the token on every login and privilege change, and DELETE the row on logout. Lookup: `parseCookie(req.headers.cookie ?? '')[COOKIE]`, then sha256, then SELECT with a JOIN to users, WHERE expires_at > now AND users.disabled_at IS NULL. Sliding expiry: update last_seen_at/expires_at at most once an hour. Cleanup: `setInterval(() => db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now()), 3600_000).unref()`. No signing is needed because the random token is looked up server-side, and hashing it means a leaked DB doesn't leak live sessions. The WebSocket upgrade handler reuses the exact same lookup, which is awkward with express-session (you would have to run the middleware on the upgrade request). express-session@1.19.0 needs a store: MemoryStore is not for production, connect-sqlite3@0.9.18 uses the separate sqlite3 addon, and better-sqlite3-session-store@0.1.0 was last published in 2022. Admin 'log out everywhere' is DELETE FROM sessions WHERE user_id=?.
Sources: npm view express-session/connect-sqlite3/better-sqlite3-session-store

## [must] Cookie attributes and cookie@2 API change
Set with Express: `res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: IS_HTTPS, path: '/', maxAge: 30*24*3600*1000 })`. COOKIE='__Host-olc_sid' when served over HTTPS (the prefix requires Secure, Path=/ and no Domain), and 'olc_sid' in HTTP/dev. Use Lax, not Strict: with Strict, a user who clicks a share or invite link from email or chat arrives without the cookie and looks logged out. For parsing (REST and WS), cookie@2.0.1 is now ESM-only (engines node>=22, works via require(esm) on 22.19) and renamed its API: exports are parseCookie, parseSetCookie, stringifyCookie and stringifySetCookie. The old cookie.parse/serialize are gone (verified). cookie-parser@1.4.7 also works but isn't needed. Behind a reverse proxy: `app.set('trust proxy', 'loopback')` so req.secure and req.ip are correct.
Sources: local: node -e require('cookie') -> [parseCookie, parseSetCookie, stringifyCookie, stringifySetCookie], npm view cookie@2.0.1 engines type

## [must] CSRF for a same-origin SPA
Layered middleware on every non-GET/HEAD/OPTIONS request under /api:
1) `const sfs = req.get('sec-fetch-site'); if (sfs && sfs !== 'same-origin') return 403`.
2) `const o = req.get('origin'); if (o && !ALLOWED_ORIGINS.has(o)) return 403`. ALLOWED_ORIGINS = PUBLIC_ORIGIN plus http://localhost:5173 in dev. Vite's proxy does not rewrite Origin unless you enable rewriteWsOrigin or changeOrigin.
3) Require the custom header `X-OLC-CSRF: 1`. The SPA's fetch wrapper always sends it, and cross-origin pages can't add it without a CORS preflight, which we never allow (no CORS middleware at all).
4) Parse JSON only when `express.json({ limit: '2mb', type: 'application/json' })` matches, and return 415 otherwise.
Gotcha: browsers send Sec-Fetch-* only to potentially trustworthy origins (HTTPS or localhost). On a plain-HTTP LAN deploy (http://192.168.x.x) the header is missing, so checks 2 and 3 carry the protection. SameSite=Lax is defence in depth only: it is site-scoped, not origin-scoped. OWASP lists custom request headers as a suitable defence for AJAX/API endpoints, and Fetch Metadata as a lightweight defence that needs an Origin fallback. csrf-csrf@4.0.3 (signed double-submit) is optional and not needed with this setup. Multipart upload endpoints are the classic form-CSRF target and get the same guard.
Sources: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html

## [should] Login/signup rate limiting
express-rate-limit@8.7.0 (peer express >=4.11). The in-memory store is fine on a single node. `rateLimit({ windowMs: 15*60*1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, ipv6Subnet: 56, keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${String(req.body?.email).toLowerCase()}` })` on POST /api/auth/login, plus a looser per-IP limiter on /api/auth/*. If a custom keyGenerator uses req.ip, wrap it with ipKeyGenerator (v8 warns about IPv6 bypass). Bootstrap: the first registered user becomes admin. After that, ALLOW_SIGNUP=false by default and the admin creates accounts or issues invite links.
Sources: express-rate-limit@8.7.0 readme (local)

## [must] Roles and permission matrix (enforced identically on REST and WS)
resolveRole(pid, principal): 'owner' if projects.owner_id === userId. Otherwise the project_members.role. Otherwise, for an anonymous session, sessions.anon_grants[pid] is re-checked against share_links, requiring revoked_at IS NULL and role='viewer'. Otherwise null. Deleted projects resolve to null. RANK = { viewer: 1, editor: 2, owner: 3 }. Middleware `requireRole(min)` returns 404 (not 403) when role is null, so project ids can't be probed. Matrix, adapted from Overleaf's roles doc:
- viewer: read files, view and download the PDF, download the zip, view history (named viewers only; anonymous link viewers get no history, as on Overleaf), and compile (it doesn't mutate sources; rate-limit it and disallow it for anonymous viewers).
- editor: everything a viewer can do, plus edit docs, upload/create/rename/move/delete files, restore file or project, add labels, change the root doc and compiler.
- owner: everything an editor can do, plus share settings (invite, remove, change roles, enable/regenerate/revoke links), rename, delete, transfer ownership, and delete any label.
The 'reviewer' role (tracked changes) is left out for v1. Validate bodies with zod@4.6.5.
Sources: https://docs.overleaf.com/on-premises/user-and-project-management/roles-and-permissions

## [must] Share links (Overleaf-style view/edit links), design
How Overleaf does it, as design reference only (no code copied): the read-only token is 12 consonant letters at /read/<token>; the read-write token is a 10-digit numeric prefix plus 12 letters at /<token>, looked up by prefix and then compared with a timing-safe check. An anonymous view grant is stored in the session. Edit links require an account. The project must be in 'tokenBased' access mode.
Our version:
- Tokens are randomBytes(16).toString('base64url') (128-bit). share_links keeps a row per role with `token` (so the owner can copy the link again) and a UNIQUE token_hash = sha256(token) for lookup.
- URLs are /join/v/<token> and /join/e/<token>. Both are SPA routes that show an interstitial 'Join <project> as viewer/editor' page (Overleaf also asks for confirmation) and then POST /api/share/accept {token}. Visiting the link alone never changes state.
- Logged in: upsert project_members(role, source='link'). Never downgrade an existing higher role.
- Anonymous: view links only. Create an anonymous session whose anon_grants holds {pid: tokenHashHex}. Edit links require login or signup first, then return to the link.
- After accepting, redirect to /project/<pid> so the token leaves the address bar and history. Helmet's default Referrer-Policy no-referrer also stops leaks through the Referer header.
- Revoke or regenerate: set revoked_at or replace the token, DELETE members WHERE source='link' if the owner chooses 'remove people who joined via link', and close their live sockets.
- Rate-limit /api/share/accept by IP.
Sources: https://raw.githubusercontent.com/overleaf/overleaf/main/services/web/app/src/Features/TokenGenerator/TokenGenerator.mjs (read for design only), https://raw.githubusercontent.com/overleaf/overleaf/main/services/web/app/src/Features/TokenAccess/TokenAccessHandler.mjs (read for design only), https://docs.overleaf.com/collaborating/sharing-a-project

## [must] WebSocket auth and read-only enforcement (ws 8.21.3 noServer)
const wss = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
server.on('upgrade', (req, socket, head) => { socket.on('error', noop); const url = new URL(req.url!, 'http://x'); const m = url.pathname.match(/^\/ws\/projects\/([0-9a-f]{24})$/); if (!m || !ALLOWED_ORIGINS.has(req.headers.origin ?? '')) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return socket.destroy(); } const principal = sessionFromCookie(req.headers.cookie); const role = principal && resolveRole(m[1], principal); if (!role) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return socket.destroy(); } wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req, { pid: m[1], principal, role })); });
The Origin check is mandatory: browsers don't apply CORS to WebSockets (cross-site WebSocket hijacking). @y/websocket-server@0.1.5 (setupWSConnection) has no auth or read-only mode, so write a small server on y-protocols@1.0.7. For read-only clients, decode messageSync (0), read the sub-type, and answer messageYjsSyncStep1 (0) normally, but DROP messageYjsSyncStep2 (1) and messageYjsUpdate (2). Awareness (1) is allowed so viewers' cursors still show. Keep Map<pid, Set<ws>>. When a role changes or a link is revoked, re-resolve the role per socket: close with code 4403 if access is lost, or send {type:'role', role:'viewer'} and flip ws.role on a downgrade. Heartbeat ping every 30 s and terminate sockets that don't respond.
Sources: ws@8.21.3 README 'Client authentication' (local), y-protocols@1.0.7 sync.js exports (local), @y/websocket-server@0.1.5 src/utils.js (local)

## [must] Zip import with yauzl 3.4.0 (verified behaviours)
yauzl@3.4.0 (MIT, 1 dependency 'pend') plus @types/yauzl@3.4.0, which includes openPromise, eachEntry and openReadStreamPromise. Tested with crafted zips: '../../evil.txt' makes the whole archive throw 'invalid relative path'. With strictFileNames:true, 'a\\b.tex' throws 'invalid characters'. With the default strictFileNames:false, backslashes become '/' (better for Windows zips) and are still validated. Symlink entries are NOT rejected but are detectable with `((e.externalFileAttributes >>> 16) & 0o170000) === 0o120000`, so skip them. Flow:
const zip = await yauzl.openPromise(tmpPath, { validateEntrySizes: true, decodeStrings: true, strictFileNames: false, autoClose: false });
if (zip.entryCount > 2000) reject;
const entries = []; for await (const e of zip.eachEntry()) entries.push(e);
Then validate all entries before writing anything: skip directory entries (name ends with '/'), symlinks, and ignored names. Reject encrypted entries (e.isEncrypted()) and those where !e.canDecodeFileData() (only stored/deflate are supported). Run toProjectPath() on each name. Enforce e.uncompressedSize <= 50 MB, sum <= 300 MB, and a ratio check: reject if uncompressedSize > 1 MB && uncompressedSize/compressedSize > 200. Duplicate or case-conflicting names mean reject.
Extract into DATA_DIR/tmp/import-<rand>/: `await pipeline(await zip.openReadStreamPromise(e), byteCounter(limit), fs.createWriteStream(dest, { flags: 'wx', mode: 0o644 }))`, then zip.close(). Finally rename the staging dir to projects/<newPid>, git init, commit with reason=import, and insert the files rows.
The declared sizes can be trusted because yauzl errors if the inflated stream is longer or shorter than uncompressedSize. A 200 MB bomb compressed to 204 KB showed unc=209715200, so it is rejected before inflating. Always rm -rf the staging dir in finally.
Sources: yauzl@3.4.0 README (local), local test yz.mjs with evil.zip/slip.zip/bs.zip/bomb.zip

## [should] Import heuristics (root-folder strip, ignore list, main document)
- If every entry shares one top-level folder (common for GitHub zips and hand-zipped folders), strip it. Overleaf's own exports put files at the root.
- Skip these: /(^|\/)(__MACOSX|\.git|\.svn|\.hg|\.DS_Store|Thumbs\.db|desktop\.ini)(\/|$)/ and /\.(aux|log|toc|lof|lot|out|fls|fdb_latexmk|synctex(\.gz)?|xdv|dvi|blg|nav|snm|vrb|bcf|run\.xml)$/i. Keep .bbl, because arXiv/journal bundles may need it.
- Skip a PDF whose basename equals a .tex basename in the same directory: it's a stale build. For the user's antiddos_v2_submission.zip this drops antiddos_v2.pdf and antiddos_v2_supplementary.pdf but keeps the figure PNGs.
- Choosing the root doc: main.tex if present. Otherwise root-level .tex files matching /^[^%\n]*\\documentclass\s*(\[[^\]]*\])?\s*\{[^}]+\}/m that also contain \begin{document}. Prefer the shallowest path, then the name. Let the user change it later: the user's bundle has two root documents (main and supplementary, linked via xr).
- Defaults are the same limits as Overleaf: 2000 entities, 50 MB upload, 2 MB per editable doc.
Sources: https://raw.githubusercontent.com/overleaf/overleaf/main/services/web/config/settings.defaults.js, local: unzip -l of <paper directory>/antiddos_v2_submission.zip

## [must] Zip export: yazl 3.3.1 (recommended) vs archiver 8.0.0
yazl@3.3.1 (MIT, only dependency buffer-crc32, same author as yauzl) plus @types/yazl@3.3.1. For a current-state download: take the lock, flushDocs(pid), then `const zip = new yazl.ZipFile(); for (const f of files) zip.addFile(abs, f.path, { mtime, mode: 0o100644, compress: !/\.(png|jpe?g|pdf|gz|zip)$/i.test(f.path) }); zip.end(); res.attachment(`${safeName}.zip`); zip.outputStream.pipe(res);`. Since 3.3.0 it writes the Info-ZIP UT timestamp field (forceDosTimestamp:false). archiver@8.0.0 (2026-05-08) is ESM-only ('type':'module') with a NEW class API, `import { ZipArchive } from 'archiver'; new ZipArchive({ zlib: { level: 9 } })`, and 9 dependencies (async, readable-stream, zip-stream, tar-stream, readdir-glob, ...). Many archiver tutorials no longer apply. Reject adm-zip@0.6.1: it loads the whole archive in memory and had the historic zip-slip CVE-2018-1002204. Reject unzipper@0.12.5: it stream-parses local headers, which yauzl's README explains is unreliable versus the central directory, and it had the historic zip-slip CVE-2018-1002203.
Sources: yazl@3.3.1 README (local), archiver@8.0.0 README + index.js (local), npm view archiver@8.0.0 dependencies

## [must] Multipart uploads: multer 2.4.0 settings
multer@2.4.0 (2026-09-14) is the only acceptable version: the 2.x line fixed many CVEs through 2025–26 (CVE-2025-47935/47944/48997/7338, CVE-2026-2359/3304/3520/5038/5079 and more), so keep it updated. It still sits on busboy@1.6.0. Use @types/multer@2.2.0.
const upload = multer({ storage: multer.diskStorage({ destination: path.join(DATA_DIR,'uploads-tmp'), filename: (_req, _f, cb) => cb(null, randomUUID()) }), defParamCharset: 'utf8', preservePath: true, limits: { fileSize: 50*1024*1024, files: 50, fields: 20, fieldSize: 64*1024, parts: 80, fieldNameSize: 100 } });
defParamCharset defaults to 'latin1', which garbles non-ASCII filenames, so set 'utf8'. For folder drag-and-drop, the client calls `formData.append('files', file, file.webkitRelativePath || file.name)`. With preservePath:true the server receives the relative path in originalname, which is untrusted: run it through toProjectPath(). Route: `router.post('/api/projects/:pid/upload', csrfGuard, requireRole('editor'), upload.array('files', 50), handler)`. The zip import uses upload.single('zip'), then checks the magic bytes 'PK\x03\x04' and hands the temp path to yauzl. Map MulterError codes (LIMIT_FILE_SIZE and so on) to 413/400 in the error handler. Unlink temp files in finally.
Sources: https://github.com/expressjs/multer/blob/main/CHANGELOG.md, multer@2.4.0 README (local)

## [must] Serving user-uploaded files safely (stored XSS)
Project files (and history blobs) are attacker-controlled. An uploaded .svg or .html served inline from the app origin would run script with the victim's session. Serve through a handler that sets: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`. For anything outside {png,jpg,jpeg,gif,webp,pdf} also set `Content-Disposition: attachment` (res.attachment(basename)). Set the content type from an allowlist map, never from the upload. Previewing SVG in the file view: render it via <img src> (scripts don't run in img context) or rasterize it. Express's res.sendFile uses dotfiles:'ignore' by default, so explicit fs streams with the O_NOFOLLOW open are easier.

## [must] Express 5.2.1 vs Fastify 5.12.5: choose Express 5
Recommend express@5.2.1 (MIT, node>=18) with @types/express@5.0.6. HTTP throughput is not the bottleneck here; compiles and WebSockets are. Express 5 now forwards rejected promises from async handlers to error middleware, so no asyncHandler wrapper is needed. multer and helmet are native Express middleware. ws attaches to the http.Server the same way in both frameworks. Express 5 details to know:
- Wildcards must be named: '/*splat', or '/{*splat}' to also match '/'. Wildcard params come back as arrays (tested).
- Optional segments use braces, '/:file{.:ext}'. No regex characters in paths.
- req.body is undefined unless a body parser ran.
- express.static has dotfiles:'ignore' by default.
- The query parser defaults to 'simple'.
- app.listen passes errors to its callback.
- res.status() validates codes.
- 5.2.0 security bump (body-parser 2.2.1); 5.2.1 reverted an erroneous extended-query-parser change.
Fastify 5.12.5 (with @fastify/websocket 11.3.1, @fastify/multipart 10.1.1, @fastify/static 10.1.4, @fastify/cookie 11.1.2) is a fine alternative with JSON-schema validation and encapsulated plugins. It would only win if you want schema-driven typed routes. With zod@4.6.5 on Express, that matters little.
Sources: https://expressjs.com/en/guide/migrating-5.html, https://github.com/expressjs/express/releases, npm view express/fastify/@fastify/* versions

## [must] Serving the Vite-built SPA + dev proxy (Vite 8.3.0)
Production (single port):
const dist = path.resolve(import.meta.dirname, '../../web/dist');
app.use('/assets', express.static(path.join(dist,'assets'), { immutable: true, maxAge: '1y', index: false, fallthrough: false }));
app.use(express.static(dist, { index: false }));
app.get('/{*splat}', (req, res, next) => { if (req.path.startsWith('/api/') || req.path.startsWith('/ws/')) return next(); res.set('Cache-Control','no-cache'); res.sendFile(path.join(dist,'index.html')); });
Register the SPA fallback after all /api routes and before the error handler. The fallback was tested on Express 5 and returns index.html for '/' and '/project/xyz'.
Dev: vite@8.3.0 (Rolldown-based; engines ^20.19 || >=22.12; server.proxy uses http-proxy-3) with @vitejs/plugin-react@6.1.1. In vite.config.ts: `server: { port: 5173, strictPort: true, proxy: { '/api': { target: 'http://127.0.0.1:3000' }, '/ws': { target: 'ws://127.0.0.1:3000', ws: true } } }`. Don't set rewriteWsOrigin, and don't set allowedHosts: true (DNS rebinding). Cookies set by the backend through the proxy land on localhost:5173 because they have no Domain attribute. Add http://localhost:5173 to ALLOWED_ORIGINS in dev only. Backend dev loop: Node 22.19 strips TypeScript types natively (running a .ts file worked here without flags), or use tsx@4.23.15. Pin @types/node@22.20.4 to the runtime (npm latest is 26.x). TypeScript latest is 7.0.2 (the native compiler).
Sources: https://vite.dev/config/server-options, npm view vite@8.3.0 engines, local test node t.ts on v22.19.0

## [should] helmet 8.3.0 defaults that break this app
Verified default headers from helmet(): CSP default-src 'self'; img-src 'self' data:; script-src 'self'; style-src 'self' https: 'unsafe-inline'; upgrade-insecure-requests. It also sets Strict-Transport-Security max-age=31536000; includeSubDomains, COOP same-origin, CORP same-origin, and Referrer-Policy no-referrer. Adjust:
- On plain-HTTP deploys, set directives.upgradeInsecureRequests: null and strictTransportSecurity: false. Otherwise the browser upgrades subresources to https and they fail.
- img-src must add blob: (pdf.js and image previews).
- worker-src must be 'self' blob: (pdf.js worker).
- connect-src must be 'self' plus ws:/wss: for your host.
- script-src needs 'wasm-unsafe-eval' if pdf.js (pdfjs-dist@6.3.289 ships wasm/ decoders) loads its wasm.
- CodeMirror 6 injects <style> elements: keep 'unsafe-inline' for styles or use a nonce with EditorView.cspNonce.
Keep Referrer-Policy no-referrer: it protects share-link tokens.
Sources: local test: printed helmet@8.3.0 default headers, npm view pdfjs-dist version + tarball listing

## [must] LaTeX sandbox: exact docker run arguments (tested on TL2026 image)
spawn('docker', args, { stdio: ['ignore','pipe','pipe'] }) with no shell:
const name = `olc-build-${buildId}`;
const args = ['run','--rm','--init','--name',name,
 '--network','none','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,noexec,size=256m',
 '--user',`${process.getuid()}:${process.getgid()}`,'--cap-drop','ALL','--security-opt','no-new-privileges',
 '--pids-limit','256','--memory','2g','--memory-swap','2g','--cpus','2',
 '--ulimit','fsize=536870912','--ulimit','nofile=1024:1024','--ulimit','core=0',
 '--log-driver','none','--hostname','latex',
 '-e','HOME=/tmp','-e','TEXMFVAR=/tmp/texmf-var','-e','shell_escape=f','-e','openout_any=p','-e','max_print_line=10000',
 '-v',`${compileSrc}:/project:ro`,'-v',`${compileOut}:/out:rw`,'-w','/project',
 IMAGE,
 'timeout','--signal=KILL',String(limitSec),
 'latexmk','-norc', engineFlag /* '-pdf' | '-xelatex' | '-lualatex' */, '-interaction=nonstopmode','-file-line-error','-synctex=1','-f' /* omit for 'stop on first error' */, '-latexoption=-no-shell-escape','-outdir=/out', `./${rootDocPath}`];
This compiled the user's MDPI paper (antiddos_v2.tex, XeLaTeX, TikZ/pgfplots) in about 10.1 s with PDF and synctex.gz. A LuaLaTeX fontspec document with a cold TEXMFVAR took about 4.5 s, because the image already ships the luaotfload names cache in TEXMFSYSVAR and a fontconfig cache. --log-driver none still streams output to the attached CLI (tested). Enforce the timeout from Node as well: `setTimeout(() => execFile('docker',['kill',name]), limitMs)`. Killing the docker CLI process does NOT stop the container. Also run `docker rm -f` for leftover olc-build-* containers at startup. Use a global compile queue with concurrency of about min(8, cores/4). Pin the image by digest (local: texlive/texlive@sha256:ee8ecc627897eabeb42d862d8187546483455e66ce94aa5c2bce1b45a977ab27). Never mount the Docker socket or any other project into the container. The app itself holds Docker access (root-equivalent), so validate every value that reaches args: engine from an enum, rootDocPath via toProjectPath plus a /\.tex$/ check, and the ./ prefix so it can never start with '-'.
Sources: local docker tests in scratch/paper and scratch/lua, docker image inspect texlive/texlive:latest

## [must] TeX Live 2026: openin_any is a NO-OP (reads are not restricted)
The texmf.cnf shipped in the image (line ~705) says: 'as of 2026, openin_any no longer has any effect; the underlying kpse_in_name_ok and related functions always return true' (thread tug.org/pipermail/tex-live/2025-December/051965.html). Tested: with openin_any=p set via env (kpsewhich confirms 'p'), a document still read /etc/passwd, ../../../../etc/hostname, a dotfile, and \IfFileExists{/etc/passwd}. So a document can read ANY file visible inside the container, and the container filesystem is the only read boundary. Mount only this project's source snapshot and its out dir. Documents can read the TeX Live tree and the image's own /etc, which is harmless. Do not rely on openin_any in docs or tests. openout_any=p (the image default) is still enforced: `\openout` to /tmp/evil.txt gave '! I can't write on file' (tested). So writes are confined to the working/output directory tree. Default shell_escape in the image is 'p' (restricted list: bibtex, extractbb, kpsewhich, makeindex, repstopdf, latexminted, memoize-extract, ...). With -no-shell-escape the log shows 'runsystem(...)...disabled.' (tested).
Sources: texmf.cnf in texlive/texlive:latest (TeX Live 2026), sed -n 630,720p, local test scratch/tex/read.tex

## [must] Secrets must never be in the compile container env (/proc/self/environ is readable)
Tested: `\openin\f=/proc/self/environ` inside the container read the environment. A test variable passed with -e showed up in the .log and could be typeset into the PDF, where any viewer of the project can see it. Pass only HOME, TEXMFVAR, shell_escape, openout_any, max_print_line and optionally SOURCE_DATE_EPOCH. Never pass DB paths, session secrets or API keys, and never inherit process.env. docker run does not inherit the host env unless you use -e VAR without a value or --env-file, so audit args for that.
Sources: local test scratch/tex/env.tex

## [must] latexmk must run with -norc (project latexmkrc = arbitrary Perl)
Tested with latexmk 4.88: a project-root `latexmkrc` containing `system("id > rc_pwned.txt")` ran (uid=1000(texlive)) even with -latexoption=-no-shell-escape. With `-norc` it did not run. -norc skips the system, user and project rc files. If you need defaults, pass them as CLI flags or use `-r /etc/olc/latexmkrc` baked into a derived image (read-only). Overleaf supports a user latexmkrc because it treats the container as the trust boundary. If you want that feature later, it's only acceptable because of the network-none, read-only, cap-drop container. Also never pass user text to latexmk's `-e <perl>`.
Sources: local test scratch/paper/rc

## [must] GNU timeout as PID 1 fails silently: use --init
Tested: `docker run --rm texlive/texlive:latest timeout 5 echo hi` exits 125 with no output (and so does --foreground). The same command succeeds under `sh -c` or with `docker run --init` (tini as PID 1). --init also reaps zombie processes from latexmk/bibtex/gs. Treat exit 137 (SIGKILL from timeout or docker kill) as 'timed out' and exit 125 as a docker or setup error, and report both separately in the UI.
Sources: local docker tests

## [must] Compile directory model: read-only source snapshot + writable outdir
Before each compile, inside the project lock: flushDocs, then snapshot, then sync projects/<pid> into compiles/<pid>/src. Copy only files whose size or mtime changed and delete removed ones (like Overleaf's CLSI resource sync). On btrfs/xfs, fs.promises.copyFile(src, dst, fs.constants.COPYFILE_FICLONE) reflinks. Then mount src :ro and out :rw. Benefits: the compile sees a consistent snapshot even while people keep typing, TeX can never modify canonical sources, and aux files persist in out/ for incremental builds. Tested: a read-only source mount with `latexmk -outdir=/out` works, including \include{chap/c1`}, because latexmk 4.88 created /out/chap/c1.aux itself. Files written with \openout (filecontents etc.) go to /out and are found again because TeX searches the output directory first. After the run, copy output.pdf/.log/.synctex.gz/.blg to output/<pid>/<buildId>/ only if fs.lstat(p).isFile(), and serve PDFs with Content-Type application/pdf and Range support (res.sendFile handles ranges). SyncTeX paths inside the file start with /project/, so strip that prefix to map back to project paths. The user's paper references antiddos_v2_supplementary.aux via xr. Two root docs in one project need their own jobnames, or both built into the same out dir, for cross-references to resolve.
Sources: local test scratch/paper (out2/chap/c1.aux created), https://raw.githubusercontent.com/overleaf/overleaf/main/services/web/config/settings.defaults.js

## [should] Shell-escape policy options and the EPS caveat
Default: fully off (-no-shell-escape plus env shell_escape=f). Offer a per-project 'restricted' option (-shell-restricted, TeX Live's own default list) and never offer full -shell-escape. Caveat: pdfLaTeX turns .eps into PDF through epstopdf via restricted \write18 (repstopdf). With shell escape fully off, \includegraphics{x.eps} under pdflatex fails unless an x-eps-converted-to.pdf already exists. XeLaTeX handles EPS through xdvipdfmx/Ghostscript (rungs), not \write18, so the user's XeLaTeX paper with Definitions/logo-mdpi.eps compiled fine with shell escape off (tested). minted and pgfplots externalization need full shell escape and are unsupported by design. Set the compile time limit to 180 s (Overleaf CE's default) and let admins configure it.
Sources: texmf.cnf shell_escape_commands in TL2026 image, local compile of antiddos_v2.tex

## [nice] Log parsing helper: max_print_line via env
kpathsea reads texmf.cnf variables from the environment. `-e max_print_line=10000` stopped TeX from wrapping log lines at 79 columns (longest line 176 characters vs 96 by default, tested), which makes file:line:error parsing (-file-line-error) and warning regexes reliable. You can also set error_line=254 and half_error_line=238.
Sources: local test scratch/lua

## [must] Git hardening against user-controlled content
Users can't reach git config because the git dir sits outside the work tree and zip, upload and path rules reserve .git*. Keep that invariant: it is what blocks core.fsmonitor/hooks code execution. Add -c core.hooksPath=/dev/null and -c core.fsmonitor=false on every call anyway, and --no-ext-diff --no-textconv on diff commands. Use `git add --all --force -- .` so a stray ignore rule can never drop files from history. Never run git clone, fetch or push on user-supplied URLs; if you add Git import later, restrict protocol with -c protocol.allow=never -c protocol.https.allow=always. Build git history paths only with toProjectPath and pass them after '--'.
Sources: local tests in scratch/gt

## [nice] Soft delete, quotas, backups, shutdown
- Project delete: set projects.deleted_at, move projects/<pid> and history/<pid>.git into trash/, and purge after 30 days.
- Quotas (Overleaf-like): max 2000 files per project, 50 MB per upload, 2 MB per editable doc, and a configurable per-project total (for example 1 GB counting history).
- SIGTERM: stop accepting connections, close sockets with 1001, flush all Y.Docs, snapshot dirty projects, db.close().
- Nightly: db.backup(), `git gc --quiet` on repos with more than 200 new commits, and a sweep of stale uploads-tmp/tmp entries and old output builds.

## Packages
- express@5.2.1 (MIT) — HTTP server/router (async error propagation, named wildcards) @types/express@5.0.6; wildcard params are arrays; SPA fallback '/{*splat}'
- ws@8.21.3 (MIT) — WebSocket server (noServer + upgrade auth) for Yjs sync @types/ws@8.18.1; set maxPayload; check Origin on upgrade
- better-sqlite3@13.0.3 (MIT) — Metadata DB (users, sessions, projects, members, share links, files, labels) Node-API, prebuilt binaries bundled in tarball (no node-gyp), engines node>=22, SQLite 3.53.4; types via @types/better-sqlite3@9.6.0
- yauzl@3.4.0 (MIT) — Safe zip import (central-directory based, validateFileName, size validation, promise/async-iterator API) @types/yauzl@3.4.0 covers openPromise/eachEntry/openReadStreamPromise
- yazl@3.3.1 (MIT) — Streaming zip export of current project state @types/yazl@3.3.1; only dep buffer-crc32; historical versions via `git archive` instead
- multer@2.4.0 (MIT) — Multipart file/zip uploads to disk temp @types/multer@2.2.0; set defParamCharset:'utf8', preservePath:true, strict limits; many 2025-26 CVEs fixed, so keep it on the latest version
- diff@9.0.0 (BSD-3-Clause) — Server-side text diffs (structuredPatch/createTwoFilesPatch/diffChars for Yjs restore) Ships own types; do NOT add @types/diff; dual ESM/CJS
- @codemirror/merge@6.12.2 (MIT) — History diff UI (unifiedMergeView inline / MergeView side-by-side) Read-only config, collapseUnchanged
- cookie@2.0.1 (MIT) — Parse Cookie header in REST + WS upgrade ESM-only, node>=22; API renamed to parseCookie/stringifySetCookie
- helmet@8.3.0 (MIT) — Security headers/CSP Disable upgradeInsecureRequests/HSTS on HTTP deploys; add blob:/wasm-unsafe-eval for pdf.js
- express-rate-limit@8.7.0 (MIT) — Login/share-accept rate limiting Use ipKeyGenerator in custom keyGenerator; standardHeaders 'draft-8'
- zod@4.6.5 (MIT) — Request body/param validation 
- yjs@13.6.32 (MIT) — CRDT docs (restore applies edits via transact) 
- y-protocols@1.0.7 (MIT) — Custom sync server with read-only enforcement (drop syncStep2/update from viewers) @y/websocket-server@0.1.5 lacks auth/read-only
- vite@8.3.0 (MIT) — Frontend build + dev proxy (/api, /ws with ws:true) engines ^20.19||>=22.12; proxy via http-proxy-3; plugin-react 6.1.1
- git (system CLI)@2.34.1 local (>=2.24 for --end-of-options, >=2.23 for restore) (GPL-2.0 (external binary, invoked via execFile)) — Per-project history: snapshots, log, diff, cat-file, restore, archive, gc Preferred over isomorphic-git@1.42.2 (no diff/archive/gc) and simple-git@3.36.0
- texlive/texlive (Docker image)@latest = TeX Live 2026, latexmk 4.88, sha256:ee8ecc627897eabeb42d862d8187546483455e66ce94aa5c2bce1b45a977ab27 (various free licenses) — Sandboxed compile Runs as root by default: pass --user; uid 1000 'texlive' exists; openin_any is a no-op in 2026
- fastify@5.12.5 (MIT) — Alternative server framework (not recommended for this project) @fastify/websocket 11.3.1, @fastify/multipart 10.1.1, @fastify/static 10.1.4
- archiver@8.0.0 (MIT) — Alternative zip writer (not recommended) ESM-only, new `new ZipArchive()` API, 9 deps

## Risks
- TeX Live 2026 made openin_any a no-op, so documents can read every file visible inside the container, /proc/self/environ included (verified). Anything sensitive that gets mounted or passed in the env leaks into logs and PDFs that link viewers can see.
- A project latexmkrc executes arbitrary Perl unless -norc is used (verified). Leaving it out makes -no-shell-escape pointless.
- GNU timeout as container PID 1 exits 125 silently (verified); use --init. Killing the docker CLI does not stop the container, so call docker kill <name>, or runaway compiles keep running.
- Express 5 wildcard params are arrays of decoded segments, and %2F becomes '../x' inside one segment (verified). Any naive path join is directory traversal.
- Uploaded .svg/.html served inline from the app origin is stored XSS. Force sandbox CSP, nosniff, and attachment for non-image types.
- Sec-Fetch-Site is not sent over plain-HTTP LAN origins, so CSRF protection there depends on the Origin check and the custom header. Helmet's default upgrade-insecure-requests plus HSTS breaks plain-HTTP deployments.
- The history repo must live outside the working tree, and .git* names must be reserved. Otherwise a crafted zip could plant git config (core.fsmonitor/hooks gives code execution on the host when git runs) or .gitignore rules that silently drop files from history.
- Restoring by writing files directly while Y.Docs are live gets overwritten by the next flush. Restores must go through Y.Doc transactions.
- scrypt with OWASP parameters uses 64-128 MiB per hash on the libuv threadpool. Without maxmem it throws (verified), and without a concurrency cap plus rate limiting, a login flood can exhaust memory.
- isomorphic-git cannot gc: 200 snapshots made 21 MB of loose objects versus 2.3 MB after git gc (measured). Use the CLI and schedule gc.
- The Node app needs Docker socket access, which is root-equivalent on the host. Every value reaching docker args must come from an enum or a validated path, and the app should run as a dedicated user. Consider rootless Docker or gVisor (--runtime=runsc) for stronger isolation.
- multer has had many CVEs in 2025-2026. Pin the latest (2.4.0) and keep it patched. cookie@2 and archiver@8 are ESM-only with renamed APIs, so older tutorials will mislead.
- node:sqlite on Node 22 is still experimental (Stability 1.1, prints a runtime warning). Relying on it risks API churn before Node 22 EOL.
- With shell escape off, pdfLaTeX projects that \includegraphics .eps files fail unless converted PDFs exist. XeLaTeX is unaffected (verified on the user's MDPI paper).
