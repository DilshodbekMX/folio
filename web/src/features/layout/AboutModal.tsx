import { useEffect, useState } from 'react'
import type { SystemInfo } from '@folio/shared/api'
import { COMPILERS } from '@folio/shared/api'
import { api } from '../../api/endpoints'
import { errorMessage, isAbortError } from '../../api/client'
import { FolioMark, Modal, Spinner } from '../../ui'
import { HELP_URL, useChrome } from './uiState'

const RUNNERS: Record<SystemInfo['compileRunner'], string> = {
  docker: 'Sandboxed Docker container',
  local: 'Local TeX installation (not sandboxed)',
  fake: 'Test runner (no TeX)',
}

export function AboutModal() {
  const open = useChrome(s => s.aboutOpen)
  const setOpen = useChrome(s => s.setAboutOpen)
  const [info, setInfo] = useState<SystemInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const ctrl = new AbortController()
    setError(null)
    api.system({ signal: ctrl.signal }).then(setInfo, e => {
      if (!isAbortError(e)) setError(errorMessage(e))
    })
    return () => ctrl.abort()
  }, [open])

  const engines = info?.engines.map(id => COMPILERS.find(c => c.id === id)?.label ?? id).join(', ')

  return (
    <Modal open={open} onClose={() => setOpen(false)} title="About Folio" size="sm">
      <div className="lay-about">
        <div className="lay-about__head">
          <FolioMark size={40} tile />
          <div>
            <div className="lay-about__name">Folio{info ? ` ${info.version}` : ''}</div>
            <div className="lay-about__tag">A self-hosted, collaborative LaTeX editor.</div>
          </div>
        </div>
        {error && <p className="lay-about__error">{error}</p>}
        {!info && !error && (
          <div className="lay-about__loading">
            <Spinner size={16} />
          </div>
        )}
        {info && (
          <dl className="lay-about__facts">
            <dt>TeX distribution</dt>
            <dd>{info.texLive ?? 'Unknown'}</dd>
            <dt>Compiles run in</dt>
            <dd>{RUNNERS[info.compileRunner]}</dd>
            {info.compileRunner === 'docker' && (
              <>
                <dt>Image</dt>
                <dd className="lay-about__mono">{info.compileImage}</dd>
                <dt>Docker</dt>
                <dd>{info.dockerOk ? 'Available' : 'Not reachable — compiles will fail'}</dd>
              </>
            )}
            <dt>Compilers</dt>
            <dd>{engines || '—'}</dd>
          </dl>
        )}
        <p className="lay-about__links">
          <a href={HELP_URL} target="_blank" rel="noopener noreferrer">
            User guide
          </a>
        </p>
      </div>
    </Modal>
  )
}
