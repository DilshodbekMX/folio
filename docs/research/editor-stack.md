# AREA: Frontend editor stack: CodeMirror 6 + LaTeX + Yjs real-time collaboration (React/Vite)

Versions were checked against the npm registry on 2026-09-21, and the stack was built and tested in the scratchpad (<scratch>). The test ran a Vite 8 + React 19.3 app using CodeMirror 6, codemirror-lang-latex, y-codemirror.next and y-websocket 3.1, against a custom Node ws server. Playwright/Chromium drove two browsers editing the same file. Confirmed: text syncs both ways, remote carets show the collaborator's name, Ctrl-Z undoes only your own edits, and read-only viewers cannot edit. Also confirmed: \ref, \cite and \includegraphics completions, a \begin{env} auto-close that does not add a stray brace, folding in both language modes, Vim 'u' undo, debounced write-back to the .tex file, and reloading from disk after an outside edit. The user's real paper (antiddos_v2.tex, 203 KB) renders in about 170 ms and each keystroke lands within one frame. Recommended stack: plain CodeMirror 6 (not @uiw/react-codemirror), without basicSetup/history(), because Yjs's Y.UndoManager handles undo. yjs 13.6.32 + y-codemirror.next 0.3.6 + y-websocket 3.1.0 on the client. A small server of our own on y-protocols 1.0.7 + lib0 + ws 8.21.3, not @y/websocket-server: 0.1.5 needs the yjs 14 prerelease, and 0.1.1 has load/unload race conditions. Use TypeScript ~6.0.3, not 7.0.2: typescript-eslint requires <6.1, and TS 7 has no programmatic API until 7.1.

Most important finding: if the server builds a fresh Y.Doc from the .tex file after a restart, clients that are still connected merge their old copy into it and the whole document is duplicated — and the duplicate gets written to disk. This was reproduced. Fix: store the Yjs binary state in a sidecar file next to each .tex, load it first, then reconcile with the file on disk using a prefix/suffix diff. Verified: no duplication, and edits made outside the editor are picked up. Make every server-side text change the same way (git restore, upload, file-watcher event), as a diff on the live Y.Text; never swap the Y.Doc.

LaTeX language support: codemirror-lang-latex 0.6.1 is the most complete option (Lezer grammar, folding, tooltips, linter, command data), but it is AGPL-3.0-or-later since 0.5.0. Versions 0.4.x were labelled MIT yet say they are "based on the Overleaf LaTeX grammar", so their MIT label is doubtful. The MIT alternative is @codemirror/legacy-modes 6.5.4 stex through StreamLanguage, plus our own completions, folding and auto-close (tested, and they work with either mode). If codemirror-lang-latex is used, it needs these settings: latex({enableAutocomplete:false, autoCloseTags:false, autoCloseBrackets:false, linter:{…noisy checks off}}). Otherwise it installs autocompletion({override}), which hides our completion sources and throws "Config merge conflict for field override" alongside our own autocompletion(). Its auto-close also leaves a stray '}' next to closeBrackets (reproduced). Its linter gave 93 wrong or noisy diagnostics on the real paper (labels in other files, packages loaded by the MDPI class, \bf, macros whose argument spans blank lines).

