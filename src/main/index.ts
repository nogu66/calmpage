import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { AcpAgents } from './acp'
import { backwardSync, build, forwardSync, resolveRoot, type BuildResult } from './build'
import { createFile, createFolder, FolderWatcher, importData, importFile, listProjectEntries, listProjectFiles, renamePath } from './files'
import { isEmptyFolder, TEMPLATE_IDS, writeTemplate, type TemplateId } from './templates'
import { listVersions, readVersion, recordVersion } from './history'
import { loadRegistry } from './registry'
import { replaceInFiles, searchFiles } from './search'
import { warmUpShellEnv } from './shell-env'
import { Terminals } from './terminals'
import { t, type Key } from '../shared/i18n'
import { isText } from '../shared/paths'
import type { SearchOptions } from '../shared/search'
import { loadSettings, saveSettings, type AgentConfig, type Palette, type Settings, type Theme } from './settings'

// Finder から起動するとシェルの PATH を引き継がないため、TeX と Homebrew の場所を足しておく。
process.env.PATH = ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(':')

// 自動テスト用: 設定の保存先と、起動時に開くパスを差し替えられる。
if (process.env.CALMPAGE_USER_DATA) app.setPath('userData', process.env.CALMPAGE_USER_DATA)
// 前の名前（0.2.0 までは Sumitex、0.1.0 までは Sumi）の設定を一度だけ引き継ぐ。新しい方を優先する
else {
  const now = join(app.getPath('userData'), 'settings.json')
  const before = ['Sumitex', 'Sumi'].map((name) => join(app.getPath('appData'), name, 'settings.json')).find((path) => existsSync(path))
  if (!existsSync(now) && before) {
    mkdirSync(dirname(now), { recursive: true })
    copyFileSync(before, now)
  }
}

let win: BrowserWindow | null = null
let folder: string | null = loadSettings().folder
let currentRoot: string | null = null
let currentPdf: string | null = null
let pendingOpen: string | null = process.env.CALMPAGE_OPEN ?? null

const watcher = new FolderWatcher(
  (path, content, source) => {
    win?.webContents.send('file:changed', path, content, source)
    void recordVersion(path, content) // AI などの書き換えも、あとで戻せるように
  },
  () => win?.webContents.send('files:changed')
)
const terminals = new Terminals(send)
const acpAgents = new AcpAgents(send)

function agentConfig(id: string): AgentConfig | undefined {
  return loadSettings().agents.find((a) => a.id === id)
}

function stopAgents(): void {
  terminals.stopAll()
  acpAgents.stopAll()
}

function send(channel: string, ...args: unknown[]): void {
  win?.webContents.send(channel, ...args)
}

function tr(key: Key, params?: Record<string, string | number>): string {
  return t(loadSettings().language, key, params)
}

// ---------- 画面への問い合わせ ----------

// main から画面に聞いて、答えを待つ。画面が固まっていたら待ちすぎない（閉じられなくなるので）
let nextRequest = 0
const pending = new Map<number, (value: unknown) => void>()

function ask<T>(channel: string, fallback: T, ...args: unknown[]): Promise<T> {
  if (!win || win.webContents.isCrashed()) return Promise.resolve(fallback)
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
    send(channel, id, ...args)
  })
}

interface Unsaved {
  path: string
  error: string | null
}

// 閉じる・終了する・フォルダやファイルを替える前に、未保存の変更を片付ける。先へ進んでよければ true。
// 自動コンパイルなら黙って保存し、保存できなかったときや自動コンパイルを切っているときだけ聞く。
// 重なったら順に聞く（ファイルの切り替え中に ⌘Q が来ても、ほかの書類を確かめずに終わらないように）
let confirming: Promise<unknown> = Promise.resolve()

function confirmUnsaved(paths: string[] | null = null, save = false): Promise<boolean> {
  const next = confirming.then(() => settleUnsaved(paths, save))
  confirming = next.catch(() => {})
  return next
}

async function settleUnsaved(paths: string[] | null, save: boolean): Promise<boolean> {
  let left = await ask<Unsaved[]>('app:flush', [], save ? 'save' : 'auto', paths)
  while (left.length && win) {
    const failed = left.find((u) => u.error)
    const name = basename(left[0].path)
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      message: failed ? tr('unsaved.failed', { name: basename(failed.path) }) : left.length === 1 ? tr('unsaved.one', { name }) : tr('unsaved.many', { n: left.length }),
      detail: failed ? `${failed.error}\n\n${tr('unsaved.detail')}` : tr('unsaved.detail'),
      buttons: [tr('unsaved.save'), tr('unsaved.dontSave'), tr('unsaved.cancel')],
      defaultId: 0,
      cancelId: 2
    })
    if (response === 2) return false
    if (response === 1) {
      await ask('app:flush', [], 'discard', left.map((u) => u.path))
      return true
    }
    left = await ask<Unsaved[]>('app:flush', [], 'save', left.map((u) => u.path))
  }
  return true
}

