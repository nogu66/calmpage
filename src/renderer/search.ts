import type { SumiApi } from '../preload'
import type { Key } from '../shared/i18n'
import { buildPattern, replaceAll, type SearchMatch, type SearchOptions, type SearchResult } from '../shared/search'
import type { Editor } from './editor'

type Params = Record<string, string | number>

export interface SearchHost {
  sumi: SumiApi
  editor: Editor
  tr: (key: Key, params?: Params) => string
  relative: (path: string) => string
  inFolder: (path: string) => boolean
  open: (path: string, match: SearchMatch) => Promise<void>
  showSidebar: () => void
  // エディターの中で書き換えたファイル（開いているもの）を受け取り、保存と組版を任せる
  replaced: (paths: string[]) => void
}

const OPTIONS: { key: keyof SearchOptions; label: string; title: Key }[] = [
  { key: 'caseSensitive', label: 'Aa', title: 'search.case' },
  { key: 'wholeWord', label: 'ab', title: 'search.word' },
  { key: 'regex', label: '.*', title: 'search.regex' }
]

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

// サイドバーの「フォルダ内を検索」。ファイル一覧やアウトラインとは別の要素で、出している間だけそれらを隠す。
export class SearchPanel {
  private input = el('input', 'search-input')
  private replaceInput = el('input', 'search-input')
  private replaceButton = el('button', 'link-button search-replace-all')
  private status = el('p', 'search-status')
  private list = el('ul', 'search-results')
  private opts: SearchOptions = { caseSensitive: false, wholeWord: false, regex: false }
  private optButtons = new Map<keyof SearchOptions, HTMLButtonElement>()
  private result: SearchResult | null = null
  private state: { key: Key; params?: Params } | null = null
  private run = 0
  private timer = 0

