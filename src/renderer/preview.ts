import {
  AnnotationLayer,
  getDocument,
  GlobalWorkerOptions,
  PixelsPerInch,
  TextLayer,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy
} from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import type { PdfView } from '../main/settings'

GlobalWorkerOptions.workerSrc = workerUrl

const GAP = 16
const PADDING = 24 // #pdf-scroll の余白と同じ。ページへ移るときも、ページの上端をここに合わせる

interface PageView {
  page: PDFPageProxy
  el: HTMLDivElement
  rendered: number // 描画済みの倍率（0 は未描画）
  // 文字とリンクの層。見えたページにだけ一度作り、あとは倍率の CSS 変数で大きさを追う
  layers: Promise<void> | null
  text: TextLayer | null
}

export interface SyncTarget {
  page: number
  x: number
  y: number
  width: number
  height: number
}

// 検索用に、ページの文字を 1 本の文字列にしたもの。starts[i] は i 番目の文字片（＝文字の層の i 番目の span）の位置
interface PageText {
  text: string
  starts: number[]
  lengths: number[]
}

// 一致した場所。文字片ごとに [片の番号, 始め, 終わり] で持つ（1 つの一致が行をまたぐことがある）
interface Match {
  page: number
  parts: [item: number, from: number, to: number][]
}

type TextContentItem = Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'][number]

const CJK = /[　-ヿ㐀-鿿豈-﫿＀-￯]/

function buildPageText(items: TextContentItem[]): PageText {
  let text = ''
  const starts: number[] = []
  const lengths: number[] = []
  const strs = items.map((item) => ('str' in item ? item.str : ''))
  for (const [i, item] of items.entries()) {
    const str = strs[i]
    const lower = str.toLowerCase()
    starts.push(text.length)
    lengths.push(str.length)
    text += lower.length === str.length ? lower : str
    // 行の終わりは空白 1 つとして扱う。日本語どうしの改行は語の途中なので、何も挟まない
    if ('hasEOL' in item && item.hasEOL && !(CJK.test(text.at(-1) ?? '') && CJK.test(strs[i + 1]?.[0] ?? ''))) text += ' '
  }
  return { text, starts, lengths }
}

export class Preview {
  private task: PDFDocumentLoadingTask | null = null
  private doc: PDFDocumentProxy | null = null
  private pages: PageView[] = []
  private scale = 1
  private observer: IntersectionObserver
  private visible = new Set<PageView>()
  private generation = 0
  private view: PdfView = 'width'
  private texts: Promise<PageText>[] = []
  private query = ''
  private matches: Match[] = []
  private current = -1
  private findToken = 0
  zoom = 1

  constructor(
    private scroller: HTMLElement,
    private onBackwardSync: (page: number, x: number, y: number) => void,
    private hooks: { openLink: (url: string) => void; onChange: () => void }
  ) {
    this.observer = new IntersectionObserver((entries) => this.onIntersect(entries), {
      root: scroller,
      rootMargin: '600px 0px'
    })
    new ResizeObserver(() => this.relayoutSoon()).observe(scroller)
    // 文字を選んでいる間は、選択の終わりの印をページ全体に広げる（余白へ引いても選択が飛ばないように）
    scroller.addEventListener('pointerdown', (e) => {
      const layer = (e.target as HTMLElement).closest('.textLayer')
      if (!layer || e.button !== 0) return
      layer.classList.add('selecting')
      window.addEventListener('pointerup', () => layer.classList.remove('selecting'), { once: true })
    })
  }

  get loaded(): boolean {
    return this.task !== null
  }

  get pageCount(): number {
    return this.pages.length
  }

