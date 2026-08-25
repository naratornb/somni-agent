// Orchestrator (architecture.md §3): runs one workflow per worktree, tasks
// sequential within it. The pipeline is a drain (M9): one supervisor loop
// re-scans the Queue for ticked workflows, consuming each tick at pickup, with
// bounded concurrency. Every state transition is written to
// .somni/runs/<runId>/run.json before it is acted on.

import { execFile } from 'child_process'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { writeReport } from './report'
import { spawnRunner, SpawnHandle } from './runner'
import { getRunner } from './runners'
import {
  atomicWrite,
  loadRepo,
  resolveProfile,
  RunnerName,
  setSelected,
  Settings,
  slugify
} from './store'

const git = promisify(execFile)

const TASK_TIMEOUT_MS = 30 * 60_000 // fallback; settings.timeoutMinutes wins
const KILL_GRACE_MS = 5_000 // SIGTERM → SIGKILL grace
const BACKOFF_START_MS = 60_000
const BACKOFF_MAX_MS = 30 * 60_000
const MAX_ATTEMPTS = 2 // one automatic retry; rate limits don't count (§3)

// ponytail: concurrent `git worktree add` on one repo can race on .git locks —
// serialize the mutating git calls; the task processes themselves run in parallel.
let gitLock: Promise<unknown> = Promise.resolve()
export function lockedGit(args: string[]): Promise<unknown> {
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
  baseSha?: string // commit the branch was cut from — reports diff against it
  status: TaskStatus
  startedAt: string
  finishedAt?: string
  tasks: TaskRun[]
}

export type RunEvents = {
  onState: (state: RunState) => void
  onLog: (runId: string, taskIndex: number, text: string) => void
  onPipeline?: (
    status: PipelineStatus,
    info?: { resumeAt?: string; mode?: DrainMode | null }
  ) => void
}

// How a drain was entered (M9 Decision 1). They differ only by stop rule.
export type DrainMode = 'manual' | 'nightly' | 'keep' | 'resume'
export type DrainState = { mode: DrainMode | null; status: PipelineStatus; resumeAt?: string }

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
  settings?: Settings // resolved repo+global settings (profile, report style)
  pollMs?: number // drain idle poll interval (default 2000)
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

type Pipeline = {
  cancelled: boolean
  stopping: boolean
  ctrls: Set<Ctrl>
  gate: Gate
  mode: DrainMode
  status: PipelineStatus
  resumeAt?: string
}
let pipeline: Pipeline | null = null
// Keep Running (M9 Decision 6): never persisted, cleared by cancel.
let keepRunning = false
// Workflow slugs with a job currently executing — lets the chat guard refuse
// only the workflow being executed rather than the whole app (M8 Decision 9).
const activeSlugs = new Set<string>()

export function isRunning(slug?: string): boolean {
  return slug === undefined ? pipeline !== null : activeSlugs.has(slug)
}

export function getDrainState(): DrainState {
  if (!pipeline) return { mode: null, status: 'Idle' }
  return { mode: pipeline.mode, status: pipeline.status, resumeAt: pipeline.resumeAt }
}

// A live drain sleeps between scans; anything that adds work (a tick, a promote,
// a Keep Running toggle) wakes it so the pickup is immediate rather than ≤pollMs.
let wakeSleeper: (() => void) | null = null
export function wakeDrain(): void {
  wakeSleeper?.()
}

function sleepOrWake(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      wakeSleeper = null
      resolve()
    }
    wakeSleeper = done
  })
}

export function setKeepRunning(on: boolean): void {
  keepRunning = on
  // Toggling mid-drain changes the stop rule in place (Decision 6): on = idle
  // and keep scanning; off = finish what's in flight and pick up nothing more
  // (unconsumed ticks stay on disk).
  if (pipeline && pipeline.mode !== 'resume') {
    pipeline.mode = on ? 'keep' : 'manual'
    pipeline.stopping = !on
  }
  wakeDrain()
}

export function cancelPipeline(): void {
  keepRunning = false
  if (!pipeline) return
  pipeline.cancelled = true
  pipeline.stopping = true
  pipeline.gate.abort()
  for (const c of pipeline.ctrls) {
    c.cancelled = true
    c.handle?.kill()
  }
  wakeDrain()
}

