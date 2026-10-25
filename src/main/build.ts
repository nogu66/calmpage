import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { app } from 'electron'
import { t, type Key } from '../shared/i18n'
import { loadSettings } from './settings'

export type Engine = 'lualatex' | 'uplatex' | 'platex' | 'xelatex' | 'pdflatex'

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
  logPath: string | null
  cancelled: boolean
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

function tr(key: Key, params?: Record<string, string>): string {
  return t(loadSettings().language, key, params)
}

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
    case 'platex':
      return ['-pdfdvi', '-latex=platex', '-bibtex=pbibtex', '-e', "$dvipdf='dvipdfmx %O -o %D %S'"]
  }
}

// TeXShop・TeXworks の「% !TEX program = xelatex」「% !TEX TS-program = xelatex」。処理系の名前だけを見る。
const PROGRAMS: Record<string, Engine> = { pdflatex: 'pdflatex', xelatex: 'xelatex', lualatex: 'lualatex', uplatex: 'uplatex', platex: 'platex' }

export function magicEngine(src: string): Engine | null {
  const m = src.slice(0, 6000).match(/^%\s*!TE?X\s+(?:TS-)?program\s*=\s*([\w-]+)/im)
  return m ? (PROGRAMS[m[1].toLowerCase()] ?? null) : null
}

const ENGINE_LABEL: Record<Engine, string> = {
  lualatex: 'LuaLaTeX',
  uplatex: 'upLaTeX',
  platex: 'pLaTeX',
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

// 各本体が読み込んだファイル（.fls と .fdb_latexmk の記録）。部品ファイルを保存したときに、どの本体を組み直すかを決める。
const dependencies = new Map<string, Set<string>>()

const inTexTree = (path: string): boolean => path.includes('/texmf-dist/') || path.includes('/texmf-var/')

async function recordDependencies(root: string, auxDir: string): Promise<void> {
  const cwd = dirname(root)
  const base = basename(root, '.tex')
  const deps = new Set<string>()
  const add = (path: string): void => {
    if (!inTexTree(path)) deps.add(path)
  }
  const fls = join(auxDir, base + '.fls')
  if (existsSync(fls)) {
    const text = await readFile(fls, 'utf8')
    // PWD は実体のパス（/private/var/…）なので、開いたフォルダのパスに読み替える
    const pwd = text.match(/^PWD (.+)$/m)?.[1] ?? cwd
    for (const m of text.matchAll(/^INPUT (.+)$/gm)) add(m[1].startsWith(pwd + '/') ? join(cwd, m[1].slice(pwd.length + 1)) : resolve(cwd, m[1]))
  }
  // .bib や .bst は bibtex / biber が読むので .fls に載らない。latexmk の記録には規則ごとの入力として載る
  const fdb = join(auxDir, base + '.fdb_latexmk')
  if (existsSync(fdb)) {
    const text = await readFile(fdb, 'utf8')
    for (const m of text.matchAll(/^\s+"([^"]+)" [\d.]+ -?\d+ \w+ "[^"]*"$/gm)) add(resolve(cwd, m[1]))
  }
  if (deps.size) dependencies.set(root, deps)
}

export async function resolveRoot(file: string, current: string | null, projectFiles: string[], depth = 0): Promise<string | null> {
  const src = await readFile(file, 'utf8')
  const magic = src.match(/^%\s*!TE?X\s+root\s*=\s*(.+)$/im)
  if (magic) return resolve(dirname(file), magic[1].trim())
  if (hasDocumentClass(src)) return file

  if (current && dependencies.get(current)?.has(file)) return current
  for (const [root, deps] of dependencies) if (deps.has(file)) return root

  // まだ一度も組んでいないとき: このファイルを読み込む書類を探す（.tex は \input、.bib は \bibliography など）。
  // 見つけた書類が部品なら、その本体をたどる
  const ext = extname(file)
  const pattern = readers(basename(file, ext), ext)
  const candidates = projectFiles
    .filter((p) => extname(p) === '.tex' && p !== file)
    .sort((a, b) => Number(dirname(b) === dirname(file)) - Number(dirname(a) === dirname(file)))
  let via: string | null = null
  for (const candidate of pattern ? candidates : []) {
    const text = await readFile(candidate, 'utf8').catch(() => '')
    if (!pattern?.test(text)) continue
    if (hasDocumentClass(text)) return candidate
    via ??= candidate
  }
  if (via && depth < 3) {
    const root = await resolveRoot(via, current, projectFiles, depth + 1)
    if (root) return root
  }
  // .bib・.sty・画像などの部品で読み手が分からなければ、いま組んでいる本体のものとみなす
  return ext !== '.tex' ? current : null
}

