// 右の柱で呼び出すエージェント。ACP に対応したものは Calmpage の会話画面で、それ以外は端末ごと動かす。
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

// 起動するときに、利用者のログインシェル（$SHELL）に置き換える
export const LOGIN_SHELL = '$SHELL'

// 最初から入れるのは Claude Code と Codex、それに素の端末だけ。ほかは必要になったら設定の登録簿から足す。
// 端末では claude などの CLI をそのまま動かせるので、ACP では使えないスラッシュコマンドもそこで使える。
// 版は ACP の登録簿（cdn.agentclientprotocol.com/registry）に載っているものに合わせる。
export const DEFAULT_AGENTS: AgentConfig[] = [
  { id: 'claude', name: 'Claude Code', kind: 'acp', command: 'npx', args: ['-y', '@agentclientprotocol/claude-agent-acp@0.94.0'] },
  { id: 'codex', name: 'Codex', kind: 'acp', command: 'npx', args: ['-y', '@agentclientprotocol/codex-acp@2.2.2'] },
  { id: 'terminal', name: 'Terminal', kind: 'terminal', command: LOGIN_SHELL, args: ['-l'] }
]

// 登録簿の 1 件と、この Mac での使いみち。
// ready はそのまま足せる（npx・uvx・PATH にあるもの）。install は配布物を取ってきて入れられる。
export type RegistryStatus =
  | { kind: 'ready'; agent: AgentConfig }
  | { kind: 'install' }
  | { kind: 'unavailable'; reason: 'npx' | 'uvx' | 'platform' }

export interface RegistryAgent {
  id: string
  name: string
  version: string
  description: string
  website: string | null
  status: RegistryStatus
  // 設定のエージェントと照らし合わせる手がかり。npx / uvx はパッケージ名、binary は入れる場所
  match: { package?: string; dir?: string }
}

// 入れている途中の様子。main から届く
export type InstallProgress =
  | { phase: 'download'; received: number; total: number | null }
  | { phase: 'extract' }
  | { phase: 'done' }
  | { phase: 'failed'; error: string }

// 「@scope/name@1.2.3」「name==0.1」から版を除く
export function packageName(spec: string): string {
  return spec.replace(/(?!^)@[^/@]*$/, '').replace(/[=<>~!]=.*$/, '')
}

// npx / uvx で動かす ACP のエージェントなら、そのパッケージ名
export function agentPackage(agent: AgentConfig): string | null {
  if (agent.kind !== 'acp' || !/(^|\/)(npx|uvx)$/.test(agent.command)) return null
  const spec = agent.args.find((a) => !a.startsWith('-'))
  return spec ? packageName(spec) : null
}

// 登録簿の件が、もう設定にあるか。既定の Claude Code と Codex は id が違うので、パッケージ名で比べる
export function findAdded(entry: RegistryAgent, agents: AgentConfig[]): AgentConfig | undefined {
  const { package: pkg, dir } = entry.match
  return agents.find((a) => a.id === entry.id || (pkg && agentPackage(a) === pkg) || (dir && a.command.startsWith(`${dir}/`)))
}
