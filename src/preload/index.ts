import { contextBridge, ipcRenderer } from 'electron'

const somni = {
  runTask: (prompt: string): Promise<void> => ipcRenderer.invoke('task:run', prompt),
  onTaskEvent: (cb: (ev: unknown) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: unknown): void => cb(ev)
    ipcRenderer.on('task:event', listener)
    return () => ipcRenderer.removeListener('task:event', listener)
  }
}

export type SomniApi = typeof somni

contextBridge.exposeInMainWorld('somni', somni)
