import { watch, type FSWatcher } from 'node:fs'
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { isImage, isListed, isSource, isText } from '../shared/paths'

export { isSource } from '../shared/paths'

const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'release', 'Library', '_minted'])
const MAX_FILES = 2000
// 図を写すときに探すフォルダの名前（前にあるほど優先）
const IMAGE_DIRS = ['figures', 'figure', 'figs', 'fig', 'images', 'image', 'img', 'graphics']

export interface ProjectEntries {
  files: string[]
  // 何も入っていないフォルダ。作ったばかりのフォルダも一覧に出せるように返す
  emptyDirs: string[]
}

function skipped(name: string): boolean {
  return name.startsWith('.') || SKIP_DIRS.has(name)
}

export async function listProjectEntries(folder: string): Promise<ProjectEntries> {
  const files: string[] = []
  const emptyDirs: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8 || files.length >= MAX_FILES) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    if (depth > 0 && entries.every((e) => e.name.startsWith('.'))) emptyDirs.push(dir)
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipped(entry.name)) await walk(join(dir, entry.name), depth + 1)
      } else if (isListed(entry.name)) {
        files.push(join(dir, entry.name))
      }
    }
  }
  await walk(folder, 0)
  // 同じ名前の .tex がある PDF は組んだ結果（latexmkrc の出力先や standalone の図）なので、一覧には出さない
  const stems = new Set(files.filter((f) => extname(f) === '.tex').map((f) => basename(f, '.tex')))
  const shown = files.filter((f) => extname(f).toLowerCase() !== '.pdf' || !stems.has(basename(f, extname(f))))
  return { files: shown.sort((a, b) => a.localeCompare(b)), emptyDirs: emptyDirs.sort((a, b) => a.localeCompare(b)) }
}

export async function listProjectFiles(folder: string): Promise<string[]> {
  return (await listProjectEntries(folder)).files
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false
  )
}

// 同じ名前があれば「名前-2.拡張子」のように番号を付ける
async function freeName(dir: string, name: string): Promise<string> {
  const ext = extname(name)
  const stem = basename(name, ext)
  let path = join(dir, name)
  for (let i = 2; await exists(path); i++) path = join(dir, `${stem}-${i}${ext}`)
  return path
}

function checkName(name: string): void {
  if (!name || name.includes('/') || name === '.' || name === '..') throw new Error(`Invalid name: ${name}`)
}

export async function createFile(dir: string, name: string): Promise<string> {
  checkName(name)
  const path = join(dir, name)
  await mkdir(dir, { recursive: true })
  await writeFile(path, '', { flag: 'wx' })
  return path
}

export async function createFolder(dir: string, name: string): Promise<string> {
  checkName(name)
  const path = join(dir, name)
  await mkdir(path)
  return path
}

// 上書きはしない（同じ名前があれば失敗させる）
export async function renamePath(from: string, name: string): Promise<string> {
  checkName(name)
  const to = join(dirname(from), name)
  if (to === from) return to
  // 大文字小文字だけの変更は、macOS では同じものとして見つかるので確かめない
  if (to.toLowerCase() !== from.toLowerCase() && (await exists(to))) throw new Error(`${name} already exists`)
  await rename(from, to)
  return to
}

// 図を置くフォルダ: 名前で分かるものがあればそれを、なければ図が入っているフォルダを、どちらもなければ figures/ を使う
export async function imageFolder(folder: string): Promise<string> {
  const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name)
  for (const name of IMAGE_DIRS) {
    const found = dirs.find((d) => d.toLowerCase() === name)
    if (found) return join(folder, found)
  }
  const { files } = await listProjectEntries(folder)
  const withImage = files.find((f) => isImage(f) && dirname(f) !== folder)
  return withImage ? dirname(withImage) : join(folder, 'figures')
}

// プロジェクトの外のファイルを写す。中にあるならそのまま返す
export async function importFile(folder: string, src: string, dir?: string): Promise<string> {
  if (src.startsWith(folder + sep)) return src
  const target = dir ?? (isImage(src) ? await imageFolder(folder) : folder)
  await mkdir(target, { recursive: true })
  const path = await freeName(target, basename(src))
  await copyFile(src, path)
  return path
}

// ブラウザからのドラッグなど、パスのないデータを書き込む
export async function importData(folder: string, name: string, data: Uint8Array, dir?: string): Promise<string> {
  const safe = basename(name).replace(/[\\/:]/g, '-') || 'image.png'
  const target = dir ?? (isImage(safe) ? await imageFolder(folder) : folder)
  await mkdir(target, { recursive: true })
  const path = await freeName(target, safe)
  await writeFile(path, data, { flag: 'wx' })
  return path
}

// エディターの補完に使うファイル（\includegraphics の画像、\input の .tex、\cite の .bib など）
const COMPLETION = /\.(tex|bib|sty|cls|png|jpe?g|pdf|eps|svg)$/i

export async function listCompletionFiles(folder: string): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8 || found.length >= MAX_FILES) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name), depth + 1)
      } else if (COMPLETION.test(entry.name)) {
        found.push(join(dir, entry.name))
      }
    }
  }
  await walk(folder, 0)
  return found.sort((a, b) => a.localeCompare(b))
}

// 外部（ほかのエディターや AI エージェント）による変更を知らせる。自分で書いた内容と同じなら知らせない。
// テキストの書き換えは onChange（組み直すのはソースのときだけ）、ファイルやフォルダの増減は onList で知らせる。
export class FolderWatcher {
  private watcher: FSWatcher | null = null
  private timers = new Map<string, NodeJS.Timeout>()
  private listTimer: NodeJS.Timeout | undefined
  private written = new Map<string, string>()

  constructor(
    private onChange: (path: string, content: string, source: boolean) => void,
    private onList: () => void = () => {}
  ) {}

  noteWrite(path: string, content: string): void {
    this.written.set(path, content)
  }

  watch(folder: string): void {
    this.close()
    this.watcher = watch(folder, { recursive: true }, (event, name) => {
      if (!name) return
      const path = join(folder, name.toString())
      const rel = relative(folder, path)
      if (rel.split(sep).some((part) => SKIP_DIRS.has(part) || part.startsWith('.git'))) return
      // 増えた・消えた・名前が変わった。拡張子のないものはフォルダかもしれないので一覧を読み直す
      if (event === 'rename' && (isListed(path) || !extname(path))) {
        clearTimeout(this.listTimer)
        this.listTimer = setTimeout(() => this.onList(), 200)
      }
      if (!isText(path)) return
      clearTimeout(this.timers.get(path))
      this.timers.set(
        path,
        setTimeout(async () => {
          this.timers.delete(path)
          const content = await readFile(path, 'utf8').catch(() => null)
          if (content === null || content === this.written.get(path)) return
          this.written.set(path, content)
          this.onChange(path, content, isSource(path))
        }, 150)
      )
    })
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
    clearTimeout(this.listTimer)
  }
}
