import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_AGENTS, type AgentConfig } from '../shared/agents'
import type { Lang } from '../shared/i18n'

export type { AgentConfig, AgentKind } from '../shared/agents'

export type Theme = 'system' | 'light' | 'dark'
export type Palette = 'paper' | 'moss' | 'sand'

export interface Settings {
  folder: string | null
  file: string | null
  zoom: number
  auto: boolean
  split: number
  sidebar: boolean
  preview: boolean
  theme: Theme
  palette: Palette
  language: Lang
  // AI の機能そのものを使うか。使わない人のために、切るとボタン・メニュー・設定の欄ごと消える。
  aiEnabled: boolean
  ai: boolean
  agents: AgentConfig[]
  agent: string
  aiWidth: number
  // 最近開いたフォルダ（新しい順）。ファイルのメニューの「最近使ったもの」に出す
  recent: string[]
}

const DEFAULTS: Settings = { folder: null, file: null, zoom: 1, auto: true, split: 0.5, sidebar: true, preview: true, theme: 'system', palette: 'paper', language: 'en', aiEnabled: true, ai: false, agents: DEFAULT_AGENTS, agent: 'claude', aiWidth: 440, recent: [] }

function path(): string {
  return join(app.getPath('userData'), 'settings.json')
}

// ファイルには、変えた項目だけを書く。既定値まで書き込むと、あとで既定を変えても古い値が残ってしまう。
function stored(): Partial<Settings> {
  try {
    return JSON.parse(readFileSync(path(), 'utf8'))
  } catch {
    return {}
  }
}

export function loadSettings(): Settings {
  return { ...DEFAULTS, ...stored() }
}

export function saveSettings(patch: Partial<Settings>): void {
  const next = { ...stored(), ...patch }
  // エージェントの一覧が既定と同じなら書かない（既定の版を上げたとき、そのまま新しい版になる）
  if (JSON.stringify(next.agents) === JSON.stringify(DEFAULT_AGENTS)) delete next.agents
  writeFileSync(path(), JSON.stringify(next, null, 2))
}