// 最近開いたフォルダ。macOS の「最近使った項目」（Dock の右クリックなど）にも載せる。
// メニューの一覧は自前で持つ: フォルダは書類の種類として登録していないので、標準の「最近使ったもの」の
// メニュー（role: recentDocuments）には出ないことがあるため。
const RECENT_MAX = 10

function addRecent(path: string): void {
  const recent = [path, ...loadSettings().recent.filter((p) => p !== path)].slice(0, RECENT_MAX)
  saveSettings({ recent })
  // 自動テストでは、手元の Mac の「最近使った項目」を汚さない
  if (!process.env.CALMPAGE_USER_DATA) app.addRecentDocument(path)
  buildMenu()
}

function clearRecent(): void {
  saveSettings({ recent: [] })
  if (!process.env.CALMPAGE_USER_DATA) app.clearRecentDocuments()
  buildMenu()
}

function recentItems(tr: (key: Key) => string): Electron.MenuItemConstructorOptions[] {
  const recent = loadSettings().recent.filter((p) => existsSync(p))
  // 同じ名前のフォルダが並ぶときだけ、親のフォルダ名を添えて見分けられるようにする
  const label = (p: string): string =>
    recent.filter((q) => basename(q) === basename(p)).length > 1 ? `${basename(p)} — ${basename(dirname(p))}` : basename(p)
  const items: Electron.MenuItemConstructorOptions[] = recent.map((p) => ({ label: label(p), click: () => void openPath(p) }))
  if (items.length) items.push({ type: 'separator' })
  items.push({ label: tr('menu.clearRecent'), enabled: recent.length > 0, click: clearRecent })
  return items
}

function setFolder(next: string): void {
  if (next !== folder) stopAgents() // AI は開いているフォルダで動くので、替えたら止める
  folder = next
  watcher.watch(next)
  saveSettings({ folder: next })
  addRecent(next)
}

// 組版は 1 本ずつ。実行中に来た依頼は最後の 1 件だけ覚えておき、終わったら続けて組む。
let building = false
let queued: string | null = null

async function requestBuild(file: string): Promise<void> {
  if (building) {
    queued = file
    return
  }
  building = true
  try {
    const files = folder ? await listProjectFiles(folder) : []
    const root = await resolveRoot(file, currentRoot, files)
    if (!root) {
      currentPdf = null
      send('build:finished', null, file)
      return
    }
    // 別の書類に移ったら、前の書類の PDF を ⇧⌘O や SyncTeX の相手にしない
    if (root !== currentRoot) currentPdf = null
    send('build:started', root)
    const result: BuildResult = await build(root)
    currentRoot = root
    if (result.pdf) currentPdf = result.pdf
    send('build:finished', result, file)
  } catch (err) {
    send('build:finished', null, file, String(err))
  } finally {
    building = false
    if (queued) {
      const next = queued
      queued = null
      void requestBuild(next)
    }
  }
}

async function openPath(path: string): Promise<void> {
  let isDir = false
  try {
    isDir = statSync(path).isDirectory()
  } catch {
    return
  }
  // フォルダが替わるときだけ、先に未保存を片付ける（同じフォルダのファイルなら画面の側で保存する）
  const next = isDir ? path : folder && path.startsWith(folder + sep) ? folder : dirname(path)
  if (next !== folder && !(await confirmUnsaved())) return
  if (isDir) {
    setFolder(path)
    send('folder:opened', path, null)
  } else {
    if (!folder || !path.startsWith(folder + sep)) setFolder(dirname(path))
    send('folder:opened', folder, path)
  }
}

// 明るさは nativeTheme で切り替える。画面の CSS（prefers-color-scheme）とウィンドウの枠が一緒に変わる。
// 配色（紙・苔・砂）は画面側の data-palette で切り替える。ここでは起動時の地の色だけ合わせる。
const GROUND: Record<Palette, [light: string, dark: string]> = {
  paper: ['#f4f4f2', '#111111'],
  moss: ['#e3e7df', '#121511'],
  sand: ['#ebe8e1', '#141412']
}

