// Orchestrator (architecture.md §3): runs one Story per worktree, subtasks
// sequential within it. The pipeline is a drain (M9): one supervisor loop
// re-scans the items for stories whose status is `in-progress` — status is the
// tick (M13) — with bounded concurrency. Every state transition is written to
// .somni/runs/<runId>/run.json before it is acted on.

import { execFile } from 'child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import {
  BRANCH_FIX_PROMPT,
  BRANCH_REVIEW_PROMPT,
  BranchReview,
  capDiff,
  implementerOf,
  parseReview,
  pickReviewer
} from './branchReview'
import { runTurnWithFailover } from './failover'
import { lockedGit } from './git'
import { writeReport } from './report'
import {
  FIX_PROMPT,
  PLAN_TASK_TITLE,
  REVIEW_PROMPT,
  storyPlanPrompt,
  subtaskPrompt,
  taskTitle
} from './prompts'
import type { RunStats } from './report'
import {
  atomicWrite,
  Effort,
  Item,
  ItemStatus,
  loadItems,
  loadRepo,
  resolveProfile,
  RunnerChoice,
  RunnerName,
  setItemStatus,
  Settings,
  slugify,
  Task
} from './store'

const TASK_TIMEOUT_MS = 30 * 60_000 // fallback; settings.timeoutMinutes wins
const KILL_GRACE_MS = 5_000 // SIGTERM → SIGKILL grace
const MAX_ATTEMPTS = 2 // one automatic retry; rate limits don't count (§3)

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
  runner?: RunnerChoice
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
  review?: BranchReview // the merge-decision grade (M28) — set only on a green, uncancelled run
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
export type Ctrl = { cancelled: boolean; ac: AbortController }

export type RunOpts = {
  now?: () => Date
  timeoutMs?: number
  graceMs?: number
  settings?: Settings // resolved repo+global settings (profile, report style)
  pollMs?: number // drain idle poll interval (default 2000)
  ctrl?: Ctrl // internal: set by the pipeline
}

