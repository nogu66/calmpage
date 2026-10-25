import * as acp from '@agentclientprotocol/sdk'
import { app } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { Readable, Writable } from 'node:stream'
import { t } from '../shared/i18n'
import { agentEnv, which } from './shell-env'
import { loadSettings, type AgentConfig } from './settings'

// ACP（Agent Client Protocol）に対応したエージェントを子プロセスで起動し、標準入出力の JSON-RPC で話す。
// Calmpage はクライアント側: 会話の流れ（session/update）と許可の確認を画面へ渡し、ファイルの読み書きに応える。

const AUTH_REQUIRED = -32000

export type StartResult =
  | { ok: true }
  | { ok: false; auth: { id: string; name: string; description?: string | null }[] }
  | { ok: false; error: string }

interface Running {
  child: ChildProcess
  conn: acp.ClientConnection
  ready: Promise<acp.InitializeResponse>
  cwd: string
  stderr: string
}

// 柱のタブ 1 つ分。同じエージェントのタブは 1 つのプロセスを分け合い、それぞれ別のセッションを持つ。
interface Tab {
  agent: string
  sessionId: string | null
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export class AcpAgents {
  private agents = new Map<string, Running>()
  private tabs = new Map<string, Tab>()
  private permissions = new Map<string, { tab: string; resolve: (r: acp.RequestPermissionResponse) => void }>()

  constructor(private send: (channel: string, ...args: unknown[]) => void) {}

  // 起動してセッションを作る（もう動いていれば、そのプロセスに新しいセッションを足す）。サインインが要るときは、その方法を返す。
  async start(tab: string, agent: AgentConfig, cwd: string): Promise<StartResult> {
    if (!this.agents.has(agent.id)) {
      const env = await agentEnv()
      // 待つ間に、同じエージェントの別のタブが起動していることがある
      if (!this.agents.has(agent.id)) {
        const spawned = this.spawn(agent, cwd, env)
        if ('error' in spawned) return { ok: false, error: spawned.error }
      }
    }
    // 「新しいスレッド」でも呼ばれる。前のセッションは newSession が片付ける。
    if (!this.tabs.has(tab)) this.tabs.set(tab, { agent: agent.id, sessionId: null })
    return this.newSession(tab)
  }

  async newSession(tab: string): Promise<StartResult> {
    const entry = this.tabs.get(tab)
    const running = entry && this.agents.get(entry.agent)
    if (!entry || !running) return { ok: false, error: 'not running' }
    try {
      await running.ready
      const old = entry.sessionId
      const session = await running.conn.agent.request(acp.methods.agent.session.new, { cwd: running.cwd, mcpServers: [] })
      entry.sessionId = session.sessionId
      if (old) void this.closeSession(running, old)
      return { ok: true }
    } catch (err) {
      if (err instanceof acp.RequestError && err.code === AUTH_REQUIRED) {
        const methods = (await running.ready.catch(() => null))?.authMethods ?? []
        return { ok: false, auth: methods.map((m) => ({ id: m.id, name: m.name, description: m.description })) }
      }
      return { ok: false, error: this.explain(running, err) }
    }
  }

  async authenticate(tab: string, methodId: string): Promise<StartResult> {
    const entry = this.tabs.get(tab)
    const running = entry && this.agents.get(entry.agent)
    if (!running) return { ok: false, error: 'not running' }
    try {
      await running.conn.agent.request(acp.methods.agent.authenticate, { methodId })
    } catch (err) {
      return { ok: false, error: this.explain(running, err) }
    }
    return this.newSession(tab)
  }

  // 1 回分のやり取り。終わった理由（end_turn / cancelled など）を返す。
  async prompt(tab: string, prompt: acp.ContentBlock[]): Promise<{ stopReason?: string; error?: string }> {
    const entry = this.tabs.get(tab)
    const running = entry && this.agents.get(entry.agent)
    if (!running || !entry.sessionId) return { error: 'not running' }
    try {
      const res = await running.conn.agent.request(acp.methods.agent.session.prompt, { sessionId: entry.sessionId, prompt })
      return { stopReason: res.stopReason }
    } catch (err) {
      return { error: this.explain(running, err) }
    }
  }

  // 中断。答えを待っている許可の確認は「取り消し」で返す（ACP の決まり）。
  cancel(tab: string): void {
    for (const [key, p] of this.permissions) {
      if (p.tab !== tab) continue
      p.resolve({ outcome: { outcome: 'cancelled' } })
      this.permissions.delete(key)
    }
    const entry = this.tabs.get(tab)
    const running = entry && this.agents.get(entry.agent)
    if (running && entry.sessionId) void running.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: entry.sessionId })
  }

  answerPermission(key: string, optionId: string | null): void {
    const pending = this.permissions.get(key)
    if (!pending) return
    this.permissions.delete(key)
    pending.resolve({ outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } })
  }

  // タブを閉じたとき。そのエージェントのタブがほかになければ、プロセスごと止める。
  close(tab: string): void {
    const entry = this.tabs.get(tab)
    if (!entry) return
    this.cancel(tab)
    this.tabs.delete(tab)
    const running = this.agents.get(entry.agent)
    if (!running) return
    if (![...this.tabs.values()].some((t) => t.agent === entry.agent)) this.stop(entry.agent)
    else if (entry.sessionId) void this.closeSession(running, entry.sessionId)
  }

  // エージェントの設定を変えた・消したとき。そのエージェントのタブはすべて止まる。
  stop(agent: string): void {
    for (const [tab, t] of [...this.tabs]) {
      if (t.agent !== agent) continue
      this.cancel(tab)
      this.tabs.delete(tab)
    }
    const running = this.agents.get(agent)
    if (!running) return
    this.agents.delete(agent)
    running.conn.close()
    running.child.kill()
  }

  stopAll(): void {
    for (const id of [...this.agents.keys()]) this.stop(id)
  }

  // 使い終わったセッションを片付ける。対応していないエージェントには送らない。
  private async closeSession(running: Running, sessionId: string): Promise<void> {
    const init = await running.ready.catch(() => null)
    if (!init?.agentCapabilities?.sessionCapabilities?.close) return
    await running.conn.agent.request(acp.methods.agent.session.close, { sessionId }).catch(() => {})
  }

  private tabOf(agent: string, sessionId: string): string | undefined {
    for (const [tab, t] of this.tabs) if (t.agent === agent && t.sessionId === sessionId) return tab
  }

  private spawn(agent: AgentConfig, cwd: string, env: Record<string, string>): Running | { error: string } {
    const file = which(agent.command, env.PATH)
    if (!file) return { error: t(loadSettings().language, 'ai.notFound', { command: agent.command }) }
    const child = spawn(file, agent.args, { cwd, env: { ...env, ...agent.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    )
    const conn = acp
      .client({ name: 'Calmpage' })
      .onNotification(acp.methods.client.session.update, ({ params }) => {
        const tab = this.tabOf(agent.id, params.sessionId)
        if (tab) this.send('acp:update', tab, params.update)
      })
      .onRequest(acp.methods.client.session.requestPermission, ({ params, signal }) => this.askPermission(agent.id, params, signal))
      .onRequest(acp.methods.client.fs.readTextFile, async ({ params }) => ({ content: await readLines(params.path, params.line, params.limit) }))
      // 書いたファイルは監視が拾い、エディターが読み直して組み直す
      .onRequest(acp.methods.client.fs.writeTextFile, async ({ params }) => {
        await writeFile(params.path, params.content, 'utf8')
        return {}
      })
      .connect(stream)
    const running: Running = {
      child,
      conn,
      cwd,
      stderr: '',
      ready: conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { name: 'Calmpage', version: app.getVersion() }
      })
    }
    running.ready.catch(() => {}) // 失敗は newSession で拾う
    // ログは標準エラーに出る。詰まらないよう読み続け、終了時の説明用に末尾だけ残す。
    child.stderr!.on('data', (d: Buffer) => (running.stderr = (running.stderr + d.toString()).slice(-4000)))
    child.on('error', (err) => (running.stderr += `\n${message(err)}`))
    // 落ちたら、そのプロセスを使っていたタブすべてに知らせる
    child.on('exit', (code) => {
      if (this.agents.get(agent.id) !== running) return
      this.agents.delete(agent.id)
      const detail = lastLines(running.stderr) || `exit ${code}`
      for (const [tab, t] of [...this.tabs]) {
        if (t.agent !== agent.id) continue
        this.cancel(tab)
        this.tabs.delete(tab)
        this.send('acp:exit', tab, detail)
      }
    })
    this.agents.set(agent.id, running)
    return running
  }

  private askPermission(agent: string, params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    const tab = this.tabOf(agent, params.sessionId)
    if (!tab) return Promise.resolve({ outcome: { outcome: 'cancelled' } })
    return new Promise((resolve) => {
      const key = randomUUID()
      this.permissions.set(key, { tab, resolve })
      signal.addEventListener('abort', () => this.answerPermission(key, null))
      this.send('acp:permission', tab, key, params)
    })
  }

  // エラーの説明。プロセスが落ちていたら、標準エラーの末尾のほうが手がかりになる。
  private explain(running: Running, err: unknown): string {
    const tail = lastLines(running.stderr)
    const text = message(err)
    return running.child.exitCode !== null && tail ? `${text}\n${tail}` : text
  }
}

function lastLines(text: string, n = 6): string {
  return text.trim().split('\n').slice(-n).join('\n')
}

async function readLines(path: string, line?: number | null, limit?: number | null): Promise<string> {
  const text = await readFile(path, 'utf8')
  if (!line && !limit) return text
  const lines = text.split('\n')
  const start = Math.max(0, (line ?? 1) - 1)
  return lines.slice(start, limit ? start + limit : undefined).join('\n')
}