function readers(name: string, ext: string): RegExp | null {
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const opt = '(\\[[^\\]]*\\])?'
  switch (ext) {
    case '.tex':
      return new RegExp(`\\\\(input|include|subfile)\\{[^}]*\\b${n}(\\.tex)?\\}`)
    case '.bib':
      return new RegExp(`\\\\(bibliography|addbibresource|addglobalbib|addsectionbib)${opt}\\{([^}]*[,/])?\\s*${n}(\\.bib)?\\s*[,}]`)
    case '.bst':
      return new RegExp(`\\\\bibliographystyle\\{([^}]*/)?${n}\\}`)
    case '.sty':
      return new RegExp(`\\\\(usepackage|RequirePackage)${opt}\\{([^}]*[,/])?\\s*${n}\\s*[,}]`)
    case '.cls':
      return new RegExp(`\\\\documentclass${opt}\\{([^}]*/)?${n}\\}`)
  }
  return null
}

// latexmk は pdflatex や bibtex を子として起こすので、プロセスグループごと止める（detached で自分がグループの頭になる）
function killGroup(child: ChildProcess): void {
  const kill = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid) process.kill(-child.pid, signal)
    } catch {
      // もう終わっている
    }
  }
  kill('SIGTERM')
  setTimeout(() => kill('SIGKILL'), 2000).unref()
}

function run(cmd: string, args: string[], cwd: string, timeoutMs: number, signal?: AbortSignal): Promise<{ code: number | null; output: string }> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...TEX_ENV }, detached: true })
    let output = ''
    child.stdout.on('data', (d) => (output += d))
    child.stderr.on('data', (d) => (output += d))
    const stop = (): void => killGroup(child)
    const timer = setTimeout(stop, timeoutMs)
    signal?.addEventListener('abort', stop, { once: true })
    const finish = (code: number | null, extra = ''): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', stop)
      done({ code, output: output + extra })
    }
    child.on('error', (err) => finish(-1, String(err)))
    child.on('close', (code) => finish(code))
  })
}

// 処理系の決め方: 書類の「% !TEX program」→ .latexmkrc → 設定の既定 → 中身から推測。
// 書類に書いた指定がいちばん具体的なので、フォルダ全体の .latexmkrc より先に見る。
async function latexmkArgs(root: string): Promise<{ args: string[]; rc: string | null; label: string }> {
  const src = await readFile(root, 'utf8')
  const rc = await rcLabel(dirname(root))
  const setting = loadSettings().engine
  const engine = magicEngine(src) ?? (rc ? null : setting !== 'auto' ? setting : detectEngine(src))
  const args = engine ? engineArgs(engine) : []
  if (!rc) args.push(`-outdir=${cacheDir(root)}`)
  return { args, rc, label: engine ? ENGINE_LABEL[engine] : (rc ?? '') }
}

// 処理系や -shell-escape を替えても、latexmk は元の書類が同じなら組み直さない。前回と違えば -g で組み直させる
const lastArgs = new Map<string, string>()

