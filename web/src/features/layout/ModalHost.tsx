import { useEffect, useRef } from 'react'
import { useLayout, type ModalState } from '../../stores/layout'
import { ShareModal } from '../share/ShareModal'
import { SettingsModal } from '../settings/SettingsModal'
import { WordCountModal } from '../wordcount/WordCountModal'
import { ShortcutsModal } from '../shortcuts/ShortcutsModal'
import { UploadModal } from '../filetree/UploadModal'
import { SymbolPalette } from '../editor/SymbolPalette'
import { AboutModal } from './AboutModal'
import { promptNewEntry } from './newEntry'

function folderProp(modal: ModalState): string {
  const f = modal.props?.folder
  return typeof f === 'string' ? f : ''
}

/** Renders the modal named by useLayout.modal (plus the About dialog). */
export function ModalHost() {
  const modal = useLayout(s => s.modal)
  const closeModal = useLayout(s => s.closeModal)
  const handled = useRef<ModalState | null>(null)

  // "New file" / "New folder" are prompt dialogs rather than components.
  useEffect(() => {
    if (!modal || (modal.type !== 'newfile' && modal.type !== 'newfolder')) return
    if (handled.current === modal) return
    handled.current = modal
    closeModal()
    void promptNewEntry(modal.type === 'newfolder' ? 'folder' : 'text', folderProp(modal))
  }, [modal, closeModal])

  let content = null
  if (modal) {
    switch (modal.type) {
      case 'share':
        content = <ShareModal onClose={closeModal} />
        break
      case 'settings':
        content = <SettingsModal onClose={closeModal} />
        break
      case 'wordcount':
        content = <WordCountModal onClose={closeModal} />
        break
      case 'shortcuts':
        content = <ShortcutsModal onClose={closeModal} />
        break
      case 'upload':
        content = <UploadModal onClose={closeModal} folder={folderProp(modal) || undefined} />
        break
      case 'symbols':
        content = <SymbolPalette onClose={closeModal} />
        break
      default:
        content = null
    }
  }
  return (
    <>
      {content}
      <AboutModal />
    </>
  )
}
