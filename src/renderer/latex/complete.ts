import {
  insertCompletionText,
  pickedCompletion,
  snippet,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource
} from '@codemirror/autocomplete'
import { syntaxTree } from '@codemirror/language'
import type { EditorState } from '@codemirror/state'
import { COMMANDS, ENVIRONMENTS, envTemplate, type CommandSpec } from './commands'
import { stripComment } from './language'
import { dirName, relativePath, type Project } from './project'

export interface CompletionDeps {
  project: Project
  // 組んでいる本体（パスの起点）。分からなければ開いているファイル
  root: () => string | null
  path: () => string | null
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

export function inMath(state: EditorState, pos: number): boolean {
  const node = syntaxTree(state).resolveInner(pos, -1)
  return /^math/.test(node.name)
}

// 選んだあと、すでに { か [ が続いていれば名前だけ入れる（引数を打ち直しているところに括弧を重ねない）
function commandApply(spec: CommandSpec): Completion['apply'] {
  const label = `\\${spec.name}`
  const snip = spec.args ? snippet(label + '{#{}}'.repeat(spec.args)) : null
  return (view, completion, from, to) => {
    const next = view.state.sliceDoc(to, to + 1)
    if (snip && next !== '{' && next !== '[') return snip(view, completion, from, to)
    view.dispatch({ ...insertCompletionText(view.state, label, from, to), annotations: pickedCompletion.of(completion) })
  }
}

// \begin を選んだら、括弧を足して環境名の候補を続けて出す
function beginApply(name: 'begin' | 'end'): Completion['apply'] {
  return (view, completion, from, to) => {
    const insert = `\\${name}{}`
    view.dispatch({
      changes: { from, to, insert },
      selection: { anchor: from + insert.length - 1 },
      annotations: pickedCompletion.of(completion),
      userEvent: 'input.complete'
    })
    startCompletion(view)
  }
}

const STATIC_COMMANDS: { option: Completion; math: boolean }[] = [
  ...COMMANDS.map((spec) => ({
    math: spec.math,
    option: { label: `\\${spec.name}`, type: spec.math ? 'constant' : 'function', apply: commandApply(spec) } as Completion
  })),
  { math: false, option: { label: '\\begin', type: 'keyword', apply: beginApply('begin') } },
  { math: false, option: { label: '\\end', type: 'keyword', apply: beginApply('end') } }
]

function commandSource(deps: CompletionDeps): CompletionSource {
  return async (cx: CompletionContext): Promise<CompletionResult | null> => {
    const m = cx.matchBefore(/\\[a-zA-Z@]*\*?/)
    if (!m) return null
    // \\（改行）のあとは命令ではない。前に続く \ が奇数個なら、この \ はその相方
    const before = /\\*$/.exec(cx.state.sliceDoc(Math.max(0, m.from - 20), m.from))![0].length
    if (before % 2) return null
    const math = inMath(cx.state, m.from)
    await deps.project.load()
    if (cx.aborted) return null
    const seen = new Set<string>()
    const options: Completion[] = []
    for (const { option, math: forMath } of STATIC_COMMANDS) {
      seen.add(option.label)
      options.push(forMath === math ? option : { ...option, boost: -1 })
    }
    for (const def of deps.project.definitions()) {
      if (def.kind !== 'command' || seen.has(`\\${def.name}`)) continue
      seen.add(`\\${def.name}`)
      options.push({ label: `\\${def.name}`, type: 'variable', detail: def.args ? `{…}×${def.args}` : undefined, boost: 1, apply: commandApply({ name: def.name, args: def.args, math: false }) })
    }
    return { from: m.from, options, validFor: /^\\[a-zA-Z@]*\*?$/ }
  }
}

// ---------- 環境名 ----------

// カーソルより前で閉じていない、いちばん内側の環境
function openEnvironment(state: EditorState, pos: number): string | null {
  const stack: string[] = []
  const text = state.sliceDoc(Math.max(0, pos - 200_000), pos)
  for (const line of text.split('\n')) {
    for (const m of stripComment(line).matchAll(/\\(begin|end)\{([^}]+)\}/g)) {
      if (m[1] === 'begin') stack.push(m[2])
      else if (stack[stack.length - 1] === m[2]) stack.pop()
    }
  }
  return stack.pop() ?? null
}

function environmentSource(deps: CompletionDeps): CompletionSource {
  return async (cx) => {
    const m = cx.matchBefore(/\\(begin|end)\s*\{[^}]*/)
    if (!m) return null
    const begin = m.text.startsWith('\\begin')
    const from = m.from + m.text.indexOf('{') + 1
    await deps.project.load()
    if (cx.aborted) return null
    const names = new Set([...ENVIRONMENTS, ...deps.project.definitions().filter((d) => d.kind === 'environment').map((d) => d.name)])
    const open = begin ? null : openEnvironment(cx.state, m.from)
    const options: Completion[] = [...names].map((name) => ({
      label: name,
      type: 'type',
      boost: name === open ? 99 : 0,
      apply: begin ? beginEnvApply(name, m.from) : endEnvApply(name)
    }))
    if (open && !names.has(open)) options.push({ label: open, type: 'type', boost: 99, apply: endEnvApply(open) })
    return { from, options, validFor: /^[a-zA-Z*]*$/ }
  }
}

