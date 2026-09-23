# AREA: LaTeX compile log parsing (errors / warnings / badboxes linked to file and line), plus BibTeX/Biber .blg and latexmk output

Write our own parser as a small TypeScript module with no runtime dependencies. There is no maintained npm package for this: `latex-log-parser`, `@overleaf/latex-log-parser` and `texlogparser` all return 404. I checked the design against three things: Overleaf's `latex-log-parser.ts`, which I read to learn the approach only (AGPL, not copied); LaTeX-Workshop's `latexlog.ts`, `bibtexlog.ts` and `biberlog.ts` (MIT); and about 25 real logs I generated with the local `texlive/texlive:latest` image (TeX Live 2026: pdfTeX 1.40.29, XeTeX 0.999998, LuaHBTeX 1.24.0, latexmk 4.88, biber 2.22, BibTeX 0.99e). I also wrote a prototype and ran it against the user's two real logs. The prototype is in the scratchpad: `proto/texlog.ts` and `proto/biblog.ts`. It maps every real-log entry to the right file and line and keeps the file stack balanced.

The biggest simplification is on the compile side. Set the environment variables `max_print_line=10000`, `error_line=254` and `half_error_line=238` on the TeX process. With these, pdflatex, xelatex and lualatex write unwrapped logs; I verified this. The `-max-print-line` command-line flag is rejected by all three engines in TeX Live 2026 ("unrecognized option"). Unwrapping still has to exist for older or foreign logs, such as the user's current logs, which wrap at 79. The wrap rule depends on the engine:
- **pdfTeX** wraps at 79 bytes and can split a UTF-8 character across lines, so it must be unwrapped at byte level before decoding.
- **XeTeX** wraps at 79 Unicode code points. Lines containing 'ë' or 'ü' are 80 bytes, and an emoji line is 80 UTF-16 units, so JavaScript's `.length` gives the wrong answer.
- **LuaTeX** wraps at 79 or 80 bytes, and wraps early rather than split a multi-byte character.

Blind 79-character joining also produces false joins: each real log has 3 (for example `…microtype-xetex.def` + `File: …`). A small set of "a new message starts here" exclusions fixes them.

The core algorithm is a single pass over logical lines. Each line is checked in priority order:
1. Fatal banner (ignore).
2. TeX error (`! `) or file-line-error (`./f.tex:12: `).
3. `Runaway …?`
4. Badbox header.
5. Warning header (Package, Class, Module, LaTeX, LaTeX Font, pdfTeX).
6. `Missing character`.
7. XeTeX `Invalid UTF-8`.
8. Otherwise, scan the line's parentheses to maintain a file stack.

