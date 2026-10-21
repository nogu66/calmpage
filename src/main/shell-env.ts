import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Finder から起動したアプリは、ログインシェルの環境（PATH や API キー）を持たない。最初に一度だけシェルから読み取る。
let shellEnv: Promise<Record<string, string>> | null = null

function loadShellEnv(): Promise<Record<string, string>> {
  shellEnv ??= new Promise((resolve) => {
    const mark = '__SUMI_ENV__'
    const shell = process.env.SHELL || '/bin/zsh'
    execFile(shell, ['-ilc', `printf ${mark}; env -0; printf ${mark}`], { timeout: 8000, maxBuffer: 4 << 20 }, (_err, stdout) => {
      const env: Record<string, string> = {}
      for (const entry of String(stdout ?? '').split(mark)[1]?.split('\0') ?? []) {
        const eq = entry.indexOf('=')
        if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1)
      }
      resolve(env)
    })
  })
  return shellEnv
}

// 起動のたびにシェルを待たないよう、アプリの起動時に読み始めておく
export function warmUpShellEnv(): void {
  void loadShellEnv()
}

// エージェントに渡す環境
export async function agentEnv(): Promise<Record<string, string>> {
  const shell = await loadShellEnv()
  const env: Record<string, string> = { ...(process.env as Record<string, string>), ...shell }
  env.PATH = [shell.PATH, process.env.PATH, join(homedir(), '.local/bin')].filter(Boolean).join(':')
  // Claude Code の中から起動したとき（自動テスト）に「入れ子」と判定されないように
  delete env.CLAUDECODE
  for (const key of Object.keys(env)) if (key.startsWith('ELECTRON_')) delete env[key]
  return env
}

export function which(command: string, path: string): string | null {
  if (command.includes('/')) return command
  for (const dir of path.split(':')) {
    const full = join(dir, command)
    try {
      accessSync(full, constants.X_OK)
      return full
    } catch {
      // 次の場所を探す
    }
  }
  return null
}