function groundColor(): string {
  return GROUND[loadSettings().palette][nativeTheme.shouldUseDarkColors ? 1 : 0]
}

// 設定の変更はここに集める。メニューと設定画面のどちらから変えても、画面へ同じ知らせが届く。
function updateSettings(patch: Partial<Settings>): void {
  // 消した・書き換えたエージェントは止める（次に開いたとき新しい設定で起動する）
  if (patch.agents) {
    for (const old of loadSettings().agents) {
      const next = patch.agents.find((a) => a.id === old.id)
      if (JSON.stringify(next) === JSON.stringify(old)) continue
      terminals.stop(old.id)
      acpAgents.stop(old.id)
    }
  }
  saveSettings(patch)
  if (patch.aiEnabled === false) stopAgents()
  if (patch.theme) nativeTheme.themeSource = patch.theme
  if (patch.theme || patch.palette) win?.setBackgroundColor(groundColor())
  if (patch.theme || patch.palette || patch.language || patch.aiEnabled !== undefined) buildMenu()
  send('settings:changed', loadSettings())
}

function buildMenu(): void {
  const { theme, palette, language, aiEnabled } = loadSettings()
  const tr = (key: Key): string => t(language, key)
  const command = (name: string) => () => send('menu', name)
  const themeItem = (value: Theme): Electron.MenuItemConstructorOptions => ({
    label: tr(`theme.${value}`),
    type: 'radio',
    checked: theme === value,
    click: () => updateSettings({ theme: value })
  })
  const paletteItem = (value: Palette): Electron.MenuItemConstructorOptions => ({
    label: tr(`palette.${value}`),
    type: 'radio',
    checked: palette === value,
    click: () => updateSettings({ palette: value })
  })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about', label: tr('menu.about') },
          { type: 'separator' },
          { label: tr('menu.settings'), accelerator: 'CmdOrCtrl+,', click: command('settings') },
          { type: 'separator' },
          { role: 'services', label: tr('menu.services') },
          { type: 'separator' },
          { role: 'hide', label: tr('menu.hide') },
          { role: 'hideOthers', label: tr('menu.hideOthers') },
          { role: 'unhide', label: tr('menu.showAll') },
          { type: 'separator' },
          { role: 'quit', label: tr('menu.quit') }
        ]
      },
      {
        label: tr('menu.file'),
        submenu: [
          { label: tr('menu.newFile'), accelerator: 'CmdOrCtrl+N', click: command('new-file') },
          { label: tr('menu.newDocument'), accelerator: 'CmdOrCtrl+Shift+N', click: command('new-document') },
          { label: tr('menu.newFolder'), accelerator: 'CmdOrCtrl+Alt+N', click: command('new-folder') },
          { type: 'separator' },
          { label: tr('menu.openFolder'), accelerator: 'CmdOrCtrl+O', click: () => void chooseFolder() },
          { label: tr('menu.openRecent'), submenu: recentItems(tr) },
          { type: 'separator' },
          { label: tr('menu.saveCompile'), accelerator: 'CmdOrCtrl+S', click: command('save') },
          { label: tr('menu.compile'), accelerator: 'CmdOrCtrl+R', click: command('build') },
          { type: 'separator' },
          { label: tr('menu.rename'), click: command('rename') },
          { label: tr('menu.trash'), click: command('trash') },
          { label: tr('menu.reveal'), click: command('reveal') },
          { type: 'separator' },
          { label: tr('menu.openPdf'), accelerator: 'CmdOrCtrl+Shift+O', click: command('open-pdf') },
          { type: 'separator' },
          { label: tr('menu.history'), click: command('history') },
          { label: tr('menu.closeTab'), accelerator: 'CmdOrCtrl+W', click: command('close-tab') }
        ]
      },
      {
        label: tr('menu.edit'),
        submenu: [
          { role: 'cut', label: tr('menu.cut') },
          { role: 'copy', label: tr('menu.copy') },
          { role: 'paste', label: tr('menu.paste') },
          { role: 'selectAll', label: tr('menu.selectAll') },
          { type: 'separator' },
          { label: tr('menu.findInFolder'), accelerator: 'CmdOrCtrl+Shift+F', click: command('find-in-folder') }
        ]
      },
      {
        label: tr('menu.view'),
        submenu: [
          { label: tr('menu.forwardSync'), accelerator: 'CmdOrCtrl+J', click: command('forward-sync') },
          { label: tr('menu.sidebar'), accelerator: 'CmdOrCtrl+B', click: command('toggle-sidebar') },
          { label: tr('menu.preview'), accelerator: 'CmdOrCtrl+Shift+P', click: command('toggle-preview') },
          { label: tr('menu.problems'), accelerator: 'CmdOrCtrl+Shift+M', click: command('toggle-problems') },
          { label: tr('menu.ai'), accelerator: 'CmdOrCtrl+Shift+L', click: command('toggle-ai'), visible: aiEnabled, enabled: aiEnabled },
          { type: 'separator' },
          { label: tr('menu.zoomIn'), accelerator: 'CmdOrCtrl+=', click: command('zoom-in') },
          { label: tr('menu.zoomOut'), accelerator: 'CmdOrCtrl+-', click: command('zoom-out') },
          { label: tr('menu.zoomReset'), accelerator: 'CmdOrCtrl+0', click: command('zoom-reset') },
          { label: tr('menu.findPdf'), accelerator: 'CmdOrCtrl+Alt+F', click: command('find-pdf') },
          { type: 'separator' },
          { label: tr('menu.theme'), submenu: [themeItem('system'), themeItem('light'), themeItem('dark')] },
          { label: tr('menu.palette'), submenu: [paletteItem('paper'), paletteItem('moss'), paletteItem('sand')] },
          { type: 'separator' },
          { role: 'toggleDevTools', label: tr('menu.devTools') }
        ]
      },
      {
        label: tr('menu.window'),
        submenu: [
          { role: 'minimize', label: tr('menu.minimize') },
          { role: 'zoom', label: tr('menu.zoom') },
          { type: 'separator' },
          { role: 'front', label: tr('menu.front') },
          { type: 'separator' },
          { label: tr('menu.nextTab'), accelerator: 'Ctrl+Tab', click: command('next-tab') },
          { label: tr('menu.prevTab'), accelerator: 'Ctrl+Shift+Tab', click: command('prev-tab') }
        ]
      }
    ])
  )
}

