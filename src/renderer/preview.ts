import { getDocument, GlobalWorkerOptions, type PDFDocumentLoadingTask, type PDFPageProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

GlobalWorkerOptions.workerSrc = workerUrl

const GAP = 16
const PADDING = 20

interface PageView {
  page: PDFPageProxy
  el: HTMLDivElement
  rendered: number // 描画済みの倍率（0 は未描画）
}

export interface SyncTarget {
  page: number
  x: number
  y: number
  width: number
  height: number
}

export class Preview {
  private task: PDFDocumentLoadingTask | null = null
  private pages: PageView[] = []
  private scale = 1
  private observer: IntersectionObserver
  private visible = new Set<PageView>()
  private generation = 0
  zoom = 1

  constructor(
    private scroller: HTMLElement,
    private onBackwardSync: (page: number, x: number, y: number) => void
  ) {
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: scroller,
      rootMargin: '600px 0px'
    })
    new ResizeObserver(() => this.relayoutSoon()).observe(scroller)
  }

  get loaded(): boolean {
    return this.task !== null
  }

  // 新しい PDF を読み込む。見えているページを描き終えてから差し替えるので、組み直してもちらつかない。
  // 読み込み中に clear() されたら、描き終えても差し替えない（別の書類の PDF を出さないため）。
  async load(data: Uint8Array): Promise<void> {
    const generation = this.generation
    const task = getDocument({ data })
    const doc = await task.promise
    const pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)))
    const ratio = this.scroller.scrollHeight > 0 ? this.scroller.scrollTop / this.scroller.scrollHeight : 0
    const left = this.scroller.scrollLeft

    const scale = this.fitScale(pages[0])
    const container = document.createElement('div')
    container.className = 'pages'
    const views = pages.map((page, i) => this.createPage(page, i + 1, scale, container))

    const firstVisible = Math.min(views.length - 1, Math.floor(ratio * views.length))
    await Promise.all(views.slice(Math.max(0, firstVisible - 1), firstVisible + 2).map((v) => this.render(v, scale)))

    if (generation !== this.generation) {
      void task.destroy()
      return
    }
    for (const v of this.pages) this.observer.unobserve(v.el)
    this.visible.clear()
    const old = this.task
    this.scroller.replaceChildren(container)
    this.task = task
    this.pages = views
    this.scale = scale
    this.scroller.scrollTop = ratio * this.scroller.scrollHeight
    this.scroller.scrollLeft = left
    for (const v of views) this.observer.observe(v.el)
    void old?.destroy()
  }

  clear(): void {
    this.generation++
    for (const v of this.pages) this.observer.unobserve(v.el)
    this.pages = []
    this.visible.clear()
    void this.task?.destroy()
    this.task = null
    this.scroller.replaceChildren()
  }

  setZoom(zoom: number): void {
    this.zoom = Math.min(4, Math.max(0.3, zoom))
    this.relayout()
  }

  private fitScale(page: PDFPageProxy): number {
    const width = page.getViewport({ scale: 1 }).width
    const available = Math.max(200, this.scroller.clientWidth - PADDING * 2)
    return (available / width) * this.zoom
  }

  private createPage(page: PDFPageProxy, number: number, scale: number, container: HTMLElement): PageView {
    const el = document.createElement('div')
    el.className = 'page'
    el.dataset.page = String(number)
    this.size(el, page, scale)
    el.style.marginBottom = `${GAP}px`
    const view: PageView = { page, el, rendered: 0 }
    el.addEventListener('click', (e) => {
      if (!e.metaKey) return
      const rect = el.getBoundingClientRect()
      this.onBackwardSync(number, (e.clientX - rect.left) / this.scale, (e.clientY - rect.top) / this.scale)
    })
    container.append(el)
    return view
  }

  private size(el: HTMLElement, page: PDFPageProxy, scale: number): void {
    const vp = page.getViewport({ scale })
    el.style.width = `${Math.floor(vp.width)}px`
    el.style.height = `${Math.floor(vp.height)}px`
  }

  private async render(view: PageView, scale: number): Promise<void> {
    if (view.rendered === scale) return
    view.rendered = scale
    const viewport = view.page.getViewport({ scale: scale * devicePixelRatio })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    try {
      await view.page.render({ canvas, viewport }).promise
    } catch {
      view.rendered = 0
      return
    }
    if (view.rendered !== scale) return
    view.el.querySelector('canvas')?.remove()
    view.el.prepend(canvas)
  }

  private onIntersect(entries: IntersectionObserverEntry[]): void {
    for (const entry of entries) {
      const view = this.pages.find((v) => v.el === entry.target)
      if (!view) continue
      if (entry.isIntersecting) {
        this.visible.add(view)
        void this.render(view, this.scale)
      } else {
        this.visible.delete(view)
      }
    }
  }

  private relayoutTimer = 0
  private relayoutSoon(): void {
    clearTimeout(this.relayoutTimer)
    this.relayoutTimer = window.setTimeout(() => this.relayout(), 120)
  }

  private relayout(): void {
    if (!this.pages.length) return
    const ratio = this.scroller.scrollTop / Math.max(1, this.scroller.scrollHeight)
    const scale = this.fitScale(this.pages[0].page)
    if (Math.abs(scale - this.scale) < 0.001) return
    this.scale = scale
    for (const v of this.pages) this.size(v.el, v.page, scale)
    this.scroller.scrollTop = ratio * this.scroller.scrollHeight
    for (const v of this.visible) void this.render(v, scale)
  }

  // 見ているページ（画面の上から 1/3 の高さにあるページ）。PDF が無ければ 0。
  currentPage(): number {
    const y = this.scroller.scrollTop + this.scroller.clientHeight / 3
    let page = 0
    for (const [i, v] of this.pages.entries()) if (v.el.offsetTop <= y) page = i + 1
    return page
  }

  // ソースの位置に対応する PDF 上の場所へスクロールし、しばらく印を出す。
  reveal(target: SyncTarget): void {
    const view = this.pages[target.page - 1]
    if (!view) return
    const s = this.scale
    const mark = document.createElement('div')
    mark.className = 'sync-mark'
    const width = target.width > 0 ? target.width : view.page.getViewport({ scale: 1 }).width - target.x * 2
    Object.assign(mark.style, {
      left: `${target.x * s - 4}px`,
      top: `${target.y * s - 3}px`,
      width: `${width * s + 8}px`,
      height: `${Math.max(target.height, 8) * s + 6}px`
    })
    view.el.append(mark)
    setTimeout(() => mark.remove(), 1600)
    const top = view.el.offsetTop + target.y * s - this.scroller.clientHeight / 3
    this.scroller.scrollTo({ top, behavior: 'smooth' })
  }
}
