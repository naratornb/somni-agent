// Runner adapters (architecture.md §5). Every difference between the `claude`
// and `agy` CLIs — argv, stdout shape, rate-limit wording — lives in this file.
// Nothing outside it may branch on runner type.

import { execFile } from 'child_process'
import { promisify } from 'util'
import type { StreamEvent } from './stream'
import type { Effort, RunnerName, Settings } from './store'

export type RunnerOpts = {
  model?: string
  effort?: Effort
  resumeSessionId?: string
  readOnly?: boolean // chat / summary turn: inspect the repo, never write
  autonomous?: boolean // unattended task: auto-approve every tool call
}

export type Runner = {
  name: RunnerName
  binary: string // default binary name; overridden by the settings path below
  binarySetting: 'claudeBinary' | 'antigravityBinary'
  buildArgs: (prompt: string, opts: RunnerOpts) => string[]
  parseLine: (line: string) => StreamEvent | null
  isRateLimit: (text: string) => boolean
  // Model ids to suggest for this runner. `binary` is a param (not `this.binary`)
  // so callers can point it at an overridden path — or a test fixture.
  listModels: (binary: string) => Promise<string[]>
}

// Non-JSON noise on stdout is ignored rather than treated as an error.
const json = (line: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(line) as Record<string, unknown>
  } catch {
    return null
  }
}

export const claudeRunner: Runner = {
  name: 'claude',
  binary: 'claude',
  binarySetting: 'claudeBinary',
  buildArgs: (prompt, o) => [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    ...(o.readOnly ? ['--allowedTools', 'Read,Glob,Grep'] : []),
    ...(o.autonomous ? ['--dangerously-skip-permissions'] : []),
    ...(o.resumeSessionId ? ['--resume', o.resumeSessionId] : []),
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : [])
  ],
  parseLine: (line) => {
    const msg = json(line)
    if (!msg) return null
    if (msg.type === 'system' && typeof msg.session_id === 'string') {
      return { kind: 'session', sessionId: msg.session_id }
    }
    if (msg.type === 'assistant') {
      const content = (msg.message as { content?: { type: string; text?: string }[] })?.content
      const text = (content ?? [])
        .filter((b) => b.type === 'text' && b.text)
        .map((b) => b.text)
        .join('')
      return text ? { kind: 'text', text } : null
    }
    if (msg.type === 'result') {
      const u = (msg.usage ?? {}) as Record<string, unknown>
      const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0)
      const prompt =
        n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens')
      return {
        kind: 'result',
        ok: msg.is_error !== true && msg.subtype === 'success',
        costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : undefined,
        durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : undefined,
        promptTokens: prompt || undefined,
        completionTokens: n('output_tokens') || undefined,
        detail: typeof msg.result === 'string' ? msg.result : undefined
      }
    }
    return null
  },
  isRateLimit: (text) => /rate.?limit|usage limit|overloaded|429/i.test(text),
  // The claude CLI has no `models` subcommand; these are exactly the aliases
  // `claude --help` names for `--model`, so no spawn is needed.
  listModels: () => Promise.resolve(['fable', 'opus', 'sonnet'])
}

const execFileAsync = promisify(execFile)

