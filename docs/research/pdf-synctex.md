# AREA: PDF preview (pdf.js) + SyncTeX bidirectional source<->PDF sync

Use pdfjs-dist 6.3.289 (latest, published 2026-08-29, Apache-2.0) with its built-in PDFViewer component ('pdfjs-dist/web/pdf_viewer.mjs': EventBus + PDFLinkService + PDFViewer). Don't hand-roll canvases and IntersectionObserver. PDFViewer already provides several things: virtualised continuous scroll with a rendering queue and a page-view cache; HiDPI handling (canvas = CSS size × devicePixelRatio, capped by maxCanvasPixels, plus a sharper 'detail canvas' at high zoom); a text layer whose CSS variables changed between v4, v5 and v6; zoom presets (page-width, page-fit, auto); internal hyperref links; and exact scroll restore using XYZ destinations. I checked everything below in a real Vite 8.3.0 app, driven by headless Chrome 149 at devicePixelRatio 2, in both dev and production builds. The worker loads through an `import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'` import. Scroll position survived a reload at 150% exactly (scrollTop 12345→12345, scrollLeft 77→77). A code→pdf highlight lined up with the text-layer span to within 1px. A double-click in the PDF mapped back to the correct source line. Several v6 changes break older code, including Overleaf's current code. `PageViewport.convertToViewportRectangle` was removed in 6.1. `PDFDocumentProxy.destroy()` was removed in 6.0; call `loadingTask.destroy()` instead. The `isEvalSupported` option is gone and causes a TypeScript error. The modern build calls `Promise.try`, which Node 22.19 lacks, so Node code and tests must import 'pdfjs-dist/legacy/build/pdf.mjs'. The cmaps, standard_fonts, wasm and iccs folders must actually be served. Without wasm/qcms_bg.wasm, the user's paper logged ICC colour-space errors, because the single-page-app fallback returned index.html instead of the wasm file.

SyncTeX facts, checked against the TeX Live 2026 image (texlive/texlive:latest, synctex CLI 1.21, output format "version 1.5"). `synctex view -i line:column:[page_hint:]input -o out.pdf` returns one or more records with Page, x, y, h, v, W and H. Units are big points (72 per inch), with the origin at the page's top-left and y pointing down. x and y are the matched record's baseline point. h is the left edge of the enclosing box. v is that box's BOTTOM edge (baseline + depth), and H is height + depth, so the box top is v − H. `synctex edit -o page:x:y:out.pdf` returns Input (for example '/work/./main.tex'), Line, and Column = −1, because pdfTeX, XeTeX and LuaTeX record no columns. pdf.js conversions: synctex→CSS pixels is `viewport.convertToViewportPoint(viewBox[0]+X, viewBox[3]−Y)`. CSS pixels→synctex is `[xp,yp]=viewport.convertToPdfPoint(cx,cy); X=xp−viewBox[0]; Y=viewBox[3]−yp`. At rotation 0 this is simply X·s, Y·s with s = currentScale·96/72. The .synctex.gz file stores values in sp. From synctex_parser.c: unitBp = Unit/65781.76 × Magnification/1000, and xOffBp = XOffset × Unit/65781.76. XeLaTeX writes 'Output:xdv' and 'X Offset:4736287' / 'Y Offset:4736287', which is exactly 1in = 72bp. pdfTeX and LuaTeX write 0. A parser that ignores these offsets, such as LaTeX-Workshop's synctex.js, puts XeLaTeX boxes 72bp off.

Recommendation: parse .synctex.gz in TypeScript on the server, once per build, in a worker_thread with an LRU cache keyed by buildId. Keep the synctex CLI, run with `docker exec` in a warm, locked-down TeX Live container, as the fallback and as the golden-test oracle. Don't spawn a container per click. Measured on the user's 41-page XeLaTeX MDPI paper: the file is 586 KB gzipped, 2.85 MB and 108k lines unpacked. My ~280-line JS prototype parses it in 61–69 ms with about 22 MB of heap; each forward query takes about 0.27 ms and each inverse query about 0.08 ms. The CLI costs about 400 ms per `docker run`, about 60 ms per `docker exec`, and about 20 ms inside a running container. Compared with the CLI on all 1686 source lines and 864 clicked points of that paper, the prototype returns the same page 99.8% of the time. Its top-ranked forward box is one of the CLI's boxes 95% of the time. For clicks on text, the inverse gives the exact same line 98.3% of the time (98.9% within ±1 line); for clicks in margins or whitespace, 80% match. The npm synctex parsers (synctex-js 1.0.0 from 2019, @inkylabs/synctex-js 0.0.1) are unmaintained, so write our own. You can learn from LaTeX-Workshop's MIT-licensed synctexjs.ts/worker.ts, but fix its problems: it ignores Unit/Magnification, can't read '=' compressed points, and can't read column fields. Overleaf uses the CLI only (AGPL code): learn from its design only.

## [must] pdfjs-dist version, engines and runtime gotchas
Current version: pdfjs-dist 6.3.289 (npm dist-tags latest; releases roughly monthly: 6.0.227 on 2026-05-30, 6.1.200, 6.2.108, 6.3.289 on 2026-08-29). engines: node '>=22.13.0 || >=24'. optionalDependencies: @napi-rs/canvas ^1.0.0, needed only for Node-side rendering. The modern build (build/pdf.mjs, build/pdf.worker.mjs) calls Promise.try. In Node 22.19 that throws 'TypeError: Promise.try is not a function' (reproduced), so any Node or Vitest code must import 'pdfjs-dist/legacy/build/pdf.mjs'. Browsers: the v6 minimum is Chrome 125 / Safari 18 for the LEGACY build; the modern build needs current browsers (Chrome 128+ for Promise.try). v6 API changes that matter for us: (a) PDFDocumentProxy.destroy() removed, use pdfDocument.loadingTask.destroy() or keep the task; (b) getDocument() must be called with an object; (c) PageViewport.convertToViewportRectangle removed in 6.1.200, so use two convertToViewportPoint calls plus Util.normalizeRect; (d) the DocumentInitParameters 'isEvalSupported' is gone, and passing it is a TypeScript error (the PostScript function compiler is Wasm now); (e) page.render() takes { canvas, viewport }, and canvasContext is only kept for backwards compatibility; (f) getDestinations, getJSActions, getFieldObjects, getPermissions and markInfo now return Map/Set.
Sources: npm view pdfjs-dist version/time/engines, https://github.com/mozilla/pdf.js/releases/tag/v6.0.227, https://github.com/mozilla/pdf.js/pull/21245, https://github.com/mozilla/pdf.js/pull/21426, https://github.com/mozilla/pdf.js/pull/21152, node_modules/pdfjs-dist/types/src/display/api.d.ts

## [must] Worker setup with Vite (verified in dev and production build)
Tested and working with Vite 8.3.0:
```ts
import * as pdfjsLib from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { EventBus, LinkTarget, PDFLinkService, PDFViewer } from 'pdfjs-dist/web/pdf_viewer.mjs';
import 'pdfjs-dist/web/pdf_viewer.css';
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;
```
pdf.js itself calls `new Worker(workerSrc, { type: 'module' })`. `?url` resolves the bare specifier through Vite's resolver and emits `dist/assets/pdf.worker.min-<hash>.mjs` (1.27 MB). `new URL('pdfjs-dist/...', import.meta.url)` is not documented by Vite for bare specifiers, so prefer `?url`. Alternative: `GlobalWorkerOptions.workerPort = new Worker(new URL(...), { type: 'module' })` (Overleaf does this, with webpack). Add `/// <reference types="vite/client" />` for the `?url` types. Import order matters: pdf_viewer.mjs does `const {...} = globalThis.pdfjsLib` when it is evaluated, and pdf.mjs sets `globalThis.pdfjsLib`, so import 'pdfjs-dist' before 'pdfjs-dist/web/pdf_viewer.mjs' in the same module. Bundle sizes: main chunk 606 KB (182 KB gzip), pdf_viewer.css 230 KB. Load the preview component with dynamic import().
Sources: node_modules/pdfjs-dist/build/pdf.mjs (new Worker(workerSrc,{type:'module'})), node_modules/pdfjs-dist/web/pdf_viewer.mjs line ~92 (globalThis.pdfjsLib), https://vite.dev/guide/assets, Overleaf services/web/frontend/js/features/pdf-preview/util/pdf-js.ts

