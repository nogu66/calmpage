import type { BuildResult, Diagnostic } from '../main/build'
import type { ContentBlock } from '@agentclientprotocol/sdk'
import type { AgentConfig, AgentKind, Settings } from '../main/settings'
import { DEFAULT_AGENTS, LOGIN_SHELL, type RegistryAgent } from '../shared/agents'
import type { SumiApi } from '../preload'
import { t, type Key } from '../shared/i18n'
import { Editor } from './editor'
import { PdfBar } from './pdf-bar'
import { Preview } from './preview'
import { TerminalPane } from './terminal'
import { ThreadPane } from './thread'

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
let pdfPath: string | null = null
let autoBuild = true
let autoTimer = 0
let settings: Settings

type StatusState = 'idle' | 'building' | 'ok' | 'error' | 'warning'
let status: { state: StatusState; key: Key; params: Record<string, string | number> } = { state: 'idle', key: 'status.idle', params: {} }
let pdfNote: { key: Key; params: Record<string, string | number> } | null = null

const tr = (key: Key, params?: Record<string, string | number>): string => t(settings?.language ?? 'en', key, params)

const editor = new Editor($('editor'), onEdit, () => updateChips())
const preview = new Preview($('pdf-scroll'), (page, x, y) => void backwardSync(page, x, y), {
  openLink: (url) => sumi.openLink(url),
  onChange: () => pdfBar.update()
})
const pdfBar = new PdfBar(preview, { sumi, tr, show: showPreview })
const terminals = new TerminalPane($('ai-terms'), sumi, () => ({ exited: tr('ai.exited') }))
const threads = new ThreadPane($('ai-threads'), {
  sumi,
  tr,
  relative,
  context: contextBlocks,
  contextSummary,
  beforeSend: saveText
})

// ---------- 表示の小物 ----------

function relative(path: string): string {
  return folder && path.startsWith(folder + '/') ? path.slice(folder.length + 1) : path
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1)
}

function setStatus(state: StatusState, key: Key, params: Record<string, string | number> = {}): void {
  status = { state, key, params }
  $('status').dataset.state = state
  $('status-text').textContent = tr(key, params)
}

// PDF の代わりにプレビューの真ん中へ出す一言。null で消す。
function setPdfNote(key: Key | null, params: Record<string, string | number> = {}): void {
  pdfNote = key ? { key, params } : null
  $('pdf-note').hidden = !pdfNote
  $('pdf-note').textContent = pdfNote ? tr(pdfNote.key, pdfNote.params) : ''
}

function clearPreview(): void {
  preview.clear()
  pdfPath = null
  document.body.classList.remove('has-pdf')
  updateChips()
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
    updateChips()
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

// 本体が別の書類に変わったら、前の書類の PDF はすぐ消す（新しい PDF ができるまで残すと取り違える）。
function onBuildStarted(root: string): void {
  setStatus('building', 'status.compiling')
  if (root === lastRoot) return
  lastRoot = root
  markActiveFile()
  clearPreview()
  setPdfNote('pdf.compiling', { file: baseName(root) })
}

async function onBuildFinished(result: BuildResult | null, file: string, error?: string): Promise<void> {
  if (!result) {
    lastRoot = null
    diagnostics = []
    clearPreview()
    setPdfNote('pdf.none')
    setStatus('error', error ? 'status.cannotCompile' : 'status.noRoot')
    diagnostics = [{ file, line: null, severity: 'error', message: error ?? tr('problem.noRoot', { file: baseName(file) }) }]
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
  if (errors) setStatus('error', 'status.errors', { n: errors })
  else if (warnings) setStatus('warning', 'status.warnings', { n: warnings, s: seconds })
  else setStatus('ok', 'status.done', { s: seconds })

  renderProblems(errors > 0)
  showEditorDiagnostics()

  if (result.pdf) {
    try {
      await preview.load(await sumi.readPdf(result.pdf))
      pdfPath = result.pdf
    } catch (err) {
      console.error('PDF の読み込みに失敗', err)
    }
  }
  if (result.root !== lastRoot) return // 読み込み中に別の書類へ移った
  document.body.classList.toggle('has-pdf', preview.loaded)
  setPdfNote(preview.loaded ? null : 'pdf.none')
  updateChips()
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
    where.textContent = d.file ? `${baseName(d.file)}${d.line ? `:${d.line}` : ''}` : tr('problem.document')
    const msg = document.createElement('span')
    msg.className = 'msg'
    msg.textContent = d.message
    li.append(where, msg)
    if (d.file) li.addEventListener('click', () => void openFile(d.file as string, d.line ?? undefined))
    list.append(li)
  }
  $('problems-title').textContent = diagnostics.length ? tr('problems.title', { n: diagnostics.length }) : tr('problems.none')
  if (open) $('problems').hidden = false
  if (!diagnostics.some((d) => d.severity !== 'info')) $('problems').hidden = true
}

// ---------- SyncTeX ----------

async function forwardSync(): Promise<void> {
  if (!editor.path || !preview.loaded) return
  // 閉じていたら開き、今の幅で描き直してから場所を示す
  if (!previewShown()) {
    togglePreview()
    preview.setZoom(preview.zoom)
  }
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
    const rest = area.width - sidebar - $('ai-col').offsetWidth - $('ai-divider').offsetWidth
    const ratio = (x: number): number => (x - area.left - sidebar) / rest
    const move = (ev: PointerEvent): void => setSplit(ratio(ev.clientX))
    const up = (ev: PointerEvent): void => {
      divider.removeEventListener('pointermove', move)
      divider.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
      sumi.saveSettings({ split: ratio(ev.clientX) })
    }
    divider.addEventListener('pointermove', move)
    divider.addEventListener('pointerup', up)
  })
}