  // 拡大率。pdf.js と同じく、紙の実寸（96 dpi）を 100% とする
  get percent(): number {
    return Math.round((this.scale / PixelsPerInch.PDF_TO_CSS_UNITS) * 100)
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
    container.classList.toggle('spread', this.view === 'spread')
    const views = pages.map((page, i) => this.createPage(page, i + 1, scale, container))

    const firstVisible = Math.min(views.length - 1, Math.floor(ratio * views.length))
    await Promise.all(views.slice(Math.max(0, firstVisible - 1), firstVisible + 2).map((v) => this.render(v, scale, doc)))

    if (generation !== this.generation) {
      void task.destroy()
      return
    }
    for (const v of this.pages) this.observer.unobserve(v.el)
    this.visible.clear()
    const old = this.task
    this.scroller.replaceChildren(container)
    this.task = task
    this.doc = doc
    this.pages = views
    this.scale = scale
    this.texts = []
    this.scroller.scrollTop = ratio * this.scroller.scrollHeight
    this.scroller.scrollLeft = left
    for (const v of views) this.observer.observe(v.el)
    void old?.destroy()
    // 検索中なら、新しい PDF でも同じ言葉を探し直す（読んでいる場所は動かさない）
    if (this.query) void this.find(this.query, false)
    this.hooks.onChange()
  }

  clear(): void {
    this.generation++
    for (const v of this.pages) this.observer.unobserve(v.el)
    this.pages = []
    this.visible.clear()
    void this.task?.destroy()
    this.task = null
    this.doc = null
    this.texts = []
    this.matches = []
    this.current = -1
    this.paintMatches()
    this.scroller.replaceChildren()
    this.hooks.onChange()
  }

  setZoom(zoom: number): void {
    this.zoom = Math.min(4, Math.max(0.3, zoom))
    this.relayout()
  }

  // ピンチや ⌘ + スクロールでの拡大。指の下の点を動かさない。
  // 手を動かしている間は今の絵を引き伸ばすだけにして、止まってから描き直す
  private renderTimer = 0
  zoomAt(zoom: number, clientX: number, clientY: number): void {
    if (!this.pages.length || this.scroller.clientWidth < 100) return
    const hit = document.elementFromPoint(clientX, clientY)?.closest('.page')
    const view = this.pages.find((v) => v.el === hit) ?? this.pages[Math.max(0, this.currentPage() - 1)]
    const before = view.el.getBoundingClientRect()
    const x = (clientX - before.left) / this.scale
    const y = (clientY - before.top) / this.scale
    this.zoom = Math.min(4, Math.max(0.3, zoom))
    const scale = this.fitScale(this.pages[0].page)
    if (Math.abs(scale - this.scale) < 0.001) return
    this.scale = scale
    for (const v of this.pages) this.size(v.el, v.page, scale)
    const after = view.el.getBoundingClientRect()
    this.scroller.scrollLeft += after.left + x * scale - clientX
    this.scroller.scrollTop += after.top + y * scale - clientY
    clearTimeout(this.renderTimer)
    this.renderTimer = window.setTimeout(() => {
      for (const v of this.visible) void this.render(v, this.scale)
    }, 150)
    this.hooks.onChange()
  }

  // 幅に合わせる・ページ全体・見開き。切り替えても、見ていたページはそのまま
  setView(view: PdfView): void {
    if (view === this.view) return
    const page = this.currentPage()
    this.view = view
    this.scroller.querySelector('.pages')?.classList.toggle('spread', view === 'spread')
    this.relayout()
    if (page) this.goToPage(page)
  }

  private fitScale(page: PDFPageProxy): number {
    const { width, height } = page.getViewport({ scale: 1 })
    const available = Math.max(200, this.scroller.clientWidth - PADDING * 2)
    let fit = available / width
    if (this.view === 'spread') fit = (available - GAP) / (width * 2)
    if (this.view === 'page') fit = Math.min(fit, Math.max(150, this.scroller.clientHeight - PADDING * 2) / height)
    return fit * this.zoom
  }