## [must] Pinned versions to use (verified with npm view on 2026-09-21)
dependencies: codemirror@6.0.2 (meta package, only needed if you import basicSetup/EditorView from it; recommended to import from @codemirror/* directly), @codemirror/state@6.7.5, @codemirror/view@6.43.12, @codemirror/commands@6.11.1, @codemirror/language@6.12.4, @codemirror/search@6.7.2, @codemirror/autocomplete@6.20.3, @codemirror/lint@6.9.7, @codemirror/theme-one-dark@6.1.3, @codemirror/legacy-modes@6.5.4, @lezer/common@1.5.2, @lezer/highlight@1.2.3, @lezer/lr@1.4.10, (optional AGPL) codemirror-lang-latex@0.6.1, @replit/codemirror-vim@6.4.0 (now depends on @replit/codemirror-vim-core@0.1.0), @replit/codemirror-emacs@6.1.0, yjs@13.6.32, y-codemirror.next@0.3.6, y-websocket@3.1.0, y-protocols@1.0.7, lib0@0.2.117, react@19.3.0 + react-dom@19.3.0 (released 2026-09-09; 19.2.8 also fine; create-vite template uses ^19.2.8). devDependencies: vite@8.3.0, @vitejs/plugin-react@6.1.1 (peer vite ^8, engines node ^20.19||>=22.12 → OK on 22.19), typescript@~6.0.3, @types/react@19.3.0, @types/react-dom@19.3.0 (or 19.2.18/19.2.7 with React 19.2), @types/node@^22.20.4 (match Node 22 runtime). Server: ws@8.21.3, @types/ws@8.18.1, tsx@4.23.15. Verified `npm ls @codemirror/state @codemirror/view @lezer/common yjs` shows a single deduped copy with this set. Tested tsc -p (TS 6.0.3) + vite build OK with both React 19.2.8 and 19.3.0.
Sources: npm view (registry) 2026-09-21, create-vite@9.2.1 template-react-ts/package.json

## [must] TypeScript: use 6.0.x, not 7.0.2
typescript `latest` is 7.0.2 (Go-native compiler, released 2026-07-08). It ships without a stable programmatic API (planned for 7.1), so typescript-eslint (8.70.0 peer: typescript >=4.8.4 <6.1.0) and other tools built on the TS API break. create-vite 9.2.1's react-ts template pins "typescript": "~6.0.2" and uses oxlint. Recommendation: typescript ~6.0.3 now. Optionally add TS 7 later purely as a fast `tsc --noEmit` checker, or run @typescript/typescript6 side by side as Microsoft suggests. tsconfig from the template: target es2023, module esnext, moduleResolution bundler, verbatimModuleSyntax, jsx react-jsx, noEmit, allowImportingTsExtensions, erasableSyntaxOnly.
Sources: https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/, https://www.infoq.com/news/2026/08/typescript-7-released/, npm view typescript-eslint peerDependencies

## [should] Vite 8 specifics
Vite 8.3.0 bundles with Rolldown: `build.rollupOptions` is now `build.rolldownOptions`, and chunking uses `build.rolldownOptions.output.codeSplitting`. `resolve.dedupe` is still supported (v8.3.0 docs). @vitejs/plugin-react 6.x uses Oxc for JSX by default; Babel and the React Compiler are optional peers (@rolldown/plugin-babel, babel-plugin-react-compiler). The dev WebSocket proxy was tested working: `server: { proxy: { '/yjs': { target: 'ws://127.0.0.1:<port>', ws: true } } }`. Harmless ECONNRESET 'ws proxy error' lines are logged when sockets close. The production bundle of the test app was 983 kB (320 kB gzip), mostly codemirror-lang-latex's ~190 kB of data plus CM/Yjs. Load the editor with React.lazy/dynamic import so the project list and PDF viewer load first.
Sources: https://vite.dev/config/shared-options, vite build output in scratchpad

## [must] Dedupe CodeMirror/Lezer/Yjs singletons (instanceof / facet identity)
If two copies of @codemirror/state load, errors like 'Unrecognized extension value in extension set … multiple instances of @codemirror/state' appear. Two copies of yjs log 'Yjs was already imported. This breaks constructor checks and will lead to issues!'. vite.config.ts (tested; no duplicate warnings):
```ts
const SINGLETONS = ['@codemirror/state','@codemirror/view','@codemirror/language','@codemirror/autocomplete','@codemirror/commands','@codemirror/search','@codemirror/lint','@lezer/common','@lezer/highlight','@lezer/lr','yjs','y-protocols','lib0']
export default defineConfig({ plugins:[react()], resolve:{ dedupe: SINGLETONS },
  optimizeDeps:{ include:['yjs','y-websocket','y-codemirror.next','codemirror-lang-latex','@replit/codemirror-vim','@replit/codemirror-emacs'] },
  server:{ proxy:{ '/yjs':{ target:'ws://127.0.0.1:18234', ws:true } } } })
```
Also add an npm `overrides` block (e.g. "@codemirror/state": "$@codemirror/state") if `npm ls @codemirror/state` ever shows two versions. Never mix `import ... from 'yjs'` with a CJS require of yjs in the same bundle. After upgrading deps, restart the dev server with `vite --force`: stale pre-bundles caused a hang during testing.
Sources: https://github.com/yjs/yjs/issues/438, https://github.com/vitejs/vite/issues/13538, https://vite.dev/config/shared-options

## [must] React integration: plain CodeMirror in a component, not @uiw/react-codemirror
@uiw/react-codemirror 4.25.11 (MIT) conflicts with Yjs in three ways, confirmed by reading its source. (1) The `value` prop replaces the whole document ({from:0,to:len,insert:value}), which would rewrite the entire Y.Text. (2) It dispatches StateEffect.reconfigure.of(allExtensions) whenever `extensions`, `onChange`, `onUpdate`, theme etc. change identity, so an inline yCollab(...) array rebuilds the collaboration plugins on every render. (3) basicSetup defaults on and includes history() (disable with basicSetup={{history:false, historyKeymap:false}}). Recommended pattern (tested with React 19 StrictMode): useEffect keyed on [wsUrl, room] creates Y.Doc, WebsocketProvider and Y.UndoManager, and creates the EditorView only after `provider.on('sync', s => s && create())`. The initial doc must equal ytext.toString(). Keymap, theme and read-only live in Compartments and are switched with view.dispatch({effects: comp.reconfigure(...)}) in separate effects. Keep props in a ref so completion sources read fresh data. Cleanup order: view.destroy(); undoManager.destroy(); provider.destroy(); ydoc.destroy(). StrictMode's dev double-mount logs a harmless 'WebSocket is closed before the connection is established' warning.
Sources: uiw/react-codemirror esm/useCodeMirror.js (npm pack 4.25.11), https://github.com/yjs/y-codemirror.next

## [must] Extension list (no basicSetup; undo via Y.UndoManager)
basicSetup from codemirror@6.0.2 includes history() and historyKeymap. With yCollab, CodeMirror's history would undo collaborators' edits and fight Y.UndoManager, so build the list by hand (tested):
```ts
[ comp.keymap.of(vim()|emacs()|[]),            // first: vim/emacs must precede other keymaps
  lineNumbers(), highlightActiveLineGutter(), highlightSpecialChars(), foldGutter(), drawSelection(), dropCursor(),
  EditorState.allowMultipleSelections.of(true), indentOnInput(), indentUnit.of('  '),
  syntaxHighlighting(defaultHighlightStyle,{fallback:true}), bracketMatching(), closeBrackets(),
  autocompletion({activateOnTyping:true}), rectangularSelection(), crosshairCursor(), highlightActiveLine(),
  highlightSelectionMatches(), EditorView.lineWrapping,
  keymap.of([...yUndoManagerKeymap, ...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...foldKeymap, ...completionKeymap, ...lintKeymap, indentWithTab]),
  languageExt(mode), autoCloseEnvironment,
  yCollab(ytext, provider.awareness, { undoManager }),
  EditorView.theme({'.cm-ySelectionInfo':{opacity:1}}),   // always show collaborator names (default is hover-only)
  // (Folio since J-5: names show for 2 s after that collaborator's caret moves, and on hover — see ext/remoteCarets.ts)
  EditorView.contentAttributes.of({spellcheck:'true', autocorrect:'off', autocapitalize:'off', lang:'en'}),
  comp.theme.of(dark ? oneDark : []),
  comp.ro.of([EditorState.readOnly.of(ro), EditorView.editable.of(!ro)]) ]
```
yUndoManagerKeymap = Mod-z undo, Mod-y / Mod-Shift-z redo. yCollab also maps beforeinput historyUndo/historyRedo. Full verified file: scratchpad/cmyjs/web/src/LatexEditor.tsx.
Sources: codemirror@6.0.2 dist/index.js, y-codemirror.next@0.3.6 src/index.js, src/y-undomanager.js

## [must] LaTeX language package choice and license
Options compared. (a) codemirror-lang-latex 0.6.1 (texlyre; updated 2026-08-02): Lezer grammar with highlighting, indentation, foldNodeProp for every environment and \part…\subparagraph, foldServices for the preamble and comments, bracket matching, command/environment/package/class/option completion data (latexCommands, latexEnvironments, latexPackages, documentClasses, mathSymbols), snippets, hover tooltips (latexHoverTooltip), a linter (latexLinter), auto-close, and nestedEnvironments for mixed parsing. License: AGPL-3.0-or-later since 0.5.0. 0.2.0–0.4.2 were labelled MIT, but their README says the package is 'based on the Overleaf LaTeX grammar' (AGPL), so that MIT label is unreliable. It has a peer dependency on @lezer/generator (not imported at runtime). (b) @codemirror/legacy-modes 6.5.4 (MIT): `import { stex } from '@codemirror/legacy-modes/mode/stex'; StreamLanguage.define(stex)` gives highlighting only, with no syntax tree, folding or completion. (c) No other Lezer LaTeX grammar exists on npm (searched 'lezer latex', 'codemirror latex'). Recommendation: design languageExt(mode) so both are swappable (done in the test harness). Use stex (MIT) + our own completions/folding/auto-close by default to keep the project clean of Overleaf-derived AGPL code. Enable codemirror-lang-latex only if the user accepts AGPL for their deployment; a private self-hosted tool is fine, but offering it to others over a network triggers the AGPL source-offer duty. Measured on the real paper: both modes render in ~150–180 ms and type within one frame.
Sources: npm view codemirror-lang-latex license/time, https://github.com/texlyre/codemirror-lang-latex, codemirror-lang-latex@0.4.2 & 0.6.1 README/LICENSE (npm pack)

## [must] codemirror-lang-latex: required configuration and verified pitfalls
1) latex() with default enableAutocomplete:true pushes autocompletion({override:[latexCompletionSource]}). `override` hides every languageData completion source (our \ref/\cite/file sources), and adding your own autocompletion() throws 'Config merge conflict for field override' (combineConfig has no merge function for override). Fix: latex({enableAutocomplete:false}). latex() still registers latexCompletionSource via language.data, and our sources are added the same way: `sources.map(s => latexLanguage.data.of({autocomplete: s}))`. Tested: \subsec completes to \subsection, and project sources work at the same time. 2) autoCloseTags: its '}' key handler inserts '}'+\end{env} without looking for the '}' closeBrackets already inserted, giving `\begin{itemize}\n  \n\end{itemize}}` (reproduced). Its Enter handler (handleEnterInEnvironment) inserts \end{env} after any line ending in \begin{..} and never checks for an existing \end; it is inert only because defaultKeymap's Enter comes first in our ordering. Use autoCloseTags:false plus our own auto-close. 3) autoCloseBrackets:false when you already include closeBrackets(). 4) Linter on antiddos_v2.tex: 85 warnings + 8 errors, almost all false. 'Reference to undefined label: tab:ledger' ×10 (labels live in antiddos_v2_supplementary.tex; the linter is single-file). '\bf is obsolete' ×31. '\citep requires natbib', 'tabularx/booktabs/xcolor required' (all loaded by Definitions/mdpi.cls). 'Unclosed \jcpfit … before paragraph break' errors (a \newcommand argument spanning blank lines is legal). Use linter:{checkMissingReferences:false, checkMissingPackages:false, checkDeprecatedCommands:false, checkUnclosedBraces:false} or enableLinting:false, and show real diagnostics from the compile log instead. 5) Pass fileName so non-.tex files skip environment checks.
Sources: codemirror-lang-latex@0.6.1 dist/index.js latex() and src/auto-close-tags.ts, @codemirror/autocomplete dist/index.js (conf.override), @codemirror/state combineConfig, Playwright e2e in scratchpad (steps 10, 14a)

## [must] Custom completion sources (\ref, \cite, file paths): regexes and CompletionResult details
Register each source with lang.data.of({autocomplete: source}), where lang is latexLanguage or the StreamLanguage instance. Put the `from` right after the last '{' or ',' so multi-key \cite{a,b|} works:
```ts
const REF_CMD  = /\\(?:ref|eqref|pageref|autoref|nameref|vref|Vref|cref|Cref|cpageref|labelcref|subref)\*?\{[^}]*$/
const CITE_CMD = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?(?:\[[^\]]*\]){0,2}\{[^}]*$/
const FILE_CMD = /\\(input|include|includeonly|subfile|includegraphics|includepdf|lstinputlisting|inputminted|bibliography|addbibresource)\*?(?:\[[^\]]*\])?(?:\{[^}]*\})?\{[^}]*$/
function argFrom(ctx, re){ const m = ctx.matchBefore(re); if(!m) return null;
  let from = m.from + Math.max(m.text.lastIndexOf('{'), m.text.lastIndexOf(',')) + 1;
  while (ctx.state.sliceDoc(from, from+1) === ' ') from++; return { from, cmd: m.text } }
// ref:  { from, options: labels.map(l=>({label:l.key, type:'variable', detail:l.file})), validFor: /^[^,}\s]*$/ }
// cite: { from, options: cites.map(c=>({label:c.key, type:'text', detail:c.detail, info:c.file})), validFor: /^[^,}\s]*$/ }
// file: filter by command: includegraphics/includepdf → /\.(pdf|png|jpe?g|eps)$/i; \input → .tex (keep ext);
//       \include/\includeonly/\subfile → .tex with extension stripped; \bibliography → .bib stripped; \addbibresource → .bib kept; validFor: /^[^}]*$/
```
Tested: \ref{ lists fig:arch, sec:intro; \citep[p.~3]{smith2020, lists keys; \includegraphics[width=\linewidth]{ lists only images; Enter applies \ref{sec:intro}. Full file: scratchpad/cmyjs/web/src/latexProject.ts.
Sources: @codemirror/autocomplete CompletionContext.matchBefore / validFor, Playwright e2e steps 7–11

## [must] Project index for completions (labels, bib keys, bibitems, files)
Build it on the server over all project files (in-memory Y.Text for open rooms, disk otherwise). Serve it at GET /api/projects/:id/index -> {labels:[{key,file}], cites:[{key,detail,file}], files:[relPath]}. Refresh it after each debounced save and push a small 'index-changed' ping. The client keeps the latest copy in a ref read by getIndex(). Regexes (strip comments first with src.replace(/(^|[^\\])%.*$/gm,'$1')): labels /\\label(?:\[[^\]]*\])?\{([^}]+)\}/g (the optional [] covers cleveref's \label[type]{x}); bibitem /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g (the user's paper has 63 \bibitem and 39 \label); bib entries /@(?!(?:comment|string|preamble)\b)([a-zA-Z]+)\s*[{(]\s*([^,\s{}()]+)\s*,/gi with title /\btitle\s*=\s*[{"]\s*([^\n]*?)[}"]\s*,?\s*$/im for the detail text. Include supplementary .tex files so cross-document refs (xr) like tab:ledger resolve.
Sources: scratchpad/cmyjs/web/src/latexProject.ts, <paper directory>/antiddos_v2.tex

## [must] Environment auto-close on \begin{…} (works with closeBrackets, balance-aware)
Implement it as an input handler at highest precedence. closeBrackets() is itself an inputHandler that would just step over the auto-inserted '}':
```ts
export const autoCloseEnvironment = Prec.highest(EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '}' || from !== to || view.state.readOnly) return false
  const line = view.state.doc.lineAt(from)
  const m = /\\begin\{([A-Za-z@*]+)$/.exec(line.text.slice(0, from - line.from)); if (!m) return false
  const closeTo = view.state.sliceDoc(from, from + 1) === '}' ? from + 1 : from   // eat closeBrackets' '}'
  if (hasMatchingEnd(view.state.doc.toString(), closeTo, m[1])) return false     // depth-count \begin/\end of same name
  const indent = /^\s*/.exec(line.text)![0], unit = '  '
  view.dispatch({ changes: { from, to: closeTo, insert: `}\n${indent}${unit}\n${indent}\\end{${m[1]}}` },
    selection: EditorSelection.cursor(from + 2 + indent.length + unit.length), userEvent: 'input.type', scrollIntoView: true })
  return true }))