// ---------- AI の柱 ----------

// ACP のエージェントには、送るたびにチップで選んだ文脈を添える。端末のエージェントには、押したときに貼り込む。
type ChipName = 'file' | 'errors' | 'pdf'
const chipOn: Record<ChipName, boolean> = { file: true, errors: true, pdf: true }

// 柱のタブ。同じエージェントを何本でも開ける（同じ名前が並ぶときは 2 本目から番号を付ける）。
// ACP はプロセスをエージェントごとに分け合い、セッションをタブごとに持つ。端末はタブごとに 1 つ。
interface AiTab {
  id: string
  agent: string
  n: number
}

let tabs: AiTab[] = []
let currentTab: string | null = null
let tabSeq = 0

function agentById(id: string): AgentConfig | undefined {
  return settings.agents.find((a) => a.id === id)
}

// 柱を開いたときに最初のタブで使うエージェント（最後に開いたもの）
function defaultAgent(): AgentConfig | undefined {
  return agentById(settings.agent) ?? settings.agents[0]
}

function activeTab(): AiTab | undefined {
  return tabs.find((t) => t.id === currentTab)
}

function currentAgent(): AgentConfig | undefined {
  const tab = activeTab()
  return tab && agentById(tab.agent)
}

function aiOpen(): boolean {
  return document.body.classList.contains('ai-open')
}

function setAiOpen(open: boolean, focus = true): void {
  document.body.classList.toggle('ai-open', open)
  $('toggle-ai').setAttribute('aria-pressed', String(open))
  sumi.saveSettings({ ai: open })
  if (open) ensureTab(focus)
  else editor.view.focus()
}

// タブが 1 つもなければ、最後に使ったエージェントで 1 つ開く
function ensureTab(focus = true): void {
  const agent = defaultAgent()
  if (!tabs.length && agent) openTab(agent.id, focus)
  else showTab(focus)
}

// 選んでいるタブを柱に出す。ACP なら会話の画面、それ以外は端末。初めて出すタブは、ここで起動する。
function showTab(focus = true): void {
  const tab = activeTab()
  const agent = currentAgent()
  const acp = agent?.kind === 'acp'
  $('ai-empty').hidden = !!agent
  $('ai-threads').hidden = !acp
  $('ai-terms').hidden = !agent || acp
  $('new-thread').hidden = !acp
  updateChips()
  if (!tab || !agent) return
  if (acp) threads.show(tab.id, agent, focus)
  else void terminals.show(tab.id, agent.id, focus)
}

