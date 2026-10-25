import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, screen, session, shell, type BaseWindow, type WebContents } from 'electron'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'
import { backwardSync, forwardSync } from './build'
import { createFile, createFolder, importData, importFile, listCompletionFiles, listProjectEntries, listProjectFiles, renamePath } from './files'
import { isEmptyFolder, TEMPLATE_IDS, writeTemplate, type TemplateId } from './templates'
import { listVersions, readVersion, recordVersion } from './history'
import { installAgent, removeInstalled } from './installer'
import { loadIcons, loadRegistry, resetRegistry } from './registry'
import { replaceInFiles, searchFiles } from './search'
import { warmUpShellEnv } from './shell-env'
import { answer, Workspace } from './workspace'
import { t, type Key } from '../shared/i18n'
import { isText } from '../shared/paths'
import type { InstallProgress } from '../shared/agents'
import type { SearchOptions } from '../shared/search'
import { loadSettings, saveSettings, type AgentConfig, type Palette, type Settings, type Theme, type WindowState } from './settings'

// Finder から起動するとシェルの PATH を引き継がないため、TeX と Homebrew の場所を足しておく。
process.env.PATH = ['/Library/TeX/texbin', '/opt/homebrew/bin', '/usr/local/bin', process.env.PATH].join(':')

// 自動テスト用: 設定の保存先と、起動時に開くパスを差し替えられる。
const testing = !!process.env.CALMPAGE_USER_DATA
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

// ---------- 窓 ----------

// 開いている窓（開いた順）。front はいま前にある窓で、メニューの操作と Finder から開いたものの行き先になる
const workspaces: Workspace[] = []
let front: Workspace | null = null
// ⌘Q で、すべての窓が「閉じてよい」と答えたら立てる。立っている間は close と before-quit を止めない
let quitting = false
// 起動が終わる前に Finder から渡されたもの
const pendingOpens: string[] = []

// 自動テスト用: いま前にある窓。テストの窓はフォーカスを取らないので、前に出したかは focus では確かめられない
if (testing) (globalThis as { __calmpageFront?: () => number | null }).__calmpageFront = () => front?.win.id ?? null
// 自動テスト用: fetch を差し替えたあとに、登録簿を読み直させる
if (testing) (globalThis as { __calmpageResetRegistry?: () => void }).__calmpageResetRegistry = resetRegistry

function wsOf(sender: WebContents): Workspace | null {
  return workspaces.find((ws) => ws.contentsId === sender.id) ?? null
}

// メニューの行き先。キーで選んだときはフォーカスのある窓、なければ最後に前にあった窓
function target(window?: BaseWindow): Workspace | null {
  return workspaces.find((ws) => window && ws.win.id === window.id) ?? front ?? workspaces.at(-1) ?? null
}

function agentConfig(id: string): AgentConfig | undefined {
  return loadSettings().agents.find((a) => a.id === id)
}

function tr(key: Key, params?: Record<string, string | number>): string {
  return t(loadSettings().language, key, params)
}

// 画面に渡す設定。folder / file / tabs だけは、その窓の値にする
function view(ws: Workspace): Settings {
  return { ...loadSettings(), folder: ws.folder, file: ws.file, tabs: ws.tabs }
}

// 開いている窓を、次の起動で開き直せるように書いておく。フォルダを開いていない窓は覚えない。
// 1 つめの窓の値は folder / file / tabs にも書く（前の版に戻しても、そのフォルダが開くように）
function persistWindows(): void {
  const windows = workspaces.map((ws) => ws.state()).filter((s): s is WindowState => !!s)
  const first = windows[0]
  saveSettings({ windows, folder: first?.folder ?? null, file: first?.file ?? null, tabs: first?.tabs ?? [] })
}

