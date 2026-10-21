// 右の柱で呼び出すエージェント。ACP に対応したものは Sumi の会話画面で、それ以外は端末ごと動かす。
// 画面（設定の「元に戻す」）と main の両方から使うので shared に置く。

export type AgentKind = 'acp' | 'terminal'

export interface AgentConfig {
  id: string
  name: string
  kind: AgentKind
  command: string
  args: string[]
  env?: Record<string, string>
}

// 最初から入れるのは 2 つだけ。ほかは必要になったら設定の登録簿から足す。
// 版は ACP の登録簿（cdn.agentclientprotocol.com/registry）に載っているものに合わせる。
export const DEFAULT_AGENTS: AgentConfig[] = [
  { id: 'claude', name: 'Claude Code', kind: 'acp', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.94.0'] },
  { id: 'codex', name: 'Codex', kind: 'acp', command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp@2.2.2'] }
]

// 登録簿の 1 件。installed が false なら、この Mac に入っていない（専用のアプリを別に入れる必要がある）。
export interface RegistryAgent {
  agent: AgentConfig
  description: string
  website: string | null
  installed: boolean
}