```
Tested: typing \begin{itemize then } gives a clean block with the cursor inside. Enter after an existing \begin{document} adds no second \end. Environment-name completion (codemirror-lang-latex latexCompletionSource or our list) should apply 'name}' so this handler is not needed there, or insert the whole snippet via snippetCompletion.
Sources: Playwright e2e steps 5, 6, @codemirror/view EditorView.inputHandler

## [should] Folding of \section and \begin…\end
With codemirror-lang-latex, folding comes from foldNodeProp (Environment, FigureEnvironment, TabularEnvironment, …, Section/SubSection/…) plus foldService for the preamble, comments and sections. With stex, add a foldService (tested, 4 fold markers on the sample). For a line matching /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/, fold from lineEnd to the end of the line before the next heading of the same or higher level, or before \end{document}. For a line containing \begin{X} (except document), depth-count /\\(begin|end)\{X\}/g from after the match and fold to the line before the matching \end. Include foldGutter() and foldKeymap (Ctrl-Shift-[ / ]). The same heading regex can drive a file-outline panel.
Sources: codemirror-lang-latex src/latex-language.ts, @codemirror/language foldService

## [should] Completion data for commands/environments without AGPL: LaTeX-Workshop JSON (MIT)
If you avoid codemirror-lang-latex, take the command and environment data from James-Yu/LaTeX-Workshop (MIT, v10.19.0): data/commands.json (300 entries of {snippet, detail, documentation}), data/environments.json (57 entries), data/packages/*.json, data/bibtex-entries.json. Keep the MIT notice. The snippets use VS Code syntax; CodeMirror's snippet() parser accepts ${1:default} and ${0}, so convert bare `$1` to `${1}` and drop ${TM_SELECTED_TEXT}. Then use `snippetCompletion('\\' + tpl, {label:'\\'+name, detail, type:'function'})` from @codemirror/autocomplete, in a source matching /\\[a-zA-Z]*$/ with validFor /^\\?[a-zA-Z]*$/. Generate a JSON file at build time rather than copying at runtime.
Sources: https://github.com/James-Yu/LaTeX-Workshop/tree/master/data, https://raw.githubusercontent.com/James-Yu/LaTeX-Workshop/master/LICENSE.txt, @codemirror/autocomplete Snippet.parse

## [must] Yjs ecosystem state: stay on yjs 13; do not use @y/websocket-server ≥0.1.2 or yjs 14 prereleases
yjs latest 13.6.32 (next 14.0.0-8, beta 14.0.0-16); @y/y is the renamed v14 (14.0.0-rc.7). y-codemirror.next 0.3.6 peers yjs ^13.5.6. The server moved out of y-websocket in 3.0.0 (2025-04) into @y/websocket-server. 0.1.0/0.1.1 peer yjs ^13 and use y-protocols. 0.1.2 and 0.1.5 (2026-02-18) switched to @y/protocols and depend on yjs ^14.0.0-7, so they cannot be mixed with a yjs-13 client stack. @y/websocket 4.0.0-x is the v14 client, also prerelease. @y/codemirror is 0.0.0-x. The 0.1.1 utils (setupWSConnection, setPersistence({bindState, writeState}), setContentInitializor, getYDoc, docs) have problems: bindState is not awaited before sync step 1; docs.delete() runs while writeState is still pending, so a reconnect during the flush gets a second doc; it imports y-leveldb as an optional dependency; the README calls it a dev server and suggests Hocuspocus/YHub for production. Recommendation: write our own ~200-line server on y-protocols 1.0.7 sync/awareness + lib0 encoding (MIT; logic modeled on utils.js).
Sources: npm view @y/websocket-server versions/dependencies, https://github.com/yjs/y-websocket-server, https://github.com/yjs/y-websocket, @y/websocket-server@0.1.1 src/utils.js (npm pack)

## [must] y-websocket 3.1.0 client API (verified from source)
`new WebsocketProvider(serverUrl, roomname, ydoc, { connect=true, awareness, params={}, protocols=[], WebSocketPolyfill=WebSocket, resyncInterval=-1, maxBackoffTime=2500, disableBc=false, shouldReconnect })`. The URL is serverUrl + '/' + roomname + '?' + encoded params, so serverUrl 'wss://host/yjs' + room 'proj/file' connects to /yjs/proj/file?…. Events: 'status' {status:'connecting'|'connected'|'disconnected'}, 'sync'(bool) (also 'synced'), 'connection-close', 'connection-error', and 'closed' {code, reason} (new in 3.1). Close codes 4400–4499 are treated as permanent by default (no reconnect; use them for 'forbidden/deleted'); 4500–4599 are transient. In Node pass WebSocketPolyfill: WebSocket from 'ws'. BroadcastChannel sync between tabs of the same origin is on unless disableBc:true. For auth, put a short-lived token in params ({params:{token}}) or rely on the session cookie sent with the upgrade request.
Sources: y-websocket@3.1.0 src/y-websocket.js (npm pack), https://github.com/yjs/y-websocket

## [must] Server: multi-doc ws server with load-from-disk, debounced write-back and Yjs sidecar (tested)
Full verified file: scratchpad/cmyjs/collab-server.ts, with integration test test-server.ts using real y-websocket clients. Core pattern:
```ts
class Room { doc=new Y.Doc({gc:true}); text=this.doc.getText('content'); awareness=new Awareness(this.doc); conns=new Map<WebSocket,{readOnly:boolean,clientIds:Set<number>}>(); ready=this.load()
  async load(){ try{ Y.applyUpdate(this.doc, await fs.readFile(statePath), 'load') }catch{}      // 1. CRDT history
    const disk = await fs.readFile(texPath,'utf8').catch(()=> '')
    applyTextDiff(this.text, disk, 'load'); this.lastSavedText = disk                        // 2. reconcile .tex
    this.doc.on('update',(u,origin)=>{ broadcast([0, writeUpdate(u)]); if(origin!=='load') this.scheduleSave() }) }
  scheduleSave(){ /* debounce 1000ms, maxWait 10s */ }
  flush(){ this.saving = this.saving.then(async()=>{ const t=this.text.toString();
      if(t!==this.lastSavedText){ await writeAtomic(texPath,t); this.lastSavedText=t }   // tmp file + rename
      await writeAtomic(statePath, Y.encodeStateAsUpdate(this.doc)) }); return this.saving } }
