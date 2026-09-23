/**
 * Word count (File → Word count): texcount run by the server over the main document and the
 * files it \input/\includes. Shows words in the main text as the headline, plus headers,
 * captions, the number of sections/floats and inline/display math; the raw texcount report can
 * be expanded. Loading, error (with retry) and refresh are handled here.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { WordCountResponse } from '@folio/shared/api'
import { api } from '../../api/endpoints'
import { errorMessage } from '../../api/client'
import { useProject } from '../../stores/project'
import { Button, Modal, Spinner } from '../../ui'
import './wordcount.css'

const nf = new Intl.NumberFormat('en-US')

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; data: WordCountResponse; at: number }

function Stat({ label, value, detail }: { label: string; value: number; detail?: string }) {
  return (
    <div className="wc-stat">
      <dt className="wc-stat__label">{label}</dt>
      <dd className="wc-stat__value">
        {nf.format(value)}
        {detail && <span className="wc-stat__detail">{detail}</span>}
      </dd>
    </div>
  )
}

export function WordCountModal({ onClose }: { onClose: () => void }) {
  const projectId = useProject(s => s.projectId)
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [showRaw, setShowRaw] = useState(false)
  const reqRef = useRef<AbortController | null>(null)

  const load = useCallback(() => {
    if (!projectId) return
    reqRef.current?.abort()
    const ac = new AbortController()
    reqRef.current = ac
    setState({ kind: 'loading' })
    api
      .wordCount(projectId, {}, { signal: ac.signal })
      .then(data => {
        if (!ac.signal.aborted) setState({ kind: 'ready', data, at: Date.now() })
      })
      .catch(e => {
        if (ac.signal.aborted) return
        setState({ kind: 'error', message: errorMessage(e, 'The words could not be counted.') })
      })
  }, [projectId])

  useEffect(() => {
    load()
    return () => reqRef.current?.abort()
  }, [load])

  let body
  if (state.kind === 'loading') {
    body = (
      <div className="wc-state" aria-busy="true">
        <Spinner size={22} label={null} />
        <p>Counting words…</p>
      </div>
    )
  } else if (state.kind === 'error') {
    body = (
      <div className="wc-state wc-state--error" role="alert">
        <p className="wc-state__title">Couldn’t count the words</p>
        <p>{state.message}</p>
        <Button size="sm" icon={RefreshCw} onClick={load}>
          Try again
        </Button>
      </div>
    )
  } else {
    const d = state.data
    const total = d.textWords + d.headerWords + d.captionWords
    body = (
      <div className="wc-body">
        <div className="wc-hero">
          <span className="wc-hero__value" data-testid="wc-total">{nf.format(d.textWords)}</span>
          <span className="wc-hero__label">words in the main text</span>
        </div>
        <dl className="wc-grid">
          <Stat label="Headers" value={d.headerWords} detail={`${nf.format(d.headers)} ${d.headers === 1 ? 'heading' : 'headings'}`} />
          <Stat label="Captions & other" value={d.captionWords} detail="outside the main text" />
          <Stat label="All words" value={total} detail="text + headers + captions" />
          <Stat label="Floats" value={d.floats} detail="figures & tables" />
          <Stat label="Math inline" value={d.mathInline} />
          <Stat label="Math display" value={d.mathDisplay} />
        </dl>
        <p className="wc-note">
          Counted by texcount in <code>{d.rootPath}</code> and the files it includes. References and LaTeX commands are not counted;
          <code>%TC:ignore</code> … <code>%TC:endignore</code> excludes parts of the text.
        </p>
        {d.raw.trim() && (
          <div className="wc-raw">
            <button type="button" className="wc-raw__toggle" aria-expanded={showRaw} onClick={() => setShowRaw(v => !v)}>
              {showRaw ? 'Hide the texcount report' : 'Show the texcount report'}
            </button>
            {showRaw && (
              <pre className="wc-raw__pre" tabIndex={0}>
                {d.raw.trim()}
              </pre>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <Modal
      open
      onClose={onClose}
      title="Word count"
      size="sm"
      footer={
        <>
          {state.kind === 'ready' && (
            <Button variant="ghost" icon={RefreshCw} onClick={load}>
              Recount
            </Button>
          )}
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        </>
      }
    >
      {body}
    </Modal>
  )
}
