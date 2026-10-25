import { Prec, type Extension } from '@codemirror/state'
import { EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import type { Key } from '../../shared/i18n'
import { completionSources } from './complete'
import { add, count, type Counts } from './count'
import { formatKeys } from './format'
import { latex, latexLanguage } from './language'
import { documentFiles, outline, type Heading } from './outline'
import { Project, type ProjectApi } from './project'
import { Spell, spellTheme, type SpellApi } from './spell'

export { runEditCommand } from './format'

// エディターの「書く支え」をまとめる: 補完・アウトライン・スペルチェック・文字数。
// 画面（main.ts）とは、この Writing だけでつながる。

export interface WritingDeps {
  api: ProjectApi & {
    spellMisspelled: SpellApi['misspelled']
    spellSuggestions: SpellApi['suggestions']
    spellMenu: SpellApi['menu']
  }
  tr: (key: Key, params?: Record<string, string | number>) => string
  // 開いているファイル・組んでいる本体・保存前の内容
  path: () => string | null
  root: () => string | null
  live: (path: string) => string | null
  open: (path: string, line: number) => void
  saveOutlineOpen: (open: boolean) => void
}

const REFRESH_DELAY = 300

const $ = (id: string): HTMLElement => document.getElementById(id) as HTMLElement

const completionTheme = EditorView.theme({
  '.cm-tooltip.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', fontSize: '12.5px', maxHeight: '16em' },
  '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px 2px 4px', borderRadius: '4px' },
  '.cm-tooltip-autocomplete ul li[aria-selected]': { background: 'var(--selection)', color: 'var(--text)' },
  '.cm-completionDetail': { color: 'var(--muted)', fontStyle: 'normal', marginLeft: '1.2em' },
  '.cm-completionMatchedText': { textDecoration: 'none', fontWeight: '600' },
  '.cm-completionIcon': { color: 'var(--faint)', opacity: '1' },
  '.cm-tooltip.cm-completionInfo': { padding: '4px 9px', maxWidth: '320px', color: 'var(--muted)', fontFamily: 'var(--font-ui)' },
  '.cm-snippetField': { backgroundColor: 'var(--hover)' },
  '.cm-snippetFieldPosition': { borderLeftColor: 'var(--faint)' },
  '.cm-foldPlaceholder': { backgroundColor: 'transparent', border: '1px solid var(--border)', color: 'var(--muted)', padding: '0 4px', margin: '0 2px' }
})

function sameHeadings(a: Heading[], b: Heading[]): boolean {
  return a.length === b.length && a.every((h, i) => h.title === b[i].title && h.file === b[i].file && h.line === b[i].line && h.level === b[i].level)
}

export class Writing {
  readonly project: Project
  readonly spell: Spell
  private view: EditorView | null = null
  private timer = 0
  private headings: Heading[] = []
  private scope: 'file' | 'document' = 'file'
  private fileCounts: Counts | null = null
  private docCounts: Counts | null = null
  private outlineOpen = true
  private selectionFrame = 0
  // ファイルごとの数。内容が変わったものだけ数え直す
  private counted = new Map<string, { text: string; counts: Counts }>()

  constructor(private deps: WritingDeps) {
    this.project = new Project(deps.api, deps.live)
    this.spell = new Spell({ misspelled: deps.api.spellMisspelled, suggestions: deps.api.spellSuggestions, menu: deps.api.spellMenu })
    $('outline-toggle').addEventListener('click', () => {
      this.setOutlineOpen(!this.outlineOpen)
      deps.saveOutlineOpen(this.outlineOpen)
    })
    $('word-count').addEventListener('click', () => {
      this.scope = this.scope === 'file' ? 'document' : 'file'
      this.renderCount()
    })
  }

  extension(): Extension[] {
    const deps = { project: this.project, root: () => this.rootFor(this.deps.path()), path: this.deps.path }
    const writing = this
    const tracker = ViewPlugin.fromClass(
      class {
        constructor(view: EditorView) {
          writing.view = view
          // ファイルを開いた（状態が替わった）ところ。Editor の組み立て中にも呼ばれるので、すぐには読まない
          writing.schedule(0)
        }
        update(u: ViewUpdate): void {
          if (u.docChanged) writing.schedule()
          else if (u.selectionSet) {
            // ドラッグで選んでいる間に何度も数えないよう、描画ごとに 1 回にまとめる
            cancelAnimationFrame(writing.selectionFrame)
            writing.selectionFrame = requestAnimationFrame(() => {
              writing.renderCount()
              writing.markActive()
            })
          }
        }
      }
    )
    return [
      latex(),
      ...completionSources(deps).map((source) => latexLanguage.data.of({ autocomplete: source })),
      latexLanguage.data.of({ autocomplete: this.spell.completion() }),
      this.spell.plugin(),
      spellTheme,
      completionTheme,
      Prec.high(formatKeys),
      tracker
    ]
  }