export async function build(root: string, signal?: AbortSignal): Promise<BuildResult> {
  const started = Date.now()
  const cwd = dirname(root)
  const { args: engineOpts, label } = await latexmkArgs(root)

  const args = ['-interaction=nonstopmode', '-file-line-error', '-synctex=1', '-dir-report', ...engineOpts]
  if (loadSettings().shellEscape) args.push('-shell-escape')
  const key = args.join(' ')
  if (lastArgs.has(root) && lastArgs.get(root) !== key) args.push('-g')
  args.push(basename(root))

  const { code, output } = await run('latexmk', args, cwd, 180_000, signal)
  const base = basename(root, '.tex')
  if (signal?.aborted) {
    return { ok: false, root, pdf: null, engine: label, durationMs: Date.now() - started, diagnostics: [], output, logPath: null, cancelled: true }
  }
  const dirs = output.match(/Normalized aux dir, out dir, out2 dir:\s*\n\s*'([^']*)', '([^']*)', '([^']*)'/)
  const [auxDir, outDir, out2Dir] = dirs ? [dirs[1], dirs[2], dirs[3]] : [cwd, cwd, cwd]
  const pdf = [outDir, out2Dir, auxDir].map((d) => join(resolve(cwd, d), base + '.pdf')).find(existsSync) ?? null

  const aux = resolve(cwd, auxDir)
  const logPath = join(aux, base + '.log')
  const log = existsSync(logPath) ? await readFile(logPath, 'utf8') : ''
  await recordDependencies(root, aux)
  const latex = parseLog(log, cwd, root)
  const diagnostics = sortDiagnostics([...latex, ...(await readBibLog(aux, base, root, latex))])
  if (code !== 0 && !diagnostics.some((d) => d.severity === 'error')) {
    const tail = output.trim().split('\n').slice(-6).join('\n')
    diagnostics.unshift({ file: null, line: null, severity: 'error', message: code === -1 ? tr('build.noLatexmk', { detail: tail }) : tail })
  }
  lastArgs.set(root, key)

  return {
    ok: code === 0,
    root,
    pdf,
    engine: label,
    durationMs: Date.now() - started,
    diagnostics,
    output,
    logPath: existsSync(logPath) ? logPath : null,
    cancelled: false
  }
}

// 中間ファイルを消す。組むときと同じ出力先・処理系で latexmk -c を走らせるので、.latexmkrc の $out_dir などにも従う。
// PDF と .synctex.gz は残す（プレビューと SyncTeX を使い続けられるように）。.bbl は .bib があるときだけ消す（$bibtex_use = 1.5）。
export async function clean(root: string): Promise<boolean> {
  const { args, rc } = await latexmkArgs(root)
  const { code } = await run('latexmk', ['-c', '-e', '$bibtex_use=1.5', ...args, basename(root)], dirname(root), 60_000)
  // minted のキャッシュ（_minted、v2 は _minted-本体名）は latexmk が知らないので、自分の出力先にあるものだけ消す
  if (!rc) {
    for (const name of ['_minted', `_minted-${basename(root, '.tex')}`]) await rm(join(cacheDir(root), name), { recursive: true, force: true })
  }
  lastArgs.delete(root)
  return code === 0
}

const SOURCE_EXT = /\.(tex|sty|cls|bib|bbl|ltx|dtx|def|cfg)$/

// ログの "(" と ")" を追い、いま読まれているファイルを推定する（警告の出どころを知るため）。
function* walkLog(log: string, cwd: string): Generator<{ text: string; file: string | null }> {
  const stack: (string | null)[] = []
  for (const text of log.split('\n')) {
    yield { text, file: [...stack].reverse().find((f) => f !== null) ?? null }
    // はみ出した箱の中身（「[]」で始まる行）は本文の文字なので、括弧を数えない
    if (text.startsWith('[]')) continue
    // ファイルでない括弧（「(Font)」など）も積んでおく。閉じ括弧だけ数えると、読んでいるファイルを取り違える
    for (const m of text.matchAll(/\(([^\s()]*)|\)/g)) {
      if (m[0] === ')') stack.pop()
      else if (/^(\.{0,2}\/\S+|[^/]+\.(tex|sty|cls|bbl))$/.test(m[1])) {
        const path = resolve(cwd, m[1])
        stack.push(SOURCE_EXT.test(path) && !path.includes('/texmf-dist/') ? path : null)
      } else stack.push(null)
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
        push({ file: file ?? root, line: Number(box[3]), severity: 'info', message: tr('build.overfull', { amount: box[2] }) })
      }
    }
    i++
  }
  if (/^No pages of output\./m.test(log)) push({ file: root, line: null, severity: 'error', message: tr('build.noPages') })

  return sortDiagnostics(out)
}

function sortDiagnostics(list: Diagnostic[]): Diagnostic[] {
  const rank = { error: 0, warning: 1, info: 2 }
  return list.sort((a, b) => rank[a.severity] - rank[b.severity])
}