function openTab(agent: string, focus = true): void {
  const n = Math.max(0, ...tabs.filter((t) => t.agent === agent).map((t) => t.n)) + 1
  const tab: AiTab = { id: `tab-${++tabSeq}`, agent, n }
  tabs.push(tab)
  settings.agent = agent
  sumi.saveSettings({ agent })
  selectTab(tab.id, focus)
}

function selectTab(id: string, focus = true): void {
  currentTab = id
  renderTabs()
  showTab(focus)
}

// 閉じたら隣のタブへ移る。最後の 1 つを閉じたら柱ごと閉じる。
function closeTab(id: string): void {
  const i = tabs.findIndex((t) => t.id === id)
  if (i < 0) return
  threads.drop(id)
  terminals.drop(id)
  tabs.splice(i, 1)
  if (currentTab === id) currentTab = (tabs[i] ?? tabs[i - 1])?.id ?? null
  renderTabs()
  if (!tabs.length) setAiOpen(false)
  else if (aiOpen()) showTab()
}

function closeAllTabs(): void {
  threads.reset()
  terminals.reset()
  tabs = []
  currentTab = null
  renderTabs()
}

function tabLabel(tab: AiTab): string {
  const name = agentById(tab.agent)?.name ?? ''
  return tab.n > 1 ? `${name} ${tab.n}` : name
}

function renderTabs(): void {
  const strip = $('ai-tabs')
  strip.replaceChildren()
  for (const tab of tabs) {
    const label = tabLabel(tab)
    const el = element('div', 'ai-tab')
    const main = element('button', 'ai-tab-main', label)
    main.title = label
    main.setAttribute('role', 'tab')
    main.setAttribute('aria-selected', String(tab.id === currentTab))
    main.addEventListener('click', () => selectTab(tab.id))
    const close = element('button', 'ai-tab-close', '×')
    close.title = tr('ai.closeTab')
    close.setAttribute('aria-label', `${tr('ai.closeTab')} ${label}`)
    close.addEventListener('click', () => closeTab(tab.id))
    // 中ボタンでも閉じる
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) closeTab(tab.id)
    })
    el.classList.toggle('active', tab.id === currentTab)
    el.append(main, close)
    strip.append(el)
  }
  strip.querySelector('.ai-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}

// ⇧⌘L: 閉じていれば開く。柱で入力中なら閉じる。ほかを触っていたら柱へ戻る。
function toggleAi(): void {
  if (!folder || !settings.aiEnabled) return
  if (!aiOpen()) setAiOpen(true)
  else if (threads.hasFocus() || terminals.hasFocus()) setAiOpen(false)
  else if (currentAgent()?.kind === 'acp') threads.focus()
  else terminals.focus()
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag)
  el.className = className
  if (text !== undefined) el.textContent = text
  return el
}

// 柱のタブと「+」の一覧、設定画面のエージェントの一覧
function renderAgents(): void {
  renderTabs()
  const kindLabel = (a: AgentConfig): string => (a.kind === 'acp' ? 'ACP' : tr('settings.kindTerminal'))

  const menu = $('agent-menu')
  menu.replaceChildren()
  for (const a of settings.agents) {
    const item = element('button', 'agent-item', a.name)
    item.setAttribute('role', 'menuitem')
    // 素の端末は名前だけで分かるので、種類の印を付けない
    if (a.kind === 'terminal' && a.command !== LOGIN_SHELL) item.append(element('span', 'agent-kind', kindLabel(a)))
    item.addEventListener('click', () => {
      closeAgentMenu()
      openTab(a.id)
    })
    menu.append(item)
  }
  const add = element('button', 'agent-item agent-add', tr('ai.addAgent'))
  add.addEventListener('click', () => {
    closeAgentMenu()
    openSettings('agents')
  })
  menu.append(element('hr', 'agent-sep'), add)

  const list = $('agent-list')
  list.replaceChildren()
  for (const a of settings.agents) {
    const li = element('li', 'agent-row')
    const main = element('button', 'agent-row-main')
    main.title = tr('settings.agentEdit')
    main.addEventListener('click', () => editAgent(a))
    const head = element('div', 'agent-row-head')
    head.append(element('span', 'agent-row-name', a.name), element('span', 'agent-kind', kindLabel(a)))
    main.append(head, element('div', 'agent-command', [a.command, ...a.args].join(' ')))
    const remove = element('button', 'agent-remove', '×')
    remove.title = tr('settings.agentRemove')
    remove.setAttribute('aria-label', `${tr('settings.agentRemove')} ${a.name}`)
    remove.addEventListener('click', () => removeAgent(a.id))
    li.classList.toggle('editing', a.id === editingAgent)
    li.append(main, remove)
    list.append(li)
  }
  renderAgentForm()
  renderRegistry()
}

