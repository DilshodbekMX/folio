/**
 * SyncTeX between the editor and the PDF (SPEC §6.8).
 *
 *   syncCodeToPdf()  editor cursor → GET synctex/code → scroll the PDF to the first box and draw
 *                    fading highlight boxes (divider → arrow, editor "Jump to location in PDF").
 *   syncPdfToCode()  middle of the most visible PDF area — or the spot the user last
 *                    double-clicked, if the PDF has not moved since — → GET synctex/pdf →
 *                    useEditor.jumpTo (divider ← arrow).
 *   syncFromDoubleClick()  double-click anywhere on a page (text layer included) → code.
 *
 * Engines record no columns (the API returns 0), and the line is often the end of the paragraph,
 * so the position is refined by looking for the double-clicked word around the target line and
 * upwards to the start of its paragraph, using the text before it in the PDF to pick between
 * repeated words (wordMatch.ts).
 *
 * "Nothing found" is reported with a toast and the promise resolves normally (the divider shows
 * its own error toast only for rejections, i.e. real failures).
 */
import type { CompileResponse, FileEntry, SyncPdfToCodeResponse } from '@folio/shared/api'
import { api } from '../../api/endpoints'
import { errorMessage } from '../../api/client'
import { docSessions } from '../../realtime/docs'
import { openRootFileId, useCompile } from '../../stores/compile'
import { useEditor } from '../../stores/editor'
import { useLayout } from '../../stores/layout'
import { useProject } from '../../stores/project'
import { toast } from '../../ui'
import type { PdfDoubleClick, PdfPoint } from './viewer/PdfController'
import { getPdfController, usePdfView, whenPdfShown } from './viewer/store'
import { normalizeWord, refineWordPosition, type WordPosition } from './wordMatch'

const TOAST_ID = 'synctex'

/** a double-click remembered for the ← arrow while the PDF stays where it was */
let lastClick: { point: PdfPoint; word: string; before: string; signature: string } | null = null
let codeSeq = 0
let pdfSeq = 0

function notFound(message: string): void {
  toast(message, { tone: 'warning', id: TOAST_ID })
}

/** Coordinates for the API: plain decimals with at most 3 fraction digits (never exponent notation). */
function coord(v: number): number {
  const r = Math.round(v * 1000) / 1000
  return Object.is(r, -0) ? 0 : r
}

/** The build whose PDF is (or is about to be) on screen, if it has SyncTeX data. */
function syncBuild(): CompileResponse | null {
  const st = useCompile.getState()
  const build = st.lastWithPdf
  if (!build || !build.buildId || !build.hasSynctex) return null
  return build
}

/** Make the PDF visible (layout, logs pane, history) and wait until it can be laid out. */
async function revealPdf(): Promise<void> {
  const layout = useLayout.getState()
  if (layout.historyOpen) layout.setHistoryOpen(false)
  if (layout.view === 'editor') layout.setView('split')
  const compile = useCompile.getState()
  if (compile.logsOpen) compile.setLogsOpen(false)
  await getPdfController()?.whenUsable()
}

function revealEditor(): void {
  const layout = useLayout.getState()
  if (layout.historyOpen) layout.setHistoryOpen(false)
  if (layout.view === 'pdf') layout.setView('split')
}

/** Editor cursor position (1-based line, 0-based column) in the open text file. */
function cursorPosition(): { file: FileEntry; line: number; column: number } | null {
  const ed = useEditor.getState()
  const fileId = ed.openFileId
  if (!fileId) return null
  const file = useProject.getState().files[fileId]
  if (!file || file.kind !== 'text') return null
  if (ed.cursor && ed.cursor.fileId === fileId) return { file, line: ed.cursor.line, column: ed.cursor.column }
  const view = ed.view
  if (view) {
    const head = view.state.selection.main.head
    const line = view.state.doc.lineAt(head)
    return { file, line: line.number, column: head - line.from }
  }
  return { file, line: 1, column: 0 }
}

/** Code → PDF: highlight the PDF location of the editor cursor. */
export async function syncCodeToPdf(): Promise<void> {
  const pid = useProject.getState().projectId
  if (!pid) return
  const pos = cursorPosition()
  if (!pos) {
    notFound('Open a .tex file and place the cursor where you want to look in the PDF.')
    return
  }
  const build = syncBuild()
  if (!build || !build.buildId) {
    notFound(useCompile.getState().lastWithPdf ? 'This PDF has no SyncTeX data. Recompile and try again.' : 'Compile the project first — SyncTeX needs a PDF.')
    return
  }
  const seq = ++codeSeq
  const buildId = build.buildId
  const [res] = await Promise.all([
    api.syncCode(pid, { buildId, path: pos.file.path, line: pos.line, column: pos.column }),
    revealPdf(),
  ])
  if (seq !== codeSeq || useProject.getState().projectId !== pid) return
  if (res.pdf.length === 0) {
    // the PDF on screen may be of another document (the project has several with \documentclass)
    const project = useProject.getState()
    const targetId = openRootFileId() ?? project.settings?.rootFileId
    const target = targetId ? project.files[targetId]?.path : undefined
    notFound(
      build.rootPath && target && target !== build.rootPath
        ? `The PDF shows ${build.rootPath}. Recompile to build ${target}, then try again.`
        : `Couldn’t find line ${pos.line} of ${pos.file.path} in the PDF. It may not produce any output, or the PDF is out of date — recompile and try again.`,
    )
    return
  }
  if (!(await whenPdfShown(buildId, 15_000))) {
    notFound('The PDF changed before the location could be shown. Try again.')
    return
  }
  if (seq !== codeSeq) return
  await getPdfController()?.whenUsable()
  const drawn = getPdfController()?.highlight(res.pdf) ?? 0
  if (drawn === 0) notFound('Couldn’t show that location in the PDF. Recompile and try again.')
}

