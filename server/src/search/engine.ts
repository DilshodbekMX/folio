/**
 * Project-wide search engine.
 *
 * The matcher is written as a self-contained JavaScript source string so the exact same code
 * can run in-process (literal searches — escaped patterns cannot backtrack catastrophically)
 * and in a short-lived worker thread (user regular expressions), where a pathological pattern
 * (ReDoS) is stopped by terminating the worker instead of blocking the event loop that also
 * serves every collaboration socket.
 */
import { Worker } from 'node:worker_threads'
import pLimit from 'p-limit'
import type { SearchFileResult } from '@folio/shared/api'
import { badRequest, HttpError } from '../http/errors.ts'

export interface SearchInputFile { fileId: string; path: string; text: string }
export interface SearchOptions { q: string; regex: boolean; caseSensitive: boolean; wholeWord: boolean; maxMatches: number }
export interface SearchOutput { results: SearchFileResult[]; truncated: boolean; error?: string }

export const PREVIEW_LENGTH = 200

const CORE = String.raw`
function makePreview(line, column, length) {
  if (line.length <= ${PREVIEW_LENGTH}) return line
  if (column + length <= ${PREVIEW_LENGTH} - 20) return line.slice(0, ${PREVIEW_LENGTH})
  var start = Math.max(0, column - 60)
  return '…' + line.slice(start, start + ${PREVIEW_LENGTH} - 1)
}
function runSearch(files, opts) {
  var source = opts.regex ? opts.q : opts.q.replace(/[.*+?^$\{\}()|[\]\\\/]/g, '\\$&')
  if (opts.wholeWord) source = '(?<![\\p{L}\\p{N}_])(?:' + source + ')(?![\\p{L}\\p{N}_])'
  var re
  try {
    re = new RegExp(source, 'g' + (opts.wholeWord ? 'u' : '') + (opts.caseSensitive ? '' : 'i'))
  } catch (e) {
    return { results: [], truncated: false, error: 'Invalid regular expression: ' + (e && e.message ? e.message : String(e)) }
  }
  var results = []
  var total = 0
  for (var f = 0; f < files.length; f++) {
    var file = files[f]
    var matches = []
    var lines = file.text.split('\n')
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i]
      re.lastIndex = 0
      var m
      while ((m = re.exec(line)) !== null) {
        if (m[0].length === 0) {
          re.lastIndex = m.index + 1
          if (re.lastIndex > line.length) break
          continue
        }
        matches.push({ line: i + 1, column: m.index, length: m[0].length, preview: makePreview(line, m.index, m[0].length) })
        total++
        if (total >= opts.maxMatches) {
          results.push({ fileId: file.fileId, path: file.path, matches: matches })
          return { results: results, truncated: true }
        }
      }
    }
    if (matches.length) results.push({ fileId: file.fileId, path: file.path, matches: matches })
  }
  return { results: results, truncated: false }
}
`

// eslint-disable-next-line @typescript-eslint/no-implied-eval
const runInProcess = new Function(`${CORE}; return runSearch`)() as (files: SearchInputFile[], opts: SearchOptions) => SearchOutput

const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
${CORE}
parentPort.postMessage(runSearch(workerData.files, workerData.opts))
`

function runInWorker(files: SearchInputFile[], opts: SearchOptions, timeoutMs: number): Promise<SearchOutput> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_SOURCE, { eval: true, workerData: { files, opts }, resourceLimits: { maxOldGenerationSizeMb: 256 } })
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      void worker.terminate()
      reject(badRequest('The search took too long. Simplify the regular expression.'))
    }, timeoutMs)
    worker.once('message', (out: SearchOutput) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resolve(out)
    })
    worker.once('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    worker.once('exit', code => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new Error(`search worker exited with code ${code}`))
    })
  })
}

/** Regex searches running at once (each is a worker thread with up to 256 MB of heap) and waiting. */
export const REGEX_WORKERS = 2
export const REGEX_QUEUE_MAX = 8
const workerLimit = pLimit(REGEX_WORKERS)

/** Search `files`; regex searches run in a worker with a time limit. Throws 400 for invalid regexes. */
export async function searchFiles(files: SearchInputFile[], opts: SearchOptions, timeoutMs = 5000): Promise<SearchOutput> {
  if (opts.regex && workerLimit.activeCount >= REGEX_WORKERS && workerLimit.pendingCount >= REGEX_QUEUE_MAX) {
    throw new HttpError(503, 'unavailable', 'Too many searches are running; please try again in a moment.')
  }
  const out = opts.regex ? await workerLimit(() => runInWorker(files, opts, timeoutMs)) : runInProcess(files, opts)
  if (out.error) throw badRequest(out.error)
  return out
}
