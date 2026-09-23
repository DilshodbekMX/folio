/**
 * latexmk stdout: messages that never reach the TeX .log (xdvipdfmx problems, unstable
 * references after the maximum number of runs, .bib files that do not exist — latexmk then
 * vetoes BibTeX/Biber, so there is no .blg either). Strings taken from latexmk 4.88.
 */
import type { ParsedLog } from '../api.ts'
import { bucket } from './latex.ts'
import type { LogEntry } from '../api.ts'
import { escapeRegExp, findInSources, SourceCache, type SourceGetter } from './pathmap.ts'

export interface LatexmkParseOptions {
  /** project files (as in LogParseOptions): .tex files are searched for the \bibliography naming a missing .bib */
  projectFiles?: string[]
  /** root document (searched first) */
  rootPath?: string | null
  getSource?: SourceGetter
}

export interface LatexmkSummary {
  version: string | null
  /** number of *latex runs */
  runs: number
  /** 'Maximum runs … reached without getting stable files' */
  unstable: boolean
  /** 'Errors, so I did not complete making targets' / '…in force_mode…' */
  hadErrors: boolean
  upToDate: boolean
}

export function summarizeLatexmk(stdout: string): LatexmkSummary {
  const s: LatexmkSummary = { version: null, runs: 0, unstable: false, hadErrors: false, upToDate: false }
  for (const l of stdout.replace(/\r\n?/g, '\n').split('\n')) {
    let m: RegExpExecArray | null
    if ((m = /^Latexmk: This is Latexmk, .*Version (\S+?)\.?$/.exec(l))) s.version = m[1]
    else if ((m = /^Run number (\d+) of rule '(?:pdf|xe|lua)?latex'$/.exec(l))) s.runs++
    else if (/^Latexmk: Maximum runs of \S+ reached without getting stable files/.test(l)) s.unstable = true
    else if (/^Latexmk: Errors, /.test(l)) s.hadErrors = true
    else if (/^Latexmk: All targets .* are up-to-date/.test(l)) s.upToDate = true
  }
  return s
}

const MISSING_BIB_HINT = 'The .bib file named in \\bibliography{…} (or \\addbibresource{…}) is not in the project, so BibTeX/Biber did not run and the citations stay undefined. Check the name and its path relative to the main document, and upload the .bib file.'

/** Entries (source 'latexmk') for problems only visible in latexmk's output. */
export function parseLatexmkOutput(stdout: string, opts: LatexmkParseOptions = {}): ParsedLog {
  const out: LogEntry[] = []
  const lines = stdout.replace(/\r\n?/g, '\n').split('\n')
  const missingBib = new Map<string, string[]>()
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    // 'Bib file(s) not found in search path:' / '…but the following didn't:', then indented names
    if (/^Bib file\(s\) not found in search path:\s*$|^but the following didn't:\s*$/.test(l)) {
      for (let j = i + 1; j < lines.length && j <= i + 50; j++) {
        const f = /^\s+(\S+\.bib)\s*$/i.exec(lines[j])
        if (!f) break
        if (!missingBib.has(f[1])) missingBib.set(f[1], [l, lines[j]])
      }
      continue
    }
    let m: RegExpExecArray | null
    if ((m = /^xdvipdfmx:(warning|fatal): (.*)$/.exec(l))) {
      out.push({
        level: m[1] === 'fatal' ? 'error' : 'warning', message: `xdvipdfmx: ${m[2]}`, content: l,
        file: null, line: null, source: 'latexmk', kind: `xdvipdfmx-${m[1]}`,
      })
    } else if ((m = /^Latexmk: Maximum runs of (\S+) reached without getting stable files/.exec(l))) {
      out.push({
        level: 'warning', message: `References did not stabilise after the maximum number of ${m[1]} runs.`, content: l,
        file: null, line: null, source: 'latexmk', kind: 'unstable',
        hint: 'Cross-references kept changing between runs. Recompile once more; if it persists, look for labels or page references whose value changes the layout.',
      })
    }
  }
  if (missingBib.size > 0) {
    const sources = new SourceCache(opts.getSource)
    const tex = (opts.projectFiles ?? []).filter(f => /\.(?:tex|ltx|latex)$/i.test(f))
    const root = opts.rootPath ?? null
    const files = root ? [root, ...tex.filter(f => f !== root)] : tex
    for (const [name, content] of missingBib) {
      const base = escapeRegExp(name.replace(/\.bib$/i, ''))
      const at = findInSources(files, sources, new RegExp(`\\\\(?:bibliography|addbibresource|addglobalbib|addsectionbib|nobibliography)\\s*(?:\\[[^\\]]*\\])?\\s*\\{(?:[^}]*[,\\s/])?${base}(?:\\.bib)?\\s*[,}]`))
      out.push({
        level: 'error', kind: 'missing-bib', source: 'latexmk', message: `Bibliography file "${name}" not found`,
        content: content.join('\n'), file: at?.file ?? null, line: at?.line ?? null, hint: MISSING_BIB_HINT,
      })
    }
  }
  return bucket(out)
}
