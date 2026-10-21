import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { app } from 'electron'

export type Engine = 'lualatex' | 'uplatex' | 'xelatex' | 'pdflatex'

export interface Diagnostic {
  file: string | null
  line: number | null
  severity: 'error' | 'warning' | 'info'
  message: string
}

export interface BuildResult {
  ok: boolean
  root: string
  pdf: string | null
  engine: string
  durationMs: number
  diagnostics: Diagnostic[]
  output: string
}

export interface SyncBox {
  page: number
  x: number
  y: number
  width: number
  height: number
}

const RC_NAMES = ['.latexmkrc', 'latexmkrc']
const PDF_MODE_LABEL: Record<string, string> = {
  '1': 'pdfLaTeX',
  '3': 'pLaTeX 系',
  '4': 'LuaLaTeX',
  '5': 'XeLaTeX'
}

// TeX のログは既定で 79 字ごとに折り返され、パスやメッセージが途中で切れる。
// 折り返しを無くしておくと、ログを 1 行ずつ素直に読める。
const TEX_ENV = { max_print_line: '10000', error_line: '254', half_error_line: '238' }

export function hasDocumentClass(src: string): boolean {
  return /^[^%\n]*\\documentclass/m.test(src)
}

export function detectEngine(src: string): Engine {
  const head = src.slice(0, 6000)
  if (/\\documentclass(\[[^\]]*\])?\{ltjs|luatexja|\\directlua/.test(head)) return 'lualatex'
  if (/\\documentclass\[[^\]]*uplatex/.test(head)) return 'uplatex'
  if (/\\documentclass(\[[^\]]*\])?\{(js|u?t?j)(article|book|report)\}/.test(head)) return 'uplatex'
  if (/fontspec|xeCJK|\[[^\]]*xelatex/.test(head)) return 'xelatex'
  if (/[぀-ヿ一-鿿]/.test(src)) return 'lualatex'
  return 'pdflatex'
}

function engineArgs(engine: Engine): string[] {
  switch (engine) {
    case 'lualatex':
      return ['-lualatex']
    case 'xelatex':
      return ['-xelatex']
    case 'pdflatex':
      return ['-pdf']
    case 'uplatex':
      return ['-pdfdvi', '-latex=uplatex', '-bibtex=upbibtex', '-e', "$dvipdf='dvipdfmx %O -o %D %S'"]
  }
}

const ENGINE_LABEL: Record<Engine, string> = {
  lualatex: 'LuaLaTeX',
  uplatex: 'upLaTeX',
  xelatex: 'XeLaTeX',
  pdflatex: 'pdfLaTeX'
}

async function rcLabel(dir: string): Promise<string | null> {
  for (const name of RC_NAMES) {
    const path = join(dir, name)
    if (!existsSync(path)) continue
    const rc = await readFile(path, 'utf8')
    const mode = rc.match(/^\s*\$pdf_mode\s*=\s*(\d)/m)?.[1]
    return (mode && PDF_MODE_LABEL[mode]) ?? 'latexmkrc'
  }
  return null
}

// .latexmkrc が無いフォルダの中間ファイルは、ユーザーのフォルダを汚さないようキャッシュへ出す。
function cacheDir(root: string): string {
  const hash = createHash('sha1').update(root).digest('hex').slice(0, 12)
  return join(app.getPath('userData'), 'build', `${basename(root, '.tex')}-${hash}`)
}

// 各本体が読み込んだファイル（.fls の記録）。部品ファイルを保存したときに、どの本体を組み直すかを決める。
const dependencies = new Map<string, Set<string>>()

async function recordDependencies(root: string, auxDir: string): Promise<void> {
  const fls = join(auxDir, basename(root, '.tex') + '.fls')
  if (!existsSync(fls)) return
  const text = await readFile(fls, 'utf8')
  const pwd = text.match(/^PWD (.+)$/m)?.[1] ?? dirname(root)
  const deps = new Set<string>()
  for (const m of text.matchAll(/^INPUT (.+)$/gm)) {
    const path = resolve(pwd, m[1])
    if (!path.includes('/texmf-dist/') && !path.includes('/texmf-var/')) deps.add(path)
  }
  dependencies.set(root, deps)
}

