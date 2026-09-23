/**
 * History model helpers: who changed a file in the selected versions (J-8) and the file name of
 * a version's .zip (J-9).
 */
import { describe, expect, it } from 'vitest'
import type { FileChange, HistoryVersion, Label, UserPublic } from '@folio/shared/api'
import { fileAuthors, versionZipName } from './model'

const user = (id: string): UserPublic => ({ id, name: id.toUpperCase(), email: `${id}@example.com`, color: '#123456' })
const version = (id: string, createdAt: number, authors: string[], changes: FileChange[]): HistoryVersion => ({
  id, parentId: null, createdAt, authors: authors.map(user), reason: 'auto', labels: [], changes,
})
const label = (name: string, createdAt: number): Label => ({ id: name, name, versionId: 'v', createdAt, user: null })

describe('fileAuthors', () => {
  // newest first, as the version list is
  const versions = [
    version('v4', 400, ['carol'], [{ path: 'other.tex', op: 'modified' }]),
    version('v3', 300, ['bob'], [{ path: 'b.tex', op: 'renamed', oldPath: 'a.tex' }]),
    version('v2', 200, ['alice', 'bob'], [{ path: 'a.tex', op: 'modified' }]),
    version('v1', 100, ['dave'], [{ path: 'a.tex', op: 'added' }]),
  ]

  it('lists the people of the versions that touched the file, newest first, following renames', () => {
    expect(fileAuthors(versions, 'b.tex').map(a => [a.user.id, a.at])).toEqual([['bob', 300], ['alice', 200], ['dave', 100]])
  })

  it('ignores versions that did not touch the file', () => {
    expect(fileAuthors(versions, 'other.tex').map(a => a.user.id)).toEqual(['carol'])
    expect(fileAuthors(versions, 'missing.tex')).toEqual([])
  })

  it('one version with one author: exactly that person', () => {
    expect(fileAuthors([versions[0]], 'other.tex')).toEqual([{ user: user('carol'), at: 400 }])
  })
})

describe('versionZipName', () => {
  const at = new Date(2026, 8, 22, 9, 5).getTime()

  it('names an unlabelled version by its local date and time, never the commit hash', () => {
    expect(versionZipName('AntiDDoS Shield v2', { createdAt: at, labels: [] })).toBe('AntiDDoS Shield v2 - 2026-09-22 09.05.zip')
  })

  it('names a labelled version by its newest label', () => {
    expect(versionZipName('AntiDDoS Shield v2', { createdAt: at, labels: [label('draft', 1), label('submitted v2', 2)] })).toBe('AntiDDoS Shield v2 - submitted v2.zip')
  })

  it('keeps names safe for file systems', () => {
    expect(versionZipName('a/b: c', { createdAt: at, labels: [label('v1/final?', 1)] })).toBe('a b c - v1 final.zip')
    expect(versionZipName('', { createdAt: at, labels: [] })).toBe('project - 2026-09-22 09.05.zip')
    expect(versionZipName('Résumé ü', { createdAt: at, labels: [label('チャプター', 1)] })).toBe('Résumé ü - チャプター.zip')
  })
})