async function chooseFolder(): Promise<void> {
  if (!win) return
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'openFile'], filters: [{ name: 'LaTeX', extensions: ['tex'] }] })
  if (!res.canceled && res.filePaths[0]) await openPath(res.filePaths[0])
}

// ファイル操作の失敗は、その場で短く知らせる
async function attempt<T>(job: () => Promise<T>): Promise<T | null> {
  try {
    return await job()
  } catch (err) {
    if (win) await dialog.showMessageBox(win, { type: 'warning', message: tr('file.failed'), detail: err instanceof Error ? err.message : String(err) })
    return null
  }
}

function inFolder(path: string): boolean {
  return !!folder && (path === folder || path.startsWith(folder + sep))
}

// ファイル一覧の右クリック。選んだ操作は画面に返して、画面の側で行う（名前の入力は一覧の中でするため）
function showFileMenu(target: string | null, isDir: boolean): void {
  if (!win) return
  const pick = (command: string) => () => send('file-menu', command, target, isDir)
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: tr('menu.newFile'), click: pick('new-file') },
    { label: tr('menu.newFolder'), click: pick('new-folder') }
  ]
  if (target) items.push({ type: 'separator' }, { label: tr('menu.rename'), click: pick('rename') }, { label: tr('menu.trash'), click: pick('trash') })
  items.push({ type: 'separator' }, { label: tr('menu.reveal'), click: () => folder && shell.showItemInFolder(target ?? folder) })
  Menu.buildFromTemplate(items).popup({ window: win })
}

// 雛形から新しい書類を作る。空のフォルダを選ぶか作ってもらい、雛形を置いて開く
async function createFromTemplate(id: TemplateId): Promise<boolean> {
  if (!win || !TEMPLATE_IDS.includes(id)) return false
  if (!(await confirmUnsaved())) return false
  const res = await dialog.showOpenDialog(win, {
    properties: ['openDirectory', 'createDirectory'],
    message: tr('template.chooseFolder'),
    buttonLabel: tr('template.create')
  })
  const dir = res.filePaths[0]
  if (res.canceled || !dir) return false
  if (!(await isEmptyFolder(dir))) {
    await dialog.showMessageBox(win, { type: 'warning', message: tr('template.notEmpty', { name: basename(dir) }), detail: tr('template.notEmptyDetail') })
    return false
  }
  const main = await attempt(() => writeTemplate(id, dir))
  if (!main) return false
  await openPath(main)
  return true
}