export async function resolveRoot(file: string, current: string | null, projectFiles: string[]): Promise<string | null> {
  const src = await readFile(file, 'utf8')
  const magic = src.match(/^%\s*!TE?X\s+root\s*=\s*(.+)$/im)
  if (magic) return resolve(dirname(file), magic[1].trim())
  if (hasDocumentClass(src)) return file

  if (current && dependencies.get(current)?.has(file)) return current
  for (const [root, deps] of dependencies) if (deps.has(file)) return root

  // まだ一度も組んでいないとき: \input / \include でこのファイルを読む本体を探す。
  const name = basename(file, '.tex').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const includes = new RegExp(`\\\\(input|include|subfile)\\{[^}]*\\b${name}(\\.tex)?\\}`)
  const candidates = projectFiles
    .filter((p) => extname(p) === '.tex' && p !== file)
    .sort((a, b) => Number(dirname(b) === dirname(file)) - Number(dirname(a) === dirname(file)))
  for (const candidate of candidates) {
    const text = await readFile(candidate, 'utf8').catch(() => '')
    if (hasDocumentClass(text) && includes.test(text)) return candidate
  }
  return null
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...TEX_ENV } })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      done({ code: -1, output: output + String(err) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      done({ code, output })
    })
  })
}

export async function build(root: string): Promise<BuildResult> {
  const started = Date.now()
  const cwd = dirname(root)
  const src = await readFile(root, 'utf8')
  const rc = await rcLabel(cwd)
  const engine = detectEngine(src)

  const args = ['-interaction=nonstopmode', '-file-line-error', '-synctex=1', '-dir-report']
  if (!rc) args.push(...engineArgs(engine), `-outdir=${cacheDir(root)}`)
  args.push(basename(root))

  const { code, output } = await run('latexmk', args, cwd, 180_000)
  const dirs = output.match(/Normalized aux dir, out dir, out2 dir:\s*\n\s*'([^']*)', '([^']*)', '([^']*)'/)
  const [auxDir, outDir, out2Dir] = dirs ? [dirs[1], dirs[2], dirs[3]] : [cwd, cwd, cwd]
  const base = basename(root, '.tex')
  const pdf = [outDir, out2Dir, auxDir].map((d) => join(resolve(cwd, d), base + '.pdf')).find(existsSync) ?? null

  const logPath = join(resolve(cwd, auxDir), base + '.log')
  const log = existsSync(logPath) ? await readFile(logPath, 'utf8') : ''
  const diagnostics = parseLog(log, cwd, root)
  if (code !== 0 && !diagnostics.some((d) => d.severity === 'error')) {
    const tail = output.trim().split('\n').slice(-6).join('\n')
    diagnostics.unshift({ file: null, line: null, severity: 'error', message: code === -1 ? `latexmk を起動できません: ${tail}` : tail })
  }
  await recordDependencies(root, resolve(cwd, auxDir))

  return {
    ok: code === 0,
    root,
    pdf,
    engine: rc ?? ENGINE_LABEL[engine],
    durationMs: Date.now() - started,
    diagnostics,
    output
  }
}

const SOURCE_EXT = /\.(tex|sty|cls|bib|bbl|ltx|dtx|def|cfg)$/

// ログの "(" と ")" を追い、いま読まれているファイルを推定する（警告の出どころを知るため）。
function* walkLog(log: string, cwd: string): Generator<{ text: string; file: string | null }> {
  const stack: (string | null)[] = []
  for (const text of log.split('\n')) {
    yield { text, file: [...stack].reverse().find((f) => f !== null) ?? null }
    for (const m of text.matchAll(/\((\.{0,2}\/[^\s()]+|[^\s()/]+\.(?:tex|sty|cls|bbl))|\)/g)) {
      if (m[0] === ')') stack.pop()
      else {
        const path = resolve(cwd, m[1])
        stack.push(SOURCE_EXT.test(path) && !path.includes('/texmf-dist/') ? path : null)
      }
    }
  }
}

