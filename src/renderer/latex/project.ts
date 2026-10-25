import { stripComment } from './language'

// プロジェクトの .tex と .bib を読んでおき、補完・アウトライン・文字数で使う。
// 開いているファイルは、保存前でもエディターの最新の内容を使う。

export interface Label {
  name: string
  file: string
  line: number
}

export interface BibEntry {
  key: string
  type: string
  title: string
  author: string
  year: string
  file: string
}

export interface Definition {
  name: string
  args: number
  kind: 'command' | 'environment'
}

export interface ProjectApi {
  listCompletionFiles: () => Promise<string[]>
  readFile: (path: string) => Promise<string>
}

interface Parsed {
  text: string
  labels: Label[]
  definitions: Definition[]
  bib: BibEntry[]
}

const TEXT_FILE = /\.(tex|bib|sty|cls|ltx|dtx)$/i
const LIST_TTL = 2000

export class Project {
  folder: string | null = null
  private files: string[] = []
  private listedAt = 0
  private listing: Promise<void> | null = null
  private disk = new Map<string, string>()
  private reading = new Map<string, Promise<string | null>>()
  private parsed = new Map<string, Parsed>()

  constructor(
    private api: ProjectApi,
    private live: (path: string) => string | null
  ) {}

  setFolder(folder: string | null): void {
    this.folder = folder
    this.files = []
    this.listedAt = 0
    this.disk.clear()
    this.parsed.clear()
  }

  // 外で書き換わったファイル。新しいファイルなら一覧も読み直す
  fileChanged(path: string, content: string): void {
    this.disk.set(path, content)
    if (!this.files.includes(path)) this.listedAt = 0
  }

  async list(force = false): Promise<string[]> {
    if (!this.folder) return []
    if (force || Date.now() - this.listedAt > LIST_TTL) {
      this.listing ??= this.api
        .listCompletionFiles()
        .then((files) => {
          this.files = files
          this.listedAt = Date.now()
        })
        .catch(() => {})
        .finally(() => (this.listing = null))
      await this.listing
    }
    return this.files
  }

  // 一覧にあるテキストのファイルを、まだなら読む
  async load(): Promise<void> {
    const files = (await this.list()).filter((f) => TEXT_FILE.test(f))
    await Promise.all(files.map((f) => this.read(f)))
  }

  private read(path: string): Promise<string | null> {
    if (this.disk.has(path)) return Promise.resolve(this.disk.get(path) as string)
    let p = this.reading.get(path)
    if (!p) {
      p = this.api
        .readFile(path)
        .then((text) => {
          this.disk.set(path, text)
          return text
        })
        .catch(() => null)
        .finally(() => this.reading.delete(path))
      this.reading.set(path, p)
    }
    return p
  }

  // 今の内容（読み込んでいなければ null）
  text(path: string): string | null {
    return this.live(path) ?? this.disk.get(path) ?? null
  }

  async textAsync(path: string): Promise<string | null> {
    return this.live(path) ?? (await this.read(path))
  }

  private parse(path: string): Parsed | null {
    const text = this.text(path)
    if (text === null) return null
    const cached = this.parsed.get(path)
    if (cached && cached.text === text) return cached
    const next = path.endsWith('.bib')
      ? { text, labels: [], definitions: [], bib: parseBib(text, path) }
      : { text, labels: findLabels(text, path), definitions: findDefinitions(text), bib: [] }
    this.parsed.set(path, next)
    return next
  }

  private texFiles(): string[] {
    return this.files.filter((f) => /\.(tex|sty|cls|ltx)$/i.test(f))
  }

  labels(): Label[] {
    return this.texFiles().flatMap((f) => this.parse(f)?.labels ?? [])
  }

  definitions(): Definition[] {
    return this.texFiles().flatMap((f) => this.parse(f)?.definitions ?? [])
  }

  bibEntries(): BibEntry[] {
    return this.files.filter((f) => f.endsWith('.bib')).flatMap((f) => this.parse(f)?.bib ?? [])
  }

  allFiles(): string[] {
    return this.files
  }

