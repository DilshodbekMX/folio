/**
 * @folio/shared/synctex — SyncTeX parsing and forward/inverse search (browser-safe).
 *
 *   const idx = parseSynctexText(gunzipSync(buf, { maxOutputLength }).toString('latin1'))
 *   forwardSearch(idx, '/compile/./main.tex', 42)          // → PdfRect[] (top-left origin, pt)
 *   inverseSearch(idx, 3, 120.5, 300.2)                    // → [{ input, line, column }]
 *
 * Input paths are matched as recorded in the file (e.g. '/compile/./main.tex'); a relative
 * path such as 'main.tex' also matches by suffix. Mapping to project paths is the caller's job.
 *
 * Beyond SPEC §5: forwardSearch takes optional { pageHint, maxResults }, inverseSearch an
 * optional { accept(input) } filter (e.g. project files only, falling back to the nearest
 * accepted record), and forwardSearchBoxes returns the synctex CLI's box shape (for goldens).
 * Agreement with synctex CLI 1.5 on the real paper (1597 lines, 416 clicks): same first page
 * 99.8 %, first box overlapping a CLI box 99.4 %, same line for clicks on text 100 %.
 */
export { parseSynctex, parseSynctexText, NodeType, SP_PER_BP } from './parser.ts'
export type { SynctexIndex, ParseSynctexOptions } from './parser.ts'
export {
  forwardSearch, forwardSearchBoxes, inverseSearch, listInputs, findInputTags, normalizeSynctexPath,
  boxToRect, boxOf, synctexPages,
} from './search.ts'
export type { SynctexBox, InverseResult, ForwardOptions, InverseOptions } from './search.ts'
