/**
 * Persistent notices for text kept from documents that were closed while they held unsaved
 * edits (realtime/recovered.ts): the file was deleted, deleted and created again, or replaced
 * — typically while this user was offline — or our role changed to viewer before the server
 * took the edits. Mounted once by EditorLayout under the connection banner; one notice per kept
 * text of the open project that belongs to the signed-in user, until the user dismisses it:
 *
 *   Copy my text · Save as new file (“b (recovered).tex” next to it, then opened; editors) or
 *   Download as file (viewers, who cannot create files) · Compare with current (the file now at
 *   that path vs. the kept text) · Dismiss (asks first while the text was not saved anywhere).
 */
import { useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ArchiveRestore, ClipboardCopy, Download, FilePlus, FileText, GitCompare, X } from 'lucide-react'
import type { FileEntry, Role } from '@folio/shared/api'
import { basename, dirname, siblingCopyPath } from '@folio/shared/paths'
import { api } from '../../api/endpoints'
import { ApiError, errorMessage } from '../../api/client'
import { downloadText } from '../../lib/download'
import { docSessions } from '../../realtime/docs'
import {
  dismissRecovered, markRecoveredSaved, recoveredCause, useRecovered, type RecoveredCause, type RecoveredText,
} from '../../realtime/recovered'
import { useAuth } from '../../stores/auth'
import { useEditor } from '../../stores/editor'
import { useProject } from '../../stores/project'
import { Button, IconButton, Modal, Spinner, confirmDialog, toast } from '../../ui'
import { copyText } from '../filetree/actions'
import { DiffViewer } from '../history/DiffViewer'
import { requestEditorFocus } from '../editor/reveal'
import { waitForFile } from './newEntry'

export function RecoveredTexts() {
  const projectId = useProject(s => s.projectId)
  const meId = useAuth(s => s.me?.id ?? null)
  // only the signed-in user's own kept texts (another account's never show in this tab)
  const items = useRecovered(useShallow(s => s.items.filter(i => i.projectId === projectId && !!meId && i.userId === meId)))
  if (!projectId || items.length === 0) return null
  return (
    <div className="lay-recovered" role="region" aria-label="Kept changes">
      {items.map(item => <RecoveredNotice key={item.id} item={item} />)}
    </div>
  )
}

/**
 * What happened, in words: "“b.tex” was deleted by Bob Editor while you were offline." `role`
 * is our role in the project now (an access close while we are a viewer: the role changed).
 */
export function describeRecovered(item: RecoveredText, cause: RecoveredCause, meId: string | null, role: Role | null = null): string {
  const name = `“${basename(item.path)}”`
  const by = item.by ? ` by ${item.by.id === meId ? 'you' : item.by.name}` : ''
  const when = item.offline ? ' while you were offline' : ''
  switch (cause) {
    case 'deleted':
      return item.offline ? `${name} was deleted${by} while you were offline.` : `${name} was deleted${by} before the server confirmed them.`
    case 'recreated':
      return `${name} was deleted${by}${when} and a new file was created in its place. Your changes are not in it.`
    case 'replaced':
      return `${name} was replaced with a new version${by}${when}. Your changes are not in it.`
    case 'reset':
      return `The server’s copy of ${name} was reset${when}. Your changes are not in it.`
    case 'access':
      if (role === 'viewer') {
        return `Your role in this project was changed to viewer${when}, so the server did not accept them. You can copy them or download them as a file.`
      }
      return `Your access to this project changed${when} before the server confirmed them.`
    default:
      return `The server closed ${name} before it confirmed them.`
  }
}

/** Save the kept text as a new file next to the original ("b (recovered).tex"), then open it. */
async function saveAsNewFile(item: RecoveredText): Promise<void> {
  const pid = item.projectId
  const tried = new Set<string>()
  const taken = (p: string) => tried.has(p) || !!useProject.getState().fileByPath(p)
  // next to the original; at the project root when that folder cannot take it any more
  const bases = dirname(item.path) ? [item.path, basename(item.path)] : [item.path]
  for (const base of bases) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const path = siblingCopyPath(base, taken)
      try {
        const entry = await api.createEntry(pid, { path, kind: 'text', content: item.text })
        markRecoveredSaved(item.id, { fileId: entry.id, path: entry.path })
        toast(`Your text was saved as “${entry.path}”.`, { tone: 'success' })
        await waitForFile(entry.id, 3000)
        if (useProject.getState().projectId === pid && useProject.getState().files[entry.id]) {
          requestEditorFocus(entry.id)
          useEditor.getState().openFile(entry.id)
        }
        return
      } catch (e) {
        if (e instanceof ApiError && e.status === 409) {
          tried.add(path)
          // the name was taken meanwhile (retry) — or a parent folder is a file now (next base)
          if ((e.details as { path?: unknown } | undefined)?.path === path) continue
          break
        }
        toast(`Couldn’t save your text: ${errorMessage(e)}`, { tone: 'error' })
        return
      }
    }
  }
  toast('Couldn’t find a free name for your text. Copy it instead.', { tone: 'error' })
}

