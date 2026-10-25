// 補完に出す命令と環境。「名前 引数」の形で書き、{} は入力欄（スニペットの差し込み口）になる。
// 引数のない命令は名前だけ。よく使うものほど前に置く（同じ点数なら並び順で出る）。

const TEXT = `
section{} subsection{} subsubsection{} chapter{} part{} paragraph{} subparagraph{}
section*{} subsection*{} subsubsection*{} chapter*{}
textbf{} textit{} emph{} texttt{} textsc{} textsf{} textrm{} textsl{} textup{} textmd{} underline{} textnormal{}
label{} ref{} eqref{} pageref{} cref{} Cref{} autoref{} nameref{} cite{} citep{} citet{} parencite{} textcite{} autocite{}
footcite{} citeauthor{} citeyear{} nocite{} footnote{} footnotemark footnotetext{} caption{} centering item
includegraphics{} input{} include{} includeonly{} subfile{} bibliography{} bibliographystyle{} addbibresource{} printbibliography
documentclass{} usepackage{} title{} author{} date{} thanks{} maketitle tableofcontents listoffigures listoftables appendix
newline linebreak pagebreak newpage clearpage cleardoublepage noindent indent par
vspace{} hspace{} vspace*{} hspace*{} vfill hfill smallskip medskip bigskip quad qquad
url{} href{}{} hyperref[]{} newcommand{}{} renewcommand{}{} providecommand{}{} newenvironment{}{}{} DeclareMathOperator{}{}
newtheorem{}{} setlength{}{} addtolength{}{} setcounter{}{} stepcounter{} newcounter{}
tiny scriptsize footnotesize small normalsize large Large LARGE huge Huge
bfseries itshape ttfamily scshape sffamily rmfamily normalfont upshape slshape mdseries
today LaTeX TeX ldots dots textbackslash textasciitilde textendash textemdash
textwidth linewidth columnwidth textheight paperwidth paperheight baselineskip parindent parskip
raggedright raggedleft centerline{} mbox{} makebox{} fbox{} framebox{} parbox{}{} raisebox{}{} phantom{} hphantom{} vphantom{}
multicolumn{}{}{} multirow{}{}{} hline cline{} toprule midrule bottomrule cmidrule{} addlinespace tabularnewline
color{} textcolor{}{} colorbox{}{} definecolor{}{}{} marginpar{} protect ensuremath{} verb
SI{}{} si{} num{} qty{}{} unit{} ang{}
index{} printindex makeindex graphicspath{} usetikzlibrary{} pgfplotsset{} hypersetup{} geometry{}
draw node fill path coordinate addplot addlegendentry{} tikz{}
frametitle{} framesubtitle{} pause only{} uncover{} alert{} titlepage institute{} usetheme{}
`

const MATH = `
frac{}{} dfrac{}{} tfrac{}{} sqrt{} binom{}{} sum prod int iint iiint oint lim limsup liminf sup inf max min arg det
exp log ln lg sin cos tan sec csc cot arcsin arccos arctan sinh cosh tanh gcd Pr deg dim ker hom
partial nabla infty pm mp times div cdot cdots ldots vdots ddots
leq geq neq le ge ne approx equiv sim simeq cong propto ll gg prec succ preceq succeq
subset subseteq supset supseteq in notin ni cup cap setminus emptyset varnothing bigcup bigcap
forall exists nexists neg land lor implies iff to gets rightarrow leftarrow Rightarrow Leftarrow leftrightarrow Leftrightarrow
mapsto longrightarrow longleftarrow Longrightarrow Longleftarrow longmapsto uparrow downarrow hookrightarrow
hat{} bar{} tilde{} vec{} dot{} ddot{} check{} breve{} acute{} grave{} widehat{} widetilde{} overline{} overbrace{} underbrace{}
overrightarrow{} mathbf{} mathit{} mathrm{} mathcal{} mathbb{} mathfrak{} mathsf{} mathtt{} mathscr{} boldsymbol{} bm{}
operatorname{} text{} mathop{} left right middle big Big bigg Bigg langle rangle lfloor rfloor lceil rceil
lvert rvert lVert rVert vert Vert pmod{} bmod mod displaystyle textstyle scriptstyle
ell hbar imath jmath Re Im aleph wp angle triangle square prime star ast circ bullet oplus otimes odot ominus
perp parallel mid nmid dagger ddagger top bot vdash dashv models colon stackrel{}{} overset{}{} underset{}{}
xrightarrow{} xleftarrow{} tag{} nonumber notag intertext{} substack{} cfrac{}{} smash{} limits nolimits
alpha beta gamma delta epsilon varepsilon zeta eta theta vartheta iota kappa lambda mu nu xi pi varpi rho varrho
sigma varsigma tau upsilon phi varphi chi psi omega Gamma Delta Theta Lambda Xi Pi Sigma Upsilon Phi Psi Omega
`

export interface CommandSpec {
  name: string
  args: number
  math: boolean
}

function parse(list: string, math: boolean): CommandSpec[] {
  return list
    .trim()
    .split(/\s+/)
    .map((entry) => {
      const name = entry.replace(/[[\]{}]/g, '')
      const args = (entry.match(/\{\}/g) ?? []).length
      return { name, args, math }
    })
}

export const COMMANDS: CommandSpec[] = [...parse(TEXT, false), ...parse(MATH, true)]

// 環境の中身の決まった形。\t は 1 段の字下げ、#{} は入力欄。
const ENV_BODIES: Record<string, string> = {
  itemize: '\t\\item #{}',
  enumerate: '\t\\item #{}',
  description: '\t\\item[#{}] #{}',
  figure: '\t\\centering\n\t\\includegraphics[width=\\linewidth]{#{}}\n\t\\caption{#{}}\n\t\\label{fig:#{}}',
  table: '\t\\centering\n\t\\caption{#{}}\n\t\\label{tab:#{}}\n\t\\begin{tabular}{#{}}\n\t\t#{}\n\t\\end{tabular}',
  frame: '\t\\frametitle{#{}}\n\t#{}'
}
const ENV_ARGS: Record<string, string> = {
  figure: '[htbp]',
  table: '[htbp]',
  tabular: '{#{}}',
  'tabular*': '{#{}}{#{}}',
  tabularx: '{#{}}{#{}}',
  array: '{#{}}',
  minipage: '{#{}}',
  alignat: '{#{}}',
  'alignat*': '{#{}}',
  thebibliography: '{#{}}',
  multicols: '{#{}}',
  wrapfigure: '{#{}}{#{}}',
  subfigure: '{#{}}',
  minted: '{#{}}',
  columns: '',
  column: '{#{}}'
}

export const ENVIRONMENTS = `
document abstract itemize enumerate description figure figure* table table* tabular tabular* tabularx longtable center
flushleft flushright quote quotation verse verbatim minipage equation equation* align align* gather gather* multline multline*
flalign flalign* alignat alignat* split cases matrix pmatrix bmatrix vmatrix Vmatrix smallmatrix array subequations
theorem lemma proof definition corollary proposition remark example frame block columns column tikzpicture axis
thebibliography lstlisting minted titlepage subfigure wrapfigure landscape comment multicols
`
  .trim()
  .split(/\s+/)

export function envTemplate(name: string): string {
  const args = ENV_ARGS[name] ?? ''
  const body = ENV_BODIES[name] ?? '\t#{}'
  return `\\begin{${name}}${args}\n${body}\n\\end{${name}}`
}
