import { spawn, type IDisposable, type IPty } from 'node-pty'
import { LOGIN_SHELL } from '../shared/agents'
import { t } from '../shared/i18n'
import { agentEnv, which } from './shell-env'
import { loadSettings, type AgentConfig } from './settings'

// ACP に対応していない CLI は、端末（pty）ごと起動して、入出力をそのまま画面の xterm.js とやり取りする。
// 同じエージェントを何本でも開けるよう、端末は柱のタブごとに持つ。

interface Session {
  agent: string
  pty: IPty
  listeners: IDisposable[]
}

export class Terminals {
  private sessions = new Map<string, Session>()

  constructor(private send: (channel: string, ...args: unknown[]) => void) {}

  // 起動できなければ、画面に出す理由を返す
  async start(tab: string, agent: AgentConfig, cwd: string, cols: number, rows: number): Promise<string | null> {
    if (this.sessions.has(tab)) return null
    const env = await agentEnv()
    if (this.sessions.has(tab)) return null
    env.TERM = 'xterm-256color'
    env.COLORTERM = 'truecolor'
    env.TERM_PROGRAM = 'Calmpage'
    delete env.TERM_PROGRAM_VERSION
    const command = agent.command === LOGIN_SHELL ? env.SHELL || '/bin/zsh' : agent.command
    const file = which(command, env.PATH)
    if (!file) return t(loadSettings().language, 'ai.notFound', { command })
    let pty: IPty
    try {
      pty = spawn(file, agent.args, { name: 'xterm-256color', cols, rows, cwd, env: { ...env, ...agent.env } })
    } catch (err) {
      return String(err)
    }
    const session: Session = { agent: agent.id, pty, listeners: [] }
    session.listeners.push(
      pty.onData((data) => this.send('term:data', tab, data)),
      pty.onExit(({ exitCode }) => {
        this.sessions.delete(tab)
        this.send('term:exit', tab, exitCode)
      })
    )
    this.sessions.set(tab, session)
    return null
  }

  write(tab: string, data: string): void {
    this.sessions.get(tab)?.pty.write(data)
  }

  resize(tab: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.sessions.get(tab)?.pty.resize(cols, rows)
  }

  // タブを閉じたとき。止めた知らせは画面へ送らない（画面側は自分で端末を片付ける）
  close(tab: string): void {
    const session = this.sessions.get(tab)
    if (!session) return
    for (const l of session.listeners) l.dispose()
    session.pty.kill()
    this.sessions.delete(tab)
  }

  // エージェントの設定を変えた・消したときは、そのエージェントのタブをすべて止める
  stop(agent: string): void {
    for (const [tab, s] of [...this.sessions]) if (s.agent === agent) this.close(tab)
  }

  stopAll(): void {
    for (const tab of [...this.sessions.keys()]) this.close(tab)
  }
}
