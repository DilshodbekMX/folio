/**
 * Real-time collaboration through the server, driven from real browser pages (API level: the
 * web core's docSessions, so it does not depend on the editor UI): presence in the top bar,
 * concurrent edits converging without duplication, viewers' edits dropped by the server.
 */
import { expect } from '@playwright/test'
import {
  acquireDoc, apiAs, barrier, docInsert, docText, e2eState, fileIdByPath, folio, openProject, shot, test, userContext, waitForDocText,
} from './helpers'

test('two editors converge, presence shows who is where, the viewer cannot write', async ({ browser }) => {
  const st = e2eState()
  const pid = st.projects.example!
  const alice = await userContext(browser, 'alice')
  const bob = await userContext(browser, 'bob')
  const carol = await userContext(browser, 'carol')
  const pa = await alice.newPage()
  const pb = await bob.newPage()
  const pc = await carol.newPage()
  await openProject(pa, pid)
  await openProject(pb, pid)
  await openProject(pc, pid)

  // presence: everybody sees the others (not themselves)
  const names = (p: typeof pa) => folio(p, f => f.useProject.getState().presence.map((x: any) => x.user.name).sort())
  await expect.poll(() => names(pa)).toEqual(['Bob Editor', 'Carol Viewer'])
  await expect.poll(() => names(pb)).toEqual(['Alice Admin', 'Carol Viewer'])
  await expect(pa.locator('.lay-presence')).toHaveAttribute('aria-label', '2 online')
  // alice opens main.tex: bob's presence shows which file she is in
  const mainId = await fileIdByPath(pa, 'main.tex')
  await folio(pa, (f, id: string) => f.useEditor.getState().openFile(id), mainId)
  await expect.poll(() => folio(pb, f => f.useProject.getState().presence.find((x: any) => x.user.name === 'Alice Admin')?.openFileId ?? null)).toBe(mainId)

  // concurrent edits at both ends converge to the same text, each inserted exactly once
  const fa = await acquireDoc(pa, 'main.tex')
  const fb = await acquireDoc(pb, 'main.tex')
  const fc = await acquireDoc(pc, 'main.tex')
  const original = await docText(pa, fa)
  await Promise.all([
    docInsert(pa, fa, 0, '% alice was here\n'),
    (async () => docInsert(pb, fb, (await docText(pb, fb)).length, '\n% bob was here\n'))(),
  ])
  await barrier(pa)
  await barrier(pb)
  await waitForDocText(pa, fa, '% bob was here')
  await waitForDocText(pb, fb, '% alice was here')
  const ta = await docText(pa, fa)
  expect(await docText(pb, fb)).toBe(ta)
  expect(ta.split('% alice was here').length - 1).toBe(1)
  expect(ta.split('% bob was here').length - 1).toBe(1)
  expect(ta.length).toBe(original.length + '% alice was here\n'.length + '\n% bob was here\n'.length)
  // the viewer receives the edits…
  await waitForDocText(pc, fc, '% bob was here')
  // …but her own are never applied by the server
  await docInsert(pc, fc, 0, '% carol cannot write\n')
  await barrier(pc)
  await barrier(pa)
  expect(await docText(pa, fa)).not.toContain('carol')
  const api = await apiAs('alice')
  expect(await (await api.get(`/api/projects/${pid}/files/${fa}/raw`)).text()).toBe(ta)

  await shot(pa, 'project-alice-light')
  await pa.emulateMedia({ colorScheme: 'dark' })
  await shot(pa, 'project-alice-dark')

  // undo our edits for the other specs
  await folio(pa, (f: any, id: string) => {
    const t = (window as any).__e2eDocs[id].ytext
    const s = t.toString()
    const i = s.indexOf('% alice was here\n')
    if (i >= 0) t.delete(i, '% alice was here\n'.length)
    const s2 = t.toString()
    const j = s2.indexOf('\n% bob was here\n')
    if (j >= 0) t.delete(j, '\n% bob was here\n'.length)
  }, fa)
  await barrier(pa)
  expect(await (await api.get(`/api/projects/${pid}/files/${fa}/raw`)).text()).toBe(original)
  await api.dispose()
  for (const c of [alice, bob, carol]) await c.close()
})