// ---------- 設定: エージェントの編集・登録簿 ----------

let editingAgent: string | null = null
let registry: RegistryAgent[] | null = null

function renderAgentForm(): void {
  const editing = settings.agents.find((a) => a.id === editingAgent)
  $('agent-form-title').textContent = editing ? tr('settings.editing', { name: editing.name }) : tr('settings.custom')
  $('agent-form-submit').textContent = tr(editing ? 'settings.agentSave' : 'settings.agentAdd')
  $('agent-form-cancel').hidden = !editing
}

function setFormKind(kind: AgentKind): void {
  for (const b of $('agent-form-kind').querySelectorAll<HTMLElement>('button')) b.setAttribute('aria-pressed', String(b.dataset.value === kind))
}

// 引数に空白を含むものは引用符で囲んで、1 行に戻す
function joinCommand(parts: string[]): string {
  return parts.map((p) => (/\s/.test(p) ? `"${p}"` : p)).join(' ')
}

function editAgent(agent: AgentConfig): void {
  editingAgent = agent.id
  $<HTMLInputElement>('agent-form-name').value = agent.name
  $<HTMLInputElement>('agent-form-command').value = joinCommand([agent.command, ...agent.args])
  setFormKind(agent.kind)
  renderAgents()
  $('agent-form-name').focus()
}

function resetAgentForm(): void {
  editingAgent = null
  $<HTMLFormElement>('agent-form').reset()
  setFormKind('acp')
  renderAgents()
}

function restoreDefaults(): void {
  const ids = new Set(DEFAULT_AGENTS.map((a) => a.id))
  sumi.updateSettings({ agents: [...DEFAULT_AGENTS, ...settings.agents.filter((a) => !ids.has(a.id))] })
}

async function toggleRegistry(): Promise<void> {
  const open = $('registry').hidden
  $('registry').hidden = !open
  $('agent-browse').setAttribute('aria-expanded', String(open))
  if (!open || registry) return renderRegistry()
  $('registry-status').textContent = tr('settings.registryLoading')
  const res = await sumi.listRegistry()
  registry = res.agents ?? null
  $('registry-status').textContent = res.error ? tr('settings.registryFailed', { error: res.error }) : ''
  renderRegistry()
  $('registry-search').focus()
}

function renderRegistry(): void {
  if (!registry || $('registry').hidden) return
  const query = $<HTMLInputElement>('registry-search').value.trim().toLowerCase()
  const list = $('registry-list')
  list.replaceChildren()
  for (const entry of registry) {
    const { agent } = entry
    if (query && !`${agent.name} ${entry.description}`.toLowerCase().includes(query)) continue
    const added = settings.agents.some((a) => a.id === agent.id)
    const li = element('li', 'registry-row')
    const main = element('div', 'agent-row-main')
    main.append(element('div', 'agent-row-name', agent.name), element('div', 'registry-desc', entry.description))
    const action = element('button', 'registry-add', tr(added ? 'settings.added' : entry.installed ? 'settings.agentAdd' : 'settings.notInstalled'))
    action.disabled = added || !entry.installed
    if (!entry.installed) action.title = tr('settings.notInstalledHint', { command: agent.command })
    action.addEventListener('click', () => sumi.updateSettings({ agents: [...settings.agents, agent] }))
    li.append(main, action)
    list.append(li)
  }
}

// 「+」の一覧。「+」はタブの数で左右に動くので、ウィンドウからはみ出さない位置に出す。
function openAgentMenu(): void {
  const menu = $('agent-menu')
  const button = $('new-tab').getBoundingClientRect()
  menu.hidden = false
  menu.style.top = `${button.bottom + 4}px`
  menu.style.left = `${Math.max(8, Math.min(button.left, window.innerWidth - menu.offsetWidth - 8))}px`
  $('new-tab').setAttribute('aria-expanded', 'true')
}