function registerIpc(): void {
  ipcMain.on('app:reply', (_e, id: number, value: unknown) => {
    pending.get(id)?.(value)
    pending.delete(id)
  })
  ipcMain.handle('unsaved:confirm', (_e, paths: string[] | null, save: boolean) => confirmUnsaved(paths, save))
  ipcMain.on('window:edited', (_e, edited: boolean) => win?.setDocumentEdited(edited))
  ipcMain.handle('folder:entries', () => (folder ? listProjectEntries(folder) : { files: [], emptyDirs: [] }))
  ipcMain.handle('file:create', (_e, dir: string, name: string) => (inFolder(dir) ? attempt(() => createFile(dir, name)) : null))
  ipcMain.handle('folder:create', (_e, dir: string, name: string) => (inFolder(dir) ? attempt(() => createFolder(dir, name)) : null))
  ipcMain.handle('path:rename', (_e, path: string, name: string) => (inFolder(path) && path !== folder ? attempt(() => renamePath(path, name)) : null))
  ipcMain.handle('path:trash', async (_e, path: string) => (inFolder(path) && path !== folder ? (await attempt(() => shell.trashItem(path))) !== null : false))
  ipcMain.on('path:reveal', (_e, path: string) => shell.showItemInFolder(path))
  ipcMain.on('file:quicklook', (_e, path: string) => win?.previewFile(path))
  ipcMain.on('file:menu', (_e, target: string | null, isDir: boolean) => showFileMenu(target, isDir))
  ipcMain.handle('file:import', (_e, src: string, dir?: string) => (folder ? attempt(() => importFile(folder as string, src, dir)) : null))
  ipcMain.handle('file:import-data', (_e, name: string, data: Uint8Array, dir?: string) =>
    folder ? attempt(() => importData(folder as string, name, data, dir)) : null
  )
  ipcMain.handle('template:create', (_e, id: TemplateId) => createFromTemplate(id))
  ipcMain.handle('app:initial', async () => {
    const settings = loadSettings()
    let file = settings.file
    const open = pendingOpen
    pendingOpen = null
    if (open && statSync(open, { throwIfNoEntry: false })?.isDirectory()) {
      setFolder(open)
      file = null
    } else if (open) {
      if (!folder || !open.startsWith(folder + sep)) setFolder(dirname(open))
      file = open
    } else if (folder) {
      watcher.watch(folder)
    }
    return { ...settings, folder, file }
  })
  ipcMain.handle('folder:choose', () => chooseFolder())
  ipcMain.handle('folder:files', () => (folder ? listProjectFiles(folder) : []))
  ipcMain.handle('file:read', (_e, path: string) => readFile(path, 'utf8'))
  ipcMain.handle('file:write', async (_e, path: string, content: string) => {
    watcher.noteWrite(path, content)
    await recordVersion(path, content)
    await writeFile(path, content, 'utf8')
  })
  registerSearchAndHistory()
  ipcMain.on('build:request', (_e, file: string) => void requestBuild(file))
  ipcMain.handle('pdf:read', (_e, path: string) => readFile(path))
  ipcMain.handle('pdf:open-external', () => (currentPdf ? shell.openPath(currentPdf) : null))
  ipcMain.handle('sync:forward', (_e, file: string, line: number, column: number) =>
    currentPdf ? forwardSync(currentPdf, file, line, column) : null
  )
  ipcMain.handle('sync:backward', (_e, page: number, x: number, y: number) =>
    currentPdf ? backwardSync(currentPdf, page, x, y) : null
  )
  ipcMain.on('settings:save', (_e, patch: Partial<Settings>) => saveSettings(patch))
  ipcMain.on('settings:update', (_e, patch: Partial<Settings>) => updateSettings(patch))
  // 端末と ACP は柱のタブごとに動かす。タブの ID は画面が決める。
  ipcMain.handle('term:start', (_e, tab: string, id: string, cols: number, rows: number) => {
    const agent = agentConfig(id)
    return folder && agent ? terminals.start(tab, agent, folder, cols, rows) : null
  })
  ipcMain.on('term:input', (_e, tab: string, data: string) => terminals.write(tab, data))
  ipcMain.on('term:resize', (_e, tab: string, cols: number, rows: number) => terminals.resize(tab, cols, rows))
  ipcMain.on('term:close', (_e, tab: string) => terminals.close(tab))
  ipcMain.handle('acp:start', (_e, tab: string, id: string) => {
    const agent = agentConfig(id)
    return folder && agent ? acpAgents.start(tab, agent, folder) : { ok: false, error: 'no folder' }
  })
  ipcMain.handle('acp:new-session', (_e, tab: string) => acpAgents.newSession(tab))
  ipcMain.handle('acp:authenticate', (_e, tab: string, methodId: string) => acpAgents.authenticate(tab, methodId))
  ipcMain.handle('acp:prompt', (_e, tab: string, prompt: unknown[]) => acpAgents.prompt(tab, prompt as never))
  ipcMain.on('acp:cancel', (_e, tab: string) => acpAgents.cancel(tab))
  ipcMain.on('acp:close', (_e, tab: string) => acpAgents.close(tab))
  ipcMain.on('acp:answer', (_e, key: string, optionId: string | null) => acpAgents.answerPermission(key, optionId))
  ipcMain.handle('registry:list', async () => {
    try {
      return { agents: await loadRegistry() }
    } catch (err) {
      return { error: String(err) }
    }
  })
  ipcMain.on('link:open', (_e, url: string) => {
    // PDF の中のリンクもここを通る。開くのは Web とメールだけ（file: などは開かない）
    if (/^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url)
  })
}