// upgrade: server.on('upgrade',(req,sock,head)=>{ auth(req) || reject 401; room=decodeURIComponent(url.pathname.slice('/yjs/'.length)); wss.handleUpgrade(req,sock,head,ws=>onConnection(ws,room,readOnly)) })
// onConnection: conns.set(ws,…); ws.on('message', d => room.ready.then(()=>onMessage(ws,d)))  // attach SYNCHRONOUSLY, handle after load
//   room.ready.then(()=>{ send [0, writeSyncStep1(doc)]; if awareness states: send [1, encodeAwarenessUpdate(all)] })
// onMessage: type 0 → readSyncMessage(dec, enc, doc, ws) (viewer: only readSyncStep1); reply if encoding.length(enc)>1
//            type 1 → applyAwarenessUpdate(awareness, readVarUint8Array(dec), ws); type 3 → send all awareness
//            on exception → ws.close(4400,'bad message')
// close: removeAwarenessStates(awareness,[...clientIds],null); if no conns → flush(); unload after 30s idle (flush, then delete only if still empty and map entry === room)
// ping every 30s, close if no pong.  Server awareness.setLocalState(null). SIGTERM → await flushAll().
```
The awareness 'update' handler maps origin (the ws) to the clientIds it controls and broadcasts [1, encodeAwarenessUpdate(changed)]. Test results: two clients sync; the awareness list shows all users; a viewer's (?ro=1) edits are dropped; the .tex file is written ~1s after typing; after a server restart plus an outside edit to the .tex, connected clients converge with no duplication.
Sources: scratchpad/cmyjs/collab-server.ts + test-server.ts (tsx run), y-protocols@1.0.7 sync.js/awareness.js exports

## [must] Critical: document duplication on server restart unless Yjs state is persisted
Reproduced (test-nosidecar.ts). If the server rebuilds a room by inserting the .tex text into a new Y.Doc (new clientID) while browsers still hold their old Y.Doc, y-websocket reconnects and both sides exchange state. The result is the whole file twice, and it is written to disk. Output: "…Hello world\n\\end{document}\n\\documentclass{article}…Hello external world…". Mitigations: (1) Required: persist Y.encodeStateAsUpdate(doc) per file, e.g. <dataDir>/ystate/<projectId>/<fileId>.bin kept OUT of the LaTeX project dir so it is not compiled or committed. Load it before the .tex, then applyTextDiff to the disk text. Verified: no duplication, and outside edits are applied as a normal diff. (2) Defence in depth: keep a per-room epoch (UUID) in the sidecar metadata. The client sends it in params; if the sidecar was lost and the epoch changed, the server closes with 4409 (permanent range), and the client's 'closed' handler throws away its Y.Doc and reconnects with a new one. (3) Never 'reset' a room by creating a new Y.Doc. Git restore, file upload and file-watcher events must call collab.replaceText(room, newText), which applies a prefix/suffix diff in a transaction with origin 'server'.
Sources: scratchpad/cmyjs/test-nosidecar.ts output, scratchpad/cmyjs/test-server.ts output

## [should] applyTextDiff and the file watcher for outside edits
Minimal-diff update keeps CRDT history and does not move collaborators' cursors:
```ts
export function applyTextDiff(ytext: Y.Text, next: string, origin: unknown = 'disk') {
  const old = ytext.toString(); if (old === next) return
  let s = 0; const n = Math.min(old.length, next.length); while (s < n && old.charCodeAt(s) === next.charCodeAt(s)) s++
  let eo = old.length, en = next.length; while (eo > s && en > s && old.charCodeAt(eo-1) === next.charCodeAt(en-1)) { eo--; en-- }
  if (s > 0 && (old.charCodeAt(s-1) & 0xfc00) === 0xd800) s--          // don't split surrogate pairs
  ytext.doc!.transact(() => { if (eo > s) ytext.delete(s, eo - s); if (en > s) ytext.insert(s, next.slice(s, en)) }, origin)
}
```
For finer-grained merges use fast-diff@1.3.0 (Apache-2.0) or diff-match-patch@1.0.5. Watch the project dir with chokidar@5.0.0 (ESM-only, node >=20.19). On 'change', read the file and skip it if content === room.lastSavedText (this ignores our own atomic writes). Otherwise, if the room is loaded, call replaceText; if not, do nothing, since the next load reconciles.
Sources: scratchpad/cmyjs/collab-server.ts, npm view chokidar@5.0.0 engines type

## [must] y-codemirror.next 0.3.6 usage, awareness and cursor colours
API: yCollab(ytext, awareness, { undoManager?: Y.UndoManager | false }) returns [ySyncFacet, ySync, yRemoteSelectionsTheme, yRemoteSelections, yUndoManagerFacet, yUndoManager, beforeinput handler]. Also exported: yUndoManagerKeymap, YSyncConfig, ySyncAnnotation, yRemoteSelections(Theme). Undo/redo functions are not exported directly; call yUndoManagerKeymap[0].run(view) / [1].run(view) or undoManager.undo(). Set local user info with provider.awareness.setLocalStateField('user', { name, color, colorLight }). color must be a 6-digit '#rrggbb', because the plugin builds the selection tint as color + '33' when colorLight is missing. Generate a stable colour per user id (HSL to hex). The plugin writes awareness 'cursor' {anchor, head} as relative-position JSON only while the editor and document have focus. The name label (.cm-ySelectionInfo) is hidden until hover by default; override with EditorView.theme({'.cm-ySelectionInfo':{opacity:1}}). Tested: A sees 'bob' next to Bob's caret. The Y.Text name must match on client and server (we use doc.getText('content')).
Sources: y-codemirror.next@0.3.6 src/*.js, Playwright e2e step 3

## [should] Undo semantics with Y.UndoManager (captureTimeout)
new Y.UndoManager(ytext, { captureTimeout = 500, trackedOrigins, captureTransaction, deleteFilter }). Only edits from this client's ySync origin are tracked, so Ctrl-Z never undoes a collaborator's edit (verified). Edits less than 500 ms apart are merged into one stack item. During fast automated typing, one vim 'u' undid about 150 characters from several separate actions (seen in server logs). Call undoManager.stopCapturing() at logical boundaries: on vim 'vim-mode-change' (getCM(view).on('vim-mode-change', ()=>um.stopCapturing())), after applying a completion, and on cursor jumps (selection moved without docChanged).
Sources: yjs@13.6.32 dist/src/utils/UndoManager.d.ts, collab server debug log in scratchpad

## [should] Vim / Emacs keymaps
@replit/codemirror-vim 6.4.0 (MIT; now built on @replit/codemirror-vim-core 0.1.0). Exports vim({status?:boolean}), Vim, getCM(view), CodeMirror. Put vim() before other keymaps (first item in the extension list) and keep drawSelection(). The Vim API supports Vim.map('jj','<Esc>','insert'), Vim.defineEx('write','w', () => save()), which is good for :w triggering compile. Gotcha (verified): vim's u / Ctrl-r call CodeMirror.commands.undo/redo, which wrap @codemirror/commands undo(). That does nothing without history(), and the adapter captures the functions for :undo/:redo at init, so patch at module load:
```ts
import { vim, CodeMirror as VimCM } from '@replit/codemirror-vim'
VimCM.commands.undo = (cm: any) => { yUndoManagerKeymap[0].run!(cm.cm6) }
VimCM.commands.redo = (cm: any) => { yUndoManagerKeymap[1].run!(cm.cm6) }
```
Tested: 'xx' deletes, 'u' restores through Y.UndoManager and the change syncs to the server. @replit/codemirror-emacs 6.1.0: emacs(), also placed before other keymaps. Switch at runtime via a Compartment (tested) and store the choice per user.
Sources: @replit/codemirror-vim@6.4.0 dist/index.js (runHistoryCommand), @replit/codemirror-vim-core vim.js lines 3408, 6396, Playwright e2e step 12

## [should] Spell check
MVP: EditorView.contentAttributes.of({ spellcheck: 'true', lang: 'en', autocorrect: 'off', autocapitalize: 'off' }). Caveats: (1) the browser checks everything, including LaTeX macro names, \label/\cite keys and math, so there is noise; (2) only rendered viewport lines are checked, and Chrome rechecks lazily after edits; (3) no shared or project dictionary; (4) native spellcheck is ignored on iOS; a Sept-2026 report found no underlines in Electron 44/Chromium 152 (an Electron problem; desktop Chrome 152 works); (5) right-click replacement goes through the DOM and CodeMirror's observer, which generally works in CM6. Better (Overleaf-like, since Overleaf moved to client-side Hunspell/WASM): nspell@2.1.5 (MIT, CJS, types @types/nspell@2.1.6) plus dictionary-en@4.0.0 ((MIT AND BSD)) in a Web Worker. Note dictionary-en 4 is ESM that reads index.aff/index.dic with node:fs and its `exports` exposes only ./index.js, so it cannot be imported in the browser. Copy index.aff/index.dic to /dict/en.{aff,dic} at build time and fetch them in the worker. A ViewPlugin tokenizes visibleRanges, skipping commands, math, comments and ref/cite/label arguments (use the syntax tree with codemirror-lang-latex, or stex token types), sends words to the worker (spell.correct / spell.suggest), and marks misses with Decoration.mark({class:'cm-spell-error'}). Add a context menu for suggestions and a per-project dictionary (spell.add).
Sources: https://discuss.codemirror.net/t/native-spellcheck-is-never-applied-to-a-codemirror-6-editing-host-on-chromium-152-electron-44/9886, https://discuss.codemirror.net/t/os-level-spellcheck-is-disabled-on-ios-even-after-adding-contentattribute/4128, https://www.overleaf.com/blog/overleafs-remote-hackathon-revisited-one-year, dictionary-en@4.0.0 index.js (npm pack)

## [should] Diagnostics from the compile log instead of a heuristic linter
Overleaf-style log annotations are more reliable than any single-file linter; see the lint false positives above. After latexmk, parse the .log into {file, line, severity, message}: /^! (.*)$/ followed by /^l\.(\d+)/ for errors; /^(?:LaTeX|Package \w+) Warning: (.*) on input line (\d+)\./ for warnings; 'Reference `x' on page n undefined'; 'Overfull \\hbox … at lines a--b'. Track the current file with the '(' / ')' file stack. Push the results into the matching editor with `view.dispatch(setDiagnostics(view.state, diags))` from @codemirror/lint, mapping line numbers to doc.line(n).from/to. Keep lintGutter() for gutter markers. Clear them on the next compile.
Sources: @codemirror/lint setDiagnostics, codemirror-lang-latex linter run on antiddos_v2.tex

