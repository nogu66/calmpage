import type { SumiApi } from '../preload'
import type { Key } from '../shared/i18n'
import { findAdded, type AgentConfig, type InstallProgress, type RegistryAgent } from '../shared/agents'

// ACP の登録簿から選ぶ一覧。柱の「+」から出すものと、設定の中に置くものの 2 つがあり、中身（RegistryStore）を分け合う。

type Params = Record<string, string | number>

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag)
  e.className = className
  if (text !== undefined) e.textContent = text
  return e
}

// 登録簿の中身は窓に 1 つだけ持つ。一覧を出すたびに main へ聞き直す（登録簿は main が覚えていて、
// 使えるかどうかは PATH で変わるため）。読めなかったときは、その旨と「もう一度」を出す
export class RegistryStore {
  agents: RegistryAgent[] | null = null
  error: string | null = null
  icons: Record<string, string> = {}
  progress = new Map<string, InstallProgress>()
  private loading: Promise<void> | null = null
  private listeners = new Set<() => void>()

  constructor(private sumi: SumiApi) {
    sumi.onInstallProgress((id, p) => {
      if (p.phase === 'done') this.progress.delete(id)
      else this.progress.set(id, p)
      this.emit()
    })
  }

  subscribe(fn: () => void): void {
    this.listeners.add(fn)
  }

  private emit(): void {
    for (const fn of this.listeners) fn()
  }

  load(): Promise<void> {
    this.loading ??= this.fetch().finally(() => (this.loading = null))
    return this.loading
  }

  private async fetch(): Promise<void> {
    // 前の中身があれば、届くまでそれを出しておく
    if (!this.agents) {
      this.error = null
      this.emit()
    }
    const res = await this.sumi.listRegistry()
    this.agents = res.agents ?? null
    this.error = res.agents ? null : (res.error ?? 'unknown error')
    this.emit()
    if (!this.agents) return
    this.icons = await this.sumi.registryIcons()
    this.emit()
  }

  install(id: string): Promise<{ agent?: AgentConfig; error?: string }> {
    this.progress.set(id, { phase: 'download', received: 0, total: null })
    this.emit()
    return this.sumi.installAgent(id)
  }
}

export interface PickerHost {
  tr: (key: Key, params?: Params) => string
  agents: () => AgentConfig[]
  // 「追加」を押したとき（柱では足して、そのままタブで開く）
  add: (agent: AgentConfig) => void
  // 入れ終わったとき。設定には main が足してある
  installed?: (agent: AgentConfig) => void
  // 柱だけ: 追加済みのものを開く・閉じる・自分で書く欄へ
  open?: (agent: AgentConfig) => void
  close?: () => void
  custom?: () => void
}

type Mode = 'pillar' | 'settings'

// 「すぐ使える」（追加済み・npx や PATH で動く）と「インストールが要る」（取ってきて入れる・この Mac では使えない）の
// タブに分ける。後ろのタブでは、入れられるものを先に、使えないものを下へよける。その中は名前順。
// 一覧を出している間は並びもタブも変えない（足したり入れたりした行が動くと、目で追えなくなる）。
type Tab = 'ready' | 'install'

function rank(entry: RegistryAgent, added: boolean): number {
  if (added || entry.status.kind === 'ready') return 0
  return entry.status.kind === 'install' ? 1 : 2
}

export class AgentPicker {
  readonly el: HTMLElement
  private input = el('input', 'picker-search')
  private status = el('p', 'picker-status')
  private retry = el('button', 'link-button picker-retry')
  private list = el('ul', 'picker-list')
  private tabs = el('div', 'segmented picker-tabs')
  private tabButtons: Record<Tab, HTMLButtonElement> = { ready: el('button', 'picker-tab'), install: el('button', 'picker-tab') }
  private tab: Tab = 'ready'
  private order: string[] = []
  private group = new Map<string, Tab>()
  private shown: RegistryAgent[] = []
  private active = 0