Each message handler consumes its whole block, so any parentheses inside it never reach the file-stack scanner. A block is: the error's context and help text; the warning's `(pkg)` or indented continuation lines; the badbox's box-content lines up to the next blank line. This matters in practice: `antiddos_v2.log` has two badbox content blocks with an unbalanced '(' (log lines 1772 and 1964). Overleaf's approach scans those parentheses, and LaTeX-Workshop only skips one content line.

At each '(', the path is resolved in this order:
1. Longest-prefix match against the project's known file list. This handles spaces and parentheses in names, e.g. `./figs (old)/part.tex`.
2. A quoted path. LuaTeX prints `("./my dir/file name.tex"`.
3. A lazy match that ends at the first extension.
4. A plain fallback.

A ')' pops the top frame, but the root frame is never popped.

Expected results for the user's logs (XeTeX, not file-line-error mode):
- **`antiddos_v2.log`:** 0 errors, 80 warnings, 29 badboxes. All badboxes are `Underfull \hbox` in `./antiddos_v2.tex`. The 80 warnings drop to 74 if the six XeTeX 'Invalid UTF-8' messages are treated as info.
- **`antiddos_v2_supplementary.log`:** 0 errors, 35 warnings, 18 badboxes (12 underfull, 6 overfull, all in `./antiddos_v2_supplementary.tex`).
- **Both logs:** no undefined references or citations, no rerun requests, no missing characters and no 'Font shape undefined' warnings.

Separate parsers are needed for BibTeX and Biber `.blg` files. With Biber 2.22 the temporary file is named by a hash (`/tmp/biber_tmp_xxxx/<md5>_1.utf8`), so Overleaf's filename-extraction regex fails on it. Track `Found BibTeX data source '…'` instead; the line numbers equal the original `.bib` lines (checked on line 22 of the fixture). Also parse latexmk's stdout for its summary and exit code, and for `xdvipdfmx:warning:` lines, which never reach the `.log`.

## [must] Compile side: turn off log wrapping with environment variables (the command-line flag does not work)
Run TeX with these environment variables: `docker run ... -e max_print_line=10000 -e error_line=254 -e half_error_line=238 texlive/texlive:latest latexmk ...`. kpathsea reads texmf.cnf variables from the environment, and latexmk passes the environment on to the engines. Verified in TeX Live 2026: pdflatex, xelatex and lualatex then wrote lines up to 311, 137 and 398 characters, and file-line-error lines such as `./a-very-long-.../deep.tex:2: Undefined control sequence.` stayed on one line. The flag `-max-print-line=500` fails on all three engines with `unrecognized option '-max-print-line=500'` (see LaTeX-Workshop issue #885 for the lualatex case). Give the parser an option `maxPrintLine` (default 79). Set it to Infinity for logs we produce, because an unwrapped log can still contain natural lines of exactly 79 characters, and those must not be joined. Auto-detect for uploaded or foreign logs: skip line 1 (the 'This is XeTeX…' banner, 118 characters) and the ' …stack positions out of …' memory line, which are always unwrapped. If 3 or more of the remaining lines are longer than 80 bytes, treat the log as unwrapped.
Sources: https://github.com/James-Yu/LaTeX-Workshop/issues/885, https://ctan.math.illinois.edu/macros/latex/contrib/hardwrap/hardwrap.pdf, local: docker texlive/texlive:latest (TL2026) runs in scratchpad fx/mpl-*

## [must] Unwrapping algorithm (engine-specific; measured on real logs)
1. Read the log as a Buffer and split on byte 0x0A, stripping a trailing 0x0D.
2. Detect the engine from line 1 with `/^This is (pdfTeX|XeTeX|LuaHBTeX|LuaTeX|e-u?pTeX|ε-pTeX|e-TeX|TeX)\b/`.
3. A physical line `prev` counts as wrapped, so the next physical line is appended to it, when all of these hold:
   - `prev` does not end with '...' (truncated error context).
   - The next line does not match NO_JOIN_NEXT (see the next finding).
   - The engine rule matches:
     - pdfTeX / e-TeX / pTeX: `prev.byteLength === 79`. pdfTeX counts bytes and splits UTF-8 characters: the fixture line ended with 0xC3 and the next line started with 0xA9. So join the byte arrays first, then decode with `new TextDecoder('utf-8')`.
     - XeTeX: the code-point count of the decoded line is 79. Use `[...s].length` or a for-of counter, never `s.length`. Real log line 2117 (`…Largouët, C. Netspot: `) is 80 bytes but 79 code points. The fixture line `Missing character: There is no 😀 (U+1F600) in font [lmroman10-regular]:mapping=` is 79 code points but 80 UTF-16 units.
     - LuaTeX: `byteLength === 79 || byteLength === 80`. Lua-side output (`luaotfload | …`, `Lua module: …`) and file-line-error lines wrap at 80 bytes, e.g. `./a-very-long-…/another-long-directory-n` + `ame-for-wrap-test/deep.tex:2: …`. LuaTeX also wraps early rather than split a multi-byte character (a 78-byte line was followed by a line starting with 'é'), so additionally accept `76 <= byteLength < 79 && next[0] >= 0xC0`.
4. Keep a map from each logical line to its first physical line, so every entry can report the log line number for a 'jump to raw log' view.
Sources: local: <paper directory>/antiddos_v2.log lines 2117, 2173, local fixtures scratchpad fx2/out-{pdflatex,xelatex,lualatex}/missingchar.log, https://raw.githubusercontent.com/overleaf/overleaf/main/services/web/frontend/js/ide/log-parser/latex-log-parser.ts

## [must] Stopping false joins after a line that is exactly 79 characters
After TeX prints the 79th character it emits a newline. A message that TeX then starts with print_nl() therefore begins on the next line with no blank line in between, which looks exactly like a wrap. Evidence from each real log, three false joins apiece: `(/home/detector/texlive/2026/texmf-dist/tex/latex/microtype/microtype-xetex.def` (79 characters) followed by `File: microtype-xetex.def 2026/03/01 …`; `…/translations/translations.sty` followed by `Package: translations …`; `…/koma-script/scrlfile-hook.sty` followed by `Package: scrlfile-hook …`. LuaTeX shows the same thing with a 79-byte `Missing character: …;!` line followed directly by the next `Missing character:` line. Do not join when the next line matches NO_JOIN_NEXT = `/^(?:! |l\.\d+ |Missing character: |File: |Package: |Document Class: |(?:LaTeX|LaTeX Font|LaTeX3|Package \S+|Class \S+|Module \S+) (?:Info|Warning|Error): |(?:Over|Under)full \\[hv]box |\*\*\* )/`. With this rule the prototype makes 0 false joins on both real logs (173 true joins in the main log), and the wrapped path `…/rerunfilecheck` + `.sty` (log lines 1331–1332) is still joined correctly. Joining an empty next line is harmless and semantically correct, because a line of exactly 79 characters followed by print_ln produces an artificial blank line. Overleaf's original rule only excludes lines that start with '!'.
Sources: local: antiddos_v2.log lines 381-382, 844-845, 957-958, local: fx2/out-lualatex/missingchar.log lines 92-101

## [must] Output data model (TypeScript)
`type Level = 'error'|'warning'|'typesetting'|'info'`
`interface LogEntry {`
- `level: Level`
- `kind: 'tex-error'|'latex-error'|'package-error'|'class-error'|'missing-file'|'undefined-cs'|'latex-warning'|'package-warning'|'class-warning'|'font-warning'|'pdftex-warning'|'undefined-reference'|'undefined-citation'|'multiply-defined'|'rerun'|'summary'|'overfull-hbox'|'underfull-hbox'|'overfull-vbox'|'underfull-vbox'|'tight-hbox'|'loose-hbox'|'missing-character'|'invalid-utf8'|'bibtex'|'biber'|'latexmk'`
- `message: string` (normalized, continuations joined with single spaces)
- `package?: string`
- `file: string|null` (raw path exactly as printed, innermost file frame)
- `projectPath?: string` (the innermost frame that is a project file, e.g. 'sections/intro.tex'; used for the editor jump)
- `line: number|null`
- `endLine?: number` (badbox 'lines a--b')
- `page?: number`
- `logLine: number` (1-based physical line in the .log)
- `raw: string` (the whole consumed block)
- `context?: {before: string, after: string}` (from `l.N`)
- `help?: string`
- `secondary?: boolean` ('Emergency stop' after another error)
- `fromSystemFile?: boolean`
- `groupKey?: string`, `count?: number` (collapsed duplicates)

`}`

Top-level result: `{ engine, entries, errors, warnings, typesetting, filesTree, pages: number|null /* from 'Output written on X (N pages' */ }`. Keep `line` only when the innermost frame is the file the line belongs to. A line from 'on input line N' refers to `\inputlineno` of the innermost file, which may be a system .sty.

## [must] Main state machine (pseudo-code in check order)
```
for each logical line L (index i):
  if FATAL.test(L): skip   // /^(?:!|.+:\d+:)  ==> Fatal error occurred/  (file-line-error mode prints './x.tex:3:  ==> Fatal error occurred, no output PDF file produced!')
  elif m = /^! (.*)$/ or (FLE.test(L) and !/^(?:Package|Class|LaTeX|Module)\b/.test(L)):
    parseErrorBlock()      // consumes lines; see error finding
  elif /^Runaway (argument|definition|preamble|text)\?$/:
    attach this line and the next (the argument text) to the following error; skip both
  elif BADBOX.test(L):
    parseBadbox()          // consumes content up to the next blank line
  elif WARN_HEAD.test(L):
    parseWarning()         // consumes continuation lines
  elif MISSING_CHAR.test(L):
    push warning
  elif INVALID_UTF8.test(L):
    push warning or info
  else:
    s = L.replace(/^\([A-Za-z][\w@.\-]*\)\s{2,}/, '')   // '(Font)   …', '(microtype)   …' continuations of Info messages
    trackPages(s)
    scanParens(s)
```
Handlers set i to the first line they did not consume. Also look for 'pdfTeX warning' anywhere in the line, because pdfTeX can print it mid-line after '[n{…map}'. Process the text before it with scanParens first.
Sources: https://raw.githubusercontent.com/James-Yu/LaTeX-Workshop/master/src/parse/parser/latexlog.ts

## [must] File stack: tokens, path regexes, parenthesis markers
Keep `stack: Frame[]` with `Frame = {kind:'file', path} | {kind:'paren'}`, seeded empty. The first '(' pushes the root, e.g. `(./antiddos_v2.tex`.

scanParens(s): walk each '(' or ')' in s from left to right.

On ')':
- Pop the top frame.
- If the popped frame was the last file frame, push it back. Never pop the root: the final ' )' closes the root, and a stray ')' must not empty the stack.

On '(': let `rest = s.slice(pos+1)` and try these in order:
1. Known project files, longest first. Match `rest.startsWith(c)` for c in `['./'+f, '"./'+f+'"', f, compileDir+'/'+f, outDir+'/'+f]`, sorted by descending length. This resolves `./my dir/file name.tex` and `./figs (old)/part.tex` exactly.
2. Quoted path: `/^"([^"]+)"/`. LuaTeX prints `("./my dir/file name.tex"` and `("./figs (old)/part.tex"`; pdfTeX and XeTeX in TeX Live 2026 do not quote.
3. Lazy match ending at the first extension: `/^((?:\.{1,2}\/|\/|[A-Za-z]:[\\/])[^\n]*?\.[A-Za-z0-9_-]{1,12})(?=[\s)"]|$)/`. This handles spaces and parentheses without a file list, and gets `.code.tex` right (it stops only where the extension is followed by space, ')' or end of line).
4. Fallback: `/^((?:[A-Za-z]:)?[^\s()"\[\]{}<>]*\/[^\s()"\[\]{}<>]*)/`. A '/' is required. This covers `(out-pdflatex/main.aux)`, which has no './' when -output-directory is used.
5. Otherwise push `{kind:'paren'}`. This handles balanced text such as '(HO)', '(encoding: OT1)', '(h,v)=(0.0pt,0.0pt)' and '(1in=72.27pt=25.4mm, 1cm=28.453pt)'.

Then continue scanning after the consumed path, because one line can hold several tokens: `) (./a.sty`, `(./antiddos_v2.out) (./antiddos_v2.out)`, and with max_print_line=10000 dozens of `) (/usr/…sty`.

Classify frames:
- Project file: relative, starts with './', or starts with compileDir.
- System file: absolute and outside compileDir. The real logs use `/home/detector/texlive/2026/…`, so do not hard-code `/usr/local/texlive`.

currentFile() is the innermost file frame. projectPath is the innermost project frame. Build filesTree (parent/child) for an Overleaf-style 'files used' view.
Sources: https://raw.githubusercontent.com/overleaf/overleaf/main/services/web/frontend/js/ide/log-parser/latex-log-parser.ts, https://raw.githubusercontent.com/James-Yu/LaTeX-Workshop/master/src/parse/parser/latexlog.ts, local fixtures fx/out-*/main.log

## [must] Never scan parentheses inside message blocks (evidence from the real log)
Badbox content, error context and help, and warning continuation lines contain the user's text, which often has an unbalanced '(' or ')'. One stray '(' makes the file's closing ')' decrement a paren marker instead of popping the file. After that, every later message is attributed to the wrong file.

Real evidence from antiddos_v2.log, two badbox blocks with 1 '(' and 0 ')':
- Log line 1772: `[]|\T1/ppl/m/n/9 the de-rived fea-ture tree (la-bels`
- Log line 1964: `…Source: \T1/lmtt/m/n/8 results/joint_filter.json \T1/ppl/m/n/8 (\T1/lmtt/m/n/8 runners/run_joint_filter.py…`

Synthetic evidence: `\hbox to 2cm{… (open}` produces `Overfull \hbox … detected at line 11` followed by `\OT1/cmr/m/n/10 xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx (open`.

How the other parsers handle this:
- Overleaf's parser scans badbox content lines for parentheses.
- LaTeX-Workshop skips only the first line after the header, even though content often spans 2–3 lines.

Our rule: after a badbox header, consume lines up to (not including) the next empty line. TeX's show_box always ends with ' []' followed by a blank line; for the vbox 'has occurred while \output is active []' case, the blank line comes right after the header. Test invariant: after parsing, no paren frames remain and the last frame is the root file.
Sources: local: antiddos_v2.log lines 1772-1775 and 1964-1968

## [must] Error blocks ('! ' and file-line-error), line numbers, help text, special cases
Error start:
- `! (.*)` in normal mode. The file is `currentFile()`.
- FLE = `/^((?:\.{1,2}\/|\/|[A-Za-z]:[\\/])[^:]*?|[^\s:()]+\.(?:tex|sty|cls|ltx|bbl|aux|def|cfg|clo|fd|dtx)):(\d+): (.*)$/` in -file-line-error mode. It gives the file and line explicitly. After unwrapping, a path with spaces or parentheses still matches, e.g. `./figs (old)/part.tex:2: Undefined control sequence.`.
- Even with -file-line-error, some errors are printed in '!' style: `! LaTeX Error: File `doesnotexist.tex' not found.` does, but the Emergency stop that follows becomes `./missingfile.tex:3: Emergency stop.`. Support both forms in one log.

Body: collect lines until `l\.(\d+) (.*)`. That is the TeX line number, and group 2 is the 'before' context. The next line is the 'after' context, indented to the error column. Stop early without a line number if another `! ` or FLE line appears first.

Help text: after the context line, consume up to 4 paragraphs separated by blank lines. Stop at two consecutive blank lines or at a line matching NEW_MSG = `/^(?:! |\(|\)|\[\d|LaTeX |Package |Class |Module |(?:Over|Under)full |Missing character|No file |\\openout|File: |Document Class:|\*\*\*|Here is how much|Output written|[^\s:]+:\d+: )/`. \errhelp-based expl3 errors contain internal blank lines ('LaTeX does not know anything more about this error, sorry.' blank 'Try typing <return> to proceed.').

Classifying the first line:
- `/^LaTeX(?: (\w+))? Error: (.*)$/`: covers 'LaTeX Error' and TeX Live 2026's 'LaTeX cmd Error: Command '\foo' already defined.'. Append following indented lines (`/^\s{2,}\S/`) up to the first blank line, e.g. `! LaTeX Error: Unicode character ☃ (U+2603)` + `               not set up for use with LaTeX.`.
- `/^(Package|Class|Module) (\S+) Error: (.*)$/`: append continuation lines starting with `(pkg)`.
- Undefined control sequence: take the macro from the end of the l.N before-text with `/(\\(?:[A-Za-z@]+\*?|.))\s*$/`, giving e.g. 'Undefined control sequence \undefinedmacro'.
- Missing character error (when \tracinglostchars>=3): `! Missing character: There is no ☃ (U+2603) in font [lmroman10-regular]:mapping=tex-text;.` ends with '.' instead of '!'. It is followed directly by `l.13 …`.

Secondary Emergency stop: 'Emergency stop.' right after another error is marked secondary. If the primary error has no line, copy the l.N or FLE line from the Emergency stop. For a missing \input file this gives line 3, which is correct.

Missing packages: `File `doesnotexistpkg.sty' not found.` in the preamble reports `l.3 \begin{document}` in TeX Live 2026, while the \usepackage was on line 2. Enrich this by searching the root preamble for `\\(?:usepackage|RequirePackage)(?:\[[^\]]*\])?\{[^}]*\bNAME\b` and override the line when found.

No `l.` line:
- `! Emergency stop.` + `<*> noend.tex` + `*** (job aborted, no legal \end found)`: file = root, line null. Set message to 'Emergency stop: job aborted, no legal \end found'.
- `*** (cannot \read from terminal in nonstop modes)` goes into the raw block only.

Other messages:
- Summary lines ignored: `!  ==> Fatal error occurred, no output PDF file produced!` and its file-line-error form.
- 'Missing $ inserted.' contains `<inserted text> ` and `$` context lines before `l.5 Text x^`.
Sources: local fixtures scratchpad fx2/out-pdflatex/{errors,missingfile,noend,fatal,missingchar}.log, fx2/fle/*.log, fx7/l3.log, https://raw.githubusercontent.com/overleaf/overleaf/main/services/web/frontend/js/ide/log-parser/latex-log-parser.ts

## [must] Warnings: header regex, continuation lines, input-line extraction, subtypes
WARN_HEAD = `/^(?:(Package|Class|Module) ([^\s:]+)|(LaTeX3?)(?: ([A-Za-z]+))?|(pdfTeX)) [Ww]arning(?: \(([^)]*)\))?: ?(.*)$/`
- Group 2: package name.
- Group 4: LaTeX submodule such as 'Font'.
- Group 6: pdfTeX category such as 'ext4'.
- Group 7: the text.

Continuation: append the following non-blank lines while they are one of:
- `(pkg)` continuations: `/^\(([A-Za-z][\w@.\-]*)\)\s+(.*)$/`, e.g. '(hyperref)', '(fancyhdr)', '(Font)', '(natbib)', '(rerunfilecheck)', '(biblatex)', or expl3's '(mymod)'.
- Indented lines `/^\s+\S/`: LaTeX \MessageBreak continuations, e.g. `LaTeX Warning: Unused global option(s):` + `    [nonexistentoption].` or `               but the document class provides …`.

Stop at a blank line or any other line. Strip the prefixes and join with single spaces.

Line number: `/\bon input line (\d+)\.?\s*$/` on the joined text; there is no line when absent. Why joining matters: 'LaTeX Font Warning: Font shape `OT1/cmr/bx/sc' undefined' carries its line only in the continuation `(Font)              using `OT1/cmr/bx/n' instead on input line 10.`. Overleaf's parser treats LaTeX Font warnings as single lines and loses that line number.

Subtypes (check in this order on the joined text):
- undefined-reference / undefined-citation: `/^(Reference|Citation|Hyper reference) [`']([^']*)' on page (\S+) undefined on input line (\d+)\.$/`. Accept both quote styles: biblatex prints 'LaTeX Warning: Citation 'good' on page 1 undefined on input line 5.' with a straight quote, which LaTeX-Workshop's backtick-only regex misses. natbib uses 'Package natbib Warning: Citation `x' …'.
- multiply-defined: `/(Label|Citation) [`']([^']*)' multiply defined/`.
- rerun: `/Rerun to get|Please \(re\)run|Please rerun LaTeX|may have changed|has changed\. Rerun|Rerun LaTeX/` (e.g. 'Package hyperref Warning: Rerun to get /PageLabels entry.').
- summary: `/^There were (?:undefined (?:references|citations)|multiply[- ]defined (?:labels|citations))\.?$|^Some font shapes were not available, defaults substituted\.$/`.

Do not classify these as warnings: 'Package pgfplots info on input line …' (lower-case info), 'Package … Info:', 'LaTeX Font Info:', 'Package rerunfilecheck Info: File … has not changed.', '==> First Aid for cleveref.sty applied!'. Match 'Rerun' only inside Warning messages, never the word 'Rerun' in 'Package: rerunfilecheck … Rerun checks for auxiliary files (HO)'.
Sources: local fixtures fx/out-*/main.log, fx3/bb.log, https://raw.githubusercontent.com/James-Yu/LaTeX-Workshop/master/src/parse/parser/latexlog.ts

## [must] Badbox header regex and line semantics
BADBOX = `/^(Overfull|Underfull|Tight|Loose) \\([hv])box \((?:badness (\d+)|(-?\d+(?:\.\d+)?)pt too (wide|high))\) (?:(in paragraph|in alignment) at lines (\d+)--(\d+)|detected at line (\d+)|has occurred while \\output is active)/`

Forms seen in TeX Live 2026 fixtures:
- 'Overfull \hbox (133.65085pt too wide) detected at line 11'
- 'Overfull \hbox (136.15877pt too wide) in paragraph at lines 14--15'
- 'Overfull \hbox (78.39197pt too wide) in alignment at lines 17--17': from \halign. LaTeX-Workshop's regexes miss this form.
- 'Overfull \vbox (28.45276pt too high) detected at line 19'
- 'Overfull \vbox (303.58267pt too high) has occurred while \output is active []': there is no line number; the trailing '[]' is box content, not a page. Attach the current page instead.
- 'Tight' and 'Loose' only appear when \hbadness < 100.

Line semantics:
- `line` = first number, `endLine` = second (Overleaf also uses the first). Store the badness or the amount in points for filtering, e.g. hide overfull boxes under 1pt.
- Cells of tabularx and p{} columns all report the line of \end{tabularx}, because tabularx typesets the body there. Real examples: the main log's 9 badboxes at 236--236 are all `\end{tabularx}}}`, and the supplement's 6 overfull boxes at 217--217 are `\end{tabularx}`.
- Title and abstract material typeset at \begin{document} reports 108--108.
Sources: local: antiddos_v2.log, antiddos_v2_supplementary.log, fx2/out-pdflatex/errors.log

## [should] XeTeX/LuaTeX-specific and Unicode messages
Missing character, logged as a warning by default because the TeX Live 2026 kernel sets \tracinglostchars=2 in latex.ltx:
- Regex: `/^!? ?Missing character: There is no (.+?) (?:\(U\+([0-9A-F]{4,6})\) )?in font (.+?)[!.]$/`
- XeTeX form: 'Missing character: There is no ☃ (U+2603) in font [lmroman10-regular]:mapping=tex-text;!'
- LuaTeX form: '… in font [lmroman10-regular]:+tlig;!'. LuaTeX repeated each missing character 3 times in the fixture (12 lines for 4 characters), so group duplicates.
- There is no line number; use `currentFile()`, line null, and the page.
- With \tracinglostchars>=3 it becomes an error ('! Missing character: … ;.' followed by 'l.13 Snow ☃.').

pdfTeX never prints 'Missing character' for UTF-8 input. It raises '! LaTeX Error: Unicode character ☃ (U+2603)' + '               not set up for use with LaTeX.' with an `l.3` line instead.

XeTeX 'Invalid UTF-8':
- Regex: `/^Invalid UTF-8 byte or sequence at line (\d+) replaced by U\+FFFD\.$/`.
- In the real main log, log lines 1646–1651 show 6 of these. They are reported at antiddos_v2.tex:108 (`\begin{document}`), but the bytes come from the binary EPS header of Definitions/logo-mdpi.eps. graphics reads it with \read, so the reported line belongs to the \input file, not the file that contains the bad bytes; the next lines are 'File: Definitions/logo-mdpi.eps Graphic file (type eps)'.
- Report as warning or info at file:line, with a hint pointing to the next 'File: … Graphic file' or '<…>' line. None of the .tex/.aux/.out files contain invalid UTF-8 (verified).

Font shape fallback:
- 'LaTeX Font Warning: Font shape `TU/lmr/bx/sc' undefined' + '(Font)              using `TU/lmr/bx/n' instead on input line 10.'
- End-of-run summary: 'LaTeX Font Warning: Some font shapes were not available, defaults substituted.'
Sources: local: antiddos_v2.log 1646-1653, local fixtures fx2/out-{xelatex,lualatex,pdflatex}/missingchar.log, fx7/l3.log, TL2026 latex.ltx line ~508 (\tracinglostchars=2)

## [should] pdfTeX warnings with context
Example: 'pdfTeX warning (ext4): destination with the same identifier (name{page.1}) has ' + 'been already used, duplicate ignored' (wrapped at 79), then '<to be read again> ', '                   \relax ', 'l.8 \newpage', '             [1]'. Parse it like an error block: level warning, kind pdftex-warning, line from `l.N` (8 here), category from '(ext4)'. The page marker '[1]' is on the context line, so run page tracking on it. The text contains '(name{page.1})', which is balanced, but it must not go through scanParens. Other common forms: 'pdfTeX warning: pdflatex (file ./fig.pdf): PDF inclusion: …'. Match `/pdfTeX warning(?: \(([^)]*)\))?: (.*)$/` anywhere in the line, because it can follow ']' or '}' on the same line.
Sources: local fixture fx6/dup.log lines 233-238

## [should] Warnings emitted while reading .aux (the real logs' multiply-defined citations)
Messages printed between `(./antiddos_v2.aux` and its ')' have `currentFile() = './antiddos_v2.aux'` and no line. Real log: log lines 1372–1409 hold 12 `Package natbib Warning: Citation `KEY' multiply defined.` plus `LaTeX Warning: Label `LastPage' multiply defined.`.

Root cause: each document uses `\usepackage{xr}\externaldocument{…}`, so each imports the other document's .aux. Main: antiddos_v2.tex:105-106. Supplement: antiddos_v2_supplementary.tex:66-67. Both define the same \bibitem keys and the lastpage label.

Enrichment: map an aux frame to its .tex, i.e. the root, and look up the source definitions:
- Label: search for `\\label\{KEY\}`.
- Citation: search for `\\bibitem(?:\[[^\]]*\])?\{KEY\}`.

Expected locations as antiddos_v2.tex / antiddos_v2_supplementary.tex:
- Siffer2017Anomaly 1545/736
- Rubinstein2009Antidote 1593/766
- Engelen2021Troubleshooting 1596/739
- Li2023ECOD 1650/742
- Li2020COPOD 1653/745
- Xu2023DIF 1656/748
- Goldstein2012HBOS 1659/751
- Bandaragoda2018INNE 1662/754
- Pevny2016Loda 1665/760
- Liu2008IsolationForest 1668/757
- Hosking1987GPD 1671/733
- Pendlebury2019Tesseract 1677/763

LastPage is defined by the lastpage package, so it has no source location. These are only 'duplicates' through xr, so a good hint text would say: 'duplicate imported via \externaldocument'.
Sources: local: antiddos_v2.tex lines 105-106, antiddos_v2_supplementary.tex 66-67, grep of \bibitem keys

## [must] TEST FIXTURE: antiddos_v2.log (XeTeX, TeX Live 2026, 2210 physical lines, 41 pages, no -file-line-error)
Totals: errors 0, badboxes 29, warnings 80. Treat the 6 'Invalid UTF-8' as info and warnings become 74. Engine 'xetex'. Final stack [./antiddos_v2.tex], with no leftover paren frames.

Badboxes: 29, all Underfull \hbox, all 'in paragraph', all in ./antiddos_v2.tex. Listed as start--end xCount [log lines]:
- 108--108 x1 [1665]
- 118--119 x1 [1680]
- 192--193 x1 [1729]
- 236--236 x9 [1742,1747,1752,1757,1762,1767,1772,1777,1782]
- 343--344 x1 [1806]
- 661--662 x2 [1931,1937]
- 667--668 x1 [1944]
- 1093--1094 x1 [1964]
- 1330--1331 x1 [2029]
- 1453--1453 x2 [2082,2088]
- 1534--1536 x1 [2109]
- 1549--1551 x3 [2116,2122,2128]
- 1591--1593 x2 [2141,2147]
- 1654--1656 x2 [2160,2166]
- 1660--1662 x1 [2172]
- Badness values in order: 1436,1527,1762,10000,1178,1178,10000,10000,1642,2401,1178,1178,1275,10000,2359,1365,2961,1565,1137,1360,1609,2384,2368,1454,5050,2707,1389,1097,1286.

Warnings (80):
- (a) 1 'Package inputenc Warning: inputenc package ignored with utf8 based engines.' [log 42]. file = /home/detector/texlive/2026/texmf-dist/tex/latex/base/inputenc.sty, projectPath = Definitions/mdpi.cls, line null.
- (b) 12 'Package natbib Warning: Citation `X' multiply defined.' [log 1372,1375,1378,1382,1385,1388,1391,1394,1397,1400,1403,1406] and 1 'LaTeX Warning: Label `LastPage' multiply defined.' [1409]. file ./antiddos_v2.aux, line null.
- (c) 16 'Package hyperref Warning: Token not allowed in a PDF string (Unicode): removing …' [1578–1638, every 4 lines], all ./antiddos_v2.tex:108. 14 remove 'math shift', 1 removes `\geq' [1582], 1 removes `\leq' [1594].
- (d) 6 'Invalid UTF-8 byte or sequence at line 108 replaced by U+FFFD.' [1646–1651] at ./antiddos_v2.tex:108.
- (e) 41 'Package fancyhdr Warning: \headheight is too small (12.0pt): Make it at least …' at ./antiddos_v2.tex, line null. The first [1686] says 20.0pt; the other 40 say 18.18796pt; each sits just before a page marker, one per page for pages 1–41.
- (f) 1 'LaTeX Warning: Text page 29 contains only floats.' [2011], line null.
- (g) 1 'Package natbib Warning: There were multiply defined citations.' [2178].
- (h) 1 'LaTeX Warning: There were multiply-defined labels.' [2196].

Must be 0: undefined references or citations, rerun warnings, Missing character, Font shape undefined, overfull boxes, vboxes.

With grouping by identical message: fancyhdr collapses to 2 groups and hyperref to 3.

Regression checks:
- The unwrapped path '(/home/detector/…/rerunfilecheck/rerunfilecheck' + '.sty' (log lines 1331–1332) is one frame.
- No logical line ends in 'defFile:' or 'styPackage:' (no false joins).
- Every entry after log line 1772 still maps to ./antiddos_v2.tex.
Sources: local: <paper directory>/antiddos_v2.log, prototype: scratchpad proto/texlog.ts output

## [must] TEST FIXTURE: antiddos_v2_supplementary.log (XeTeX, 1887 lines, 19 pages)
Totals: errors 0, badboxes 18 (12 Underfull \hbox + 6 Overfull \hbox), warnings 35. Final stack [./antiddos_v2_supplementary.tex].

Badboxes, all in ./antiddos_v2_supplementary.tex, all 'in paragraph':
- 147--148 underfull x2 [1615,1621], badness 10000 and 1127
- 217--217 overfull x6 [1654,1659,1664,1669,1674,1679], each '(0.58865pt too wide)'; content ' []|\T1/ppl/b/n/10 dr@1%| ' etc. (tabularx header cells, line 217 = \end{tabularx})
- 436--437 underfull x3 [1723,1730,1736], badness 1715, 2351, 2512
- 532--533 underfull x1 [1757], badness 3547
- 740--742 underfull x3 [1810,1816,1822], badness 10000, 3942, 2951
- 752--754 underfull x3 [1828,1834,1840], badness 7151, 10000, 10000

Warnings (35):
- 1 inputenc [log 42] (system file, projectPath Definitions/mdpi.cls)
- 12 natbib 'Citation `X' multiply defined.' [1381–1415] plus 'Label `LastPage' multiply defined.' [1418], all at ./antiddos_v2_supplementary.aux, line null
- 19 fancyhdr \headheight [first 1606]: 18 say 'at least 18.18796pt', 1 says '18.13795pt'
- 1 'There were multiply defined citations.' [1854]
- 1 'There were multiply-defined labels.' [1872]

Must be 0: hyperref warnings, Invalid UTF-8, errors, undefined refs or citations.
Sources: local: <paper directory>/antiddos_v2_supplementary.log

## [should] Synthetic fixtures to add to the test suite (generated and verified in texlive/texlive:latest)
Project fx with these files:
- `main.tex`: `\documentclass[a4paper,nonexistentoption]{article}\usepackage{hyperref}`, `\section{Test $x^2$}`, and `\input` of: `sections/intro` (\undefinedmacro on line 3, `\ref{fig:missing}` and `\cite{nokey}` on line 4), `"my dir/file name"` (`\hbox to 1cm{…}` on line 2), `"figs (old)/part"` (\anotherundefined on line 2), and a 100+ character path `a-very-long-directory-name-that-keeps-going-and-going/another-long-directory-name-for-wrap-test/deep` (\alsoundefined on line 2). Then `{\bfseries\scshape …}` on line 10, `\hbox to 2cm{… (open}` on line 11, a `p{1cm}` tabular on lines 13–15, `\[\hbox to 20cm{wide}\]` on line 17, and \missingfilemacro on line 18.
- Compile with pdflatex, xelatex, lualatex, each with and without -file-line-error: `docker run --rm --network none -u $(id -u):$(id -g) -e HOME=/tmp -v $PWD:/work -w /work texlive/texlive:latest <engine> -interaction=nonstopmode [-file-line-error] -output-directory=out main.tex`.

Expected, identical across all 6 variants except the LuaTeX badbox count:
- 4 errors:
  - ./sections/intro.tex:3 '\undefinedmacro'
  - ./figs (old)/part.tex:2
  - …/deep.tex:2
  - ./main.tex:18
- Warnings: pdfTeX 11, XeTeX 12 (extra 'Package hyperref Warning: Rerun to get /PageLabels entry.'), LuaTeX 11. They include:
  - Unused global option(s) '[nonexistentoption]'
  - 3 hyperref Token warnings at main.tex:4
  - undefined reference fig:missing and citation nokey at ./sections/intro.tex:4
  - Font shape `OT1/cmr/bx/sc' (TU/lmr/bx/sc for XeTeX/LuaTeX) at main.tex:10
  - end-of-run summaries: font substitution, undefined references, Label(s) may have changed, rerunfilecheck 'File `main.out' has changed' + 2 continuation lines
- Badboxes: pdfTeX and XeTeX 5:
  - './my dir/file name.tex':2 overfull 'detected at line 2'
  - main.tex:11 overfull 'detected'
  - main.tex:14--15 overfull 'in paragraph'
  - main.tex:17 underfull and overfull 'detected'
- LuaTeX 10 badboxes: it hyphenates the long word into 6 boxes at 14--15.

fx2:
- errors.tex:
  - 'Missing $ inserted.' x2 at lines 5 and 6
  - LaTeX Error '\begin{itemize} on input line 11 ended by \end{enumerate}.' at 13
  - Package mypkg Error at 15
  - 'Overfull \hbox … in alignment at lines 17--17'
  - 'Overfull \vbox … detected at line 19'
  - 'Overfull \vbox (303.58267pt too high) has occurred while \output is active []'
  - `h' float specifier changed
  - 2 undefined refs at 25
- missingfile.tex: 2 errors, 'File `doesnotexist.tex' not found.' (line 3 after propagation) + secondary Emergency stop.
- noend.tex: 1 error, Emergency stop and job aborted, no line.
- missingchar.tex: XeTeX 4 Missing character; LuaTeX 12 (3x repeats); pdfTeX 4 'Unicode character … not set up' errors at line 3.

Keep these logs, plus the bibtex/biber .blg files, as golden files.
Sources: scratchpad fx/, fx2/, fx3/, fx6/, fx7/ (generated logs)

## [must] BibTeX .blg parsing (BibTeX 0.99e, TeX Live 2026)
Detect the tool from line 1 with `/^This is BibTeX, Version/`. Parse line-oriented:
- Warning with a location: `/^Warning--(.*)$/` followed by `/^--line (\d+) of file (.+)$/` → warning at file:line. Example: 'Warning--string name "undefinedmacro" is undefined' / '--line 30 of file refs.bib'.
- Warning naming an entry: `/^Warning--(.*) in (\S+)$/`, e.g. 'empty journal in nojournal', 'to sort, need author or key in broken'. Find the key in the .bib with `new RegExp('^\\s*@\\w+\\s*[{(]\\s*' + escapeRe(key) + '\\s*(?:,|$)', 'm')` (allow a missing comma for broken entries).
- Missing entry: `/^Warning--I didn't find a database entry for "([^"]+)"$/` → map to the \cite in the .tex via the LaTeX 'Citation … undefined on input line N' warning.
- Errors: `/^(.*)---line (\d+) of file (.+)$/`, then context lines ' : …', until `/^I'm skipping whatever remains of this (entry|command)$/`. If '(Error may have been on previous line)' appears, point the editor at line-1. Examples: 'Repeated entry---line 14 of file refs.bib'; 'I was expecting a `,' or a `}'---line 22 of file refs.bib' (the real cause is the missing comma after the key on 21).
- Other errors: `/^(.*)---while reading file (.+)$/` for .aux problems such as 'I found no \citation commands'; bst errors via `/^(.*)\nwhile executing---line (\d+) of file (.+)$/m`; 'A bad cross reference---entry "x"' + 'refers to entry "y", which doesn't exist'; `/^I couldn't open (database|style|auxiliary) file (.+)$/`.
- Totals: `/^\(There (?:were|was) (\d+) (error message|warning)s?\)$/`. With errors present, BibTeX printed only '(There were 2 error messages)'.

Fixture fx3/bt.blg expected results:
- 2 errors: refs.bib:14 'Repeated entry'; refs.bib:22 'I was expecting a `,' or a `}''.
- 9 warnings:
  - refs.bib:30 undefined string
  - 'missingkey' has no database entry
  - 5 about 'broken' (to sort, and empty author, title, journal, year)
  - macroerr empty journal (key at line 27)
  - nojournal empty journal (key at line 8)
- bibtex exit code 2.
Sources: https://raw.githubusercontent.com/James-Yu/LaTeX-Workshop/master/src/parse/parser/bibtexlog.ts, https://raw.githubusercontent.com/overleaf/overleaf/main/services/web/frontend/js/ide/log-parser/bib-log-parser.ts, local fixture scratchpad fx3/bt.blg

## [must] Biber .blg parsing (Biber 2.22): the temp file is a hash, so track the data source
Line format in .blg: `[85] Utils.pm:480> ERROR - …`. Biber's stdout has the same messages without the prefix. HEAD = `/^(?:\[\d+\] [^>]*> )?(INFO|WARN|ERROR|FATAL) - (.*)$/`. Detect the tool with `/INFO - This is Biber/` on line 1.

Keep `dataSource`, updated from INFO `/^Found BibTeX data source '(.+)'$/`.

ERROR/WARN forms:
- `/^BibTeX subsystem: (.+?), line (\d+), (.*)$/` → file = dataSource (NOT the temp path), line = group 2. Example: 'ERROR - BibTeX subsystem: /tmp/biber_tmp_wpk5/8fe4c9854184545302f21ebf0d47516c_1.utf8, line 22, syntax error: found "author", expected ","'. Line 22 equals the original refs.bib line (verified). Overleaf's regex `/^BibTeX subsystem: \/.+\/(\w+\.\w+)_.+, line (\d+), (.+)$/` expects '<name>.bib_<n>.utf8' and fails on Biber 2.22's hash name.
- `/^Duplicate entry key: '([^']+)' in file '([^']+)'/`: point to the second occurrence of the key.
- `/[Ee]ntry '([^']+)' \(([^)]+)\)/`: datamodel and date warnings. Find the key's line in the .bib.
- `/^I didn't find a database entry for '([^']+)'/`.
- Totals: `/^(WARNINGS|ERRORS): (\d+)$/`.

After a Biber error, biblatex writes no .bbl. The LaTeX log then shows 'LaTeX Warning: Citation 'good' on page 1 undefined …' (straight quotes) for every key, 'LaTeX Warning: Empty bibliography on input line 6.', and 'Package biblatex Warning: Please (re)run Biber on the file:' + '(biblatex)                bb' + '(biblatex)                and rerun LaTeX afterwards.'.

Fixture fx3/bb.blg expected results: 1 error (refs.bib:22) and 1 warning (duplicate 'good', second occurrence at refs.bib:14). biber exit code 2.
Sources: https://raw.githubusercontent.com/James-Yu/LaTeX-Workshop/master/src/parse/parser/biberlog.ts, https://raw.githubusercontent.com/overleaf/overleaf/main/services/web/frontend/js/ide/log-parser/bib-log-parser.ts, local fixture scratchpad fx3/bb.blg, fx3/bb.log

## [should] latexmk 4.88: messages, exit codes, what to take from stdout
Always parse the final <job>.log for TeX messages; latexmk overwrites it on each run. Parse .blg only if a bibtex or biber rule ran in this build: 'Latexmk: applying rule 'bibtex bt'...' / "Running 'biber  \"bb\"'", or the .blg mtime is at least the build start.

From stdout, collect (strings taken from TL2026 latexmk.pl and seen in fixture output):
- `/^Latexmk: This is Latexmk, John Collins, .*Version (\S+)\.$/`
- `/^Run number (\d+) of rule '([^']+)'$/`: number of passes
- `/^Latexmk: Summary of warnings(?: from last run of \*latex)?:$/` followed by `/^  Latex failed to resolve (\d+) (reference|citation)\(s\)$/` and `/^  Latex found (\d+) multiply defined reference\(s\)$/`
- `/^Latexmk: ====Problematic refs and citations with line #s in .tex file:$/` followed by `/^  (Reference|Citation) `([^']+)' on page (\S+) undefined on input line (\d+)$/`
- `/^Collected error summary \(may duplicate other messages\):$/` followed by `/^  ([^:]+): (?:Command for '([^']+)' gave return code (\d+)|Bibtex errors: See file '([^']+)'|Biber errors: See file '([^']+)')$/`
- `/^Latexmk: Errors, so I did not complete making targets$/`
- `/^Latexmk: All targets \((.+)\) are up-to-date$/`
- `/^Latexmk: Maximum runs of (\S+) reached without getting stable files$/`: raise as a warning ('references did not stabilise')
- `/^Latexmk: Missing (?:input|bbl) file '([^']+)'/`

Exit codes (latexmk.pl): 0 success, 12 failure making targets (exit 12, line 3232), 10 and 11 command line or rc problems.

With `-xelatex`, latexmk runs 'xelatex -no-pdf … -recorder' and then xdvipdfmx. xdvipdfmx problems only appear on stdout as `/^xdvipdfmx:(warning|fatal): (.*)$/` (the binary contains the '%s:warning: ' and '%s:fatal: ' formats). Surface them as entries with file null.

Overleaf's runner uses `latexmk -cd -jobname=output -auxdir=$COMPILE_DIR -outdir=$COMPILE_DIR -synctex=1 -interaction=batchmode -time` plus `-f` (or `-halt-on-error` for stop-on-first-error mode). -f keeps producing a PDF when errors occur. Suggested for us: `-interaction=nonstopmode -file-line-error -f -synctex=1`. batchmode and nonstopmode write the same .log.
Sources: local: TL2026 latexmk.pl lines 3232, 4949, 5266, 5541, 10220-10376, 10547, 10702-10718, local fixtures scratchpad fx4/lmk-*.txt, https://raw.githubusercontent.com/overleaf/overleaf/main/services/clsi/app/js/LatexRunner.js

## [should] Post-processing: path mapping, grouping, pages, suppression
1. Normalize: `raw.replace(/^"|"$/g,'')`, strip './', strip `compileDir + '/'`, collapse '//'. Resolve aux and output-directory paths (e.g. 'out/main.aux' → main.aux → root .tex).
2. projectPath = the innermost frame whose normalized path is in the project tree. For system frames (e.g. inputenc.sty, loaded by ./Definitions/mdpi.cls) show 'in package inputenc (loaded from Definitions/mdpi.cls)' and drop the line.
3. Pages: track `/\[(\d+)(?:\.\d+)*(?=[\s\]{<]|$)/` in non-message text. '[N' is printed at shipout, so messages before the next '[N' are on page N. Use this for per-page messages such as fancyhdr, 'has occurred while \output is active' and missing characters. Total pages come from `/^Output written on .+ \((\d+) pages?/`.
4. Grouping key = kind + normalized message + file + line. Show '×41' for fancyhdr, collapse the 6 Invalid UTF-8 and LuaTeX's 3x repeated missing characters. Overleaf offers an `ignoreDuplicates` option keyed on raw text.
5. Hide 'rerun' and 'summary' kinds when latexmk finished successfully, because it already reran. Show them if latexmk stopped with 'Maximum runs … without getting stable files'.
6. Treat 'No file main.aux.' and 'No file main.bbl.' as info (normal on the first run).
7. Order: errors first, then warnings, then typesetting. Within a level keep log order, so the first error is usually the root cause.
Sources: https://raw.githubusercontent.com/overleaf/overleaf/main/services/web/frontend/js/ide/log-parser/latex-log-parser.ts

## [should] What we learned from Overleaf's latex-log-parser.ts (AGPL; approach only, do not copy)
Overleaf's parser works like this:
1. Unwrap: LogText joins a physical line to the previous one when the previous one is exactly 79 JavaScript characters, does not end with '...', and the current line does not start with '!'.
2. Two states, NORMAL and ERROR:
   - `! ` errors: collect up to `/^l\.[0-9]+/`, then two blank-line-terminated paragraphs.
   - FILE_LINE_ERROR_REGEX `/^([./].*):(\d+): (.*)/`.
   - 'Runaway argument'.
   - `LATEX_WARNING_REGEX /^LaTeX(?:3| Font)? Warning: (.*)$/`: single line.
   - HBOX: single line, line taken from `/lines? ([0-9]+)/`.
   - `PACKAGE_WARNING_REGEX /^((?:Package|Class|Module) \b.+\b Warning:.*)$/`: multi-line until a blank line, stripping a '(pkg)' prefix.
   - Otherwise parseParensForFilenames with a global openParens counter.
3. consumeFilePath: the text must match `/^\/?([^ ()\\]+\/)+/`; it handles spaces only when a '.ext' precedes the space.
4. Levels are error, warning and typesetting. postProcess can dedupe by raw text.

Gaps to fix in our version:
- JavaScript length counts UTF-16 units, not bytes or code points.
- False joins before 'File:' and 'Package:' lines.
- LaTeX Font warnings are single-line, so 'on input line N' is lost.
- Badbox content goes through the paren counter, which the real log breaks.
- The loose `lines? (\d+)` line regex.
- 'Missing character' and XeTeX messages are ignored.
- The file-line-error form of the Fatal banner is not ignored.
- './figs (old)/part.tex' is recorded as './figs'.

Its separate HumanReadableLogs rules attach friendly explanations to known error regexes. We can do the same with our own wording.
Sources: https://raw.githubusercontent.com/overleaf/overleaf/main/services/web/frontend/js/ide/log-parser/latex-log-parser.ts, https://raw.githubusercontent.com/overleaf/overleaf/main/services/web/frontend/js/ide/log-parser/bib-log-parser.ts

## [should] What we learned from LaTeX-Workshop latexlog.ts (MIT; regexes can be reused with attribution)
Regexes from latexlog.ts:
- `latexError = /^(?!.*ignored error)(?:(.*):(\d+):|!)(?:\s?(.+) [Ee]rror:)? (.+?)$/`
- `latexOverfullBox = /^(Overfull \\[vh]box \([^)]*\)) in paragraph at lines (\d+)--(\d+)$/`, plus `…Alt … detected at line (\d+)$` and `…Output … has occurred while \\output is active(?: \[(\d+)\])?`, and the same three for Underfull
- `latexWarn = /^((?:(?:Class|Package|Module) \S*)|LaTeX(?: \S*)?|LaTeX3) (Warning):\s+(.*?)(?: on(?: input)? line (\d+))?(\.|\?|)$/`
- `latexPackageWarningExtraLines = /^\((.*)\)\s+(.*?)(?: +on input line (\d+))?(\.)?$/`
- `latexMissChar = /^\s*(Missing character:.*?!)/`
- `UNDEFINED_REFERENCE = /^LaTeX Warning: (Reference|Citation) `(.*?)' on page (?:\d+) undefined on input line (\d+).$/`
- `messageLine = /^l\.\d+\s(\.\.\.)?(.*)$/`

File stack: parseLaTeXFileStack recurses over '(' and ')' with a `nested` counter. The path regex is `/^"?((?:(?:[a-zA-Z]:|\.|\/)?(?:\/|\\\\?))[^"()[\]]*)/`, trimmed; there is a MiKTeX variant `/^"?([^"()[\]]*\.[a-z]{3,})/`.

Gaps to fix in our version:
- No unwrapping at all.
- Only skips 1 badbox content line.
- Misses 'in alignment at lines'.
- Backtick-only undefined-reference regex, so biblatex's 'key' is missed.
- A line of 1 by default.
- BibTeX key lookups depend on the editor's citation cache.
Sources: https://raw.githubusercontent.com/James-Yu/LaTeX-Workshop/master/src/parse/parser/latexlog.ts, https://raw.githubusercontent.com/James-Yu/LaTeX-Workshop/master/src/parse/parser/bibtexlog.ts, https://raw.githubusercontent.com/James-Yu/LaTeX-Workshop/master/src/parse/parser/biberlog.ts

## [must] Edge-case catalogue (each needs a unit test)
1. Parentheses in normal text: '(HO)', '(encoding: OT1)', '(ALL-29, USABLE-22)', "Score (HBOS" + '): A Fast' wrapped across lines. Balanced text goes to paren frames; unbalanced text is only safe inside consumed blocks.
2. '(' in file paths with spaces or parentheses: pdfTeX and XeTeX print `(./figs (old)/part.tex` unquoted; LuaTeX prints `("./figs (old)/part.tex"`.
3. Long paths wrapped across lines (79/80 rules), including file-line-error paths split mid-word ('…another-long-directory-' + 'name-for-wrap-test/deep.tex:2:').
4. Multiple file tokens on one line; ') (' sequences; 60+ tokens per line when max_print_line=10000.
5. Output-directory paths without './' ('(out-pdflatex/main.aux)').
6. System paths outside /usr/local (e.g. /home/detector/texlive/2026).
7. Graphics lines '<Definitions/logo-mdpi.eps>' and '<use Definitions/logo-orcid.pdf>' are not stack frames.
8. Font map and encoding braces '{/usr/…/pdftex.map}' after '[1'.
9. Page markers split over lines ('[1' blank ']').
10. Warnings emitted inside .aux reading.
11. Warnings inside system .sty files, where 'on input line' refers to the .sty.
12. XeTeX 'Invalid UTF-8 … at line N', which refers to the \input file while the bytes come from a \read EPS.
13. Missing character in XeTeX (…mapping=tex-text;!) and LuaTeX (…:+tlig;!), a 79-byte line followed by another message, and the \tracinglostchars=3 error variant ending in '.'.
14. Font shape … undefined with the '(Font)' continuation that holds the line.
15. biblatex straight quotes (Citation 'x').
16. expl3 warnings '(mymod)   second line (with paren)' and expl3 errors whose help text has blank lines.
17. 'LaTeX cmd Error:' submodule names.
18. Error without an l.N line ('<*> noend.tex').
19. 'File `x.sty' not found' reported at the \begin{document} line.
20. Fatal banner in both '!' and 'file:line:' forms.
21. CRLF logs (Windows or MiKTeX uploads).
22. Truncated logs, e.g. a killed compile or timeout: finalize any open block at EOF and report 'log ended unexpectedly' if no 'Here is how much of TeX's memory' line appears.
23. Messages in \write18 or shell-escape output interleaved in the log.
24. Lines of exactly 79 characters in logs made with max_print_line=10000 (e.g. ') (/usr/local/texlive/2026/texmf-dist/tex/generic/kvdefinekeys/kvdefinekeys.sty'): never unwrap these.
Sources: local fixtures and real logs listed above

## [should] LuaLaTeX sandbox gotcha that affects log collection
Once a document needed a font lookup by name (here `\bfseries\scshape` fallback), lualatex spent more than 8 minutes at 100% CPU building the luaotfload font-name database ('Scanning 6295 collected font files ...'). One run with HOME unwritable ended with exit 139 (segfault) and a truncated log. Fix: in the compile image, run `luaotfload-tool -u` at build time as the runtime user, and set `TEXMFVAR` or `HOME` to a writable, persistent cache (e.g. `-e HOME=/tmp -e TEXMFVAR=/cache/texmf-var`). With a warm cache a trivial lualatex document compiled in about 4 seconds. The parser must cope with the truncated logs this produces (no 'Output written' line): report an error 'Compilation stopped unexpectedly (engine crashed or timed out)'.
Sources: local: scratchpad fx/out-lualatex-fle (exit 139), fx/out-lualatex-fle2/otfupdate.txt

## [should] Implementation and test harness
- Put the parser in a shared workspace package, e.g. packages/texlog with modules `unwrap.ts`, `latex.ts`, `bibtex.ts`, `biber.ts`, `latexmk.ts`, `index.ts`. Keep it pure: Buffer or Uint8Array in, JSON out.
- Run it on the server after each compile. Send the entries to the client along with the PDF URL, and keep the raw log for the 'Raw logs' pane with logLine anchors.
- Test with vitest 5.0.1 (MIT, latest on npm today). Golden tests: copy the two real logs and the fx*/ logs into test/fixtures and assert the counts and file:line lists from the fixture findings above.
- Property test: for every fixture, the stack ends at [root] with 0 paren frames, and no entry has file === null once the root has been seen.
- Node 22.19 runs .ts files directly (type stripping is on by default from 22.18); the prototype `node proto/texlog.ts <log>` ran that way.
- Prototype files, with the tested regexes, are in the scratchpad:
  - <scratch>
  - <scratch>
Sources: npm view vitest version -> 5.0.1

## [nice] Friendly hints (our own text) keyed by regex
Keep a table of `{match: RegExp, title, hint, docsUrl?}` applied to the message. It is similar in spirit to Overleaf's HumanReadableLogs, but write our own wording. Initial entries:
- 'Undefined control sequence': a typo, or a missing \usepackage.
- 'Missing \$ inserted': math-only command used in text, or an unescaped _ or ^.
- 'File `(.+)' not found'.
- 'Unicode character .* not set up for use with LaTeX': switch the project to XeLaTeX or LuaLaTeX, or add \DeclareUnicodeCharacter.
- 'Missing character: There is no': the current font lacks this glyph; use fontspec with a font that has it.
- '\\headheight is too small': add \setlength{\headheight}{…} (fancyhdr gives the value).
- 'Token not allowed in a PDF string': use \texorpdfstring{math}{text} in section and title arguments.
- 'multiply defined' via xr \externaldocument: harmless duplicate imported from the other document's .aux.
- 'Text page N contains only floats'.
- 'Font shape .* undefined'.
- 'Overfull \\hbox': links to the badbox docs; also suggest \sloppy or rewording.
- 'Emergency stop' (secondary): 'see the first error above'.

## Packages
- vitest@5.0.1 (MIT) — Unit and golden-fixture tests for the log parsers Latest dist-tag on npm as of 2026-09-21. The parser itself needs no runtime dependencies (uses TextDecoder, Buffer and RegExp).
- (none) latex-log-parser / @overleaf/latex-log-parser / texlogparser@n/a (n/a) — Checked whether a ready-made npm log parser exists npm view returned 404 for all three. The best references are Overleaf's in-repo parser (AGPL; learn from it only, do not copy) and LaTeX-Workshop's latexlog.ts, bibtexlog.ts and biberlog.ts (MIT).

## Risks
- When wrapping is on, the 79-column ambiguity cannot be fully resolved: a line that is naturally exactly 79 characters followed by an unlisted message start will still be falsely joined. Turning wrapping off with the max_print_line env var in our own compiles removes this; keep the heuristic only for foreign logs.
- LuaTeX's wrap behaviour (79 or 80 bytes, early wrap before multi-byte characters, and one 80-byte emoji line) was measured on only a few samples. Treat the LuaTeX unwrap rule as a heuristic and prefer unwrapped logs.
- Without the project's file list, paths containing '(' or spaces rely on the lazy extension-terminated regex. A file without an extension followed by more text on the same line could be mis-scoped. Always pass the known project files and the compile-dir prefix.
- Help text of package or expl3 errors is not strictly delimited. The two-blank-lines / NEW_MSG rule can leave a trailing help line in normal parsing; that is harmless unless it contains an unbalanced parenthesis.
- 'on input line N' refers to the innermost input file, which may be a system .sty. Showing that line against a project file would jump to the wrong place, so only attach the line when the innermost frame is a project file.
- The line of a badbox or error can be a proxy: tabularx and array cells report the \end{tabularx} line, title material reports \begin{document} (108), and a missing package reports the \begin{document} line instead of the \usepackage line. The UI should show the line range and log context, not claim precision.
- The user's real logs came from another machine (/home/detector/texlive/2026) and were written at 20:01, while antiddos_v2.tex was modified at 20:10. The spot-checked badbox lines still match the current source, but fixture expectations must reference the log files, not a live recompile.
- The Invalid UTF-8 warnings are attributed to antiddos_v2.tex:108, but the real cause is the EPS logo read with \read. Presenting them as source errors on line 108 would mislead users, so classify them as info with an explanatory hint.
- lualatex in the sandbox can take minutes or segfault on the first font-name lookup unless the luaotfload database is pre-built and TEXMFVAR is writable. Truncated logs must be handled.
- Overleaf's code is AGPL-3.0. Re-implement from the documented behaviour; do not paste its regexes or functions verbatim. LaTeX-Workshop is MIT, so reusing its regexes needs attribution in a NOTICE file.
