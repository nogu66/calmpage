import { readFile, stat, writeFile } from 'node:fs/promises'
import { buildPattern, findMatches, replaceAll, type SearchFile, type SearchOptions, type SearchResult } from '../shared/search'
import { isSource } from './files'

const MAX_MATCHES = 2000
const MAX_BYTES = 4 * 1024 * 1024

// 大きなフォルダでも main を塞がないよう、数ファイルごとにほかの仕事へ譲る
const yieldNow = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

async function readText(path: string): Promise<string | null> {
  const info = await stat(path).catch(() => null)
  if (!info || !info.isFile() || info.size > MAX_BYTES) return null
  const text = await readFile(path, 'utf8').catch(() => null)
  return text === null || text.includes('\0') ? null : text
}

// 開いているファイルは画面の内容（overrides）で探す。stale() が真になったら、新しい検索に譲って null を返す。
export async function searchFiles(
  files: string[],
  overrides: Record<string, string>,
  query: string,
  opts: SearchOptions,
  stale: () => boolean
): Promise<SearchResult | null> {
  const re = buildPattern(query, opts)
  const result: SearchResult = { files: [], total: 0, truncated: false }
  for (let i = 0; i < files.length; i++) {
    if (i % 16 === 0) {
      await yieldNow()
      if (stale()) return null
    }
    const path = files[i]
    if (!isSource(path)) continue
    const text = overrides[path] ?? (await readText(path))
    if (text === null) continue
    const matches = findMatches(text, re, MAX_MATCHES - result.total + 1)
    if (!matches.length) continue
    if (result.total + matches.length > MAX_MATCHES) {
      result.truncated = true
      matches.length = MAX_MATCHES - result.total
    }
    const file: SearchFile = { path, matches }
    result.files.push(file)
    result.total += matches.length
    if (result.truncated) break
  }
  return result
}

// 開いていないファイルを書き換える。onWrite で、書く前に見張りと履歴へ知らせる。
export async function replaceInFiles(
  files: string[],
  query: string,
  opts: SearchOptions,
  replacement: string,
  onWrite: (path: string, before: string, after: string) => void
): Promise<{ files: number; count: number }> {
  const re = buildPattern(query, opts)
  let changed = 0
  let count = 0
  for (let i = 0; i < files.length; i++) {
    if (i % 16 === 0) await yieldNow()
    const path = files[i]
    if (!isSource(path)) continue
    const text = await readText(path)
    if (text === null) continue
    const next = replaceAll(text, re, replacement, opts.regex)
    if (!next.count) continue
    onWrite(path, text, next.text)
    await writeFile(path, next.text, 'utf8')
    changed++
    count += next.count
  }
  return { files: changed, count }
}
