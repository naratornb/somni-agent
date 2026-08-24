import { contextBridge, ipcRenderer } from 'electron'

// Shared shapes (duplicated from src/main/store.ts types; keep in sync)
export type Role = { slug: string; name: string; preamble: string }
export type Task = { title: string; prompt: string; role: string; selected: boolean }
export type Workflow = { slug: string; name: string; selected: boolean; tasks: Task[] }
export type RepoData = { roles: Role[]; workflows: Workflow[] }

const somni = {
  runTask: (prompt: string): Promise<void> => ipcRenderer.invoke('task:run', prompt),
  onTaskEvent: (cb: (ev: unknown) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, ev: unknown): void => cb(ev)
    ipcRenderer.on('task:event', listener)
    return () => ipcRenderer.removeListener('task:event', listener)
  },
  lastRepo: (): Promise<string | null> => ipcRenderer.invoke('repo:last'),
  chooseRepo: (): Promise<string | null> => ipcRenderer.invoke('repo:choose'),
  loadRepo: (repo: string): Promise<RepoData> => ipcRenderer.invoke('repo:load', repo),
  saveRole: (repo: string, role: Role): Promise<Role> =>
    ipcRenderer.invoke('role:save', repo, role),
  deleteRole: (repo: string, slug: string): Promise<void> =>
    ipcRenderer.invoke('role:delete', repo, slug),
  saveWorkflow: (repo: string, wf: Workflow): Promise<Workflow> =>
    ipcRenderer.invoke('workflow:save', repo, wf),
  deleteWorkflow: (repo: string, slug: string): Promise<void> =>
    ipcRenderer.invoke('workflow:delete', repo, slug)
}

export type SomniApi = typeof somni

contextBridge.exposeInMainWorld('somni', somni)