export function parseLog(log: string, cwd: string, root: string): Diagnostic[] {
  const out: Diagnostic[] = []
  const lines = log.split('\n')
  const seen = new Set<string>()
  const push = (d: Diagnostic): void => {
    const key = `${d.file}:${d.line}:${d.message}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(d)
  }

  let i = 0
  for (const { text, file } of walkLog(log, cwd)) {
    const err = text.match(/^(.+?\.(?:tex|sty|cls|bib|ltx)):(\d+): (.+)$/)
    if (err) {
      push({ file: resolve(cwd, err[1]), line: Number(err[2]), severity: 'error', message: err[3] })
    } else if (text.startsWith('! ')) {
      const at = lines.slice(i, i + 12).join('\n').match(/^l\.(\d+)/m)
      push({ file: file ?? root, line: at ? Number(at[1]) : null, severity: 'error', message: text.slice(2) })
    } else {
      const warn = text.match(/^(?:LaTeX|Package (\S+)|Class (\S+)) Warning: (.*)$/)
      if (warn) {
        let message = warn[3]
        for (let j = i + 1; j < lines.length && /^\(\S+\)\s/.test(lines[j]); j++) message += ' ' + lines[j].replace(/^\(\S+\)\s+/, '')
        const at = message.match(/on input line (\d+)/)
        const source = warn[1] ?? warn[2]
        // 行番号の無い警告（フォントの拡大率の報告など）はたいてい直す必要がないので、情報として扱う。
        push({
          file: at ? (file ?? root) : null,
          line: at ? Number(at[1]) : null,
          severity: at ? 'warning' : 'info',
          message: (source ? `[${source}] ` : '') + message.replace(/\s*on input line \d+\.?/, '')
        })
      }
      const box = text.match(/^(Overfull|Underfull) \\[hv]box \((.+?)\).*?lines? (\d+)/)
      if (box && box[1] === 'Overfull') {
        push({ file: file ?? root, line: Number(box[3]), severity: 'info', message: `はみ出し (${box[2]})` })
      }
    }
    i++
  }
  if (/^No pages of output\./m.test(log)) push({ file: root, line: null, severity: 'error', message: 'PDF が 1 ページも出力されませんでした' })

  const rank = { error: 0, warning: 1, info: 2 }
  return out.sort((a, b) => rank[a.severity] - rank[b.severity])
}

function parseFields(text: string): Record<string, string>[] {
  const records: Record<string, string>[] = []
  let current: Record<string, string> | null = null
  for (const line of text.split('\n')) {
    const m = line.match(/^(\w+):(.*)$/)
    if (!m) continue
    if (m[1] === 'Output') {
      current = {}
      records.push(current)
    } else if (current && !(m[1] in current)) current[m[1]] = m[2]
  }
  return records
}

export async function forwardSync(pdf: string, file: string, line: number, column: number): Promise<SyncBox | null> {
  const { code, output } = await run('synctex', ['view', '-i', `${line}:${column}:${file}`, '-o', pdf], dirname(pdf), 10_000)
  if (code !== 0) return null
  const r = parseFields(output).find((r) => r.Page)
  if (!r) return null
  const width = Number(r.W)
  const height = Number(r.H)
  return { page: Number(r.Page), x: Number(r.h), y: Number(r.v) - height, width, height }
}

export async function backwardSync(pdf: string, page: number, x: number, y: number): Promise<{ file: string; line: number } | null> {
  const { code, output } = await run('synctex', ['edit', '-o', `${page}:${x}:${y}:${pdf}`], dirname(pdf), 10_000)
  if (code !== 0) return null
  const r = parseFields(output).find((r) => r.Input)
  if (!r || !r.Line) return null
  return { file: resolve(r.Input), line: Math.max(1, Number(r.Line)) }
}