// Antigravity (`agy`). Flags and stdout shapes below were pinned against the
// installed CLI (`agy --help` plus a live `agy -p … --output-format stream-json`
// round trip, including a `--conversation` resume).
export const antigravityRunner: Runner = {
  name: 'antigravity',
  binary: 'agy',
  binarySetting: 'antigravityBinary',
  buildArgs: (prompt, o) => [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    // agy has no per-tool allowlist, so read-only is two overlapping levers:
    // `--mode plan` keeps it out of the workspace, `--sandbox` denies shell
    // commands. Verified: a direct "overwrite this file now" instruction left
    // the file untouched. Both are needed — plan mode alone is advisory (§7).
    ...(o.readOnly ? ['--mode', 'plan', '--sandbox'] : []),
    ...(o.autonomous ? ['--dangerously-skip-permissions'] : []),
    ...(o.resumeSessionId ? ['--conversation', o.resumeSessionId] : []),
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['--effort', o.effort] : [])
  ],
  parseLine: (line) => {
    const msg = json(line)
    if (!msg) return null
    if (msg.event === 'init' && typeof msg.conversation_id === 'string') {
      return { kind: 'session', sessionId: msg.conversation_id }
    }
    if (msg.event === 'step_update') {
      const step = msg.step_update as { step_type?: string; text_delta?: string } | undefined
      return step?.step_type === 'agent_response' && step.text_delta
        ? { kind: 'text', text: step.text_delta }
        : null
    }
    if (msg.event === 'result') {
      const r = (msg.result ?? {}) as {
        status?: string
        response?: string
        duration_seconds?: number
        // Pinned against a live `agy -p … --output-format stream-json` result event:
        // usage = {input_tokens, output_tokens, thinking_tokens, cache_read_tokens,
        // total_tokens}; thinking is already inside output (in + out === total).
        usage?: Record<string, number>
      }
      const n = (k: string): number => (typeof r.usage?.[k] === 'number' ? r.usage[k] : 0)
      const prompt = n('input_tokens') + n('cache_read_tokens')
      return {
        kind: 'result',
        ok: r.status === 'SUCCESS',
        // agy reports token usage but no dollar cost — the subscription isn't metered.
        promptTokens: prompt || undefined,
        completionTokens: n('output_tokens') || undefined,
        durationMs:
          typeof r.duration_seconds === 'number'
            ? Math.round(r.duration_seconds * 1000)
            : undefined,
        detail: typeof r.response === 'string' ? r.response : undefined
      }
    }
    return null
  },
  // Google's shapes differ from Anthropic's: quota/RESOURCE_EXHAUSTED, not "usage limit".
  isRateLimit: (text) => /rate.?limit|quota|resource.?exhausted|too many requests|429/i.test(text),
  // `agy models` prints `id\tLabel` lines on stdout, with progress noise
  // ("Fetching available models...") that carries no tab. Pinned against the
  // installed CLI.
  listModels: async (binary) => {
    try {
      const { stdout } = await execFileAsync(binary, ['models'], { timeout: 10_000 })
      const ids = stdout
        .split('\n')
        .filter((l) => l.includes('\t'))
        .map((l) => l.slice(0, l.indexOf('\t')).trim())
        .filter(Boolean)
      return ids.length ? ids : AGY_FALLBACK_MODELS
    } catch {
      return AGY_FALLBACK_MODELS
    }
  }
}

// ponytail: a short pinned list, used only when the CLI can't be queried (not
// installed, offline, changed output). The live query is the source of truth —
// let this drift rather than growing a sync mechanism for it.
const AGY_FALLBACK_MODELS = [
  'gemini-3.1-pro-high',
  'gemini-3.1-pro-low',
  'gemini-3.7-flash-high',
  'claude-opus-4-6-thinking',
  'claude-sonnet-4-6'
]

const RUNNERS: Record<RunnerName, Runner> = {
  claude: claudeRunner,
  antigravity: antigravityRunner
}

// The one place a runner name maps to an adapter. An unknown name (hand-edited
// config) falls back to claude rather than failing the run.
export function getRunner(name: RunnerName = 'claude', settings: Settings = {}): Runner {
  const runner = RUNNERS[name] ?? claudeRunner
  const path = settings[runner.binarySetting]
  return path ? { ...runner, binary: path } : runner
}

export type RunnerHealth = { ok: boolean; binary: string }

// Health probe for the configured runner (the voice:status idiom): the app's
// core purpose dies silently when the CLI isn't resolvable, so main answers
// the question on demand — no cache, a Settings fix clears it without restart.
// ponytail: probes only the *global* runner and assumes every runner answers
// `--version` — a role pinning the other runner isn't covered; probe per
// resolved profile (and lift the probe args onto Runner) if that ever bites.
export async function runnerStatus(settings: Settings = {}): Promise<RunnerHealth> {
  const { binary } = getRunner(settings.runner, settings)
  try {
    await execFileAsync(binary, ['--version'], { timeout: 10_000 })
    return { ok: true, binary }
  } catch {
    return { ok: false, binary }
  }
}
