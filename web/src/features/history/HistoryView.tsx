/**
 * History view (SPEC §6.7/§6.8), rendered by EditorLayout over the editor + PDF area while
 * useLayout.historyOpen. The rail panel (file tree + outline) is collapsed while it is open, so
 * the diff gets the room and there are not two file lists side by side; it comes back as it was
 * when the history closes (unless the user opened a rail panel meanwhile):
 *
 *   header   Back to editor · what is shown ("Viewing …" / "Comparing …") · Add label · Download
 *            (.zip) · Restore project (editors)
 *   files    changed files of the selected version or range (Changes) or every file of the
 *            version (All files) with op badges; when comparing a range, who changed each file
 *   diff     read-only unified diff (@codemirror/merge) of the selected file, or before/after
 *            previews for binary files; who changed it (J-8: the history keeps the people who
 *            edited during each snapshot, so one person's changes are marked in their colour,
 *            several people are named without per-line attribution); Restore this file (editors)
 *   versions day-grouped list with authors, reason chips, changed files and labels; Labels
 *            filter; infinite scroll; Shift-click / Shift+↑↓ compares a range; ↑/↓ moves
 *
 * Opening the view takes a snapshot first (editors) so the latest edits are listed; the list
 * refreshes live on 'history:changed'. Viewers can browse and download but not restore/label.
 * A version's .zip is saved as "<project> - <label>.zip" or "<project> - <date time>.zip" (J-9).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import clsx from 'clsx'
import {
  ArrowLeft, ChevronDown, ChevronUp, Download, FileSearch, RotateCcw, Tag, X,
} from 'lucide-react'
import type { HistoryDiffResponse, HistoryFilesResponse, HistoryVersion, Label } from '@folio/shared/api'
import { basename, dirname } from '@folio/shared/paths'
import { api } from '../../api/endpoints'
import { buildUrl, errorMessage, isAbortError } from '../../api/client'
import { safeColor } from '../../lib/colors'
import { downloadAs, downloadUrl } from '../../lib/download'
import { formatDateTime } from '../../lib/time'
import { projectEvents } from '../../realtime/meta'
import { useAuth } from '../../stores/auth'
import { useEditor } from '../../stores/editor'
import { useLayout } from '../../stores/layout'
import { useProject } from '../../stores/project'
import {
  Avatar, Button, EmptyState, IconButton, Spinner, Tabs, Tooltip, confirmDialog, promptDialog, toast,
} from '../../ui'
import { expectLocalDeletion } from '../editor/openFileGuard'
import { FileIcon } from '../filetree/FileIcon'
import { BinaryDiff, VersionFilePreview } from './BinaryDiff'
import { DiffViewer, type DiffAuthor, type DiffHandle, type DiffStats } from './DiffViewer'
import {
  fileAuthors, makeRange, netChanges, resolveSelection, versionZipName, type FileAuthor, type HistorySelection, type NetChange,
} from './model'
import { OP_LABEL, OpIcon, VersionList, authorNames, type VersionActions, type VersionFilter } from './VersionList'
import './history.css'

const PAGE = 50
const SNAPSHOT_TIMEOUT_MS = 8000

type FileMode = 'changes' | 'all'

interface DiffState {
  key: string
  status: 'loading' | 'ready' | 'error'
  data?: HistoryDiffResponse
  error?: string
}

/**
 * Collapse the rail panel while the history is shown; the returned cleanup brings it back —
 * also when the page is left meanwhile (the panel state is persisted) — unless the user opened
 * a panel in between.
 */
