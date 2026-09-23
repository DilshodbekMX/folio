/**
 * Turn a build's raw logs into the ParsedLog of CompileResponse, using `@folio/shared/texlog`
 * (loaded lazily: a broken or missing parser must never break compiling — the raw log is
 * still published and the UI falls back to it).
 *
 * Paths: latexmk runs with -cd, so TeX's working directory is the root document's folder and
 * the log prints `./x.tex` relative to it. For a root in a sub-folder we parse in that folder's
 * coordinate system — every project file expressed relative to it, so files outside the folder
 * read with `\input{../shared/defs}` are `../shared/defs.tex` — and map the results back to
 * project paths afterwards.
 */
import path from 'node:path'
import type { LogEntry, ParsedLog } from '@folio/shared/api'
import { moduleLog } from '../log.ts'

const log = moduleLog('compile.logs')

type Texlog = typeof import('@folio/shared/texlog')

const TEXLOG_MODULE = '@folio/shared/texlog'
let texlogPromise: Promise<Texlog | null> | null = null

export function loadTexlog(): Promise<Texlog | null> {
  texlogPromise ??= (import(/* @vite-ignore */ TEXLOG_MODULE) as Promise<Texlog>).catch(err => {
    log.error({ err }, 'log parser (@folio/shared/texlog) unavailable; compile logs will not be parsed')
    return null
  })
  return texlogPromise
}

export interface LogInputs {
  /** <job>.log bytes, null when no log was produced by this build */
  logBytes: Buffer | null
  /** <job>.blg text, null when there is none */
  blgText: string | null
  /** latexmk output (xdvipdfmx problems, unstable references) */
  stdout: string
  /** every project file path */
  projectFiles: string[]
  /** project path of the compiled root document */
  rootPath: string
  /** the compile dir as TeX saw it ('/compile' in the sandbox) */
  texCompileDir: string
  /** live text of a project file (for source lookups), null if unknown */
  getSource: (projectPath: string) => string | null
}

export async function parseCompileLogs(i: LogInputs): Promise<ParsedLog | null> {
  if (!i.logBytes && !i.blgText) return null
  const texlog = await loadTexlog()
  if (!texlog) return null
  const rootDir = path.posix.dirname(i.rootPath) === '.' ? '' : path.posix.dirname(i.rootPath)
  const files = rootDir ? i.projectFiles.map(f => path.posix.relative(rootDir, f)) : i.projectFiles
  const compileDir = rootDir ? `${i.texCompileDir.replace(/\/+$/, '')}/${rootDir}` : i.texCompileDir
  /** a path relative to the root's folder → project path */
  const toProject = (p: string) => (rootDir ? path.posix.normalize(path.posix.join(rootDir, p)) : p)
  const getSource = (p: string) => i.getSource(toProject(p))
  try {
    const opts = { projectFiles: files, compileDir, rootPath: path.posix.basename(i.rootPath), getSource }
    const latex = i.logBytes ? texlog.parseLatexLog(i.logBytes, opts) : null
    const blg = i.blgText ? texlog.parseBlg(i.blgText, opts) : null
    const lmk = texlog.parseLatexmkOutput(i.stdout, opts)
    const merged = texlog.mergeLogs(latex, blg, lmk)
    if (!rootDir) return merged
    const fix = (e: LogEntry): LogEntry => (e.file ? { ...e, file: toProject(e.file) } : e)
    return {
      errors: merged.errors.map(fix),
      warnings: merged.warnings.map(fix),
      typesetting: merged.typesetting.map(fix),
      info: merged.info.map(fix),
    }
  } catch (err) {
    log.error({ err, rootPath: i.rootPath }, 'log parsing failed')
    return null
  }
}