## [must] Serve pdf.js asset folders (cmaps, standard_fonts, wasm, iccs)
Pass to getDocument: `{ url, cMapUrl: '/pdfjs/cmaps/', cMapPacked: true, standardFontDataUrl: '/pdfjs/standard_fonts/', wasmUrl: '/pdfjs/wasm/', iccUrl: '/pdfjs/iccs/', enableXfa: false }`. Serve these from Express with `express.static(path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'wasm'))` and the same for the other folders. Sizes: cmaps 1.7 MB, standard_fonts 820 KB, wasm 1.6 MB (openjpeg.wasm, jbig2.wasm, qcms_bg.wasm, quickjs-eval.wasm), iccs 24 KB. Set Content-Type: application/wasm. Make sure the single-page-app fallback returns 404 for /pdfjs/*, not index.html. Reproduced on the user's paper: without the folder, the console showed 'Warning: ICCBased color space: CompileError: WebAssembly.Module(): expected magic word ... found 3c 21 64 6f' (that is '<!do', the HTML page), and ICC colour in the included figures failed. For Vite-only setups, vite-plugin-static-copy 4.1.1 (peer vite ^6||^7||^8) can copy the folders instead.
Sources: verified with Playwright against vite preview build, node_modules/pdfjs-dist/types/src/display/api.d.ts DocumentInitParameters, npm view vite-plugin-static-copy version

## [must] Use PDFViewer instead of hand-rolling (recommended setup code, type-checked with TypeScript 7.0.2)
Required: the container is an absolutely positioned, overflow:auto element holding <div class="pdfViewer"></div>. If it is not absolutely positioned, PDFViewer throws 'The `container` must be absolutely positioned.'
```ts
const eventBus = new EventBus();
const linkService = new PDFLinkService({ eventBus, externalLinkTarget: LinkTarget.BLANK, externalLinkRel: 'noopener noreferrer nofollow' });
const ac = new AbortController();
const viewer = new PDFViewer({ container, viewer: container.querySelector('.pdfViewer')!, eventBus, linkService,
  textLayerMode: 1 /*ENABLE*/, annotationMode: pdfjsLib.AnnotationMode.ENABLE /*links, no forms*/,
  annotationEditorMode: pdfjsLib.AnnotationEditorType.DISABLE /* -1 */, enableAutoLinking: false,
  ...( { abortSignal: ac.signal } as object) }); // abortSignal exists at runtime but is missing from the .d.ts
