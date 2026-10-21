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
// Sumitex はクライアント側: 会話の流れ（session/update）と許可の確認を画面へ渡し、ファイルの読み書きに応える。

const AUTH_REQUIRED = -32000

export type StartResult =
  | { ok: true }
  | { ok: false; auth: { id: string; name: string; description?: string | null }[] }
  | { ok: false; error: string }

interface Running {
  child: ChildProcess
  conn: acp.ClientConnection
  ready: Promise<acp.InitializeResponse>
  sessionId: string | null
  cwd: string
  stderr: string
}

function message(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

export class AcpAgents {
  private agents = new Map<string, Running>()
  private permissions = new Map<string, { agent: string; resolve: (r: acp.RequestPermissionResponse) => void }>()

  constructor(private send: (channel: string, ...args: unknown[]) => void) {}

  // 起動してセッションを作る。サインインが要るときは、その方法を返す。
  async start(agent: AgentConfig, cwd: string): Promise<StartResult> {
    let running = this.agents.get(agent.id)
    if (!running) {
      const spawned = await this.spawn(agent, cwd)
      if ('error' in spawned) return { ok: false, error: spawned.error }
      running = spawned
    }
    return this.newSession(agent.id)
  }

  async newSession(id: string): Promise<StartResult> {
    const running = this.agents.get(id)
    if (!running) return { ok: false, error: 'not running' }
    try {
      await running.ready
      const session = await running.conn.agent.request(acp.methods.agent.session.new, { cwd: running.cwd, mcpServers: [] })
      running.sessionId = session.sessionId
      return { ok: true }
    } catch (err) {
      if (err instanceof acp.RequestError && err.code === AUTH_REQUIRED) {
        const methods = (await running.ready.catch(() => null))?.authMethods ?? []
        return { ok: false, auth: methods.map((m) => ({ id: m.id, name: m.name, description: m.description })) }
      }
      return { ok: false, error: this.explain(running, err) }
    }
  }

  async authenticate(id: string, methodId: string): Promise<StartResult> {
    const running = this.agents.get(id)
    if (!running) return { ok: false, error: 'not running' }
    try {
      await running.conn.agent.request(acp.methods.agent.authenticate, { methodId })
    } catch (err) {
      return { ok: false, error: this.explain(running, err) }
    }
    return this.newSession(id)
  }

  // 1 回分のやり取り。終わった理由（end_turn / cancelled など）を返す。
  async prompt(id: string, prompt: acp.ContentBlock[]): Promise<{ stopReason?: string; error?: string }> {
    const running = this.agents.get(id)
    if (!running?.sessionId) return { error: 'not running' }
    try {
      const res = await running.conn.agent.request(acp.methods.agent.session.prompt, { sessionId: running.sessionId, prompt })
      return { stopReason: res.stopReason }
    } catch (err) {
      return { error: this.explain(running, err) }
    }
  }

  // 中断。答えを待っている許可の確認は「取り消し」で返す（ACP の決まり）。
  cancel(id: string): void {
    const running = this.agents.get(id)
    for (const [key, p] of this.permissions) {
      if (p.agent !== id) continue
      p.resolve({ outcome: { outcome: 'cancelled' } })
      this.permissions.delete(key)
    }
    if (running?.sessionId) void running.conn.agent.notify(acp.methods.agent.session.cancel, { sessionId: running.sessionId })
  }

  answerPermission(key: string, optionId: string | null): void {
    const pending = this.permissions.get(key)
    if (!pending) return
    this.permissions.delete(key)
    pending.resolve({ outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } })
  }

  stop(id: string): void {
    const running = this.agents.get(id)
    if (!running) return
    this.cancel(id)
    this.agents.delete(id)
    running.conn.close()
    running.child.kill()
  }

  stopAll(): void {
    for (const id of [...this.agents.keys()]) this.stop(id)
  }

  private async spawn(agent: AgentConfig, cwd: string): Promise<Running | { error: string }> {
    const env = await agentEnv()
    const file = which(agent.command, env.PATH)
    if (!file) return { error: t(loadSettings().language, 'ai.notFound', { command: agent.command }) }
    const child = spawn(file, agent.args, { cwd, env: { ...env, ...agent.env }, stdio: ['pipe', 'pipe', 'pipe'] })
    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>
    )
    const conn = acp
      .client({ name: 'Sumitex' })
      .onNotification(acp.methods.client.session.update, ({ params }) => this.send('acp:update', agent.id, params.update))
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
      sessionId: null,
      stderr: '',
      ready: conn.agent.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { name: 'Sumitex', version: app.getVersion() }
      })
    }
    running.ready.catch(() => {}) // 失敗は newSession で拾う
    // ログは標準エラーに出る。詰まらないよう読み続け、終了時の説明用に末尾だけ残す。
    child.stderr!.on('data', (d: Buffer) => (running.stderr = (running.stderr + d.toString()).slice(-4000)))
    child.on('error', (err) => (running.stderr += `\n${message(err)}`))
    child.on('exit', (code) => {
      if (this.agents.get(agent.id) !== running) return
      this.agents.delete(agent.id)
      this.cancel(agent.id)
      this.send('acp:exit', agent.id, lastLines(running.stderr) || `exit ${code}`)
    })
    this.agents.set(agent.id, running)
    return running
  }

  private askPermission(agent: string, params: acp.RequestPermissionRequest, signal: AbortSignal): Promise<acp.RequestPermissionResponse> {
    return new Promise((resolve) => {
      const key = randomUUID()
      this.permissions.set(key, { agent, resolve })
      signal.addEventListener('abort', () => this.answerPermission(key, null))
      this.send('acp:permission', agent, key, params)
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