function workspaceChanged(ws: Workspace, folderOpened: boolean): void {
  if (folderOpened && ws.folder) addRecent(ws.folder)
  persistWindows()
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

type Bounds = NonNullable<WindowState['bounds']>

// 覚えていた位置が、今つないでいる画面のどれかに収まっているときだけ使う（外した画面の上に開かないように）
function onScreen(b: Bounds): boolean {
  return screen.getAllDisplays().some(({ workArea: a }) => b.x < a.x + a.width - 80 && b.x + b.width > a.x + 80 && b.y >= a.y - 10 && b.y < a.y + a.height - 80)
}

function initialBounds(state: WindowState | null): Partial<Bounds> {
  if (state?.bounds && onScreen(state.bounds)) return state.bounds
  // 新しい窓は、前の窓から少しずらして重ねる（macOS のほかのアプリと同じように）
  const from = front && !front.win.isDestroyed() ? front.win.getNormalBounds() : null
  if (from && onScreen({ ...from, x: from.x + 22, y: from.y + 22 })) return { ...from, x: from.x + 22, y: from.y + 22 }
  return { width: 1480, height: 920 }
}

// 窓を前に出す。自動テスト中は手元の入力を奪わないよう、重なりだけ前にしてフォーカスは移さない
function reveal(ws: Workspace): void {
  front = ws
  if (ws.win.isDestroyed()) return
  if (ws.win.isMinimized()) ws.win.restore()
  if (testing) {
    ws.win.showInactive()
    ws.win.moveTop()
  } else {
    ws.win.show()
    ws.win.focus()
  }
}

// fresh: 起動時や Finder から開いたもの（「最近使ったもの」に載せる）。復元した窓は載せない
function openWindow(state: WindowState | null, fresh = false): Workspace {
  const win = new BrowserWindow({
    ...initialBounds(state),
    minWidth: 900,
    minHeight: 560,
    title: 'Calmpage',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 13 },
    backgroundColor: groundColor(),
    // 自動テスト中は最前面に出さない（手元で打っているキー入力をエディターが奪わないように）
    show: !testing,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  const ws = new Workspace(win, state, workspaceChanged)
  workspaces.push(ws)
  front = ws
  if (fresh && ws.folder) addRecent(ws.folder)
  // タイトルはフォルダの名前にする（index.html の <title> で上書きさせない）
  win.on('page-title-updated', (e) => e.preventDefault())
  win.on('focus', () => (front = ws))
  let moved: NodeJS.Timeout | undefined
  const remember = (): void => {
    clearTimeout(moved)
    moved = setTimeout(persistWindows, 500)
  }
  win.on('resized', remember)
  win.on('moved', remember)
  win.on('close', (e) => {
    if (quitting || ws.released) {
      // 最後の窓を閉じるとアプリも終わる。その窓は次の起動で開き直す
      if (!quitting && workspaces.length === 1) persistWindows()
      return
    }
    e.preventDefault()
    void ws.release(() => win.close())
  })
  win.on('closed', () => {
    clearTimeout(moved)
    ws.dispose()
    workspaces.splice(workspaces.indexOf(ws), 1)
    if (front === ws) {
      front = null
      front = target(BrowserWindow.getFocusedWindow() ?? undefined)
    }
    // 閉じた窓は次の起動で開かない。終了のときと最後の窓は、閉じる前の一覧のままにする
    if (!quitting && workspaces.length) persistWindows()
  })
  // ファイルを窓に落としたとき、その場所へ移ってしまわないように
  win.webContents.on('will-navigate', (e) => e.preventDefault())
  if (testing) win.showInactive()
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  else void win.loadFile(join(__dirname, '../renderer/index.html'))
  return ws
}

// ---------- 開く ----------

function isDirectory(path: string): boolean | null {
  try {
    return statSync(path).isDirectory()
  } catch {
    return null
  }
}

// そのパスをもう開いている窓。フォルダなら同じフォルダの窓、ファイルならそれを含むフォルダの窓（prefer を先に見る）
function ownerOf(path: string, isDir: boolean, prefer: Workspace | null): Workspace | null {
  const holds = (ws: Workspace): boolean => !!ws.folder && (isDir ? ws.folder === path : path.startsWith(ws.folder + sep))
  if (prefer && holds(prefer)) return prefer
  return workspaces.find(holds) ?? null
}

function stateFor(path: string, isDir: boolean): WindowState {
  return isDir ? { folder: path, file: null, tabs: [] } : { folder: dirname(path), file: path, tabs: [] }
}

// この窓でフォルダかファイルを開く
async function openIn(ws: Workspace, path: string): Promise<void> {
  const isDir = isDirectory(path)
  if (isDir === null) return
  // フォルダが替わるときだけ、先に未保存を片付ける（同じフォルダのファイルなら画面の側で保存する）
  const next = isDir ? path : ws.folder && path.startsWith(ws.folder + sep) ? ws.folder : dirname(path)
  if (next !== ws.folder && ws.folder && !(await ws.confirmUnsaved())) return
  if (isDir) {
    ws.setFolder(path)
    ws.send('folder:opened', path, null)
  } else {
    if (!ws.folder || !path.startsWith(ws.folder + sep)) ws.setFolder(dirname(path))
    ws.send('folder:opened', ws.folder, path)
  }
}

// ⌘O・ファイルのメニューの「最近使ったもの」・雛形: 今の窓で開く。ただし、ほかの窓でもう開いていたら、その窓を前に出す
async function openHere(ws: Workspace, path: string): Promise<void> {
  const isDir = isDirectory(path)
  if (isDir === null) return
  const owner = ownerOf(path, isDir, ws)
  if (owner && owner !== ws) {
    reveal(owner)
    if (!isDir) await openIn(owner, path)
    return
  }
  await openIn(ws, path)
}

// Finder・Dock から: 開いている窓があればそれを前に出す。前の窓が空ならそこで、空でなければ新しい窓で開く
async function openOutside(path: string): Promise<void> {
  const isDir = isDirectory(path)
  if (isDir === null) return
  const owner = ownerOf(path, isDir, front)
  if (owner) {
    reveal(owner)
    if (!isDir) await openIn(owner, path)
    return
  }
  if (front && !front.folder) {
    reveal(front)
    await openIn(front, path)
    return
  }
  openWindow(stateFor(path, isDir), true)
}

// 起動時に開く窓: 前回の窓を開き直し、テスト用の CALMPAGE_OPEN は 1 つめの窓で、Finder から渡されたものはその規則で開く
function startupStates(): { state: WindowState | null; fresh: boolean }[] {
  const list = loadSettings()
    .windows.filter((w) => isDirectory(w.folder))
    .map((state) => ({ state: state as WindowState | null, fresh: false }))
  const open = process.env.CALMPAGE_OPEN
  const isDir = open ? isDirectory(open) : null
  if (open && isDir !== null) {
    const first = list[0]?.state
    const state = !isDir && first && open.startsWith(first.folder + sep) ? { ...first, file: open } : stateFor(open, isDir)
    const rest = list.slice(1).filter((w) => w.state?.folder !== state.folder)
    list.splice(0, list.length, { state, fresh: true }, ...rest)
  }
  for (const path of pendingOpens.splice(0)) {
    const isDir = isDirectory(path)
    if (isDir === null) continue
    const owner = list.find(({ state }) => state && (isDir ? state.folder === path : path.startsWith(state.folder + sep)))
    if (owner?.state && !isDir) owner.state = { ...owner.state, file: path }
    else if (!owner) list.push({ state: stateFor(path, isDir), fresh: true })
  }
  return list.length ? list : [{ state: null, fresh: false }]
}

// 最近開いたフォルダ。macOS の「最近使った項目」（Dock の右クリックなど）にも載せる。
// メニューの一覧は自前で持つ: フォルダは書類の種類として登録していないので、標準の「最近使ったもの」の
// メニュー（role: recentDocuments）には出ないことがあるため。
const RECENT_MAX = 10

function addRecent(path: string): void {
  const recent = [path, ...loadSettings().recent.filter((p) => p !== path)].slice(0, RECENT_MAX)
  saveSettings({ recent })
  // 自動テストでは、手元の Mac の「最近使った項目」を汚さない
  if (!testing) app.addRecentDocument(path)
  buildMenu()
}

function clearRecent(): void {
  saveSettings({ recent: [] })
  if (!testing) app.clearRecentDocuments()
  buildMenu()
}

function recentItems(tr: (key: Key) => string): Electron.MenuItemConstructorOptions[] {
  const recent = loadSettings().recent.filter((p) => existsSync(p))
  // 同じ名前のフォルダが並ぶときだけ、親のフォルダ名を添えて見分けられるようにする
  const label = (p: string): string =>
    recent.filter((q) => basename(q) === basename(p)).length > 1 ? `${basename(p)} — ${basename(dirname(p))}` : basename(p)
  const items: Electron.MenuItemConstructorOptions[] = recent.map((p) => ({
    label: label(p),
    click: (_item, window) => {
      const ws = target(window)
      if (ws) void openHere(ws, p)
      else openWindow(stateFor(p, true), true)
    }
  }))
  if (items.length) items.push({ type: 'separator' })
  items.push({ label: tr('menu.clearRecent'), enabled: recent.length > 0, click: clearRecent })
  return items
}

// ---------- 設定とメニュー ----------

// 設定の変更はここに集める。メニューと設定画面のどちらから変えても、すべての窓へ同じ知らせが届く。
function updateSettings(patch: Partial<Settings>): void {
  // 消した・書き換えたエージェントは止める（次に開いたとき新しい設定で起動する）
  if (patch.agents) {
    for (const old of loadSettings().agents) {
      const next = patch.agents.find((a) => a.id === old.id)
      if (JSON.stringify(next) === JSON.stringify(old)) continue
      for (const ws of workspaces) {
        ws.terminals.stop(old.id)
        ws.acpAgents.stop(old.id)
      }
    }
  }
  // 外したエージェントのうち、Calmpage が入れたものはファイルも片付ける
  if (patch.agents) void removeInstalled(loadSettings().agents, patch.agents)
  saveSettings(patch)
  if (patch.aiEnabled === false) for (const ws of workspaces) ws.stopAgents()
  if (patch.theme) nativeTheme.themeSource = patch.theme
  if (patch.theme || patch.palette) for (const ws of workspaces) ws.win.setBackgroundColor(groundColor())
  if (patch.theme || patch.palette || patch.language || patch.aiEnabled !== undefined) buildMenu()
  for (const ws of workspaces) ws.send('settings:changed', view(ws))
}

// 画面からの設定のうち、開いているファイルとタブは窓ごとに持つ。残りを返す
function takeOpenFiles(ws: Workspace, patch: Partial<Settings>): Partial<Settings> {
  const { folder: _folder, file, tabs, ...rest } = patch
  if (file !== undefined || tabs) ws.setOpenFiles({ file, tabs })
  return rest
}

function buildMenu(): void {
  const { theme, palette, language, aiEnabled } = loadSettings()
  const tr = (key: Key): string => t(language, key)
  const command = (name: string) => (_item: Electron.MenuItem, window?: BaseWindow) => target(window)?.send('menu', name)
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
          { label: tr('menu.newWindow'), accelerator: 'Cmd+Ctrl+N', click: () => void openWindow(null) },
          { type: 'separator' },
          { label: tr('menu.openFolder'), accelerator: 'CmdOrCtrl+O', click: (_item, window) => void chooseFolder(target(window)) },
          { label: tr('menu.openRecent'), submenu: recentItems(tr) },
          { type: 'separator' },
          { label: tr('menu.saveCompile'), accelerator: 'CmdOrCtrl+S', click: command('save') },
          { label: tr('menu.compile'), accelerator: 'CmdOrCtrl+R', click: command('build') },
          { label: tr('menu.cancelCompile'), accelerator: 'CmdOrCtrl+.', click: (_item, window) => target(window)?.cancelBuild() },
          { label: tr('menu.cleanAux'), click: command('clean') },
          { type: 'separator' },
          { label: tr('menu.rename'), click: command('rename') },
          { label: tr('menu.trash'), click: command('trash') },
          { label: tr('menu.reveal'), click: command('reveal') },
          { type: 'separator' },
          { label: tr('menu.openPdf'), accelerator: 'CmdOrCtrl+Shift+O', click: command('open-pdf') },
          { type: 'separator' },
          { label: tr('menu.history'), click: command('history') },
          { label: tr('menu.closeTab'), accelerator: 'CmdOrCtrl+W', click: command('close-tab') },
          { role: 'close', label: tr('menu.closeWindow'), accelerator: 'CmdOrCtrl+Shift+W' }
        ]
      },
      {
        label: tr('menu.edit'),
        // 取り消しは role: 'undo' にしない（CodeMirror の履歴とずれる）。窓に送って、エディターか入力欄で行う。
        // キーはまず窓に届き、CodeMirror が扱ったときはメニューは動かないので、二重には効かない
        submenu: [
          { label: tr('menu.undo'), accelerator: 'CmdOrCtrl+Z', click: command('undo') },
          { label: tr('menu.redo'), accelerator: 'Shift+CmdOrCtrl+Z', click: command('redo') },
          { type: 'separator' },
          { role: 'cut', label: tr('menu.cut') },
          { role: 'copy', label: tr('menu.copy') },
          { role: 'paste', label: tr('menu.paste') },
          { role: 'selectAll', label: tr('menu.selectAll') },
          { type: 'separator' },
          { label: tr('menu.find'), accelerator: 'CmdOrCtrl+F', click: command('find') },
          { label: tr('menu.replace'), accelerator: 'Alt+CmdOrCtrl+F', click: command('replace') },
          { label: tr('menu.findNext'), accelerator: 'CmdOrCtrl+G', click: command('find-next') },
          { label: tr('menu.findPrevious'), accelerator: 'Shift+CmdOrCtrl+G', click: command('find-previous') },
          { label: tr('menu.findInFolder'), accelerator: 'CmdOrCtrl+Shift+F', click: command('find-in-folder') },
          { label: tr('menu.goToLine'), accelerator: 'Alt+CmdOrCtrl+G', click: command('go-to-line') },
          { type: 'separator' },
          { label: tr('menu.toggleComment'), accelerator: 'CmdOrCtrl+/', click: command('toggle-comment') },
          {
            label: tr('menu.format'),
            submenu: [
              { label: tr('menu.bold'), accelerator: 'Shift+CmdOrCtrl+B', click: command('bold') },
              { label: tr('menu.italic'), accelerator: 'CmdOrCtrl+I', click: command('italic') },
              { label: tr('menu.emph'), accelerator: 'Shift+CmdOrCtrl+I', click: command('emph') },
              { label: tr('menu.typewriter'), click: command('typewriter') }
            ]
          }
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
          { label: tr('menu.findPdf'), accelerator: 'Shift+CmdOrCtrl+Alt+F', click: command('find-pdf') },
          { type: 'separator' },
          { label: tr('menu.theme'), submenu: [themeItem('system'), themeItem('light'), themeItem('dark')] },
          { label: tr('menu.palette'), submenu: [paletteItem('paper'), paletteItem('moss'), paletteItem('sand')] },
          { type: 'separator' },
          { role: 'toggleDevTools', label: tr('menu.devTools') }
        ]
      },
      {
        // role: 'window' で macOS の Window メニューになり、開いている窓（フォルダの名前）が一覧に並ぶ
        label: tr('menu.window'),
        role: 'window',
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

async function chooseFolder(ws: Workspace | null): Promise<void> {
  if (!ws) return
  const res = await dialog.showOpenDialog(ws.win, { properties: ['openDirectory', 'openFile'], filters: [{ name: 'LaTeX', extensions: ['tex'] }] })
  if (!res.canceled && res.filePaths[0]) await openHere(ws, res.filePaths[0])
}

// ファイル操作の失敗は、その場で短く知らせる
async function attempt<T>(ws: Workspace, job: () => Promise<T>): Promise<T | null> {
  try {
    return await job()
  } catch (err) {
    if (!ws.win.isDestroyed()) await dialog.showMessageBox(ws.win, { type: 'warning', message: tr('file.failed'), detail: err instanceof Error ? err.message : String(err) })
    return null
  }
}

function inFolder(ws: Workspace, path: string): boolean {
  return !!ws.folder && (path === ws.folder || path.startsWith(ws.folder + sep))
}

// ファイル一覧の右クリック。選んだ操作は画面に返して、画面の側で行う（名前の入力は一覧の中でするため）
function showFileMenu(ws: Workspace, target: string | null, isDir: boolean): void {
  const pick = (command: string) => () => ws.send('file-menu', command, target, isDir)
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: tr('menu.newFile'), click: pick('new-file') },
    { label: tr('menu.newFolder'), click: pick('new-folder') }
  ]
  if (target) items.push({ type: 'separator' }, { label: tr('menu.rename'), click: pick('rename') }, { label: tr('menu.trash'), click: pick('trash') })
  items.push({ type: 'separator' }, { label: tr('menu.reveal'), click: () => ws.folder && shell.showItemInFolder(target ?? ws.folder) })
  Menu.buildFromTemplate(items).popup({ window: ws.win })
}

