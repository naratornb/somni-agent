// Orchestrator (architecture.md §3): runs one workflow per worktree, tasks
// sequential within it; the pipeline schedules selected workflows FIFO with
// bounded concurrency. Every state transition is written to
// .somni/runs/<runId>/run.json before it is acted on.

import { execFile } from 'child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { spawnClaude, SpawnHandle } from './runner'
import { atomicWrite, loadRepo, slugify } from './store'

const git = promisify(execFile)

// ponytail: fixed reliability defaults; per-repo config.json overrides land in M5.
const TASK_TIMEOUT_MS = 30 * 60_000
const KILL_GRACE_MS = 5_000 // SIGTERM → SIGKILL grace
const BACKOFF_START_MS = 60_000
const BACKOFF_MAX_MS = 30 * 60_000
const MAX_ATTEMPTS = 2 // one automatic retry; rate limits don't count (§3)
const RATE_LIMIT = /rate.?limit|usage limit|overloaded|429/i

// ponytail: concurrent `git worktree add` on one repo can race on .git locks —
// serialize the mutating git calls; the task processes themselves run in parallel.
let gitLock: Promise<unknown> = Promise.resolve()
function lockedGit(args: string[]): Promise<unknown> {
  const p = gitLock.then(() => git('git', args))
  gitLock = p.catch(() => {})
  return p
}

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
  onPipeline?: (status: PipelineStatus, info?: { resumeAt?: string }) => void
}

type Ctrl = { cancelled: boolean; handle: SpawnHandle | null }

// Pipeline-wide pause gate. Rate limits are account-wide, so one workflow
// hitting one holds back every workflow's next attempt.
type Gate = {
  wait: () => Promise<void> // resolves immediately unless paused
  pause: () => Promise<void> // enter/join the pause window
  ok: () => void // a task succeeded → reset the backoff
  abort: () => void // cancel: stop waiting now
}

export type RunOpts = {
  now?: () => Date
  timeoutMs?: number
  graceMs?: number
  backoffMs?: number
  maxBackoffMs?: number
  ctrl?: Ctrl // internal: set by the pipeline
  gate?: Gate // internal: set by the pipeline
}

function makeGate(events: RunEvents, opts: RunOpts): Gate {
  const base = opts.backoffMs ?? BACKOFF_START_MS
  const max = opts.maxBackoffMs ?? BACKOFF_MAX_MS
  let delay = base
  let current: Promise<void> | null = null
  let finish: (() => void) | null = null
  let timer: NodeJS.Timeout | null = null
  const end = (): void => {
    if (timer) clearTimeout(timer)
    timer = null
    current = null
    const f = finish
    finish = null
    f?.()
  }
  return {
    wait: () => current ?? Promise.resolve(),
    pause: () => {
      if (!current) {
        const wait = delay
        delay = Math.min(delay * 2, max)
        events.onPipeline?.('Paused', { resumeAt: new Date(Date.now() + wait).toISOString() })
        current = new Promise<void>((resolve) => {
          finish = resolve
          timer = setTimeout(() => {
            events.onPipeline?.('Running')
            end()
          }, wait)
        })
      }
      return current
    },
    // A success *during* a pause is just an in-flight task draining — it says
    // nothing about the limit having cleared, so it must not reset the backoff.
    ok: () => {
      if (!current) delay = base
    },
    abort: () => end()
  }
}

let pipeline: { cancelled: boolean; ctrls: Set<Ctrl>; gate: Gate } | null = null

export function isRunning(): boolean {
  return pipeline !== null
}

