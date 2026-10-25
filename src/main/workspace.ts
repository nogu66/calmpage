import { dialog, type BrowserWindow } from 'electron'
import { basename } from 'node:path'
import { AcpAgents } from './acp'
import { build, clean, resolveRoot, type BuildResult } from './build'
import { FolderWatcher, listProjectFiles } from './files'
import { recordVersion } from './history'
import { loadSettings, type WindowState } from './settings'
import { Terminals } from './terminals'
import { t, type Key } from '../shared/i18n'

// 窓 1 つ分の状態。窓ごとに別のフォルダを開くので、見張り・組版・エージェント・画面への問い合わせも窓ごとに持つ。

interface Unsaved {
  path: string
  error: string | null
}

function tr(key: Key, params?: Record<string, string | number>): string {
  return t(loadSettings().language, key, params)
}

// 画面への問い合わせの答え。番号は窓をまたいで振るので、待ち合わせは 1 つの表でよい
let nextRequest = 0
const pending = new Map<number, (value: unknown) => void>()

export function answer(id: number, value: unknown): void {
  pending.get(id)?.(value)
  pending.delete(id)
}

export class Workspace {
  folder: string | null
  file: string | null
  tabs: string[]
  currentRoot: string | null = null
  currentPdf: string | null = null
  searchRun = 0
  // 画面が「閉じてよい」と答えたら立てる。立っている間は close を止めない
  released = false
  readonly contentsId: number
  readonly watcher: FolderWatcher
  readonly terminals: Terminals
  readonly acpAgents: AcpAgents
  private releasing = false
  private confirming: Promise<unknown> = Promise.resolve()
  // 組版は 1 本ずつ。実行中に来た依頼は最後の 1 件だけ覚えておき、終わったら続けて組む。
  // 中間ファイルの削除もこの順番待ちに入れる（組んでいる最中に消さないように）。
  private building = false
  private queued: string | null = null
  private stopper: AbortController | null = null

  constructor(
    readonly win: BrowserWindow,
    state: WindowState | null,
    // フォルダ・ファイル・タブが変わったとき（最近使ったものと、復元の一覧を書き直す）
    private changed: (ws: Workspace, folderOpened: boolean) => void
  ) {
    this.folder = state?.folder ?? null
    this.file = state?.file ?? null
    this.tabs = state?.tabs ?? []
    this.contentsId = win.webContents.id
    const send = this.send.bind(this)
    this.watcher = new FolderWatcher(
      (path, content, source) => {
        send('file:changed', path, content, source)
        void recordVersion(path, content) // AI などの書き換えも、あとで戻せるように
      },
      () => send('files:changed')
    )
    this.terminals = new Terminals(send)
    this.acpAgents = new AcpAgents(send)
    if (this.folder) this.watcher.watch(this.folder)
    this.updateTitle()
  }