## [should] One provider per open file; project presence
y-websocket opens one WebSocket per room. The simple approach, like Overleaf's single editor pane, keeps only the active file's Y.Doc and provider alive and destroys them when switching files. Reconnect plus sync is fast, and the server keeps the room warm for 30 s. Room name = `${projectId}/${fileId}` with a stable file id, so a rename keeps the room and history. Awareness is per room, so for a project-wide 'who is online and in which file' list use a separate lightweight room (e.g. `${projectId}/__presence`, awareness only) or project-level messages on your API socket. Binary files (images, PDFs) do not go through Yjs; upload them over REST.
Sources: y-websocket@3.1.0 src (url getter)

## [must] Security and permissions on the WebSocket upgrade
Do auth in http server.on('upgrade') before wss.handleUpgrade: validate the session cookie (or a short-lived signed token from params), check project membership and role, and on failure write 'HTTP/1.1 401 Unauthorized\r\n\r\n' and destroy the socket. Decode and validate the room with a strict regex (e.g. /^[a-z0-9-]{8,}\/[a-z0-9-]{8,}$/) and map it to paths only through the database; never join raw room strings into file paths. Enforce read-only server-side: for viewer connections, answer sync step 1 but ignore step 2 and updates (tested). On the client also set EditorState.readOnly and EditorView.editable(false). Set WebSocketServer maxPayload (16 MB used). Close with 4403 or 4404 (permanent range) when access is revoked or a file is deleted, and show the reason from the provider's 'closed' event.
Sources: scratchpad/cmyjs/collab-server.ts, https://github.com/websockets/ws#client-authentication