export function cancelPipeline(): void {
  if (!pipeline) return
  pipeline.cancelled = true
  pipeline.gate.abort()
  for (const c of pipeline.ctrls) {
    c.cancelled = true
    c.handle?.kill()
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const taskTitle = (t: { title?: string }, i: number): string => t.title || `task ${i + 1}`
const human = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`

// Sequential within a workflow, parallel across workflows, bounded by
// maxConcurrency (each workflow has at most one running task, so bounding
// concurrent workflows bounds concurrent tasks).
async function runJobs(
  jobs: { id: string; run: (ctrl: Ctrl, gate: Gate) => Promise<RunState> }[],
  maxConcurrency: number,
  events: RunEvents,
  opts: RunOpts
): Promise<RunState[]> {
  if (pipeline) throw new Error('a pipeline is already running')
  const gate = opts.gate ?? makeGate(events, opts)
  pipeline = { cancelled: false, ctrls: new Set(), gate }
  const mine = pipeline
  events.onPipeline?.('Running')
  try {
    const queue = [...jobs]
    const results: RunState[] = []
    const workers = Math.max(1, Math.min(maxConcurrency, queue.length))
    await Promise.all(
      Array.from({ length: workers }, async () => {
        while (queue.length > 0 && !mine.cancelled) {
          const job = queue.shift()!
          const ctrl: Ctrl = { cancelled: false, handle: null }
          mine.ctrls.add(ctrl)
          try {
            results.push(await job.run(ctrl, gate))
          } catch (err) {
            events.onLog(job.id, -1, `[error] ${message(err)}`)
          } finally {
            mine.ctrls.delete(ctrl)
          }
        }
      })
    )
    return results
  } finally {
    pipeline = null
    events.onPipeline?.('Idle')
  }
}

export function runPipeline(
  repo: string,
  slugs: string[],
  worktreeBase: string,
  maxConcurrency: number,
  events: RunEvents,
  opts: RunOpts = {}
): Promise<RunState[]> {
  const jobs = slugs.map((slug) => ({
    id: slug,
    run: (ctrl: Ctrl, gate: Gate) =>
      runWorkflow(repo, slug, worktreeBase, events, { ...opts, ctrl, gate })
  }))
  return runJobs(jobs, maxConcurrency, events, opts)
}

// Crash/quit recovery (§3): a run.json still marked Running on disk belongs to a
// dead process. Callers should only ask when no pipeline is running in-process.
export function findOrphanedRuns(repo: string): RunState[] {
  const dir = join(repo, '.somni', 'runs')
  if (!existsSync(dir)) return []
  return readdirSync(dir).flatMap((runId) => {
    try {
      const state = JSON.parse(readFileSync(join(dir, runId, 'run.json'), 'utf8')) as RunState
      return state.status === 'Running' ? [state] : []
    } catch {
      return []
    }
  })
}

export function abandonRun(repo: string, runId: string): void {
  const path = join(repo, '.somni', 'runs', runId, 'run.json')
  const state = JSON.parse(readFileSync(path, 'utf8')) as RunState
  for (const t of state.tasks)
    if (t.status === 'Running' || t.status === 'Queued') t.status = 'Cancelled'
  state.status = 'Cancelled'
  state.finishedAt = new Date().toISOString()
  atomicWrite(path, JSON.stringify(state, null, 2) + '\n')
}

// Re-runs the not-yet-completed tasks of orphaned runs in their existing worktrees.
export function resumePipeline(
  repo: string,
  runIds: string[],
  maxConcurrency: number,
  events: RunEvents,
  opts: RunOpts = {}
): Promise<RunState[]> {
  const jobs = runIds.map((runId) => ({
    id: runId,
    run: (ctrl: Ctrl, gate: Gate) => {
      const path = join(repo, '.somni', 'runs', runId, 'run.json')
      const state = JSON.parse(readFileSync(path, 'utf8')) as RunState
      return execute(repo, state, events, { ...opts, ctrl, gate })
    }
  }))
  return runJobs(jobs, maxConcurrency, events, opts)
}

export function runWorkflow(
  repo: string,
  wfSlug: string,
  worktreeBase: string,
  events: RunEvents,
  opts: RunOpts = {}
): Promise<RunState> {
  const now = opts.now ?? ((): Date => new Date())
  const wf = loadRepo(repo).workflows.find((w) => w.slug === wfSlug)
  if (!wf) throw new Error(`workflow not found: ${wfSlug}`)
  const defs = wf.tasks.filter((t) => t.selected !== false)
  if (defs.length === 0) throw new Error(`no tasks selected in ${wf.name}`)

  const stamp = now().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const runId = `${stamp}-${wf.slug}` // slug keeps concurrent same-second runs unique
  mkdirSync(join(repo, '.somni', 'runs', runId, 'logs'), { recursive: true })

  return execute(
    repo,
    {
      runId,
      workflow: wf.slug,
      name: wf.name,
      branch: `somni/${wf.slug}-${stamp}`,
      worktree: join(worktreeBase, runId),
      status: 'Running',
      startedAt: now().toISOString(),
      tasks: defs.map((t, i) => ({
        title: taskTitle(t, i),
        role: t.role,
        status: 'Queued',
        log: `logs/${i + 1}-${slugify(t.title || 'task')}.jsonl`
      }))
    },
    events,
    opts
  )
}

// Fresh runs and resumed runs share this: it only ever runs the tasks that
// aren't Completed yet, in whatever worktree the state names.
async function execute(
  repo: string,
  state: RunState,
  events: RunEvents,
  opts: RunOpts
): Promise<RunState> {
  const now = opts.now ?? ((): Date => new Date())
  const ctrl = opts.ctrl ?? { cancelled: false, handle: null }
  const gate = opts.gate ?? makeGate(events, opts)
  const timeoutMs = opts.timeoutMs ?? TASK_TIMEOUT_MS
  const graceMs = opts.graceMs ?? KILL_GRACE_MS
  const runDir = join(repo, '.somni', 'runs', state.runId)
  const writeState = (): void => {
    atomicWrite(join(runDir, 'run.json'), JSON.stringify(state, null, 2) + '\n')
    events.onState(state)
  }

  const { roles, workflows } = loadRepo(repo)
  const defs = (workflows.find((w) => w.slug === state.workflow)?.tasks ?? []).filter(
    (t) => t.selected !== false
  )

  // A dead process left these Running; they get re-attempted from scratch.
  for (const t of state.tasks) if (t.status === 'Running') t.status = 'Queued'
  state.status = 'Running'
  state.finishedAt = undefined
  writeState()

  try {
    // ponytail: tasks are matched to definitions by position, so titles must
    // still line up — a same-count reorder would otherwise run the wrong prompt
    // under the old title. Renaming a task mid-orphan invalidates the run too;
    // that's the safe direction, and cheaper than putting ids in the schema.
    if (
      defs.length !== state.tasks.length ||
      defs.some((d, i) => taskTitle(d, i) !== state.tasks[i].title)
    )
      throw new Error('workflow changed since it started')
    await ensureWorktree(repo, state.worktree, state.branch)

    for (let i = 0; i < state.tasks.length; i++) {
      const task = state.tasks[i]
      if (task.status === 'Completed') continue
      if (ctrl.cancelled) {
        task.status = 'Skipped'
        continue
      }
      const def = defs[i]
      const preamble = roles.find((r) => r.slug === def.role)?.preamble
      const prompt = preamble ? `${preamble}\n\n---\n\n${def.prompt}` : def.prompt
      const logPath = join(runDir, task.log)
      task.status = 'Running'
      task.attempts ??= 0
      writeState()

      let failures = 0
      for (;;) {
        await gate.wait() // pipeline paused (rate limit) → hold here
        if (ctrl.cancelled) {
          task.status = 'Cancelled'
          break
        }
        task.attempts = (task.attempts ?? 0) + 1
        writeState() // the attempt is on disk before it is made

        const started = now().getTime()
        let detail: string | undefined
        let stderr: string | undefined
        let resultMs: number | undefined
        let timedOut = false
        const handle = spawnClaude(
          [
            '-p',
            prompt,
            '--output-format',
            'stream-json',
            '--verbose',
            '--dangerously-skip-permissions'
          ],
          state.worktree,
          (ev) => {
            if (ev.kind === 'session') task.sessionId = ev.sessionId
            if (ev.kind === 'text') events.onLog(state.runId, i, ev.text)
            if (ev.kind === 'spawn-error') {
              stderr = ev.message.split('\n').filter(Boolean).pop()
              events.onLog(state.runId, i, `[stderr] ${ev.message}`)
            }
            if (ev.kind === 'result') {
              task.costUsd = ev.costUsd
              resultMs = ev.durationMs
              detail = ev.detail
            }
          },
          (chunk) => appendFileSync(logPath, chunk)
        )
        ctrl.handle = handle
        let grace: NodeJS.Timeout | null = null
        const killer = setTimeout(() => {
          timedOut = true
          handle.kill()
          grace = setTimeout(() => handle.kill('SIGKILL'), graceMs)
        }, timeoutMs)
        const exit = await handle.done
        clearTimeout(killer)
        if (grace) clearTimeout(grace)
        ctrl.handle = null
        const ok = exit.ok && !timedOut

        task.exitCode = exit.code
        task.durationMs = resultMs ?? now().getTime() - started
        // Persist *why* it failed even when the CLI never produced a result event
        // (bad PATH, crash, timeout) — otherwise the morning shows "Failed", no reason.
        task.error =
          ok || ctrl.cancelled
            ? undefined
            : timedOut
              ? `timed out after ${human(timeoutMs)}`
              : (detail ?? stderr ?? `exited with code ${exit.code}`)

        if (ctrl.cancelled) {
          task.status = 'Cancelled'
          break
        }
        if (ok) {
          gate.ok()
          task.status = 'Completed'
          break
        }
        if (!timedOut && RATE_LIMIT.test(`${detail ?? ''} ${stderr ?? ''}`)) {
          // Rate limits pause the whole pipeline instead of burning the retry (§3).
          // ponytail: re-attempts are unbounded by design — the point is to outlast
          // a 5-hour usage window; cancel is the way out.
          events.onLog(state.runId, i, `[somni] rate limited — pausing`)
          writeState()
          await gate.pause()
          continue
        }
        if (++failures < MAX_ATTEMPTS) {
          events.onLog(state.runId, i, `[somni] ${task.error} — retrying once`)
          continue
        }
        task.status = 'Failed'
        break
      }
      writeState()

      if (task.status !== 'Completed') {
        for (const rest of state.tasks.slice(i + 1)) {
          if (rest.status !== 'Completed') rest.status = 'Skipped'
        }
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
    events.onLog(state.runId, -1, `[error] ${message(err)}`)
  } finally {
    state.finishedAt = now().toISOString()
    writeState()
  }
  return state
}

// Fresh run: create worktree + branch. Resume: reuse whatever the dead run left
// behind (task prompts are goals, not diffs, so re-running over it is fine).
async function ensureWorktree(repo: string, worktree: string, branch: string): Promise<void> {
  if (existsSync(worktree)) return
  const branchExists = await lockedGit([
    '-C',
    repo,
    'show-ref',
    '--verify',
    '--quiet',
    `refs/heads/${branch}`
  ]).then(
    () => true,
    () => false
  )
  const args = branchExists ? [worktree, branch] : [worktree, '-b', branch]
  await lockedGit(['-C', repo, 'worktree', 'add', ...args])
}