  private createPage(page: PDFPageProxy, number: number, scale: number, container: HTMLElement): PageView {
    const el = document.createElement('div')
    el.className = 'page'
    el.dataset.page = String(number)
    this.size(el, page, scale)
    el.style.marginBottom = `${GAP}px`
    const view: PageView = { page, el, rendered: 0, layers: null, text: null }
    // ⌘クリックの SyncTeX は、リンクより先に受け取って横取りする
    el.addEventListener(
      'click',
      (e) => {
        if (!e.metaKey) return
        e.preventDefault()
        e.stopPropagation()
        const rect = el.getBoundingClientRect()
        this.onBackwardSync(number, (e.clientX - rect.left) / this.scale, (e.clientY - rect.top) / this.scale)
      },
      true
    )
    container.append(el)
    return view
  }

  // 文字とリンクの層は CSS 変数 --total-scale-factor で大きさが決まる（pdf.js の層の決まり）
  private size(el: HTMLElement, page: PDFPageProxy, scale: number): void {
    const vp = page.getViewport({ scale })
    el.style.width = `${Math.floor(vp.width)}px`
    el.style.height = `${Math.floor(vp.height)}px`
    el.style.setProperty('--total-scale-factor', String(scale))
  }

  private async render(view: PageView, scale: number, doc = this.doc): Promise<void> {
    if (view.rendered === scale) return
    view.rendered = scale
    const viewport = view.page.getViewport({ scale: scale * devicePixelRatio })
    const canvas = document.createElement('canvas')
    canvas.width = Math.floor(viewport.width)
    canvas.height = Math.floor(viewport.height)
    try {
      await Promise.all([view.page.render({ canvas, viewport }).promise, this.layers(view, scale, doc)])
    } catch {
      view.rendered = 0
      return
    }
    if (view.rendered !== scale) return
    view.el.querySelector(':scope > canvas')?.remove()
    view.el.prepend(canvas)
  }

  // 層づくりに失敗しても、ページの絵は出す（次に見えたとき作り直す）
  private layers(view: PageView, scale: number, doc: PDFDocumentProxy | null): Promise<void> {
    view.layers ??= this.buildLayers(view, scale, doc).catch(() => {
      view.layers = null
    })
    return view.layers
  }

  private async buildLayers(view: PageView, scale: number, doc: PDFDocumentProxy | null): Promise<void> {
    const viewport = view.page.getViewport({ scale })
    const textDiv = document.createElement('div')
    textDiv.className = 'textLayer'
    const text = new TextLayer({ textContentSource: view.page.streamTextContent(), container: textDiv, viewport })
    const [annotations] = await Promise.all([view.page.getAnnotations({ intent: 'display' }), text.render()])
    const end = document.createElement('div')
    end.className = 'endOfContent'
    textDiv.append(end)

    const linkDiv = document.createElement('div')
    linkDiv.className = 'annotationLayer'
    const linkService = this.linkService()
    const layer = new AnnotationLayer({
      div: linkDiv,
      page: view.page,
      viewport,
      linkService,
      annotationStorage: doc?.annotationStorage,
      accessibilityManager: null,
      annotationCanvasMap: null,
      annotationEditorUIManager: null,
      structTreeLayer: null,
      commentManager: null
    })
    await layer.render({ annotations, viewport, div: linkDiv, page: view.page, linkService: linkService as never, renderForms: false })
    // href を残すと、⇧クリックで新しいウィンドウが開くなど、ブラウザとしての動きが出てしまう。
    // 文書の中のリンクの title はリンクの文字（式の番号など）そのままで、出しても役に立たない
    for (const a of linkDiv.querySelectorAll('a[href]')) {
      a.removeAttribute('href')
      a.removeAttribute('title')
    }

    view.text = text
    view.el.append(textDiv, linkDiv)
    if (this.matches.some((m) => this.pages[m.page] === view)) this.paintMatches()
  }

