// The shared "resolve a provider, run one Turn, classify the result" body
// (M26 §5) — used by the subtask loop, aux Review/Fix, and the full-style
// Report task (src/main/executor.ts, src/main/report.ts). One implementation
// means a rate-limit/auth-park/clock/logging fix lands once for all three
// instead of drifting across copies.
//
// Lives in its own module (not executor.ts) so report.ts can import it without
// a runtime cycle: executor.ts already imports writeReport from report.ts, so
// report.ts must not import a runtime value back from executor.ts. It still
// imports Ctrl/RunEvents/TaskRun from executor.ts, but only as types — erased
// at compile time, so that edge never becomes a runtime cycle.

import {
  acquireSlot,
  isAvailable,
  markAuthFailed,
  markOk,
  markRateLimited,
  nextAvailableAt,
  pickAuto
} from './providers'
import { getRunner } from './runners'
import { turn, TurnRequest } from './turn'
import type { Effort, RunnerChoice, RunnerName, Settings } from './store'
import type { Ctrl, RunEvents, TaskRun } from './executor'

const POLL_MS = 25 // real ms between deadline checks

// Abortable wait to a deadline on the caller's clock (RunOpts.now, or real time
// by default); resolves true when the deadline passed, false on cancel/abort.
// Polls in real time rather than a single setTimeout(at - now()): `now` may
// run faster than real time (tests fast-forward a provider's real cooldown),
// and that delta is on the caller's clock, not a real-ms duration.
function sleepUntil(at: number, signal: AbortSignal, now: () => number): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (ok: boolean): void => {
      clearInterval(iv)
      signal.removeEventListener('abort', onAbort)
      resolve(ok)
    }
    const onAbort = (): void => finish(false)
    signal.addEventListener('abort', onAbort, { once: true })
    const iv = setInterval(() => {
      if (now() >= at) finish(true)
    }, POLL_MS)
    if (now() >= at) finish(true)
  })
}

// Waits for a usable provider. 'auto' fails over to the next chain member
// immediately; a pinned choice waits out its own cooldown. Returns the
// terminal states explicitly rather than throwing, so callers decide how to
// fail (task vs. run) without a try/catch detour.
export async function resolveTurnRunner(
  choice: RunnerChoice,
  settings: Settings,
  ctrl: Ctrl,
  nowMs: () => number,
  onPause?: (resumeAt: string) => void,
  onResume?: () => void
): Promise<RunnerName | 'cancelled' | 'unavailable'> {
  for (;;) {
    if (ctrl.cancelled) return 'cancelled'
    const next =
      choice === 'auto'
        ? pickAuto(settings, nowMs())
        : isAvailable(choice, settings, nowMs())
          ? choice
          : null
    if (next) return next
    const at = nextAvailableAt(settings, choice, nowMs())
    if (at === null) return 'unavailable'
    onPause?.(new Date(at).toISOString())
    if (await sleepUntil(at, ctrl.ac.signal, nowMs)) onResume?.()
  }
}

export type TurnOutcome =
  | { ok: true; text: string }
  | { ok: false; reason: 'cancelled' }
  | { ok: false; reason: 'no-provider' }
  // Pinned + parked: that provider can never come back on its own.
  | { ok: false; reason: 'auth-parked' }
  // Genuine (non-rate-limit, non-auth) failures exhausted maxAttempts on the
  // same provider (§5: a retry never switches providers).
  | { ok: false; reason: 'exhausted' }

export type FailoverArgs = {
  choice: RunnerChoice
  // Only used when `choice` is pinned — 'auto' always reads per-provider
  // defaults from settings.providers.defaults instead.
  pinnedModel?: string
  pinnedEffort?: Effort
  settings: Settings
  ctrl: Ctrl
  nowMs: () => number
  events: RunEvents
  runId: string
  taskIndex: number // -1 for aux/report tasks, the subtask's index otherwise
  task: TaskRun // mutated in place: runner/model/effort/attempts/usage/error
  maxAttempts: number // genuine-failure retries on the same provider (2 for a subtask, 1 = one shot for aux/report)
  request: Omit<TurnRequest, 'settings' | 'runner' | 'model' | 'effort'>
  onAttempt?: () => void // fires once task fields are set for the coming attempt (a persistence hook)
  onFailover?: () => void // fires after a rate-limit/auth-park is recorded, before the retry (a persistence hook)
}

/**
 * Resolve → acquireSlot → turn → classify, looped until a terminal outcome.
 * 'auto' fails over immediately on a rate limit or auth failure; a pinned
 * choice waits out its own cooldown (rate limit) or fails the task outright
 * (auth park — it can't come back). A genuine failure retries the same
 * provider up to `maxAttempts` times, never switching mid-retry.
 */
export async function runTurnWithFailover(args: FailoverArgs): Promise<TurnOutcome> {
  const { choice, settings, ctrl, nowMs, events, runId, taskIndex, task, maxAttempts, request } =
    args
  const auto = choice === 'auto'
  let concrete: RunnerName | null = null
  let failures = 0
  for (;;) {
    if (ctrl.cancelled) return { ok: false, reason: 'cancelled' }
    if (!concrete) {
      const resolved = await resolveTurnRunner(
        choice,
        settings,
        ctrl,
        nowMs,
        (resumeAt) => events.onPipeline?.('Paused', { resumeAt }),
        () => events.onPipeline?.('Running')
      )
      if (resolved === 'cancelled') return { ok: false, reason: 'cancelled' }
      if (resolved === 'unavailable') return { ok: false, reason: 'no-provider' }
      concrete = resolved
    }
    const model = auto ? settings.providers?.defaults?.[concrete]?.model : args.pinnedModel
    const effort = auto ? settings.providers?.defaults?.[concrete]?.effort : args.pinnedEffort
    task.runner = concrete
    task.model = model
    task.effort = effort
    task.attempts = (task.attempts ?? 0) + 1
    args.onAttempt?.()

    const release = await acquireSlot(concrete, settings)
    let r: Awaited<ReturnType<typeof turn>>
    try {
      r = await turn(
        { ...request, settings, runner: concrete, model, effort },
        { signal: ctrl.ac.signal }
      )
    } finally {
      release()
    }

    task.costUsd = r.usage.costUsd
    task.promptTokens = r.usage.promptTokens
    task.completionTokens = r.usage.completionTokens
    task.durationMs = r.usage.durationMs
    task.exitCode = r.exitCode
    if (r.sessionId) task.sessionId = r.sessionId
    // Persist *why* it failed even when the CLI never produced a result event
    // (bad PATH, crash, timeout) — otherwise the morning shows "Failed", no reason.
    task.error = r.ok || ctrl.cancelled ? undefined : r.detail

    if (ctrl.cancelled) return { ok: false, reason: 'cancelled' }
    if (r.ok) {
      markOk(concrete)
      return { ok: true, text: r.text }
    }
    if (r.rateLimited) {
      markRateLimited(concrete, nowMs())
      events.onLog(runId, taskIndex, `[somni] ${concrete} rate limited — failing over`)
      args.onFailover?.()
      concrete = null
      continue
    }
    if (getRunner(concrete, settings).isAuthError?.(r.detail ?? '')) {
      markAuthFailed(concrete)
      events.onLog(runId, taskIndex, `[somni] ${concrete} auth failed — parked`)
      if (!auto) return { ok: false, reason: 'auth-parked' }
      args.onFailover?.()
      concrete = null
      continue
    }
    if (++failures < maxAttempts) {
      events.onLog(runId, taskIndex, `[somni] ${r.detail ?? 'failed'} — retrying`)
      continue
    }
    return { ok: false, reason: 'exhausted' }
  }
}
