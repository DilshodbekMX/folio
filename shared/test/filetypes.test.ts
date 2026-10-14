/** Text vs binary classification: the size limit is the editor's (UTF-16 code units), not bytes. */
import { describe, expect, it } from 'vitest'
import {
  classifyByName, classifyFile, declaredEncoding, declareUtf8, decodeIncomingText, decodeUtf8Text, MAX_TEXT_FILE_BYTES,
  MAX_TEXT_LENGTH, textLengthFits,
} from '../src/filetypes.ts'
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

/** Single-byte encodings for the tests: Latin-1 characters as themselves, plus a few extras. */
const bytesOf = (s: string, extra: Record<string, number> = {}) =>
  Uint8Array.from([...s].map(c => extra[c] ?? c.charCodeAt(0)))
const cp1252 = (s: string) => bytesOf(s, { '“': 0x93, '”': 0x94, '–': 0x96 })
// Windows-1251 puts А–я at 0xC0–0xFF
const cp1251 = (s: string) => Uint8Array.from([...s].map(c => {
  const u = c.charCodeAt(0)
  return u >= 0x410 && u <= 0x44f ? u - 0x410 + 0xc0 : u
}))

describe('decodeIncomingText', () => {
  it('passes UTF-8 through, normalised', () => {
    expect(decodeIncomingText('a.tex', enc.encode('\uFEFFcafé\r\n'))).toEqual({ text: 'café\n', encoding: 'utf-8' })
  })

  it('converts Windows text (curly quotes, accents) instead of making it read-only', () => {
    // a journal template edited on Windows: one pair of quotes in a comment
    const tex = cp1252('%% To switch between “Numbered” styles\r\n\\documentclass{sn-jnl}\r\n')
    expect(classifyFile('sn-article.tex', tex)).toBe('binary')
    expect(decodeIncomingText('sn-article.tex', tex)).toEqual({
      text: '%% To switch between “Numbered” styles\n\\documentclass{sn-jnl}\n', encoding: 'windows-1252',
    })
    expect(decodeIncomingText('sn-mathphys-num.bst', cp1252('select the “alpha” option'))?.text).toBe('select the “alpha” option')
    expect(decodeIncomingText('refs.bib', cp1252('author = {Müller and Gödel}'))?.text).toBe('author = {Müller and Gödel}')
    // German runs of two accented letters are still Western
    expect(decodeIncomingText('de.tex', cp1252('Größe – Füße'))).toEqual({ text: 'Größe – Füße', encoding: 'windows-1252' })
  })

  it('recognises Cyrillic Windows text', () => {
    expect(decodeIncomingText('ru.tex', cp1251('Привет, мир! Это пример текста в кодировке.'))).toEqual({
      text: 'Привет, мир! Это пример текста в кодировке.', encoding: 'windows-1251',
    })
  })

  it('reads UTF-16 with a byte-order mark (Notepad "Unicode")', () => {
    const le = Uint8Array.from([0xff, 0xfe, ...[...'Hé\r\n'].flatMap(c => [c.charCodeAt(0), 0])])
    expect(decodeIncomingText('notes.txt', le)).toEqual({ text: 'Hé\n', encoding: 'utf-16le' })
    const be = Uint8Array.from([0xfe, 0xff, ...[...'Hé'].flatMap(c => [0, c.charCodeAt(0)])])
    expect(decodeIncomingText('notes.txt', be)).toEqual({ text: 'Hé', encoding: 'utf-16be' })
  })

  it('follows the encoding the file or the project declares', () => {
    // 0xB1 is ą in Latin-2 but ± in Windows-1252
    const pl = bytesOf('\\usepackage[latin2]{inputenc}\nZa\xb1\n')
    expect(decodeIncomingText('pl.tex', pl)).toEqual({ text: '\\usepackage[latin2]{inputenc}\nZaą\n', encoding: 'iso-8859-2' })
    expect(decodeIncomingText('chapter.tex', bytesOf('Za\xb1'), 'iso-8859-2')?.text).toBe('Zaą')
    // the file's own declaration wins over the project's; a commented-out one does not count
    expect(decodeIncomingText('x.tex', bytesOf('% !TEX encoding = ISO-8859-2\nZa\xb1'), 'windows-1251')?.encoding).toBe('iso-8859-2')
    expect(decodeIncomingText('x.tex', bytesOf('%\\usepackage[latin2]{inputenc}\nZa\xb1'))?.encoding).toBe('windows-1252')
    // a UTF-8 declaration is wrong for bytes that are not UTF-8: guessed instead
    expect(decodeIncomingText('x.tex', cp1252('\\usepackage[utf8]{inputenc}\ncafé'))?.text).toContain('café')
  })

  it('keeps what it cannot read safely as binary', () => {
    // an encoding Folio cannot decode, declared by the file or by the project
    expect(decodeIncomingText('dos.tex', bytesOf('\\usepackage[cp850]{inputenc}\n\x82'))).toBeNull()
    expect(decodeIncomingText('dos.tex', bytesOf('\x82'), '')).toBeNull()
    // only text-by-extension files are converted; NUL bytes mean binary
    expect(decodeIncomingText('data/notes', cp1252('café'))).toBeNull()
    // formats that name their own encoding would be contradicted by a conversion
    expect(decodeIncomingText('page.html', cp1252('<meta charset="windows-1252">café'))).toBeNull()
    expect(decodeIncomingText('script.py', cp1252('# -*- coding: latin-1 -*-\ncafé'))).toBeNull()
    expect(decodeIncomingText('logo.png', enc.encode('text'))).toBeNull()
    expect(decodeIncomingText('a.tex', Uint8Array.from([0xe9, 0x00, 0x61]))).toBeNull()
    expect(decodeIncomingText('a.tex', new Uint8Array(MAX_TEXT_FILE_BYTES + 1).fill(0xe9))).toBeNull()
  })
})