  setFolder(folder: string | null): void {
    this.project.setFolder(folder)
    this.counted.clear()
    this.headings = []
    this.schedule(0)
  }

  fileChanged(path: string, content: string): void {
    this.project.fileChanged(path, content)
    this.schedule()
  }

  applySettings(settings: { spellcheck: boolean; outline: boolean }): void {
    this.spell.setEnabled(settings.spellcheck)
    this.setOutlineOpen(settings.outline)
    this.renderCount()
  }

  schedule(delay = REFRESH_DELAY): void {
    clearTimeout(this.timer)
    this.timer = window.setTimeout(() => void this.refresh(), delay)
  }

  // 本体が分かっていて、開いているファイルがその書類の一部なら本体から。でなければ開いているファイルだけ
  private rootFor(path: string | null): string | null {
    const root = this.deps.root()
    if (!path) return root
    if (root && root !== path && (!path.endsWith('.tex') || documentFiles(this.project, root).includes(path))) return root
    return path
  }

  private async refresh(): Promise<void> {
    await this.project.load()
    const path = this.deps.path()
    const root = this.rootFor(path)
    const next = root ? outline(this.project, root) : []
    if (!sameHeadings(next, this.headings)) {
      this.headings = next
      this.renderOutline()
    } else this.markActive()
    this.fileCounts = this.view && path ? this.countOf(path, this.view.state.doc.toString(), true) : null
    this.docCounts = root
      ? documentFiles(this.project, root)
          .map((f) => this.countOf(f, this.project.text(f) ?? '', f === root))
          .reduce(add, { words: 0, chars: 0 })
      : null
    this.renderCount()
  }

  private countOf(path: string, text: string, documentOnly: boolean): Counts {
    const key = `${documentOnly ? 'doc' : 'all'}:${path}`
    const hit = this.counted.get(key)
    if (hit?.text === text) return hit.counts
    const counts = count(text, documentOnly)
    this.counted.set(key, { text, counts })
    return counts
  }

  // ---------- アウトライン ----------

  private setOutlineOpen(open: boolean): void {
    this.outlineOpen = open
    $('outline').classList.toggle('collapsed', !open)
    $('outline-toggle').setAttribute('aria-expanded', String(open))
  }

  private renderOutline(): void {
    const list = $('outline-list')
    list.replaceChildren()
    const min = Math.min(...this.headings.map((h) => h.level))
    this.headings.forEach((h) => {
      const li = document.createElement('li')
      li.className = 'outline-item'
      li.style.setProperty('--level', String(h.level - min))
      li.textContent = h.title || '…'
      li.title = h.title
      li.addEventListener('click', () => this.deps.open(h.file, h.line))
      list.append(li)
    })
    $('outline-empty').hidden = this.headings.length > 0
    this.markActive()
  }

  // カーソルのある節を示す
  markActive(): void {
    const path = this.deps.path()
    const view = this.view
    let active = -1
    if (path && view) {
      const line = view.state.doc.lineAt(view.state.selection.main.head).number
      this.headings.forEach((h, i) => {
        if (h.file === path && h.line <= line) active = i
      })
      // 節の途中から始まるファイル（\input された節の中身など）は、そのファイルを読み込んでいる節
      if (active < 0) {
        const first = this.headings.findIndex((h) => h.file === path)
        if (first > 0) active = first - 1
      }
    }
    $('outline-list')
      .querySelectorAll('li')
      .forEach((li, i) => li.classList.toggle('active', i === active))
  }

  // ---------- 文字数 ----------

  renderCount(): void {
    const el = $('word-count')
    const view = this.view
    if (!view || !this.deps.path()) {
      el.textContent = ''
      return
    }
    const fmt = (c: Counts) => ({ words: c.words.toLocaleString(), chars: c.chars.toLocaleString() })
    const sel = view.state.selection.main
    if (!sel.empty) {
      el.textContent = this.deps.tr('count.selection', fmt(count(view.state.sliceDoc(sel.from, sel.to), false)))
    } else if (this.scope === 'document' && this.docCounts) {
      el.textContent = this.deps.tr('count.document', fmt(this.docCounts))
    } else if (this.fileCounts) {
      el.textContent = this.deps.tr('count.file', fmt(this.fileCounts))
    }
    el.title = this.deps.tr(this.scope === 'file' ? 'count.showDocument' : 'count.showFile')
  }
}
