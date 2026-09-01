// One prompt→reply exchange with a Runner (CONTEXT.md: "Turn"): exactly one
// attempt, always time-bounded, always cancellable. Every AI feature — Subtask
// execution, Grooming replies, Review/Fix, Reports, Refine, the Playground —
// crosses this seam; retries and the rate-limit gate are Pipeline policy and
// stay outside. The SIGTERM→SIGKILL grace dance, stream demux, usage capture,
// raw-log append, and failure taxonomy all live behind it.

import { appendFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { WebContents } from 'electron'
import { spawnRunner, TaskEvent } from './runner'
import { getRunner } from './runners'
import type { Effort, RunnerName, Settings } from './store'

export const TURN_TIMEOUT_MS = 30 * 60_000 // fallback; settings.timeoutMinutes wins
const KILL_GRACE_MS = 5_000 // SIGTERM → SIGKILL grace

const human = (ms: number): string =>
  ms >= 60_000 ? `${Math.round(ms / 60_000)}m` : `${Math.round(ms / 1000)}s`

export type TurnUsage = {
  costUsd?: number
  promptTokens?: number
  completionTokens?: number
  durationMs: number
}

export type TurnRequest = {
  prompt: string
  settings: Settings // resolved settings: runner/binary lookup + timeout default
  cwd: string
  // Per-turn profile overrides (Subtasks resolve role → repo → global);
  // omitted fields fall back to the settings' own runner/model/effort.
  runner?: RunnerName
  model?: string
  effort?: Effort
  resumeSessionId?: string
  readOnly?: boolean
  autonomous?: boolean
  timeoutMs?: number // default settings.timeoutMinutes → TURN_TIMEOUT_MS
  graceMs?: number
  logPath?: string // raw stream appended here
  onText?: (text: string) => void
  onSession?: (sessionId: string) => void
  onStderr?: (message: string) => void
}

export type TurnResult =
  | { ok: true; text: string; sessionId?: string; exitCode: number | null; usage: TurnUsage }
  | {
      ok: false
      kind: 'spawn' | 'exit' | 'timeout' | 'aborted'
      detail: string
      rateLimited: boolean
      sessionId?: string
      exitCode: number | null
      usage: TurnUsage
    }

export async function turn(
  req: TurnRequest,
  opts: { signal?: AbortSignal } = {}
): Promise<TurnResult> {
  const runner = getRunner(req.runner ?? req.settings.runner, req.settings)
  const timeoutMs =
    req.timeoutMs ??
    (req.settings.timeoutMinutes ? req.settings.timeoutMinutes * 60_000 : TURN_TIMEOUT_MS)
  const graceMs = req.graceMs ?? KILL_GRACE_MS
  if (opts.signal?.aborted)
    return {
      ok: false,
      kind: 'aborted',
      detail: 'aborted',
      rateLimited: false,
      exitCode: null,
      usage: { durationMs: 0 }
    }

  const started = Date.now()
  const usage: TurnUsage = { durationMs: 0 }
  let detail: string | undefined
  let streamed = ''
  let stderrLast: string | undefined
  let sessionId: string | undefined
  let resultMs: number | undefined
  let timedOut = false

  const handle = spawnRunner(
    runner,
    runner.buildArgs(req.prompt, {
      model: req.model ?? req.settings.model,
      effort: req.effort ?? req.settings.effort,
      resumeSessionId: req.resumeSessionId,
      readOnly: req.readOnly,
      autonomous: req.autonomous
    }),
    req.cwd,
    (ev) => {
      if (ev.kind === 'session') {
        sessionId = ev.sessionId
        req.onSession?.(ev.sessionId)
      }
      if (ev.kind === 'text') {
        streamed += ev.text
        req.onText?.(ev.text)
      }
      if (ev.kind === 'spawn-error') {
        stderrLast = ev.message.split('\n').filter(Boolean).pop()
        req.onStderr?.(ev.message)
      }
      if (ev.kind === 'result') {
        usage.costUsd = ev.costUsd
        usage.promptTokens = ev.promptTokens
        usage.completionTokens = ev.completionTokens
        resultMs = ev.durationMs
        detail = ev.detail
      }
    },
    req.logPath ? (chunk): void => appendFileSync(req.logPath!, chunk) : undefined
  )

  let grace: NodeJS.Timeout | null = null
  const killNow = (): void => {
    handle.kill()
    grace ??= setTimeout(() => handle.kill('SIGKILL'), graceMs)
  }
  const killer = setTimeout(() => {
    timedOut = true
    killNow()
  }, timeoutMs)
  const onAbort = (): void => killNow()
  opts.signal?.addEventListener('abort', onAbort, { once: true })

  const exit = await handle.done
  clearTimeout(killer)
  if (grace) clearTimeout(grace)
  opts.signal?.removeEventListener('abort', onAbort)
  usage.durationMs = resultMs ?? Date.now() - started

  const base = { sessionId, exitCode: exit.code, usage }
  if (opts.signal?.aborted)
    return { ok: false, kind: 'aborted', detail: 'aborted', rateLimited: false, ...base }
  if (timedOut)
    return {
      ok: false,
      kind: 'timeout',
      detail: `timed out after ${human(timeoutMs)}`,
      rateLimited: false,
      ...base
    }
  if (exit.ok) return { ok: true, text: (detail ?? streamed).trim(), ...base }
  return {
    ok: false,
    kind: exit.code === null ? 'spawn' : 'exit',
    detail: detail ?? stderrLast ?? `exited with code ${exit.code}`,
    rateLimited: runner.isRateLimit(`${detail ?? ''} ${stderrLast ?? ''}`),
    ...base
  }
}

// ---- Playground (M0) --------------------------------------------------------
// One ad-hoc Turn in a scratch dir; the renderer renders the raw event feed.

let playground: AbortController | null = null

export function runTask(prompt: string, send: (ev: TaskEvent) => void): void {
  if (playground) return
  const cwd = mkdtempSync(join(tmpdir(), 'somni-m0-'))
  const ac = (playground = new AbortController())
  void turn(
    {
      prompt,
      settings: {},
      cwd,
      onSession: (id) => send({ kind: 'session', sessionId: id }),
      onText: (t) => send({ kind: 'text', text: t }),
      onStderr: (m) => send({ kind: 'spawn-error', message: m })
    },
    { signal: ac.signal }
  ).then((r) => {
    playground = null
    send({
      kind: 'result',
      ok: r.ok,
      costUsd: r.usage.costUsd,
      durationMs: r.usage.durationMs,
      promptTokens: r.usage.promptTokens,
      completionTokens: r.usage.completionTokens,
      detail: r.ok ? r.text : r.detail
    })
    send({ kind: 'exit', code: r.exitCode })
  })
}

export function killTask(): void {
  playground?.abort()
}

export function wireTaskIpc(ipcMain: Electron.IpcMain, contents: () => WebContents | null): void {
  ipcMain.handle('task:run', (_e, prompt: string) => {
    runTask(String(prompt), (ev) => contents()?.send('task:event', ev))
  })
}
