/**
 * A small BibTeX stream mode (our own): entry types, citation keys, field names, braced and
 * quoted values (also across lines), numbers, string concatenation, and the free text
 * between entries (which BibTeX ignores) as comments.
 */
import { StreamLanguage, type StreamParser, type StringStream } from '@codemirror/language'
import { tags as t, type Tag } from '@lezer/highlight'

interface BibState {
  /** inside @type{ … } */
  inEntry: boolean
  /** saw @type, waiting for the opening delimiter */
  pendingOpen: boolean
  /** the closing delimiter of the current entry */
  close: '}' | ')'
  /** @comment / @preamble / @string bodies are not key/field structured */
  special: 'comment' | 'string' | 'preamble' | null
  expect: 'key' | 'afterKey' | 'field' | 'equals' | 'value' | 'afterValue'
  /** open braces of a braced value (0 = not in a value) */
  braces: number
  /** inside a "quoted" value */
  quoted: boolean
}

function readValueBody(stream: StringStream, st: BibState): void {
  while (!stream.eol()) {
    const ch = stream.next()
    if (ch === '\\') {
      stream.next()
      continue
    }
    if (ch === '{') st.braces++
    else if (ch === '}') {
      st.braces--
      if (st.braces === 0 && !st.quoted) return
    } else if (ch === '"' && st.quoted && st.braces === 0) {
      st.quoted = false
      return
    }
  }
}

const bibtexParser: StreamParser<BibState> = {
  name: 'bibtex',
  startState() {
    return { inEntry: false, pendingOpen: false, close: '}', special: null, expect: 'key', braces: 0, quoted: false }
  },
  copyState(s) {
    return { ...s }
  },
  token(stream, st) {
    // continuation of a multi-line value
    if (st.inEntry && (st.braces > 0 || st.quoted)) {
      readValueBody(stream, st)
      const style = st.special === 'comment' ? 'comment' : 'string'
      if (st.braces === 0 && !st.quoted) {
        if (st.special === 'comment' || st.special === 'preamble') {
          // the brace that closed the body was the entry's own
          st.inEntry = false
          st.special = null
        } else st.expect = 'afterValue'
      }
      return style
    }
    if (stream.eatSpace()) return null
    if (!st.inEntry) {
      if (st.pendingOpen) {
        const ch = stream.peek()
        if (ch === '{' || ch === '(') {
          stream.next()
          st.pendingOpen = false
          st.inEntry = true
          st.close = ch === '{' ? '}' : ')'
          st.expect = st.special === 'string' ? 'field' : st.special ? 'value' : 'key'
          if ((st.special === 'comment' || st.special === 'preamble') && ch === '{') st.braces = 1
          return 'bracket'
        }
        st.pendingOpen = false
      }
      const m = stream.match(/^@\s*([A-Za-z]+)/) as RegExpMatchArray | null
      if (m) {
        const type = m[1].toLowerCase()
        st.special = type === 'comment' || type === 'string' || type === 'preamble' ? type : null
        st.pendingOpen = true
        return 'entryType'
      }
      // free text between entries (BibTeX ignores it); a stray '@' is consumed as text
      if (stream.peek() === '@') stream.next()
      if (!stream.skipTo('@')) stream.skipToEnd()
      return 'comment'
    }
    // inside an entry
    const ch = stream.peek()
    if (ch === st.close && st.braces === 0) {
      stream.next()
      st.inEntry = false
      st.special = null
      return 'bracket'
    }
    if (ch === '%' && st.expect !== 'value') {
      stream.skipToEnd()
      return 'comment'
    }
    if (ch === ',') {
      stream.next()
      st.expect = 'field'
      return 'punctuation'
    }
    if (ch === '=') {
      stream.next()
      st.expect = 'value'
      return 'operator'
    }
    if (ch === '#') {
      stream.next()
      st.expect = 'value'
      return 'operator'
    }
    if (st.expect === 'key' && stream.match(/^[^,\s{}()"=#%]+/)) {
      st.expect = 'afterKey'
      return 'citeKey'
    }
    if (st.expect === 'value' || st.expect === 'afterValue') {
      if (ch === '{') {
        stream.next()
        st.braces = 1
        readValueBody(stream, st)
        if (st.braces === 0) st.expect = 'afterValue'
        return 'string'
      }
      if (ch === '"') {
        stream.next()
        st.quoted = true
        readValueBody(stream, st)
        if (!st.quoted) st.expect = 'afterValue'
        return 'string'
      }
      if (stream.match(/^\d+/)) {
        st.expect = 'afterValue'
        return 'number'
      }
      if (stream.match(/^[A-Za-z][\w\-:.]*/)) {
        st.expect = 'afterValue'
        return 'stringMacro'
      }
    }
    if (stream.match(/^[A-Za-z][\w\-:.]*/)) {
      st.expect = 'equals'
      return 'fieldName'
    }
    stream.next()
    return null
  },
  languageData: {
    commentTokens: { line: '%' },
    closeBrackets: { brackets: ['{', '"', '('] },
  },
  tokenTable: {
    entryType: t.keyword,
    citeKey: t.labelName,
    fieldName: t.propertyName,
    stringMacro: t.variableName,
    punctuation: t.separator,
  } satisfies Record<string, Tag>,
}

export const bibtexLanguage = StreamLanguage.define(bibtexParser)
