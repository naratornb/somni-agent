import { contextBridge, ipcRenderer } from 'electron'

// Shared shapes (duplicated from src/main/store.ts types; keep in sync)
export type Effort = 'low' | 'medium' | 'high'
export type ReportStyle = 'minimal' | 'compact' | 'full'
export type RunnerName = 'claude' | 'antigravity'
export type ViewMode = 'po' | 'engineer'
export type Settings = {
  concurrency: number
  timeoutMinutes: number
  reportStyle: ReportStyle
  runner: RunnerName
  claudeBinary?: string
  antigravityBinary?: string
  whisperBinary?: string
  model?: string
  effort?: Effort
  nightlyTime?: string
  nightlyArmed?: boolean
  viewMode: ViewMode
}
export type Role = {
  slug: string
  name: string
  preamble: string
  runner?: RunnerName
  model?: string
  effort?: Effort
}
export type Task = { title: string; prompt: string; role: string; selected: boolean }
export type Workflow = {
  slug: string
  name: string
  selected: boolean
  tasks: Task[]
  brief?: string
}
export type ItemKind = 'idea' | 'epic' | 'story'
export type ItemStatus =
  'backlog' | 'grooming' | 'ready' | 'in-progress' | 'needs-attention' | 'review' | 'done'
export type Item = {
  id: string
  slug: string
  kind: ItemKind
  status: ItemStatus
  name: string
  spec: string
  created: string
  epic?: string
  blockedBy?: string[]
  tasks: Task[]
}
export type IpcResult = { ok: boolean; error?: string }
// `workflows` is always [] in v2 — see the note in src/main/store.ts.
export type RepoData = {
  roles: Role[]
  items: Item[]
  backlog: string[]
  workflows: Workflow[]
}
export type TaskStatus = 'Queued' | 'Running' | 'Completed' | 'Failed' | 'Skipped' | 'Cancelled'
export type PipelineStatus = 'Running' | 'Paused' | 'Idle'
export type DrainMode = 'manual' | 'nightly' | 'keep' | 'resume'
export type DrainState = { mode: DrainMode | null; status: PipelineStatus; resumeAt?: string }
export type PipelinePush = { status: PipelineStatus; resumeAt?: string; mode?: DrainMode | null }
export type TaskRun = {
  title: string
  role: string
  status: TaskStatus
  attempts?: number
  sessionId?: string
  exitCode?: number | null
  costUsd?: number
  durationMs?: number
  promptTokens?: number
  completionTokens?: number
  error?: string
  runner?: RunnerName
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
  stats?: RunStats
}
export type FileChange = { path: string; kind: 'A' | 'M' | 'D'; lines: number }
export type RunStats = {
  files: FileChange[]
  created: number
  modified: number
  totalCostUsd?: number
  promptTokens?: number
  completionTokens?: number
}

export type RunRow = RunState & { worktreeExists: boolean }
export type RunDetails = { stats: RunStats | null; branchExists: boolean }

export type VoiceStatus = { binary: boolean; model: boolean }
export type Transcription = { ok: boolean; text?: string; error?: string }
export type ModelProgress = { received: number; total: number }

export type ChatMessage = { role: 'user' | 'assistant'; text: string; ts: string }
export type ChatProposal = { name: string; brief: string; tasks: Task[]; roles: Role[] }
export type ChatQuestion = { question: string; options: string[]; recommended: string }
export type ChatEvent =
  | { slug: string; kind: 'text'; text: string }
  | {
      slug: string
      kind: 'done'
      message: ChatMessage
      proposal: ChatProposal | null
      question: ChatQuestion | null
    }
  | { slug: string; kind: 'error'; message: string }