function closeAgentMenu(): void {
  $('agent-menu').hidden = true
  $('new-tab').setAttribute('aria-expanded', 'false')
}

function removeAgent(id: string): void {
  sumi.updateSettings({ agents: settings.agents.filter((a) => a.id !== id) })
}

// 「npx -y pkg --acp」のような 1 行を、コマンドと引数に分ける（引用符で囲めば空白を含められる）
function parseCommand(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3])
}

// 自分で書いたエージェントを足す。編集中なら、その行を書き換える（環境変数はそのまま残す）。
function submitAgent(e: SubmitEvent): void {
  e.preventDefault()
  const name = $<HTMLInputElement>('agent-form-name').value.trim()
  const parts = parseCommand($<HTMLInputElement>('agent-form-command').value.trim())
  if (!name || !parts.length) return
  const kind = ($('agent-form-kind').querySelector('[aria-pressed="true"]') as HTMLElement).dataset.value as AgentKind
  const editing = settings.agents.find((a) => a.id === editingAgent)
  if (editing) {
    const agent: AgentConfig = { ...editing, name, kind, command: parts[0], args: parts.slice(1) }
    editingAgent = null
    sumi.updateSettings({ agents: settings.agents.map((a) => (a.id === agent.id ? agent : a)) })
  } else {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'agent'
    const agent: AgentConfig = { id: `${slug}-${Date.now().toString(36)}`, name, kind, command: parts[0], args: parts.slice(1) }
    sumi.updateSettings({ agents: [...settings.agents, agent] })
  }
  $<HTMLFormElement>('agent-form').reset()
  setFormKind('acp')
}

function setAiWidth(px: number): void {
  document.documentElement.style.setProperty('--ai-width', `${Math.round(px)}px`)
}

function setupAiDivider(): void {
  const divider = $('ai-divider')
  divider.addEventListener('pointerdown', (e) => {
    divider.setPointerCapture(e.pointerId)
    document.body.classList.add('resizing')
    const area = $('workspace').getBoundingClientRect()
    const width = (x: number): number => Math.min(area.width * 0.5, Math.max(320, area.right - x))
    const move = (ev: PointerEvent): void => setAiWidth(width(ev.clientX))
    const up = (ev: PointerEvent): void => {
      divider.removeEventListener('pointermove', move)
      divider.removeEventListener('pointerup', up)
      document.body.classList.remove('resizing')
      sumi.saveSettings({ aiWidth: width(ev.clientX) })
    }
    divider.addEventListener('pointermove', move)
    divider.addEventListener('pointerup', up)
  })
}

function fileUrl(path: string): string {
  return `file://${encodeURI(path)}`
}

function selectionRange(): string | null {
  const lines = editor.selectionLines()
  if (!lines) return null
  return lines.from === lines.to ? `${lines.from}` : `${lines.from}–${lines.to}`
}

function errorItems(): string[] {
  return diagnostics
    .filter((d) => d.severity === 'error')
    .map((d) => `- ${d.file ? relative(d.file) : ''}${d.line ? `:${d.line}` : ''} ${d.message}`)
}

// チップの中身。使えないもの（ファイルなし・エラーなし・PDF なし）は押せなくする。
function chipLabels(): Record<ChipName, string | null> {
  const name = editor.path ? baseName(editor.path) : null
  const range = selectionRange()
  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const page = pdfPath ? preview.currentPage() : 0
  return {
    file: name && (range ? tr('ai.lines', { file: name, range }) : name),
    errors: errors ? tr('ai.errors', { n: errors }) : null,
    pdf: page ? tr('ai.pdfPage', { page }) : null
  }
}

