import { HEADING_LEVELS, stripComment } from './language'
import type { Project } from './project'

// 見出しの一覧。本体から \input と \include をたどり、読み込む順に並べる。

export interface Heading {
  level: number
  title: string
  file: string
  line: number
}

const HEADING = /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{/g
const INCLUDE = /\\(?:input|include|subfile)\s*\{([^}]+)\}/g
const MAX_DEPTH = 12

// { から対応する } までの中身（行をまたいでもよい）
function readBraced(text: string, open: number): string {
  let depth = 0
  for (let i = open; i < Math.min(text.length, open + 600); i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i)
  }
  return text.slice(open + 1, open + 80)
}

// 見出しに出すときは命令を外して中身だけにする（\emph{x} → x）
function plainTitle(title: string): string {
  return title
    .replace(/\\(?:label|index|footnote)\s*\{[^}]*\}/g, '')
    .replace(/\\[a-zA-Z@]+\*?\s*/g, '')
    .replace(/[{}~]/g, (c) => (c === '~' ? ' ' : ''))
    .replace(/\s+/g, ' ')
    .trim()
}

export function outline(project: Project, root: string): Heading[] {
  const out: Heading[] = []
  const seen = new Set<string>()
  const walk = (file: string, depth: number): void => {
    const text = project.text(file)
    if (text === null || seen.has(file) || depth > MAX_DEPTH) return
    seen.add(file)
    const lines = text.split('\n')
    // 行ごとの開始位置（行をまたぐ題名を読むため）
    let offset = 0
    lines.forEach((raw, i) => {
      const start = offset
      offset += raw.length + 1
      const line = stripComment(raw)
      if (!line.includes('\\')) return
      const events: { at: number; run: () => void }[] = []
      for (const m of line.matchAll(HEADING)) {
        const at = m.index ?? 0
        events.push({
          at,
          run: () => out.push({ level: HEADING_LEVELS[m[1]], title: plainTitle(readBraced(text, start + at + m[0].length - 1)), file, line: i + 1 })
        })
      }
      for (const m of line.matchAll(INCLUDE)) {
        const target = project.resolveInclude(root, m[1].trim())
        if (target) events.push({ at: m.index ?? 0, run: () => walk(target, depth + 1) })
      }
      events.sort((a, b) => a.at - b.at).forEach((e) => e.run())
    })
  }
  walk(root, 0)
  return out
}

// 本体から読み込まれるファイル（本体を含む）
export function documentFiles(project: Project, root: string): string[] {
  const files: string[] = []
  const walk = (file: string, depth: number): void => {
    const text = project.text(file)
    if (text === null || files.includes(file) || depth > MAX_DEPTH) return
    files.push(file)
    for (const raw of text.split('\n')) {
      const line = stripComment(raw)
      if (!line.includes('\\')) continue
      for (const m of line.matchAll(INCLUDE)) {
        const target = project.resolveInclude(root, m[1].trim())
        if (target) walk(target, depth + 1)
      }
    }
  }
  walk(root, 0)
  return files
}