function on(channel: string, cb: (payload: unknown) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Reserved chat key for the one pre-Apply brief-first draft (keep in sync with
// DRAFT_KEY in src/main/chat.ts).
export const DRAFT_KEY = '_draft'
// The fixed Propose Now message (keep in sync with PROPOSE_NOW in chat.ts).
export const PROPOSE_NOW =
  'Stop interviewing and propose the workflow now, from my answers so far plus ' +
  'your own stated assumptions for anything still open.'
// The fixed Refine structure message (keep in sync with REFINE_STRUCTURE in chat.ts).
export const REFINE_STRUCTURE =
  "Reread this workflow's current definition and propose a refined version now: " +
  'tighter task boundaries, better ordering, sharper prompts, the right role for ' +
  'each task. Keep the intent — refine how it gets there.'

const somni = {
  draftKey: DRAFT_KEY,
  proposeNow: PROPOSE_NOW,
  refineStructure: REFINE_STRUCTURE,
  runTask: (prompt: string): Promise<void> => ipcRenderer.invoke('task:run', prompt),
  onTaskEvent: (cb: (ev: unknown) => void): (() => void) => on('task:event', cb),
  startPipeline: (repo: string, ids: string[]): Promise<{ refused: string[] }> =>
    ipcRenderer.invoke('pipeline:start', repo, ids),
  // Add to pipeline: main enforces the Ready gate and returns any refusals for
  // the Board to surface inline.
  addToPipeline: (repo: string, ids: string[]): Promise<{ refused: string[] }> =>
    ipcRenderer.invoke('pipeline:add', repo, ids),
  cancelPipeline: (): Promise<void> => ipcRenderer.invoke('pipeline:cancel'),
  pipelineState: (): Promise<DrainState> => ipcRenderer.invoke('pipeline:state'),
  setKeepRunning: (repo: string, on: boolean): Promise<void> =>
    ipcRenderer.invoke('pipeline:keepRunning', repo, on),
  setBacklog: (repo: string, ids: string[]): Promise<void> =>
    ipcRenderer.invoke('backlog:set', repo, ids),
  // ponytail: v1 Backlog shims. WorkflowsView's parked-work section is dead in
  // v2 (the loader returns no workflows, so no row can reach these); they go
  // with that view when the Board replaces it.
  park: (...args: unknown[]): Promise<void> => Promise.resolve(void args),
  promote: (...args: unknown[]): Promise<void> => Promise.resolve(void args),
  orphanedRuns: (repo: string): Promise<RunState[]> => ipcRenderer.invoke('pipeline:orphan', repo),
  resumePipeline: (repo: string, runIds: string[]): Promise<void> =>
    ipcRenderer.invoke('pipeline:resume', repo, runIds),
  abandonRun: (repo: string, runId: string): Promise<void> =>
    ipcRenderer.invoke('pipeline:abandon', repo, runId),
  onPipelineStatus: (cb: (s: PipelinePush) => void): (() => void) =>
    on('pipeline:status', (p) => cb(p as PipelinePush)),
  onRunState: (cb: (state: RunState) => void): (() => void) =>
    on('run:state', (p) => cb(p as RunState)),
  onRunLog: (cb: (log: { runId: string; taskIndex: number; text: string }) => void): (() => void) =>
    on('run:log', (p) => cb(p as { runId: string; taskIndex: number; text: string })),
  getSettings: (): Promise<Settings> => ipcRenderer.invoke('settings:get'),
  setSettings: (s: Partial<Settings>): Promise<void> => ipcRenderer.invoke('settings:set', s),
  // One-shot Refine (M11). The result is inert — the renderer applies it into
  // its editing buffer only; nothing reaches disk until the editor's Save.
  refineField: (
    repo: string,
    kind: 'task' | 'role',
    text: string
  ): Promise<{ ok: boolean; text?: string; error?: string }> =>
    ipcRenderer.invoke('field:refine', repo, kind, text),
  // `runner` undefined = the role editor's inherit case; main resolves it.
  listModels: (runner?: RunnerName): Promise<string[]> => ipcRenderer.invoke('models:list', runner),
  // Voice input (M12). Capture is renderer-side; everything else is main's.
  voiceStatus: (): Promise<VoiceStatus> => ipcRenderer.invoke('voice:status'),
  downloadModel: (): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('voice:downloadModel'),
  transcribe: (samples: Float32Array): Promise<Transcription> =>
    ipcRenderer.invoke('voice:transcribe', samples),
  onVoiceProgress: (cb: (p: ModelProgress) => void): (() => void) =>
    on('voice:modelProgress', (p) => cb(p as ModelProgress)),
  listRuns: (repo: string): Promise<RunRow[]> => ipcRenderer.invoke('runs:list', repo),
  runReport: (repo: string, runId: string): Promise<string | null> =>
    ipcRenderer.invoke('runs:report', repo, runId),
  runDetails: (repo: string, runId: string): Promise<RunDetails> =>
    ipcRenderer.invoke('runs:details', repo, runId),
  switchBranch: (repo: string, branch: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('runs:switchBranch', repo, branch),
  revealWorktree: (path: string): Promise<void> => ipcRenderer.invoke('runs:revealWorktree', path),
  cleanupRun: (repo: string, runId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('runs:cleanup', repo, runId),
  lastRepo: (): Promise<string | null> => ipcRenderer.invoke('repo:last'),
  chooseRepo: (): Promise<string | null> => ipcRenderer.invoke('repo:choose'),
  loadRepo: (repo: string): Promise<RepoData> => ipcRenderer.invoke('repo:load', repo),
  saveRole: (repo: string, role: Role): Promise<Role> =>
    ipcRenderer.invoke('role:save', repo, role),
  deleteRole: (repo: string, slug: string): Promise<void> =>
    ipcRenderer.invoke('role:delete', repo, slug),
  saveItem: (repo: string, item: Partial<Item> & { name: string }): Promise<Item> =>
    ipcRenderer.invoke('item:save', repo, item),
  deleteItem: (repo: string, id: string): Promise<void> =>
    ipcRenderer.invoke('item:delete', repo, id),
  // Refused (with a reason) unless the Ready gate passes — main is the authority.
  setItemStatus: (repo: string, id: string, status: ItemStatus): Promise<IpcResult> =>
    ipcRenderer.invoke('item:setStatus', repo, id, status),
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
  // Apply — the only write out of a chat. `slug` is DRAFT_KEY for the Draft
  // view (creates a ticked workflow, renames the transcript) or an existing
  // workflow slug from the editor (tick preserved).
  applyProposal: (
    repo: string,
    slug: string,
    proposal: ChatProposal
  ): Promise<{ ok: true; workflow: Workflow } | { ok: false; error: string }> =>
    ipcRenderer.invoke('proposal:apply', repo, slug, proposal),
  onChatEvent: (cb: (ev: ChatEvent) => void): (() => void) =>
    on('chat:event', (p) => cb(p as ChatEvent))
}

export type SomniApi = typeof somni

contextBridge.exposeInMainWorld('somni', somni)
