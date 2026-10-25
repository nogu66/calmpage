import { app } from 'electron'
import { basename, join } from 'node:path'
import { packageName, type AgentConfig, type RegistryAgent, type RegistryStatus } from '../shared/agents'
import { agentEnv, which } from './shell-env'

// ACP の登録簿（Zed などと同じ一覧）。npx / uvx で動くものはそのまま足せる。
// 専用の配布物（binary）は、この Mac の PATH にあればそれを使い、なければ取ってきて userData/agents/ に入れる。
const URL = 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json'
export const PLATFORM = process.arch === 'arm64' ? 'darwin-aarch64' : 'darwin-x86_64'
// アイコンは単色の小さな SVG。大きすぎるものは出さない
const ICON_LIMIT = 64 * 1024

interface Package {
  package: string
  args?: string[]
  env?: Record<string, string>
}

export interface BinaryTarget {
  archive?: string
  cmd: string
  args?: string[]
  env?: Record<string, string>
  sha256?: string
}

export interface Entry {
  id: string
  name: string
  version?: string
  description?: string
  website?: string
  icon?: string
  distribution: {
    npx?: Package
    uvx?: Package
    binary?: Record<string, BinaryTarget>
  }
}

let cache: Promise<Entry[]> | null = null
// アイコンは URL ごとに覚える。読めなかったものは覚えず、次に登録簿を開いたときに読み直す
const icons = new Map<string, Promise<string | null>>()

export function loadEntries(): Promise<Entry[]> {
  cache ??= fetchEntries().catch((err) => {
    cache = null
    throw err
  })
  return cache
}

// 自動テスト用: 読み直させる（fetch を差し替えたあとに使う）
export function resetRegistry(): void {
  cache = null
  icons.clear()
}

async function fetchEntries(): Promise<Entry[]> {
  const res = await fetch(URL, { signal: AbortSignal.timeout(20_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const { agents } = (await res.json()) as { agents: Entry[] }
  return agents.filter((e) => e && typeof e.id === 'string' && typeof e.name === 'string' && e.distribution)
}

// 入れたエージェントの置き場所。<id>/<版>/ に展開する
export function agentsRoot(): string {
  return join(app.getPath('userData'), 'agents')
}

export function safeSegment(text: string): string {
  return text.replace(/[^A-Za-z0-9._+-]/g, '_').replace(/^\.+/, '_') || '_'
}

// 使えるかどうかは PATH によるので、一覧を渡すたびに決め直す（登録簿そのものは覚えておく）
export async function loadRegistry(): Promise<RegistryAgent[]> {
  const entries = await loadEntries()
  const { PATH } = await agentEnv()
  return entries.map((e) => toAgent(e, PATH)).sort((a, b) => a.name.localeCompare(b.name))
}

function toAgent(e: Entry, path: string): RegistryAgent {
  const base = { id: e.id, name: e.name, kind: 'acp' as const }
  const d = e.distribution
  const agent = (command: string, args: string[], env?: Record<string, string>): AgentConfig => ({ ...base, command, args, ...(env ? { env } : {}) })
  let status: RegistryStatus
  const match: RegistryAgent['match'] = {}
  const bin = d.binary?.[PLATFORM]
  if (d.npx) {
    match.package = packageName(d.npx.package)
    status = which('npx', path) ? { kind: 'ready', agent: agent('npx', ['-y', d.npx.package, ...(d.npx.args ?? [])], d.npx.env) } : { kind: 'unavailable', reason: 'npx' }
  } else if (d.uvx) {
    match.package = packageName(d.uvx.package)
    status = which('uvx', path) ? { kind: 'ready', agent: agent('uvx', [d.uvx.package, ...(d.uvx.args ?? [])], d.uvx.env) } : { kind: 'unavailable', reason: 'uvx' }
  } else if (bin) {
    match.dir = join(agentsRoot(), safeSegment(e.id))
    // すでに PATH にあれば、取ってこずにそれを使う
    const command = basename(bin.cmd)
    if (which(command, path)) status = { kind: 'ready', agent: agent(command, bin.args ?? [], bin.env) }
    else status = bin.archive ? { kind: 'install' } : { kind: 'unavailable', reason: 'platform' }
  } else {
    status = { kind: 'unavailable', reason: 'platform' }
  }
  return { id: e.id, name: e.name, version: e.version ?? '', description: e.description ?? '', website: e.website ?? null, status, match }
}

// 一覧のアイコンを data: URL でまとめて返す（画面の CSP は外の画像を読まないため）。読めなかったものは入れない
export async function loadIcons(): Promise<Record<string, string>> {
  const entries = await loadEntries()
  const out: Record<string, string> = {}
  const queue = entries.filter((e) => e.icon && /^https:\/\//.test(e.icon))
  // 一度に開く接続は数本にとどめる
  const worker = async (): Promise<void> => {
    for (let e = queue.shift(); e; e = queue.shift()) {
      const url = e.icon!
      let icon = icons.get(url)
      if (!icon) {
        icon = fetchIcon(url)
        icons.set(url, icon)
      }
      const data = await icon
      if (data) out[e.id] = data
      else icons.delete(url)
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))
  return out
}

async function fetchIcon(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!res.ok || Number(res.headers.get('content-length') ?? 0) > ICON_LIMIT) return null
    const body = Buffer.from(await res.arrayBuffer())
    if (body.length > ICON_LIMIT || !/<svg[\s>]/.test(body.toString('utf8'))) return null
    return `data:image/svg+xml;base64,${body.toString('base64')}`
  } catch {
    return null
  }
}