/** PDF → code: move the editor to the source of the visible PDF area (or the last double-click). */
export async function syncPdfToCode(): Promise<void> {
  const ctrl = getPdfController()
  const view = usePdfView.getState()
  if (!ctrl || !ctrl.hasDocument || view.status !== 'ready' || !view.buildId) {
    notFound('Compile the project first — SyncTeX needs a PDF.')
    return
  }
  const build = useCompile.getState().lastWithPdf
  if (build?.buildId === view.buildId && !build.hasSynctex) {
    notFound('This PDF has no SyncTeX data. Recompile and try again.')
    return
  }
  let point: PdfPoint | null = null
  let word = ''
  let before = ''
  if (lastClick && lastClick.signature === ctrl.scrollSignature()) {
    point = lastClick.point
    word = lastClick.word
    before = lastClick.before
  } else {
    if (useLayout.getState().view === 'editor' || useCompile.getState().logsOpen) {
      await revealPdf()
    }
    point = ctrl.visibleCenter()
  }
  if (!point) {
    notFound('Show the PDF to find its location in the code.')
    return
  }
  await syncPointToCode(view.buildId, point, word, before)
}

/** Double-click in the PDF (text layer or not) → jump to the source. */
export function syncFromDoubleClick(p: PdfDoubleClick): void {
  const ctrl = getPdfController()
  const buildId = usePdfView.getState().buildId
  if (!ctrl || !buildId) return
  const point: PdfPoint = { page: p.page, x: p.x, y: p.y }
  lastClick = { point, word: p.word, before: p.before, signature: ctrl.scrollSignature() }
  const build = useCompile.getState().lastWithPdf
  if (build?.buildId === buildId && !build.hasSynctex) {
    notFound('This PDF has no SyncTeX data. Recompile and try again.')
    return
  }
  syncPointToCode(buildId, point, p.word, p.before).catch(e => {
    toast(`SyncTeX didn’t work: ${errorMessage(e)}. Recompile and try again.`, { tone: 'error', id: TOAST_ID })
  })
}

async function syncPointToCode(buildId: string, point: PdfPoint, word: string, before: string): Promise<void> {
  const pid = useProject.getState().projectId
  if (!pid) return
  const seq = ++pdfSeq
  const res: SyncPdfToCodeResponse = await api.syncPdf(pid, { buildId, page: point.page, x: coord(point.x), y: coord(point.y) })
  if (seq !== pdfSeq || useProject.getState().projectId !== pid) return
  const project = useProject.getState()
  let target: { file: FileEntry; line: number } | null = null
  for (const hit of res.code) {
    const file = (hit.fileId ? project.files[hit.fileId] : undefined) ?? project.fileByPath(hit.path)
    if (file && file.kind === 'text') {
      target = { file, line: Math.max(1, hit.line) }
      break
    }
  }
  if (!target) {
    notFound(
      res.code.length > 0
        ? 'That part of the PDF comes from a file outside the project (a package or class file).'
        : 'Couldn’t find the corresponding source location. Recompile and try again.',
    )
    return
  }
  let line = target.line
  let column: number | undefined
  if (word) {
    const refined = await refineColumn(pid, target.file, line, word, before).catch(() => null)
    if (seq !== pdfSeq) return
    if (refined) {
      line = refined.line
      column = refined.column
    }
  }
  revealEditor()
  if (!useEditor.getState().jumpTo({ fileId: target.file.id, line, column })) {
    notFound(`Couldn’t open ${target.file.path}.`)
  }
}

// -- column refinement --------------------------------------------------------------------------

async function fileText(pid: string, file: FileEntry): Promise<string> {
  const session = docSessions.get(file.id)
  if (session && session.isSynced()) return session.ytext.toString()
  return api.rawFile(pid, file.id)
}

async function refineColumn(pid: string, file: FileEntry, line: number, word: string, before: string): Promise<WordPosition | null> {
  if (normalizeWord(word).length < 2) return null
  const lines = (await fileText(pid, file)).split('\n')
  return refineWordPosition(lines, line, word, before)
}
