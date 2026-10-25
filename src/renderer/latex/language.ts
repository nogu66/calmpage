import {
  foldService,
  getIndentUnit,
  HighlightStyle,
  indentService,
  indentString,
  StreamLanguage,
  syntaxHighlighting,
  type IndentContext,
  type StreamParser,
  type StringStream
} from '@codemirror/language'
import { countColumn, EditorSelection, Prec, type EditorState, type Extension } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { Tag, tags as t } from '@lezer/highlight'

// LaTeX の字句解析。stex では数式と引数の見分けがつかないので、自前の StreamParser にした。
// 数式・コメント・ラベルやパスのような「本文でない引数」に印を付けておき、色分けとスペルチェックで使う。

export const mathTag = Tag.define()
export const mathCommandTag = Tag.define()
// \label{…} や \cite{…}、\usepackage{…} の中身。色は変えず、スペルチェックと数から外すための印。
export const argumentTag = Tag.define()
// verbatim や tikzpicture の中。命令の色は付けるが、本文としては扱わない。
export const codeTag = Tag.define()

export const MATH_ENVS = new Set([
  'equation', 'equation*', 'align', 'align*', 'alignat', 'alignat*', 'gather', 'gather*', 'multline', 'multline*',
  'flalign', 'flalign*', 'eqnarray', 'eqnarray*', 'math', 'displaymath', 'dmath', 'dmath*'
])
const VERBATIM_ENVS = new Set(['verbatim', 'verbatim*', 'Verbatim', 'lstlisting', 'minted', 'comment', 'filecontents', 'filecontents*'])
const CODE_ENVS = new Set(['tikzpicture', 'axis', 'semilogxaxis', 'semilogyaxis', 'loglogaxis', 'pgfpicture', 'forest', 'circuitikz'])

// 中身が本文でない引数を取る命令と、その引数の数（省略可能な [..] はすべて本文でないとみなす）
const ARG_COMMANDS: Record<string, number> = {
  label: 1, ref: 1, eqref: 1, pageref: 1, cref: 1, Cref: 1, cpageref: 1, Cpageref: 1, autoref: 1, nameref: 1, vref: 1, Vref: 1, labelcref: 1, subref: 1,
  input: 1, include: 1, includeonly: 1, subfile: 1, includegraphics: 1, includesvg: 1, includepdf: 1, lstinputlisting: 1, verbatiminput: 1,
  bibliography: 1, bibliographystyle: 1, addbibresource: 1, usepackage: 1, RequirePackage: 1, documentclass: 1, LoadClass: 1,
  begin: 1, end: 1, url: 1, href: 1, hyperref: 0, graphicspath: 1, usetikzlibrary: 1, usepgfplotslibrary: 1, pgfplotsset: 1, tikzset: 1,
  hypersetup: 1, geometry: 1, sisetup: 1, captionsetup: 1, lstset: 1, setminted: 1, newcommand: 1, renewcommand: 1, providecommand: 1,
  DeclareMathOperator: 1, newenvironment: 1, renewenvironment: 1, newtheorem: 1, setlength: 2, addtolength: 2, setcounter: 2,
  addtocounter: 2, stepcounter: 1, refstepcounter: 1, value: 1, arabic: 1, roman: 1, Roman: 1, alph: 1, Alph: 1, color: 1,
  textcolor: 1, colorbox: 1, pagecolor: 1, definecolor: 3, pagestyle: 1, thispagestyle: 1, pagenumbering: 1, si: 1, SI: 2, num: 1,
  qty: 2, unit: 1, ang: 1, vspace: 1, hspace: 1, rule: 2, fontsize: 2, selectfont: 0, multicolumn: 2, multirow: 2, cline: 1,
  cmidrule: 1, newcounter: 1, index: 1, glossary: 1, gls: 1, Gls: 1, glspl: 1, acrshort: 1, acrlong: 1, acrfull: 1, ac: 1
}

export function isCiteCommand(name: string): boolean {
  return /cite/i.test(name) && name !== 'citetitle' ? true : name === 'nocite'
}

export function argCount(name: string): number {
  return ARG_COMMANDS[name] ?? (isCiteCommand(name) ? 1 : 0)
}

