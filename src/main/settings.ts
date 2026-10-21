import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { Lang } from '../shared/i18n'

export type Theme = 'system' | 'light' | 'dark'
export type Palette = 'paper' | 'moss' | 'sand'

export interface Settings {
  folder: string | null
  file: string | null
  zoom: number
  auto: boolean
  split: number
  sidebar: boolean
  theme: Theme
  palette: Palette
  language: Lang
}

const DEFAULTS: Settings = { folder: null, file: null, zoom: 1, auto: true, split: 0.5, sidebar: true, theme: 'system', palette: 'paper', language: 'en' }

function path(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(path(), 'utf8')) }
  } catch {
    return { ...DEFAULTS }
  }
}

export function saveSettings(patch: Partial<Settings>): void {
  writeFileSync(path(), JSON.stringify({ ...loadSettings(), ...patch }, null, 2))
}
