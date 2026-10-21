import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import { statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join, sep } from 'node:path'
import { backwardSync, build, forwardSync, resolveRoot, type BuildResult } from './build'
import { FolderWatcher, listProjectFiles } from './files'
import { loadSettings, saveSettings, type Palette, type Theme } from './settings'

// Finder から起動するとシェルの PATH を引き継がないため、TeX と Homebrew の場所を足しておく。
process.env.PATH = ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(':')

// 自動テスト用: 設定の保存先と、起動時に開くパスを差し替えられる。
if (process.env.SUMI_USER_DATA) app.setPath('userData', process.env.SUMI_USER_DATA)

let win: BrowserWindow | null = null
let folder: string | null = loadSettings().folder
let currentRoot: string | null = null
let currentPdf: string | null = null
let pendingOpen: string | null = process.env.SUMI_OPEN ?? null

const watcher = new FolderWatcher((path, content) => win?.webContents.send('file:changed', path, content))

function send(channel: string, ...args: unknown[]): void {
  win?.webContents.send(channel, ...args)
}

function setFolder(next: string): void {
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
      send('build:finished', null, file)
      return
    }
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

function applyTheme(theme: Theme): void {
  nativeTheme.themeSource = theme
  win?.setBackgroundColor(groundColor())
}

function setTheme(theme: Theme): void {
  applyTheme(theme)
  saveSettings({ theme })
  buildMenu()
}

function setPalette(palette: Palette): void {
  saveSettings({ palette })
  win?.setBackgroundColor(groundColor())
  send('palette', palette)
  buildMenu()
}

function buildMenu(): void {
  const command = (name: string) => () => send('menu', name)
  const { theme, palette } = loadSettings()
  const themeItem = (label: string, value: Theme): Electron.MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: theme === value,
    click: () => setTheme(value)
  })
  const paletteItem = (label: string, value: Palette): Electron.MenuItemConstructorOptions => ({
    label,
    type: 'radio',
    checked: palette === value,
    click: () => setPalette(value)
  })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      {
        label: 'ファイル',
        submenu: [
          { label: 'フォルダを開く…', accelerator: 'CmdOrCtrl+O', click: () => void chooseFolder() },
          { type: 'separator' },
          { label: '保存して組版', accelerator: 'CmdOrCtrl+S', click: command('save') },
          { label: '組版', accelerator: 'CmdOrCtrl+R', click: command('build') },
          { type: 'separator' },
          { label: 'PDF をプレビュー.app で開く', accelerator: 'CmdOrCtrl+Shift+O', click: command('open-pdf') }
        ]
      },
      {
        label: '編集',
        submenu: [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }]
      },
      {
        label: '表示',
        submenu: [
          { label: 'カーソル位置を PDF で表示', accelerator: 'CmdOrCtrl+J', click: command('forward-sync') },
          { label: 'ファイル一覧', accelerator: 'CmdOrCtrl+B', click: command('toggle-sidebar') },
          { label: '問題の一覧', accelerator: 'CmdOrCtrl+Shift+M', click: command('toggle-problems') },
          { type: 'separator' },
          { label: 'PDF を拡大', accelerator: 'CmdOrCtrl+=', click: command('zoom-in') },
          { label: 'PDF を縮小', accelerator: 'CmdOrCtrl+-', click: command('zoom-out') },
          { label: 'PDF を幅に合わせる', accelerator: 'CmdOrCtrl+0', click: command('zoom-reset') },
          { type: 'separator' },
          {
            label: '明るさ',
            submenu: [themeItem('システムに合わせる', 'system'), themeItem('ライト', 'light'), themeItem('ダーク', 'dark')]
          },
          {
            label: '配色',
            submenu: [paletteItem('紙（標準）', 'paper'), paletteItem('苔', 'moss'), paletteItem('砂', 'sand')]
          },
          { type: 'separator' },
          { role: 'toggleDevTools' }
        ]
      },
      { role: 'windowMenu' }
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
  ipcMain.on('settings:save', (_e, patch) => saveSettings(patch))
}

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 900,
    minHeight: 560,
    title: 'Sumi',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: groundColor(),
    // 自動テスト中は最前面に出さない（手元で打っているキー入力をエディターが奪わないように）
    show: !process.env.SUMI_USER_DATA,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  win.on('closed', () => (win = null))
  if (process.env.SUMI_USER_DATA) win.showInactive()
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.on('open-file', (event, path) => {
  event.preventDefault()
  if (win && app.isReady()) openPath(path)
  else pendingOpen = path
})

app.whenReady().then(() => {
  applyTheme(loadSettings().theme)
  registerIpc()
  buildMenu()
  createWindow()
  app.on('activate', () => {
    if (!win) createWindow()
  })
})

app.on('window-all-closed', () => {
  watcher.close()
  app.quit()
})
