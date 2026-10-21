import { Terminal, type ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { SumiApi } from '../preload'

// 端末のエージェント（ACP に対応していない CLI）を、端末ごと埋め込む。セッションはエージェントごとに生かしておく。

// 16 色は CLI が使う。紙の明るい地でも読めるよう、明るさごとに濃さを変える。
const LIGHT_ANSI: ITheme = {
  black: '#1a1a1a', red: '#b3261e', green: '#2e7d32', yellow: '#8a6d00',
  blue: '#1f5fbf', magenta: '#8e3fa8', cyan: '#00797a', white: '#6b6b68',
  brightBlack: '#8a8a86', brightRed: '#d0342c', brightGreen: '#388e3c', brightYellow: '#a37f00',
  brightBlue: '#2a6fd6', brightMagenta: '#a24cc0', brightCyan: '#008c8c', brightWhite: '#1a1a1a'
}

const DARK_ANSI: ITheme = {
  black: '#1a1a1a', red: '#e06c6c', green: '#8fbf7f', yellow: '#d9b56b',
  blue: '#7aa2e3', magenta: '#c58fd6', cyan: '#6cc4c4', white: '#d0d0cc',
  brightBlack: '#6b6b68', brightRed: '#f08080', brightGreen: '#a6d496', brightYellow: '#e8c98a',
  brightBlue: '#98b8f0', brightMagenta: '#d6a8e3', brightCyan: '#8ad6d6', brightWhite: '#f4f4f2'
}

// Shift+Enter は Alt+Enter（ESC + CR）として送る。多くの CLI がこれを改行として扱う。
const NEWLINE = '\x1b\r'

interface Session {
  term: Terminal
  fit: FitAddon
  el: HTMLElement
  state: 'idle' | 'running' | 'exited'
}

function theme(): ITheme {
  const css = getComputedStyle(document.documentElement)
  const v = (name: string): string => css.getPropertyValue(name).trim()
  const dark = matchMedia('(prefers-color-scheme: dark)').matches
  return {
    ...(dark ? DARK_ANSI : LIGHT_ANSI),
    background: v('--card'),
    foreground: v('--text'),
    cursor: v('--text'),
    cursorAccent: v('--card'),
    selectionBackground: dark ? 'rgba(230, 230, 228, 0.22)' : 'rgba(26, 26, 26, 0.14)'
  }
}

export class TerminalPane {
  private sessions = new Map<string, Session>()
  agent = ''

  constructor(
    private host: HTMLElement,
    private sumi: SumiApi,
    private messages: () => { exited: string }
  ) {
    new ResizeObserver(() => this.fitCurrent()).observe(host)
    sumi.onTermData((id, data) => this.sessions.get(id)?.term.write(data))
    sumi.onTermExit((id) => this.onExit(id))
  }

  // 柱が見えているときに呼ぶ。その CLI を初めて出すときは起動する。
  async show(agent: string, focus = true): Promise<void> {
    this.agent = agent
    const session = this.session(agent)
    for (const [a, s] of this.sessions) s.el.hidden = a !== agent
    this.fitCurrent()
    if (focus) session.term.focus()
    if (session.state === 'idle') await this.start(agent, session)
  }

  focus(): void {
    this.sessions.get(this.agent)?.term.focus()
  }

  hasFocus(): boolean {
    return this.host.contains(document.activeElement)
  }

  // チップの中身を入力欄に貼り込む（CLI が対応していれば括弧付きペーストになり、送信はされない）
  insert(text: string): void {
    const session = this.sessions.get(this.agent)
    if (session?.state !== 'running') return
    session.term.paste(text)
    session.term.focus()
  }

  applyTheme(): void {
    for (const s of this.sessions.values()) s.term.options.theme = theme()
  }

  hide(): void {
    for (const s of this.sessions.values()) s.el.hidden = true
  }

  // エージェントの設定を変えたとき・消したとき
  drop(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    s.term.dispose()
    s.el.remove()
    this.sessions.delete(id)
  }

  // フォルダを替えたとき。main 側のセッションはもう止まっている。
  reset(): void {
    for (const s of this.sessions.values()) {
      s.term.dispose()
      s.el.remove()
    }
    this.sessions.clear()
  }

  private session(agent: string): Session {
    const existing = this.sessions.get(agent)
    if (existing) return existing
    const el = document.createElement('div')
    el.className = 'ai-term'
    this.host.append(el)
    const term = new Terminal({
      allowProposedApi: true,
      fontFamily: "'SF Mono', Menlo, 'Hiragino Sans', monospace",
      fontSize: 12,
      lineHeight: 1.2,
      scrollback: 5000,
      theme: theme()
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.loadAddon(new WebLinksAddon((_e, url) => this.sumi.openLink(url)))
    term.open(el)
    const session: Session = { term, fit, el, state: 'idle' }
    term.attachCustomKeyEventHandler((e) => {
      if (e.key !== 'Enter' || !e.shiftKey || e.metaKey) return true
      if (e.type === 'keydown' && session.state === 'running') this.sumi.termInput(agent, NEWLINE)
      return false
    })
    term.onData((data) => {
      if (session.state === 'running') this.sumi.termInput(agent, data)
      else if (session.state === 'exited' && data === '\r') {
        term.reset()
        void this.start(agent, session)
      }
    })
    term.onResize(({ cols, rows }) => {
      if (session.state === 'running') this.sumi.termResize(agent, cols, rows)
    })
    this.sessions.set(agent, session)
    return session
  }

  private async start(agent: string, session: Session): Promise<void> {
    session.state = 'running'
    const error = await this.sumi.termStart(agent, session.term.cols, session.term.rows)
    if (!error) return
    session.state = 'exited'
    session.term.write(`\x1b[2m${error}\x1b[0m\r\n`)
  }

  private onExit(agent: string): void {
    const session = this.sessions.get(agent)
    if (!session) return
    session.state = 'exited'
    session.term.write(`\r\n\x1b[2m${this.messages().exited}\x1b[0m\r\n`)
  }

  // 見えていない（幅 0 の）ときに合わせると桁数が壊れるので、見えている端末だけ合わせる
  private fitCurrent(): void {
    const session = this.sessions.get(this.agent)
    if (!session || session.el.hidden || this.host.clientWidth === 0) return
    session.fit.fit()
  }
}
