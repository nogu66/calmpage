import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { AcpAgents } from './acp'
import { backwardSync, build, forwardSync, resolveRoot, type BuildResult } from './build'
import { FolderWatcher, listProjectFiles } from './files'
import { loadRegistry } from './registry'
import { warmUpShellEnv } from './shell-env'
import { Terminals } from './terminals'
import { t, type Key } from '../shared/i18n'
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

const watcher = new FolderWatcher((path, content) => win?.webContents.send('file:changed', path, content))
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

function setFolder(next: string): void {
  if (next !== folder) stopAgents() // AI は開いているフォルダで動くので、替えたら止める
  folder = next
  watcher.watch(next)
  saveSettings({ folder: next })
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

function openPath(path: string): void {
  let isDir = false
  try {
    isDir = statSync(path).isDirectory()
  } catch {
    return
  }
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
          { label: tr('menu.openFolder'), accelerator: 'CmdOrCtrl+O', click: () => void chooseFolder() },
          { type: 'separator' },
          { label: tr('menu.saveCompile'), accelerator: 'CmdOrCtrl+S', click: command('save') },
          { label: tr('menu.compile'), accelerator: 'CmdOrCtrl+R', click: command('build') },
          { type: 'separator' },
          { label: tr('menu.openPdf'), accelerator: 'CmdOrCtrl+Shift+O', click: command('open-pdf') }
        ]
      },
      {
        label: tr('menu.edit'),
        submenu: [
          { role: 'cut', label: tr('menu.cut') },
          { role: 'copy', label: tr('menu.copy') },
          { role: 'paste', label: tr('menu.paste') },
          { role: 'selectAll', label: tr('menu.selectAll') }
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
          { role: 'front', label: tr('menu.front') }
        ]
      }
    ])
  )
}

async function chooseFolder(): Promise<void> {
  if (!win) return
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'openFile'], filters: [{ name: 'LaTeX', extensions: ['tex'] }] })
  if (!res.canceled && res.filePaths[0]) openPath(res.filePaths[0])
}

function registerIpc(): void {
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
    await writeFile(path, content, 'utf8')
  })
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
  ipcMain.handle('term:start', (_e, id: string, cols: number, rows: number) => {
    const agent = agentConfig(id)
    return folder && agent ? terminals.start(agent, folder, cols, rows) : null
  })
  ipcMain.on('term:input', (_e, id: string, data: string) => terminals.write(id, data))
  ipcMain.on('term:resize', (_e, id: string, cols: number, rows: number) => terminals.resize(id, cols, rows))
  ipcMain.handle('acp:start', (_e, id: string) => {
    const agent = agentConfig(id)
    return folder && agent ? acpAgents.start(agent, folder) : { ok: false, error: 'no folder' }
  })
  ipcMain.handle('acp:new-session', (_e, id: string) => acpAgents.newSession(id))
  ipcMain.handle('acp:authenticate', (_e, id: string, methodId: string) => acpAgents.authenticate(id, methodId))
  ipcMain.handle('acp:prompt', (_e, id: string, prompt: unknown[]) => acpAgents.prompt(id, prompt as never))
  ipcMain.on('acp:cancel', (_e, id: string) => acpAgents.cancel(id))
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
  win.on('closed', () => (win = null))
  if (process.env.CALMPAGE_USER_DATA) win.showInactive()
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.on('open-file', (event, path) => {
  event.preventDefault()
  if (win && app.isReady()) openPath(path)
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

app.on('window-all-closed', () => {
  watcher.close()
  stopAgents()
  app.quit()
})