function updateChips(): void {
  const acp = currentAgent()?.kind === 'acp'
  const labels = chipLabels()
  const empty: Record<ChipName, Key> = { file: 'ai.noFile', errors: 'ai.noErrors', pdf: 'ai.noPdf' }
  for (const name of ['file', 'errors', 'pdf'] as ChipName[]) {
    const chip = $<HTMLButtonElement>(`chip-${name}`)
    chip.textContent = labels[name] ?? tr(empty[name])
    chip.disabled = !labels[name]
    if (acp) {
      chip.setAttribute('aria-pressed', String(chipOn[name]))
      chip.title = tr(chipOn[name] ? 'ai.chipOn' : 'ai.chipOff')
    } else {
      chip.removeAttribute('aria-pressed')
      chip.title = tr('ai.insertHint')
    }
  }
}

// ACP: 送るたびに添える文脈
function contextBlocks(): ContentBlock[] {
  const blocks: ContentBlock[] = []
  if (chipOn.file && editor.path) {
    blocks.push({ type: 'resource_link', uri: fileUrl(editor.path), name: relative(editor.path) })
    const lines = editor.selectionLines()
    if (lines) blocks.push({ type: 'text', text: `Selected lines ${lines.from}-${lines.to} of ${relative(editor.path)}:\n\n${editor.selectionText()}` })
  }
  const errors = errorItems()
  if (chipOn.errors && errors.length) blocks.push({ type: 'text', text: `LaTeX compile errors:\n${errors.join('\n')}` })
  if (chipOn.pdf && pdfPath) {
    const page = preview.currentPage()
    blocks.push({ type: 'resource_link', uri: fileUrl(pdfPath), name: baseName(pdfPath), title: `Compiled PDF (page ${page})` })
    blocks.push({ type: 'text', text: `The user is looking at page ${page} of the compiled PDF.` })
  }
  return blocks
}

function contextSummary(): string {
  const labels = chipLabels()
  return (['file', 'errors', 'pdf'] as ChipName[])
    .filter((name) => chipOn[name] && labels[name])
    .map((name) => labels[name])
    .join(' · ')
}

// 端末: 押したチップの参照を入力欄に貼り込む。Claude Code は「@パス#L行」で中身ごと読み込む。
function insertChip(name: ChipName): void {
  const agent = currentAgent()
  const claude = agent?.command.split('/').pop() === 'claude'
  const ref = (path: string, range: string | null): string =>
    claude ? `@${relative(path)}${range ? `#L${range.replace('–', '-')}` : ''}` : `${relative(path)}${range ? `:${range.replace('–', '-')}` : ''}`
  if (name === 'file' && editor.path) terminals.insert(`${ref(editor.path, selectionRange())} `)
  if (name === 'errors') terminals.insert(`LaTeX compile errors:\n${errorItems().join('\n')}\n`)
  if (name === 'pdf' && pdfPath) terminals.insert(`${ref(pdfPath, null)} (page ${preview.currentPage()}) `)
}

function onChip(name: ChipName): void {
  if (currentAgent()?.kind !== 'acp') return insertChip(name)
  chipOn[name] = !chipOn[name]
  updateChips()
}

function setupAi(): void {
  $('toggle-ai').addEventListener('click', () => setAiOpen(!aiOpen()))
  $('new-tab').addEventListener('click', () => ($('agent-menu').hidden ? openAgentMenu() : closeAgentMenu()))
  document.addEventListener('pointerdown', (e) => {
    if (!$('agent-menu').hidden && !(e.target as HTMLElement).closest('.agent-picker-wrap')) closeAgentMenu()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('agent-menu').hidden) closeAgentMenu()
  })
  $('new-thread').addEventListener('click', () => threads.newThread())
  for (const name of ['file', 'errors', 'pdf'] as ChipName[]) $(`chip-${name}`).addEventListener('click', () => onChip(name))
  for (const b of $('agent-form-kind').querySelectorAll<HTMLButtonElement>('button')) {
    b.addEventListener('click', () => setFormKind(b.dataset.value as AgentKind))
  }
  $<HTMLFormElement>('agent-form').addEventListener('submit', submitAgent)
  $('agent-form-cancel').addEventListener('click', resetAgentForm)
  $('agent-browse').addEventListener('click', () => void toggleRegistry())
  $('agent-restore').addEventListener('click', restoreDefaults)
  $('registry-search').addEventListener('input', renderRegistry)
  let scrollFrame = 0
  $('pdf-scroll').addEventListener('scroll', () => {
    cancelAnimationFrame(scrollFrame)
    scrollFrame = requestAnimationFrame(updateChips)
  })
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => terminals.applyTheme())
  setupAiDivider()
}