  // pdf.js の注釈の層が呼ぶ、リンクの行き先の窓口
  private linkService() {
    return {
      eventBus: null,
      addLinkAttributes: (link: HTMLAnchorElement, url: string) => {
        link.title = url
        link.dataset.url = url
        link.onclick = () => {
          this.hooks.openLink(url)
          return false
        }
      },
      getDestinationHash: () => '#',
      getAnchorUrl: () => '#',
      goToDestination: (dest: unknown) => void this.goToDestination(dest),
      executeNamedAction: (action: string) => this.namedAction(action),
      executeSetOCGState: () => {},
      getAttachmentContent: async () => null
    }
  }

  // 文書の中のリンク（目次・\ref・\cite）。行き先の高さまで含めてスクロールする
  private async goToDestination(dest: unknown): Promise<void> {
    const doc = this.doc
    if (!doc) return
    const explicit = typeof dest === 'string' ? await doc.getDestination(dest) : dest
    if (!Array.isArray(explicit) || doc !== this.doc) return
    const [ref, mode, ...args] = explicit as [unknown, { name?: string } | null, ...(number | null)[]]
    const index = typeof ref === 'number' ? ref : ref && typeof ref === 'object' ? await doc.getPageIndex(ref as never) : -1
    const view = this.pages[index]
    if (!view) return
    let x: number | null = null
    let y: number | null = null
    if (mode?.name === 'XYZ') [x, y] = args
    else if (mode?.name === 'FitH' || mode?.name === 'FitBH') y = args[0]
    else if (mode?.name === 'FitR') [x, , , y] = args
    const [left, top] = y === null ? [0, 0] : view.page.getViewport({ scale: this.scale }).convertToViewportPoint(x ?? 0, y)
    this.scroller.scrollTo({ top: view.el.offsetTop + top - PADDING, left: x === null ? this.scroller.scrollLeft : view.el.offsetLeft + left - PADDING })
  }

