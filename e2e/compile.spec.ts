/**
 * Compiling through the server from a browser page: the compile store (barrier → POST) returns a
 * build whose PDF and log are served; a collaborator is told about it (compile:done → lastCompile).
 * The real paper's acceptance test (XeLaTeX + xr, no errors, no undefined references) is in
 * paper.spec.ts.
 */
import { expect } from '@playwright/test'
import { acquireDoc, apiAs, compile, docInsert, docText, e2eState, folio, openProject, test, userContext } from './helpers'

test('compile the Example project; a collaborator receives the new build', async ({ browser }) => {
  const st = e2eState()
  const pid = st.projects.example!
  const alice = await userContext(browser, 'alice')
  const bob = await userContext(browser, 'bob')
  const pa = await alice.newPage()
  const pb = await bob.newPage()
  await openProject(pa, pid)
  await openProject(pb, pid)
  // the compile must see the very last keystroke (barrier before the POST)
  const fa = await acquireDoc(pa, 'main.tex')
  const marker = `% compiled ${Date.now()}`
  await docInsert(pa, fa, (await docText(pa, fa)).length, `\n${marker}\n`)
  const r = await compile(pa)
  expect(r.status).toBe('success')
  expect(r.buildId).toMatch(/^[0-9a-f]{8,}-[0-9a-f]{16}$/)
  const last = await folio(pa, f => f.useCompile.getState().last)
  const pdf = await pa.evaluate(u => fetch(u).then(async res => ({ status: res.status, type: res.headers.get('content-type'), head: new TextDecoder().decode((await res.arrayBuffer()).slice(0, 5)) })), last.pdfUrl)
  expect(pdf).toEqual({ status: 200, type: 'application/pdf', head: '%PDF-' })
  // bob's page learns about alice's build (compile:done event → lastCompile)
  await pb.waitForFunction(id => (window as any).__folio.useCompile.getState().last?.buildId === id, r.buildId, { timeout: 20_000 })
  // the log is served as plain text (the real engine banner with Docker, the fixture otherwise)
  const api = await apiAs('bob')
  const logRes = await api.get(last.logUrl)
  expect(logRes.status()).toBe(200)
  expect(logRes.headers()['content-type']).toBe('text/plain; charset=utf-8')
  if (st.runner === 'docker') expect(await logRes.text()).toMatch(/This is pdfTeX/)
  await api.dispose()
  // put the file back
  await folio(pa, (f: any, [id, m]: [string, string]) => {
    const t = (window as any).__e2eDocs[id].ytext
    const i = t.toString().indexOf(`\n${m}\n`)
    if (i >= 0) t.delete(i, m.length + 2)
  }, [fa, marker])
  await folio(pa, f => f.docSessions.barrierAll())
  await alice.close()
  await bob.close()
})
