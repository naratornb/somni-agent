import { contextBridge, ipcRenderer } from 'electron'

// Shared shapes (duplicated from src/main/store.ts types; keep in sync)
export type Role = { slug: string; name: string; preamble: string }
export type Task = { title: string; prompt: string; role: string; selected: boolean }
export type Workflow = { slug: string; name: string; selected: boolean; tasks: Task[] }
export type RepoData = { roles: Role[]; workflows: Workflow[] }
export type TaskStatus = 'Queued' | 'Running' | 'Completed' | 'Failed' | 'Skipped' | 'Cancelled'
export type TaskRun = {
  title: string
  role: string
  status: TaskStatus
  sessionId?: string
  exitCode?: number | null
  costUsd?: number
  durationMs?: number
  error?: string
  log: string
}
export type RunState = {
  runId: string
  workflow: string
  name: string
  branch: string
  worktree: string
  status: TaskStatus
  startedAt: string
  finishedAt?: string
  tasks: TaskRun[]
}

function on(channel: string, cb: (payload: unknown) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const somni = {
  runTask: (prompt: string): Promise<void> => ipcRenderer.invoke('task:run', prompt),
  onTaskEvent: (cb: (ev: unknown) => void): (() => void) => on('task:event', cb),
  startPipeline: (repo: string, slugs: string[]): Promise<void> =>
    ipcRenderer.invoke('pipeline:start', repo, slugs),
  cancelPipeline: (): Promise<void> => ipcRenderer.invoke('pipeline:cancel'),
  onRunState: (cb: (state: RunState) => void): (() => void) =>
    on('run:state', (p) => cb(p as RunState)),
  onRunLog: (cb: (log: { runId: string; taskIndex: number; text: string }) => void): (() => void) =>
    on('run:log', (p) => cb(p as { runId: string; taskIndex: number; text: string })),
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