type Pipeline = {
  cancelled: boolean
  stopping: boolean
  ctrls: Set<Ctrl>
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
const MAX_FIX_CYCLES = 2 // Review → fix+Review → fix+Review → Failed

/** Last ```somni-verdict block; null when absent or malformed (§10: that is red). */
function parseVerdict(text: string): { verdict: 'green' | 'red'; findings: string } | null {
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

// Plain, unlocked git reads for the branch review's diff (M28 §2) — the mutex
// in git.ts is for mutations; report.ts's collectStats is the same idiom.
const gitRead = promisify(execFile)

async function branchDiff(
  worktree: string,
  base: string
): Promise<{ stat: string; files: { file: string; diff: string }[] }> {
  // The runCheckCommand precedent: an unbounded diff must not reject on
  // Node's 1MB default and take the whole run down with it.
  const opts = { maxBuffer: 10 << 20 }
  const [{ stdout: stat }, { stdout: raw }] = await Promise.all([
    gitRead('git', ['-C', worktree, 'diff', '--stat', base], opts),
    gitRead('git', ['-C', worktree, 'diff', base], opts)
  ])
  const files = raw
    .split(/^diff --git /m)
    .filter(Boolean)
    .map((piece) => ({ file: piece.split('\n', 1)[0], diff: `diff --git ${piece}` }))
  return { stat, files }
}

/** The deterministic half of the green signal (§10). Undefined = not configured. */
async function runCheckCommand(
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
function isGreen(
  verdict: 'green' | 'red' | 'unknown',
  check: { ok: boolean } | undefined
): boolean {
  return check ? check.ok && verdict !== 'red' : verdict === 'green'
}

type Job = { id: string; slug: string; run: (ctrl: Ctrl) => Promise<RunState> }

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
  const mine: Pipeline = {
    cancelled: false,
    stopping: false,
    ctrls: new Set(),
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
      .then(() => job.run(ctrl))
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
        run: async (ctrl) => {
          try {
            return await runStory(repo, it.id, worktreeBase, events, { ...opts, ctrl })
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

// ---- the Run record (M20): one place knows how run.json is read, written and
// tolerated. A missing or corrupt run.json reads as null: listers skip it,
// while entry points that need one specific run refuse loudly (mustLoadRun).

export function loadRun(repo: string, runId: string): RunState | null {
  try {
    return JSON.parse(
      readFileSync(join(repo, '.somni', 'runs', runId, 'run.json'), 'utf8')
    ) as RunState
  } catch {
    return null
  }
}

/** Every readable run, newest first. */
export function loadRuns(repo: string): RunState[] {
  const dir = join(repo, '.somni', 'runs')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .flatMap((runId) => loadRun(repo, runId) ?? [])
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

// Exported for runs:merge (M28 §4) — stamping review.merged reuses this same
// read-tolerant/write-atomic path rather than a hand-rolled JSON write.
export function saveRun(repo: string, state: RunState): void {
  atomicWrite(
    join(repo, '.somni', 'runs', state.runId, 'run.json'),
    JSON.stringify(state, null, 2) + '\n'
  )
}

function mustLoadRun(repo: string, runId: string): RunState {
  const state = loadRun(repo, runId)
  if (!state) throw new Error(`run ${runId} has no readable run.json`)
  return state
}

// Crash/quit recovery (§3): a run.json still marked Running on disk belongs to a
// dead process. Callers should only ask when no pipeline is running in-process.
// Oldest first — a resume replays orphans in the order they were started.
export function findOrphanedRuns(repo: string): RunState[] {
  return loadRuns(repo)
    .filter((state) => state.status === 'Running')
    .reverse()
}

export function abandonRun(repo: string, runId: string): void {
  const state = mustLoadRun(repo, runId)
  for (const t of state.tasks)
    if (t.status === 'Running' || t.status === 'Queued') t.status = 'Cancelled'
  state.status = 'Cancelled'
  state.finishedAt = new Date().toISOString()
  saveRun(repo, state)
}

const runSlug = (repo: string, runId: string): string => loadRun(repo, runId)?.workflow ?? runId

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
    run: (ctrl: Ctrl) => execute(repo, mustLoadRun(repo, runId), events, { ...opts, ctrl })
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
  const settings = opts.settings ?? {}
  const timeoutMs =
    opts.timeoutMs ?? (settings.timeoutMinutes ? settings.timeoutMinutes * 60_000 : TASK_TIMEOUT_MS)
  const graceMs = opts.graceMs ?? KILL_GRACE_MS
  const runDir = join(repo, '.somni', 'runs', state.runId)
  const writeState = (): void => {
    saveRun(repo, state)
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

  const nowMs = (): number => now().getTime()

  // ponytail: aux tasks get one genuine-failure shot each (report.ts's
  // Report-task precedent — the review loop is itself the retry) but still
  // fail over/wait on a rate limit or auth failure via runTurnWithFailover
  // (M26 §5), same as a subtask. They record attempts/cost so run.json and
  // the report treat them like any other task, and they share the run's
  // AbortController, so cancel and the task timeout reach them too.
  // Branch Review (M28 §3) pins the reviewer's own runner/model/effort rather
  // than the run's default profile, and its turn is `plain` — neither readOnly
  // nor autonomous, since it's asked to grade from the prompt alone, no tools.
  const auxTask = async (
    title: string,
    prompt: string,
    log: string,
    override?: { runner: RunnerName; model?: string; effort?: Effort; plain?: true }
  ): Promise<string | null> => {
    const profile = resolveProfile(undefined, settings)
    const runner = override?.runner ?? profile.runner ?? 'claude'
    const task: TaskRun = {
      title,
      role: '',
      aux: true,
      status: 'Running',
      attempts: 0,
      log: `logs/${log}`
    }
    state.tasks.push(task)
    writeState()

    // A pinned override never falls back to the DEFAULT profile's model —
    // profile.model is that other provider's model id, and handing it to a
    // different runner's CLI is a cross-provider leak (M28 review fix: the
    // unpinned cross-provider reviewer/fix-turn silently invoked its CLI
    // with a foreign model id and errored out ungraded every time). turn.ts
    // itself re-falls-back an omitted model to `settings.model` (the same
    // global default), so the override call gets its OWN settings object
    // with that field already resolved — never the shared one.
    const pinnedModel = override
      ? (override.model ?? settings.providers?.defaults?.[override.runner]?.model)
      : profile.model
    const turnSettings = override ? { ...settings, model: pinnedModel } : settings

    const outcome = await runTurnWithFailover({
      choice: runner,
      pinnedModel,
      pinnedEffort: override?.effort ?? profile.effort,
      settings: turnSettings,
      ctrl,
      nowMs,
      events,
      runId: state.runId,
      taskIndex: -1,
      task,
      maxAttempts: 1, // one shot for a genuine failure — the review loop is itself the retry
      request: {
        prompt,
        cwd: state.worktree,
        autonomous: !override?.plain,
        timeoutMs,
        graceMs,
        logPath: join(runDir, task.log)
      },
      onFailover: writeState
    })

    let text: string | null = null
    if (outcome.ok) {
      text = outcome.text || null
      task.status = text ? 'Completed' : 'Failed'
      if (!text) task.error = `${title.toLowerCase()} task produced no output`
    } else if (outcome.reason === 'cancelled') {
      task.status = 'Cancelled'
    } else if (outcome.reason === 'no-provider') {
      task.status = 'Failed'
      task.error = 'no provider available'
    } else {
      task.status = 'Failed'
      task.error ??= `${title.toLowerCase()} task produced no output`
    }
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

  // Branch Review (M28): the merge-decision grade, cross-provider by default —
  // runs only after the closing review loop landed green (§1). `approve` and
  // `ungraded` land the run exactly like green does today; `reject` or a final
  // `needs-work` feed the same `failed` signal reviewGreen=false already uses,
  // so routing to needs-attention is the one existing mechanism, not a second
  // one (§6). Cancellation mid-review returns true (not-failed) without ever
  // writing state.review — the aux task's own Cancelled status is what decides
  // the run's fate (§7); no grade is invented either way.
  const branchReview = async (): Promise<boolean> => {
    const implementer = implementerOf(
      state.tasks.filter((t) => !t.aux).map((t) => t.runner as RunnerName | undefined)
    )
    const reviewer = pickReviewer(settings, implementer)
    const subtaskPrompts = defs.map((d) => d.prompt)
    let truncated = false
    let reviewN = 0

    // Never returns null: a git failure or a dead turn both grade 'ungraded'
    // with the real reason folded in — a review outage never holds a green,
    // finished branch hostage (§6), and never invents a fabricated wording
    // when the TaskRun already recorded what actually went wrong.
    const review = async (): Promise<Pick<BranchReview, 'grade' | 'reasons' | 'findings'>> => {
      let diff: { stat: string; files: { file: string; diff: string }[] }
      try {
        diff = await branchDiff(state.worktree, state.baseSha ?? 'HEAD')
      } catch (err) {
        return { grade: 'ungraded', reasons: [`branch diff failed: ${message(err)}`], findings: [] }
      }
      const capped = capDiff(diff.stat, diff.files)
      truncated ||= capped.truncated
      const text = await auxTask(
        'Branch review',
        BRANCH_REVIEW_PROMPT(story?.spec ?? '', subtaskPrompts, capped.body),
        `branch-review-${++reviewN}.log`,
        { runner: reviewer.runner, model: reviewer.model, effort: reviewer.effort, plain: true }
      )
      if (text) return parseReview(text)
      const task = state.tasks[state.tasks.length - 1] // the 'Branch review' TaskRun just pushed
      return {
        grade: 'ungraded',
        reasons: [task?.error ?? 'the branch review turn produced no reply'],
        findings: []
      }
    }

    const land = (r: BranchReview): boolean => {
      state.review = r
      writeState()
      return r.grade === 'approve' || r.grade === 'ungraded'
    }
    const base = (
      partial: Pick<BranchReview, 'grade' | 'reasons' | 'findings'>,
      fixRound?: true
    ): BranchReview => ({
      ...partial,
      provider: reviewer.runner,
      sameProvider: reviewer.sameProvider,
      diffTruncated: truncated || undefined,
      ...(fixRound ? { fixRound } : {})
    })

    const first = await review()
    if (ctrl.cancelled) return true // §7: cancellation invents no grade
    if (first.grade !== 'needs-work') return land(base(first))

    // needs-work: ONE fix round (§5), then a re-review by the same reviewer.
    // Pinned to the implementer (spec §3, not the run's default profile) —
    // still the failover machinery (bounded, cancellable, cooldown-waiting),
    // just never a free cross-provider failover for this one turn.
    events.onLog(state.runId, -1, '[somni] branch review needs-work — one fix round')
    const fixText = await auxTask(
      'Address merge review',
      BRANCH_FIX_PROMPT(first.findings),
      'branch-fix.log',
      { runner: implementer }
    )
    if (ctrl.cancelled) return true
    // A fix turn that never ran at all parks with the ORIGINAL findings — this
    // is not the whole-run-failed path (§5).
    if (fixText === null)
      return land(
        base({ ...first, reasons: [...first.reasons, 'fix round did not complete'] }, true)
      )

    const check = await runCheckCommand(settings.checkCommand, state.worktree, timeoutMs)
    if (ctrl.cancelled) return true
    if (check && !check.ok)
      return land(
        base(
          {
            ...first,
            reasons: [
              ...first.reasons,
              `checkCommand \`${check.command}\` failed after the fix round`
            ]
          },
          true
        )
      )

    const second = await review()
    if (ctrl.cancelled) return true
    return land(base(second, true))
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
      // Resolved once per task, outside the attempt loop: a genuine-failure
      // retry always reuses the same concrete provider, never mixed (§5) —
      // runTurnWithFailover only re-resolves after a rate limit or auth park.
      const profile = resolveProfile(role, settings)
      // The superpowers plan def is already the complete prompt.
      const prompt =
        methodology === 'superpowers'
          ? def.prompt
          : subtaskPrompt(specPath, role?.preamble, def.prompt)
      const logPath = join(runDir, task.log)
      task.status = 'Running'
      task.attempts ??= 0
      writeState()

      const outcome = await runTurnWithFailover({
        choice: profile.runner ?? 'claude',
        pinnedModel: profile.model,
        pinnedEffort: profile.effort,
        settings,
        ctrl,
        nowMs,
        events,
        runId: state.runId,
        taskIndex: i,
        task,
        maxAttempts: MAX_ATTEMPTS,
        request: {
          prompt,
          cwd: state.worktree,
          autonomous: true,
          timeoutMs,
          graceMs,
          logPath,
          onSession: (id) => (task.sessionId = id),
          onText: (t) => events.onLog(state.runId, i, t),
          onStderr: (m) => events.onLog(state.runId, i, `[stderr] ${m}`)
        },
        onAttempt: writeState,
        onFailover: writeState
      })

      if (outcome.ok) {
        task.status = 'Completed'
      } else if (outcome.reason === 'cancelled') {
        task.status = 'Cancelled'
      } else if (outcome.reason === 'no-provider') {
        task.error = 'no provider available'
        task.status = 'Failed'
      } else {
        // 'auth-parked' (pinned, can never come back) or 'exhausted' (genuine
        // failures used up MAX_ATTEMPTS on the same provider) — task.error is
        // already the last turn's detail.
        task.status = 'Failed'
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
    const subtasksOk = state.tasks.filter((t) => !t.aux).every((t) => t.status === 'Completed')
    let reviewGreen = true
    if (!ctrl.cancelled && subtasksOk) reviewGreen = await reviewLoop()

    // Branch Review (M28 §1): only on a green, uncancelled run — a red run
    // already has its verdict. Feeds the exact `failed` signal reviewGreen=false
    // already routes through, rather than a second needs-attention path (§6).
    let branchOk = true
    if (subtasksOk && reviewGreen && !ctrl.cancelled) branchOk = await branchReview()

    // Subtask failures only: an aux task's own status never independently fails
    // the run — the closing review loop and Branch Review each carry their own
    // green/ok signal (a "turn died" branch review is ungraded, not failed) and
    // are OR'd in explicitly below.
    const failed =
      state.tasks.filter((t) => !t.aux).some((t) => t.status === 'Failed') ||
      !reviewGreen ||
      !branchOk
    const cancelled = state.tasks.some((t) => t.status === 'Cancelled')
    state.status = cancelled ? 'Cancelled' : failed ? 'Failed' : 'Completed'
    // Land the final status on disk *before* generating the report: a full-style
    // report task runs for minutes, and a crash during it must leave a finished
    // run, not a Running orphan whose extra Report task fails the resume check.
    writeState()
    // A morning report is useful on failure too (§6); never let it fail the run.
    if (state.status === 'Completed' || state.status === 'Failed') {
      // Assigned only on success: a failed report must not clobber stats a
      // previous (resumed) run already landed in run.json.
      const stats = await writeReport(repo, state, settings, ctrl, events, nowMs).catch((err) => {
        events.onLog(state.runId, -1, `[somni] report failed: ${message(err)}`)
        return undefined
      })
      if (stats) state.stats = stats
    }
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