function setSidebarShown(show: boolean): void {
  document.body.classList.toggle('no-sidebar', !show)
  $('toggle-sidebar').setAttribute('aria-pressed', String(show))
}

function toggleSidebar(): void {
  const show = document.body.classList.contains('no-sidebar')
  setSidebarShown(show)
  sumi.saveSettings({ sidebar: show })
}

function previewShown(): boolean {
  return !document.body.classList.contains('no-preview')
}

function setPreviewShown(show: boolean): void {
  document.body.classList.toggle('no-preview', !show)
  $('toggle-preview').setAttribute('aria-pressed', String(show))
}

function togglePreview(): void {
  setPreviewShown(!previewShown())
  sumi.saveSettings({ preview: previewShown() })
}

// 閉じていたら開き、今の幅で描き直す
function showPreview(): void {
  if (previewShown()) return
  togglePreview()
  preview.setZoom(preview.zoom)
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
    case 'toggle-preview':
      return togglePreview()
    case 'toggle-ai':
      return toggleAi()
    case 'toggle-problems':
      $('problems').hidden = !$('problems').hidden
      return
    case 'settings':
      return openSettings()
    case 'zoom-in':
      preview.setZoom(preview.zoom * 1.15)
      break
    case 'zoom-out':
      preview.setZoom(preview.zoom / 1.15)
      break
    case 'zoom-reset':
      sumi.updateSettings({ pdfView: 'width' })
      preview.setZoom(1)
      break
    case 'find-pdf':
      return pdfBar.openFind()
  }
  sumi.saveSettings({ zoom: preview.zoom })
}

async function onFolderOpened(next: string, file: string | null): Promise<void> {
  folder = next
  lastRoot = null
  diagnostics = []
  clearPreview()
  setPdfNote(null)
  // タブの並びは残し、中身だけ新しいフォルダで起動し直す（main 側ではもう止めてある）
  threads.reset()
  terminals.reset()
  $('ai-folder').textContent = baseName(next)
  $('ai-folder').title = next
  renderProblems(false)
  setStatus('idle', 'status.idle')
  $('engine').textContent = ''
  await refreshFiles()
  updateTitle()
  const first = file ?? files.find((f) => f.endsWith('.tex'))
  if (first) await openFile(first)
  if (aiOpen()) ensureTab(false)
}

// ほかのエディターや AI が書き換えたら、開いている内容を読み直して組み直す。
async function onFileChanged(path: string, content: string): Promise<void> {
  if (!files.includes(path)) await refreshFiles()
  editor.reloadFromDisk(path, content)
  if (path === editor.path) showEditorDiagnostics()
  if (editor.path) sumi.requestBuild(editor.path)
}

// ---------- 設定と言語 ----------

function applyLanguage(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = tr(el.dataset.i18n as Key)
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) el.title = tr(el.dataset.i18nTitle as Key)
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) el.setAttribute('aria-label', tr(el.dataset.i18nAria as Key))
  for (const el of document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) el.placeholder = tr(el.dataset.i18nPlaceholder as Key)
  threads.applyLanguage()
  $('status-text').textContent = tr(status.key, status.params)
  if (pdfNote) setPdfNote(pdfNote.key, pdfNote.params)
  renderProblems(false)
  updateChips()
  pdfBar.update()
}

