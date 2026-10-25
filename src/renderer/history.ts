import type { Version } from '../main/history'
import type { SumiApi } from '../preload'
import type { Key, Lang } from '../shared/i18n'
import { diffStat, renderDiff } from './diff'

type Params = Record<string, string | number>

export interface HistoryHost {
  sumi: SumiApi
  tr: (key: Key, params?: Params) => string
  lang: () => Lang
  relative: (path: string) => string
  current: (path: string) => string | null
  restore: (path: string, text: string) => void
  closed: () => void
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

// 「ファイルの履歴…」: 版の一覧と、選んだ版から今の内容への差分。設定と同じシートの形で出す。
export class HistorySheet {
  readonly el = el('div', 'sheet-backdrop')
  private title = el('h2', 'history-title')
  private list = el('ul', 'history-list')
  private diff = el('div', 'history-diff')
  private restoreButton = el('button', 'link-button history-restore')
  private closeButton = el('button', 'sheet-done history-close')
  private path: string | null = null
  private versions: (Version & { text: string })[] = []
  private selected = -1

  constructor(private host: HistoryHost) {
    this.el.id = 'history'
    this.el.hidden = true
    const sheet = el('section', 'sheet history-sheet')
    sheet.setAttribute('role', 'dialog')
    sheet.setAttribute('aria-modal', 'true')
    const head = el('header', 'sheet-head')
    const actions = el('div', 'history-actions')
    const close = this.closeButton
    close.dataset.i18n = 'history.close'
    close.addEventListener('click', () => this.close())
    this.restoreButton.dataset.i18n = 'history.restore'
    this.restoreButton.addEventListener('click', () => this.restore())
    actions.append(this.restoreButton, close)
    head.append(this.title, actions)
    const body = el('div', 'history-body')
    body.append(this.list, this.diff)
    sheet.append(head, body)
    this.el.append(sheet)
    document.body.append(this.el)

    this.el.addEventListener('click', (e) => {
      if (e.target === this.el) this.close()
    })
    this.el.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close()
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        this.select(Math.max(0, Math.min(this.versions.length - 1, this.selected + (e.key === 'ArrowDown' ? 1 : -1))), true)
      }
    })
  }

  isOpen(): boolean {
    return !this.el.hidden
  }

  async open(path: string): Promise<void> {
    this.path = path
    const versions = await this.host.sumi.listVersions(path)
    const texts = await Promise.all(versions.map((v) => this.host.sumi.readVersion(path, v.id).catch(() => null)))
    if (this.path !== path) return
    this.versions = versions.flatMap((v, i) => (texts[i] === null ? [] : [{ ...v, text: texts[i] as string }]))
    this.el.hidden = false
    this.render()
    // 今の内容と違う、いちばん新しい版を選んでおく
    const current = this.host.current(path) ?? ''
    const first = this.versions.findIndex((v) => v.text !== current)
    if (this.versions.length) this.select(first === -1 ? 0 : first, true)
    else this.closeButton.focus()
  }

  close(): void {
    if (this.el.hidden) return
    this.el.hidden = true
    this.path = null
    this.host.closed()
  }

  private when(time: number): string {
    return new Intl.DateTimeFormat(this.host.lang(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(time)
  }

  private render(): void {
    const path = this.path as string
    const name = this.host.relative(path)
    this.title.textContent = this.host.tr('history.title', { file: name.slice(name.lastIndexOf('/') + 1) })
    this.title.title = name
    this.list.replaceChildren()
    const current = this.host.current(path) ?? ''
    if (!this.versions.length) {
      this.diff.replaceChildren(el('p', 'history-empty', this.host.tr('history.empty')))
      this.restoreButton.disabled = true
      return
    }
    this.versions.forEach((v, i) => {
      const li = el('li', '')
      const item = el('button', 'history-item')
      item.dataset.id = v.id
      item.setAttribute('role', 'option')
      item.append(el('span', 'history-when', this.when(v.time)))
      if (v.text === current) item.append(el('span', 'history-stat', this.host.tr('history.same')))
      else {
        const stat = diffStat(v.text, current)
        if (stat) item.append(el('span', 'history-stat', `+${stat.added} −${stat.removed}`))
      }
      item.addEventListener('click', () => this.select(i, false))
      li.append(item)
      this.list.append(li)
    })
  }

  private select(i: number, focus: boolean): void {
    const v = this.versions[i]
    if (!v || !this.path) return
    this.selected = i
    const items = [...this.list.querySelectorAll<HTMLElement>('.history-item')]
    items.forEach((item, j) => item.setAttribute('aria-selected', String(i === j)))
    if (focus) items[i]?.focus()
    items[i]?.scrollIntoView({ block: 'nearest' })
    const current = this.host.current(this.path) ?? ''
    this.restoreButton.disabled = v.text === current
    if (v.text === current) {
      this.diff.replaceChildren(el('p', 'history-empty', this.host.tr('history.noDiff')))
      return
    }
    this.diff.replaceChildren(
      renderDiff(v.text, current, {
        title: this.host.tr('history.compare', { time: this.when(v.time) }),
        context: 3,
        maxRows: 3000,
        more: (n) => this.host.tr('ai.moreLines', { n })
      })
    )
  }

  private restore(): void {
    const v = this.versions[this.selected]
    if (!v || !this.path) return
    this.host.restore(this.path, v.text)
    this.close()
  }
}