// Pure so the nightly timer is testable: ms from `now` to the next HH:MM.
export function msUntil(hhmm: string, now: Date): number {
  const [h, m] = hhmm.split(':').map(Number)
  const at = new Date(now)
  at.setHours(h, m, 0, 0)
  const ms = at.getTime() - now.getTime()
  return ms > 0 ? ms : ms + 24 * 60 * 60_000
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const taskTitle = (t: { title?: string }, i: number): string => t.title || `task ${i + 1}`
const human = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`

type Job = { id: string; slug: string; run: (ctrl: Ctrl, gate: Gate) => Promise<RunState> }

// The drain (M9 §3): one supervisor loop. It refills up to maxConcurrency from
// `next()`, then waits for either a job to finish or the poll interval to
// elapse, and re-asks. Sequential within a workflow, parallel across them (each
// workflow has at most one running task, so bounding workflows bounds tasks).
// Stop rule: nothing in flight and either stopping (cancel) or not keep-running.
async function drainLoop(
  next: () => Job | undefined,
  maxConcurrency: number,
  events: RunEvents,
  opts: RunOpts,
  mode: DrainMode
): Promise<RunState[]> {
  if (pipeline) throw new Error('a pipeline is already running')
  const emit = (status: PipelineStatus, info?: { resumeAt?: string }): void => {
    // Paused always re-emits (each backoff window carries a fresh resumeAt);
    // Running/Idle only on change, so an idling drain doesn't flap.
    if (mine.status === status && status !== 'Paused') return
    mine.status = status
    mine.resumeAt = info?.resumeAt
    events.onPipeline?.(status, { ...info, mode: mine.mode })
  }
  const gate = opts.gate ?? makeGate({ ...events, onPipeline: emit }, opts)
  const mine: Pipeline = {
    cancelled: false,
    stopping: false,
    ctrls: new Set(),
    gate,
    mode,
    status: 'Idle'
  }
  pipeline = mine

  const results: RunState[] = []
  const running = new Set<Promise<void>>()
  const workers = Math.max(1, maxConcurrency)
  const pollMs = opts.pollMs ?? 2000
  // A resume is a fixed set and never idles, whatever Keep Running says (Decision 7).
  const idles = (): boolean => keepRunning && mode !== 'resume'

  const launch = (job: Job): void => {
    const ctrl: Ctrl = { cancelled: false, handle: null }
    mine.ctrls.add(ctrl)
    activeSlugs.add(job.slug)
    emit('Running') // only ever on an actual launch
    const p = Promise.resolve()
      .then(() => job.run(ctrl, gate))
      .then((r) => {
        results.push(r)
      })
      .catch((err) => events.onLog(job.id, -1, `[error] ${message(err)}`))
      .finally(() => {
        mine.ctrls.delete(ctrl)
        activeSlugs.delete(job.slug)
        running.delete(p)
      })
    running.add(p)
  }

  try {
    for (;;) {
      while (!mine.stopping && running.size < workers) {
        const job = next()
        if (!job) break
        launch(job)
      }
      if (running.size === 0) {
        if (mine.stopping || !idles()) break
        emit('Idle') // keep-running, nothing to do — "waiting for work"
      }
      const sleep = sleepOrWake(pollMs)
      await Promise.race([...running, sleep])
      wakeDrain() // settle the sleeper if a job won the race
    }
    return results
  } finally {
    pipeline = null
    activeSlugs.clear()
    wakeSleeper = null
    events.onPipeline?.('Idle', { mode: null }) // mode null = the drain is over
  }
}

// Manual / nightly / keep-running all land here: a scanning drain over the
// Queue (ticked workflows), consuming each tick as it picks the work up.
export function startDrain(
  repo: string,
  worktreeBase: string,
  maxConcurrency: number,
  events: RunEvents,
  opts: RunOpts = {},
  mode: DrainMode = 'manual'
): Promise<RunState[]> {
  const skip = new Set<string>() // untick failed → don't retry it this drain
  const next = (): Job | undefined => {
    // ponytail: queue order is alphabetical by slug (loadRepo lists sorted).
    // A `tickedAt` stamp on the workflow would make it FIFO if that ever matters.
    for (const wf of loadRepo(repo).workflows) {
      // A re-tick of a running workflow stays on disk and runs after, never
      // concurrently with itself (Decision 2).
      if (!wf.selected || skip.has(wf.slug) || activeSlugs.has(wf.slug)) continue
      try {
        setSelected(repo, wf.slug, false) // the tick is consumed before the spawn
      } catch (err) {
        // Skip *this* slug for the rest of the drain and keep looking — one bad
        // workflow must not stall the ones behind it (Decision 2, fail-soft).
        skip.add(wf.slug)
        events.onLog(wf.slug, -1, `[somni] could not untick ${wf.slug}: ${message(err)} — skipping`)
        continue
      }
      return {
        id: wf.slug,
        slug: wf.slug,
        run: (ctrl, gate) =>
          runWorkflow(repo, wf.slug, worktreeBase, events, { ...opts, ctrl, gate })
      }
    }
    return undefined
  }
  return drainLoop(next, maxConcurrency, events, opts, mode)
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

const runSlug = (repo: string, runId: string): string => {
  try {
    const path = join(repo, '.somni', 'runs', runId, 'run.json')
    return (JSON.parse(readFileSync(path, 'utf8')) as RunState).workflow
  } catch {
    return runId
  }
}

// Re-runs the not-yet-completed tasks of orphaned runs in their existing worktrees.
export function resumePipeline(
  repo: string,
  runIds: string[],
  maxConcurrency: number,
  events: RunEvents,
  opts: RunOpts = {}
): Promise<RunState[]> {
  // Fixed set over the drain loop: a resume never scans the Queue (Decision 7).
  const queue: Job[] = runIds.map((runId) => ({
    id: runId,
    slug: runSlug(repo, runId),
    run: (ctrl: Ctrl, gate: Gate) => {
      const path = join(repo, '.somni', 'runs', runId, 'run.json')
      const state = JSON.parse(readFileSync(path, 'utf8')) as RunState
      return execute(repo, state, events, { ...opts, ctrl, gate })
    }
  }))
  return drainLoop(() => queue.shift(), maxConcurrency, events, opts, 'resume')
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
  const settings = opts.settings ?? {}
  const timeoutMs =
    opts.timeoutMs ?? (settings.timeoutMinutes ? settings.timeoutMinutes * 60_000 : TASK_TIMEOUT_MS)
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
    state.baseSha ??= await headSha(repo)
    await ensureWorktree(repo, state.worktree, state.branch)

    for (let i = 0; i < state.tasks.length; i++) {
      const task = state.tasks[i]
      if (task.status === 'Completed') continue
      if (ctrl.cancelled) {
        task.status = 'Skipped'
        continue
      }
      const def = defs[i]
      const role = roles.find((r) => r.slug === def.role)
      const profile = resolveProfile(role, settings)
      // Resolved once per task, outside the attempt loop: a retry always reuses
      // the same profile, so runners are never mixed within one task (§5).
      const runner = getRunner(profile.runner, settings)
      task.runner = profile.runner
      task.model = profile.model
      task.effort = profile.effort
      const preamble = role?.preamble
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
        const handle = spawnRunner(
          runner,
          runner.buildArgs(prompt, { ...profile, autonomous: true }),
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
        if (!timedOut && runner.isRateLimit(`${detail ?? ''} ${stderr ?? ''}`)) {
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
    // Land the final status on disk *before* generating the report: a full-style
    // report task runs for minutes, and a crash during it must leave a finished
    // run, not a Running orphan whose extra Report task fails the resume check.
    writeState()
    // A morning report is useful on failure too (§6); never let it fail the run.
    if (state.status === 'Completed' || state.status === 'Failed')
      await writeReport(repo, state, settings).catch((err) =>
        events.onLog(state.runId, -1, `[somni] report failed: ${message(err)}`)
      )
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

async function headSha(repo: string): Promise<string | undefined> {
  const { stdout } = (await lockedGit(['-C', repo, 'rev-parse', 'HEAD'])) as { stdout: string }
  return stdout.trim() || undefined
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
