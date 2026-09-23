/**
 * Where you were is kept (J-3): each file's cursor and first visible line survive switching
 * files and reloading the page (localStorage 'folio:editorpos:<pid>'), without creeping by a
 * line per reload; a jump (the outline) wins over the remembered place.
 */
import { expect, type Page } from '@playwright/test'
import { authFile, folio, newProject, openFile, openProject, removeProject, test } from './helpers'

const lines = (n: number, tag: string) => Array.from({ length: n }, (_, i) => `% ${tag} line ${i + 1}`)
const MAIN = ['\\documentclass{article}', '\\begin{document}', ...lines(300, 'main'), '\\section{Near the end}', 'End.', '\\end{document}', ''].join('\n')
const SECOND = [...lines(200, 'second'), ''].join('\n')

let pid: string

test.use({ storageState: authFile('alice') })

test.beforeAll(async () => {
  pid = await newProject('E2E Editor Positions', { files: [{ path: 'main.tex', content: MAIN }, { path: 'second.tex', content: SECOND }], members: false })
})
test.afterAll(async () => {
  if (pid) await removeProject(pid)
})

interface Where { line: number; col: number; top: number }

/** cursor line/column and the first visible line, computed like the editor does */
function where(page: Page): Promise<Where> {
  return folio(page, f => {
    const v = f.useEditor.getState().view
    const head = v.state.selection.main.head
    const line = v.state.doc.lineAt(head)
    const rect = v.scrollDOM.getBoundingClientRect()
    const top = v.scrollDOM.scrollTop <= 0 ? 1 : v.state.doc.lineAt(v.lineBlockAtHeight(rect.top - v.documentTop + 1).from).number
    return { line: line.number as number, col: (head - line.from) as number, top: top as number }
  })
}

/** put the caret at line:col and scroll so that line `top` is the first one visible */
async function place(page: Page, w: Where): Promise<Where> {
  await folio(page, (f, a: Where) => {
    const v = f.useEditor.getState().view
    v.focus()
    v.dispatch({ selection: { anchor: v.state.doc.line(a.line).from + a.col } })
    v.scrollDOM.scrollTop = v.lineBlockAt(v.state.doc.line(a.top).from).top
  }, w)
  // positions are written about once a second
  await page.waitForTimeout(1500)
  return where(page)
}

async function reopen(page: Page, file: string, line: number): Promise<Where> {
  await openFile(page, file)
  await page.waitForFunction(l => {
    const v = (window as any).__folio.useEditor.getState().view
    return !!v && v.state.doc.lineAt(v.state.selection.main.head).number === l && v.scrollDOM.scrollTop > 0
  }, line, { timeout: 20_000 })
  await page.waitForTimeout(300) // the scroll is applied once the editor has its size
  return where(page)
}

test('cursor and scroll position of each file survive switching files and reloading', async ({ page }) => {
  await openProject(page, pid)
  await openFile(page, 'main.tex')
  const inMain = await place(page, { line: 250, col: 5, top: 232 })
  expect(inMain.line).toBe(250)
  expect(inMain.top).toBeGreaterThan(200)

  await openFile(page, 'second.tex')
  const inSecond = await place(page, { line: 120, col: 2, top: 101 })
  expect(inSecond.line).toBe(120)

  // switching back within the session
  expect(await reopen(page, 'main.tex', 250)).toEqual(inMain)

  // two reloads in a row: the same place each time (no creeping by a line)
  for (let i = 0; i < 2; i++) {
    await page.reload()
    await openProject(page, pid)
    expect(await reopen(page, 'main.tex', 250)).toEqual(inMain)
    expect(await reopen(page, 'second.tex', 120)).toEqual(inSecond)
  }
  const stored = await page.evaluate(id => JSON.parse(localStorage.getItem(`folio:editorpos:${id}`) ?? '{}'), pid)
  expect(Object.keys(stored)).toHaveLength(2)

  // a jump asked for somewhere else wins over the remembered place
  await page.reload()
  await openProject(page, pid)
  await openFile(page, 'second.tex')
  const mainId = await folio(page, f => f.useProject.getState().fileByPath('main.tex').id as string)
  await folio(page, (f, id: string) => f.useEditor.getState().jumpTo({ fileId: id, line: 303 }), mainId)
  await page.waitForFunction(() => {
    const v = (window as any).__folio.useEditor.getState().view
    return !!v && v.state.doc.lineAt(v.state.selection.main.head).number === 303
  }, undefined, { timeout: 20_000 })
  await page.waitForTimeout(500)
  expect((await where(page)).line).toBe(303)
  await expect(page.locator('.cm-line', { hasText: 'Near the end' })).toBeInViewport()
})
