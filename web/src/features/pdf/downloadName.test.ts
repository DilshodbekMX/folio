/**
 * Download names of PDFs (J-2): the main document's PDF is "<project>.pdf", any other root
 * document's (the xr supplement, a standalone figure) "<project> - <jobname>.pdf", so the
 * supplement is never saved under the paper's name.
 */
import { describe, expect, it } from 'vitest'
import { buildJobname, isOtherRoot, pdfDownloadName } from './downloadName'

const MAIN = 'antiddos_v2.tex'

describe('pdfDownloadName', () => {
  it('names the main document after the project', () => {
    expect(pdfDownloadName('AntiDDoS Shield v2', { rootPath: MAIN, jobname: 'antiddos_v2' }, MAIN)).toBe('AntiDDoS Shield v2.pdf')
  })

  it('adds the jobname for another root document', () => {
    const supp = { rootPath: 'antiddos_v2_supplementary.tex', jobname: 'antiddos_v2_supplementary' }
    expect(isOtherRoot(supp, MAIN)).toBe(true)
    expect(pdfDownloadName('AntiDDoS Shield v2', supp, MAIN)).toBe('AntiDDoS Shield v2 - antiddos_v2_supplementary.pdf')
  })

  it('derives the jobname from the root path when the build does not name it', () => {
    const fig = { rootPath: 'figures/Fig 1.TEX', jobname: null }
    expect(buildJobname(fig)).toBe('Fig 1')
    expect(pdfDownloadName('Paper', fig, MAIN)).toBe('Paper - Fig 1.pdf')
  })

  it('falls back to the project name when the main document or the build is unknown', () => {
    const supp = { rootPath: 'supp.tex', jobname: 'supp' }
    expect(isOtherRoot(supp, null)).toBe(false)
    expect(pdfDownloadName('Paper', supp, null)).toBe('Paper.pdf')
    expect(pdfDownloadName('Paper', null, MAIN)).toBe('Paper.pdf')
  })

  it('keeps Unicode and removes characters no file system accepts', () => {
    expect(pdfDownloadName('Thèse / final: v2', { rootPath: 'a:b.tex', jobname: 'a:b' }, MAIN)).toBe('Thèse final v2 - a b.pdf')
    expect(pdfDownloadName('   ', { rootPath: MAIN, jobname: 'antiddos_v2' }, MAIN)).toBe('project.pdf')
  })
})
