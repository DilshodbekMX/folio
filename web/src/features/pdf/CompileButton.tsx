/**
 * Recompile split button (features.md "Recompile split-button: exact dropdown"): the main part
 * compiles (spinner + "Compiling…" while running); the caret opens the compile options —
 * Auto compile On/Off, Compile mode Normal / Fast [draft], error handling (Stop on first error /
 * Try to compile despite errors), Stop compilation (while compiling), Recompile from scratch.
 * Options are per user and project (useCompile persists them in localStorage).
 *
 * Viewers can recompile too (like Overleaf); the options that need edit rights — auto compile,
 * stopping a compile, recompiling from scratch — are not offered to them.
 * A compile builds the open document when it has its own \documentclass (e.g. a supplementary
 * document next to the paper); the tooltip names the document whenever it is not the main one.
 */
import { ChevronDown, CircleStop, Eraser, RefreshCw } from 'lucide-react'
import clsx from 'clsx'
import { basename } from '@folio/shared/paths'
import { errorMessage } from '../../api/client'
import { openRootFileId, useCompile } from '../../stores/compile'
import { useEditor } from '../../stores/editor'
import { useProject } from '../../stores/project'
import { DropdownMenu, Spinner, Tooltip, formatShortcut, toast, type MenuItem } from '../../ui'

export function runCompile(o: { fromScratch?: boolean } = {}): void {
  // compile() never rejects; problems are shown by the PDF pane
  void useCompile.getState().compile(o)
}

export async function stopCompile(): Promise<void> {
  try {
    await useCompile.getState().stop()
  } catch (e) {
    toast(`Couldn’t stop the compile: ${errorMessage(e)}`, { tone: 'error' })
  }
}

export function compileOptionItems(): MenuItem[] {
  const st = useCompile.getState()
  const { options } = st
  const compiling = st.status === 'compiling'
  const canEdit = useProject.getState().canEdit()
  const set = st.setOption
  const items: MenuItem[] = []
  if (canEdit) {
    items.push(
      { type: 'header', label: 'Auto compile' },
      { type: 'radio', label: 'On', checked: options.autoCompile, keepOpen: true, onSelect: () => set('autoCompile', true) },
      { type: 'radio', label: 'Off', checked: !options.autoCompile, keepOpen: true, onSelect: () => set('autoCompile', false) },
      { type: 'separator' },
    )
  }
  items.push(
    { type: 'header', label: 'Compile mode' },
    { type: 'radio', label: 'Normal', checked: !options.draft, keepOpen: true, onSelect: () => set('draft', false) },
    {
      type: 'radio',
      label: 'Fast [draft]',
      description: 'Images are shown as boxes',
      checked: options.draft,
      keepOpen: true,
      onSelect: () => set('draft', true),
    },
    { type: 'separator' },
    { type: 'header', label: 'Compile error handling' },
    { type: 'radio', label: 'Stop on first error', checked: options.stopOnFirstError, keepOpen: true, onSelect: () => set('stopOnFirstError', true) },
    { type: 'radio', label: 'Try to compile despite errors', checked: !options.stopOnFirstError, keepOpen: true, onSelect: () => set('stopOnFirstError', false) },
  )
  if (canEdit) {
    items.push(
      { type: 'separator' },
      { label: 'Stop compilation', icon: CircleStop, disabled: !compiling, onSelect: () => void stopCompile() },
      { label: 'Recompile from scratch', icon: Eraser, description: 'Deletes cached auxiliary files first', onSelect: () => runCompile({ fromScratch: true }) },
    )
  }
  return items
}

/** The document the next compile builds, when it is not the project's main document. */
function compileTargetPath(): string | null {
  const id = openRootFileId()
  return id ? (useProject.getState().files[id]?.path ?? null) : null
}

/** Tooltip of the Recompile button (rendered while shown, so it names the current target). */
function RecompileTip() {
  const target = compileTargetPath()
  const what = target ? `Recompile ${basename(target)}` : 'Recompile the PDF'
  return <>{`${what} (${formatShortcut('Mod-Enter')})`}</>
}

export function CompileButton() {
  const compiling = useCompile(s => s.status === 'compiling')
  const runningAuto = useCompile(s => s.runningAuto)
  // re-render when options change so the open menu shows the new radio state
  useCompile(s => s.options)
  // re-render when the role changes: the menu offers editors more options
  useProject(s => s.role)
  const draft = useCompile(s => s.options.draft)
  // the tooltip names the open document when it is compiled instead of the main one
  useEditor(s => s.openFileId)

  const tip = compiling ? (runningAuto ? 'Auto-compiling your latest changes…' : 'Compiling…') : <RecompileTip />

  return (
    <div className={clsx('pdf-compile', compiling && 'is-compiling')} role="group" aria-label="Compile">
      <Tooltip content={tip} side="bottom">
        <button
          type="button"
          className="pdf-compile__main"
          aria-disabled={compiling || undefined}
          aria-busy={compiling || undefined}
          onClick={() => {
            if (!compiling) runCompile()
          }}
        >
          {compiling ? <Spinner size={14} label={null} className="pdf-compile__spinner" /> : <RefreshCw size={15} aria-hidden="true" />}
          <span className="pdf-compile__label">{compiling ? 'Compiling…' : 'Recompile'}</span>
          {draft && !compiling && <span className="pdf-compile__mode">draft</span>}
        </button>
      </Tooltip>
      <DropdownMenu
        items={compileOptionItems()}
        minWidth={250}
        trigger={
          <button type="button" className="pdf-compile__caret" aria-label="Toggle compile options menu">
            <ChevronDown size={15} aria-hidden="true" />
          </button>
        }
      />
    </div>
  )
}
