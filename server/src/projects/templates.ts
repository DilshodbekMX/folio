/**
 * Built-in project templates (SPEC §4.7): 'blank' (minimal article) and 'example' (sections,
 * mathematics, a TikZ figure, a booktabs table, natbib citations into references.bib and
 * cross-references; compiles with pdfLaTeX + BibTeX).
 */
import type { Compiler, ProjectTemplate } from '@folio/shared/api'

export interface TemplateFile { path: string; content: string }
export interface Template { files: TemplateFile[]; rootPath: string; compiler: Compiler }

/** Escape text for use inside a LaTeX argument (\title{...}, \author{...}). */
export function escapeLatex(text: string): string {
  const map: Record<string, string> = {
    '\\': '\\textbackslash{}', '{': '\\{', '}': '\\}', '$': '\\$', '&': '\\&', '#': '\\#',
    '^': '\\textasciicircum{}', '_': '\\_', '%': '\\%', '~': '\\textasciitilde{}',
  }
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\{}$&#^_%~]/g, c => map[c])
}

function blank(title: string, author: string): Template {
  const main = `\\documentclass{article}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage{graphicx}

\\title{${title}}
\\author{${author}}
\\date{\\today}

\\begin{document}

\\maketitle

\\section{Introduction}

Start writing here.

\\end{document}
`
  return { files: [{ path: 'main.tex', content: main }], rootPath: 'main.tex', compiler: 'pdflatex' }
}

function example(title: string, author: string): Template {
  const main = `\\documentclass[11pt]{article}
\\usepackage[T1]{fontenc}
\\usepackage{lmodern}
\\usepackage[margin=2.5cm]{geometry}
\\usepackage{amsmath,amssymb}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage{tikz}
\\usetikzlibrary{arrows.meta,positioning}
\\usepackage[numbers,sort&compress]{natbib}
\\usepackage[colorlinks=true,allcolors=blue]{hyperref}

\\title{${title}}
\\author{${author}}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
This example project shows the main features of a \\LaTeX{} document:
sections and cross-references, mathematics, a figure drawn with Ti\\emph{k}Z,
a table typeset with \\texttt{booktabs}, and a bibliography managed with Bib\\TeX.
Edit anything and press \\emph{Recompile} to see the result.
\\end{abstract}

\\section{Introduction}\\label{sec:intro}

\\LaTeX{} was introduced by \\citet{lamport1994latex} as a set of macros on top of
\\TeX{} \\citep{knuth1984texbook}. Section~\\ref{sec:math} shows some mathematics,
Figure~\\ref{fig:pipeline} in Section~\\ref{sec:figure} is drawn with Ti\\emph{k}Z, and
Table~\\ref{tab:results} in Section~\\ref{sec:results} uses the \\texttt{booktabs} rules.

\\section{Mathematics}\\label{sec:math}

Inline mathematics sits in the text, like Euler's identity $e^{i\\pi} + 1 = 0$.
Displayed equations are numbered and can be referenced:
\\begin{equation}\\label{eq:gauss}
  \\int_{-\\infty}^{\\infty} e^{-x^2} \\,\\mathrm{d}x = \\sqrt{\\pi}.
\\end{equation}
Equation~\\eqref{eq:gauss} is the Gaussian integral. Aligned equations:
\\begin{align}
  f(x) &= \\sum_{n=0}^{\\infty} \\frac{f^{(n)}(a)}{n!} (x - a)^n, \\label{eq:taylor} \\\\
  \\nabla \\cdot \\mathbf{E} &= \\frac{\\rho}{\\varepsilon_0}. \\label{eq:gauss-law}
\\end{align}
The Taylor series~\\eqref{eq:taylor} and Gauss's law~\\eqref{eq:gauss-law} share one environment.

\\section{A figure drawn with Ti\\emph{k}Z}\\label{sec:figure}

\\begin{figure}[htbp]
  \\centering
  \\begin{tikzpicture}[
      >=Stealth,
      node distance=1.6cm,
      box/.style={draw, rounded corners, fill=blue!6, minimum width=2.3cm, minimum height=1cm, align=center}]
    \\node[box] (src) {Source\\\\(\\texttt{.tex})};
    \\node[box, right=of src] (engine) {pdf\\LaTeX{}\\\\+ Bib\\TeX};
    \\node[box, right=of engine] (pdf) {PDF};
    \\draw[->, thick] (src) -- (engine);
    \\draw[->, thick] (engine) -- (pdf);
    \\draw[->, dashed] (pdf.south) to[bend left=30] node[midway, below] {SyncTeX} (src.south);
  \\end{tikzpicture}
  \\caption{From source to PDF, and back again with SyncTeX.}
  \\label{fig:pipeline}
\\end{figure}

\\section{Results}\\label{sec:results}

\\begin{table}[htbp]
  \\centering
  \\caption{A table typeset with \\texttt{booktabs}.}
  \\label{tab:results}
  \\begin{tabular}{lrr}
    \\toprule
    Method   & Time (s) & Accuracy (\\%) \\\\
    \\midrule
    Baseline & 12.4     & 81.2 \\\\
    Improved & 9.8      & 86.5 \\\\
    Best     & 7.1      & 91.3 \\\\
    \\bottomrule
  \\end{tabular}
\\end{table}

\\section{Conclusion}\\label{sec:conclusion}

We revisited the ideas of Section~\\ref{sec:intro}. More details about \\LaTeX{} packages can be
found in \\citet{mittelbach2004companion}.

\\bibliographystyle{plainnat}
\\bibliography{references}

\\end{document}
`
  const bib = `@book{lamport1994latex,
  author    = {Leslie Lamport},
  title     = {{\\LaTeX}: A Document Preparation System},
  edition   = {2nd},
  publisher = {Addison-Wesley},
  address   = {Reading, MA},
  year      = {1994}
}

@book{knuth1984texbook,
  author    = {Donald E. Knuth},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  address   = {Reading, MA},
  year      = {1984}
}

@book{mittelbach2004companion,
  author    = {Frank Mittelbach and Michel Goossens and Johannes Braams and David Carlisle and Chris Rowley},
  title     = {The {\\LaTeX} Companion},
  edition   = {2nd},
  publisher = {Addison-Wesley},
  address   = {Boston, MA},
  year      = {2004}
}
`
  return {
    files: [{ path: 'main.tex', content: main }, { path: 'references.bib', content: bib }],
    rootPath: 'main.tex',
    compiler: 'pdflatex',
  }
}

export function buildTemplate(template: ProjectTemplate, opts: { projectName: string; authorName: string }): Template {
  const title = escapeLatex(opts.projectName)
  const author = escapeLatex(opts.authorName)
  return template === 'example' ? example(title, author) : blank(title, author)
}
