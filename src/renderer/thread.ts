import type { ContentBlock, PlanEntry, RequestPermissionRequest, SessionUpdate, ToolCallContent, ToolCallUpdate } from '@agentclientprotocol/sdk'
import { diffLines } from 'diff'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { StartResult } from '../main/acp'
import type { AgentConfig } from '../main/settings'
import type { SumiApi } from '../preload'
import type { Key } from '../shared/i18n'

// ACP のエージェントとの会話の画面。柱のタブごとに 1 本のスレッドを持ち、切り替えても消さない。

export interface ThreadHost {
  sumi: SumiApi
  tr: (key: Key, params?: Record<string, string | number>) => string
  relative: (path: string) => string
  // 送るたびに添える文脈（チップで選んだもの）と、その短い説明
  context: () => ContentBlock[]
  contextSummary: () => string
  // 送る前に、エディターの未保存の内容をファイルへ書き出す（エージェントはファイルを読む）
  beforeSend: () => Promise<void>
}

type State = 'starting' | 'ready' | 'busy' | 'auth' | 'failed' | 'exited'

interface ToolView {
  el: HTMLElement
  head: HTMLElement
  body: HTMLElement
  data: ToolCallUpdate
  shown: string
}

const DIFF_CONTEXT = 2
const DIFF_MAX_ROWS = 300

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  if (className) el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

function markdown(text: string): string {
  return DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }))
}

class Thread {
  readonly el = element('div', 'thread')
  private log = element('div', 'thread-log')
  private input = element('textarea', 'composer-input')
  private button = element('button', 'composer-send')
  private state: State = 'starting'
  private segment: { kind: 'message' | 'thought'; el: HTMLElement; text: string; frame: number } | null = null
  private tools = new Map<string, ToolView>()
  private plan: HTMLElement | null = null
  private pending = new Map<string, HTMLElement>()

