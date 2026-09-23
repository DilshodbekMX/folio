/**
 * GET /api/projects/:pid/search?q=&regex=0|1&caseSensitive=0|1&wholeWord=0|1 (viewer+):
 * searches the live text of every text file (CollabService.getText), line by line; at most
 * 2000 matches (then `truncated`), previews are the matching line cut to 200 characters.
 */
import express from 'express'
import { z } from 'zod'
import { comparePaths } from '@folio/shared/paths'
import type { SearchResponse } from '@folio/shared/api'
import { getProject } from '../http/request.ts'
import { requireProjectRole } from '../auth/middleware.ts'
import type { Services } from '../services.ts'
import { searchFiles, type SearchInputFile } from './engine.ts'

export const MAX_SEARCH_MATCHES = 2000

const flag = z.enum(['0', '1', 'true', 'false']).optional().transform(v => v === '1' || v === 'true')
const querySchema = z.object({
  q: z.string().min(1, 'Enter something to search for').max(1000),
  regex: flag,
  caseSensitive: flag,
  wholeWord: flag,
})

export function searchRoutes(s: Services): express.Router {
  const r = express.Router()

  r.get('/api/projects/:pid/search', requireProjectRole('viewer'), async (req, res) => {
    const { project } = getProject(req)
    const q = querySchema.parse(req.query)
    const entries = s.files.list(project.id).filter(f => f.kind === 'text').sort((a, b) => comparePaths(a.path, b.path))
    const files: SearchInputFile[] = []
    for (const e of entries) files.push({ fileId: e.id, path: e.path, text: await s.collab.getText(project.id, e.id) })
    const out = await searchFiles(files, { q: q.q, regex: q.regex, caseSensitive: q.caseSensitive, wholeWord: q.wholeWord, maxMatches: MAX_SEARCH_MATCHES })
    const body: SearchResponse = { results: out.results, truncated: out.truncated }
    res.setHeader('Cache-Control', 'no-store')
    res.json(body)
  })

  return r
}