describe('encoding declarations', () => {
  it('finds the declared encoding', () => {
    expect(declaredEncoding('\\documentclass{article}\n\\usepackage[latin1]{inputenc}\n')).toBe('windows-1252')
    expect(declaredEncoding('\\usepackage[T1]{fontenc}\n\\usepackage[utf8]{inputenc}')).toBe('utf-8')
    expect(declaredEncoding('\\usepackage[cp1251]{inputenc}')).toBe('windows-1251')
    expect(declaredEncoding('\\RequirePackage[ansinew]{inputenc}')).toBe('windows-1252')
    expect(declaredEncoding('\\usepackage[latin9]{inputenc}')).toBe('iso-8859-15')
    expect(declaredEncoding('\\inputencoding{koi8-r}')).toBe('koi8-r')
    expect(declaredEncoding('% !TEX encoding = UTF-8 Unicode\n\\usepackage[latin1]{inputenc}')).toBe('utf-8')
    expect(declaredEncoding('\\usepackage[cp850]{inputenc}')).toBe('')
    expect(declaredEncoding('%\\usepackage[latin1]{inputenc}\n\\usepackage{amsmath}')).toBeNull()
    expect(declaredEncoding('50\\% \\usepackage[latin1]{inputenc}')).toBe('windows-1252')
  })

  it('switches legacy declarations to UTF-8 and leaves the rest alone', () => {
    expect(declareUtf8('\\usepackage[latin1]{inputenc}')).toBe('\\usepackage[utf8]{inputenc}')
    expect(declareUtf8('\\RequirePackage[cp1251]{inputenc} % Russian')).toBe('\\RequirePackage[utf8]{inputenc} % Russian')
    expect(declareUtf8('\\inputencoding{latin1}')).toBe('\\inputencoding{utf8}')
    expect(declareUtf8('\\usepackage[backend=biber,bibencoding=latin1]{biblatex}')).toBe('\\usepackage[backend=biber,bibencoding=utf8]{biblatex}')
    expect(declareUtf8('% !TEX encoding = ISO-8859-1\nx')).toBe('% !TEX encoding = UTF-8\nx')
    for (const keep of [
      '\\usepackage[utf8]{inputenc}', '\\usepackage[T1]{fontenc}', '%\\usepackage[latin1]{inputenc}',
      '% \\usepackage[latin1]{inputenc} was here', '% !TEX encoding = UTF-8', 'bibencoding=auto',
    ]) expect(declareUtf8(keep), keep).toBe(keep)
  })
})