function collapseRailPanel(): () => void {
  const before = useLayout.getState().railPanel
  if (before === null) return () => {}
  useLayout.getState().setRailPanel(null)
  const restore = () => {
    if (useLayout.getState().railPanel === null) useLayout.getState().setRailPanel(before)
  }
  window.addEventListener('pagehide', restore)
  return () => {
    window.removeEventListener('pagehide', restore)
    restore()
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([p, new Promise<null>(resolve => setTimeout(() => resolve(null), ms))])
}

export function HistoryView() {
  const pid = useProject(s => s.projectId)
  if (!pid) return null
  return <History key={pid} pid={pid} />
}

function History({ pid }: { pid: string }) {
  const canEdit = useProject(s => s.role === 'owner' || s.role === 'editor')
  const projectName = useProject(s => s.name)
  const meId = useAuth(s => s.me?.id ?? null)
  const setHistoryOpen = useLayout(s => s.setHistoryOpen)

  const [versions, setVersions] = useState<HistoryVersion[]>([])
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [listError, setListError] = useState<string | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [filter, setFilter] = useState<VersionFilter>('all')
  const [selection, setSelection] = useState<HistorySelection | null>(null)
  const [fileMode, setFileMode] = useState<FileMode>('changes')
  /** file explicitly chosen in the file list (kept while versions change, when present) */
  const [pickedPath, setPickedPath] = useState<string | null>(null)
  const [allFiles, setAllFiles] = useState<{ versionId: string; files: HistoryFilesResponse['files'] } | null>(null)
  const [diff, setDiff] = useState<DiffState | null>(null)
  const [stats, setStats] = useState<DiffStats | null>(null)
  const [busy, setBusy] = useState<'restore-file' | 'restore-project' | 'label' | 'download' | null>(null)
  const diffRef = useRef<DiffHandle | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const diffStateRef = useRef(diff)
  diffStateRef.current = diff

  const versionsRef = useRef(versions)
  versionsRef.current = versions
  const hasMoreRef = useRef(hasMore)
  hasMoreRef.current = hasMore
  const loadingMoreRef = useRef(false)
  const loadSeq = useRef(0)

  const close = useCallback(() => setHistoryOpen(false), [setHistoryOpen])

  // -- loading ------------------------------------------------------------------------------

  const initialLoad = useCallback(async () => {
    const seq = ++loadSeq.current
    setListState('loading')
    setListError(null)
    try {
      if (useProject.getState().canEdit()) {
        // make the latest edits part of the history before listing it
        await withTimeout(api.historySnapshot(pid).catch(() => null), SNAPSHOT_TIMEOUT_MS)
      }
      const res = await api.historyVersions(pid, { limit: PAGE })
      if (seq !== loadSeq.current) return
      setVersions(res.versions)
      setHasMore(res.hasMore)
      setListState('ready')
      setSelection(prev => prev ?? (res.versions[0] ? { kind: 'single', id: res.versions[0].id } : null))
    } catch (e) {
      if (seq !== loadSeq.current) return
      setListState('error')
      setListError(errorMessage(e, 'The history could not be loaded.'))
    }
  }, [pid])

  useEffect(() => {
    void initialLoad()
  }, [initialLoad])

  const loadMore = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return
    const last = versionsRef.current[versionsRef.current.length - 1]
    if (!last) return
    loadingMoreRef.current = true
    setLoadingMore(true)
    try {
      const res = await api.historyVersions(pid, { before: last.id, limit: PAGE })
      setVersions(prev => {
        const seen = new Set(prev.map(v => v.id))
        return [...prev, ...res.versions.filter(v => !seen.has(v.id))]
      })
      setHasMore(res.hasMore)
    } catch (e) {
      toast(`Couldn’t load older versions: ${errorMessage(e)}`, { tone: 'error' })
    } finally {
      loadingMoreRef.current = false
      setLoadingMore(false)
    }
  }, [pid])

  /** Re-read the loaded part of the list (new versions, label changes) keeping older pages. */
  const refresh = useCallback(async (changedVersionId?: string | null) => {
    const current = versionsRef.current
    const limit = Math.min(200, Math.max(PAGE, current.length))
    try {
      const res = await api.historyVersions(pid, { limit })
      const fresh = res.versions
      const lastFresh = fresh[fresh.length - 1]
      const at = lastFresh ? current.findIndex(v => v.id === lastFresh.id) : -1
      let next: HistoryVersion[]
      let more: boolean
      if (current.length === 0 || at < 0) {
        next = fresh
        more = res.hasMore
      } else {
        next = [...fresh, ...current.slice(at + 1)]
        more = at + 1 >= current.length ? res.hasMore : hasMoreRef.current
      }
      // a label changed on a version beyond the refreshed window
      if (changedVersionId && !fresh.some(v => v.id === changedVersionId)) {
        const i = next.findIndex(v => v.id === changedVersionId)
        if (i > 0) {
          const one = await api.historyVersions(pid, { before: next[i - 1].id, limit: 1 })
          if (one.versions[0]?.id === changedVersionId) next = next.map((v, k) => (k === i ? one.versions[0] : v))
        }
      }
      setVersions(next)
      setHasMore(more)
      setListState('ready')
      setSelection(prev => prev ?? (next[0] ? { kind: 'single', id: next[0].id } : null))
    } catch {
      // keep what we have; the next event retries
    }
  }, [pid])

  useEffect(() => {
    let timer: number | undefined
    let pendingId: string | null | undefined
    const off = projectEvents.on('history:changed', e => {
      pendingId = e.versionId
      window.clearTimeout(timer)
      timer = window.setTimeout(() => void refresh(pendingId), 300)
    })
    return () => {
      off()
      window.clearTimeout(timer)
    }
  }, [refresh])

  // keyboard users land on the selected version (↑/↓ then move between versions)
  const focusedOnce = useRef(false)
  useEffect(() => {
    if (listState !== 'ready' || focusedOnce.current) return
    focusedOnce.current = true
    requestAnimationFrame(() => rootRef.current?.querySelector<HTMLElement>('.hist-card__select[tabindex="0"]')?.focus({ preventScroll: true }))
  }, [listState])

  // -- selection ------------------------------------------------------------------------------

  const resolved = useMemo(() => resolveSelection(versions, selection), [versions, selection])
  const { to, fromId, from } = resolved
  const changes: NetChange[] = useMemo(() => netChanges(resolved.versions), [resolved.versions])
  const changesRef = useRef(changes)
  changesRef.current = changes
  const anchorRef = useRef<string | null>(null)

  const onSelectVersion = useCallback((id: string, extend: boolean) => {
    if (extend) {
      const anchor = anchorRef.current ?? (selection?.kind === 'single' ? selection.id : selection?.kind === 'range' ? selection.fromId : null)
      if (anchor && anchor !== id) {
        anchorRef.current = anchor
        setSelection(makeRange(versionsRef.current, anchor, id))
        return
      }
    }
    anchorRef.current = id
    setSelection({ kind: 'single', id })
  }, [selection])

  // all files of the 'to' version
  const toIdForFiles = to?.id ?? null
  useEffect(() => {
    if (fileMode !== 'all' || !toIdForFiles || allFiles?.versionId === toIdForFiles) return
    let cancelled = false
    api.historyFiles(pid, toIdForFiles).then(res => {
      if (!cancelled) setAllFiles({ versionId: toIdForFiles, files: res.files })
    }).catch(e => {
      if (!cancelled) toast(`Couldn’t list the files of this version: ${errorMessage(e)}`, { tone: 'error' })
    })
    return () => {
      cancelled = true
    }
  }, [fileMode, toIdForFiles, allFiles, pid])

  const fileEntries = useMemo(
    () => (fileMode === 'changes'
      ? changes.map(c => ({ path: c.path, change: c as NetChange | null }))
      : allFileEntries(allFiles && allFiles.versionId === to?.id ? allFiles.files : null, changes)),
    [fileMode, changes, allFiles, to?.id],
  )
  const allFilesLoading = fileMode === 'all' && !!to && allFiles?.versionId !== to.id

  // the file shown: the user's pick when this version has it, else the file open in the
  // editor when it changed, else the first change / first file (derived during render so a
  // new selection never requests a diff for a path the version does not have)
  const selectedPath = useMemo(() => {
    if (!to || allFilesLoading) return null
    if (pickedPath && fileEntries.some(e => e.path === pickedPath)) return pickedPath
    const openId = useEditor.getState().openFileId
    const openPath = openId ? useProject.getState().files[openId]?.path : undefined
    if (openPath && changes.some(c => c.path === openPath)) return openPath
    return changes[0]?.path ?? fileEntries[0]?.path ?? null
  }, [to, allFilesLoading, pickedPath, fileEntries, changes])

  const change = selectedPath ? changes.find(c => c.path === selectedPath) ?? null : null

  // who changed the selected file in the selected version(s), and each file of a range
  const selectedAuthors = useMemo(
    () => (change && selectedPath ? fileAuthors(resolved.versions, selectedPath) : []),
    [change, selectedPath, resolved.versions],
  )
  const rangeAuthors = useMemo(() => {
    const byPath = new Map<string, FileAuthor[]>()
    if (selection?.kind !== 'range') return byPath
    for (const c of changes) byPath.set(c.path, fileAuthors(resolved.versions, c.path))
    return byPath
  }, [selection?.kind, changes, resolved.versions])
  const diffAuthor: DiffAuthor | null = selectedAuthors.length === 1
    ? { name: selectedAuthors[0].user.id === meId ? 'you' : selectedAuthors[0].user.name, color: safeColor(selectedAuthors[0].user.color), when: formatDateTime(selectedAuthors[0].at) }
    : null

  // The editor and PDF stay mounted underneath the overlay: make them inert while the history is
  // shown so focus (e.g. the editor focusing itself after a file is opened from the tree) and
  // keystrokes cannot reach hidden content.
  useEffect(() => {
    const root = rootRef.current
    const work = root?.closest('.lay-work')
    if (!root || !work) return
    const made: HTMLElement[] = []
    for (const el of Array.from(work.children)) {
      if (!(el instanceof HTMLElement) || el.contains(root) || el.inert) continue
      el.inert = true
      made.push(el)
    }
    if (document.activeElement instanceof HTMLElement && made.some(el => el.contains(document.activeElement))) document.activeElement.blur()
    return () => {
      for (const el of made) el.inert = false
    }
  }, [])

  // the history's own file list replaces the rail panel (file tree, outline, search, chat)
  useEffect(() => collapseRailPanel(), [])

  // clicking a file in the file tree (when the user reopens it next to the history) shows its history
  useEffect(() => useEditor.subscribe((st, prev) => {
    if (st.openFileId === prev.openFileId || !st.openFileId) return
    const path = useProject.getState().files[st.openFileId]?.path
    if (!path) return
    setPickedPath(path)
    if (!changesRef.current.some(c => c.path === path)) setFileMode('all')
  }), [])

  // -- diff -----------------------------------------------------------------------------------

  const toId = to?.id ?? null
  const changed = !!change
  useEffect(() => {
    if (!toId || !selectedPath) {
      setDiff(null)
      return
    }
    // unchanged file (All files mode): show it as it was at `to`
    const fromParam = changed ? fromId : toId
    const key = `${toId}|${fromParam ?? ''}|${selectedPath}`
    const prev = diffStateRef.current
    if (prev?.key === key && prev.status === 'ready') return
    const ctrl = new AbortController()
    setDiff({ key, status: 'loading' })
    setStats(null)
    api.historyDiff(pid, { to: toId, from: fromParam, path: selectedPath }, { signal: ctrl.signal })
      .then(data => setDiff({ key, status: 'ready', data }))
      .catch(e => {
        if (isAbortError(e)) return
        setDiff({ key, status: 'error', error: errorMessage(e, 'The changes could not be loaded.') })
      })
    return () => ctrl.abort()
  }, [pid, toId, fromId, selectedPath, changed])

  // -- actions --------------------------------------------------------------------------------

  const whenText = (v: HistoryVersion) => formatDateTime(v.createdAt)

  const restoreFile = async () => {
    if (!to || !selectedPath || !diff?.data || busy) return
    const data = diff.data
    const deleted = data.newText === null
    // a file deleted in this version comes back as it was just before
    const versionId = deleted ? data.from : to.id
    const path = deleted ? (change?.oldPath ?? selectedPath) : selectedPath
    if (!versionId) return
    const when = deleted ? (from ? whenText(from) : 'the previous version') : whenText(to)
    const ok = await confirmDialog({
      title: deleted ? 'Restore deleted file?' : 'Restore this file?',
      message: (
        <>
          <p>
            <code>{path}</code> will be {deleted ? 'brought back' : 'restored'} as it was in the version from <strong>{when}</strong>.
          </p>
          <p className="hist-dialog__muted">
            {deleted ? 'It is added to the project again.' : 'Its current content is replaced for everyone editing it.'} Nothing is lost: the restore is recorded as a new version in the history.
          </p>
        </>
      ),
      confirmLabel: deleted ? 'Restore file' : 'Restore this file',
    })
    if (!ok) return
    setBusy('restore-file')
    try {
      const res = await api.historyRestore(pid, { versionId, path })
      if (res.restored.length === 0 && res.skipped?.length) {
        toast(<>Couldn’t restore <strong>{basename(path)}</strong>: something else is at that path now (a folder with files in it?).</>, { tone: 'warning', duration: 10_000 })
        return
      }
      if (res.restored.length === 0) {
        toast(<><strong>{basename(path)}</strong> already matches the version from {when}.</>, { tone: 'info' })
        return
      }
      toast(<>Restored <strong>{basename(path)}</strong> to the version from {when}.</>, { tone: 'success' })
      close()
      const entry = await waitForFileByPath(path, 3000)
      if (entry && entry.kind !== 'folder') useEditor.getState().openFile(entry.id)
    } catch (e) {
      toast(`Couldn’t restore “${path}”: ${errorMessage(e)}`, { tone: 'error' })
    } finally {
      setBusy(null)
    }
  }

  const restoreProject = useCallback(async (v: HistoryVersion) => {
    if (busy) return
    const ok = await confirmDialog({
      title: 'Restore the whole project?',
      message: (
        <>
          <p>
            Your current project will revert to the version from <strong>{formatDateTime(v.createdAt)}</strong>: every file goes back to how it was, files
            created since then are deleted and deleted files come back.
          </p>
          <p className="hist-dialog__muted">This affects everyone working on the project. Nothing is lost: the restore is recorded as a new version, so you can go back to the current state from the history.</p>
        </>
      ),
      confirmLabel: 'Restore project',
      danger: true,
    })
    if (!ok) return
    setBusy('restore-project')
    try {
      // files created since that version disappear, possibly the one open in the editor
      expectLocalDeletion('all')
      const res = await api.historyRestore(pid, { versionId: v.id })
      if (res.restored.length === 0) {
        toast(`The project already matches the version from ${formatDateTime(v.createdAt)}.`, { tone: 'info' })
        return
      }
      toast(`Project restored to the version from ${formatDateTime(v.createdAt)} (${res.restored.length} ${res.restored.length === 1 ? 'file' : 'files'} changed).`, { tone: 'success' })
      const skipped = res.skipped ?? []
      if (skipped.length > 0) {
        const list = skipped.slice(0, 3).map(p => `“${p}”`).join(', ') + (skipped.length > 3 ? ` and ${skipped.length - 3} more` : '')
        toast(`Not restored: ${list} — something else is at that path now (a folder with files in it?).`, { tone: 'warning', duration: 10_000 })
      }
      close()
    } catch (e) {
      toast(`Couldn’t restore the project: ${errorMessage(e)}`, { tone: 'error' })
    } finally {
      setBusy(null)
    }
  }, [busy, close, pid])

  const addLabel = useCallback(async (v: HistoryVersion) => {
    const name = await promptDialog({
      title: 'Add label',
      label: 'New label name',
      message: <>Label the version from <strong>{formatDateTime(v.createdAt)}</strong>, for example “Submitted to journal”.</>,
      placeholder: 'Submitted draft',
      confirmLabel: 'Add label',
      validate: value => (!value ? 'Enter a label name.' : value.length > 200 ? 'Labels can be at most 200 characters.' : v.labels.some(l => l.name === value) ? 'This version already has this label.' : null),
    })
    if (name === null) return
    setBusy('label')
    try {
      const label = await api.createLabel(pid, { name, versionId: v.id })
      setVersions(prev => prev.map(x => (x.id === label.versionId && !x.labels.some(l => l.id === label.id) ? { ...x, labels: [...x.labels, label] } : x)))
      toast(<>Added label <strong>{label.name}</strong>.</>, { tone: 'success' })
    } catch (e) {
      toast(`Couldn’t add the label: ${errorMessage(e)}`, { tone: 'error' })
    } finally {
      setBusy(null)
    }
  }, [pid])

  const deleteLabel = useCallback(async (l: Label) => {
    const ok = await confirmDialog({
      title: 'Delete label?',
      message: <p>Are you sure you want to delete the label <strong>“{l.name}”</strong>? The version itself stays in the history.</p>,
      confirmLabel: 'Delete label',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteLabel(pid, l.id)
      setVersions(prev => prev.map(x => (x.id === l.versionId ? { ...x, labels: x.labels.filter(y => y.id !== l.id) } : x)))
      toast(`Deleted label “${l.name}”.`, { tone: 'success' })
    } catch (e) {
      toast(`Couldn’t delete the label: ${errorMessage(e)}`, { tone: 'error' })
    }
  }, [pid])

  // fetched, then saved under our name: the server's Content-Disposition names it by commit hash
  const downloadVersion = useCallback(async (v: HistoryVersion) => {
    setBusy(b => b ?? 'download')
    try {
      await downloadAs(api.historyDownloadUrl(pid, v.id), versionZipName(projectName, v))
    } finally {
      setBusy(b => (b === 'download' ? null : b))
    }
  }, [pid, projectName])

  const actions: VersionActions = useMemo(() => ({
    addLabel: v => void addLabel(v),
    deleteLabel: l => void deleteLabel(l),
    download: v => void downloadVersion(v),
    restoreProject: v => void restoreProject(v),
    compareFrom: v => {
      // from v up to the current selection (when newer) or the newest version
      const list = versionsRef.current
      const at = (id: string | undefined) => (id ? list.findIndex(x => x.id === id) : -1)
      const cur = selection?.kind === 'range' ? selection.toId : selection?.id
      const toId = cur && at(cur) >= 0 && at(cur) < at(v.id) ? cur : list[0]?.id
      anchorRef.current = v.id
      setSelection(toId && toId !== v.id ? makeRange(list, v.id, toId) : { kind: 'single', id: v.id })
    },
    compareTo: v => {
      // from the current selection (when older) or the first version up to v
      const list = versionsRef.current
      const at = (id: string | undefined) => (id ? list.findIndex(x => x.id === id) : -1)
      const cur = selection?.kind === 'range' ? selection.fromId : selection?.id
      const fromId = cur && at(cur) > at(v.id) ? cur : list[list.length - 1]?.id
      anchorRef.current = fromId ?? v.id
      setSelection(fromId && fromId !== v.id ? makeRange(list, fromId, v.id) : { kind: 'single', id: v.id })
    },
  }), [addLabel, deleteLabel, downloadVersion, restoreProject, selection])

  // Esc returns to the editor (unless a dialog/menu handled it)
  const onRootKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape' && !e.defaultPrevented) {
      e.preventDefault()
      close()
    }
  }

  // -- render ---------------------------------------------------------------------------------

  const headline = (() => {
    if (!to) return listState === 'loading' ? 'Loading history…' : 'No version selected'
    if (selection?.kind === 'range' && from) {
      // same minute on both ends: add seconds so the two ends can be told apart
      const same = formatDateTime(from.createdAt) === formatDateTime(to.createdAt)
      const fmt = (ts: number) => (same ? `${formatDateTime(ts)}:${String(new Date(ts).getSeconds()).padStart(2, '0')}` : formatDateTime(ts))
      return (
        <>
          Comparing <strong>{fmt(from.createdAt)}</strong> <span className="hist-head__arrow">→</span> <strong>{fmt(to.createdAt)}</strong>
        </>
      )
    }
    return (
      <>
        Viewing <strong>{formatDateTime(to.createdAt)}</strong>
        <span className="hist-head__by"> · {authorNames(to.authors, meId)}</span>
      </>
    )
  })()

  return (
    <div className="hist-root" ref={rootRef} onKeyDown={onRootKeyDown}>
      <header className="hist-head">
        <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={close} className="hist-head__back">
          Back to editor
        </Button>
        <div className="hist-head__sep" aria-hidden="true" />
        <div className="hist-head__title">
          <h2 className="hist-head__h">History</h2>
          <span className="hist-head__what" aria-live="polite">{headline}</span>
          {selection?.kind === 'range' && (
            <Tooltip content="Stop comparing" side="bottom">
              <button type="button" className="hist-head__clear" aria-label="Stop comparing" onClick={() => to && onSelectVersion(to.id, false)}>
                <X size={14} aria-hidden="true" />
              </button>
            </Tooltip>
          )}
        </div>
        {to && (
          <div className="hist-head__actions">
            {canEdit && (
              <Button size="sm" variant="ghost" icon={Tag} loading={busy === 'label'} onClick={() => void addLabel(to)}>
                Add label
              </Button>
            )}
            <Button size="sm" variant="ghost" icon={Download} loading={busy === 'download'} onClick={() => void downloadVersion(to)}>
              Download .zip
            </Button>
            {canEdit && (
              <Button size="sm" variant="secondary" icon={RotateCcw} loading={busy === 'restore-project'} onClick={() => void restoreProject(to)}>
                Restore project
              </Button>
            )}
          </div>
        )}
      </header>

      <div className="hist-body">
        <nav className="hist-files" aria-label="Files in this version">
          <div className="hist-files__head">
            <Tabs
              variant="pill"
              label="Files"
              active={fileMode}
              onChange={id => setFileMode(id as FileMode)}
              tabs={[
                { id: 'changes', label: 'Changes', badge: to ? changes.length : undefined },
                { id: 'all', label: 'All files' },
              ]}
            />
          </div>
          <div className="hist-files__scroll">
            {!to ? null : allFilesLoading ? (
              <div className="hist-files__loading"><Spinner size={14} label="Loading files" /></div>
            ) : fileEntries.length === 0 ? (
              <p className="hist-files__empty">{fileMode === 'changes' ? 'No file changes in this version.' : 'This version has no files.'}</p>
            ) : (
              <ul className="hist-files__list" role="listbox" aria-label="Files">
                {fileEntries.map(({ path, change: c }) => (
                  <li
                    key={path}
                    role="option"
                    aria-selected={path === selectedPath}
                    tabIndex={path === selectedPath ? 0 : -1}
                    data-path={path}
                    className={clsx('hist-file', path === selectedPath && 'is-selected', c?.op === 'deleted' && 'is-deleted', !c && 'is-unchanged')}
                    onClick={() => setPickedPath(path)}
                    onKeyDown={e => {
                      const i = fileEntries.findIndex(f => f.path === path)
                      let j = -1
                      if (e.key === 'ArrowDown') j = Math.min(fileEntries.length - 1, i + 1)
                      else if (e.key === 'ArrowUp') j = Math.max(0, i - 1)
                      else return
                      e.preventDefault()
                      const next = fileEntries[j]
                      setPickedPath(next.path)
                      requestAnimationFrame(() => e.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-path="${CSS.escape(next.path)}"]`)?.focus())
                    }}
                    title={c?.oldPath ? `${c.oldPath} → ${path}` : path}
                  >
                    <FileIcon path={path} kind="text" className="hist-file__icon" />
                    <span className="hist-file__name">
                      <span className="hist-file__base">{basename(path)}</span>
                      {(dirname(path) || c?.oldPath) && (
                        <span className="hist-file__dir">{c?.op === 'renamed' && c.oldPath ? `from ${c.oldPath}` : `${dirname(path)}/`}</span>
                      )}
                    </span>
                    {c && rangeAuthors.has(path) && <FileAuthors authors={rangeAuthors.get(path)!} meId={meId} />}
                    {c && (
                      <span className={clsx('hist-badge', `hist-badge--${c.op}`)} title={OP_LABEL[c.op]}>
                        <OpIcon op={c.op} size={12} />
                        <span className="hist-badge__text">{OP_LABEL[c.op]}</span>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </nav>

        <main className="hist-main">
          {to && selectedPath ? (
            <>
              <div className="hist-diffbar">
                <FileIcon path={selectedPath} kind="text" size={16} />
                <div className="hist-diffbar__titles">
                  <span className="hist-diffbar__path" title={selectedPath}>{selectedPath}</span>
                  <span className="hist-diffbar__meta">
                    {change ? (
                      <>
                        <span className={clsx('hist-badge', `hist-badge--${change.op}`)}>
                          <OpIcon op={change.op} size={12} />
                          <span className="hist-badge__text">{change.op === 'renamed' && change.oldPath ? `Renamed from ${change.oldPath}` : OP_LABEL[change.op]}</span>
                        </span>
                        {stats && diff?.status === 'ready' && !diff.data?.binary && (
                          <span className="hist-diffbar__stats">
                            {stats.chunks} {stats.chunks === 1 ? 'change' : 'changes'}
                            <span className="hist-stat hist-stat--add">+{stats.added}</span>
                            <span className="hist-stat hist-stat--del">−{stats.removed}</span>
                          </span>
                        )}
                        {selectedAuthors.length > 0 && <ChangedBy authors={selectedAuthors} meId={meId} />}
                      </>
                    ) : (
                      <span className="hist-diffbar__unchanged">Unchanged in this version</span>
                    )}
                  </span>
                </div>
                <div className="hist-diffbar__tools">
                  {change && diff?.status === 'ready' && !diff.data?.binary && (stats?.chunks ?? 0) > 1 && (
                    <>
                      <IconButton size="sm" icon={ChevronUp} label="Previous change" onClick={() => diffRef.current?.prev()} />
                      <IconButton size="sm" icon={ChevronDown} label="Next change" onClick={() => diffRef.current?.next()} />
                    </>
                  )}
                  {diff?.status === 'ready' && diff.data && (diff.data.newText !== null) && (
                    <IconButton
                      size="sm"
                      icon={Download}
                      label="Download this file as it was in this version"
                      onClick={() => downloadUrl(buildUrl(api.historyFileUrl(pid, to.id, selectedPath), { download: 1 }), basename(selectedPath))}
                    />
                  )}
                  {canEdit && diff?.status === 'ready' && diff.data && (change || diff.data.newText !== null) && (
                    <Button size="sm" variant="secondary" icon={RotateCcw} loading={busy === 'restore-file'} onClick={() => void restoreFile()}>
                      {diff.data.newText === null ? 'Restore deleted file' : 'Restore this file'}
                    </Button>
                  )}
                </div>
              </div>
              <div className="hist-diff">
                {!diff || diff.status === 'loading' ? (
                  <div className="hist-diff__state"><Spinner size={18} label="Loading changes" /></div>
                ) : diff.status === 'error' ? (
                  <EmptyState size="sm" icon={FileSearch} title="Changes could not be loaded">{diff.error}</EmptyState>
                ) : diff.data!.binary && !change ? (
                  <VersionFilePreview pid={pid} side={{ versionId: to.id, path: selectedPath }} />
                ) : diff.data!.binary ? (
                  <BinaryDiff
                    pid={pid}
                    before={diff.data!.oldText !== null && diff.data!.from ? { versionId: diff.data!.from, path: change?.oldPath ?? selectedPath } : null}
                    after={diff.data!.newText !== null ? { versionId: to.id, path: selectedPath } : null}
                  />
                ) : (
                  <DiffViewer
                    ref={diffRef}
                    path={selectedPath}
                    oldText={change ? diff.data!.oldText : diff.data!.newText}
                    newText={diff.data!.newText}
                    collapse={!!change}
                    author={change ? diffAuthor : null}
                    onStats={setStats}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="hist-diff__state">
              {listState === 'loading' || allFilesLoading ? (
                <Spinner size={18} label="Loading history" />
              ) : (
                <EmptyState size="sm" icon={FileSearch} title={to ? 'Select a file' : 'Select a version'}>
                  {to ? 'Choose a file on the left to see what changed.' : 'Choose a version on the right to see its changes.'}
                </EmptyState>
              )}
            </div>
          )}
        </main>

        <VersionList
          versions={versions}
          state={listState}
          error={listError}
          hasMore={hasMore}
          loadingMore={loadingMore}
          onLoadMore={() => void loadMore()}
          onRetry={() => void initialLoad()}
          filter={filter}
          onFilter={setFilter}
          selection={selection}
          onSelect={onSelectVersion}
          canEdit={canEdit}
          meId={meId}
          actions={actions}
        />
      </div>
    </div>
  )
}

const nameOf = (a: FileAuthor, meId: string | null) => (a.user.id === meId ? 'You' : a.user.name)

/**
 * "by ● Alice Admin" next to the diff stats: one person → their changes are the ones shown (the
 * diff carries their colour); several → the people who edited this file in those versions.
 */
function ChangedBy({ authors, meId }: { authors: FileAuthor[]; meId: string | null }) {
  const names = authors.map(a => nameOf(a, meId))
  const text = names.length <= 2 ? names.join(' and ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
  const tip = authors.length === 1
    ? `Changed by ${names[0]} · ${formatDateTime(authors[0].at)}`
    : `Edited by ${names.join(', ')}. The history records who edited during each version, not who wrote each line.`
  return (
    <Tooltip content={tip} side="bottom">
      <span className="hist-diffbar__by" tabIndex={0} aria-label={tip}>
        <span className="hist-diffbar__byavatars" aria-hidden="true">
          {authors.slice(0, 3).map(a => <Avatar key={a.user.id} user={{ ...a.user, color: safeColor(a.user.color) }} size={16} decorative />)}
        </span>
        <span className="hist-diffbar__bynames">by {text}</span>
      </span>
    </Tooltip>
  )
}

/** Avatars of the people who changed a file within a compared range (file list). */
function FileAuthors({ authors, meId }: { authors: FileAuthor[]; meId: string | null }) {
  if (authors.length === 0) return null
  const label = `Changed by ${authors.map(a => nameOf(a, meId)).join(', ')}`
  return (
    <span className="hist-file__authors" title={label} aria-label={label} role="img">
      {authors.slice(0, 3).map(a => <Avatar key={a.user.id} user={{ ...a.user, color: safeColor(a.user.color) }} size={16} decorative />)}
      {authors.length > 3 && <span className="hist-file__authorsmore">+{authors.length - 3}</span>}
    </span>
  )
}

function allFileEntries(files: HistoryFilesResponse['files'] | null, changes: NetChange[]): { path: string; change: NetChange | null }[] {
  if (!files) return []
  const byPath = new Map(changes.map(c => [c.path, c]))
  const out = files.map(f => ({ path: f.path, change: byPath.get(f.path) ?? null }))
  // deleted files are not part of the version's tree: list them too (struck through)
  for (const c of changes) if (c.op === 'deleted' && !files.some(f => f.path === c.path)) out.push({ path: c.path, change: c })
  return out.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }))
}

function waitForFileByPath(path: string, timeoutMs: number) {
  const find = () => useProject.getState().fileByPath(path)
  const hit = find()
  if (hit) return Promise.resolve(hit)
  return new Promise<ReturnType<typeof find>>(resolve => {
    const done = () => {
      window.clearTimeout(timer)
      unsub()
      resolve(find())
    }
    const unsub = useProject.subscribe(() => {
      if (find()) done()
    })
    const timer = window.setTimeout(done, timeoutMs)
  })
}
