// Runs one workflow: worktree + branch, tasks sequentially, every state
// transition written to .somni/runs/<runId>/run.json before it is acted on.

import { execFile } from 'child_process'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { spawnClaude, SpawnHandle } from './runner'
import { atomicWrite, loadRepo, slugify } from './store'

const git = promisify(execFile)

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

export type RunEvents = {
  onState: (state: RunState) => void
  onLog: (taskIndex: number, text: string) => void
}

let current: { handle: SpawnHandle | null; cancelled: boolean } | null = null

export function cancelRun(): void {
  if (current) {
    current.cancelled = true
    current.handle?.kill()
  }
}

export function isRunning(): boolean {
  return current !== null
}

export async function runWorkflow(
  repo: string,
  wfSlug: string,
  worktreeBase: string,
  events: RunEvents,
  now: () => Date = () => new Date()
): Promise<RunState> {
  if (current) throw new Error('a run is already in progress')
  const { roles, workflows } = loadRepo(repo)
  const wf = workflows.find((w) => w.slug === wfSlug)
  if (!wf) throw new Error(`workflow not found: ${wfSlug}`)

  const runId = now().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const branch = `somni/${wf.slug}-${runId}`
  const worktree = join(worktreeBase, `${runId}-${wf.slug}`)
  const runDir = join(repo, '.somni', 'runs', runId)
  const logsDir = join(runDir, 'logs')
  mkdirSync(logsDir, { recursive: true })

  const state: RunState = {
    runId,
    workflow: wf.slug,
    name: wf.name,
    branch,
    worktree,
    status: 'Running',
    startedAt: now().toISOString(),
    tasks: wf.tasks.map((t, i) => ({
      title: t.title || `task ${i + 1}`,
      role: t.role,
      status: 'Queued',
      log: `logs/${i + 1}-${slugify(t.title || 'task')}.jsonl`
    }))
  }
  const writeState = (): void => {
    atomicWrite(join(runDir, 'run.json'), JSON.stringify(state, null, 2) + '\n')
    events.onState(state)
  }

  current = { handle: null, cancelled: false }
  writeState()
  try {
    await git('git', ['-C', repo, 'worktree', 'add', worktree, '-b', branch])

    for (let i = 0; i < state.tasks.length; i++) {
      const task = state.tasks[i]
      const def = wf.tasks[i]
      if (current.cancelled) {
        task.status = 'Skipped'
        continue
      }
      task.status = 'Running'
      writeState()

      const preamble = roles.find((r) => r.slug === def.role)?.preamble
      const prompt = preamble ? `${preamble}\n\n---\n\n${def.prompt}` : def.prompt
      const logPath = join(runDir, task.log)
      const started = now().getTime()

      const handle = spawnClaude(
        [
          '-p',
          prompt,
          '--output-format',
          'stream-json',
          '--verbose',
          '--dangerously-skip-permissions'
        ],
        worktree,
        (ev) => {
          if (ev.kind === 'session') task.sessionId = ev.sessionId
          if (ev.kind === 'text') events.onLog(i, ev.text)
          if (ev.kind === 'spawn-error') events.onLog(i, `[stderr] ${ev.message}`)
          if (ev.kind === 'result') {
            task.costUsd = ev.costUsd
            task.durationMs = ev.durationMs
            if (!ev.ok && ev.detail) task.error = ev.detail
          }
        },
        (chunk) => appendFileSync(logPath, chunk)
      )
      current.handle = handle
      const { code, ok } = await handle.done
      current.handle = null
      task.exitCode = code
      task.durationMs ??= now().getTime() - started
      task.status = current.cancelled ? 'Cancelled' : ok ? 'Completed' : 'Failed'
      writeState()

      if (task.status !== 'Completed') {
        for (const rest of state.tasks.slice(i + 1)) rest.status = 'Skipped'
        break
      }
    }

    const failed = state.tasks.some((t) => t.status === 'Failed')
    const cancelled = state.tasks.some((t) => t.status === 'Cancelled')
    state.status = cancelled ? 'Cancelled' : failed ? 'Failed' : 'Completed'
  } catch (err) {
    state.status = 'Failed'
    for (const t of state.tasks)
      if (t.status === 'Queued' || t.status === 'Running') t.status = 'Skipped'
    events.onLog(-1, `[error] ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    state.finishedAt = now().toISOString()
    writeState()
    current = null
  }
  return state
}
