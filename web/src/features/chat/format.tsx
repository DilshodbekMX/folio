/**
 * Markdown-lite for chat messages (SPEC §6.8): http(s)/www links, `inline code` and ```code
 * blocks```. Produces React nodes (never HTML strings), so message text cannot inject markup.
 */
import type { ReactNode } from 'react'

const FENCE_RE = /```(?:[\w+-]*\n)?([\s\S]*?)```/g
const CODE_RE = /`([^`\n]+)`/g
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"'`]+/gi
const TRAILING_PUNCT = '.,;:!?\'"’”]}>*_'

/** Split a URL match from trailing punctuation that most likely belongs to the sentence. */
function trimUrl(raw: string): { url: string; rest: string } {
  let url = raw
  while (url.length > 0) {
    const ch = url[url.length - 1]
    const unbalancedParen = ch === ')' && (url.split('(').length - 1) < (url.split(')').length - 1)
    if (!TRAILING_PUNCT.includes(ch) && !unbalancedParen) break
    url = url.slice(0, -1)
  }
  return { url, rest: raw.slice(url.length) }
}

function linkify(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  URL_RE.lastIndex = 0
  for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
    const { url, rest } = trimUrl(m[0])
    if (!url || url.length < 5) continue
    if (m.index > last) out.push(text.slice(last, m.index))
    const href = /^www\./i.test(url) ? `https://${url}` : url
    out.push(
      <a key={`${keyPrefix}l${i++}`} href={href} target="_blank" rel="noopener noreferrer" className="chat-link">
        {url}
      </a>,
    )
    if (rest) out.push(rest)
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  CODE_RE.lastIndex = 0
  for (let m = CODE_RE.exec(text); m; m = CODE_RE.exec(text)) {
    if (m.index > last) out.push(...linkify(text.slice(last, m.index), `${keyPrefix}t${i}`))
    out.push(
      <code key={`${keyPrefix}c${i}`} className="chat-code">
        {m[1]}
      </code>,
    )
    i++
    last = m.index + m[0].length
  }
  if (last < text.length) out.push(...linkify(text.slice(last), `${keyPrefix}t${i}`))
  return out
}

/** Render a chat message's content. */
export function renderChatContent(content: string): ReactNode[] {
  const out: ReactNode[] = []
  let last = 0
  let i = 0
  FENCE_RE.lastIndex = 0
  for (let m = FENCE_RE.exec(content); m; m = FENCE_RE.exec(content)) {
    if (m.index > last) out.push(...inline(content.slice(last, m.index).replace(/\n$/, ''), `b${i}`))
    out.push(
      <pre key={`f${i}`} className="chat-pre">
        <code>{m[1].replace(/\n$/, '')}</code>
      </pre>,
    )
    i++
    last = m.index + m[0].length
    if (content[last] === '\n') last++
  }
  if (last < content.length) out.push(...inline(content.slice(last), `b${i}`))
  return out
}