  constructor(
    readonly tab: string,
    readonly agent: AgentConfig,
    private host: ThreadHost
  ) {
    const composer = element('div', 'composer')
    this.input.rows = 1
    this.button.type = 'button'
    composer.append(this.input, this.button)
    this.el.append(this.log, composer)
    this.applyLanguage()

    this.input.addEventListener('keydown', (e) => {
      // 日本語入力の変換を確定する Enter では送らない
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
        e.preventDefault()
        void this.send()
      } else if (e.key === 'Escape' && this.state === 'busy') {
        e.preventDefault()
        this.cancel()
      }
    })
    this.input.addEventListener('input', () => this.autosize())
    this.button.addEventListener('click', () => (this.state === 'busy' ? this.cancel() : void this.send()))
    this.log.addEventListener('click', (e) => {
      const link = (e.target as HTMLElement).closest('a')
      if (!link) return
      e.preventDefault()
      this.host.sumi.openLink(link.href)
    })
  }

  applyLanguage(): void {
    const { tr } = this.host
    this.input.placeholder = tr('ai.ask', { name: this.agent.name })
    this.setState(this.state)
  }

  focus(): void {
    this.input.focus()
  }

  // 起動して新しいセッションを作る。「新しいスレッド」もこれを使う（落ちていれば起動し直す）。
  async start(): Promise<void> {
    if (this.state === 'busy') this.cancel()
    this.log.replaceChildren()
    this.tools.clear()
    this.pending.clear()
    this.segment = null
    this.plan = null
    this.setState('starting')
    const note = this.note(this.host.tr('ai.starting', { name: this.agent.name }), this.host.tr('ai.firstRun'))
    const result = await this.host.sumi.acpStart(this.tab, this.agent.id)
    note.remove()
    this.started(result)
  }

  private started(result: StartResult): void {
    const { tr, sumi } = this.host
    if (result.ok) {
      this.setState('ready')
      if (!this.log.children.length) this.log.append(element('p', 'thread-hint', tr('ai.hint', { name: this.agent.name })))
      return
    }
    if ('auth' in result) {
      this.setState('auth')
      const card = this.note(tr('ai.signIn', { name: this.agent.name }))
      const actions = element('div', 'note-actions')
      for (const method of result.auth) {
        const b = element('button', 'note-button', method.name)
        if (method.description) b.title = method.description
        b.addEventListener('click', async () => {
          for (const other of actions.querySelectorAll('button')) other.disabled = true
          const next = await sumi.acpAuthenticate(this.tab, method.id)
          card.remove()
          this.started(next)
        })
        actions.append(b)
      }
      card.append(actions)
      return
    }
    this.setState('failed')
    this.retryNote(tr('ai.failed', { name: this.agent.name }), result.error)
  }

  async send(): Promise<void> {
    const text = this.input.value.trim()
    if (!text || this.state !== 'ready') return
    this.input.value = ''
    this.autosize()
    this.log.querySelector('.thread-hint')?.remove()
    this.segment = null
    const message = element('div', 'msg-user')
    message.append(element('div', 'msg-user-text', text))
    const summary = this.host.contextSummary()
    if (summary) message.append(element('div', 'msg-context', summary))
    this.log.append(message)
    this.scroll(true)

    this.setState('busy')
    await this.host.beforeSend()
    // 返事の区切りはここでは閉じない。main からの知らせは、完了の返事より後に届くことがある。
    const res = await this.host.sumi.acpPrompt(this.tab, [{ type: 'text', text }, ...this.host.context()])
    const { tr } = this.host
    if (res.error && this.isBusy()) this.note(tr('ai.error'), res.error)
    else if (res.stopReason === 'cancelled') this.note(tr('ai.stopped'))
    else if (res.stopReason === 'refusal') this.note(tr('ai.refusal'))
    else if (res.stopReason === 'max_tokens' || res.stopReason === 'max_turn_requests') this.note(tr('ai.maxTokens'))
    if (this.isBusy()) this.setState('ready')
  }

  // 返事を待つ間に、エージェントが落ちて状態が変わっていることがある
  private isBusy(): boolean {
    return this.state === 'busy'
  }

  cancel(): void {
    if (this.state !== 'busy') return
    this.host.sumi.acpCancel(this.tab)
    for (const box of this.pending.values()) box.replaceChildren(element('span', 'permission-chosen', this.host.tr('ai.stopped')))
    this.pending.clear()
  }

  update(u: SessionUpdate): void {
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        return this.appendText('message', u.content)
      case 'agent_thought_chunk':
        return this.appendText('thought', u.content)
      case 'tool_call':
      case 'tool_call_update':
        this.tool(u)
        return
      case 'plan':
        return this.showPlan(u.entries)
    }
  }

  // 許可の確認。対応する道具の行の下に、エージェントが示した選択肢を並べる。
  permission(key: string, request: RequestPermissionRequest): void {
    const view = this.tool(request.toolCall)
    const box = element('div', 'permission')
    for (const option of request.options) {
      const label = this.host.tr(`perm.${option.kind}` as Key)
      const b = element('button', `permission-button ${option.kind.startsWith('allow') ? 'allow' : 'reject'}`, label)
      b.title = option.name
      b.addEventListener('click', () => {
        this.host.sumi.acpAnswer(key, option.optionId)
        this.pending.delete(key)
        box.replaceChildren(element('span', 'permission-chosen', label))
      })
      box.append(b)
    }
    view.el.append(box)
    this.pending.set(key, box)
    this.scroll(true)
  }

  exited(detail: string): void {
    this.setState('exited')
    this.pending.clear()
    this.retryNote(this.host.tr('ai.agentExited', { name: this.agent.name }), detail)
  }

  private retryNote(title: string, detail: string): void {
    const card = this.note(title, detail)
    const again = element('button', 'note-button', this.host.tr('ai.restart'))
    again.addEventListener('click', () => void this.start())
    const actions = element('div', 'note-actions')
    actions.append(again)
    card.append(actions)
  }

  private appendText(kind: 'message' | 'thought', content: ContentBlock): void {
    if (content.type !== 'text') return
    if (this.segment?.kind !== kind) {
      let el: HTMLElement
      if (kind === 'message') {
        el = element('div', 'msg-agent markdown')
        this.log.append(el)
      } else {
        const details = element('details', 'thought')
        details.append(element('summary', '', this.host.tr('ai.thinking')))
        el = element('div', 'markdown')
        details.append(el)
        this.log.append(details)
      }
      this.segment = { kind, el, text: '', frame: 0 }
    }
    // 細切れに届くので、描き直しは区切りごとに 1 フレームに 1 回
    const segment = this.segment
    segment.text += content.text
    cancelAnimationFrame(segment.frame)
    segment.frame = requestAnimationFrame(() => {
      segment.el.innerHTML = markdown(segment.text)
      this.scroll()
    })
  }

  private tool(u: ToolCallUpdate): ToolView {
    let view = this.tools.get(u.toolCallId)
    if (!view) {
      const el = element('div', 'tool')
      const head = element('div', 'tool-head')
      const body = element('div', 'tool-body')
      el.append(head, body)
      this.log.append(el)
      view = { el, head, body, data: { toolCallId: u.toolCallId }, shown: '' }
      this.tools.set(u.toolCallId, view)
      this.segment = null
    }
    for (const [k, v] of Object.entries(u)) if (v !== undefined && v !== null) (view.data as Record<string, unknown>)[k] = v
    this.renderTool(view)
    this.scroll()
    return view
  }

  private renderTool(view: ToolView): void {
    const { title, status, kind, content } = view.data
    view.el.dataset.status = status ?? 'pending'
    let added = 0
    let removed = 0
    // 中身が変わったときだけ描き直す（開いた「出力」が閉じないように）
    const shown = JSON.stringify(content ?? [])
    if (shown !== view.shown) {
      view.shown = shown
      view.body.replaceChildren()
      for (const c of content ?? []) this.renderContent(view.body, c, kind)
    }
    for (const row of view.body.querySelectorAll('.diff-row')) {
      if (row.classList.contains('add')) added++
      if (row.classList.contains('del')) removed++
    }
    view.head.replaceChildren(element('i', 'tool-dot'), element('span', 'tool-title', title || kind || ''))
    if (added || removed) view.head.append(element('span', 'tool-stat', `+${added} −${removed}`))
    if (status === 'failed') view.head.append(element('span', 'tool-stat', this.host.tr('ai.toolFailed')))
  }

  private renderContent(body: HTMLElement, c: ToolCallContent, kind: ToolCallUpdate['kind']): void {
    if (c.type === 'diff') {
      body.append(this.diff(c.path, c.oldText ?? '', c.newText))
    } else if (c.type === 'content' && c.content.type === 'text' && c.content.text.trim() && kind !== 'read') {
      const details = element('details', 'tool-output')
      details.append(element('summary', '', this.host.tr('ai.output')), element('pre', '', c.content.text.slice(0, 20000)))
      body.append(details)
    }
  }

  // 行ごとの差分。変わっていない行は前後 2 行だけ残して畳む。
  private diff(path: string, oldText: string, newText: string): HTMLElement {
    const box = element('div', 'diff')
    box.append(element('div', 'diff-path', this.host.relative(path)))
    const parts = diffLines(oldText, newText)
    let rows = 0
    let hidden = 0
    const row = (cls: string, text: string): void => {
      if (rows >= DIFF_MAX_ROWS) {
        hidden++
        return
      }
      rows++
      box.append(element('div', `diff-row ${cls}`, text || ' '))
    }
    parts.forEach((part, i) => {
      const lines = part.value.replace(/\n$/, '').split('\n')
      if (part.added) for (const l of lines) row('add', l)
      else if (part.removed) for (const l of lines) row('del', l)
      else {
        const head = i === 0 ? [] : lines.slice(0, DIFF_CONTEXT)
        const tail = i === parts.length - 1 ? [] : lines.slice(-DIFF_CONTEXT)
        if (head.length + tail.length >= lines.length) for (const l of lines) row('same', l)
        else {
          for (const l of head) row('same', l)
          row('gap', '⋯')
          for (const l of tail) row('same', l)
        }
      }
    })
    if (hidden) box.append(element('div', 'diff-more', this.host.tr('ai.moreLines', { n: hidden })))
    return box
  }

  private showPlan(entries: PlanEntry[]): void {
    if (!this.plan) {
      this.plan = element('ul', 'plan')
      this.log.append(this.plan)
      this.segment = null
    }
    this.plan.replaceChildren(
      ...entries.map((e) => {
        const li = element('li', '', e.content)
        li.dataset.status = e.status
        return li
      })
    )
    this.scroll()
  }

  private note(title: string, detail?: string): HTMLElement {
    const card = element('div', 'note')
    card.append(element('div', 'note-title', title))
    if (detail) card.append(element('pre', 'note-detail', detail))
    this.log.append(card)
    this.scroll(true)
    return card
  }

  private setState(state: State): void {
    this.state = state
    const busy = state === 'busy'
    this.button.dataset.state = busy ? 'stop' : 'send'
    this.button.textContent = busy ? '■' : '⏎'
    this.button.title = this.host.tr(busy ? 'ai.stop' : 'ai.send')
    this.button.disabled = !busy && state !== 'ready'
  }

  private autosize(): void {
    this.input.style.height = 'auto'
    this.input.style.height = `${Math.min(this.input.scrollHeight, 180)}px`
  }

  // 一番下を見ているときだけ追いかける（読み返しているときは動かさない）
  private scroll(force = false): void {
    const near = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 80
    if (force || near) this.log.scrollTop = this.log.scrollHeight
  }
}

