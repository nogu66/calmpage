import { execFile } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, statSync } from 'node:fs'
import { chmod, mkdir, readdir, rename, rm } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { AgentConfig, InstallProgress } from '../shared/agents'
import { agentsRoot, loadEntries, PLATFORM, safeSegment } from './registry'

// 登録簿の binary の配布物を取ってきて、userData/agents/<id>/<版>/ に展開する。
// 途中の物は隠しフォルダに置き、出来上がってから名前を変えるので、半端な版が残らない。

// 配布物の上限（いちばん大きいものでも 250MB ほど）
const ARCHIVE_LIMIT = 1024 * 1024 * 1024

const running = new Map<string, Promise<AgentConfig>>()

export function installAgent(id: string, onProgress: (p: InstallProgress) => void): Promise<AgentConfig> {
  let job = running.get(id)
  if (!job) {
    job = install(id, onProgress).finally(() => running.delete(id))
    running.set(id, job)
  }
  return job
}

async function install(id: string, onProgress: (p: InstallProgress) => void): Promise<AgentConfig> {
  const entry = (await loadEntries()).find((e) => e.id === id)
  const target = entry?.distribution.binary?.[PLATFORM]
  if (!entry || !target?.archive) throw new Error('no archive for this Mac')
  const root = join(agentsRoot(), safeSegment(entry.id))
  const version = safeSegment(entry.version || 'latest')
  const dest = join(root, version)
  const command = inside(dest, target.cmd)
  const agent: AgentConfig = { id: entry.id, name: entry.name, kind: 'acp', command, args: target.args ?? [], ...(target.env ? { env: target.env } : {}) }

  // 同じ版がもう入っていれば（設定から外したあとなど）、そのまま使う
  if (!isFile(command)) {
    await mkdir(root, { recursive: true })
    const stamp = randomBytes(4).toString('hex')
    const archive = join(root, `.download-${stamp}`)
    const staging = join(root, `.${version}-${stamp}`)
    try {
      await download(target.archive, archive, target.sha256, onProgress)
      onProgress({ phase: 'extract' })
      await mkdir(staging)
      await extract(target.archive, archive, staging)
      const staged = inside(staging, target.cmd)
      if (!isFile(staged)) throw new Error(`${target.cmd} is not in the archive`)
      await chmod(staged, statSync(staged).mode | 0o755)
      await rm(dest, { recursive: true, force: true })
      await rename(staging, dest)
    } finally {
      await rm(archive, { force: true })
      await rm(staging, { recursive: true, force: true })
    }
  }
  // 古い版は片付ける
  for (const name of await readdir(root)) {
    if (name !== version) await rm(join(root, name), { recursive: true, force: true })
  }
  return agent
}

// 配布物の中の cmd（「./bin/devin」など）を、展開先の中の絶対パスにする。外を指すものは断る
function inside(dir: string, cmd: string): string {
  const full = resolve(dir, cmd)
  if (!full.startsWith(dir + sep)) throw new Error(`unexpected command path: ${cmd}`)
  return full
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

async function download(url: string, file: string, sha256: string | undefined, onProgress: (p: InstallProgress) => void): Promise<void> {
  if (!/^https:\/\//.test(url)) throw new Error('only https downloads are allowed')
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
  const total = Number(res.headers.get('content-length')) || null
  if (total && total > ARCHIVE_LIMIT) throw new Error('the archive is too large')
  const hash = createHash('sha256')
  const out = createWriteStream(file)
  const closed = new Promise<void>((done, fail) => {
    out.on('close', done)
    out.on('error', fail)
  })
  let received = 0
  let reported = 0
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      received += chunk.length
      if (received > ARCHIVE_LIMIT) throw new Error('the archive is too large')
      hash.update(chunk)
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r))
      // 進み具合は 1 秒に数回で足りる
      const now = Date.now()
      if (now - reported > 150) {
        reported = now
        onProgress({ phase: 'download', received, total })
      }
    }
  } finally {
    out.end()
    await closed
  }
  onProgress({ phase: 'download', received, total: total ?? received })
  if (sha256 && hash.digest('hex') !== sha256.toLowerCase()) throw new Error('checksum')
}

function extract(url: string, archive: string, dir: string): Promise<void> {
  const name = decodeURIComponent(new URL(url).pathname).toLowerCase()
  let cmd: string
  let args: string[]
  if (name.endsWith('.zip')) [cmd, args] = ['/usr/bin/ditto', ['-x', '-k', archive, dir]]
  else if (/\.(tar\.gz|tgz|tar\.bz2|tbz2?|tar\.xz|txz|tar)$/.test(name)) [cmd, args] = ['/usr/bin/tar', ['-xf', archive, '-C', dir]]
  else return Promise.reject(new Error(`unsupported archive: ${name.split('/').pop()}`))
  return new Promise((done, fail) => {
    execFile(cmd, args, { timeout: 5 * 60_000 }, (err, _stdout, stderr) => {
      if (err) fail(new Error(String(stderr).trim().split('\n').pop() || err.message))
      else done()
    })
  })
}

// 設定から外したエージェントのうち、ここに入れたものはファイルごと消す（取り直せるので残さない）
export async function removeInstalled(before: AgentConfig[], after: AgentConfig[]): Promise<void> {
  const root = agentsRoot() + sep
  const dirOf = (a: AgentConfig): string | null => (a.command.startsWith(root) ? a.command.slice(root.length).split(sep)[0] : null)
  const kept = new Set(after.map(dirOf))
  for (const dir of new Set(before.map(dirOf))) {
    if (!dir || kept.has(dir) || running.has(dir)) continue
    const path = join(agentsRoot(), dir)
    if (existsSync(path)) await rm(path, { recursive: true, force: true }).catch(() => {})
  }
}
