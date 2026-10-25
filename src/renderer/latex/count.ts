import { argCount, MATH_ENVS, stripComment } from './language'

// 単語数と文字数。命令・コメント・数式・ラベルやパスのような引数は数えない。
// 日本語では語の区切りがないので、texcount と同じく漢字・かなは 1 字を 1 語と数える。

export interface Counts {
  words: number
  chars: number
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿ｦ-ﾟ]/g
const LATIN_WORD = /[A-Za-z0-9À-ɏ]+(?:['’-][A-Za-z0-9À-ɏ]+)*/g
const SKIP_ENVS = ['tikzpicture', 'verbatim', 'lstlisting', 'minted', 'comment', 'filecontents']

function envPattern(names: Iterable<string>): RegExp {
  const alt = [...names].map((n) => n.replace(/[*]/g, '\\*')).join('|')
  return new RegExp(`\\\\begin\\{(${alt})\\}[\\s\\S]*?\\\\end\\{\\1\\}`, 'g')
}
const MATH_ENV = envPattern(MATH_ENVS)
const SKIP_ENV = envPattern(SKIP_ENVS)

// 本文として読む文字だけを残す
export function proseText(text: string, documentOnly: boolean): string {
  let body = text
  if (documentOnly) {
    const begin = body.indexOf('\\begin{document}')
    if (begin >= 0) {
      const end = body.indexOf('\\end{document}', begin)
      body = body.slice(begin + '\\begin{document}'.length, end < 0 ? undefined : end)
    }
  }
  body = body.split('\n').map(stripComment).join('\n')
  body = body
    .replace(SKIP_ENV, ' ')
    .replace(MATH_ENV, ' ')
    .replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)/g, ' ')
    .replace(/(^|[^\\])\$(?:\\.|[^$\\])*\$/g, '$1 ')
    .replace(/\\verb(.).*?\1/g, ' ')
  // 本文でない引数を取る命令は、引数ごと消す
  // \begin は {表の列} のような続く引数も消す
  body = body.replace(/\\([a-zA-Z@]+)\*?/g, (_, name: string) => {
    const n = name === 'begin' ? 3 : argCount(name)
    return n ? `\u0000${n}\u0000` : ' '
  })
  body = dropArgs(body)
  return body.replace(/\\[%$&#_{}]/g, (m) => m[1]).replace(/\\./g, ' ').replace(/[{}[\]~]/g, ' ')
}

// 印（\0 n \0）のあとの [..] と {..} を n 個ぶん消す。2 つめ以降は間を空けずに続くものだけ
function dropArgs(text: string): string {
  let out = ''
  let i = 0
  while (i < text.length) {
    const at = text.indexOf('\u0000', i)
    if (at < 0) {
      out += text.slice(i)
      break
    }
    out += text.slice(i, at) + ' '
    const close = text.indexOf('\u0000', at + 1)
    let n = Number(text.slice(at + 1, close))
    i = close + 1
    let first = true
    while (i < text.length) {
      if (first) while (/\s/.test(text[i] ?? '')) i++
      first = false
      const open = text[i]
      if (open !== '[' && open !== '{') break
      const end = open === '[' ? ']' : '}'
      let depth = 0
      for (; i < text.length; i++) {
        if (text[i] === open) depth++
        else if (text[i] === end && --depth === 0) {
          i++
          break
        }
      }
      if (open === '{' && --n === 0) break
    }
  }
  return out
}

export function count(text: string, documentOnly = true): Counts {
  const prose = proseText(text, documentOnly)
  const cjk = prose.match(CJK)?.length ?? 0
  const latin = prose.replace(CJK, ' ').match(LATIN_WORD)?.length ?? 0
  const chars = prose.replace(/\s/g, '').length
  return { words: latin + cjk, chars }
}

export function add(a: Counts, b: Counts): Counts {
  return { words: a.words + b.words, chars: a.chars + b.chars }
}
