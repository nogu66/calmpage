import { basename } from 'node:path'
import type { AgentConfig, RegistryAgent } from '../shared/agents'
import { agentEnv, which } from './shell-env'

// ACP の登録簿（Zed などと同じ一覧）。npx / uvx で動くものはそのまま追加でき、
// 専用のアプリを入れるものは、この Mac に入っているときだけ追加できる。
const URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
const PLATFORM = process.arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64'

interface Package {
  package: string
  args?: string[]
  env?: Record<string, string>
}

interface Entry {
  id: string
  name: string
  description?: string
  website?: string
  distribution: {
    npx?: Package
    uvx?: Package
    binary?: Record<string, { cmd: string; args?: string[]; env?: Record<string, string> }>
  }
}

let cache: Promise<RegistryAgent[]> | null = null

export function loadRegistry(): Promise<RegistryAgent[]> {
  cache ??= fetchRegistry().catch((err) => {
    cache = null
    throw err
  })
  return cache
}

async function fetchRegistry(): Promise<RegistryAgent[]> {
  const res = await fetch(URL)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const { agents } = (await res.json()) as { agents: Entry[] }
  const { PATH } = await agentEnv()
  return agents
    .map((e) => toAgent(e, PATH))
    .filter((a): a is RegistryAgent => a !== null)
    .sort((a, b) => a.agent.name.localeCompare(b.agent.name))
}

function toAgent(e: Entry, path: string): RegistryAgent | null {
  const info = { description: e.description ?? '', website: e.website ?? null }
  const base = { id: e.id, name: e.name, kind: 'acp' as const }
  const d = e.distribution
  const agent = (command: string, args: string[], env?: Record<string, string>): AgentConfig => ({ ...base, command, args, ...(env ? { env } : {}) })
  if (d.npx) return { ...info, agent: agent('npx', ['-y', d.npx.package, ...(d.npx.args ?? [])], d.npx.env), installed: true }
  if (d.uvx) return { ...info, agent: agent('uvx', [d.uvx.package, ...(d.uvx.args ?? [])], d.uvx.env), installed: !!which('uvx', path) }
  const bin = d.binary?.[PLATFORM]
  if (!bin) return null
  const command = basename(bin.cmd)
  return { ...info, agent: agent(command, bin.args ?? [], bin.env), installed: !!which(command, path) }
}