export class ThreadPane {
  private threads = new Map<string, Thread>()
  private current: Thread | null = null

  constructor(
    private host: HTMLElement,
    private h: ThreadHost
  ) {
    h.sumi.onAcpUpdate((tab, u) => this.threads.get(tab)?.update(u))
    h.sumi.onAcpPermission((tab, key, request) => {
      const thread = this.threads.get(tab)
      if (thread) thread.permission(key, request)
      else h.sumi.acpAnswer(key, null)
    })
    h.sumi.onAcpExit((tab, detail) => this.threads.get(tab)?.exited(detail))
  }

  // そのタブを初めて出すときは、エージェントを起動して新しいセッションを作る
  show(tab: string, agent: AgentConfig, focus = true): void {
    let thread = this.threads.get(tab)
    if (!thread) {
      thread = new Thread(tab, agent, this.h)
      this.threads.set(tab, thread)
      this.host.append(thread.el)
      void thread.start()
    }
    for (const t of this.threads.values()) t.el.hidden = t !== thread
    this.current = thread
    if (focus) thread.focus()
  }

  newThread(): void {
    void this.current?.start()
  }

  focus(): void {
    this.current?.focus()
  }

  hasFocus(): boolean {
    return this.host.contains(document.activeElement)
  }

  applyLanguage(): void {
    for (const t of this.threads.values()) t.applyLanguage()
  }

  // タブを閉じたとき・エージェントの設定を変えたとき。main 側のセッションも閉じる（もう止まっていれば何もしない）。
  drop(tab: string): void {
    const thread = this.threads.get(tab)
    if (!thread) return
    this.h.sumi.acpClose(tab)
    thread.el.remove()
    this.threads.delete(tab)
    if (this.current === thread) this.current = null
  }

  // フォルダを替えたとき・AI を切ったとき
  reset(): void {
    for (const tab of [...this.threads.keys()]) this.drop(tab)
  }
}