## [nice] Alternative server: Hocuspocus (MIT)
@hocuspocus/server 4.7.0 and @hocuspocus/provider 4.7.0 (peers yjs ^13.6.8, y-protocols ^1.0.6) are production-grade. They provide onAuthenticate, onLoadDocument, onStoreDocument (debounced via debounce/maxDebounce), afterUnloadDocument, flush on Server.destroy(), and many documents over one socket. v4 hook payloads use web-standard Request/Headers. The trade-off: a different wire protocol and client (@hocuspocus/provider instead of y-websocket), plus more dependencies. Reasonable if multiplexing several open files over one socket becomes important. The same sidecar-plus-diff persistence rules apply in onLoadDocument/onStoreDocument.
Sources: https://tiptap.dev/docs/hocuspocus/server/hooks, npm view @hocuspocus/server

## [nice] .bib and other non-.tex files
@codemirror/legacy-modes has no BibTeX mode (checked the full mode list). Options: stex for .bib (acceptable), or a small simpleMode: `import { simpleMode } from '@codemirror/legacy-modes/mode/simple-mode'`, then StreamLanguage.define(simpleMode({ start: [{regex:/@[a-zA-Z]+/, token:'keyword'}, {regex:/[a-zA-Z]+(?=\s*=)/, token:'propertyName'}, {regex:/%.*/, token:'comment'}, {regex:/[{}]/, token:'bracket'}] })). Pick the language by file extension with a Compartment. Plain text for .cls/.sty/.txt, or stex for .cls/.sty. Hand .bib edits to the project index scanner.
Sources: @codemirror/legacy-modes@6.5.4 mode/ directory and simple-mode.d.ts

