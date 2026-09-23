# Third-party notices

Folio is an independent implementation inspired by the user experience of
[Overleaf](https://www.overleaf.com). It contains **no Overleaf source code** and is not affiliated with or
endorsed by Overleaf. Folio itself is licensed under the GNU Affero General Public License v3.0
(see [LICENSE](LICENSE)).

## Projects consulted during design

| Project | License | How it was used |
|---|---|---|
| [LaTeX-Workshop](https://github.com/James-Yu/LaTeX-Workshop) | MIT, © 2016 James Yu | Studied as a reference for LaTeX log parsing and SyncTeX. No code was copied; Folio's parsers in [`shared/src/texlog/`](shared/src/texlog/) and [`shared/src/synctex/`](shared/src/synctex/) are its own. |
| [Overleaf](https://github.com/overleaf/overleaf) | AGPL-3.0 | Its documented behaviour (compile options, editor layout, UI wording) was studied. No code was copied. |

If code from a third-party project is ever adapted into Folio, list the files here together with that project's
license and copyright notice.

## Software Folio depends on

These packages are installed by `npm install` and are used under their own licenses. Each package's full
license text is in `node_modules/<package>/`.

| Package | Version | License |
|---|---|---|
| [@codemirror/autocomplete](https://github.com/codemirror/autocomplete) | 6.20.3 | MIT |
| [@codemirror/commands](https://github.com/codemirror/commands) | 6.11.1 | MIT |
| [@codemirror/language](https://github.com/codemirror/language) | 6.12.4 | MIT |
| [@codemirror/legacy-modes](https://github.com/codemirror/legacy-modes) | 6.5.4 | MIT |
| [@codemirror/lint](https://github.com/codemirror/lint) | 6.9.7 | MIT |
| [@codemirror/merge](https://github.com/codemirror/merge) | 6.12.2 | MIT |
| [@codemirror/search](https://github.com/codemirror/search) | 6.7.2 | MIT |
| [@codemirror/state](https://github.com/codemirror/state) | 6.7.5 | MIT |
| [@codemirror/theme-one-dark](https://github.com/codemirror/theme-one-dark) | 6.1.3 | MIT |
| [@codemirror/view](https://github.com/codemirror/view) | 6.43.12 | MIT |
| [@lezer/highlight](https://github.com/lezer-parser/highlight) | 1.2.3 | MIT |
| [@replit/codemirror-vim](https://github.com/replit/codemirror-vim) | 6.4.0 | MIT |
| [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) | 13.0.3 | MIT |
| [clsx](https://github.com/lukeed/clsx) | 2.1.1 | MIT |
| [cookie](https://github.com/jshttp/cookie) | 2.0.1 | MIT |
| [diff](https://github.com/kpdecker/jsdiff) | 9.0.0 | BSD-3-Clause |
| [express](https://github.com/expressjs/express) | 5.2.1 | MIT |
| [express-rate-limit](https://github.com/express-rate-limit/express-rate-limit) | 8.7.0 | MIT |
| [fast-diff](https://github.com/jhchen/fast-diff) | 1.3.0 | Apache-2.0 |
| [helmet](https://github.com/helmetjs/helmet) | 8.3.0 | MIT |
| [katex](https://github.com/KaTeX/KaTeX) | 0.18.7 | MIT |
| [lib0](https://github.com/dmonad/lib0) | 0.2.117 | MIT |
| [lru-cache](https://github.com/isaacs/node-lru-cache) | 11.5.3 | BlueOak-1.0.0 |
| [lucide-react](https://github.com/lucide-icons/lucide) | 1.47.0 | ISC |
| [mime](https://github.com/broofa/mime) | 4.1.0 | MIT |
| [multer](https://github.com/expressjs/multer) | 2.4.0 | MIT |
| [p-limit](https://github.com/sindresorhus/p-limit) | 7.3.3 | MIT |
| [pdfjs-dist](https://github.com/mozilla/pdf.js) | 6.3.289 | Apache-2.0 |
| [pino](https://github.com/pinojs/pino) | 10.3.1 | MIT |
| [pino-pretty](https://github.com/pinojs/pino-pretty) | 13.1.3 | MIT |
| [react](https://github.com/react/react) | 19.3.0 | MIT |
| [react-dom](https://github.com/react/react) | 19.3.0 | MIT |
| [react-resizable-panels](https://github.com/bvaughn/react-resizable-panels) | 4.13.1 | MIT |
| [react-router](https://github.com/remix-run/react-router) | 7.18.4 | MIT |
| [tsx](https://github.com/privatenumber/tsx) | 4.23.15 | MIT |
| [ws](https://github.com/websockets/ws) | 8.21.3 | MIT |
| [y-codemirror.next](https://github.com/yjs/y-codemirror.next) | 0.3.6 | MIT |
| [y-protocols](https://github.com/yjs/y-protocols) | 1.0.7 | MIT |
| [y-websocket](https://github.com/yjs/y-websocket) | 3.1.0 | MIT |
| [yauzl](https://github.com/thejoshwolfe/yauzl) | 3.4.0 | MIT |
| [yazl](https://github.com/thejoshwolfe/yazl) | 3.3.1 | MIT |
| [yjs](https://github.com/yjs/yjs) | 13.6.32 | MIT |
| [zod](https://github.com/colinhacks/zod) | 4.6.5 | MIT |
| [zustand](https://github.com/pmndrs/zustand) | 5.0.15 | MIT |

Development-only tools (TypeScript, Vite, Vitest, Playwright and their plugins) are listed in the
`package.json` files and are not part of a running Folio.

## Software Folio runs but does not include

| Software | License | Role |
|---|---|---|
| [TeX Live](https://www.tug.org/texlive/) via the [`texlive/texlive`](https://hub.docker.com/r/texlive/texlive) Docker image | various free-software licenses | compiles documents inside the sandbox |
| [Docker](https://www.docker.com) | Apache-2.0 (Moby) | runs the compile sandbox |
| [git](https://github.com/git/git) | GPL-2.0 | stores each project's history (called as an external program) |