// 雛形から新しい書類を作る。空のフォルダを選ぶか作ってもらい、雛形を置いて開く（⌘O と同じく、今の窓で）
async function createFromTemplate(ws: Workspace, id: TemplateId): Promise<boolean> {
  if (!TEMPLATE_IDS.includes(id)) return false
  if (!(await ws.confirmUnsaved())) return false
  const res = await dialog.showOpenDialog(ws.win, {
    properties: ['openDirectory', 'createDirectory'],
    message: tr('template.chooseFolder'),
    buttonLabel: tr('template.create')
  })
  const dir = res.filePaths[0]
  if (res.canceled || !dir) return false
  if (!(await isEmptyFolder(dir))) {
    await dialog.showMessageBox(ws.win, { type: 'warning', message: tr('template.notEmpty', { name: basename(dir) }), detail: tr('template.notEmptyDetail') })
    return false
  }
  const main = await attempt(ws, () => writeTemplate(id, dir))
  if (!main) return false
  await openHere(ws, main)
  return true
}

// ---------- IPC ----------

// 窓からの呼び出しは、送ってきた窓の状態で答える。閉じかけの窓からなら何もしない
function handle<A extends unknown[]>(channel: string, fn: (ws: Workspace, ...args: A) => unknown): void {
  ipcMain.handle(channel, (e, ...args) => {
    const ws = wsOf(e.sender)
    return ws ? fn(ws, ...(args as A)) : null
  })
}

