import { contextBridge, ipcRenderer } from 'electron'

// Shared shapes (duplicated from src/main/store.ts types; keep in sync)
export type Effort = 'low' | 'medium' | 'high'
export type ReportStyle = 'minimal' | 'compact' | 'full'
export type Settings = {
  concurrency: number
  timeoutMinutes: number
  reportStyle: ReportStyle
  model?: string
  effort?: Effort
}
export type Role = {
  slug: string
  name: string
  preamble: string
  model?: string
  effort?: Effort
}
export type Task = { title: string; prompt: string; role: string; selected: boolean }
export type Workflow = { slug: string; name: string; selected: boolean; tasks: Task[] }
export type RepoData = { roles: Role[]; workflows: Workflow[] }
export type TaskStatus = 'Queued' | 'Running' | 'Completed' | 'Failed' | 'Skipped' | 'Cancelled'
export type PipelineStatus = 'Running' | 'Paused' | 'Idle'
export type TaskRun = {
  title: string
  role: string
  status: TaskStatus
  attempts?: number
  sessionId?: string
  exitCode?: number | null
  costUsd?: number
  durationMs?: number
  error?: string
  model?: string
  effort?: string
  log: string
}
export type RunState = {
  runId: string
  workflow: string
  name: string
  branch: string
  worktree: string
  baseSha?: string
  status: TaskStatus
  startedAt: string
  finishedAt?: string
  tasks: TaskRun[]
}

export type RunRow = RunState & { worktreeExists: boolean }

export type ChatMessage = { role: 'user' | 'assistant'; text: string; ts: string }
export type ChatProposal = { name: string; tasks: Task[] }
export type ChatEvent =
  | { slug: string; kind: 'text'; text: string }
  | { slug: string; kind: 'done'; message: ChatMessage; proposal: ChatProposal | null }
  | { slug: string; kind: 'error'; message: string }

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
  orphanedRuns: (repo: string): Promise<RunState[]> => ipcRenderer.invoke('pipeline:orphan', repo),
  resumePipeline: (repo: string, runIds: string[]): Promise<void> =>
    ipcRenderer.invoke('pipeline:resume', repo, runIds),
  abandonRun: (repo: string, runId: string): Promise<void> =>
    ipcRenderer.invoke('pipeline:abandon', repo, runId),
  onPipelineStatus: (
    cb: (s: { status: PipelineStatus; resumeAt?: string }) => void
  ): (() => void) =>
    on('pipeline:status', (p) => cb(p as { status: PipelineStatus; resumeAt?: string })),
  onRunState: (cb: (state: RunState) => void): (() => void) =>
    on('run:state', (p) => cb(p as RunState)),
  onRunLog: (cb: (log: { runId: string; taskIndex: number; text: string }) => void): (() => void) =>
    on('run:log', (p) => cb(p as { runId: string; taskIndex: number; text: string })),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (s: Settings): Promise<void> => ipcRenderer.invoke('settings:set', s),
  listRuns: (repo: string): Promise<RunRow[]> => ipcRenderer.invoke('runs:list', repo),
  runReport: (repo: string, runId: string): Promise<string | null> =>
    ipcRenderer.invoke('runs:report', repo, runId),
  cleanupRun: (repo: string, runId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('runs:cleanup', repo, runId),
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
    ipcRenderer.invoke('workflow:delete', repo, slug),
  loadChat: (repo: string, slug: string): Promise<{ messages: ChatMessage[]; busy: boolean }> =>
    ipcRenderer.invoke('chat:load', repo, slug),
  newChat: (repo: string, slug: string): Promise<void> =>
    ipcRenderer.invoke('chat:new', repo, slug),
  sendChat: (repo: string, slug: string, text: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:send', repo, slug, text),
  onChatEvent: (cb: (ev: ChatEvent) => void): (() => void) =>
    on('chat:event', (p) => cb(p as ChatEvent))
}

export type SomniApi = typeof somni

contextBridge.exposeInMainWorld('somni', somni)