interface State {
  // 数式の閉じ方: '$'、'$$'、'\\)'、'\\]'、または環境名（\end{…} で閉じる）
  math: string | null
  mathEnv: boolean
  verbatim: string | null
  code: number
  // 本文でない引数があといくつ続くか。0 なら普通の本文
  args: number
  depth: number
  // \begin と \end の直後だけ、引数を環境名として読む
  env: 'begin' | 'end' | null
  // \verb の区切り文字
  verb: string | null
}

// 括弧の中身を、行の終わりか対応する閉じ括弧まで読む。閉じたら true
function readGroup(stream: StringStream, state: State, open: string, close: string): boolean {
  while (!stream.eol()) {
    const ch = stream.next() as string
    if (ch === '\\') stream.next()
    else if (ch === open) state.depth++
    else if (ch === close && --state.depth === 0) return true
    else if (ch === '%' && open === '{') {
      stream.backUp(1)
      return false
    }
  }
  return false
}

function enterEnv(state: State, name: string): void {
  if (MATH_ENVS.has(name) && !state.math) {
    state.math = name
    state.mathEnv = true
  } else if (VERBATIM_ENVS.has(name)) state.verbatim = name
  else if (CODE_ENVS.has(name)) state.code++
}

function leaveEnv(state: State, name: string): void {
  if (state.mathEnv && state.math === name) {
    state.math = null
    state.mathEnv = false
  } else if (CODE_ENVS.has(name)) state.code = Math.max(0, state.code - 1)
}

const parser: StreamParser<State> = {
  name: 'latex',
  startState: () => ({ math: null, mathEnv: false, verbatim: null, code: 0, args: 0, depth: 0, env: null, verb: null }),
  copyState: (s) => ({ ...s }),
  // 空行で段落が切れたら、閉じ忘れの $ を持ち越さない（文書の残り全部が数式の色にならないように）
  blankLine: (state) => {
    if (state.math === '$' || state.math === '\\(') state.math = null
    state.args = 0
    state.depth = 0
  },
  token(stream, state) {
    if (state.verb) {
      const at = stream.string.indexOf(state.verb, stream.pos)
      if (at < 0) stream.skipToEnd()
      else {
        stream.pos = at + 1
        state.verb = null
      }
      return 'code'
    }
    if (state.verbatim) {
      const end = `\\end{${state.verbatim}}`
      const at = stream.string.indexOf(end, stream.pos)
      if (at === stream.pos) {
        state.verbatim = null
      } else {
        if (at < 0) stream.skipToEnd()
        else stream.pos = at
        return 'code'
      }
    }

    // 本文でない引数の途中（複数行にまたがるときも、ここで読み続ける）
    if (state.depth > 0) {
      if (stream.peek() === '%') {
        stream.skipToEnd()
        return 'comment'
      }
      const style = argStyle(state)
      if (readGroup(stream, state, '{', '}')) finishArg(stream, state)
      return style
    }
    if (state.args > 0) {
      if (stream.eatSpace()) return null
      const ch = stream.peek()
      if (ch === '[' || ch === '{') {
        stream.next()
        state.depth = 1
        const close = ch === '[' ? ']' : '}'
        const style = argStyle(state)
        const closed = readGroup(stream, state, ch, close)
        if (ch === '[') {
          // [..] は数に入れない。行をまたぐ [..] は珍しいので、閉じなければ打ち切る
          state.depth = 0
          return style
        }
        if (closed) finishArg(stream, state)
        return style
      }
      state.args = 0
      state.env = null
    }

    const ch = stream.peek()
    if (ch === '%') {
      stream.skipToEnd()
      return 'comment'
    }
    if (ch === '\\') {
      stream.next()
      if (stream.match(/^[a-zA-Z@]+\*?/)) {
        const name = stream.current().slice(1).replace(/\*$/, '')
        if (name === 'verb' || name === 'lstinline') {
          const delim = stream.next()
          if (delim && delim !== '{') state.verb = delim
          return 'tag'
        }
        const n = argCount(name)
        if (n) {
          state.args = n
          state.env = name === 'begin' ? 'begin' : name === 'end' ? 'end' : null
        }
        return state.math && !state.env ? 'mathCommand' : 'tag'
      }
      const next = stream.next()
      if (next === '(' || next === '[') {
        if (!state.math) {
          state.math = next === '(' ? '\\)' : '\\]'
          return 'mathCommand'
        }
      } else if ((next === ')' || next === ']') && state.math === `\\${next}`) {
        state.math = null
        return 'mathCommand'
      }
      return state.math ? 'mathCommand' : 'tag'
    }
    if (ch === '$') {
      if (state.math === '$') {
        stream.next()
        state.math = null
      } else if (stream.match('$$')) {
        if (state.math === '$$') state.math = null
        else if (!state.math) state.math = '$$'
      } else {
        stream.next()
        if (!state.math) state.math = '$'
      }
      return 'math'
    }
    if (ch === '{' || ch === '}' || ch === '[' || ch === ']') {
      stream.next()
      return 'bracket'
    }
    // 次の特別な文字までをまとめて読む
    stream.next()
    while (!stream.eol() && !/[\\%${}[\]]/.test(stream.peek() as string)) stream.next()
    if (state.math) return 'math'
    if (state.code) return 'code'
    return null
  },
  languageData: {
    commentTokens: { line: '%' },
    indentOnInput: /^\s*\\end\{[^}]*\}?$/,
    closeBrackets: { brackets: ['(', '[', '{'] }
  },
  tokenTable: { math: mathTag, mathCommand: mathCommandTag, argument: argumentTag, code: codeTag }
}

