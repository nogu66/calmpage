import { watch, type FSWatcher } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'

const SOURCE = /\.(tex|bib|cls|sty|bst)$|^\.?latexmkrc$/
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'build', 'release', 'Library', '_minted'])
const MAX_FILES = 2000

export function isSource(path: string): boolean {
  return SOURCE.test(basename(path))
}

export async function listProjectFiles(folder: string): Promise<string[]> {
  const found: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 8 || found.length >= MAX_FILES) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && !SKIP_DIRS.has(entry.name)) await walk(join(dir, entry.name), depth + 1)
      } else if (isSource(entry.name)) {
        found.push(join(dir, entry.name))
      }
    }
  }
  await walk(folder, 0)
  return found.sort((a, b) => a.localeCompare(b))
}

// 外部（ほかのエディターや AI エージェント）による変更を知らせる。自分で書いた内容と同じなら知らせない。
export class FolderWatcher {
  private watcher: FSWatcher | null = null
  private timers = new Map<string, NodeJS.Timeout>()
  private written = new Map<string, string>()

  constructor(private onChange: (path: string, content: string) => void) {}

  noteWrite(path: string, content: string): void {
    this.written.set(path, content)
  }

  watch(folder: string): void {
    this.close()
    this.watcher = watch(folder, { recursive: true }, (_event, name) => {
      if (!name) return
      const path = join(folder, name.toString())
      const rel = relative(folder, path)
      if (!isSource(path) || rel.split(sep).some((part) => SKIP_DIRS.has(part) || part.startsWith('.git'))) return
      clearTimeout(this.timers.get(path))
      this.timers.set(
        path,
        setTimeout(async () => {
          this.timers.delete(path)
          const content = await readFile(path, 'utf8').catch(() => null)
          if (content === null || content === this.written.get(path)) return
          this.written.set(path, content)
          this.onChange(path, content)
        }, 150)
      )
    })
  }

  close(): void {
    this.watcher?.close()
    this.watcher = null
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }
}
