// Orchestrator (architecture.md §3): runs one Story per worktree, subtasks
// sequential within it. The pipeline is a drain (M9): one supervisor loop
// re-scans the items for stories whose status is `in-progress` — status is the
// tick (M13) — with bounded concurrency. Every state transition is written to
// .somni/runs/<runId>/run.json before it is acted on.

import { execFile } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { writeReport } from './report'
import { turn } from './turn'
import type { RunStats } from './report'
import {
  atomicWrite,
  Item,
  ItemStatus,
  loadItems,
  loadRepo,
  Methodology,
  resolveProfile,
  Role,
  RunnerName,
  setItemStatus,
  Settings,
  slugify,
  Task
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
  // Auto-appended by somni (Review / fix / Report) rather than a Story subtask.
  // Excluded from the "story changed since it started" resume check.
  aux?: true
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
  // The story id. The JSON key name is frozen for v1-run compatibility (§4.1).
  workflow: string
  name: string
  branch: string
  worktree: string
  baseSha?: string // commit the branch was cut from — reports diff against it
  status: TaskStatus
  startedAt: string
  finishedAt?: string
  tasks: TaskRun[]
  reviews?: ReviewCycle[] // the closing review loop, one entry per cycle (M16)
  stats?: RunStats // written at report time; see report.ts (architecture.md §4)
}

