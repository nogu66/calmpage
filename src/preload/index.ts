import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BuildResult, SyncBox } from '../main/build'
import type { ContentBlock, RequestPermissionRequest, SessionUpdate } from '@agentclientprotocol/sdk'
import type { StartResult } from '../main/acp'
import type { Settings } from '../main/settings'
import type { RegistryAgent } from '../shared/agents'

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
  cancelBuild: (): void => ipcRenderer.send('build:cancel'),
  cleanBuild: (file: string): Promise<boolean | null> => ipcRenderer.invoke('build:clean', file),
  readPdf: (path: string): Promise<Uint8Array> => ipcRenderer.invoke('pdf:read', path),
  openPdfExternally: (): Promise<void> => ipcRenderer.invoke('pdf:open-external'),
  forwardSync: (file: string, line: number, column: number): Promise<SyncBox | null> =>
    ipcRenderer.invoke('sync:forward', file, line, column),
  backwardSync: (page: number, x: number, y: number): Promise<{ file: string; line: number } | null> =>
    ipcRenderer.invoke('sync:backward', page, x, y),
  saveSettings: (patch: Partial<Settings>): void => ipcRenderer.send('settings:save', patch),
  updateSettings: (patch: Partial<Settings>): void => ipcRenderer.send('settings:update', patch),
  termStart: (id: string, cols: number, rows: number): Promise<string | null> => ipcRenderer.invoke('term:start', id, cols, rows),
  termInput: (id: string, data: string): void => ipcRenderer.send('term:input', id, data),
  termResize: (id: string, cols: number, rows: number): void => ipcRenderer.send('term:resize', id, cols, rows),
  acpStart: (id: string): Promise<StartResult> => ipcRenderer.invoke('acp:start', id),
  acpNewSession: (id: string): Promise<StartResult> => ipcRenderer.invoke('acp:new-session', id),
  acpAuthenticate: (id: string, methodId: string): Promise<StartResult> => ipcRenderer.invoke('acp:authenticate', id, methodId),
  acpPrompt: (id: string, prompt: ContentBlock[]): Promise<{ stopReason?: string; error?: string }> =>
    ipcRenderer.invoke('acp:prompt', id, prompt),
  acpCancel: (id: string): void => ipcRenderer.send('acp:cancel', id),
  acpAnswer: (key: string, optionId: string | null): void => ipcRenderer.send('acp:answer', key, optionId),
  openLink: (url: string): void => ipcRenderer.send('link:open', url),
  listRegistry: (): Promise<{ agents?: RegistryAgent[]; error?: string }> => ipcRenderer.invoke('registry:list'),

  onFolderOpened: (cb: (folder: string, file: string | null) => void) => on('folder:opened', cb),
  onFileChanged: (cb: (path: string, content: string) => void) => on('file:changed', cb),
  onBuildStarted: (cb: (root: string) => void) => on('build:started', cb),
  onBuildFinished: (cb: (result: BuildResult | null, file: string, error?: string) => void) => on('build:finished', cb),
  onBuildCancelled: (cb: () => void) => on('build:cancelled', cb),
  onMenu: (cb: (command: string) => void) => on('menu', cb),
  onSettings: (cb: (settings: Settings) => void) => on('settings:changed', cb),
  onTermData: (cb: (id: string, data: string) => void) => on('term:data', cb),
  onTermExit: (cb: (id: string, code: number) => void) => on('term:exit', cb),
  onAcpUpdate: (cb: (id: string, update: SessionUpdate) => void) => on('acp:update', cb),
  onAcpPermission: (cb: (id: string, key: string, request: RequestPermissionRequest) => void) => on('acp:permission', cb),
  onAcpExit: (cb: (id: string, detail: string) => void) => on('acp:exit', cb)
}

export type SumiApi = typeof api

contextBridge.exposeInMainWorld('sumi', api)
