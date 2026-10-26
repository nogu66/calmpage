import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { DEFAULT_AGENTS, type AgentConfig } from '../shared/agents'
import type { Lang } from '../shared/i18n'

export type { AgentConfig, AgentKind } from '../shared/agents'

export type Theme = 'system' | 'light' | 'dark'
export type Palette = 'paper' | 'moss' | 'sand'
export type PdfView = 'width' | 'page' | 'spread'
// 「自動」は書類の中身から選ぶ。書類の「% !TEX program」と .latexmkrc はこれより先に効く
export type EngineSetting = 'auto' | 'pdflatex' | 'xelatex' | 'lualatex' | 'uplatex'

// 窓 1 つ分。終了したときに開いていた窓を、次の起動で開き直すために覚えておく
export interface WindowState {
  folder: string
  file: string | null
  tabs: string[]
  bounds?: { x: number; y: number; width: number; height: number }
}

export interface Settings {
  // folder / file / tabs は窓ごとの値。main が窓ごとに埋めて画面へ渡す。
  // ファイルには 1 つめの窓の値も書いておく（windows を知らない前の版に戻しても、そのフォルダが開くように）
  folder: string | null
  file: string | null
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
  // PDF の表示（幅に合わせる・ページ全体・見開き）と、ダークモードで PDF を反転するか
  pdfView: PdfView
  pdfInvert: boolean
  // 最近開いたフォルダ（新しい順）。ファイルのメニューの「最近使ったもの」に出す
  recent: string[]
  // エディターのタブに並べていたファイル（並びのとおり）。開いていたものは file に入る
  tabs: string[]
  windows: WindowState[]
  engine: EngineSetting
  // 書類から任意のプログラムを動かせるようになるので、既定は切っておく
  shellEscape: boolean
  // エディター: 本文の英単語のスペルチェックと、サイドバーのアウトラインを開いておくか
  spellcheck: boolean
  outline: boolean
}

const DEFAULTS: Settings = { folder: null, file: null, auto: true, split: 0.5, sidebar: true, preview: true, theme: 'system', palette: 'paper', language: 'en', aiEnabled: true, ai: false, agents: DEFAULT_AGENTS, agent: 'claude', aiWidth: 440, pdfView: 'width', pdfInvert: false, recent: [], tabs: [], windows: [], engine: 'auto', shellEscape: false, spellcheck: true, outline: true }

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
  const saved = stored()
  const settings = { ...DEFAULTS, ...saved }
  // 0.3.0 までは窓が 1 つで、folder / file / tabs だけを持っていた。windows を書くまでは、それを 1 つめの窓として読む
  if (!saved.windows && saved.folder) settings.windows = [{ folder: saved.folder, file: saved.file ?? null, tabs: saved.tabs ?? [] }]
  return settings
}

export function saveSettings(patch: Partial<Settings>): void {
  const next = { ...stored(), ...patch }
  // エージェントの一覧が既定と同じなら書かない（既定の版を上げたとき、そのまま新しい版になる）
  if (JSON.stringify(next.agents) === JSON.stringify(DEFAULT_AGENTS)) delete next.agents
  writeFileSync(path(), JSON.stringify(next, null, 2))
}
