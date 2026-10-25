// フォルダ内の検索と置換で、main（ディスクのファイル）と画面（開いているファイル）が同じ決まりで探せるようにする。

export interface SearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

export interface SearchMatch {
  line: number
  column: number
  length: number
  before: string
  match: string
  after: string
}

export interface SearchFile {
  path: string
  matches: SearchMatch[]
}

export interface SearchResult {
  files: SearchFile[]
  total: number
  truncated: boolean
}

const PREVIEW_BEFORE = 14
const PREVIEW_MAX = 160

// 正しくない正規表現なら例外を投げる
export function buildPattern(query: string, opts: SearchOptions): RegExp {
  let source = opts.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (opts.wholeWord) source = `(?<!\\w)(?:${source})(?!\\w)`
  return new RegExp(source, opts.caseSensitive ? 'gm' : 'gim')
}

export function findMatches(text: string, re: RegExp, limit: number): SearchMatch[] {
  const matches: SearchMatch[] = []
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  re.lastIndex = 0
  let line = 0
  for (let m = re.exec(text); m && matches.length < limit; m = re.exec(text)) {
    // 長さ 0 の一致（^ など）は数えずに先へ進む
    if (!m[0].length) {
      re.lastIndex++
      continue
    }
    while (line + 1 < starts.length && starts[line + 1] <= m.index) line++
    const lineEnd = line + 1 < starts.length ? starts[line + 1] - 1 : text.length
    const lineText = text.slice(starts[line], lineEnd)
    const column = m.index - starts[line]
    const length = Math.min(m[0].length, lineText.length - column)
    const from = Math.max(0, column - PREVIEW_BEFORE)
    matches.push({
      line: line + 1,
      column,
      length: m[0].length,
      before: (from > 0 ? '…' : '') + lineText.slice(from, column).trimStart(),
      match: lineText.slice(column, column + length),
      after: lineText.slice(column + length, column + length + PREVIEW_MAX)
    })
  }
  return matches
}

// 正規表現のときだけ $1 などを使える。そうでなければ置換の文字はそのまま入れる。
export function replaceAll(text: string, re: RegExp, replacement: string, regex: boolean): { text: string; count: number } {
  let count = 0
  re.lastIndex = 0
  const next = text.replace(re, (...args) => {
    const m = args[0] as string
    if (!m.length) return m
    count++
    if (!regex) return replacement
    // 引数は (一致, 群…, 位置, 全体[, 名前付きの群])
    const end = typeof args[args.length - 1] === 'object' ? args.length - 3 : args.length - 2
    const groups = args.slice(1, end) as (string | undefined)[]
    return replacement.replace(/\$(\$|&|\d{1,2})/g, (all, ref: string) => {
      if (ref === '$') return '$'
      if (ref === '&') return m
      const n = Number(ref)
      return n >= 1 && n <= groups.length ? (groups[n - 1] ?? '') : all
    })
  })
  return { text: next, count }
}