  // \input や \include で読み込むファイルのパスを、本体のあるフォルダから探す
  resolveInclude(root: string, name: string, ext = '.tex'): string | null {
    const base = dirName(root)
    const candidates = [name, name + ext].map((n) => normalize(n.startsWith('/') ? n : `${base}/${n}`))
    return candidates.find((c) => this.files.includes(c)) ?? null
  }
}

function findLabels(text: string, file: string): Label[] {
  const labels: Label[] = []
  const lines = text.split('\n')
  lines.forEach((raw, i) => {
    const line = stripComment(raw)
    if (!line.includes('\\label')) return
    for (const m of line.matchAll(/\\label\s*\{([^}]+)\}/g)) labels.push({ name: m[1].trim(), file, line: i + 1 })
  })
  return labels
}

function findDefinitions(text: string): Definition[] {
  const defs: Definition[] = []
  const body = text
    .split('\n')
    .map(stripComment)
    .join('\n')
  const command = /\\(?:newcommand|renewcommand|providecommand|DeclareRobustCommand|NewDocumentCommand|RenewDocumentCommand|DeclareMathOperator)\*?\s*\{?\s*\\([a-zA-Z@]+)\s*\}?\s*(?:\[(\d)\])?/g
  for (const m of body.matchAll(command)) defs.push({ name: m[1], args: m[2] ? Number(m[2]) : 0, kind: 'command' })
  for (const m of body.matchAll(/\\(?:def|let)\s*\\([a-zA-Z@]+)/g)) defs.push({ name: m[1], args: 0, kind: 'command' })
  for (const m of body.matchAll(/\\(?:newenvironment|renewenvironment|NewDocumentEnvironment|newtheorem)\*?\s*\{([^}]+)\}/g)) {
    defs.push({ name: m[1].trim(), args: 0, kind: 'environment' })
  }
  return defs
}

// .bib の項目を、鍵と題名・著者・年だけ読む。値の { } は入れ子にできる
function parseBib(text: string, file: string): BibEntry[] {
  const entries: BibEntry[] = []
  const re = /@(\w+)\s*[{(]\s*([^,\s]+)\s*,/g
  for (let m; (m = re.exec(text)); ) {
    const type = m[1].toLowerCase()
    if (type === 'comment' || type === 'string' || type === 'preamble') continue
    const end = text.indexOf('\n@', re.lastIndex)
    const body = text.slice(re.lastIndex, end < 0 ? undefined : end)
    entries.push({ key: m[2], type, title: field(body, 'title'), author: field(body, 'author'), year: field(body, 'year') || field(body, 'date').slice(0, 4), file })
  }
  return entries
}

function field(body: string, name: string): string {
  const m = new RegExp(`(?:^|[,\\s])${name}\\s*=\\s*`, 'i').exec(body)
  if (!m) return ''
  let i = m.index + m[0].length
  const open = body[i]
  let value = ''
  if (open === '{' || open === '"') {
    let depth = 0
    for (; i < body.length; i++) {
      const ch = body[i]
      if (ch === '{') depth++
      else if (ch === '}') depth--
      if ((open === '{' && depth === 0 && ch === '}') || (open === '"' && ch === '"' && depth === 0 && value)) break
      value += ch
    }
    value = value.slice(1)
  } else {
    value = /^[^,}\n]*/.exec(body.slice(i))![0]
  }
  return value.replace(/[{}]/g, '').replace(/\s+/g, ' ').trim()
}

export function dirName(path: string): string {
  return path.slice(0, path.lastIndexOf('/')) || '/'
}

export function normalize(path: string): string {
  const out: string[] = []
  for (const part of path.split('/')) {
    if (part === '..') out.pop()
    else if (part !== '.' && part !== '') out.push(part)
  }
  return '/' + out.join('/')
}

// from（フォルダ）から to への相対パス
export function relativePath(from: string, to: string): string {
  const a = normalize(from).split('/').filter(Boolean)
  const b = normalize(to).split('/').filter(Boolean)
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/')
}
