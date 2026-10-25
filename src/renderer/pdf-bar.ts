import type { Settings } from '../main/settings'
import type { SumiApi } from '../preload'
import type { Key } from '../shared/i18n'
import type { Preview } from './preview'

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

// PDF の列の上の細い帯（ページ番号・拡大率・表示の切り替え）と、PDF の中の検索
export class PdfBar {
  private findTimer = 0

  constructor(
    private preview: Preview,
    private deps: { sumi: SumiApi; tr: (key: Key) => string; show: () => void }
  ) {
    const scroller = $('pdf-scroll')
    let frame = 0
    scroller.addEventListener('scroll', () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => this.update())
    })

    // プレビューに焦点があるときだけ受け取る（エディターの ⌘F は CodeMirror の検索）
    $('preview-col').addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).closest('input')) return
      const plain = !e.metaKey && !e.altKey && !e.ctrlKey && !e.shiftKey
      if (e.metaKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') this.openFind()
      else if (e.metaKey && e.key.toLowerCase() === 'g') this.preview.findNext(e.shiftKey ? -1 : 1)
      else if (plain && e.key === 'ArrowRight') this.preview.step(1)
      else if (plain && e.key === 'ArrowLeft') this.preview.step(-1)
      else return
      e.preventDefault()
    })

    const pageInput = $<HTMLInputElement>('pdf-page')
    pageInput.addEventListener('focus', () => pageInput.select())
    pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const n = Number.parseInt(pageInput.value, 10)
        if (Number.isFinite(n)) this.preview.goToPage(n)
        scroller.focus()
      } else if (e.key === 'Escape') {
        scroller.focus()
      } else return
      e.preventDefault()
    })
    pageInput.addEventListener('blur', () => this.update())

    const input = $<HTMLInputElement>('pdf-find-input')
    input.addEventListener('input', () => {
      clearTimeout(this.findTimer)
      this.findTimer = window.setTimeout(() => void this.preview.find(input.value), 150)
    })
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return // 日本語の変換を確定する ⏎ では探さない
      if (e.key === 'Enter' ||(e.metaKey && e.key.toLowerCase() === 'g')) {
        const back = e.shiftKey
        clearTimeout(this.findTimer)
        if (this.preview.findStatus().query !== input.value) void this.preview.find(input.value)
        else this.preview.findNext(back ? -1 : 1)
      } else if (e.key === 'Escape') {
        this.closeFind()
      } else return
      e.preventDefault()
    })
    $('pdf-find-prev').addEventListener('click', () => this.preview.findNext(-1))
    $('pdf-find-next').addEventListener('click', () => this.preview.findNext(1))
    $('pdf-find-close').addEventListener('click', () => this.closeFind())

    $<HTMLInputElement>('settings-pdf-invert').addEventListener('change', (e) =>
      this.deps.sumi.updateSettings({ pdfInvert: (e.target as HTMLInputElement).checked })
    )
  }

  apply(settings: Settings): void {
    this.preview.setView(settings.pdfView)
    document.body.classList.toggle('pdf-invert', settings.pdfInvert)
    $<HTMLInputElement>('settings-pdf-invert').checked = settings.pdfInvert
  }

  // ⌥⌘F、またはプレビューで ⌘F。もう開いていれば、入力欄を選び直す
  openFind(): void {
    if (!this.preview.loaded) return
    this.deps.show()
    $('pdf-find').hidden = false
    const input = $<HTMLInputElement>('pdf-find-input')
    input.focus()
    input.select()
    if (input.value && this.preview.findStatus().query !== input.value) void this.preview.find(input.value)
  }

  closeFind(): void {
    clearTimeout(this.findTimer)
    $('pdf-find').hidden = true
    this.preview.closeFind()
    $('pdf-scroll').focus()
  }

  update(): void {
    const total = this.preview.pageCount
    const pageInput = $<HTMLInputElement>('pdf-page')
    if (document.activeElement !== pageInput) pageInput.value = total ? String(this.preview.currentPage()) : ''
    $('pdf-total').textContent = total ? `/ ${total}` : ''
    $('pdf-zoom').textContent = total ? `${this.preview.percent}%` : ''
    const { query, current, total: found } = this.preview.findStatus()
    $('pdf-find-count').textContent = !query ? '' : found ? `${current} / ${found}` : this.deps.tr('pdf.findNone')
  }
}
