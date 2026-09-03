import { contextBridge, ipcRenderer } from 'electron'
// Shared shapes are single-sourced from the main modules (M20). Type-only
// imports/re-exports are erased at build time, so none of main's runtime
// (fs, electron main APIs) ever crosses into the preload bundle.
import type { ChatEvent, ChatMessage, ChatProposal } from '../main/chat'
import type { DrainMode, DrainState, PipelineStatus, RunState } from '../main/executor'
import type { IpcResult, RunDetails, RunRow } from '../main/repoIpc'
import type { SkillsStatus } from '../main/skills'
import type {
  Item,
  ItemStatus,
  RepoData,
  ResolvedSettings,
  Role,
  RunnerName,
  Settings
} from '../main/store'
import type { RunnerHealth } from '../main/runners'
import type { ModelProgress, Transcription, VoiceStatus } from '../main/voice'

export type { ChatEvent, ChatMessage, ChatProposal, ChatQuestion, GroomedStory } from '../main/chat'
export type {
  DrainMode,
  DrainState,
  PipelineStatus,
  ReviewCycle,
  RunState,
  TaskRun,
  TaskStatus
} from '../main/executor'
export type { FileChange, RunStats } from '../main/report'
export type { IpcResult, RunDetails, RunRow } from '../main/repoIpc'
export type { SkillsStatus } from '../main/skills'
export type {
  Effort,
  Item,
  ItemKind,
  ItemStatus,
  Methodology,
  RepoData,
  ReportStyle,
  ResolvedSettings,
  Role,
  RunnerName,
  Settings,
  Task
} from '../main/store'
export type { ModelProgress, Transcription, VoiceStatus } from '../main/voice'

export type PipelinePush = { status: PipelineStatus; resumeAt?: string; mode?: DrainMode | null }

function on(channel: string, cb: (payload: unknown) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: unknown): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

// Reserved chat key for the one pre-Apply from-scratch groom (keep in sync with
// DRAFT_KEY in src/main/chat.ts).
export const DRAFT_KEY = '_draft'
// The fixed Propose Now message (keep in sync with PROPOSE_NOW in chat.ts).
export const PROPOSE_NOW =
  'Stop interviewing and propose the groomed result now, from my answers so far ' +
  'plus your own stated assumptions for anything still open.'

const somni = {
  draftKey: DRAFT_KEY,
  proposeNow: PROPOSE_NOW,
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
  // settings:get spreads SETTINGS_DEFAULTS, so every defaulted field is present.
  getSettings: (): Promise<ResolvedSettings> => ipcRenderer.invoke('settings:get'),
  // Repo-level .somni/config.json (M16: checkCommand). Never global.
  getRepoConfig: (repo: string): Promise<Partial<Settings>> =>
    ipcRenderer.invoke('config:get', repo),
  setRepoConfig: (repo: string, patch: Partial<Settings>): Promise<void> =>
    ipcRenderer.invoke('config:set', repo, patch),
  // Vendored skills (M16): status of <repo>/.claude/skills/ vs the bundle.
  skillsStatus: (repo: string): Promise<SkillsStatus> => ipcRenderer.invoke('skills:status', repo),
  injectSkills: (repo: string): Promise<SkillsStatus> => ipcRenderer.invoke('skills:inject', repo),
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
  // Home quick-start chips (M23): [] means "use the static fallback".
  suggestions: (repo: string): Promise<string[]> => ipcRenderer.invoke('repo:suggestions', repo),
  // Health of the configured Runner CLI (M22) — probed fresh on each ask.
  runnerStatus: (): Promise<RunnerHealth> => ipcRenderer.invoke('runner:status'),
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
  loadChat: (repo: string, slug: string): Promise<{ messages: ChatMessage[]; busy: boolean }> =>
    ipcRenderer.invoke('chat:load', repo, slug),
  newChat: (repo: string, slug: string): Promise<void> =>
    ipcRenderer.invoke('chat:new', repo, slug),
  sendChat: (repo: string, slug: string, text: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('chat:send', repo, slug, text),
  // Apply — the only write out of a groom. `key` is DRAFT_KEY (creates the
  // item(s), renames the transcript) or the groomed item's id (converted in
  // place, keeping its id).
  applyProposal: (
    repo: string,
    key: string,
    proposal: ChatProposal
  ): Promise<{ ok: true; item: Item } | { ok: false; error: string }> =>
    ipcRenderer.invoke('proposal:apply', repo, key, proposal),
  onChatEvent: (cb: (ev: ChatEvent) => void): (() => void) =>
    on('chat:event', (p) => cb(p as ChatEvent))
}

export type SomniApi = typeof somni

contextBridge.exposeInMainWorld('somni', somni)
