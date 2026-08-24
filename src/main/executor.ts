// Orchestrator (architecture.md §3): runs one workflow per worktree, tasks
// sequential within it; the pipeline schedules selected workflows FIFO with
// bounded concurrency. Every state transition is written to
// .somni/runs/<runId>/run.json before it is acted on.

import { execFile } from 'child_process'
import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { spawnClaude, SpawnHandle } from './runner'
import { atomicWrite, loadRepo, slugify } from './store'

const git = promisify(execFile)

// ponytail: concurrent `git worktree add` on one repo can race on .git locks —
// serialize the mutating git calls; the task processes themselves run in parallel.
let gitLock: Promise<unknown> = Promise.resolve()
function lockedGit(args: string[]): Promise<unknown> {
  const p = gitLock.then(() => git('git', args))
  gitLock = p.catch(() => {})
  return p
}

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
  onLog: (runId: string, taskIndex: number, text: string) => void
}

type Ctrl = { cancelled: boolean; handle: SpawnHandle | null }

let pipeline: { cancelled: boolean; ctrls: Set<Ctrl> } | null = null

export function isRunning(): boolean {
  return pipeline !== null
}

export function cancelPipeline(): void {
  if (!pipeline) return
  pipeline.cancelled = true
  for (const c of pipeline.ctrls) {
    c.cancelled = true
    c.handle?.kill()
  }
}

// Sequential within a workflow, parallel across workflows, bounded by
// maxConcurrency (each workflow has at most one running task, so bounding
// concurrent workflows bounds concurrent tasks).
export async function runPipeline(
  repo: string,
  slugs: string[],
  worktreeBase: string,
  maxConcurrency: number,
  events: RunEvents,
  now: () => Date = () => new Date()
): Promise<RunState[]> {
  if (pipeline) throw new Error('a pipeline is already running')
  pipeline = { cancelled: false, ctrls: new Set() }
  const mine = pipeline
  try {
    const queue = [...slugs]
    const results: RunState[] = []
    const workers = Math.max(1, Math.min(maxConcurrency, queue.length))
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (queue.length > 0 && !mine.cancelled) {
          const slug = queue.shift()!
          const ctrl: Ctrl = { cancelled: false, handle: null }
          mine.ctrls.add(ctrl)
          try {
            results.push(await runWorkflow(repo, slug, worktreeBase, events, now, ctrl))
          } catch (err) {
            events.onLog(slug, -1, `[error] ${err instanceof Error ? err.message : String(err)}`)
          } finally {
            mine.ctrls.delete(ctrl)
          }
        }
      })
    )
    return results
  } finally {
    pipeline = null
  }
}

export async function runWorkflow(
  repo: string,
  wfSlug: string,
  worktreeBase: string,
  events: RunEvents,
  now: () => Date = () => new Date(),
  ctrl: Ctrl = { cancelled: false, handle: null }
): Promise<RunState> {
  const { roles, workflows } = loadRepo(repo)
  const wf = workflows.find((w) => w.slug === wfSlug)
  if (!wf) throw new Error(`workflow not found: ${wfSlug}`)
  const defs = wf.tasks.filter((t) => t.selected !== false)
  if (defs.length === 0) throw new Error(`no tasks selected in ${wf.name}`)

  const stamp = now().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const runId = `${stamp}-${wf.slug}` // slug keeps concurrent same-second runs unique
  const branch = `somni/${wf.slug}-${stamp}`
  const worktree = join(worktreeBase, runId)
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
    tasks: defs.map((t, i) => ({
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

  writeState()
  try {
    await lockedGit(['-C', repo, 'worktree', 'add', worktree, '-b', branch])

    for (let i = 0; i < state.tasks.length; i++) {
      const task = state.tasks[i]
      const def = defs[i]
      if (ctrl.cancelled) {
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
          if (ev.kind === 'text') events.onLog(runId, i, ev.text)
          if (ev.kind === 'spawn-error') events.onLog(runId, i, `[stderr] ${ev.message}`)
          if (ev.kind === 'result') {
            task.costUsd = ev.costUsd
            task.durationMs = ev.durationMs
            if (!ev.ok && ev.detail) task.error = ev.detail
          }
        },
        (chunk) => appendFileSync(logPath, chunk)
      )
      ctrl.handle = handle
      const { code, ok } = await handle.done
      ctrl.handle = null
      task.exitCode = code
      task.durationMs ??= now().getTime() - started
      task.status = ctrl.cancelled ? 'Cancelled' : ok ? 'Completed' : 'Failed'
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
    events.onLog(runId, -1, `[error] ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    state.finishedAt = now().toISOString()
    writeState()
  }
  return state
}