function listen<A extends unknown[]>(channel: string, fn: (ws: Workspace, ...args: A) => void): void {
  ipcMain.on(channel, (e, ...args) => {
    const ws = wsOf(e.sender)
    if (ws) fn(ws, ...(args as A))
  })
}

function registerIpc(): void {
  ipcMain.on('app:reply', (_e, id: number, value: unknown) => answer(id, value))
  handle('unsaved:confirm', (ws, paths: string[] | null, save: boolean) => ws.confirmUnsaved(paths, save))
  listen('window:edited', (ws, edited: boolean) => ws.win.setDocumentEdited(edited))
  handle('folder:entries', (ws) => (ws.folder ? listProjectEntries(ws.folder) : { files: [], emptyDirs: [] }))
  handle('file:create', (ws, dir: string, name: string) => (inFolder(ws, dir) ? attempt(ws, () => createFile(dir, name)) : null))
  handle('folder:create', (ws, dir: string, name: string) => (inFolder(ws, dir) ? attempt(ws, () => createFolder(dir, name)) : null))
  handle('path:rename', (ws, path: string, name: string) => (inFolder(ws, path) && path !== ws.folder ? attempt(ws, () => renamePath(path, name)) : null))
  handle('path:trash', async (ws, path: string) => (inFolder(ws, path) && path !== ws.folder ? (await attempt(ws, () => shell.trashItem(path))) !== null : false))
  ipcMain.on('path:reveal', (_e, path: string) => shell.showItemInFolder(path))
  listen('file:quicklook', (ws, path: string) => ws.win.previewFile(path))
  listen('file:menu', (ws, target: string | null, isDir: boolean) => showFileMenu(ws, target, isDir))
  handle('file:import', (ws, src: string, dir?: string) => (ws.folder ? attempt(ws, () => importFile(ws.folder as string, src, dir)) : null))
  handle('file:import-data', (ws, name: string, data: Uint8Array, dir?: string) =>
    ws.folder ? attempt(ws, () => importData(ws.folder as string, name, data, dir)) : null
  )
  handle('template:create', (ws, id: TemplateId) => createFromTemplate(ws, id))
  // 開き直し（開発中の再読み込みなど）でも呼ばれる。見張りは窓を作ったときに始めている
  handle('app:initial', (ws) => view(ws))
  handle('folder:choose', (ws) => chooseFolder(ws))
  handle('folder:files', (ws) => (ws.folder ? listProjectFiles(ws.folder) : []))
  ipcMain.handle('file:read', (_e, path: string) => readFile(path, 'utf8'))
  handle('file:write', async (ws, path: string, content: string) => {
    ws.watcher.noteWrite(path, content)
    await recordVersion(path, content)
    await writeFile(path, content, 'utf8')
  })
  registerSearchAndHistory()
  listen('build:request', (ws, file: string) => void ws.requestBuild(file))
  listen('build:cancel', (ws) => ws.cancelBuild())
  handle('build:clean', (ws, file: string) => ws.cleanAux(file))
  ipcMain.handle('pdf:read', (_e, path: string) => readFile(path))
  handle('pdf:open-external', (ws) => (ws.currentPdf ? shell.openPath(ws.currentPdf) : null))
  handle('sync:forward', (ws, file: string, line: number, column: number) => (ws.currentPdf ? forwardSync(ws.currentPdf, file, line, column) : null))
  handle('sync:backward', (ws, page: number, x: number, y: number) => (ws.currentPdf ? backwardSync(ws.currentPdf, page, x, y) : null))
  listen('settings:save', (ws, patch: Partial<Settings>) => {
    const rest = takeOpenFiles(ws, patch)
    if (Object.keys(rest).length) saveSettings(rest)
  })
  listen('settings:update', (ws, patch: Partial<Settings>) => updateSettings(takeOpenFiles(ws, patch)))
  // 端末と ACP は窓ごと・柱のタブごとに動かす。タブの ID は画面が決める。
  handle('term:start', (ws, tab: string, id: string, cols: number, rows: number) => {
    const agent = agentConfig(id)
    return ws.folder && agent ? ws.terminals.start(tab, agent, ws.folder, cols, rows) : null
  })
  listen('term:input', (ws, tab: string, data: string) => ws.terminals.write(tab, data))
  listen('term:resize', (ws, tab: string, cols: number, rows: number) => ws.terminals.resize(tab, cols, rows))
  listen('term:close', (ws, tab: string) => ws.terminals.close(tab))
  handle('acp:start', (ws, tab: string, id: string) => {
    const agent = agentConfig(id)
    return ws.folder && agent ? ws.acpAgents.start(tab, agent, ws.folder) : { ok: false, error: 'no folder' }
  })
  handle('acp:new-session', (ws, tab: string) => ws.acpAgents.newSession(tab))
  handle('acp:authenticate', (ws, tab: string, methodId: string) => ws.acpAgents.authenticate(tab, methodId))
  handle('acp:prompt', (ws, tab: string, prompt: unknown[]) => ws.acpAgents.prompt(tab, prompt as never))
  listen('acp:cancel', (ws, tab: string) => ws.acpAgents.cancel(tab))
  listen('acp:close', (ws, tab: string) => ws.acpAgents.close(tab))
  listen('acp:answer', (ws, key: string, optionId: string | null) => ws.acpAgents.answerPermission(key, optionId))
  ipcMain.handle('registry:list', async () => {
    try {
      return { agents: await loadRegistry() }
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) }
    }
  })
  ipcMain.handle('registry:icons', () => loadIcons().catch(() => ({})))
  // 取ってきて入れたら、設定に足す。進み具合はすべての窓へ知らせる（同じ一覧を別の窓で開いていることがある）
  ipcMain.handle('registry:install', async (_e, id: string) => {
    const progress = (p: InstallProgress): void => {
      for (const ws of workspaces) ws.send('registry:progress', id, p)
    }
    try {
      const agent = await installAgent(id, progress)
      const agents = loadSettings().agents
      if (!agents.some((a) => a.id === agent.id)) updateSettings({ agents: [...agents, agent] })
      progress({ phase: 'done' })
      return { agent }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      progress({ phase: 'failed', error })
      return { error }
    }
  })
  handle('folder:completion-files', (ws) => (ws.folder ? listCompletionFiles(ws.folder) : []))
  // 誤った語の右クリック: 言い換えの候補と「辞書に追加」を出す。選んだものを返し、何も選ばなければ null
  handle('spell:menu', (ws, word: string, suggestions: string[]) => {
    const tr = (key: Key): string => t(loadSettings().language, key)
    return new Promise((resolve) => {
      let picked: { replace?: string; learned?: boolean } | null = null
      const items: Electron.MenuItemConstructorOptions[] = suggestions.length
        ? suggestions.slice(0, 8).map((s) => ({ label: s, click: () => (picked = { replace: s }) }))
        : [{ label: tr('spell.noGuesses'), enabled: false }]
      items.push(
        { type: 'separator' },
        {
          label: tr('spell.learn'),
          click: () => {
            session.defaultSession.addWordToSpellCheckerDictionary(word)
            picked = { learned: true }
          }
        }
      )
      // メニューを閉じた知らせは、項目のクリックより先に届くことがあるので、一拍おいて返す
      Menu.buildFromTemplate(items).popup({ window: ws.win, callback: () => setTimeout(() => resolve(picked), 0) })
    })
  })
  ipcMain.on('link:open', (_e, url: string) => {
    // PDF の中のリンクもここを通る。開くのは Web とメールだけ（file: などは開かない）
    if (/^(https?:\/\/|mailto:)/i.test(url)) void shell.openExternal(url)
  })
}