## [nice] Performance on the user's real paper
antiddos_v2.tex is 203,552 bytes and 1,686 lines, with very long paragraph lines, 8 tables, 7 tikzpictures and 8 pgfplots axes. In headless Chromium through the collab server: first render after sync about 177 ms (Lezer) / 154 ms (stex); keystroke dispatch plus frame median 16.7 ms, p95 16.9 ms (one frame) in both modes. EditorView.lineWrapping is essential given the long lines. The Lezer parse runs incrementally in the background with no noticeable cost. No need for virtualisation beyond CodeMirror's own viewport rendering.
Sources: scratchpad/cmyjs/perf.mjs output

## [should] Verified reference implementation files (scratchpad)
All paths are under <scratch> collab-server.ts (server, tested), test-server.ts and test-nosidecar.ts (Node integration tests incl. the duplication repro), serve-collab.ts (http + upgrade routing), web/vite.config.ts, web/tsconfig.json, web/src/LatexEditor.tsx (React component), web/src/latexProject.ts (completions, auto-close, fold service, scanners), e2e.mjs (Playwright checks; use playwright-core@1.61.0 with executablePath ~/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome, since the cached chromium-1228 matches 1.61.0, not 1.63.0), perf.mjs. These are clean-room code (no Overleaf code) and can be moved into the app.
Sources: local scratchpad