  private namedAction(action: string): void {
    const page = this.currentPage()
    if (action === 'NextPage') this.goToPage(page + 1)
    else if (action === 'PrevPage') this.goToPage(page - 1)
    else if (action === 'FirstPage') this.goToPage(1)
    else if (action === 'LastPage') this.goToPage(this.pages.length)
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

  // PDF プレビューを閉じている間（列の幅が 0 で、余白だけが残る）は描き直さない。開くと ResizeObserver がまた呼ぶ
  private relayout(): void {
    if (!this.pages.length || this.scroller.clientWidth < 100) return
    const ratio = this.scroller.scrollTop / Math.max(1, this.scroller.scrollHeight)
    const scale = this.fitScale(this.pages[0].page)
    if (Math.abs(scale - this.scale) < 0.001) return this.hooks.onChange()
    this.scale = scale
    for (const v of this.pages) this.size(v.el, v.page, scale)
    this.scroller.scrollTop = ratio * this.scroller.scrollHeight
    for (const v of this.visible) void this.render(v, scale)
    this.hooks.onChange()
  }

  // 見ているページ（画面の上から 1/3 の高さにあるページ）。PDF が無ければ 0。
  // 見開きでは、同じ段の左のページを返す
  currentPage(): number {
    const y = this.scroller.scrollTop + this.scroller.clientHeight / 3
    let page = 0
    let row = -Infinity
    for (const [i, v] of this.pages.entries()) {
      if (v.el.offsetTop > y) break
      if (v.el.offsetTop > row) {
        page = i + 1
        row = v.el.offsetTop
      }
    }
    return page
  }

  goToPage(number: number): void {
    const view = this.pages[Math.min(this.pages.length, Math.max(1, number)) - 1]
    if (view) this.scroller.scrollTo({ top: view.el.offsetTop - PADDING })
  }

  // 前後のページへ（見開きでは 2 ページずつ）
  step(direction: 1 | -1): void {
    this.goToPage(this.currentPage() + direction * (this.view === 'spread' ? 2 : 1))
  }

  // ---------- PDF の中の検索 ----------

  private pageText(index: number): Promise<PageText> {
    this.texts[index] ??= this.pages[index].page.getTextContent().then((content) => buildPageText(content.items))
    return this.texts[index]
  }

  // 大文字と小文字は区別しない。reveal なら、見ているページから先で最初の一致へ移る
  async find(query: string, reveal = true): Promise<void> {
    const token = ++this.findToken
    const pages = this.pages
    this.query = query
    const needle = query.toLowerCase()
    const matches: Match[] = []
    if (needle) {
      const texts = await Promise.all(pages.map((_, i) => this.pageText(i)))
      if (token !== this.findToken || pages !== this.pages) return
      for (const [page, t] of texts.entries()) {
        for (let at = t.text.indexOf(needle); at >= 0; at = t.text.indexOf(needle, at + needle.length)) {
          const end = at + needle.length
          const parts: Match['parts'] = []
          for (const [i, start] of t.starts.entries()) {
            if (start >= end) break
            if (start + t.lengths[i] > at) parts.push([i, Math.max(0, at - start), Math.min(t.lengths[i], end - start)])
          }
          matches.push({ page, parts })
        }
      }
    }
    const before = this.current
    this.matches = matches
    if (reveal) {
      const from = this.currentPage() - 1
      this.current = matches.length ? Math.max(0, matches.findIndex((m) => m.page >= from)) : -1
    } else {
      this.current = matches.length ? Math.min(Math.max(0, before), matches.length - 1) : -1
    }
    this.paintMatches()
    this.hooks.onChange()
    if (reveal) await this.revealMatch()
  }

  findNext(direction: 1 | -1): void {
    if (!this.matches.length) return
    this.current = (this.current + direction + this.matches.length) % this.matches.length
    this.paintMatches()
    this.hooks.onChange()
    void this.revealMatch()
  }

  closeFind(): void {
    this.findToken++
    this.query = ''
    this.matches = []
    this.current = -1
    this.paintMatches()
    this.hooks.onChange()
  }

  findStatus(): { query: string; current: number; total: number } {
    return { query: this.query, current: this.current + 1, total: this.matches.length }
  }

  private ranges(match: Match): Range[] {
    const text = this.pages[match.page]?.text
    if (!text) return []
    const ranges: Range[] = []
    for (const [item, from, to] of match.parts) {
      const node = text.textDivs[item]?.firstChild
      if (!node || !node.isConnected || to <= from) continue
      const range = document.createRange()
      range.setStart(node, Math.min(from, node.textContent?.length ?? 0))
      range.setEnd(node, Math.min(to, node.textContent?.length ?? 0))
      ranges.push(range)
    }
    return ranges
  }

  // 一致の色付けは CSS Custom Highlight で行う。文字の層の DOM を書き換えないので、選択やコピーを邪魔しない
  private paintMatches(): void {
    const all = new Highlight()
    const current = new Highlight()
    for (const [i, m] of this.matches.entries()) for (const r of this.ranges(m)) (i === this.current ? current : all).add(r)
    CSS.highlights.set('pdf-find', all)
    CSS.highlights.set('pdf-find-current', current)
  }

  private async revealMatch(): Promise<void> {
    const match = this.matches[this.current]
    const view = match && this.pages[match.page]
    if (!view) return
    await this.layers(view, this.scale, this.doc)
    if (this.matches[this.current] !== match) return
    this.paintMatches()
    const range = this.ranges(match)[0]
    const box = this.scroller.getBoundingClientRect()
    if (!range) return this.scroller.scrollTo({ top: view.el.offsetTop - PADDING })
    const rect = range.getBoundingClientRect()
    const top = this.scroller.scrollTop + rect.top - box.top - this.scroller.clientHeight / 3
    const outside = rect.left < box.left || rect.right > box.left + this.scroller.clientWidth
    const left = outside ? this.scroller.scrollLeft + rect.left - box.left - this.scroller.clientWidth / 3 : this.scroller.scrollLeft
    this.scroller.scrollTo({ top, left })
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
