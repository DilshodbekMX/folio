import { describe, expect, it } from 'vitest'
import { MAX_SEGMENT_LENGTH, basename, siblingCopyPath, validatePath } from '../src/paths.ts'

describe('siblingCopyPath', () => {
  const none = () => false

  it('puts the copy next to the file, before the extension', () => {
    expect(siblingCopyPath('b.tex', none)).toBe('b (recovered).tex')
    expect(siblingCopyPath('chapters/intro.tex', none)).toBe('chapters/intro (recovered).tex')
    expect(siblingCopyPath('refs.v2.bib', none)).toBe('refs.v2 (recovered).bib')
    expect(siblingCopyPath('Makefile', none)).toBe('Makefile (recovered)')
    expect(siblingCopyPath('.latexmkrc', none)).toBe('.latexmkrc (recovered)')
    expect(siblingCopyPath('b.tex', none, 'copy')).toBe('b (copy).tex')
  })

  it('numbers the copies when the name is taken', () => {
    const taken = new Set(['dir/b (recovered).tex', 'dir/b (recovered 2).tex'])
    expect(siblingCopyPath('dir/b.tex', p => taken.has(p))).toBe('dir/b (recovered 3).tex')
  })

  it('stays a valid path for very long names', () => {
    const long = 'x'.repeat(MAX_SEGMENT_LENGTH - 4) + '.tex'
    const p = siblingCopyPath(`a/${long}`, none)
    expect(validatePath(p)).toBeNull()
    expect(basename(p).length).toBeLessThanOrEqual(MAX_SEGMENT_LENGTH)
    expect(p.endsWith(' (recovered).tex')).toBe(true)
  })
})