  constructor(
    private store: RegistryStore,
    private host: PickerHost,
    private mode: Mode
  ) {
    this.el = el('div', `picker picker-${mode}`)
    this.input.type = 'text'
    this.input.spellcheck = false
    this.input.setAttribute('role', 'combobox')
    this.input.setAttribute('aria-expanded', 'true')
    this.list.id = `picker-list-${mode}`
    this.list.setAttribute('role', 'listbox')
    this.input.setAttribute('aria-controls', this.list.id)
    const statusRow = el('div', 'picker-status-row')
    statusRow.append(this.status, this.retry)
    for (const t of ['ready', 'install'] as Tab[]) {
      const b = this.tabButtons[t]
      b.type = 'button'
      b.dataset.tab = t
      b.addEventListener('click', () => {
        this.tab = t
        this.active = 0
        this.render()
        this.list.scrollTop = 0
        this.input.focus()
      })
      this.tabs.append(b)
    }
    this.el.append(this.tabs, this.input, statusRow, this.list)
    if (host.custom) {
      const custom = el('button', 'link-button picker-custom')
      custom.dataset.i18n = 'settings.customOpen'
      custom.addEventListener('click', () => host.custom?.())
      const foot = el('div', 'picker-foot')
      foot.append(custom)
      this.el.append(foot)
    }
    this.input.addEventListener('input', () => {
      this.active = 0
      this.render()
    })
    this.input.addEventListener('keydown', (e) => this.onKey(e))
    // 押した「もう一度」は読めたら消えるので、検索欄へ戻しておく
    this.retry.addEventListener('click', () => {
      this.input.focus()
      void store.load()
    })
    store.subscribe(() => this.render())
    this.applyLanguage()
  }

  applyLanguage(): void {
    this.input.placeholder = this.host.tr('picker.search')
    this.input.setAttribute('aria-label', this.host.tr('picker.search'))
    this.retry.textContent = this.host.tr('picker.retry')
    for (const e of this.el.querySelectorAll<HTMLElement>('[data-i18n]')) e.textContent = this.host.tr(e.dataset.i18n as Key)
    this.render()
  }

  // 出すたびに検索を空にし、そのときの状態で並べ直す
  reset(): void {
    this.input.value = ''
    this.active = 0
    this.tab = 'ready'
    this.order = []
    this.render()
    this.list.scrollTop = 0
  }

  focus(): void {
    this.input.focus()
  }

  private sort(agents: RegistryAgent[]): void {
    const mine = this.host.agents()
    const ranked = agents.map((a) => ({ a, r: rank(a, !!findAdded(a, mine)) }))
    ranked.sort((x, y) => x.r - y.r || x.a.name.localeCompare(y.a.name))
    this.order = ranked.map((x) => x.a.id)
    this.group = new Map(ranked.map((x) => [x.a.id, x.r === 0 ? 'ready' : 'install']))
  }

  render(): void {
    const { agents, error } = this.store
    this.retry.hidden = !error
    if (!agents) {
      this.status.textContent = this.host.tr(error ? 'picker.failed' : 'settings.registryLoading')
      this.status.title = error ?? ''
      this.list.replaceChildren()
      this.shown = []
      return
    }
    if (this.order.length !== agents.length) this.sort(agents)
    const byId = new Map(agents.map((a) => [a.id, a]))
    const words = this.input.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
    // 名前に当たるものを、説明だけに当たるものより先に出す
    const hits = this.order
      .map((id) => byId.get(id)!)
      .filter((a) => {
        const text = `${a.name} ${a.id} ${a.description}`.toLowerCase()
        return words.every((w) => text.includes(w))
      })
    const byName = (a: RegistryAgent): boolean => words.every((w) => `${a.name} ${a.id}`.toLowerCase().includes(w))
    const inTab = (t: Tab): RegistryAgent[] => hits.filter((a) => this.group.get(a.id) === t)
    const other: Tab = this.tab === 'ready' ? 'install' : 'ready'
    // いまのタブに当たりが無く、もう一方にあれば、そちらへ移る（探したものが見えないままにしない）
    if (!inTab(this.tab).length && inTab(other).length) this.tab = other
    for (const t of ['ready', 'install'] as Tab[]) {
      this.tabButtons[t].textContent = this.host.tr(t === 'ready' ? 'picker.tabReady' : 'picker.tabInstall', { n: inTab(t).length })
      this.tabButtons[t].setAttribute('aria-pressed', String(t === this.tab))
    }
    const current = inTab(this.tab)
    this.shown = [...current.filter(byName), ...current.filter((a) => !byName(a))]
    this.active = Math.min(this.active, Math.max(0, this.shown.length - 1))
    this.status.textContent = this.shown.length ? '' : this.host.tr('picker.none')
    this.status.title = ''
    const mine = this.host.agents()
    this.list.replaceChildren(...this.shown.map((a, i) => this.row(a, i, findAdded(a, mine))))
    this.markActive(false)
  }