/** Save the kept text as a file on this computer ("b (recovered).tex"). */
function downloadKept(item: RecoveredText): void {
  const name = basename(siblingCopyPath(basename(item.path), () => false))
  downloadText(item.text, name)
}

/** Forget a kept text; asks first unless it was saved as a file (that still exists). */
async function dismiss(item: RecoveredText, saved: boolean): Promise<void> {
  if (!saved) {
    const ok = await confirmDialog({
      title: 'Discard your kept text?',
      message: `Your unsaved changes to “${basename(item.path)}” are only kept in this tab. Once discarded they cannot be recovered.`,
      confirmLabel: 'Discard',
      danger: true,
    })
    if (!ok) return
  }
  dismissRecovered(item.id)
}

function RecoveredNotice({ item }: { item: RecoveredText }) {
  const files = useProject(s => s.files)
  const role = useProject(s => s.role)
  const canEdit = role === 'owner' || role === 'editor'
  const meId = useAuth(s => s.me?.id ?? null)
  const [saving, setSaving] = useState(false)
  const [comparing, setComparing] = useState<FileEntry | null>(null)
  const { cause, current } = recoveredCause(item, files)
  const name = basename(item.path)
  const saved = item.savedAs && files[item.savedAs.fileId] ? item.savedAs : null

  const save = async () => {
    setSaving(true)
    try {
      await saveAsNewFile(item)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="lay-recovered__item" data-testid="recovered-notice" data-file-id={item.fileId}>
      <ArchiveRestore size={16} aria-hidden="true" className="lay-recovered__icon" />
      <div className="lay-recovered__text">
        <strong>Your unsaved changes to “{name}” were kept.</strong>{' '}
        {saved ? <>They are saved in “{saved.path}”.</> : describeRecovered(item, cause, meId, role)}
      </div>
      <div className="lay-recovered__actions">
        {saved ? (
          <Button size="sm" icon={FileText} onClick={() => useEditor.getState().openFile(saved.fileId)}>
            Open “{basename(saved.path)}”
          </Button>
        ) : (
          <>
            <Button size="sm" icon={ClipboardCopy} onClick={() => void copyText(item.text, 'Your text')}>
              Copy my text
            </Button>
            {canEdit ? (
              <Button size="sm" variant="primary" icon={FilePlus} loading={saving} onClick={() => void save()}>
                Save as new file
              </Button>
            ) : (
              // viewers cannot create files in the project: they take the text with them
              <Button size="sm" variant="primary" icon={Download} onClick={() => downloadKept(item)}>
                Download as file
              </Button>
            )}
            {current && (
              <Button size="sm" icon={GitCompare} onClick={() => setComparing(current)}>
                Compare with current
              </Button>
            )}
          </>
        )}
        <IconButton icon={X} label={`Dismiss the kept text of “${name}”`} size="sm" onClick={() => void dismiss(item, !!saved)} />
      </div>
      {comparing && (
        <CompareModal item={item} current={comparing} canEdit={canEdit && !saved} onSave={save} onClose={() => setComparing(null)} />
      )}
    </div>
  )
}

/** The file now at that path (left, red) against the kept text (right, green). */
function CompareModal({ item, current, canEdit, onSave, onClose }: {
  item: RecoveredText
  current: FileEntry
  canEdit: boolean
  onSave: () => Promise<void>
  onClose: () => void
}) {
  const [state, setState] = useState<{ text: string | null; error: string | null }>({ text: null, error: null })
  useEffect(() => {
    let cancelled = false
    // the live text when this tab has the document open, else the server's copy
    const s = docSessions.get(current.id)
    if (s && s.isSynced()) {
      setState({ text: s.ytext.toString(), error: null })
      return
    }
    api.rawFile(item.projectId, current.id)
      .then(text => { if (!cancelled) setState({ text, error: null }) })
      .catch(e => { if (!cancelled) setState({ text: null, error: errorMessage(e) }) })
    return () => {
      cancelled = true
    }
  }, [item.projectId, current.id])
  const loading = state.text === null && state.error === null
  return (
    <Modal
      open
      onClose={onClose}
      size="xl"
      title={`Compare “${basename(item.path)}”`}
      description={<>Red: only in the current “{current.path}”. Green: only in your kept text.</>}
      bodyClassName="lay-recovered__compare"
      footer={
        <>
          <Button icon={ClipboardCopy} onClick={() => void copyText(item.text, 'Your text')}>
            Copy my text
          </Button>
          {canEdit ? (
            <Button icon={FilePlus} onClick={() => { onClose(); void onSave() }}>
              Save as new file
            </Button>
          ) : (
            <Button icon={Download} onClick={() => downloadKept(item)}>
              Download as file
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="lay-recovered__loading"><Spinner size={18} label="Loading the current version" /></div>
      ) : state.error !== null ? (
        <p role="alert">Couldn’t load the current version: {state.error}</p>
      ) : (
        <div className="hist-diff lay-recovered__diff">
          <DiffViewer path={item.path} oldText={state.text ?? ''} newText={item.text} collapse />
        </div>
      )}
    </Modal>
  )
}