// 環境名は数式の中でも数式の色にしない（\begin と \end の色をそろえる）
function argStyle(state: State): string {
  return state.math && !state.env ? 'math argument' : 'argument'
}

function finishArg(stream: StringStream, state: State): void {
  state.depth = 0
  state.args--
  if (state.env) {
    const text = stream.current()
    const name = text.slice(text.indexOf('{') + 1, -1).trim()
    if (state.env === 'begin') enterEnv(state, name)
    else leaveEnv(state, name)
    state.env = null
    state.args = 0
  }
}

export const latexLanguage = StreamLanguage.define(parser)

// 色分けは控えめに: 命令は差し色（紙では太字の墨）、数式は少しだけ色を変え、コメントは灰色、括弧は薄く。
// 数式は名前の付いた class にする（class を渡すと色は付かないので、色は下のテーマで付ける。テストでも見分ける）。
const latexHighlight = HighlightStyle.define([
  { tag: t.tagName, color: 'var(--syntax-command)', fontWeight: 'var(--syntax-weight)' },
  { tag: [mathTag, mathCommandTag], class: 'cm-latex-math' },
  { tag: t.comment, color: 'var(--muted)' },
  { tag: t.bracket, color: 'var(--faint)' },
  { tag: t.invalid, color: 'var(--syntax-command)', textDecoration: 'underline wavy' }
])

const latexTheme = EditorView.theme({
  '.cm-latex-math': { color: 'var(--syntax-math)' }
})

// ---------- 折りたたみ ----------

