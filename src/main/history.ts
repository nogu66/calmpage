import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'

// 保存のたびに、ファイルの版を userData/history/<パスの hash>/ に残す。Git は使わない。
// 版は「時刻-内容の hash.txt」という名前の 1 ファイルずつ。並べれば一覧になるので、目録は持たない。
const MAX_VERSIONS = 50
const MAX_AGE = 30 * 24 * 60 * 60 * 1000
const MAX_BYTES = 4 * 1024 * 1024

export interface Version {
  id: string
  time: number
  size: number
}

function hash(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function dirOf(path: string): string {
  return join(app.getPath('userData'), 'history', hash(path).slice(0, 20))
}

function parse(name: string): { time: number; hash: string } | null {
  const m = /^(\d+)-([0-9a-f]+)\.txt$/.exec(name)
  return m ? { time: Number(m[1]), hash: m[2] } : null
}

async function names(dir: string): Promise<string[]> {
  const all = await readdir(dir).catch(() => [] as string[])
  return all.filter((n) => parse(n)).sort((a, b) => parse(a)!.time - parse(b)!.time)
}

// 同じファイルへの記録が重ならないよう、ファイルごとに順に並べる
const queues = new Map<string, Promise<void>>()

function enqueue(path: string, job: () => Promise<void>): Promise<void> {
  const next = (queues.get(path) ?? Promise.resolve()).then(job).catch((err) => console.error('履歴を残せませんでした', err))
  queues.set(path, next)
  void next.then(() => {
    if (queues.get(path) === next) queues.delete(path)
  })
  return next
}

async function add(dir: string, text: string, time: number): Promise<void> {
  const h = hash(text).slice(0, 12)
  const existing = await names(dir)
  const last = existing.length ? parse(existing[existing.length - 1]) : null
  if (last?.hash === h) return // 最後の版と同じ内容は残さない
  await writeFile(join(dir, `${Math.max(time, (last?.time ?? 0) + 1)}-${h}.txt`), text, 'utf8')
}

async function prune(dir: string, now: number): Promise<void> {
  const all = await names(dir)
  // 最新の版はいつでも残す。そのほかは期間と数で捨てる
  const drop = all.slice(0, -1).filter((n, i, rest) => now - parse(n)!.time > MAX_AGE || rest.length - i >= MAX_VERSIONS)
  await Promise.all(drop.map((n) => rm(join(dir, n), { force: true })))
}

// 書く直前に呼ぶ。まだ版がなければ、書き換える前の内容も残しておく（最初の保存の前に戻れるように）。
export function recordVersion(path: string, text: string, before?: string): Promise<void> {
  return enqueue(path, async () => {
    if (text.length > MAX_BYTES) return
    const dir = dirOf(path)
    await mkdir(dir, { recursive: true })
    // 何のファイルの版か、あとで人が調べられるように
    await writeFile(join(dir, 'path'), path, 'utf8')
    if (!(await names(dir)).length) {
      const old = before ?? (await readFile(path, 'utf8').catch(() => null))
      const mtime = (await stat(path).catch(() => null))?.mtimeMs ?? Date.now() - 1
      if (old !== null && old !== text && old.length <= MAX_BYTES) await add(dir, old, Math.floor(Math.min(mtime, Date.now() - 1)))
    }
    await add(dir, text, Date.now())
    await prune(dir, Date.now())
  })
}

// 新しい順
export async function listVersions(path: string): Promise<Version[]> {
  await queues.get(path)
  const dir = dirOf(path)
  const all = await names(dir)
  const versions = await Promise.all(
    all.map(async (n) => ({ id: n, time: parse(n)!.time, size: (await stat(join(dir, n)).catch(() => null))?.size ?? 0 }))
  )
  return versions.reverse()
}

export async function readVersion(path: string, id: string): Promise<string> {
  if (!parse(id)) throw new Error(`bad version id: ${id}`)
  return readFile(join(dirOf(path), id), 'utf8')
}
