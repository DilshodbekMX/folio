Outputs used by the `fake` compile runner (server/src/compile/runner.ts, `COMPILE_RUNNER=fake`).

Produced once with `texlive/texlive:latest-full` (TeX Live 2026, latexmk 4.88) in the Folio sandbox:

- `main.tex`            the tiny hello-world source
- `main.pdf`, `main.log`, `main.synctex.gz`, `main.aux`
                        `latexmk -norc -cd -jobname=main -synctex=1 -interaction=batchmode -file-line-error -time -f -pdf main.tex`
- `error.log`           the same document with `\undefinedmacro` on line 5, compiled with `-halt-on-error` (no PDF)
- `texcount.txt`        `texcount -nocol -inc -utf8 main.tex`
- `preview.png`         `gs -q -dSAFER -dBATCH -dNOPAUSE -dEPSCrop -sDEVICE=png16m -r150 ... logo-mdpi.eps`

The fake runner copies these as `<jobname>.*` into the compile directory, so jobnames other than
`main` get the same content.