export const HEADING_LEVELS: Record<string, number> = {
  part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6
}
const HEADING = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*[[{]/
const SECTION_END = /^\s*\\(end\{document\}|appendix\b|bibliography\{|printbibliography\b|begin\{thebibliography\})/
const SCAN_LIMIT = 20000

// コメントを除いた行（\% はコメントの始まりではない）
export function stripComment(line: string): string {
  const m = /(^|[^\\])(\\\\)*%/.exec(line)
  return m ? line.slice(0, m.index + m[0].length - 1) : line
}

function foldEnvironment(state: EditorState, lineStart: number, text: string): { from: number; to: number } | null {
  // 同じ行で閉じていない最後の \begin を折る
  const re = /\\(begin|end)\{([^}]+)\}/g
  const open: { name: string; end: number }[] = []
  for (let m; (m = re.exec(text)); ) {
    if (m[1] === 'begin') open.push({ name: m[2], end: m.index + m[0].length })
    else if (open.length && open[open.length - 1].name === m[2]) open.pop()
  }
  const last = open.pop()
  if (!last) return null
  const doc = state.doc
  const startLine = doc.lineAt(lineStart)
  let depth = 1
  for (let n = startLine.number + 1; n <= Math.min(doc.lines, startLine.number + SCAN_LIMIT); n++) {
    const line = doc.line(n)
    const body = stripComment(line.text)
    const inner = /\\(begin|end)\{([^}]+)\}/g
    for (let m; (m = inner.exec(body)); ) {
      if (m[2] !== last.name) continue
      depth += m[1] === 'begin' ? 1 : -1
      if (depth === 0) {
        const to = line.from + m.index
        const from = startLine.to
        return to > from ? { from, to } : null
      }
    }
  }
  return null
}

function foldHeading(state: EditorState, lineStart: number, text: string): { from: number; to: number } | null {
  const m = HEADING.exec(text)
  if (!m) return null
  const level = HEADING_LEVELS[m[1]]
  const doc = state.doc
  const startLine = doc.lineAt(lineStart)
  let lastContent = startLine.to
  let n = startLine.number + 1
  for (; n <= Math.min(doc.lines, startLine.number + SCAN_LIMIT); n++) {
    const line = doc.line(n)
    const h = HEADING.exec(line.text)
    if ((h && HEADING_LEVELS[h[1]] <= level) || SECTION_END.test(line.text)) break
    if (line.text.trim()) lastContent = line.to
  }
  return lastContent > startLine.to ? { from: startLine.to, to: lastContent } : null
}

const latexFold = foldService.of((state, lineStart, lineEnd) => {
  const text = stripComment(state.sliceDoc(lineStart, lineEnd))
  if (!text.includes('\\')) return null
  return foldEnvironment(state, lineStart, text) ?? foldHeading(state, lineStart, text)
})

// ---------- 字下げ ----------

// 環境の中は 1 段下げる。document だけは下げない（本文全体が下がってしまうので）。
function envDelta(text: string): number {
  let delta = 0
  for (const m of stripComment(text).matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
    if (m[2] === 'document') continue
    delta += m[1] === 'begin' ? 1 : -1
  }
  return delta
}

function indentLatex(cx: IndentContext, pos: number): number | null {
  const doc = cx.state.doc
  const current = cx.lineAt(pos, 1)
  const currentText = current.text.slice(Math.max(0, pos - current.from))
  // 1 つ前の空でない行を探す
  let prev = cx.lineAt(pos, -1)
  let prevText = prev.from < pos ? prev.text.slice(0, pos - prev.from) : ''
  let n = doc.lineAt(prev.from).number
  while (!prevText.trim()) {
    if (n <= 1) return 0
    n--
    const line = doc.line(n)
    prev = { text: line.text, from: line.from }
    prevText = line.text
  }
  const base = countColumn(/^\s*/.exec(prevText)![0], cx.state.tabSize)
  const opened = Math.max(0, envDelta(prevText))
  const closing = /^\s*\\end\{(?!document\})/.test(currentText) ? 1 : 0
  // 前の行が \end で始まるなら、その行の字下げはもう戻っているので、そのまま使う
  const prevCloses = /^\s*\\end\{/.test(prevText) ? 0 : Math.min(0, envDelta(prevText))
  return Math.max(0, base + (opened + prevCloses - closing) * cx.unit)
}

// ---------- \begin{…} のあとの Enter で \end{…} を閉じる ----------

function closeEnvironmentOnEnter(view: EditorView): boolean {
  const { state } = view
  const sel = state.selection.main
  if (!sel.empty || state.selection.ranges.length > 1) return false
  const line = state.doc.lineAt(sel.head)
  const before = line.text.slice(0, sel.head - line.from)
  const after = line.text.slice(sel.head - line.from)
  if (after.trim()) return false
  const m = /\\begin\{([^}]+)\}(\[[^\]]*\]|\{[^}]*\})*\s*$/.exec(stripComment(before))
  if (!m) return false
  const name = m[1]
  const text = state.doc.toString()
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const begins = text.match(new RegExp(`\\\\begin\\{${escaped}\\}`, 'g'))?.length ?? 0
  const ends = text.match(new RegExp(`\\\\end\\{${escaped}\\}`, 'g'))?.length ?? 0
  if (begins <= ends) return false
  const base = /^\s*/.exec(line.text)![0]
  const inner = name === 'document' ? base : base + indentString(state, getIndentUnit(state))
  const insert = `\n${inner}\n${base}\\end{${name}}`
  view.dispatch({
    changes: { from: sel.head, to: line.to, insert },
    selection: EditorSelection.cursor(sel.head + 1 + inner.length),
    scrollIntoView: true,
    userEvent: 'input'
  })
  return true
}

export function latex(): Extension[] {
  return [
    latexLanguage,
    syntaxHighlighting(latexHighlight),
    latexTheme,
    latexFold,
    indentService.of(indentLatex),
    Prec.high(keymap.of([{ key: 'Enter', run: closeEnvironmentOnEnter }]))
  ]
}