  constructor(
    private root: HTMLElement,
    private host: SearchHost
  ) {
    const head = el('header', 'search-head')
    const title = el('span', '')
    title.dataset.i18n = 'menu.findInFolder'
    const close = el('button', 'search-close', '×')
    close.dataset.i18nTitle = 'search.close'
    close.dataset.i18nAria = 'search.close'
    close.addEventListener('click', () => this.hide())
    head.append(title, close)

    const field = el('div', 'search-field')
    this.input.type = 'text'
    this.input.spellcheck = false
    this.input.dataset.i18nPlaceholder = 'search.query'
    field.append(this.input)
    for (const o of OPTIONS) {
      const b = el('button', 'search-opt', o.label)
      b.dataset.opt = o.key
      b.dataset.i18nTitle = o.title
      b.setAttribute('aria-pressed', 'false')
      b.addEventListener('click', () => {
        this.opts[o.key] = !this.opts[o.key]
        b.setAttribute('aria-pressed', String(this.opts[o.key]))
        void this.search()
      })
      this.optButtons.set(o.key, b)
      field.append(b)
    }

    const replaceField = el('div', 'search-field')
    this.replaceInput.type = 'text'
    this.replaceInput.spellcheck = false
    this.replaceInput.dataset.i18nPlaceholder = 'search.replace'
    replaceField.append(this.replaceInput)
    const actions = el('div', 'search-actions')
    this.replaceButton.dataset.i18n = 'search.replaceAll'
    this.replaceButton.disabled = true
    this.replaceButton.addEventListener('click', () => void this.replaceAll())
    actions.append(this.replaceButton)

    root.append(head, field, replaceField, actions, this.status, this.list)

    this.input.addEventListener('input', () => {
      clearTimeout(this.timer)
      this.timer = window.setTimeout(() => void this.search(), 250)
    })
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        clearTimeout(this.timer)
        void this.search()
      }
    })
    this.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') void this.replaceAll()
    })
    root.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.hide()
    })
  }

  shown(): boolean {
    return document.body.classList.contains('search-open')
  }

  // ⇧⌘F: 出していなければ出す。検索欄で押したらファイル一覧に戻る。ほかを触っていたら検索欄へ。
  toggle(selection: string): void {
    if (this.shown() && document.activeElement === this.input) return this.hide()
    this.show(selection)
  }

  show(selection = ''): void {
    const wasShown = this.shown()
    document.body.classList.add('search-open')
    this.host.showSidebar()
    // 1 行だけ選んでいたら、それを探す
    if (selection && !selection.includes('\n') && selection.length <= 200) this.input.value = selection
    this.input.focus()
    this.input.select()
    if (this.input.value && (!wasShown || selection)) void this.search()
  }

  hide(): void {
    if (!this.shown()) return
    document.body.classList.remove('search-open')
    this.host.editor.view.focus()
  }

  // フォルダを替えたら、前の結果は消す
  reset(): void {
    this.run++
    this.result = null
    this.state = null
    this.renderResults()
  }

  applyLanguage(): void {
    this.renderStatus()
  }

  // 開いていて未保存のファイルは、ディスクではなくエディターの中身で探す
  private overrides(): Record<string, string> {
    const out: Record<string, string> = {}
    const { editor } = this.host
    for (const path of editor.loadedPaths()) {
      const text = editor.textOf(path)
      if (text !== null && editor.isDirty(path)) out[path] = text
    }
    return out
  }

  async search(notice?: { key: Key; params?: Params }): Promise<void> {
    const query = this.input.value
    const run = ++this.run
    this.result = null
    if (!query) {
      this.state = notice ?? null
      return this.renderResults()
    }
    try {
      buildPattern(query, this.opts)
    } catch {
      this.state = { key: 'search.invalid' }
      return this.renderResults()
    }
    this.state = { key: 'search.searching' }
    this.renderStatus()
    const res = await this.host.sumi.search(query, this.opts, this.overrides())
    if (run !== this.run || res === null) return // もっと新しい検索がある
    if ('error' in res) {
      this.state = { key: 'search.invalid' }
      return this.renderResults()
    }
    this.result = res
    this.state = notice ?? null
    this.renderResults()
  }

  private renderStatus(): void {
    const r = this.result
    let text = ''
    if (this.state) text = this.host.tr(this.state.key, this.state.params)
    else if (r && !r.total) text = this.host.tr('search.none')
    else if (r) text = this.host.tr('search.count', { n: r.total, files: r.files.length })
    if (!this.state && r?.truncated) text += ` · ${this.host.tr('search.truncated', { n: r.total })}`
    this.status.textContent = text
    this.status.hidden = !text
    this.replaceButton.disabled = !r?.total
  }

  private renderResults(): void {
    this.renderStatus()
    this.list.replaceChildren()
    for (const file of this.result?.files ?? []) {
      const group = el('li', 'search-group')
      const head = el('div', 'search-file')
      head.dataset.path = file.path
      const rel = this.host.relative(file.path)
      const slash = rel.lastIndexOf('/')
      head.title = rel
      head.append(el('span', 'search-file-name', rel.slice(slash + 1)))
      if (slash > 0) head.append(el('span', 'search-file-dir', rel.slice(0, slash)))
      head.append(el('span', 'search-file-count', String(file.matches.length)))
      head.addEventListener('click', () => group.classList.toggle('collapsed'))
      const hits = el('ul', 'search-hits')
      for (const m of file.matches) {
        const li = el('li', 'search-hit')
        li.dataset.path = file.path
        li.dataset.line = String(m.line)
        const text = el('span', 'search-hit-text')
        text.append(m.before, el('mark', '', m.match), m.after)
        li.append(el('span', 'search-hit-line', String(m.line)), text)
        li.addEventListener('click', () => {
          for (const a of this.list.querySelectorAll('.search-hit.active')) a.classList.remove('active')
          li.classList.add('active')
          void this.host.open(file.path, m)
        })
        hits.append(li)
      }
      group.append(head, hits)
      this.list.append(group)
    }
  }

  // すべて置換: 確かめてから、開いていないファイルは main がディスクに書き、開いているファイルはエディターの中で書き換える
  private async replaceAll(): Promise<void> {
    const r = this.result
    const query = this.input.value
    const replacement = this.replaceInput.value
    if (!r?.total || !query) return
    const { tr, sumi, editor } = this.host
    const ok = await sumi.confirm(
      tr('search.confirm', { n: r.truncated ? `${r.total}+` : r.total, files: r.files.length }),
      tr('search.confirmDetail', { query, replacement }),
      tr('search.confirmOk'),
      tr('search.cancel')
    )
    if (!ok) return
    const opts = { ...this.opts }
    const loaded = editor.loadedPaths().filter((p) => this.host.inFolder(p))
    const disk = await sumi.replaceInFolder(query, opts, replacement, editor.loadedPaths())
    const re = buildPattern(query, opts)
    const changed: string[] = []
    let count = disk.count
    for (const path of loaded) {
      const text = editor.textOf(path)
      if (text === null) continue
      const next = replaceAll(text, re, replacement, opts.regex)
      if (!next.count) continue
      editor.replaceText(path, next.text)
      changed.push(path)
      count += next.count
    }
    this.host.replaced(changed)
    await this.search({ key: 'search.replaced', params: { n: count } })
  }
}