// 画面が「閉じてよい」と答えたら立てる。立っている間は close と before-quit を止めない
let released = false
let releasing = false

async function release(then: () => void): Promise<void> {
  if (releasing) return
  releasing = true
  try {
    if (await confirmUnsaved()) {
      released = true
      then()
    }
  } finally {
    releasing = false
  }
}

// フォルダ内の検索と置換、ファイルの履歴。新しい検索が来たら、古い検索は途中でやめる。
let searchRun = 0

function registerSearchAndHistory(): void {
  ipcMain.handle('search:run', async (_e, query: string, opts: SearchOptions, overrides: Record<string, string>) => {
    const run = ++searchRun
    if (!folder || !query) return { files: [], total: 0, truncated: false }
    try {
      return await searchFiles((await listProjectFiles(folder)).filter(isText), overrides, query, opts, () => run !== searchRun)
    } catch (err) {
      return { error: String(err) }
    }
  })
  ipcMain.handle('search:replace', async (_e, query: string, opts: SearchOptions, replacement: string, exclude: string[]) => {
    if (!folder || !query) return { files: 0, count: 0 }
    const skip = new Set(exclude)
    const targets = (await listProjectFiles(folder)).filter((p) => isText(p) && inFolder(p) && !skip.has(p))
    // 自分の書き込みを外部の変更と取り違えないよう、書く前に見張りへ知らせる
    return replaceInFiles(targets, query, opts, replacement, (path, before, after) => {
      watcher.noteWrite(path, after)
      void recordVersion(path, after, before)
    })
  })
  ipcMain.handle('dialog:confirm', async (_e, message: string, detail: string, ok: string, cancel: string) => {
    if (!win) return false
    const res = await dialog.showMessageBox(win, { type: 'question', message, detail, buttons: [ok, cancel], defaultId: 0, cancelId: 1 })
    return res.response === 0
  })
  ipcMain.handle('history:list', (_e, path: string) => listVersions(path))
  ipcMain.handle('history:read', (_e, path: string, id: string) => readVersion(path, id))
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 560,
    title: 'Calmpage',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: groundColor(),
    // 自動テスト中は最前面に出さない（手元で打っているキー入力をエディターが奪わないように）
    show: !process.env.CALMPAGE_USER_DATA,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  released = false
  win.on('close', (e) => {
    if (released) return
    e.preventDefault()
    void release(() => win?.close())
  })
  win.on('closed', () => (win = null))
  // ファイルを窓に落としたとき、その場所へ移ってしまわないように
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (process.env.CALMPAGE_USER_DATA) win.showInactive()
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.on('open-file', (event, path) => {
  event.preventDefault()
  if (win && app.isReady()) void openPath(path)
  else pendingOpen = path
})

app.whenReady().then(() => {
  // 組み立てたアプリは .icns を使う。開発中だけ Dock の Electron のアイコンを差し替える
  if (!app.isPackaged) app.dock?.setIcon(join(__dirname, '../../build/icon.png'))
  nativeTheme.themeSource = loadSettings().theme
  registerIpc()
  warmUpShellEnv()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (!win) createWindow()
  })
})

// ⌘Q: 窓の close より先に来るので、ここで一度止めて画面に聞く
app.on('before-quit', (e) => {
  if (released || !win) return
  e.preventDefault()
  void release(() => app.quit())
})

app.on('window-all-closed', () => {
  watcher.close()
  stopAgents()
  app.quit()
})
