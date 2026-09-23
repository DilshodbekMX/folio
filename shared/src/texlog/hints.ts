/**
 * Friendly explanations for common log messages (Folio's own wording).
 * Rules are tried in order; the first whose `match` (and `kinds`, when given) fits wins.
 */
import type { LogEntry } from '../api.ts'

export interface LogHintRule {
  id: string
  match: RegExp
  /** restrict the rule to these entry kinds */
  kinds?: string[]
  hint: string
}

export const LOG_HINTS: LogHintRule[] = [
  {
    id: 'no-end-document',
    match: /no legal \\end found/,
    hint: 'The document ended without \\end{document}. Add it at the end of the main file.',
  },
  {
    id: 'emergency-stop',
    match: /^Emergency stop\b/,
    kinds: ['emergency-stop'],
    hint: 'TeX gave up after an earlier problem. Fix the first error listed above; this one usually disappears with it.',
  },
  {
    id: 'undefined-control-sequence',
    match: /^Undefined control sequence/,
    hint: 'A command is not defined. Check it for typos, or load the package that provides it with \\usepackage in the preamble.',
  },
  {
    id: 'missing-dollar',
    match: /^Missing \$ inserted/,
    hint: 'A math-only command or character (such as _ or ^) appeared outside math mode, or a math formula was not closed. Wrap the formula in $...$, or escape a literal underscore as \\_.',
  },
  {
    id: 'missing-file',
    match: /File [`'][^']*' not found|I can't find file|I couldn't open (?:database|style|auxiliary) file/,
    hint: 'A file could not be found. Check the spelling and the path (relative to the main document), the file\'s extension, and that the file is part of the project. For packages, check the package name.',
  },
  {
    id: 'unicode-not-set-up',
    match: /Unicode character .* not set up for use with LaTeX/,
    hint: 'pdfLaTeX cannot typeset this character with the current fonts. Switch the compiler to XeLaTeX or LuaLaTeX in the project settings, replace the character, or define it with \\DeclareUnicodeCharacter.',
  },
  {
    id: 'missing-character',
    match: /Missing character: There is no/,
    hint: 'The current font has no glyph for this character, so it is missing from the PDF. Select a font that contains it (e.g. with fontspec) or replace the character.',
  },
  {
    id: 'undefined-reference',
    match: /(?:Reference|Hyper reference) [`'][^']*' on page \S+ undefined|There were undefined references/,
    hint: 'A \\ref points to a label that does not exist. Check the label name; if the label is in another document (xr), make sure that document is compiled too. Recompile once if you just added the label.',
  },
  {
    id: 'undefined-citation',
    match: /Citation [`'][^']*' on page \S+ undefined|There were undefined citations|I didn't find a database entry/,
    hint: 'A \\cite key has no matching bibliography entry. Check the key in your .bib file or \\bibitem list, and that the bibliography is included.',
  },
  {
    id: 'xr-no-file',
    match: /LABELS NOT IMPORTED|No file \S+\.aux/,
    kinds: ['xr-no-file'],
    hint: 'The .aux file of an external document (\\externaldocument) does not exist yet, so its labels were not imported and its references show ??. Folio builds the documents named in \\externaldocument before the main one; if this persists, check the name and path, or list the document under Settings → Compiler → External documents.',
  },
  {
    id: 'multiply-defined-xr',
    match: /multiply defined/,
    kinds: ['multiply-defined-xr'],
    hint: 'This duplicate is imported from another document through \\externaldocument (xr): both documents define the same key. It is harmless unless the two definitions differ.',
  },
  {
    id: 'multiply-defined',
    match: /multiply[ -]defined/,
    hint: 'The same label or citation key is defined more than once. Rename one of them so every \\label / \\bibitem key is unique.',
  },
  {
    id: 'rerun',
    match: /Rerun to get|Please \(re\)run|Please rerun|may have changed|Rerun LaTeX/,
    hint: 'Cross-references were not stable yet. Recompiling once more usually fixes this.',
  },
  {
    id: 'font-shape',
    match: /Font shape .* undefined|Some font shapes were not available/,
    hint: 'The requested font variant (e.g. bold small caps) does not exist in the current font, so a substitute was used.',
  },
  {
    id: 'headheight',
    match: /\\headheight is too small/,
    hint: 'The page header is taller than the space reserved for it. Add the \\setlength{\\headheight}{...} value suggested in the message to your preamble.',
  },
  {
    id: 'pdf-string-token',
    match: /Token not allowed in a PDF string/,
    hint: 'Math or commands inside a section title cannot be used in PDF bookmarks. Use \\texorpdfstring{<LaTeX version>}{<plain text version>} in the title.',
  },
  {
    id: 'float-only-page',
    match: /Text page \S+ contains only floats/,
    hint: 'Floats (figures/tables) filled a whole page. Consider adjusting float placement options such as [htbp] or \\FloatBarrier.',
  },
  {
    id: 'float-specifier',
    match: /`[!h]+' float specifier changed to/,
    hint: 'LaTeX could not place the float exactly "here". Use [htbp] to give it more placement options.',
  },
  {
    id: 'overfull-hbox',
    match: /^Overfull \\hbox/,
    hint: 'A line sticks out into the margin. Rephrase the text, allow hyphenation of long words (e.g. \\- or \\hyphenation), or use \\sloppy locally. For tables and images, reduce their width.',
  },
  {
    id: 'underfull-hbox',
    match: /^Underfull \\hbox/,
    hint: 'A line had to be stretched more than TeX likes, leaving large gaps between words. Usually harmless; often caused by \\\\ or \\newline at the end of a paragraph or by narrow columns.',
  },
  {
    id: 'overfull-vbox',
    match: /^Overfull \\vbox/,
    hint: 'Material is too tall for the page or box it is in. Reduce the size of the figure/table or allow a page break.',
  },
  {
    id: 'underfull-vbox',
    match: /^Underfull \\vbox/,
    hint: 'A page or box had to be stretched vertically. Usually harmless.',
  },
  {
    id: 'invalid-utf8',
    match: /^Invalid UTF-8 byte or sequence/,
    hint: 'XeTeX read bytes that are not valid UTF-8. When this is reported at \\begin{document}, it usually comes from reading a binary file such as an EPS image and can be ignored; otherwise check the file encoding.',
  },
  {
    id: 'runaway-argument',
    match: /Paragraph ended before .* was complete|File ended while scanning use of/,
    hint: 'A closing brace } is probably missing, so a command\'s argument ran into a blank line or the end of the file.',
  },
  {
    id: 'too-many-braces',
    match: /^Too many }'s/,
    hint: 'There is a closing brace } without a matching opening brace {.',
  },
  {
    id: 'environment-mismatch',
    match: /\\begin\{[^}]*\} on input line \d+ ended by \\end\{/,
    hint: 'An environment is closed with the wrong \\end{...}. Check that every \\begin{x} has a matching \\end{x}, in the right order.',
  },
  {
    id: 'misplaced-alignment',
    match: /^Misplaced alignment tab character &/,
    hint: 'An & was used outside a table or alignment. Escape a literal ampersand as \\&.',
  },
  {
    id: 'log-truncated',
    match: /log ended unexpectedly/,
    hint: 'The TeX engine stopped before finishing (it may have been stopped, timed out or crashed). Check the other errors, then recompile.',
  },
  {
    id: 'bib-repeated-entry',
    match: /^Repeated entry|^Duplicate entry key/,
    hint: 'The same key appears twice in the bibliography database; only the first entry is used. Remove or rename the duplicate.',
  },
  {
    id: 'bib-syntax',
    match: /^I was expecting a|syntax error/,
    hint: 'The .bib entry is malformed — often a missing comma after the key or between fields, or an unbalanced brace. The real mistake may be on the line before.',
  },
  {
    id: 'bib-empty-field',
    match: /^empty \w+ in \S+$|^to sort, need/,
    hint: 'The bibliography style expects this field for the entry type. Add the field to the .bib entry.',
  },
]

export function hintFor(entry: Pick<LogEntry, 'message' | 'kind'>): string | undefined {
  for (const rule of LOG_HINTS) {
    if (rule.kinds && !(entry.kind && rule.kinds.includes(entry.kind))) continue
    if (rule.match.test(entry.message)) return rule.hint
  }
  return undefined
}
