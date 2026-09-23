import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { useAuth } from '../stores/auth'
import { FolioLogo } from '../ui'

/** Two-column frame for the sign-in pages: form on the left, a typeset "folio" on the right. */
export function AuthShell({ title, subtitle, children, footer }: { title: ReactNode; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const version = useAuth(s => s.setup?.version)
  return (
    <div className="pg-auth">
      <div className="pg-auth__col">
        <header className="pg-auth__brand">
          <Link to="/" aria-label="Folio">
            <FolioLogo size={24} />
          </Link>
        </header>
        <main className="pg-auth__main">
          <h1 className="pg-auth__title">{title}</h1>
          {subtitle && <p className="pg-auth__subtitle">{subtitle}</p>}
          {children}
          {footer && <div className="pg-auth__alt">{footer}</div>}
        </main>
        <footer className="pg-auth__foot">
          Self-hosted LaTeX, written together{version ? ` · v${version}` : ''}
        </footer>
      </div>
      <aside className="pg-auth__art" aria-hidden="true">
        <Specimen />
      </aside>
    </div>
  )
}

/**
 * A typeset page with its source beside it; the highlighted sentence and source line are the
 * same text, which is what Folio's two-way sync does in the editor.
 */
function Specimen() {
  return (
    <div className="pg-spec">
      <div className="pg-spec__page">
        <div className="pg-spec__running">
          <span>Draft</span>
          <span>Keeping source and page in step</span>
        </div>
        <h2 className="pg-spec__title">Keeping source and page in step</h2>
        <p className="pg-spec__authors">Ada Rivera · Tomás Ferreira · Lin Wei</p>
        <p className="pg-spec__abstract">
          <span className="pg-spec__abs-head">Abstract.</span> We describe a way of writing a paper together in which nobody waits
          for anybody: edits travel as they are typed, and the page is set again within seconds.
        </p>
        <h3 className="pg-spec__h">
          <span className="pg-spec__num">1</span>Introduction
        </h3>
        <p className="pg-spec__p">Writing together works best when the source and the page never drift apart.</p>
        <p className="pg-spec__p pg-spec__p--hl">
          <span className="pg-spec__pin">main.tex:15</span>
          Click a line of source and the page shows where it lands; double-click the page and the cursor goes home.
        </p>
        <div className="pg-spec__eq">
          <span className="pg-spec__math">
            <i>E</i>(<i>t</i>) = <span className="pg-spec__frac"><span><i>n</i><sub>0</sub></span><span><i>t</i> + <i>τ</i></span></span> + <i>ε</i>
          </span>
          <span className="pg-spec__eqno">(1)</span>
        </div>
        <p className="pg-spec__p pg-spec__p--fade">
          In Section&nbsp;2 we show why the second property matters more than the first, and how a shared history turns every
          collaborator’s version into one continuous record.
        </p>
        <div className="pg-spec__folio">1</div>
      </div>

      <div className="pg-spec__src">
        <div className="pg-spec__srcbar">
          <span className="pg-spec__dot" />
          <span className="pg-spec__dot" />
          <span className="pg-spec__dot" />
          <span className="pg-spec__file">main.tex</span>
        </div>
        <ol className="pg-spec__code" start={11}>
          <li><span className="t-cmd">\section</span><span className="t-brace">{'{'}</span>Introduction<span className="t-brace">{'}'}</span></li>
          <li>Writing together works best when the</li>
          <li>source and the page never drift apart.</li>
          <li />
          <li className="is-hl">Click a line of source and the page…<span className="pg-spec__caret" /></li>
          <li><span className="t-cmd">\begin</span><span className="t-brace">{'{'}</span><span className="t-env">equation</span><span className="t-brace">{'}'}</span></li>
          <li>{'  '}E(t) = <span className="t-cmd">\frac</span>{'{n_0}{t + \\tau}'} + <span className="t-cmd">\varepsilon</span></li>
          <li><span className="t-cmd">\end</span><span className="t-brace">{'{'}</span><span className="t-env">equation</span><span className="t-brace">{'}'}</span></li>
        </ol>
      </div>
    </div>
  )
}