// フォルダ内の検索と置換、ファイルの履歴。新しい検索が来たら、その窓の古い検索は途中でやめる。
function registerSearchAndHistory(): void {
  handle('search:run', async (ws, query: string, opts: SearchOptions, overrides: Record<string, string>) => {
    const run = ++ws.searchRun
    if (!ws.folder || !query) return { files: [], total: 0, truncated: false }
    try {
      return await searchFiles((await listProjectFiles(ws.folder)).filter(isText), overrides, query, opts, () => run !== ws.searchRun)
    } catch (err) {
      return { error: String(err) }
    }
  })
  handle('search:replace', async (ws, query: string, opts: SearchOptions, replacement: string, exclude: string[]) => {
    if (!ws.folder || !query) return { files: 0, count: 0 }
    const skip = new Set(exclude)
    const targets = (await listProjectFiles(ws.folder)).filter((p) => isText(p) && inFolder(ws, p) && !skip.has(p))
    // 自分の書き込みを外部の変更と取り違えないよう、書く前に見張りへ知らせる
    return replaceInFiles(targets, query, opts, replacement, (path, before, after) => {
      ws.watcher.noteWrite(path, after)
      void recordVersion(path, after, before)
    })
  })
  handle('dialog:confirm', async (ws, message: string, detail: string, ok: string, cancel: string) => {
    const res = await dialog.showMessageBox(ws.win, { type: 'question', message, detail, buttons: [ok, cancel], defaultId: 0, cancelId: 1 })
    return res.response === 0
  })
  ipcMain.handle('history:list', (_e, path: string) => listVersions(path))
  ipcMain.handle('history:read', (_e, path: string, id: string) => readVersion(path, id))
}

