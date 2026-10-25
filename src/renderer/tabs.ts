import type { Key } from '../shared/i18n'

export interface TabHost {
  tr: (key: Key) => string
  relative: (path: string) => string
  activePath: () => string | null
  rootPath: () => string | null
  isDirty: (path: string) => boolean
  select: (path: string) => void
  close: (path: string) => void
  // 並びが変わったら呼ぶ（設定に残す）
  changed: (paths: string[]) => void
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

// エディターの上のタブ。中身は持たず、並びだけを持つ（中身は Editor の docs にある）。
export class TabBar {
  paths: string[] = []

  constructor(
    private el: HTMLElement,
    private host: TabHost
  ) {
    el.setAttribute('role', 'tablist')
    // 中クリックで閉じる。押したときに既定の自動スクロールが始まらないようにする
    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) e.preventDefault()
    })
  }

  set(paths: string[]): void {
    this.paths = [...new Set(paths)]
    this.render()
  }

  add(path: string): void {
    if (this.paths.includes(path)) return this.render()
    this.paths.push(path)
    this.render()
    this.host.changed(this.paths)
  }

  remove(path: string): void {
    if (!this.paths.includes(path)) return
    this.paths = this.paths.filter((p) => p !== path)
    this.render()
    this.host.changed(this.paths)
  }

  // 閉じたあとに出すタブ: 右隣、なければ左隣
  neighbor(path: string): string | null {
    const i = this.paths.indexOf(path)
    if (i === -1) return null
    return this.paths[i + 1] ?? this.paths[i - 1] ?? null
  }

  step(path: string | null, dir: 1 | -1): string | null {
    if (!this.paths.length) return null
    const i = path ? this.paths.indexOf(path) : -1
    return this.paths[(i + dir + this.paths.length) % this.paths.length]
  }

  render(): void {
    const active = this.host.activePath()
    const root = this.host.rootPath()
    // 同じ名前のファイルが 2 つ以上あるときだけ、フォルダの名前を添える
    const names = new Map<string, number>()
    for (const p of this.paths) names.set(baseName(p), (names.get(baseName(p)) ?? 0) + 1)
    this.el.replaceChildren()
    for (const path of this.paths) {
      const tab = document.createElement('div')
      tab.className = 'tab'
      tab.dataset.path = path
      tab.setAttribute('role', 'tab')
      tab.setAttribute('aria-selected', String(path === active))
      tab.classList.toggle('active', path === active)
      tab.classList.toggle('root', path === root)
      tab.classList.toggle('dirty', this.host.isDirty(path))
      tab.title = path === root ? `${this.host.relative(path)} · ${this.host.tr('tabs.root')}` : this.host.relative(path)
      const name = document.createElement('span')
      name.className = 'tab-name'
      name.textContent = baseName(path)
      tab.append(name)
      const rel = this.host.relative(path)
      if ((names.get(baseName(path)) ?? 0) > 1 && rel.includes('/')) {
        const dir = document.createElement('span')
        dir.className = 'tab-dir'
        dir.textContent = rel.slice(0, rel.lastIndexOf('/'))
        tab.append(dir)
      }
      const close = document.createElement('button')
      close.className = 'tab-close'
      close.title = this.host.tr('tabs.close')
      close.setAttribute('aria-label', this.host.tr('tabs.close'))
      close.innerHTML = '<span class="x">×</span>'
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        this.host.close(path)
      })
      tab.append(close)
      tab.addEventListener('click', () => this.host.select(path))
      tab.addEventListener('auxclick', (e) => {
        if (e.button === 1) this.host.close(path)
      })
      this.el.append(tab)
      if (path === active) requestAnimationFrame(() => tab.scrollIntoView({ block: 'nearest', inline: 'nearest' }))
    }
  }

  // 打つたびに描き直さず、印だけを付け替える
  updateDirty(): void {
    for (const tab of this.el.querySelectorAll<HTMLElement>('.tab')) tab.classList.toggle('dirty', this.host.isDirty(tab.dataset.path as string))
  }
}
