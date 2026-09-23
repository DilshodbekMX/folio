/** Text vs binary classification: the size limit is the editor's (UTF-16 code units), not bytes. */
import { describe, expect, it } from 'vitest'
import { classifyByName, classifyFile, decodeUtf8Text, MAX_TEXT_FILE_BYTES, MAX_TEXT_LENGTH, textLengthFits } from '../src/filetypes.ts'
import { MAX_DOC_LENGTH } from '../src/protocol.ts'

const enc = new TextEncoder()

describe('classifyFile', () => {
  it('uses the collaborative document limit, counted in characters', () => {
    expect(MAX_TEXT_LENGTH).toBe(MAX_DOC_LENGTH)
    // 1.2 M Greek characters = 2.4 MB of UTF-8: editable, so it stays text
    const greek = enc.encode('α'.repeat(1_200_000))
    expect(greek.byteLength).toBeGreaterThan(2 * 1024 * 1024)
    expect(classifyFile('gr.tex', greek)).toBe('text')
    // CJK: 3 bytes per character
    expect(classifyFile('zh.tex', enc.encode('漢'.repeat(MAX_DOC_LENGTH)))).toBe('text')
    // one character over the limit is binary, whatever the script
    expect(classifyFile('zh.tex', enc.encode('漢'.repeat(MAX_DOC_LENGTH + 1)))).toBe('binary')
    expect(classifyFile('a.tex', enc.encode('a'.repeat(MAX_DOC_LENGTH + 1)))).toBe('binary')
    expect(classifyFile('a.tex', enc.encode('a'.repeat(MAX_DOC_LENGTH)))).toBe('text')
    // CRLF is normalised before counting (the editor never sees the CRs)
    expect(classifyFile('a.tex', enc.encode('a\r\n'.repeat(MAX_DOC_LENGTH / 2)))).toBe('text')
    // beyond 3 bytes per code unit nothing can be text
    expect(classifyFile('a.tex', new Uint8Array(MAX_TEXT_FILE_BYTES + 1).fill(97))).toBe('binary')
  })

  it('keeps the other rules', () => {
    expect(classifyFile('a.png', enc.encode('hello'))).toBe('binary')
    expect(classifyFile('a.tex', Uint8Array.from([0x61, 0x00, 0x62]))).toBe('binary')
    expect(classifyFile('latin1.tex', Uint8Array.from([0x63, 0x61, 0x66, 0xe9]))).toBe('binary')
    expect(classifyFile('notes', enc.encode('plain words'))).toBe('text')
    expect(classifyByName('refs.bib')).toBe('text')
  })

  it('helpers', () => {
    expect(decodeUtf8Text(enc.encode('ok é'))).toBe('ok é')
    expect(decodeUtf8Text(Uint8Array.from([0xff]))).toBeNull()
    expect(textLengthFits('x'.repeat(MAX_TEXT_LENGTH))).toBe(true)
    expect(textLengthFits('x'.repeat(MAX_TEXT_LENGTH + 1))).toBe(false)
  })
})