// ---------- アプリ ----------

app.on('open-file', (event, path) => {
  event.preventDefault()
  if (app.isReady() && workspaces.length) void openOutside(path)
  else if (app.isReady()) openWindow(stateFor(path, !!isDirectory(path)), true)
  else pendingOpens.push(path)
})

app.whenReady().then(() => {
  // 組み立てたアプリは .icns を使う。開発中だけ Dock の Electron のアイコンを差し替える
  if (!app.isPackaged) app.dock?.setIcon(join(__dirname, '../../build/icon.png'))
  nativeTheme.themeSource = loadSettings().theme
  registerIpc()
  warmUpShellEnv()
  buildMenu()
  for (const { state, fresh } of startupStates()) openWindow(state, fresh)
  // 起動した窓の並びを書いておく（消えたフォルダを一覧から外し、CALMPAGE_OPEN などで開いたものを足す）
  persistWindows()
  app.on('activate', () => {
    if (!workspaces.length) for (const { state } of startupStates()) openWindow(state)
  })
})

// ⌘Q: 窓の close より先に来るので、ここで一度止めて、窓を 1 つずつ確かめる。どれかでキャンセルされたら終わらない
let askingQuit = false

app.on('before-quit', (e) => {
  if (quitting || !workspaces.length) return
  e.preventDefault()
  if (askingQuit) return
  askingQuit = true
  void (async () => {
    try {
      for (const ws of [...workspaces]) {
        if (!ws.win.isDestroyed() && !(await ws.confirmUnsaved(null, false, () => reveal(ws)))) return
      }
      persistWindows()
      quitting = true
      app.quit()
    } finally {
      askingQuit = false
    }
  })()
})

app.on('window-all-closed', () => app.quit())