linkService.setViewer(viewer);
// load: viewer.setDocument(doc); linkService.setDocument(doc, null);
// teardown (React StrictMode-safe): viewer.setDocument(null); linkService.setDocument(null); ac.abort(); await loadingTask.destroy();
```
What you get: only visible pages render (getVisibleElements does a binary search on scroll, and the rendering queue renders visible pages first, then pre-renders the next page in the scroll direction). Page views are evicted from a buffer of max(10, 2·visible+1). HiDPI comes from OutputScale.pixelRatio = devicePixelRatio (verified: canvas 1920 px for 960 CSS px at DPR 2). maxCanvasPixels defaults to 4096·8192; beyond that it zooms the canvas with CSS and draws a detail canvas for the visible area (enableDetailCanvas defaults to true). Internal \ref and hyperref links navigate within the viewer. Events: pagesinit, pagerendered, textlayerrendered, pagechanging, scalechanging, updateviewarea. Full wrapper class: <scratch>
Sources: node_modules/pdfjs-dist/types/web/pdf_viewer.d.ts, node_modules/pdfjs-dist/web/pdf_viewer.mjs lines 7999-8080, 9152-9260, Overleaf pdf-js-wrapper.ts (design only), Playwright e2e run, Chrome 149 headless shell

## [must] Zoom (fit width / fit page / percent) and resize handling
`viewer.currentScaleValue = 'page-width' | 'page-fit' | 'page-height' | 'auto' | 'page-actual' | '1.25'` (numeric values as strings). `viewer.currentScale` (number) is relative to 96 dpi CSS: page CSS width = pageWidthPt × currentScale × 96/72, and pageView.viewport.scale = currentScale × PixelsPerInch.PDF_TO_CSS_UNITS (4/3). Presets use SCROLLBAR_PADDING 40 and VERTICAL_PADDING 5; 'auto' is min(1.25, width-fit). Stepping: viewer.increaseScale() / decreaseScale() use DEFAULT_SCALE_DELTA 1.1, clamped to MIN_SCALE 0.1 and MAX_SCALE 25. Measured on a 1000×800 window, A4: page-width → 1.2095, page-fit → 0.6797. PDFViewer's own ResizeObserver only updates the --viewer-container-height CSS variable; it does NOT re-fit. So re-apply presets yourself: `new ResizeObserver(() => requestAnimationFrame(() => { const v = viewer.currentScaleValue; if (['page-width','page-fit','page-height','auto'].includes(v)) viewer.currentScaleValue = v; viewer.update(); }))`. Overleaf uses rAF here to avoid 'ResizeObserver loop' errors. Show zoom in the UI from the 'scalechanging' event ({scale, presetValue}). Store the user's zoom (the preset string or a number) per project, e.g. in localStorage.
Sources: node_modules/pdfjs-dist/web/pdf_viewer.mjs #setScale (~line 8965), constants lines 162-170, Playwright measurement

## [should] HiDPI and devicePixelRatio changes
PDFViewer renders at devicePixelRatio automatically, but the component does not notice DPR changes (for example when the window moves to another monitor or the browser zoom changes). Watch it and refresh: `let mq; const arm = () => { mq?.removeEventListener('change', on); mq = matchMedia(`(resolution: ${devicePixelRatio}dppx)`); mq.addEventListener('change', on, { once: true }); }; const on = () => { viewer.refresh(); arm(); }; arm();`. Canvas limits: maxCanvasPixels defaults to 33.5 MP; Overleaf raises it to 8192·8192 except on Safari (4096·4096). capCanvasAreaFactor (default 200) caps canvas area to the screen area × 3. Keep the defaults to start with.
Sources: node_modules/pdfjs-dist/build/pdf.mjs class OutputScale, types/web/pdf_viewer.d.ts PDFViewerOptions, Overleaf pdf-js-wrapper.ts

## [must] Keep scroll position across recompiles (verified: scrollTop and scrollLeft identical after reload)
Before loading the new PDF, capture the PDF-space point at the container's top-left corner:
```ts
const c = container.getBoundingClientRect();
for (let i = 0; i < viewer.pagesCount; i++) { const pv = viewer.getPageView(i); const r = pv.div.getBoundingClientRect(); if (r.bottom < c.top) continue;
  const [left, top] = pv.viewport.convertToPdfPoint(c.left - r.left - pv.div.clientLeft, c.top - r.top - pv.div.clientTop); // clientLeft/Top = 9px page border
  saved = { page: i + 1, left, top, scaleValue: viewer.currentScaleValue }; break; }
