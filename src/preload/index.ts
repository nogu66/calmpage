import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import type { BuildResult, SyncBox } from '../main/build'
import type { Palette, Settings } from '../main/settings'

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

  onFolderOpened: (cb: (folder: string, file: string | null) => void) => on('folder:opened', cb),
  onFileChanged: (cb: (path: string, content: string) => void) => on('file:changed', cb),
  onBuildStarted: (cb: (root: string) => void) => on('build:started', cb),
  onBuildFinished: (cb: (result: BuildResult | null, file: string, error?: string) => void) => on('build:finished', cb),
  onMenu: (cb: (command: string) => void) => on('menu', cb),
  onPalette: (cb: (palette: Palette) => void) => on('palette', cb)
}

export type SumiApi = typeof api

contextBridge.exposeInMainWorld('sumi', api)
