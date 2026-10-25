import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { BuildResult, SyncBox } from '../main/build'
import type { ProjectEntries } from '../main/files'
import type { TemplateId } from '../main/templates'
import type { ContentBlock, RequestPermissionRequest, SessionUpdate } from '@agentclientprotocol/sdk'
import type { StartResult } from '../main/acp'
import type { Settings } from '../main/settings'
import type { RegistryAgent } from '../shared/agents'
import type { SearchOptions, SearchResult } from '../shared/search'
import type { Version } from '../main/history'

// 閉じる前の片付け: auto は自動コンパイルなら保存、save は保存、discard は捨てる。残った（保存できなかった）ものを返す
export type FlushMode = 'auto' | 'save' | 'discard'
export interface Unsaved {
  path: string
  error: string | null
}

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, ...args: unknown[]): void => cb(...(args as T))
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  initial: (): Promise<Settings> => ipcRenderer.invoke('app:initial'),
  chooseFolder: (): Promise<void> => ipcRenderer.invoke('folder:choose'),
  listFiles: (): Promise<string[]> => ipcRenderer.invoke('folder:files'),
  readFile: (path: string): Promise<string> => ipcRenderer.invoke('file:read', path),
  writeFile: (path: string, content: string): Promise<void> => ipcRenderer.invoke('file:write', path, content),
  requestBuild: (file: string): void => ipcRenderer.send('build:request', file),
  readPdf: (path: string): Promise<Uint8Array> => ipcRenderer.invoke('pdf:read', path),
  openPdfExternally: (): Promise<void> => ipcRenderer.invoke('pdf:open-external'),
  forwardSync: (file: string, line: number, column: number): Promise<SyncBox | null> =>
    ipcRenderer.invoke('sync:forward', file, line, column),
  backwardSync: (page: number, x: number, y: number): Promise<{ file: string; line: number } | null> =>
    ipcRenderer.invoke('sync:backward', page, x, y),
  saveSettings: (patch: Partial<Settings>): void => ipcRenderer.send('settings:save', patch),
  updateSettings: (patch: Partial<Settings>): void => ipcRenderer.send('settings:update', patch),
  termStart: (tab: string, id: string, cols: number, rows: number): Promise<string | null> =>
    ipcRenderer.invoke('term:start', tab, id, cols, rows),
  termInput: (tab: string, data: string): void => ipcRenderer.send('term:input', tab, data),
  termResize: (tab: string, cols: number, rows: number): void => ipcRenderer.send('term:resize', tab, cols, rows),
  termClose: (tab: string): void => ipcRenderer.send('term:close', tab),
  acpStart: (tab: string, id: string): Promise<StartResult> => ipcRenderer.invoke('acp:start', tab, id),
  acpNewSession: (tab: string): Promise<StartResult> => ipcRenderer.invoke('acp:new-session', tab),
  acpAuthenticate: (tab: string, methodId: string): Promise<StartResult> => ipcRenderer.invoke('acp:authenticate', tab, methodId),
  acpPrompt: (tab: string, prompt: ContentBlock[]): Promise<{ stopReason?: string; error?: string }> =>
    ipcRenderer.invoke('acp:prompt', tab, prompt),
  acpCancel: (tab: string): void => ipcRenderer.send('acp:cancel', tab),
  acpClose: (tab: string): void => ipcRenderer.send('acp:close', tab),
  acpAnswer: (key: string, optionId: string | null): void => ipcRenderer.send('acp:answer', key, optionId),
  openLink: (url: string): void => ipcRenderer.send('link:open', url),
  listRegistry: (): Promise<{ agents?: RegistryAgent[]; error?: string }> => ipcRenderer.invoke('registry:list'),
  search: (query: string, opts: SearchOptions, overrides: Record<string, string>): Promise<SearchResult | { error: string } | null> =>
    ipcRenderer.invoke('search:run', query, opts, overrides),
  replaceInFolder: (query: string, opts: SearchOptions, replacement: string, exclude: string[]): Promise<{ files: number; count: number }> =>
    ipcRenderer.invoke('search:replace', query, opts, replacement, exclude),
  confirm: (message: string, detail: string, ok: string, cancel: string): Promise<boolean> =>
    ipcRenderer.invoke('dialog:confirm', message, detail, ok, cancel),
  listVersions: (path: string): Promise<Version[]> => ipcRenderer.invoke('history:list', path),
  readVersion: (path: string, id: string): Promise<string> => ipcRenderer.invoke('history:read', path, id),

  // ファイル操作。失敗したら main がその場で知らせ、null を返す
  listEntries: (): Promise<ProjectEntries> => ipcRenderer.invoke('folder:entries'),
  createFile: (dir: string, name: string): Promise<string | null> => ipcRenderer.invoke('file:create', dir, name),
  createFolder: (dir: string, name: string): Promise<string | null> => ipcRenderer.invoke('folder:create', dir, name),
  renamePath: (path: string, name: string): Promise<string | null> => ipcRenderer.invoke('path:rename', path, name),
  trashPath: (path: string): Promise<boolean> => ipcRenderer.invoke('path:trash', path),
  revealPath: (path: string): void => ipcRenderer.send('path:reveal', path),
  quickLook: (path: string): void => ipcRenderer.send('file:quicklook', path),
  showFileMenu: (target: string | null, isDir: boolean): void => ipcRenderer.send('file:menu', target, isDir),
  importFile: (src: string, dir?: string): Promise<string | null> => ipcRenderer.invoke('file:import', src, dir),
  importData: (name: string, data: Uint8Array, dir?: string): Promise<string | null> => ipcRenderer.invoke('file:import-data', name, data, dir),
  // ドロップしたファイルの場所。ブラウザから運んだ画像などは '' になる
  pathForFile: (file: File): string => webUtils.getPathForFile(file),
  createFromTemplate: (id: TemplateId): Promise<boolean> => ipcRenderer.invoke('template:create', id),
  confirmUnsaved: (paths: string[] | null, save = false): Promise<boolean> => ipcRenderer.invoke('unsaved:confirm', paths, save),
  setEdited: (edited: boolean): void => ipcRenderer.send('window:edited', edited),
  onFlush: (cb: (mode: FlushMode, paths: string[] | null) => Promise<Unsaved[]>) =>
    on('app:flush', async (id: number, mode: FlushMode, paths: string[] | null) => ipcRenderer.send('app:reply', id, await cb(mode, paths))),
  onFileMenu: (cb: (command: string, target: string | null, isDir: boolean) => void) => on('file-menu', cb),
  onFilesChanged: (cb: () => void) => on('files:changed', cb),

  onFolderOpened: (cb: (folder: string, file: string | null) => void) => on('folder:opened', cb),
  onFileChanged: (cb: (path: string, content: string, source: boolean) => void) => on('file:changed', cb),
  onBuildStarted: (cb: (root: string) => void) => on('build:started', cb),
  onBuildFinished: (cb: (result: BuildResult | null, file: string, error?: string) => void) => on('build:finished', cb),
  onMenu: (cb: (command: string) => void) => on('menu', cb),
  onSettings: (cb: (settings: Settings) => void) => on('settings:changed', cb),
  onTermData: (cb: (tab: string, data: string) => void) => on('term:data', cb),
  onTermExit: (cb: (tab: string, code: number) => void) => on('term:exit', cb),
  onAcpUpdate: (cb: (tab: string, update: SessionUpdate) => void) => on('acp:update', cb),
  onAcpPermission: (cb: (tab: string, key: string, request: RequestPermissionRequest) => void) => on('acp:permission', cb),
  onAcpExit: (cb: (tab: string, detail: string) => void) => on('acp:exit', cb)
}

export type SumiApi = typeof api

contextBridge.exposeInMainWorld('sumi', api)