// BibTeX と Biber の記録（.blg）。今の書類で文献の処理が動いたとき（latexmk の記録に規則があるとき）だけ読む。
async function readBibLog(auxDir: string, base: string, root: string, latex: Diagnostic[]): Promise<Diagnostic[]> {
  const fdb = join(auxDir, base + '.fdb_latexmk')
  const blg = join(auxDir, base + '.blg')
  if (!existsSync(fdb) || !existsSync(blg)) return []
  if (!/^\["(bibtex|biber) /m.test(await readFile(fdb, 'utf8'))) return []
  const bibs: Record<string, string> = {}
  for (const p of dependencies.get(root) ?? []) if (p.endsWith('.bib')) bibs[p] = await readFile(p, 'utf8').catch(() => '')
  return parseBlg(await readFile(blg, 'utf8'), bibs, latex)
}

// bibs は .bib のパスと中身。行の書かれていない警告（「empty publisher in knuth」など）は、項目の書き出しの行に結び付ける
export function parseBlg(text: string, bibs: Record<string, string>, latex: Diagnostic[] = []): Diagnostic[] {
  const out: Diagnostic[] = []
  const bibFile = (name: string): string | null => Object.keys(bibs).find((p) => basename(p) === basename(name)) ?? null
  const entry = (message: string): { file: string | null; line: number | null } => {
    const key = message.match(/ in (\S+)$|entry '([^']+)'/i)
    const k = key?.[1] ?? key?.[2]
    if (!k) return { file: null, line: null }
    const head = new RegExp(`@\\w+\\s*[{(]\\s*${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*,`)
    for (const [file, src] of Object.entries(bibs)) {
      const i = src.split('\n').findIndex((l) => head.test(l))
      if (i >= 0) return { file, line: i + 1 }
    }
    return { file: null, line: null }
  }
  // 見つからない文献は LaTeX の「Citation … undefined」がソースの行付きで出しているので、重ねて出さない
  const known = (key: string): boolean => latex.some((d) => /Citation/.test(d.message) && d.message.includes(key))
  const lines = text.split('\n')
  // Biber は .bib を名前の無い一時ファイルに写して読むので、直前に「Found BibTeX data source」と出た .bib のこととみなす
  let source: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const found = line.match(/INFO - Found BibTeX data source '(.+)'$/)
    if (found) source = bibFile(found[1])
    const biber = line.match(/^\[\d+\] [\w:.]+> (WARN|ERROR) - (.+)$/)
    if (biber) {
      const missing = biber[2].match(/I didn't find a database entry for '([^']+)'/)
      if (missing && known(missing[1])) continue
      const at = biber[2].match(/\.utf8, line (\d+), /)
      const message = source ? biber[2].replace(/\S+\.utf8,/, `${basename(source)},`) : biber[2]
      const where = at && source ? { file: source, line: Number(at[1]) } : entry(message)
      out.push({ ...where, severity: biber[1] === 'ERROR' ? 'error' : 'warning', message: `[Biber] ${message}` })
      continue
    }
    const warn = line.match(/^Warning--(.+)$/)
    if (warn) {
      const missing = warn[1].match(/I didn't find a database entry for "([^"]+)"/)
      if (missing && known(missing[1])) continue
      const at = lines[i + 1]?.match(/^--line (\d+) of file (.+)$/)
      const where = at && bibFile(at[2]) ? { file: bibFile(at[2]), line: Number(at[1]) } : entry(warn[1])
      out.push({ ...where, severity: 'warning', message: `[BibTeX] ${warn[1]}` })
      continue
    }
    const err = line.match(/^(.+?)---line (\d+) of file (.+)$/)
    if (err) {
      const file = bibFile(err[3])
      out.push({ file, line: file ? Number(err[2]) : null, severity: 'error', message: `[BibTeX] ${err[1]}` })
      continue
    }
    // 「I couldn't open database file」など、ファイルの行に結び付かない誤り。\cite が 1 つもないだけなら警告にとどめる
    const fatal = line.match(/^(I couldn't open .+|I found no .+?)(?:---while reading file .+)?$/)
    if (fatal) out.push({ file: null, line: null, severity: /^I found no \\citation/.test(fatal[1]) ? 'warning' : 'error', message: `[BibTeX] ${fatal[1]}` })
  }
  return out
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