## Packages
- @codemirror/state@6.7.5 (MIT) — Editor state, transactions, Compartment, Prec, facets must be a single instance (dedupe)
- @codemirror/view@6.43.12 (MIT) — EditorView, keymap, inputHandler, contentAttributes, decorations 
- @codemirror/commands@6.11.1 (MIT) — defaultKeymap, indentWithTab (do NOT use history()) 
- @codemirror/language@6.12.4 (MIT) — StreamLanguage, foldService, foldGutter, syntaxHighlighting, indentUnit 
- @codemirror/search@6.7.2 (MIT) — search/replace panel + highlightSelectionMatches 
- @codemirror/autocomplete@6.20.3 (MIT) — autocompletion(), snippetCompletion, closeBrackets never combine with another autocompletion({override})
- @codemirror/lint@6.9.7 (MIT) — setDiagnostics from compile log, lintGutter 
- @codemirror/theme-one-dark@6.1.3 (MIT) — dark theme via Compartment 
- @codemirror/legacy-modes@6.5.4 (MIT) — stex (LaTeX) and simple-mode (BibTeX) stream parsers license-clean default language mode
- codemirror-lang-latex@0.6.1 (AGPL-3.0-or-later) — Optional richer LaTeX support (Lezer grammar, folding, tooltips, completion data) Derived from Overleaf grammar; use latex({enableAutocomplete:false, autoCloseTags:false, autoCloseBrackets:false, linter:{…off}})
- @lezer/common@1.5.2 (MIT) — peer of lang packages 
- @lezer/highlight@1.2.3 (MIT) — highlight tags 
- @lezer/lr@1.4.10 (MIT) — LR parser runtime (codemirror-lang-latex) 
- @replit/codemirror-vim@6.4.0 (MIT) — Vim keymap patch CodeMirror.commands.undo/redo to Y.UndoManager
- @replit/codemirror-emacs@6.1.0 (MIT) — Emacs keymap 
- yjs@13.6.32 (MIT) — CRDT for collaborative text avoid 14.x prerelease / @y/y
- y-codemirror.next@0.3.6 (MIT) — yCollab binding, remote cursors, Y.UndoManager keymap 
- y-websocket@3.1.0 (MIT) — Client WebsocketProvider (server no longer included) 
- y-protocols@1.0.7 (MIT) — sync + awareness protocol for our custom server 
- lib0@0.2.117 (MIT) — encoding/decoding for the server 
- ws@8.21.3 (MIT) — Node WebSocket server (noServer + handleUpgrade) 
- @types/ws@8.18.1 (MIT) — types 
- react@19.3.0 (MIT) — UI 19.2.8 also verified
- react-dom@19.3.0 (MIT) — UI 
- vite@8.3.0 (MIT) — dev server/bundler (Rolldown) 
- @vitejs/plugin-react@6.1.1 (MIT) — React plugin for Vite 8 
- typescript@6.0.3 (Apache-2.0) — type checking not 7.0.2 yet (no API; typescript-eslint <6.1)
- @types/react@19.3.0 (MIT) — types 
- @types/react-dom@19.3.0 (MIT) — types 
- @types/node@22.20.4 (MIT) — Node 22 types for server 
- tsx@4.23.15 (MIT) — run TS server in dev 
- chokidar@5.0.0 (MIT) — watch project dir for external edits ESM-only, node >=20.19
- nspell@2.1.5 (MIT) — Hunspell-compatible spell checker in a Web Worker @types/nspell 2.1.6
- dictionary-en@4.0.0 ((MIT AND BSD)) — English Hunspell dictionary node:fs-based index.js; serve index.aff/.dic as static files
- fast-diff@1.3.0 (Apache-2.0) — optional finer-grained diff when applying disk changes to Y.Text 
- @hocuspocus/server@4.7.0 (MIT) — alternative production Yjs server needs @hocuspocus/provider instead of y-websocket
- playwright-core@1.61.0 (Apache-2.0) — e2e tests against cached chromium-1228 

## Risks
- License: codemirror-lang-latex ≥0.5.0 is AGPL-3.0-or-later and derived from Overleaf's grammar; ≤0.4.2 claims MIT but has the same provenance. Using it makes the app AGPL: fine for private self-hosting, but letting others use it over a network means offering the source. Keep it behind a swappable languageExt, with stex (MIT) as the default.
- Document duplication after a server restart if the Yjs state is not persisted; reproduced, and it gets written to disk. The sidecar state file is mandatory, and it must survive backups, moves and git operations (keep it outside the LaTeX project dir, keyed by a stable fileId).
- Server-side text changes (git restore, upload, outside edits) must go through applyTextDiff on the live Y.Text. Replacing the Y.Doc or writing the .tex while a room is loaded without reconciling causes lost edits or duplication.
- @y/websocket-server ≥0.1.2 pulls in yjs 14 prereleases; installing it next to yjs 13 gives two Yjs copies and broken constructor checks. Pin the yjs 13 ecosystem and check with `npm ls yjs`.
- Duplicate @codemirror/state or @lezer/common copies (e.g. from @uiw/react-codemirror or a lang package with a different range) break the extension system; keep resolve.dedupe and check `npm ls` in CI.
- codemirror-lang-latex's built-in autocompletion (override), autoCloseTags (stray '}'), and linter (93 false or noisy diagnostics on the real paper) are harmful with default settings.
- Y.UndoManager's 500 ms captureTimeout can merge unrelated edits into one undo step; call stopCapturing() at boundaries (vim mode change, completion accept, cursor jumps).
- Native browser spellcheck is noisy for LaTeX and does not work on iOS or some Electron builds; a proper checker (nspell in a worker) is extra work.
- TypeScript 7 is `latest` on npm; `npm i -D typescript` would install it and break typescript-eslint. Pin ~6.0.3.
- Bundle size (~1 MB min, 320 kB gzip with codemirror-lang-latex): lazy-load the editor route.
- Our collab server is single-process by design; horizontal scaling would need Redis pub/sub (e.g. y-redis) or Hocuspocus, which this single-box deployment does not need.
