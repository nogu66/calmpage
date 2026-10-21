import type { BuildResult, Diagnostic } from '../main/build'
import type { SumiApi } from '../preload'
import { Editor } from './editor'
import { Preview } from './preview'

declare global {
  interface Window {
    sumi: SumiApi
  }
}

const sumi = window.sumi
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

const AUTO_BUILD_DELAY = 1200

let folder: string | null = null
let files: string[] = []
let diagnostics: Diagnostic[] = []
let lastRoot: string | null = null
let autoBuild = true
let autoTimer = 0

const editor = new Editor($('editor'), onEdit)
const preview = new Preview($('pdf-scroll'), (page, x, y) => void backwardSync(page, x, y))

// ---------- 表示の小物 ----------

function relative(path: string): string {
  return folder && path.startsWith(folder + '/') ? path.slice(folder.length + 1) : path
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function setStatus(state: 'idle' | 'building' | 'ok' | 'error' | 'warning', text: string): void {
  $('status').dataset.state = state
  $('status-text').textContent = text
}

function updateDirty(): void {
  $('dirty').hidden = !editor.isDirty()
}

function updateTitle(): void {
  $('folder-name').textContent = folder ? baseName(folder) : ''
  $('crumb-sep').hidden = !editor.path
  $('file-name').textContent = editor.path ? relative(editor.path) : ''
  document.body.classList.toggle('empty', !folder)
}

// ---------- ファイル一覧 ----------

async function refreshFiles(): Promise<void> {
  files = folder ? await sumi.listFiles() : []
  const list = $('file-list')
  list.replaceChildren()
  let dir: string | null = null
  for (const path of files) {
    const rel = relative(path)
    const d = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    if (d !== dir) {
      dir = d
      if (d) {
        const head = document.createElement('li')
        head.className = 'dir'
        head.textContent = d
        head.title = d
        list.append(head)
      }
    }
    const li = document.createElement('li')
    li.className = 'file'
    li.dataset.path = path
    li.textContent = baseName(path)
    li.title = rel
    li.addEventListener('click', () => void openFile(path))
    list.append(li)
  }
  markActiveFile()
}

function markActiveFile(): void {
  for (const li of $('file-list').querySelectorAll<HTMLElement>('li.file')) {
    li.classList.toggle('active', li.dataset.path === editor.path)
    li.classList.toggle('root', li.dataset.path === lastRoot)
  }
}

// ---------- 開く・保存・組版 ----------

async function openFile(path: string, line?: number): Promise<void> {
  if (editor.path !== path) {
    if (editor.isDirty()) await saveText()
    const text = await sumi.readFile(path)
    editor.open(path, text)
    sumi.saveSettings({ file: path })
    updateTitle()
    updateDirty()
    markActiveFile()
    showEditorDiagnostics()
    if (!path.endsWith('.bib')) sumi.requestBuild(path)
  }
  if (line) editor.goToLine(line)
}

async function saveText(): Promise<void> {
  const path = editor.path
  clearTimeout(autoTimer)
  if (!path || !editor.isDirty()) return
  const text = editor.text()
  await sumi.writeFile(path, text)
  editor.markSaved(path, text)
  updateDirty()
}

async function save(): Promise<void> {
  await saveText()
  if (editor.path) sumi.requestBuild(editor.path)
}

function onEdit(): void {
  updateDirty()
  clearTimeout(autoTimer)
  if (autoBuild) autoTimer = window.setTimeout(() => void save(), AUTO_BUILD_DELAY)
}

async function onBuildFinished(result: BuildResult | null, file: string, error?: string): Promise<void> {
  if (!result) {
    setStatus('error', error ? '組版できません' : '本体が見つかりません')
    diagnostics = [
      {
        file,
        line: null,
        severity: 'error',
        message: error ?? `${baseName(file)} を読み込んでいる本体の .tex が見つかりません。先頭に「% !TEX root = 本体.tex」と書くと指定できます。`
      }
    ]
    renderProblems(true)
    return
  }
  lastRoot = result.root
  diagnostics = result.diagnostics
  $('engine').textContent = result.engine
  markActiveFile()

  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length
  const seconds = (result.durationMs / 1000).toFixed(1)
  if (errors) setStatus('error', `エラー ${errors} 件`)
  else if (warnings) setStatus('warning', `警告 ${warnings} 件 · ${seconds}秒`)
  else setStatus('ok', `完了 · ${seconds}秒`)

  renderProblems(errors > 0)
  showEditorDiagnostics()

  if (result.pdf) {
    try {
      await preview.load(await sumi.readPdf(result.pdf))
      document.body.classList.add('has-pdf')
    } catch (err) {
      console.error('PDF の読み込みに失敗', err)
    }
  }
}

// ---------- 問題の一覧 ----------

function showEditorDiagnostics(): void {
  const path = editor.path
  editor.showDiagnostics(
    diagnostics
      .filter((d) => d.file === path && d.line !== null)
      .map((d) => ({ line: d.line as number, severity: d.severity, message: d.message }))
  )
}

function renderProblems(open: boolean): void {
  const list = $('problem-list')
  list.replaceChildren()
  for (const d of diagnostics) {
    const li = document.createElement('li')
    li.className = d.severity
    const where = document.createElement('span')
    where.className = 'where'
    where.textContent = d.file ? `${baseName(d.file)}${d.line ? `:${d.line}` : ''}` : '文書全体'
    const msg = document.createElement('span')
    msg.className = 'msg'
    msg.textContent = d.message
    li.append(where, msg)
    if (d.file) li.addEventListener('click', () => void openFile(d.file as string, d.line ?? undefined))
    list.append(li)
  }
  $('problems-title').textContent = diagnostics.length ? `問題 ${diagnostics.length} 件` : '問題はありません'
  if (open) $('problems').hidden = false
  if (!diagnostics.some((d) => d.severity !== 'info')) $('problems').hidden = true
}

// ---------- SyncTeX ----------

async function forwardSync(): Promise<void> {
  if (!editor.path || !preview.loaded) return
  const { line, column } = editor.cursor()
  const box = await sumi.forwardSync(editor.path, line, column)
  if (box) preview.reveal(box)
}

async function backwardSync(page: number, x: number, y: number): Promise<void> {
  const hit = await sumi.backwardSync(page, x, y)
  if (hit) await openFile(hit.file, hit.line)
}

// ---------- 分割と表示切り替え ----------

function setSplit(ratio: number): void {
  const clamped = Math.min(0.75, Math.max(0.25, ratio))
  document.documentElement.style.setProperty('--split', String(clamped))
}

function setupDivider(): void {
  const divider = $('divider')
  divider.addEventListener('pointerdown', (e) => {
    divider.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing')
    const area = $('workspace').getBoundingClientRect()
    const sidebar = $('sidebar').getBoundingClientRect().width
    const move = (ev: PointerEvent): void => setSplit((ev.clientX - area.left - sidebar) / (area.width - sidebar))
    const up = (ev: PointerEvent): void => {
      divider.removeEventListener('pointermove', move)
      divider.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
      sumi.saveSettings({ split: (ev.clientX - area.left - sidebar) / (area.width - sidebar) })
    }
    divider.addEventListener('pointermove', move)
    divider.addEventListener('pointerup', up)
  })
}

function toggleSidebar(): void {
  const hidden = document.body.classList.toggle('no-sidebar')
  sumi.saveSettings({ sidebar: !hidden })
}

// ---------- メニューと外部の変更 ----------

function handleMenu(command: string): void {
  switch (command) {
    case 'save':
      return void save()
    case 'build':
      if (editor.path) sumi.requestBuild(editor.path)
      return
    case 'forward-sync':
      return void forwardSync()
    case 'open-pdf':
      return void sumi.openPdfExternally()
    case 'toggle-sidebar':
      return toggleSidebar()
    case 'toggle-problems':
      $('problems').hidden = !$('problems').hidden
      return
    case 'zoom-in':
      preview.setZoom(preview.zoom * 1.15)
      break
    case 'zoom-out':
      preview.setZoom(preview.zoom / 1.15)
      break
    case 'zoom-reset':
      preview.setZoom(1)
      break
  }
  sumi.saveSettings({ zoom: preview.zoom })
}

async function onFolderOpened(next: string, file: string | null): Promise<void> {
  folder = next
  lastRoot = null
  diagnostics = []
  preview.clear()
  document.body.classList.remove('has-pdf')
  renderProblems(false)
  setStatus('idle', '待機中')
  $('engine').textContent = ''
  await refreshFiles()
  updateTitle()
  const first = file ?? files.find((f) => f.endsWith('.tex'))
  if (first) await openFile(first)
}

// ほかのエディターや AI が書き換えたら、開いている内容を読み直して組み直す。
async function onFileChanged(path: string, content: string): Promise<void> {
  if (!files.includes(path)) await refreshFiles()
  editor.reloadFromDisk(path, content)
  if (path === editor.path) showEditorDiagnostics()
  if (editor.path) sumi.requestBuild(editor.path)
}

async function init(): Promise<void> {
  const settings = await sumi.initial()
  document.documentElement.dataset.palette = settings.palette
  sumi.onPalette((palette) => (document.documentElement.dataset.palette = palette))
  autoBuild = settings.auto
  $<HTMLInputElement>('auto').checked = autoBuild
  $<HTMLInputElement>('auto').addEventListener('change', (e) => {
    autoBuild = (e.target as HTMLInputElement).checked
    sumi.saveSettings({ auto: autoBuild })
  })
  setSplit(settings.split)
  document.body.classList.toggle('no-sidebar', !settings.sidebar)
  preview.zoom = settings.zoom
  setupDivider()

  $('open-folder').addEventListener('click', () => void sumi.chooseFolder())
  $('problems-close').addEventListener('click', () => ($('problems').hidden = true))
  $('status').addEventListener('click', () => ($('problems').hidden = !$('problems').hidden))

  sumi.onMenu(handleMenu)
  sumi.onFolderOpened((f, file) => void onFolderOpened(f, file))
  sumi.onFileChanged((p, c) => void onFileChanged(p, c))
  sumi.onBuildStarted(() => setStatus('building', '組版中…'))
  sumi.onBuildFinished((r, f, err) => void onBuildFinished(r, f, err))

  window.addEventListener('beforeunload', () => void saveText())

  if (settings.folder) await onFolderOpened(settings.folder, settings.file && settings.file.startsWith(settings.folder) ? settings.file : null)
  else updateTitle()
}

void init()