// One pass of the closing review loop. `verdict` is what the agent claimed
// ('unknown' = no parseable somni-verdict block); `green` is what somni ruled,
// which is what actually decides the run (architecture.md §10).
export type ReviewCycle = {
  cycle: number
  verdict: 'green' | 'red' | 'unknown'
  findings: string
  check?: { command: string; ok: boolean; output: string }
  green: boolean
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

// Cancellation is one AbortController per run: aborting kills the current Turn
// (subtask or aux Review/Fix) and pre-empts any Turn the run has not started yet.
type Ctrl = { cancelled: boolean; ac: AbortController }

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
// Story ids with a job currently executing — lets the chat guard refuse only
// the story being executed rather than the whole app (M8 Decision 9).
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
    c.ac.abort()
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

// The implement discipline (M16). Prompt text only — the runner adapters stay
// runner-agnostic. Prepended to every subtask *alongside* the role preamble.
export const DISCIPLINE_PREAMBLE = [
  'You are working through somni, unattended, in an isolated git worktree.',
  '',
  'Discipline for this subtask:',
  '- Read the Story Spec at `{SPEC}` first. It is the contract; the subtask below is one step of it.',
  '- Work through the `implement` skill in `.claude/skills/` — TDD at the agreed seams:',
  '  a failing test first, the smallest change that passes it, then refactor.',
  '- Stay strictly within this subtask. Do not start the next one, do not refactor',
  '  code the Spec does not name, and do not add dependencies.',
  '- If the Spec and the subtask disagree, follow the Spec and say so in your reply.'
].join('\n')

/** Discipline preamble → role preamble → the subtask prompt (M16 §3). */
export function subtaskPrompt(
  specPath: string,
  rolePreamble: string | undefined,
  prompt: string
): string {
  return [DISCIPLINE_PREAMBLE.replace('{SPEC}', specPath), rolePreamble, prompt]
    .filter(Boolean)
    .join('\n\n---\n\n')
}

// Superpowers mode (docs/adr/0002): the agent orchestrates. One process runs
// the whole Story as a plan, subagent-driven; somni's engine sees exactly one
// synthetic subtask, so retries and the review loop apply at Story level.
export const PLAN_TASK_TITLE = 'Execute plan'

export const PLAN_PREAMBLE = [
  'You are working through somni, unattended, in an isolated git worktree.',
  '',
  'Discipline for this run — the superpowers workflow:',
  '- Read the Story Spec at `{SPEC}` first. It is the contract for this whole run.',
  '- The plan below lists the ordered steps. Execute it with the',
  '  `executing-plans` and `subagent-driven-development` skills in `.claude/skills/`:',
  '  work through the steps in order, dispatching a fresh subagent per step and',
  '  reviewing its work before moving on.',
  '- `test-driven-development` governs every change: a failing test first, the',
  '  smallest change that passes it, then refactor. Verify each step honestly',
  '  before calling it done (`verification-before-completion`).',
  '- Stay strictly within the plan. Do not refactor code the Spec does not name,',
  '  and do not add dependencies.',
  '- If the Spec and a step disagree, follow the Spec and say so in your reply.'
].join('\n')

/** The whole Story as one prompt: discipline, then the ordered steps with their role personas. */
export function storyPlanPrompt(specPath: string, defs: Task[], roles: Role[]): string {
  const steps = defs.map((d, i) => {
    const role = roles.find((r) => r.slug === d.role)
    return [
      `## Step ${i + 1}: ${taskTitle(d, i)}`,
      ...(role?.preamble ? [`Work this step as ${role.name}:\n${role.preamble}`] : []),
      d.prompt
    ].join('\n\n')
  })
  return [PLAN_PREAMBLE.replace('{SPEC}', specPath), '# The plan', ...steps].join('\n\n---\n\n')
}

const MAX_FIX_CYCLES = 2 // Review → fix+Review → fix+Review → Failed

const REVIEW_SKILL: Record<Methodology, string> = {
  pocock: '`code-review`',
  superpowers: '`requesting-code-review`'
}

const REVIEW_PROMPT = (base: string, methodology: Methodology = 'pocock'): string =>
  [
    'You are closing out an unattended coding run in this worktree.',
    '',
    `1. Code-review the full diff against \`${base}\` (\`git diff ${base}\`) using the`,
    `   ${REVIEW_SKILL[methodology]} skill in \`.claude/skills/\`: correctness, scope creep, missing tests.`,
    "2. Run this repo's test suite and report what it actually did.",
    '3. End your reply with exactly one fenced block, and nothing after it:',
    '',
    '```somni-verdict',
    '{"verdict": "green", "findings": ""}',
    '```',
    '',
    'Use "red" and put every blocking problem in `findings` (plain text, one per line)',
    'if the tests fail or the review found something that must be fixed. Do not be',
    'generous: "green" means a human could merge this as-is.'
  ].join('\n')

const FIX_PROMPT = (findings: string, methodology: Methodology = 'pocock'): string =>
  [
    'The closing review of this worktree came back red. Fix these findings, and only these:',
    '',
    findings,
    '',
    methodology === 'superpowers'
      ? 'Debug systematically — find the root cause before fixing (`systematic-debugging`' +
        '\nin `.claude/skills/`) — and keep the TDD discipline: a failing test first where' +
        '\na test is the right proof.'
      : 'Keep the same TDD discipline: a failing test first where a test is the right proof.',
    'Do not expand scope beyond the findings.'
  ].join('\n')

/** Last ```somni-verdict block; null when absent or malformed (§10: that is red). */
export function parseVerdict(text: string): { verdict: 'green' | 'red'; findings: string } | null {
  const blocks = [...text.matchAll(/```somni-verdict[^\n]*\n([\s\S]*?)\n```/g)]
  const last = blocks[blocks.length - 1]
  if (!last) return null
  try {
    const raw = JSON.parse(last[1]) as Record<string, unknown>
    if (raw.verdict !== 'green' && raw.verdict !== 'red') return null
    return { verdict: raw.verdict, findings: typeof raw.findings === 'string' ? raw.findings : '' }
  } catch {
    return null
  }
}

const TAIL_CHARS = 4000

/** The deterministic half of the green signal (§10). Undefined = not configured. */
export async function runCheckCommand(
  command: string | undefined,
  cwd: string,
  timeoutMs: number
): Promise<{ command: string; ok: boolean; output: string } | undefined> {
  if (!command?.trim()) return undefined
  try {
    const { stdout, stderr } = await promisify(execFile)('/bin/sh', ['-c', command], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 << 20
    })
    return { command, ok: true, output: `${stdout}${stderr}`.slice(-TAIL_CHARS) }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string }
    return {
      command,
      ok: false,
      output: `${e.stdout ?? ''}${e.stderr ?? ''}${e.stdout || e.stderr ? '' : (e.message ?? '')}`
        .slice(-TAIL_CHARS)
        .trim()
    }
  }
}

/**
 * The verdict semantics, pinned by the M16 decisions log: a configured
 * checkCommand is authoritative — failing is red whatever the agent claimed,
 * passing makes a missing/malformed verdict green. Without one, only an
 * explicit "green" is green.
 */