// \begin{名前} を選んだら \end{名前} まで入れ、カーソルを中へ。行の続きに何かあるときは名前だけ
function beginEnvApply(name: string, start: number): Completion['apply'] {
  return (view, completion, from, to) => {
    const line = view.state.doc.lineAt(to)
    let end = to
    if (view.state.sliceDoc(end, end + 1) === '}') end++
    if (view.state.sliceDoc(end, line.to).trim()) {
      view.dispatch({ ...insertCompletionText(view.state, name, from, to), annotations: pickedCompletion.of(completion) })
      return
    }
    snippet(envTemplate(name))(view, completion, start, end)
  }
}

function endEnvApply(name: string): Completion['apply'] {
  return (view, completion, from, to) => {
    const end = view.state.sliceDoc(to, to + 1) === '}' ? to + 1 : to
    view.dispatch({
      changes: { from, to: end, insert: `${name}}` },
      selection: { anchor: from + name.length + 1 },
      annotations: pickedCompletion.of(completion),
      userEvent: 'input.complete'
    })
  }
}

// ---------- 参照・文献・パス ----------

// カンマで区切った引数の、いま打っている 1 つ分
function lastSegment(cx: CompletionContext, text: string): number {
  const inner = text.slice(text.lastIndexOf('{') + 1)
  const seg = inner.slice(inner.lastIndexOf(',') + 1).replace(/^\s+/, '')
  return cx.pos - seg.length
}

function refSource(deps: CompletionDeps): CompletionSource {
  return async (cx) => {
    const m = cx.matchBefore(/\\[a-zA-Z]*ref\*?\s*\{[^}]*/)
    if (!m) return null
    const from = lastSegment(cx, m.text)
    await deps.project.load()
    if (cx.aborted) return null
    const seen = new Set<string>()
    const options: Completion[] = []
    for (const label of deps.project.labels()) {
      if (seen.has(label.name)) continue
      seen.add(label.name)
      options.push({ label: label.name, type: 'variable', detail: `${baseName(label.file)}:${label.line}` })
    }
    return { from, options, validFor: /^[^,}\s]*$/ }
  }
}

function citeSource(deps: CompletionDeps): CompletionSource {
  return async (cx) => {
    const m = cx.matchBefore(/\\[a-zA-Z]*cite[a-zA-Z]*\*?\s*(?:\[[^\]]*\])*\{[^}]*/)
    if (!m) return null
    const from = lastSegment(cx, m.text)
    await deps.project.load()
    if (cx.aborted) return null
    const options: Completion[] = deps.project.bibEntries().map((e) => {
      const authors = e.author.split(/\s+and\s+/i)
      const first = authors[0]?.split(',')[0]?.trim().split(' ').pop() ?? ''
      const who = authors.length > 2 ? `${first} et al.` : authors.length === 2 ? `${first} & ${authors[1].split(',')[0].trim().split(' ').pop()}` : first
      return { label: e.key, type: 'text', detail: [who, e.year].filter(Boolean).join(' '), info: e.title || undefined }
    })
    return { from, options, validFor: /^[^,}\s]*$/ }
  }
}

const IMAGE = /\.(png|jpe?g|pdf|eps|svg)$/i
const PATH_COMMANDS: Record<string, { match: RegExp; strip: boolean; list: boolean }> = {
  includegraphics: { match: IMAGE, strip: false, list: false },
  includesvg: { match: /\.svg$/i, strip: true, list: false },
  includepdf: { match: /\.pdf$/i, strip: false, list: false },
  input: { match: /\.tex$/i, strip: true, list: false },
  include: { match: /\.tex$/i, strip: true, list: false },
  includeonly: { match: /\.tex$/i, strip: true, list: true },
  subfile: { match: /\.tex$/i, strip: false, list: false },
  subfileinclude: { match: /\.tex$/i, strip: false, list: false },
  bibliography: { match: /\.bib$/i, strip: true, list: true },
  addbibresource: { match: /\.bib$/i, strip: false, list: false }
}

function pathSource(deps: CompletionDeps): CompletionSource {
  return async (cx) => {
    const m = cx.matchBefore(/\\([a-zA-Z]+)\*?\s*(?:\[[^\]]*\])*\{[^}]*/)
    if (!m) return null
    const command = /^\\([a-zA-Z]+)/.exec(m.text)![1]
    const spec = PATH_COMMANDS[command]
    if (!spec) return null
    const from = spec.list ? lastSegment(cx, m.text) : m.from + m.text.indexOf('{') + 1
    // 画像は置いたばかりのことが多いので、毎回一覧を読み直す
    const files = await deps.project.list(true)
    if (cx.aborted) return null
    const current = deps.path()
    const root = deps.root() ?? current
    if (!root) return null
    const base = dirName(root)
    // 組んでできた PDF（同じ名前の .tex がある）は画像の候補に出さない
    const tex = new Set(files.filter((f) => f.endsWith('.tex')).map((f) => f.slice(0, -4)))
    const options: Completion[] = files
      .filter((f) => spec.match.test(f) && f !== current && f !== root && !(f.endsWith('.pdf') && tex.has(f.slice(0, -4))))
      .map((f) => {
        const rel = relativePath(base, f)
        return { label: spec.strip ? rel.replace(/\.[^./]+$/, '') : rel, type: 'namespace' }
      })
    return { from, options, validFor: spec.list ? /^[^,}]*$/ : /^[^}]*$/ }
  }
}

export function completionSources(deps: CompletionDeps): CompletionSource[] {
  return [commandSource(deps), environmentSource(deps), refSource(deps), citeSource(deps), pathSource(deps)]
}