  private row(entry: RegistryAgent, index: number, added: AgentConfig | undefined): HTMLElement {
    const { tr } = this.host
    const li = el('li', 'picker-row')
    li.id = `picker-${this.mode}-${entry.id}`
    li.dataset.id = entry.id
    li.setAttribute('role', 'option')
    const icon = el('span', 'picker-icon')
    const data = this.store.icons[entry.id]
    // 単色（currentColor）の SVG なので、形だけを抜き型にして文字の色で塗る。暗い画面でも沈まない
    if (data) icon.style.setProperty('--icon', `url("${data}")`)
    else {
      icon.classList.add('letter')
      icon.textContent = entry.name.trim().charAt(0).toUpperCase()
    }
    icon.setAttribute('aria-hidden', 'true')
    const main = el('div', 'picker-main')
    main.append(el('div', 'picker-name', entry.name))
    if (entry.description) main.append(el('div', 'picker-desc', entry.description))
    const progress = this.store.progress.get(entry.id)
    const note = this.note(progress)
    if (note) main.append(el('div', `picker-note${progress?.phase === 'failed' ? ' failed' : ''}`, note))

    const { status } = entry
    let label: string | null = null
    let enabled = true
    if (added) {
      label = tr(this.mode === 'pillar' ? 'picker.open' : 'picker.added')
      enabled = this.mode === 'pillar'
      li.dataset.state = 'added'
    } else if (status.kind === 'ready') {
      label = tr('picker.add')
      li.dataset.state = 'ready'
    } else if (status.kind === 'install') {
      label = tr('picker.install')
      enabled = !progress || progress.phase === 'failed'
      li.dataset.state = progress && progress.phase !== 'failed' ? 'installing' : 'install'
      li.title = tr('picker.installHint', { name: entry.name, version: entry.version })
    } else {
      enabled = false
      li.dataset.state = 'unavailable'
    }
    li.setAttribute('aria-disabled', String(!enabled))
    li.append(icon, main)
    if (label !== null) {
      const action = el('button', 'picker-action', label)
      action.tabIndex = -1
      action.disabled = !enabled
      li.append(action)
    } else if (status.kind === 'unavailable') {
      const key: Key = status.reason === 'npx' ? 'picker.needsNpx' : status.reason === 'uvx' ? 'picker.needsUvx' : 'picker.noBuild'
      li.append(el('span', 'picker-reason', tr(key)))
    }
    li.addEventListener('mousemove', () => {
      if (this.active === index) return
      this.active = index
      this.markActive(false)
    })
    li.addEventListener('click', () => this.choose(entry))
    return li
  }

  private note(p: InstallProgress | undefined): string | null {
    const { tr } = this.host
    if (!p || p.phase === 'done') return null
    if (p.phase === 'extract') return tr('picker.extracting')
    if (p.phase === 'failed') return tr('picker.installFailed', { error: p.error === 'checksum' ? tr('picker.checksum') : p.error })
    if (p.total) return tr('picker.downloadingPercent', { percent: Math.floor((p.received / p.total) * 100) })
    return tr('picker.downloadingSize', { mb: (p.received / 1048576).toFixed(1) })
  }

  private markActive(scroll: boolean): void {
    const rows = this.list.children
    for (let i = 0; i < rows.length; i++) rows[i].classList.toggle('active', i === this.active)
    const row = rows[this.active] as HTMLElement | undefined
    if (row) this.input.setAttribute('aria-activedescendant', row.id)
    else this.input.removeAttribute('aria-activedescendant')
    if (scroll) row?.scrollIntoView({ block: 'nearest' })
  }

  private onKey(e: KeyboardEvent): void {
    if (e.isComposing) return
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!this.shown.length) return
      const step = e.key === 'ArrowDown' ? 1 : -1
      this.active = (this.active + step + this.shown.length) % this.shown.length
      this.markActive(true)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = this.shown[this.active]
      if (entry) this.choose(entry)
    } else if (e.key === 'Escape' && this.host.close) {
      e.preventDefault()
      e.stopPropagation()
      this.host.close()
    }
  }

  private choose(entry: RegistryAgent): void {
    const added = findAdded(entry, this.host.agents())
    if (added) {
      this.host.open?.(added)
      return
    }
    const progress = this.store.progress.get(entry.id)
    if (progress && progress.phase !== 'failed') return
    if (entry.status.kind === 'ready') this.host.add(entry.status.agent)
    else if (entry.status.kind === 'install') {
      void this.store.install(entry.id).then((res) => {
        if (res.agent) this.host.installed?.(res.agent)
      })
    }
  }
}