// main から届いた設定を画面に映す（メニューと設定画面のどちらで変えてもここを通る）
function applySettings(next: Settings): void {
  const prev = settings as Settings | undefined
  const languageChanged = prev?.language !== next.language
  settings = next
  document.documentElement.dataset.palette = next.palette
  document.documentElement.lang = next.language
  autoBuild = next.auto
  $<HTMLInputElement>('auto').checked = next.auto
  $<HTMLInputElement>('settings-auto').checked = next.auto
  $<HTMLInputElement>('settings-ai').checked = next.aiEnabled
  document.body.classList.toggle('ai-off', !next.aiEnabled)
  for (const group of document.querySelectorAll<HTMLElement>('[data-setting]')) {
    const value = next[group.dataset.setting as 'language' | 'theme' | 'palette' | 'pdfView']
    for (const button of group.querySelectorAll<HTMLButtonElement>('button')) {
      button.setAttribute('aria-pressed', String(button.dataset.value === value))
    }
  }
  if (languageChanged) applyLanguage()
  terminals.applyTheme()
  pdfBar.apply(next)

  // 設定を変えたエージェントのタブは、新しい設定で起動し直す。消したエージェントのタブは閉じる（main 側では止めてある）
  let agentsChanged = false
  for (const old of prev?.agents ?? []) {
    const now = next.agents.find((a) => a.id === old.id)
    if (JSON.stringify(now) === JSON.stringify(old)) continue
    agentsChanged = true
    for (const tab of tabs.filter((t) => t.agent === old.id)) {
      threads.drop(tab.id)
      terminals.drop(tab.id)
    }
    if (!now) tabs = tabs.filter((t) => t.agent !== old.id)
  }
  if (!activeTab()) currentTab = tabs[0]?.id ?? null
  renderAgents()
  // AI を切ったら、柱を閉じて画面からも片付ける（main 側ではエージェントを止めてある）
  if (!next.aiEnabled && prev?.aiEnabled !== false) {
    if (aiOpen()) setAiOpen(false)
    closeAllTabs()
  } else if (aiOpen() && agentsChanged) ensureTab(false)
  else updateChips()
}

function openSettings(section?: 'agents'): void {
  $('settings').hidden = false
  if (section === 'agents') {
    $('agent-list').scrollIntoView({ block: 'center' })
    $('agent-form-name').focus()
  } else {
    $('settings-close').focus()
  }
}

function closeSettings(): void {
  $('settings').hidden = true
}

function setupSettings(): void {
  $('open-settings').addEventListener('click', () => openSettings())
  $('settings-close').addEventListener('click', closeSettings)
  $('settings').addEventListener('click', (e) => {
    if (e.target === $('settings')) closeSettings()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('settings').hidden) closeSettings()
  })
  for (const group of document.querySelectorAll<HTMLElement>('[data-setting]')) {
    for (const button of group.querySelectorAll<HTMLButtonElement>('button')) {
      button.addEventListener('click', () => sumi.updateSettings({ [group.dataset.setting as string]: button.dataset.value }))
    }
  }
  $<HTMLInputElement>('settings-ai').addEventListener('change', (e) => sumi.updateSettings({ aiEnabled: (e.target as HTMLInputElement).checked }))
  for (const id of ['auto', 'settings-auto']) {
    $<HTMLInputElement>(id).addEventListener('change', (e) => sumi.updateSettings({ auto: (e.target as HTMLInputElement).checked }))
  }
}

async function init(): Promise<void> {
  const initial = await sumi.initial()
  applySettings(initial)
  sumi.onSettings(applySettings)
  setupSettings()
  setSplit(initial.split)
  setSidebarShown(initial.sidebar)
  setPreviewShown(initial.preview)
  preview.zoom = initial.zoom
  setupDivider()
  setAiWidth(initial.aiWidth)
  setupAi()

  $('open-folder').addEventListener('click', () => void sumi.chooseFolder())
  $('toggle-preview').addEventListener('click', togglePreview)
  $('toggle-sidebar').addEventListener('click', toggleSidebar)
  $('problems-close').addEventListener('click', () => ($('problems').hidden = true))
  $('status').addEventListener('click', () => ($('problems').hidden = !$('problems').hidden))

  sumi.onMenu(handleMenu)
  sumi.onFolderOpened((f, file) => void onFolderOpened(f, file))
  sumi.onFileChanged((p, c) => void onFileChanged(p, c))
  sumi.onBuildStarted(onBuildStarted)
  sumi.onBuildFinished((r, f, err) => void onBuildFinished(r, f, err))

  window.addEventListener('beforeunload', () => void saveText())

  if (initial.folder) await onFolderOpened(initial.folder, initial.file && initial.file.startsWith(initial.folder) ? initial.file : null)
  else updateTitle()
  if (initial.ai && initial.aiEnabled && initial.folder) setAiOpen(true, false)
}

void init()