export function isGreen(
  verdict: 'green' | 'red' | 'unknown',
  check: { ok: boolean } | undefined
): boolean {
  return check ? check.ok && verdict !== 'red' : verdict === 'green'
}

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
    const ctrl: Ctrl = { cancelled: false, ac: new AbortController() }
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
// stories whose status is `in-progress` (M13 §3 — status is the tick).
export function startDrain(
  repo: string,
  worktreeBase: string,
  maxConcurrency: number,
  events: RunEvents,
  opts: RunOpts = {},
  mode: DrainMode = 'manual'
): Promise<RunState[]> {
  const skip = new Set<string>() // failed to even start → don't re-pick it this drain
  const next = (): Job | undefined => {
    const items = loadItems(repo)
    const done = new Set(items.filter((i) => i.status === 'done').map((i) => i.id))
    // ponytail: pickup order is by id (loadItems sorts numerically). Stories
    // blocked by anything not yet `done` simply wait for a later scan.
    for (const it of items) {
      // `kind` is checked here too: .somni/ is hand-editable, so a hand-marked
      // in-progress epic must never spawn.
      if (it.kind !== 'story' || it.status !== 'in-progress') continue
      if (skip.has(it.id) || activeSlugs.has(it.id)) continue
      if (it.blockedBy?.some((b) => !done.has(b))) continue
      return {
        id: it.id,
        slug: it.id,
        run: async (ctrl, gate) => {
          try {
            return await runStory(repo, it.id, worktreeBase, events, { ...opts, ctrl, gate })
          } catch (err) {
            // A story that cannot even start would otherwise be re-picked on
            // every scan — its status stays `in-progress` on disk.
            skip.add(it.id)
            throw err
          }
        }
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

export function runStory(
  repo: string,
  storyId: string,
  worktreeBase: string,
  events: RunEvents,
  opts: RunOpts = {}
): Promise<RunState> {
  const now = opts.now ?? ((): Date => new Date())
  const story = loadItems(repo).find((i) => i.id === storyId)
  if (!story) throw new Error(`story not found: ${storyId}`)
  const defs = story.tasks.filter((t) => t.selected !== false)
  if (defs.length === 0) throw new Error(`no tasks selected in ${story.name}`)

  const stamp = now().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  const runId = `${stamp}-${story.slug}` // slug keeps concurrent same-second runs unique
  mkdirSync(join(repo, '.somni', 'runs', runId, 'logs'), { recursive: true })

  // Superpowers (adr/0002): the run is one plan-executing task, not one per
  // subtask; execute() builds the same synthetic def so the state check holds.
  const tasks: TaskRun[] =
    (opts.settings?.methodology ?? 'pocock') === 'superpowers'
      ? [{ title: PLAN_TASK_TITLE, role: '', status: 'Queued', log: 'logs/1-execute-plan.jsonl' }]
      : defs.map((t, i) => ({
          title: taskTitle(t, i),
          role: t.role,
          status: 'Queued',
          log: `logs/${i + 1}-${slugify(t.title || 'task')}.jsonl`
        }))

  return execute(
    repo,
    {
      runId,
      workflow: story.id,
      name: story.name,
      branch: `somni/${story.slug}-${stamp}`,
      worktree: join(worktreeBase, runId),
      status: 'Running',
      startedAt: now().toISOString(),
      tasks
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
  const ctrl = opts.ctrl ?? { cancelled: false, ac: new AbortController() }
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

  const { roles, items } = loadRepo(repo)
  const story = items.find((i: Item) => i.id === state.workflow)
  const storyDefs = (story?.tasks ?? []).filter((t) => t.selected !== false)
  const specPath = story ? join('.somni', 'items', `${story.id}-${story.slug}.md`) : ''
  const methodology = settings.methodology ?? 'pocock'
  // Superpowers: the whole Story is one plan-executing def, prompt included —
  // so a resume rebuilds the plan from the items exactly like pocock rebuilds
  // subtask prompts. A run started under the other methodology fails the
  // "story changed" check below, which is the honest outcome.
  const defs: Task[] =
    methodology === 'superpowers' && storyDefs.length > 0
      ? [
          {
            title: PLAN_TASK_TITLE,
            prompt: storyPlanPrompt(specPath, storyDefs, roles),
            role: '',
            selected: true
          }
        ]
      : storyDefs

  // ponytail: aux tasks are one Turn each rather than threaded through the
  // retry/gate loop below (report.ts's Report-task precedent) — one shot each,
  // and the review loop is itself the retry. They still record attempts/cost so
  // run.json and the report treat them like any other task, and they share the
  // run's AbortController, so cancel and the task timeout reach them too.
  const auxTask = async (title: string, prompt: string, log: string): Promise<string | null> => {
    const task: TaskRun = {
      title,
      role: '',
      aux: true,
      status: 'Running',
      attempts: 1,
      runner: settings.runner,
      model: settings.model,
      effort: settings.effort,
      log: `logs/${log}`
    }
    state.tasks.push(task)
    writeState()
    const r = await turn(
      {
        prompt,
        settings,
        cwd: state.worktree,
        autonomous: true,
        timeoutMs,
        graceMs,
        logPath: join(runDir, task.log)
      },
      { signal: ctrl.ac.signal }
    )
    Object.assign(task, r.usage)
    const text = r.ok && r.text ? r.text : null
    task.status = text ? 'Completed' : 'Failed'
    if (!text) task.error = `${title.toLowerCase()} task produced no output`
    writeState()
    return text
  }

  // Review → (red) fix → review, at most MAX_FIX_CYCLES fixes. Returns the
  // honest green signal; false lands the run in needs-attention.
  const reviewLoop = async (): Promise<boolean> => {
    const reviews = (state.reviews ??= [])
    for (let cycle = 0; ; cycle++) {
      const check = await runCheckCommand(settings.checkCommand, state.worktree, timeoutMs)
      const text = await auxTask(
        'Review',
        REVIEW_PROMPT(state.baseSha ?? 'HEAD', methodology),
        `review-${cycle + 1}.log`
      )
      const parsed = text ? parseVerdict(text) : null
      const verdict = parsed?.verdict ?? 'unknown'
      const green = isGreen(verdict, check)
      const findings =
        [
          parsed?.findings?.trim(),
          check && !check.ok ? `checkCommand \`${check.command}\` failed:\n${check.output}` : ''
        ]
          .filter(Boolean)
          .join('\n\n') || 'The review produced no parseable verdict.'
      reviews.push({ cycle: cycle + 1, verdict, findings: green ? '' : findings, check, green })
      writeState()
      if (green) return true
      if (cycle >= MAX_FIX_CYCLES || ctrl.cancelled) return false
      events.onLog(state.runId, -1, `[somni] review red — fix cycle ${cycle + 1}`)
      await auxTask(
        'Address review findings',
        FIX_PROMPT(findings, methodology),
        `fix-${cycle + 1}.log`
      )
    }
  }

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
    const subtasks = state.tasks.filter((t) => !t.aux)
    if (
      defs.length !== subtasks.length ||
      defs.some((d, i) => taskTitle(d, i) !== subtasks[i].title)
    )
      throw new Error('story changed since it started')
    state.baseSha ??= await headSha(repo)
    await ensureWorktree(repo, state.worktree, state.branch)

    for (let i = 0; i < defs.length; i++) {
      const task = state.tasks[i]
      if (task.status === 'Completed') continue
      if (ctrl.cancelled) {
        task.status = 'Skipped'
        continue
      }
      const def = defs[i]
      const role = roles.find((r) => r.slug === def.role)
      // Resolved once per task, outside the attempt loop: a retry always reuses
      // the same profile, so runners are never mixed within one task (§5).
      const profile = resolveProfile(role, settings)
      task.runner = profile.runner
      task.model = profile.model
      task.effort = profile.effort
      // The superpowers plan def is already the complete prompt.
      const prompt =
        methodology === 'superpowers'
          ? def.prompt
          : subtaskPrompt(specPath, role?.preamble, def.prompt)
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

        const r = await turn(
          {
            prompt,
            settings,
            cwd: state.worktree,
            ...profile,
            autonomous: true,
            timeoutMs,
            graceMs,
            logPath,
            onSession: (id) => (task.sessionId = id),
            onText: (t) => events.onLog(state.runId, i, t),
            onStderr: (m) => events.onLog(state.runId, i, `[stderr] ${m}`)
          },
          { signal: ctrl.ac.signal }
        )

        task.costUsd = r.usage.costUsd
        task.promptTokens = r.usage.promptTokens
        task.completionTokens = r.usage.completionTokens
        task.exitCode = r.exitCode
        task.durationMs = r.usage.durationMs
        // Persist *why* it failed even when the CLI never produced a result event
        // (bad PATH, crash, timeout) — otherwise the morning shows "Failed", no reason.
        task.error = r.ok || ctrl.cancelled ? undefined : r.detail

        if (ctrl.cancelled) {
          task.status = 'Cancelled'
          break
        }
        if (r.ok) {
          gate.ok()
          task.status = 'Completed'
          break
        }
        if (r.rateLimited) {
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

    // The closing review loop (M16 §9). Only when every subtask landed — a run
    // that already failed has nothing honest to review.
    let reviewGreen = true
    if (!ctrl.cancelled && state.tasks.filter((t) => !t.aux).every((t) => t.status === 'Completed'))
      reviewGreen = await reviewLoop()

    const failed = state.tasks.some((t) => t.status === 'Failed') || !reviewGreen
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
    // The board transition (§3), written after the run's own state: Completed →
    // review, Failed → needs-attention, Cancelled → back to ready. Fail-soft —
    // a hand-deleted item must not turn a finished run into a crash.
    const to: ItemStatus | null =
      state.status === 'Completed'
        ? 'review'
        : state.status === 'Failed'
          ? 'needs-attention'
          : state.status === 'Cancelled'
            ? 'ready'
            : null
    if (to) {
      try {
        setItemStatus(repo, state.workflow, to)
      } catch (err) {
        events.onLog(state.runId, -1, `[somni] could not update ${state.workflow}: ${message(err)}`)
      }
    }
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