  send(channel: string, ...args: unknown[]): void {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, ...args)
  }

  state(): WindowState | null {
    if (!this.folder) return null
    const state: WindowState = { folder: this.folder, file: this.file, tabs: this.tabs }
    if (!this.win.isDestroyed()) state.bounds = this.win.getNormalBounds()
    return state
  }

  setFolder(next: string): void {
    if (next !== this.folder) {
      this.stopAgents() // AI は開いているフォルダで動くので、替えたら止める
      this.cancelBuild()
      // 前のフォルダの本体と PDF を、新しいフォルダの組版や SyncTeX の相手にしない
      this.currentRoot = null
      this.currentPdf = null
    }
    this.folder = next
    this.watcher.watch(next)
    this.updateTitle()
    this.changed(this, true)
  }

  // 画面から届いた、窓ごとの値（開いているファイルとタブ）
  setOpenFiles(patch: { file?: string | null; tabs?: string[] }): void {
    if (patch.file !== undefined) this.file = patch.file
    if (patch.tabs) this.tabs = patch.tabs
    this.changed(this, false)
  }

  // Window メニューの一覧に出る名前。macOS ではタイトルを ⌘ クリックするとフォルダの場所も出る
  private updateTitle(): void {
    if (this.win.isDestroyed()) return
    this.win.setTitle(this.folder ? basename(this.folder) : 'Calmpage')
    this.win.setRepresentedFilename(this.folder ?? '')
  }

  stopAgents(): void {
    this.terminals.stopAll()
    this.acpAgents.stopAll()
  }

  // 窓を閉じたとき。latexmk は detached で動くので、窓と一緒には止まらない
  dispose(): void {
    this.watcher.close()
    this.cancelBuild()
    this.stopAgents()
    this.searchRun++
  }

  // ---------- 画面への問い合わせ ----------

  // main から画面に聞いて、答えを待つ。画面が固まっていたら待ちすぎない（閉じられなくなるので）
  ask<T>(channel: string, fallback: T, ...args: unknown[]): Promise<T> {
    if (this.win.isDestroyed() || this.win.webContents.isCrashed()) return Promise.resolve(fallback)
    const id = ++nextRequest
    return new Promise<T>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve(fallback)
      }, 5000)
      pending.set(id, (value) => {
        clearTimeout(timer)
        resolve(value as T)
      })
      this.send(channel, id, ...args)
    })
  }

  // 閉じる・終了する・フォルダやファイルを替える前に、未保存の変更を片付ける。先へ進んでよければ true。
  // 自動コンパイルなら黙って保存し、保存できなかったときや自動コンパイルを切っているときだけ聞く。
  // 重なったら順に聞く（ファイルの切り替え中に ⌘Q が来ても、ほかの書類を確かめずに終わらないように）
  confirmUnsaved(paths: string[] | null = null, save = false, reveal?: () => void): Promise<boolean> {
    const next = this.confirming.then(() => this.settleUnsaved(paths, save, reveal))
    this.confirming = next.catch(() => {})
    return next
  }

  private async settleUnsaved(paths: string[] | null, save: boolean, reveal?: () => void): Promise<boolean> {
    let left = await this.ask<Unsaved[]>('app:flush', [], save ? 'save' : 'auto', paths)
    // ⌘Q で窓を順に確かめるときは、聞く窓を前に出す（どの書類の話か分かるように）
    if (left.length) reveal?.()
    while (left.length && !this.win.isDestroyed()) {
      const failed = left.find((u) => u.error)
      const name = basename(left[0].path)
      const { response } = await dialog.showMessageBox(this.win, {
        type: 'warning',
        message: failed ? tr('unsaved.failed', { name: basename(failed.path) }) : left.length === 1 ? tr('unsaved.one', { name }) : tr('unsaved.many', { n: left.length }),
        detail: failed ? `${failed.error}\n\n${tr('unsaved.detail')}` : tr('unsaved.detail'),
        buttons: [tr('unsaved.save'), tr('unsaved.dontSave'), tr('unsaved.cancel')],
        defaultId: 0,
        cancelId: 2
      })
      if (response === 2) return false
      if (response === 1) {
        await this.ask('app:flush', [], 'discard', left.map((u) => u.path))
        return true
      }
      left = await this.ask<Unsaved[]>('app:flush', [], 'save', left.map((u) => u.path))
    }
    return true
  }

  async release(then: () => void): Promise<void> {
    if (this.releasing) return
    this.releasing = true
    try {
      if (await this.confirmUnsaved()) {
        this.released = true
        then()
      }
    } finally {
      this.releasing = false
    }
  }

  // ---------- 組版 ----------

  async requestBuild(file: string): Promise<void> {
    if (this.building) {
      this.queued = file
      return
    }
    this.building = true
    const stop = (this.stopper = new AbortController())
    try {
      const files = this.folder ? await listProjectFiles(this.folder) : []
      const root = await resolveRoot(file, this.currentRoot, files)
      if (stop.signal.aborted) return void this.send('build:cancelled')
      if (!root) {
        this.currentPdf = null
        this.send('build:finished', null, file)
        return
      }
      // 別の書類に移ったら、前の書類の PDF を ⇧⌘O や SyncTeX の相手にしない
      if (root !== this.currentRoot) this.currentPdf = null
      this.send('build:started', root)
      const result: BuildResult = await build(root, stop.signal)
      this.currentRoot = root
      if (result.cancelled) return void this.send('build:cancelled')
      if (result.pdf) this.currentPdf = result.pdf
      this.send('build:finished', result, file)
    } catch (err) {
      this.send('build:finished', null, file, String(err))
    } finally {
      this.releaseBuild()
    }
  }

  private releaseBuild(): void {
    this.building = false
    this.stopper = null
    if (this.queued) {
      const next = this.queued
      this.queued = null
      void this.requestBuild(next)
    }
  }

  // 中止したら待ち行列も捨てる（止めた直後に、溜まっていた依頼で組み直さないように）
  cancelBuild(): void {
    this.queued = null
    this.stopper?.abort()
  }

  async cleanAux(file: string): Promise<boolean | null> {
    this.cancelBuild()
    while (this.building) await new Promise((r) => setTimeout(r, 50))
    this.building = true
    try {
      const root = await resolveRoot(file, this.currentRoot, this.folder ? await listProjectFiles(this.folder) : [])
      return root ? await clean(root) : null
    } catch {
      return false
    } finally {
      this.releaseBuild()
    }
  }
}