```
Then register a one-shot 'pagesinit' handler, and call setDocument after it: `viewer.currentScaleValue = saved.scaleValue; viewer.scrollPageIntoView({ pageNumber: Math.min(saved.page, viewer.pagesCount), destArray: [null, { name: 'XYZ' }, saved.left, saved.top, null], allowNegativeOffset: true });`. scrollIntoView adds offsetTop + clientTop, so the restore is pixel-exact. To stop the scroll area collapsing and flickering, set `viewerEl.style.minHeight = currentHeight + 'px'` before setDocument and clear it in pagesinit (Overleaf's trick). Optionally wrap setDocument in `container.startViewTransition?.(...)` (element-scoped view transitions, Chrome 147+) for a crossfade. Guard races with a load sequence number: if a newer load started, call `await task.destroy()` and return. Destroy the previous loading task only after setDocument.
Sources: node_modules/pdfjs-dist/web/pdf_viewer.mjs scrollPageIntoView (~9040) and scrollIntoView (209), Overleaf pdf-js-wrapper.ts currentPosition/scrollToPosition (design), Playwright e2e: before {st:12345,sl:77,page 8/41} after {st:12345,sl:77}

## [should] PDF URLs, caching and loading options
Give every build an immutable URL, e.g. /api/projects/:id/builds/:buildId/output.pdf, with `Cache-Control: private, max-age=31536000, immutable`. Serve it with res.sendFile, which supports Range. Never serve a different PDF at the same URL: pdf.js range requests mixing the old and new file lead to corrupt-XRef errors. Serve output.synctex.gz next to it under the same buildId. For typical papers (300 KB–5 MB), `getDocument({ url, ...assets })` with the default range and streaming is fine. Overleaf adds `disableAutoFetch: true` plus a custom range transport for large PDFs; that isn't needed at first. Error UI: PasswordException, InvalidPDFException and ResponseException (with `.missing` for 404) are exported from pdfjs-dist.
Sources: Overleaf pdf-js.ts (getDocument options), node_modules/pdfjs-dist/types/src/pdf.d.ts exports

## [should] Page number indicator and navigation
`eventBus.on('pagechanging', ({ pageNumber, pageLabel, previous }) => setPage(pageNumber))` and `eventBus.on('pagesinit', () => setTotal(viewer.pagesCount))`. Go to a page with `viewer.currentPageNumber = n` (scrolls), or with viewer.nextPage() / previousPage(). Verified: the indicator showed '1 / 2' on the test document and '8 / 41' after scrolling the paper. PDFFindController gives Ctrl+F search inside the PDF if wanted later.
Sources: node_modules/pdfjs-dist/web/pdf_viewer.mjs dispatch('pagechanging'), Playwright e2e

## [must] code→PDF: drawing a highlight rectangle (verified to within 1px of the text-layer span)
From a synctex box {page, h, v, W, H} (bp from the top-left, v = bottom, H = height + depth):
```ts
const pv = viewer.getPageView(page - 1); const vp = pv.viewport; const [x0, , , y1] = vp.viewBox;
const p1 = vp.convertToViewportPoint(x0 + h, y1 - (v - H));
const p2 = vp.convertToViewportPoint(x0 + h + W, y1 - v);
const [l, t, r, b] = pdfjsLib.Util.normalizeRect([p1[0], p1[1], p2[0], p2[1]]); // W may be negative (RTL)
el.style.left = `${pv.div.offsetLeft + pv.div.clientLeft + l}px`; el.style.top = `${pv.div.offsetTop + pv.div.clientTop + t}px`;
el.style.width = `${r - l}px`; el.style.height = `${Math.max(b - t, 4)}px`;
(viewer.viewer as HTMLElement).append(el); // put the overlay in .pdfViewer, not in the page div
```
PDFPageView.reset() removes any unknown children of the page div on zoom or eviction, which is why the overlay goes in .pdfViewer. Clear highlights on 'scalechanging'. CSS: `position:absolute; pointer-events:none; background: rgb(255 235 59 / .45); transition: opacity 1s; z-index: 10`. Fade out after about 1.5 s. Scroll so the first box is centred: `container.scrollTo({ top: pv.div.offsetTop + pv.div.clientTop + t + (b - t)/2 - container.clientHeight/2 })`. Highlight every returned box, since a source line usually maps to several PDF lines. Don't copy Overleaf's `viewBox[3] + 10` fudge factor; the formula above is exact.
Sources: Overleaf frontend/js/features/pdf-preview/util/highlights.ts (design only), node_modules/pdfjs-dist/web/pdf_viewer.mjs PDFPageView.reset (~6850), Playwright: highlight [236,283,298] vs span [236,282,298]

## [must] PDF→code: mapping a double-click to synctex coordinates (verified)
Put one listener on the container. The text layer covers the canvas, so the event target is usually a span.
```ts
container.addEventListener('dblclick', (e) => {
  const pageDiv = (e.target as Element).closest<HTMLElement>('.page'); if (!pageDiv) return;
  const page = Number(pageDiv.dataset.pageNumber); const pv = viewer.getPageView(page - 1);
  const r = pageDiv.getBoundingClientRect();
  const [xp, yp] = pv.viewport.convertToPdfPoint(e.clientX - r.left - pageDiv.clientLeft, e.clientY - r.top - pageDiv.clientTop);
  const [x0, , , y1] = pv.viewport.viewBox;
  syncFromPdf({ page, x: xp - x0, y: y1 - yp, word: window.getSelection()?.toString() ?? '' });
});
```
The page div has a 9px transparent border (--page-border), so subtract clientLeft/clientTop. Verified: a double-click on 'so we can test…' gave {page:1, x:145.72, y:163.70}. `synctex edit -o 1:145.7186:163.7009:main.pdf` then returned Line:6, and the JS parser returned line 6 too. The double-click also selects a word ('we'). Send it along so the editor can place the cursor at that word's column, because synctex gives Column -1. LaTeX-Workshop uses selection.anchorNode text before and after the click for the same purpose.
Sources: LaTeX-Workshop viewer/components/synctex.ts (callSynctex), Overleaf pdf-js-wrapper.ts clickPosition, Playwright e2e + synctex CLI cross-check

## [nice] Hand-rolled alternative (only if PDFViewer is ever dropped); v6 API verified
Per page:
```ts
const viewport = page.getViewport({ scale: zoom * PixelsPerInch.PDF_TO_CSS_UNITS });
div.style.cssText = `width:${Math.floor(viewport.width)}px;height:${Math.floor(viewport.height)}px`;
div.style.setProperty('--total-scale-factor', String(viewport.scale)); // v5/v6 name; v4 used --scale-factor
// also define --scale-round-x:1px; --scale-round-y:1px on the page (setLayerDimensions uses CSS round())
const out = new OutputScale(); canvas.width = Math.floor(viewport.width*out.sx); canvas.height = Math.floor(viewport.height*out.sy);
await page.render({ canvas, viewport, transform: out.scaled ? [out.sx,0,0,out.sy,0,0] : undefined }).promise;
textDiv.className = 'textLayer'; // TextLayer does not add the class itself; CSS comes from pdf_viewer.css
await new TextLayer({ textContentSource: page.streamTextContent(), container: textDiv, viewport }).render();
```
Verified: 32 spans rendered, span left 222.9 px vs 223.0 px expected, canvas 1984 px for 992 CSS px. Lazy rendering would add: size placeholder divs from page.view (call getPage for every page up front), an IntersectionObserver with rootMargin '100% 0px', render on intersect, cancel the RenderTask and set canvas.width = 0 when far away, and reuse TextLayer.update({viewport}) on zoom. Prefer PDFViewer: these CSS variables changed in v4, v5 and v6, which shows how fragile hand-rolling is. Test page: <scratch>
Sources: node_modules/pdfjs-dist/types/src/display/text_layer.d.ts, node_modules/pdfjs-dist/build/pdf.mjs setLayerDimensions/TextLayer ctor, Playwright raw.html test

## [must] Compile flags and output files for SyncTeX
Compile with `latexmk -pdfxe -synctex=1 -interaction=nonstopmode -file-line-error main.tex` (the user's paper uses XeLaTeX; latexmk passes -synctex through). The engine writes `<jobname>.synctex.gz` next to the PDF (in the -outdir if one is given). Use a fixed jobname (e.g. -jobname=output, as Overleaf does) so the paths are stable: output.pdf and output.synctex.gz. -synctex=N: N<0 gives plain text; N>0 gives gzip; N&2 drops the .gz extension; N&4 enables pdfTeX forms; N&8 enables 'better compression', which produces ',=' compressed points (177 of them in the test file with -synctex=15). While running, TeX writes `<job>.synctex(busy)` and renames it at the end. After a crash only the (busy) file remains (seen when LuaLaTeX segfaulted). So publish the PDF and synctex as an atomic pair per buildId, and keep the previous pair if the build fails. Measured: the paper builds in about 10.5 s with latexmk + XeLaTeX in texlive/texlive:latest; the small test builds in 0.5 s.
Sources: synctex(1) man page (jlaurens/synctex man1/synctex.1), local runs in texlive/texlive:latest (TeX Live 2026, XeTeX 0.999998, latexmk 4.88)

## [must] synctex CLI syntax and output format (verified by running it)
Forward: `synctex view -i <line>:<column>:[<page_hint>:]<input> -o <output.pdf> [-d <dir>]`. Run it with cwd = build dir, and pass the input name as TeX saw it, e.g. 'main.tex' or 'chapters/intro.tex'; column can be 0. Output:
```
This is SyncTeX command line utility, version 1.5
SyncTeX result begin
Output:main.pdf
Page:1
x:142.679398
y:168.540710
h:133.768356
v:170.477890
W:343.711060
H:8.855677
before:
offset:-1
middle:
after:
Output:main.pdf   <- next record ...
SyncTeX result end
```
Semantics (from synctex_main.c): x = visible_h(node) and y = visible_v(node), the matched record's point on the baseline. h = box_visible_h (left). v = box_visible_v + box_visible_depth, the BOTTOM of the box. W = box width (can be negative). H = height + depth. Rectangle: left = h, top = v − H, width = W, height = H. All values in bp (1/72 in) from the page's top-left, y down. Inverse: `synctex edit -o <page>:<x>:<y>:<output.pdf>`, with page 1-based and x, y in bp from the top-left. Output:
```
SyncTeX result begin
Output:main.pdf
Input:/work/./main.tex
Line:6
Column:-1
Offset:0
Context:
SyncTeX result end
```
It can print two records (the left and right neighbour of the click). Parse the output generically: split lines at the first ':', and each 'Output:' starts a new record. Note: a line inside a TikZ picture returned up to 453 records, so cap the results (e.g. at 50) and set maxBuffer. Normalise Input with path.posix.normalize ('/work/./main.tex' → '/work/main.tex'), then make it relative to the build root.
Sources: https://github.com/jlaurens/synctex/blob/main/synctex_main.c (synctex_help_view/edit, lines ~700-760, ~1000-1018), docker run texlive/texlive:latest synctex view/edit on test + paper, Overleaf services/clsi/app/js/SynctexOutputParser.js (design)

## [must] Exact coordinate formulas (from synctex_parser.c synctex_scanner_parse, verified numerically)
Constants: SP_PER_BP = 65781.76 (= 65536 × 72.27/72). The preamble gives Unit (defaults to 8192 if ≤0; always 1 in modern engines), Magnification (defaults to 1000), 'X Offset' and 'Y Offset' (in the same units).
 unitBp = (postMag || 1) × Unit / 65781.76 × Magnification / 1000
 xOffBp = XOffset × Unit / 65781.76;  yOffBp = YOffset × Unit / 65781.76   (no magnification applied)
 A Post scriptum section, written by `synctex update`, overrides these; its X/Y Offset are dimensions that are converted to sp and then divided by 65781.76. It is rare; you can skip it at first.
 Record point: X = h·unitBp + xOffBp; Y = v·unitBp + yOffBp (bp, top-left origin).
 Box: left = X(h); baseline = Y(v); top = baseline − H·unitBp; bottom = baseline + D·unitBp; width = W·unitBp.
 Inverse hit in sp: h = (x − xOffBp)/unitBp; v = (y − yOffBp)/unitBp.
Engine differences measured: pdfTeX and LuaTeX write 'Output:pdf', X/Y Offset 0. XeTeX writes 'Output:xdv', 'X Offset:4736287', 'Y Offset:4736287' (= 72.00000426 bp = 1in). Checked on the paper: synctex boxes for lines 134, 158 and 400 enclose exactly the text pdf.js reports at those positions. With viewBox [0,0,595.276,841.89] (A4), pdf.js text 'Hello world…' has x = 133.77 and baseline y (top-left) = 156.59, which matches synctex h = 133.768 and y = 156.586.
Sources: https://github.com/jlaurens/synctex/blob/main/synctex_parser.c lines 6750-6835, 7309-7311, zcat of generated .synctex.gz files (pdfTeX, XeTeX, LuaTeX), coord.mjs/coord2.mjs pdf.js cross-check

## [must] .synctex(.gz) file format as actually emitted (TeX Live 2026)
Preamble: 'SyncTeX Version:1', 'Input:<tag>:<path>' lines, 'Output:pdf|xdv', 'Magnification:1000', 'Unit:1', 'X Offset:<sp>', 'Y Offset:<sp>', then 'Content:'. Content: '!<bytes>' anchors (ignore); '{<page>' / '}<page>' open and close a sheet; '[' vbox and '(' hbox open, with `<tag>,<line>[,<column>]:<h>,<v>:<W>,<H>,<D>`; ']' and ')' close them. Leaf records: 'x' current point `x<link>:<h>,<v>`, 'g' glue, '$' math (same shape), 'k' kern `k<link>:<h>,<v>:<W>`, 'r' rule `r<link>:<h>,<v>:<W>,<H>,<D>` (not in the man page but present: 1509 in the paper), 'h'/'v' void hbox and vbox (box shape). Forms: '<tag' / '>' blocks and 'f<tag>:<point>' references (pdfTeX with -synctex&4 only). 'Input:' lines ALSO appear inside the content, for files first read after page 1 (e.g. main.aux), and the same file can have two tags (antiddos_v2.aux had tags 226 and 242). Points can be compressed as 'h,=' (v equals the last full v). Postamble: 'Postamble:', 'Count:<n>', then optionally 'Post scriptum:'. Paper statistics: 108,162 lines; 41k x, 26k k, 13.6k g, 10.5k hboxes, 1.5k r, 1.1k $, 1.2k h; 242 inputs. Parse the file as latin1 (byte-preserving), then decode Input paths as UTF-8 via Buffer.from(p, 'latin1').toString('utf8'). One regex covers every record:
`/^([\[\(hvxkg$r])(\d+),(-?\d+)(?:,(-?\d+))?:(-?\d+),(-?\d+|=)(?::(-?\d+)(?:,(-?\d+),(-?\d+))?)?/`
(groups: type, tag, line, column?, h, v|'=', W?, H?, D?)
Sources: synctex(5) man page (jlaurens/synctex man5/synctex.5), generated files: stx/main.synctex.gz, stx15/main.synctex, paper/antiddos_v2.synctex.gz

## [must] TS parser design (prototype in scratch; about 280 lines)
Data model: node {t, tag, line, col, h, v, W?, H?, D?, parent, kids?, page}. Maintain byTag: Map<tag, Map<line, node[]>> (the 'friend' index), maxLine per tag, hboxesByPage, pages: Map<page, root>. Hboxes carry VISIBLE extents (vh, vv, vW, vH, vD), initialised from the declared box and then enlarged the way the C code does. For 'x', 'g' and '$' children, make the parent hbox contain the point. For 'k', contain [h−W, h] (a kern's position is recorded AFTER the move). For a void 'h' box, contain its box. When a child hbox closes, the parent hbox contains the child's visible box. Rules are NOT added (the C code comments 'Rules are sometimes far too big'). Also add C-style boundary pseudo-leaves: at hbox open, a leaf at (h, v) with the hbox's tag/line; at hbox close, a leaf at (vh + vW, vv) with the last child's tag/line. This raised agreement with the CLI. Memory: plain objects cost about 22 MB of heap for 108k records. For thesis-size documents (about 1M records), switch to struct-of-arrays (Int32Array h, v, W, H, D, tag, line, parent; Uint8Array type), about 40 bytes per record. Gunzip safely: `zlib.gunzipSync(buf, { maxOutputLength: 256 << 20 })` (throws ERR_BUFFER_TOO_LARGE; verified), or stream with zlib.createGunzip() + readline. Run the parse in a worker_thread; cache with lru-cache 11.5.3 keyed by buildId (max 3–5). Prototype: <scratch>
Sources: synctex_parser.c _synctex_make_hbox_contain_point/_box (5300-5370), content scanner (5960-6320), prototype benchmarks

## [must] Forward search algorithm (line → boxes), matching the C tool
1) Resolve the input tag(s) for the file: normalise both paths and match an exact path or a '/'+relative suffix. Skip tags outside the project. 2) L = min(line, maxLine(tag)). Try lines in the order L, L+1, L−1, L+2, L−2, … for up to 100 tries: `L += off; off = off < 0 ? -(off-1) : -(off+1); if (L <= 0) { L += off; off = ...same }`, starting with off = 1. For each L, first take the matching NON-box nodes (x, k, g, $, r, boundary). If there are none, take the box nodes with that tag/line instead. Stop at the first L that has any hits. 3) Group the hits by page; order pages by |page − pageHint| (the current page in the viewer, or 0). 4) Within a page, group by the enclosing box (the parent for leaves, the node itself for boxes); weight = number of matching nodes in that box; sort by weight descending. This is C's _synctex_vertically_sorted_v2 (C then climbs from that box to hbox ancestors whose mean line is within ±1 unless the ancestor is larger than 1,500,000 sp; that step is optional). 5) Return per box {page, h: vh·u + xOff, v: (vv + vD)·u + yOff, W: vW·u, H: (vH + vD)·u}, which has the same shape as the CLI output. Checked on the small test: [page 1, h 133.768, v 170.478, W 343.711, H 8.856] and [v 158.523], the same values and order as the CLI.
Sources: synctex_parser.c synctex_iterator_new_display (8264-8348), _synctex_display_query_v2 (8190), _synctex_vertically_sorted_v2 (7872), _synctex_node_box_visible (7554)

## [must] Inverse search algorithm (page, x, y → file:line), matching the C tool
1) Convert the click to sp: hit = ((x − xOffBp)/u, (y − yOffBp)/u). 2) Among the page's hboxes, find those whose visible box contains the hit, and take the smallest by area |vW|·(|vH|+|vD|). Ties go to the larger |W|, then the smaller total height (C: _synctex_smallest_container_v2). 3) Descend to the deepest container: recurse into any child box that contains the hit. For a vbox, pick the child with children that is nearest by point–node distance (C: _synctex_eq_deepest_container_v2). 4) In that hbox, scan the children with the h-ordered distance d. Box: 0 inside, min−h if the hit is to the left (>0), max−h if to the right (<0). Kern: the span is [h−W, h], and inside it the distance is measured to the nearer edge ±1. Points (x, g, $): h − hit.h. Keep l = the closest child with d ≤ 0 and r = the closest with d > 0; on equal distance prefer the smaller line, then the smaller column. Narrow l and r to their deepest container or closest deep child. For a vbox, do the same with the vertical distance, using the parent's height and depth for leaves. 5) If l and r differ in tag, line or column, return both, the one with the smaller line first; on the same line, return the closer one first. If they are equal, return the closer one. 6) If no hbox contains the hit (margins, whitespace), return the node on the whole page closest by L1 box distance. Then map the tag to its path, make it relative to the project, and if it is outside the project (texmf .sty/.cls) try the next candidate. Cost: about 0.08 ms per query on the paper.
Sources: synctex_parser.c synctex_iterator_new_edit (~8060-8180), _synctex_point_h/v_ordered_distance_v2 (8397, 8538), __synctex_eq_get_closest_children_in_hbox_v2 (8919)

## [must] Validation of the JS parser against the synctex CLI on the user's real paper
Inputs: antiddos_v2.tex (1686 lines, XeLaTeX, MDPI class, TikZ/pgfplots, 41 pages). CLI outputs came from one container running `synctex view` for every line and `synctex edit` for 864 grid points (pages 1, 2, 3, 5, 8, 12, 20, 30, 41). FORWARD: 1597 comparable lines (89 lines had no result in either). Same page for the first result: 1594 (99.8%). The JS first box is one of the CLI boxes: 1518 (95.1%). The first boxes overlap vertically: 1390 (87%). Every CLI box is covered by the JS result set: 1364 (85%). The differences are mostly in how boxes are ranked and in the visible-box width and height, not in the line chosen. INVERSE: 362 points on text (inside an hbox): exact line 356 (98.3%), within ±1 line 358 (98.9%). 502 points in margins or blank areas: exact line 403 (80%). Overall: 759/864 exact, 829/864 within ±1. Keep these scripts as a CI golden test (JS vs CLI) whenever the parser changes. Scripts: <scratch> cmp3.mjs, cmp4.mjs (CLI dumps are in paper/fwd.out and paper/inv.out).
Sources: local experiment in scratchpad/pdfsync_research

## [should] Performance: CLI vs JS
Measured on this machine. `docker run --rm texlive/texlive:latest synctex edit ...` takes about 0.40 s wall time per call, too slow to spawn per click. `docker exec <warm container> synctex view|edit` takes about 0.06 s. Inside a running container each call takes about 20 ms (57 s for 2550 calls), because the CLI re-parses the 586 KB gzip file every time. The JS parser takes 61–69 ms once per build, then 0.27 ms per forward query and 0.08 ms per inverse query. The synctex binary in the image (/usr/local/texlive/2026/bin/x86_64-linux/synctex, 198 KB) links only libc and libm, with zlib and kpathsea static, so it could be copied out and run on the host. Don't do that: it would parse user-influenced files natively outside the sandbox.
Sources: local timing runs, ldd inside texlive/texlive:latest

## [must] Recommendation: JS parser on the server first, CLI as fallback and test oracle
Primary: the SynctexService in the Node backend loads builds/<buildId>/output.synctex.gz on the first sync request (or right after the build), parses it in a worker_thread, and caches it with an LRU by buildId. Endpoints: `GET /api/projects/:pid/builds/:bid/sync/code?file=<rel>&line=<1-based>&column=<0>&page=<hint>` returns `[{page,h,v,width,height}]`. `GET /api/projects/:pid/builds/:bid/sync/pdf?page=&x=&y=` returns `[{file,line,column}]`. Fallback: if the JS parse throws or returns nothing, run the CLI in a warm, locked-down tools container started from the same image: `docker run -d --name tex-sync --network none --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 256m -u 1000:1000 -v <buildsRoot>:/builds:ro texlive/texlive:latest sleep infinity`. Call it from Node with `execFile('docker', ['exec','-w',`/builds/${bid}`,'tex-sync','synctex','view','-i',`${line}:${col}:${file}`,'-o','output.pdf'], { timeout: 5000, maxBuffer: 8 << 20 })`. Validate file, line, page and x/y strictly: integers only, file path relative and inside the project. Don't use CLI-only: that would require docker per click (60–400 ms), exposes C parsing to crafted files (users can upload any file, including one named *.synctex.gz), and allows no custom ranking such as the page hint from the viewer. Don't use JS-only either: keep the CLI as ground truth for edge cases (pdfTeX forms, post scriptum offsets) and for CI golden tests. Optional alternative: parse on the client in a Web Worker (fetch the immutable .synctex.gz and pipe it through `DecompressionStream('gzip')`) for zero round-trip latency.
Sources: measurements above, Overleaf CLSI CompileManager.js syncFromCode/syncFromPdf (CLI-only design), LaTeX-Workshop src/locate/synctex.ts (CLI first for forward, synctex.js only for backward)

## [should] LaTeX-Workshop synctex.js (MIT): what it does and what to fix
src/locate/synctex/synctexjs.ts is derived from tdurieux/synctex-js (MIT, 2018). It splits lines and uses regexes per record type; divides every value by 65781.76; builds `blockNumberLine[filePath][line][page] = Block[]` for leaf elements and `hBlocks`; reads X/Y Offset. Forward (worker.ts syncTeXToPDF): sort the known line numbers, find the first ≥ the target line, take the rectangle around that line's blocks on its first page (skipping blocks with children, 'k' and 'r'), and if the line has no records, interpolate the y position between the neighbouring lines. Inverse (syncTeXToTeX): loop over every leaf block on the page, rect = [left, bottom − parent.height, left + width, bottom]; keep a candidate if the current best rectangle contains it, or if it is closer by centre distance and does not itself contain the best. The extension actually uses the CLI first for forward sync (it falls back to JS on error) and JS only for backward sync, because the binary fails on CJK path encodings (issue #4239). It also tries iconv decodings of paths. Gaps to fix in our port: Unit and Magnification are ignored; the ',=' compressed v isn't supported; the ',column' link field isn't supported; 'r' rules and void boxes are treated as generic elements; visible hbox extents are missing; and its inverse heuristic is weaker than C's l/r neighbour logic. Re-implement it, don't copy it, or keep the MIT notice if you vendor any of it.
Sources: https://raw.githubusercontent.com/James-Yu/LaTeX-Workshop/master/src/locate/synctex/synctexjs.ts, https://raw.githubusercontent.com/James-Yu/LaTeX-Workshop/master/src/locate/synctex/worker.ts, https://raw.githubusercontent.com/James-Yu/LaTeX-Workshop/master/src/locate/synctex.ts

## [should] Existing npm synctex parsers: don't use them
npm search results: synctex-js 1.0.0 (MIT, published 2019, corwin-of-amber fork of tdurieux, no updates since) and @inkylabs/synctex-js 0.0.1 (MIT, a single release in 2024). The other hits are unrelated (MCP servers, WASM TeX engines). Both parsers have the same gaps as LaTeX-Workshop's (no Unit, Magnification or '=' support). Write our own module, around 400 lines of TS with tests.
Sources: npm search synctex --json, npm view synctex-js / @inkylabs/synctex-js

## [should] Path mapping and column refinement
The Input paths in the synctex file are absolute inside the compile container, e.g. '/work/./antiddos_v2.tex' and '/work/./Definitions/mdpi.cls', plus texmf files under /usr/local/texlive/2026/texmf-dist/. Normalise with path.posix.normalize, strip the container build root to get the project-relative path, and treat anything outside it as 'not navigable'. On inverse, if the best hit is a texmf file, fall back to the second candidate or to the nearest node from a project file. Clicks on MDPI running headers map to Definitions/mdpi.cls (inside the project, so that's fine). Column is always −1 from pdfTeX, XeTeX and LuaTeX. Refine it in the editor: search the target line, then ±2 lines, for the word selected by the double-click (window.getSelection().toString()), and put the cursor there. Otherwise go to the start of the line. Flash the line in CodeMirror, e.g. with a Decoration.line class that fades out.
Sources: generated synctex files, LaTeX-Workshop openTeX/getRowAndColumn approach

## [nice] Stale line numbers after editing (optional improvement)
SyncTeX lines refer to the source as it was compiled. If the user edits after compiling, forward and inverse results drift. Overleaf ignores this. A cheap fix with Yjs: when a compile starts, store a Y.snapshot / state vector, or Y.RelativePosition anchors at each line start of the compiled text. To go from a current line to a compiled line and back, map through relative positions (Y.createRelativePositionFromTypeIndex / Y.createAbsolutePositionFromRelativePosition), or diff the compiled text against the current text. Or simply show a 'PDF is out of date' hint and recompile.
Sources: design suggestion

## [nice] Test tooling note: Playwright version that matches the cached Chromium
The cached browsers are ~/.cache/ms-playwright/chromium-1228 and chromium_headless_shell-1228 (Chrome for Testing 149.0.7827.55). That revision belongs to playwright / @playwright/test 1.61.0; the latest is 1.63.0, which wants chromium 1243 and would download it. Either pin @playwright/test@1.61.0, or use playwright-core with `chromium.launch({ executablePath: ~/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell })`; the second is what I used. The Vite dev server re-optimises dependencies on the first visit and reloads the page once, so wait for your own ready-promise after a reload, or warm the server up first. Other agents in this workspace also run Vite (one holds port 5199), so use unique ports.
Sources: npm pack playwright-core@1.61.0 browsers.json, local e2e runs

## [should] React integration notes
Create one PdfPreview per mount in `useEffect(() => { const p = new PdfPreview(ref.current!); ...; return () => p.destroy(); }, [])`. It must survive StrictMode's double mount: the teardown aborts the AbortController passed as abortSignal, calls viewer.setDocument(null), disconnects its own ResizeObserver and the DPR MediaQueryList, and destroys the loading task. When a new build arrives, call `p.load(buildPdfUrl, { keepPosition: true })`. Expose onPageChange and onSyncFromPdf callbacks to React state. Don't re-render the viewer DOM from React (PDFViewer owns .pdfViewer's children). Load the preview module with React.lazy or dynamic import, because pdfjs adds about 600 KB plus 230 KB of CSS. react-pdf 11.0.0 (pins pdfjs-dist 6.3.289) is an alternative, but it has no built-in virtualisation, XYZ position restore or synctex hooks, so skip it.
Sources: npm view react-pdf version dependencies, viteapp/src/main.ts harness

## Packages
- pdfjs-dist@6.3.289 (Apache-2.0) — PDF rendering: core API plus the PDFViewer, EventBus and PDFLinkService components (pdfjs-dist/web/pdf_viewer.mjs) and the text layer engines node >=22.13.0; the modern build needs Promise.try, so use legacy/build/pdf.mjs in Node 22 and Vitest; serve cmaps, standard_fonts, wasm and iccs; the worker comes from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
- vite@8.3.0 (MIT) — Frontend bundler; the ?url worker import was verified in dev and build The config must be ESM ('type':'module') to use import.meta.resolve
- @vitejs/plugin-react@6.1.1 (MIT) — React support for Vite 
- react@19.3.0 (MIT) — UI framework (context) 
- typescript@7.0.2 (Apache-2.0) — Type checking (native Go compiler) Needs the optional platform package @typescript/typescript-linux-x64; don't install with --omit=optional. PdfPreview.ts type-checks cleanly against the pdfjs-dist 6.3.289 types
- vite-plugin-static-copy@4.1.1 (MIT) — Optional: copy pdfjs-dist cmaps, standard_fonts, wasm and iccs into the build output if Express doesn't serve them peer vite ^6 || ^7 || ^8
- lru-cache@11.5.3 (BlueOak-1.0.0) — Per-build cache of parsed SyncTeX indexes on the server 
- playwright-core@1.61.0 (Apache-2.0) — E2E tests using the cached chromium-1228 (Chrome 149) without downloading a browser Latest is 1.63.0 (chromium 1243); or keep 1.63 and pass executablePath
- synctex-js@1.0.0 (MIT) — Evaluated and rejected: old JS synctex parser Last published 2019; no Unit/Magnification or '=' support; don't use
- @inkylabs/synctex-js@0.0.1 (MIT) — Evaluated and rejected A single 2024 release; unmaintained
- react-pdf@11.0.0 (MIT) — Evaluated and not recommended (per-page React components) Pins pdfjs-dist 6.3.289; lacks PDFViewer's virtualisation, XYZ position restore and synctex integration

## Risks
- pdfjs-dist moves fast (monthly releases, frequent [api-minor] changes; convertToViewportRectangle and PDFDocumentProxy.destroy were removed in 6.x), so pin the exact version and wrap all pdf.js calls in one PdfPreview module.
- Node-side pdf.js (tests, thumbnails) must use 'pdfjs-dist/legacy/build/pdf.mjs' because the modern build calls Promise.try, which Node 22.19 lacks.
- If the /pdfjs/wasm, iccs, cmaps and standard_fonts assets are not served, or the single-page-app fallback returns index.html for them, colours and images in included figures render wrong; this was reproduced with the user's paper (ICCBased colour-space wasm CompileError).
- pdf_viewer.mjs depends on globalThis.pdfjsLib being set first, and on an absolutely positioned container; either one missing gives runtime errors that are confusing.
- Reusing the same PDF URL across builds can corrupt range-request loading; per-build immutable URLs are required.
- The JS SyncTeX parser is an approximation of the C tool (about 95% first-box agreement forward, 98% same line for inverse clicks on text, 80% in margins), so keep the CLI fallback and golden tests; pdfTeX \pdfxform forms (-synctex&4) and post-scriptum offsets aren't handled by the prototype.
- Large documents (1M+ synctex records) with plain JS objects may use hundreds of MB; use a typed-array layout and a worker_thread, and cap gunzip with maxOutputLength.
- A failed or crashed compile leaves '<job>.synctex(busy)' and no .synctex.gz; always pair the PDF and synctex per build, and keep the last good pair.
- Line numbers drift once the user edits after compiling (the same limitation as Overleaf); map through Yjs relative positions or flag the PDF as stale.
- For the compile area: LuaLaTeX segfaulted (exit 139) in texlive/texlive:latest when run as -u 1000:1000 even with HOME=/tmp; it works with -e TEXMFVAR=/tmp/texmf-var, or as root.
- The shared scratchpad is used by other agents at the same time (one overwrote a 'paper' folder there, and another holds Vite port 5199); my research files are in scratchpad/pdfsync_research.
