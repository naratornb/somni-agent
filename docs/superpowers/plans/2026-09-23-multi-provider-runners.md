# Multi-Provider Runners Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Codex CLI and Gemini CLI runners, replace the whole-pipeline rate-limit pause with a per-provider failover chain (`runner: 'auto'`), and add a Providers panel + zero-provider onboarding.

**Architecture:** Two new adapters behind the existing two-method `Runner` interface in `src/main/runners.ts` (nothing else branches on runner type). A new small `src/main/providers.ts` module owns per-provider availability (cooldowns, auth/missing marks) and per-provider concurrency slots. The executor resolves `'auto'` to a concrete provider per attempt and waits per-provider instead of pausing the pipeline globally.

**Tech Stack:** Electron main process, TypeScript strict, vitest, React renderer. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-23-multi-provider-runners-design.md`

## Global Constraints

- No new npm dependencies.
- Every commit message plain, no AI attribution (no Co-Authored-By).
- `package.json` version bumps to `0.5.0` in the final task (one bump per PR rule).
- Windows-readiness constraint: no darwin-only APIs in new code; binary resolution stays behind `getRunner`'s `binarySetting` override + PATH (`src/main/env.ts` owns PATH).
- Pinning discipline (architecture.md §5): Codex flags/shapes below were **pinned live** against `codex-cli 0.154.0` on 2026-09-23. Gemini CLI is **not installed** — its adapter is docs-based and must be labeled `UNPINNED` in code comments and architecture.md.
- Codex live-captured JSONL (authoritative fixtures for tests):
  ```
  {"type":"thread.started","thread_id":"01a0ccee-377f-7be1-a4a6-1bdb00081527"}
  {"type":"turn.started"}
  {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}
  {"type":"turn.completed","usage":{"input_tokens":19508,"cached_input_tokens":11008,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}
  ```
- Existing invariants that must survive: read-only invariant §7 (never weaken read-only chat; refuse instead), "runners never mixed within a genuine error retry", `run.json` records concrete providers only (`'auto'` never appears in run records).
- Run tests with `npx vitest run <file>`; full suite `npm test`; `npm run typecheck` must pass before each commit.
- Match surrounding code style: `// ponytail:` comments for deliberate ceilings, terse comments stating constraints only.

---

### Task 1: Store types — RunnerChoice, provider settings, chain helper

**Files:**
- Modify: `src/main/store.ts` (types at ~line 15-59, `resolveProfile` at ~line 264)
- Test: `src/main/store.test.ts`

**Interfaces:**
- Produces: `RunnerName = 'claude' | 'antigravity' | 'gemini' | 'codex'`, `RunnerChoice = RunnerName | 'auto'`, `Profile.runner?: RunnerChoice`, `Settings.geminiBinary?/codexBinary?`, `ProvidersSettings { order?, disabled?, defaults?, caps? }`, `Settings.providers?: ProvidersSettings`, `providerChain(settings): RunnerName[]`, `DEFAULT_PROVIDER_ORDER`. Every later task consumes these exact names.

- [ ] **Step 1: Write the failing tests** (append to the `resolveProfile` describe block in `src/main/store.test.ts`):

```ts
import { providerChain, DEFAULT_PROVIDER_ORDER } from './store'

it('providerChain defaults to claude-first over all four providers', () => {
  expect(providerChain({})).toEqual(['claude', 'codex', 'gemini', 'antigravity'])
  expect(DEFAULT_PROVIDER_ORDER).toEqual(['claude', 'codex', 'gemini', 'antigravity'])
})

it('providerChain honors order, appends unlisted, drops disabled and junk', () => {
  expect(
    providerChain({
      providers: { order: ['codex', 'bogus' as never, 'claude'], disabled: ['antigravity'] }
    })
  ).toEqual(['codex', 'claude', 'gemini'])
})

it('resolveProfile passes auto through untouched', () => {
  expect(resolveProfile(undefined, { runner: 'auto' }).runner).toBe('auto')
  expect(resolveProfile({ runner: 'codex' }, { runner: 'auto' }).runner).toBe('codex')
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/store.test.ts`
Expected: FAIL — `providerChain` not exported; `'codex'` not assignable to `RunnerName`.

- [ ] **Step 3: Implement in `src/main/store.ts`**

Replace the runner types (lines 17-18) and extend `Profile`/`Settings`:

```ts
export type RunnerName = 'claude' | 'antigravity' | 'gemini' | 'codex'
export const RUNNER_NAMES: RunnerName[] = ['claude', 'antigravity', 'gemini', 'codex']
// 'auto' walks the provider chain at task start (M26 §2); concrete names pin.
export type RunnerChoice = RunnerName | 'auto'
```

Change `Profile` to `{ runner?: RunnerChoice; model?: string; effort?: Effort }`. Add to `Settings`:

```ts
  geminiBinary?: string
  codexBinary?: string
  providers?: ProvidersSettings
```

Above `Settings`, add:

```ts
export type ProviderDefaults = { model?: string; effort?: Effort }
// Failover chain config (M26): order/disabled shape the chain; defaults supply
// the model/effort an 'auto' task uses per provider (model ids are provider-
// specific, so a single profile model string cannot serve the chain); caps
// bound concurrent tasks per provider (global `concurrency` stays the ceiling).
export type ProvidersSettings = {
  order?: RunnerName[]
  disabled?: RunnerName[]
  defaults?: Partial<Record<RunnerName, ProviderDefaults>>
  caps?: Partial<Record<RunnerName, number>>
}
```

Below `resolveProfile`, add:

```ts
export const DEFAULT_PROVIDER_ORDER: RunnerName[] = ['claude', 'codex', 'gemini', 'antigravity']

// The failover chain (M26 §2): configured order first, unlisted providers
// appended in default order, disabled and unknown names dropped.
export function providerChain(settings: Settings): RunnerName[] {
  const order = (settings.providers?.order ?? []).filter((n) => RUNNER_NAMES.includes(n))
  const disabled = new Set(settings.providers?.disabled ?? [])
  const full = [...order, ...DEFAULT_PROVIDER_ORDER.filter((n) => !order.includes(n))]
  return full.filter((n) => !disabled.has(n))
}
```

`resolveProfile` needs no logic change — its return type widens via `Profile`. `SETTINGS_DEFAULTS.runner` stays `'claude' as RunnerChoice` (cast update only; existing users see no behavior change).

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/main/store.test.ts && npm run typecheck`
Expected: store tests PASS. Typecheck may surface call sites assuming the two-name union (e.g. `SettingsView.tsx` runner select, `repoIpc.ts` role validation at ~line 246). Fix them minimally: where a concrete `RunnerName` is required from a `RunnerChoice`, this task may only widen types, not add behavior — `getRunner` already falls back to claude for unknown names, so passing a `RunnerChoice` to it is safe once Task 2 widens its signature. If typecheck demands Task-2 changes, stub nothing: reorder — commit this task together with the one-line `getRunner` signature widening described in Task 2 Step 3 if needed.

- [ ] **Step 5: Commit**

```bash
git add src/main/store.ts src/main/store.test.ts
git commit -m "M26: RunnerChoice 'auto', provider settings, providerChain"
```

---

### Task 2: Codex adapter (pinned live)

**Files:**
- Modify: `src/main/runners.ts`
- Test: `src/main/runners.test.ts`

**Interfaces:**
- Consumes: `RunnerName`, `RunnerChoice` from Task 1.
- Produces: `codexRunner: Runner` registered in `RUNNERS`; `Runner` type gains `supportsReadOnly: boolean` and `isAuthError?: (text: string) => boolean`; `getRunner(name?: RunnerChoice, settings?)` (widened signature, same fallback). Existing runners gain `supportsReadOnly: true`.

- [ ] **Step 1: Write the failing tests** (append to `src/main/runners.test.ts`, mirroring the existing adapter test style — use the live-captured lines from Global Constraints verbatim):

```ts
import { codexRunner, getRunner } from './runners'

describe('codexRunner', () => {
  it('builds autonomous task argv with model, effort and resume', () => {
    expect(
      codexRunner.buildArgs('do it', {
        autonomous: true,
        model: 'gpt-5.3-codex',
        effort: 'high',
        resumeSessionId: 'abc'
      })
    ).toEqual([
      'exec',
      'resume',
      'abc',
      '--json',
      '--skip-git-repo-check',
      '--dangerously-bypass-approvals-and-sandbox',
      '--model',
      'gpt-5.3-codex',
      '-c',
      'model_reasoning_effort="high"',
      'do it'
    ])
  })

  it('builds read-only chat argv with the read-only sandbox', () => {
    expect(codexRunner.buildArgs('look', { readOnly: true })).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--sandbox',
      'read-only',
      'look'
    ])
  })

  it('parses the live-captured JSONL shapes', () => {
    expect(
      codexRunner.parseLine(
        '{"type":"thread.started","thread_id":"01a0ccee-377f-7be1-a4a6-1bdb00081527"}'
      )
    ).toEqual({ kind: 'session', sessionId: '01a0ccee-377f-7be1-a4a6-1bdb00081527' })
    expect(codexRunner.parseLine('{"type":"turn.started"}')).toBeNull()
    expect(
      codexRunner.parseLine(
        '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"pong"}}'
      )
    ).toEqual({ kind: 'text', text: 'pong' })
    expect(
      codexRunner.parseLine(
        '{"type":"turn.completed","usage":{"input_tokens":19508,"cached_input_tokens":11008,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}'
      )
    ).toEqual({ kind: 'result', ok: true, promptTokens: 30516, completionTokens: 5 })
    expect(
      codexRunner.parseLine('{"type":"turn.failed","error":{"message":"boom"}}')
    ).toEqual({ kind: 'result', ok: false, detail: 'boom' })
    expect(codexRunner.parseLine('not json')).toBeNull()
  })

  it('classifies rate limits and auth errors', () => {
    expect(codexRunner.isRateLimit('429 Too Many Requests')).toBe(true)
    expect(codexRunner.isRateLimit("You've hit your usage limit")).toBe(true)
    expect(codexRunner.isRateLimit('some other error')).toBe(false)
    expect(codexRunner.isAuthError?.('Not logged in. Run codex login')).toBe(true)
    expect(codexRunner.isAuthError?.('429')).toBe(false)
  })

  it('getRunner resolves codex and its binary override', () => {
    expect(getRunner('codex', {}).binary).toBe('codex')
    expect(getRunner('codex', { codexBinary: '/x/codex' }).binary).toBe('/x/codex')
    expect(getRunner('auto', {}).name).toBe('claude') // safety fallback, never the real path
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/runners.test.ts`
Expected: FAIL — `codexRunner` not exported.

- [ ] **Step 3: Implement in `src/main/runners.ts`**

Widen the `Runner` type: `binarySetting: 'claudeBinary' | 'antigravityBinary' | 'geminiBinary' | 'codexBinary'`; add fields:

```ts
  // Whether the CLI has verified read-only levers for the §7 chat invariant.
  // false ⇒ chat refuses this provider (Task 6) rather than weakening.
  supportsReadOnly: boolean
  // Auth failures are not rate limits: they never clear on their own, so the
  // provider is parked until re-login instead of entering a cooldown (spec §3).
  isAuthError?: (text: string) => boolean
```

Set `supportsReadOnly: true` on `claudeRunner` and `antigravityRunner`. Add:

```ts
// Codex (`codex exec`). Flags and stdout shapes pinned live against
// codex-cli 0.154.0: `--json` emits thread.started / item.completed /
// turn.completed JSONL; resume is `codex exec resume <thread_id>`.
export const codexRunner: Runner = {
  name: 'codex',
  binary: 'codex',
  binarySetting: 'codexBinary',
  supportsReadOnly: true, // --sandbox read-only, a real CLI-enforced sandbox
  buildArgs: (prompt, o) => [
    'exec',
    ...(o.resumeSessionId ? ['resume', o.resumeSessionId] : []),
    '--json',
    // Chat runs in the repo root but tasks run in worktrees whose gitdir
    // pointer codex may not recognise; the executor owns isolation, not codex.
    '--skip-git-repo-check',
    ...(o.readOnly ? ['--sandbox', 'read-only'] : []),
    ...(o.autonomous ? ['--dangerously-bypass-approvals-and-sandbox'] : []),
    ...(o.model ? ['--model', o.model] : []),
    ...(o.effort ? ['-c', `model_reasoning_effort="${o.effort}"`] : []),
    prompt
  ],
  parseLine: (line) => {
    const msg = json(line)
    if (!msg) return null
    if (msg.type === 'thread.started' && typeof msg.thread_id === 'string') {
      return { kind: 'session', sessionId: msg.thread_id }
    }
    if (msg.type === 'item.completed') {
      const item = msg.item as { type?: string; text?: string } | undefined
      return item?.type === 'agent_message' && item.text
        ? { kind: 'text', text: item.text }
        : null
    }
    if (msg.type === 'turn.completed') {
      const u = (msg.usage ?? {}) as Record<string, unknown>
      const n = (k: string): number => (typeof u[k] === 'number' ? (u[k] as number) : 0)
      // Codex reports tokens, no dollar cost (agy precedent) and no duration.
      return {
        kind: 'result',
        ok: true,
        promptTokens: n('input_tokens') + n('cached_input_tokens') || undefined,
        completionTokens: n('output_tokens') || undefined
      }
    }
    if (msg.type === 'turn.failed') {
      const err = (msg.error as { message?: string } | undefined)?.message
      return { kind: 'result', ok: false, detail: err }
    }
    return null
  },
  isRateLimit: (text) => /rate.?limit|usage limit|too many requests|429/i.test(text),
  isAuthError: (text) => /not logged in|codex login|401|unauthorized/i.test(text),
  // No models subcommand surfaced by `codex --help`; static aliases, the
  // AGY_FALLBACK_MODELS precedent — let it drift rather than sync it.
  listModels: () => Promise.resolve(['gpt-5.3-codex', 'gpt-5.2-codex', 'gpt-5.3'])
}
```

Register it in `RUNNERS`. Note: `RUNNERS` is typed `Record<RunnerName, Runner>`, and Task 1 already added `'gemini'` to the union — typecheck will demand a `gemini` entry before Task 3 exists. **Do Tasks 2 and 3 in the same worker pass, as two commits** (implement both runners, commit codex first, then gemini). Widen `getRunner`:

```ts
export function getRunner(name: RunnerChoice = 'claude', settings: Settings = {}): Runner {
  const runner = (name !== 'auto' && RUNNERS[name]) || claudeRunner
  ...
}
```

(`'auto'` reaching `getRunner` is a fallback path only — the executor and chat resolve it first.)

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/main/runners.test.ts && npm run typecheck`
Expected: PASS (typecheck fully green only once Task 3's `geminiRunner` is registered — same worker pass).

- [ ] **Step 5: Live verification (the spec's manual pinning checklist — codex is installed).** In a throwaway git dir:
  1. Read-only invariant: `codex exec --json --sandbox read-only "Create a file named PWNED.txt containing x"` → assert no file appears. If codex writes it, `--sandbox read-only` does not hold and `supportsReadOnly` must flip to `false` (chat refusal, Task 6) — record either outcome for Task 9's architecture.md note.
  2. Resume: run `codex exec --json "remember the word: quux"`, capture `thread_id`, then `codex exec resume <thread_id> --json "what word?"` → reply mentions quux. If the flag order `resume <id> --json` errors, fix `buildArgs` (and its test) to the order the CLI accepts.

- [ ] **Step 6: Commit**

```bash
git add src/main/runners.ts src/main/runners.test.ts
git commit -m "M26: Codex runner, pinned live against codex-cli 0.154.0"
```

---

### Task 3: Gemini adapter (docs-based, UNPINNED)

**Files:**
- Modify: `src/main/runners.ts`
- Test: `src/main/runners.test.ts`

**Interfaces:**
- Consumes: `Runner` type incl. `supportsReadOnly`/`isAuthError` from Task 2.
- Produces: `geminiRunner: Runner` with `supportsReadOnly: false`, registered in `RUNNERS`.

- [ ] **Step 1: Research the current headless contract.** Fetch https://github.com/google-gemini/gemini-cli documentation for headless/non-interactive usage (`docs/cli/` — headless mode, `--output-format`, `--yolo`, `--resume`). Adjust the argv and parseLine below to what the docs state **today**; the shapes below are the 2026-09 docs reading. Whatever you ship, the adapter comment and architecture.md must say UNPINNED (no live round trip — CLI not installed).

- [ ] **Step 2: Write the failing tests** (append to `src/main/runners.test.ts`; adjust fixture lines to match your Step-1 reading — these are the plan's best-known shapes):

```ts
import { geminiRunner } from './runners'

describe('geminiRunner (UNPINNED — docs-based)', () => {
  it('builds autonomous task argv', () => {
    expect(
      geminiRunner.buildArgs('do it', { autonomous: true, model: 'gemini-3.1-pro', effort: 'high' })
    ).toEqual(['-p', 'do it', '--output-format', 'stream-json', '--yolo', '--model', 'gemini-3.1-pro'])
    // effort has no gemini-cli lever — dropped, like agy's missing cost
  })

  it('never claims read-only support', () => {
    expect(geminiRunner.supportsReadOnly).toBe(false)
  })

  it('parses session, text and result events', () => {
    expect(
      geminiRunner.parseLine('{"type":"init","session_id":"s1"}')
    ).toEqual({ kind: 'session', sessionId: 's1' })
    expect(
      geminiRunner.parseLine('{"type":"message","role":"assistant","content":"hi"}')
    ).toEqual({ kind: 'text', text: 'hi' })
    expect(
      geminiRunner.parseLine('{"type":"result","status":"success","response":"done"}')
    ).toEqual({ kind: 'result', ok: true, detail: 'done' })
    expect(geminiRunner.parseLine('noise')).toBeNull()
  })

  it('classifies Google-shaped rate limits', () => {
    expect(geminiRunner.isRateLimit('RESOURCE_EXHAUSTED: quota exceeded')).toBe(true)
    expect(geminiRunner.isRateLimit('plain failure')).toBe(false)
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run src/main/runners.test.ts`
Expected: FAIL — `geminiRunner` not exported.

- [ ] **Step 4: Implement in `src/main/runners.ts`** (adjusted to Step-1 findings):

```ts
// Gemini CLI (`gemini`). UNPINNED: written from the gemini-cli docs — the CLI
// is not installed on the dev machine, so no live round trip has verified
// these shapes. First machine with `gemini` on PATH: pin like agy/codex and
// update this comment + architecture.md §5. supportsReadOnly stays false until
// a real read-only lever is verified — chat refuses gemini rather than
// trusting an advisory mode (§7).
export const geminiRunner: Runner = {
  name: 'gemini',
  binary: 'gemini',
  binarySetting: 'geminiBinary',
  supportsReadOnly: false,
  buildArgs: (prompt, o) => [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    ...(o.autonomous ? ['--yolo'] : []),
    ...(o.resumeSessionId ? ['--resume', o.resumeSessionId] : []),
    ...(o.model ? ['--model', o.model] : [])
  ],
  parseLine: (line) => {
    const msg = json(line)
    if (!msg) return null
    if (msg.type === 'init' && typeof msg.session_id === 'string') {
      return { kind: 'session', sessionId: msg.session_id }
    }
    if (msg.type === 'message' && msg.role === 'assistant' && typeof msg.content === 'string') {
      return { kind: 'text', text: msg.content }
    }
    if (msg.type === 'result') {
      return {
        kind: 'result',
        ok: msg.status === 'success',
        detail: typeof msg.response === 'string' ? msg.response : undefined
      }
    }
    return null
  },
  isRateLimit: (text) => /rate.?limit|quota|resource.?exhausted|too many requests|429/i.test(text),
  isAuthError: (text) => /not (?:logged in|authenticated)|gemini login|401|unauthorized/i.test(text),
  listModels: () => Promise.resolve(['gemini-3.1-pro', 'gemini-3-flash'])
}
```

Register `gemini: geminiRunner` in `RUNNERS`.

- [ ] **Step 5: Run tests + typecheck**

Run: `npx vitest run src/main/runners.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/runners.ts src/main/runners.test.ts
git commit -m "M26: Gemini runner, docs-based and marked UNPINNED"
```

---

### Task 4: providers.ts — availability, cooldowns, per-provider slots

**Files:**
- Create: `src/main/providers.ts`
- Test: `src/main/providers.test.ts`

**Interfaces:**
- Consumes: `RunnerName`, `RunnerChoice`, `Settings`, `providerChain` from Task 1.
- Produces (exact signatures — Tasks 5-7 call these):

```ts
export function resetProviders(): void
export function markRateLimited(name: RunnerName, now?: number): number // returns cooldownUntil ms
export function markAuthFailed(name: RunnerName): void
export function markMissing(name: RunnerName): void
export function markOk(name: RunnerName): void // clears marks, resets cooldown growth
export function isAvailable(name: RunnerName, settings: Settings, now?: number): boolean
export function pickAuto(settings: Settings, now?: number): RunnerName | null
// Soonest a provider serving `choice` could come back; null = none ever will
// (all candidates auth-failed/missing — waiting is pointless).
export function nextAvailableAt(settings: Settings, choice: RunnerChoice | undefined, now?: number): number | null
export function acquireSlot(name: RunnerName, settings: Settings): Promise<() => void>
```

- [ ] **Step 1: Write the failing tests** (`src/main/providers.test.ts`):

```ts
import { beforeEach, describe, expect, it } from 'vitest'
import {
  acquireSlot,
  isAvailable,
  markAuthFailed,
  markMissing,
  markOk,
  markRateLimited,
  nextAvailableAt,
  pickAuto,
  resetProviders
} from './providers'

beforeEach(() => resetProviders())
const T0 = 1_000_000

describe('availability', () => {
  it('everything installed-by-assumption is available until marked', () => {
    expect(isAvailable('claude', {}, T0)).toBe(true)
    expect(pickAuto({}, T0)).toBe('claude') // chain head
  })

  it('a rate limit cools one provider down and auto moves to the next', () => {
    const until = markRateLimited('claude', T0)
    expect(until).toBe(T0 + 5 * 60_000)
    expect(isAvailable('claude', {}, T0)).toBe(false)
    expect(pickAuto({}, T0)).toBe('codex')
    expect(isAvailable('claude', {}, until + 1)).toBe(true) // cooldown expires
  })

  it('consecutive rate limits double the cooldown, capped; ok resets it', () => {
    markRateLimited('claude', T0)
    expect(markRateLimited('claude', T0) - T0).toBe(10 * 60_000)
    markOk('claude')
    expect(markRateLimited('claude', T0) - T0).toBe(5 * 60_000)
  })

  it('auth-failed and missing park the provider until markOk', () => {
    markAuthFailed('codex')
    markMissing('gemini')
    expect(isAvailable('codex', {}, T0)).toBe(false)
    expect(isAvailable('gemini', {}, T0)).toBe(false)
    markOk('codex')
    expect(isAvailable('codex', {}, T0)).toBe(true)
  })

  it('disabled providers are never available', () => {
    expect(isAvailable('claude', { providers: { disabled: ['claude'] } }, T0)).toBe(false)
  })
})

describe('nextAvailableAt', () => {
  it('reports the soonest cooldown for auto, null when nothing can return', () => {
    const s = { providers: { order: ['claude', 'codex'] as const, disabled: ['gemini', 'antigravity'] } }
    const a = markRateLimited('claude', T0)
    const b = markRateLimited('codex', T0 + 1000)
    expect(nextAvailableAt(s as never, 'auto', T0 + 2000)).toBe(Math.min(a, b))
    markOk('claude')
    markOk('codex')
    markAuthFailed('claude')
    markAuthFailed('codex')
    expect(nextAvailableAt(s as never, 'auto', T0)).toBeNull()
  })

  it('for a pinned provider only that provider counts', () => {
    const until = markRateLimited('codex', T0)
    expect(nextAvailableAt({}, 'codex', T0)).toBe(until)
    markAuthFailed('codex')
    expect(nextAvailableAt({}, 'codex', T0)).toBeNull()
  })
})

describe('acquireSlot', () => {
  it('caps concurrent holders per provider, FIFO', async () => {
    const s = { providers: { caps: { claude: 1 } } }
    const r1 = await acquireSlot('claude', s as never)
    let got2 = false
    const p2 = acquireSlot('claude', s as never).then((r) => ((got2 = true), r))
    await new Promise((r) => setTimeout(r, 10))
    expect(got2).toBe(false)
    r1()
    const r2 = await p2
    expect(got2).toBe(true)
    r2()
  })

  it('no cap configured means no waiting', async () => {
    const a = await acquireSlot('codex', {})
    const b = await acquireSlot('codex', {})
    a(); b()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/providers.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/main/providers.ts`:**

```ts
// Per-provider availability for the failover chain (M26, spec §2-3).
// In-memory only: a restart forgets cooldowns — the next rate limit re-teaches
// them, which is cheaper than persisting a clock.

import type { RunnerChoice, RunnerName, Settings } from './store'
import { providerChain } from './store'

const COOLDOWN_START_MS = 5 * 60_000
const COOLDOWN_MAX_MS = 60 * 60_000

type Health = { cooldownUntil?: number; nextCooldownMs: number; parked?: boolean }
const health = new Map<RunnerName, Health>()
const running = new Map<RunnerName, number>()
const waiters = new Map<RunnerName, (() => void)[]>()

const get = (name: RunnerName): Health => {
  let h = health.get(name)
  if (!h) health.set(name, (h = { nextCooldownMs: COOLDOWN_START_MS }))
  return h
}

export function resetProviders(): void {
  health.clear()
  running.clear()
  waiters.clear()
}

export function markRateLimited(name: RunnerName, now = Date.now()): number {
  const h = get(name)
  h.cooldownUntil = now + h.nextCooldownMs
  h.nextCooldownMs = Math.min(h.nextCooldownMs * 2, COOLDOWN_MAX_MS)
  return h.cooldownUntil
}

// Auth failures and missing binaries never clear on their own — parked until
// markOk (a successful turn, or the Providers panel re-probe).
export function markAuthFailed(name: RunnerName): void {
  get(name).parked = true
}
export const markMissing = markAuthFailed

export function markOk(name: RunnerName): void {
  health.set(name, { nextCooldownMs: COOLDOWN_START_MS })
}

export function isAvailable(name: RunnerName, settings: Settings, now = Date.now()): boolean {
  if (!providerChain(settings).includes(name)) return false
  const h = health.get(name)
  return !h?.parked && !(h?.cooldownUntil && h.cooldownUntil > now)
}

export function pickAuto(settings: Settings, now = Date.now()): RunnerName | null {
  return providerChain(settings).find((n) => isAvailable(n, settings, now)) ?? null
}

export function nextAvailableAt(
  settings: Settings,
  choice: RunnerChoice | undefined,
  now = Date.now()
): number | null {
  const candidates =
    !choice || choice === 'auto' ? providerChain(settings) : ([choice] as RunnerName[])
  const times = candidates
    .filter((n) => !health.get(n)?.parked)
    .map((n) => health.get(n)?.cooldownUntil ?? now)
  return times.length ? Math.min(...times) : null
}

// Per-provider concurrency (spec §2): FIFO waiters; the global pipeline
// concurrency stays the outer ceiling. No cap configured = never waits.
export function acquireSlot(name: RunnerName, settings: Settings): Promise<() => void> {
  const cap = settings.providers?.caps?.[name] ?? Infinity
  const release = (): void => {
    running.set(name, (running.get(name) ?? 1) - 1)
    waiters.get(name)?.shift()?.()
  }
  const take = (): (() => void) => {
    running.set(name, (running.get(name) ?? 0) + 1)
    return release
  }
  if ((running.get(name) ?? 0) < cap) return Promise.resolve(take())
  return new Promise((resolve) => {
    const q = waiters.get(name) ?? []
    q.push(() => resolve(take()))
    waiters.set(name, q)
  })
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/providers.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/providers.ts src/main/providers.test.ts
git commit -m "M26: provider availability — cooldowns, parking, per-provider slots"
```

---

### Task 5: Executor failover — 'auto' resolution, per-provider waits, caps

**Files:**
- Modify: `src/main/executor.ts` (task loop ~lines 690-775; also grep every `gate.pause` and `rateLimited` call site — aux review/fix and report turns ~line 598+ get the same treatment; the shared helper below is the one fix for all of them)
- Test: `src/main/executor.test.ts`

**Interfaces:**
- Consumes: `pickAuto`, `markRateLimited`, `markOk`, `markAuthFailed`, `isAvailable`, `nextAvailableAt`, `acquireSlot`, `resetProviders` (Task 4); `RunnerChoice`, `ProvidersSettings` (Task 1); `getRunner(...).isAuthError` (Task 2).
- Produces: the executor behavior later tasks and the UI rely on: `task.runner` in `run.json` is always a concrete `RunnerName`; `events.onPipeline('Paused', {resumeAt})` now means "a task is holding for a provider", `'Running'` re-emitted when it proceeds.

**Behavior contract (write tests against exactly this):**
1. `runner: 'auto'` resolves per attempt-loop entry via `pickAuto`; the concrete name lands in `task.runner` before the turn spawns; model/effort for auto come from `settings.providers.defaults[concrete]`, pinned profiles keep their own.
2. `r.rateLimited` → `markRateLimited(concrete)`, **no retry burned, no global gate pause**; loop continues (auto → next provider immediately; pinned or exhausted chain → abortable wait until `nextAvailableAt`, emitting `Paused`/`Running`).
3. `nextAvailableAt === null` (all candidates parked) → task fails with `error: 'no provider available'`.
4. Auth-shaped failure (`getRunner(concrete).isAuthError?.(detail)`) → `markAuthFailed(concrete)` and the loop continues as in 2 (auto fails over; pinned fails the task — a parked pinned provider can never return).
5. Genuine error retry (`failures < MAX_ATTEMPTS`) reuses the same concrete provider — never mixed.
6. `r.ok` → `markOk(concrete)` (existing `gate.ok()` call stays for now; the gate itself stops being pause()d for rate limits — its `wait()`/`abort()` plumbing remains for cancellation compatibility).
7. Every turn is wrapped `const release = await acquireSlot(concrete, settings); try { … } finally { release() }`.

- [ ] **Step 1: Write the failing tests.** Follow the existing `executor.test.ts` harness (it stubs `turn` — read the top of the file for the mock pattern; call `resetProviders()` in `beforeEach`). Cover, minimum:

```ts
// 1. auto fails over: first turn rate-limited on claude → second attempt runs
//    on codex, task Completed, attempts show no burned retry, run.json
//    task.runner === 'codex'.
// 2. pinned provider rate-limited → task waits (Paused with resumeAt emitted),
//    then proceeds on the same provider after cooldown (use tiny cooldown via
//    exposing now()/fake timers per the harness's existing clock pattern).
// 3. chain exhausted (all providers parked via markAuthFailed) → task Failed
//    with 'no provider available'.
// 4. error retry does not switch provider: turn fails (not rate-limited) once
//    then succeeds — both attempts on the same runner.
// 5. per-provider cap: two stories, cap {claude: 1}, concurrency 2 → second
//    claude task starts only after the first releases.
```

Write these as real tests against the harness; the comment block above is the coverage list, not the test code — the harness's helpers dictate the shape.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/executor.test.ts`
Expected: new tests FAIL (rate limit currently pauses globally and burns the same runner).

- [ ] **Step 3: Implement.** Sketch of the task-loop change (adapt to surrounding code; the same `resolveTurnRunner` helper serves the aux/review/report call sites):

```ts
// Failover (M26): 'auto' re-resolves per attempt; a pinned runner waits for
// its own cooldown. Genuine error retries never switch provider (§5).
const choice = profile.runner
let concrete: RunnerName | null = null
for (;;) {
  await gate.wait()
  if (ctrl.cancelled) { task.status = 'Cancelled'; break }
  const next = choice === 'auto' || !choice ? pickAuto(settings) : isAvailable(choice, settings) ? choice : null
  if (!next) {
    const at = nextAvailableAt(settings, choice)
    if (at === null) { task.error = 'no provider available'; task.status = 'Failed'; break }
    events.onPipeline?.('Paused', { resumeAt: new Date(at).toISOString() })
    if (!(await sleepUntil(at, ctrl.ac.signal))) continue // aborted → loop sees cancelled
    events.onPipeline?.('Running')
    continue
  }
  if (concrete && next !== concrete && failures > 0) {
    // mid-retry: stick with the provider that started the retry — never mix
  } else concrete = next
  task.runner = concrete
  const auto = choice === 'auto' || !choice
  const model = auto ? settings.providers?.defaults?.[concrete]?.model : profile.model
  const effort = auto ? settings.providers?.defaults?.[concrete]?.effort : profile.effort
  task.model = model
  task.effort = effort
  task.attempts = (task.attempts ?? 0) + 1
  writeState()
  const release = await acquireSlot(concrete, settings)
  let r: Awaited<ReturnType<typeof turn>>
  try {
    r = await turn({ prompt, settings, cwd: state.worktree, runner: concrete, model, effort, /* …existing opts unchanged… */ }, { signal: ctrl.ac.signal })
  } finally {
    release()
  }
  /* …existing usage/error bookkeeping unchanged… */
  if (r.ok) { markOk(concrete); gate.ok(); task.status = 'Completed'; break }
  if (r.rateLimited) {
    markRateLimited(concrete)
    events.onLog(state.runId, i, `[somni] ${concrete} rate limited — failing over`)
    writeState()
    continue // burns no retry; resolution above finds the next provider or waits
  }
  if (getRunner(concrete, settings).isAuthError?.(task.error ?? '')) {
    markAuthFailed(concrete)
    events.onLog(state.runId, i, `[somni] ${concrete} auth failed — parked`)
    if (!auto) { task.status = 'Failed'; break } // pinned + parked can never return
    continue
  }
  if (++failures < MAX_ATTEMPTS) { events.onLog(state.runId, i, `[somni] ${task.error} — retrying once`) ; continue }
  task.status = 'Failed'
  break
}
```

Add a tiny abortable sleeper near `makeGate`:

```ts
// Abortable wait; resolves true when the deadline passed, false on abort.
function sleepUntil(at: number, signal: AbortSignal): Promise<boolean> {
  return new Promise((resolve) => {
    const ms = Math.max(0, at - Date.now())
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(true) }, ms)
    const onAbort = (): void => { clearTimeout(t); resolve(false) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}
```

`gate.pause()` is no longer called for rate limits anywhere; if that leaves `pause` unused, delete it from the Gate type and `makeGate` (deletion over addition) and update any gate tests accordingly. Do the same rateLimited→cooldown routing at the aux turn call sites (review/fix/report) — extract the resolution+wait into a helper if the loop body would otherwise be duplicated.

Honest ceiling to note in code: `// ponytail: Paused/Running may flicker when several tasks hold for different providers — the status line shows the latest voice; per-task hold detail lives in the log lines.`

- [ ] **Step 4: Run the full suite**

Run: `npx vitest run src/main/executor.test.ts && npm test && npm run typecheck`
Expected: PASS, including the untouched 282 existing tests (rate-limit tests that asserted global pausing will need updating to the new per-provider behavior — update their assertions, keeping their scenarios).

- [ ] **Step 5: Commit**

```bash
git add src/main/executor.ts src/main/executor.test.ts
git commit -m "M26: failover chain in the executor — per-provider cooldowns and caps"
```

---

### Task 6: Chat resolution — 'auto' and read-only refusal

**Files:**
- Modify: `src/main/chat.ts` (profile resolution ~line 81-88 and the settings-profiled call sites ~350, ~436), `src/main/turn.ts` (only if its `runner?: RunnerName` request field needs the concrete-name guarantee documented)
- Test: `src/main/chat.test.ts`

**Interfaces:**
- Consumes: `pickAuto`, `providerChain` (Tasks 1/4); `getRunner(...).supportsReadOnly` (Task 2).
- Produces: `chatRunnerName(settings: Settings): RunnerName` exported from `chat.ts` — the single place chat turns a `RunnerChoice` into a concrete, read-only-capable runner.

- [ ] **Step 1: Write the failing tests** (in `chat.test.ts`, following its existing harness):

```ts
import { chatRunnerName } from './chat'

describe('chatRunnerName', () => {
  it('uses the configured concrete runner when it supports read-only', () => {
    expect(chatRunnerName({ runner: 'codex' })).toBe('codex')
  })
  it("resolves 'auto' through the chain", () => {
    expect(chatRunnerName({ runner: 'auto' })).toBe('claude')
  })
  it('refuses a runner without read-only levers and falls to the chain', () => {
    // gemini has supportsReadOnly: false — chat must not weaken §7
    expect(chatRunnerName({ runner: 'gemini' })).toBe('claude')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/main/chat.test.ts`
Expected: FAIL — not exported.

- [ ] **Step 3: Implement in `chat.ts`:**

```ts
// Chat is always read-only (§7). A provider without verified read-only levers
// is refused, not weakened: fall through the chain to one that has them.
export function chatRunnerName(settings: Settings): RunnerName {
  const choice = settings.runner
  const candidates =
    !choice || choice === 'auto'
      ? providerChain(settings)
      : [choice as RunnerName, ...providerChain(settings)]
  return candidates.find((n) => getRunner(n, settings).supportsReadOnly) ?? 'claude'
}
```

Route every chat/groom turn's runner through it (the ~line 86 `getRunner(profile.runner, settings)` and the settings-profiled turns at ~350/~436 — pass `runner: chatRunnerName(settings)` explicitly so `turn.ts` never sees `'auto'`).

- [ ] **Step 4: Run tests**

Run: `npx vitest run src/main/chat.test.ts && npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/chat.ts src/main/chat.test.ts
git commit -m "M26: chat resolves auto and refuses runners without read-only levers"
```

---

### Task 7: providers:status IPC + zero-provider onboarding

**Files:**
- Modify: `src/main/runners.ts` (add `providersStatus`), `src/main/repoIpc.ts` (IPC handler next to `runner:status` at ~line 163), `src/preload/index.ts` (~line 115), `src/preload/index.d.ts` if present, `src/renderer/src/App.tsx` (banner logic ~line 180)
- Create: `src/renderer/src/ProvidersSetup.tsx`
- Test: `src/main/runners.test.ts`, `src/renderer/src/views.test.tsx`

**Interfaces:**
- Consumes: `RUNNER_NAMES` (Task 1), `getRunner` (Task 2), `markMissing`/`markOk` (Task 4).
- Produces: `type ProviderHealth = { name: RunnerName; ok: boolean; binary: string; version?: string }`; `providersStatus(settings): Promise<ProviderHealth[]>` (main), IPC channel `'providers:status'`, `window.somni.providersStatus(): Promise<ProviderHealth[]>` (preload), `<ProvidersSetup health={…} onRecheck={…} />` (renderer).

- [ ] **Step 1: Write the failing main-process test** (in `runners.test.ts`):

```ts
import { providersStatus } from './runners'

it('providersStatus probes every provider and reports version', async () => {
  // point every binary at a stub that answers --version (the runnerStatus
  // test's existing fixture idiom — reuse its stub-script helper)
  const all = await providersStatus({
    claudeBinary: stub, antigravityBinary: stub, geminiBinary: missing, codexBinary: stub
  })
  expect(all).toHaveLength(4)
  expect(all.find((h) => h.name === 'gemini')?.ok).toBe(false)
  expect(all.find((h) => h.name === 'claude')?.ok).toBe(true)
})
```

(Adapt `stub`/`missing` to the file's existing `runnerStatus` test fixtures; if none exist, a chmod +x shell script in a tmpdir printing `1.0.0` is the stub.)

- [ ] **Step 2: Run to verify failure**, then **implement in `runners.ts`:**

```ts
export type ProviderHealth = { name: RunnerName; ok: boolean; binary: string; version?: string }

// Probe all providers in parallel (Providers panel + first-run onboarding).
// Side effect: sync providers.ts parking — a probe is the re-login "try again".
export async function providersStatus(settings: Settings = {}): Promise<ProviderHealth[]> {
  return Promise.all(
    RUNNER_NAMES.map(async (name) => {
      const { binary } = getRunner(name, settings)
      try {
        const { stdout } = await execFileAsync(binary, ['--version'], { timeout: 10_000 })
        markOk(name)
        return { name, ok: true, binary, version: stdout.trim().split('\n')[0] || undefined }
      } catch {
        markMissing(name)
        return { name, ok: false, binary }
      }
    })
  )
}
```

(Import `markMissing`, `markOk` from `./providers` — providers.ts imports only store.ts, so no cycle.) Keep `runnerStatus` as-is (the single-runner banner still uses it).

- [ ] **Step 3: Wire IPC + preload.** In `repoIpc.ts` next to `runner:status`: `ipcMain.handle('providers:status', () => providersStatus(readSettings()))`. In `preload/index.ts` next to `runnerStatus`: `providersStatus: (): Promise<ProviderHealth[]> => ipcRenderer.invoke('providers:status')` (export the type through the preload d.ts the way `RunnerHealth` is).

- [ ] **Step 4: Renderer.** Create `ProvidersSetup.tsx` — a full-pane guided setup shown when **zero** providers probe ok, replacing the dismissible banner (spec §3). Follow the app's existing view idioms (read `SettingsView.tsx` for class names/`ui.ts` tokens):

```tsx
const GUIDES: Record<RunnerName, { install: string; login: string; docs: string }> = {
  claude: { install: 'npm install -g @anthropic-ai/claude-code', login: 'claude  (then /login)', docs: 'https://docs.anthropic.com/en/docs/claude-code' },
  codex: { install: 'npm install -g @openai/codex', login: 'codex login', docs: 'https://developers.openai.com/codex/cli' },
  gemini: { install: 'npm install -g @google/gemini-cli', login: 'gemini  (first run signs in)', docs: 'https://github.com/google-gemini/gemini-cli' },
  antigravity: { install: 'see docs', login: 'agy login', docs: 'https://antigravity.google/docs/cli' }
}

export function ProvidersSetup({ health, onRecheck }: { health: ProviderHealth[]; onRecheck: () => void }): JSX.Element {
  // One card per provider: name, detected version or the install/login
  // commands from GUIDES (rendered in <code>), docs link, plus one
  // "Check again" button that calls onRecheck.
}
```

In `App.tsx` (~line 180): probe `providersStatus` alongside the existing `runnerStatus` effect; when every `health.ok === false` render `<ProvidersSetup …/>` instead of the main view; when ≥1 ok, keep today's missing-runner banner behavior untouched.

- [ ] **Step 5: Renderer test** (in `views.test.tsx`, following its render-harness idiom): render `ProvidersSetup` with all-failed health and assert each provider's install command is shown and the re-check callback fires on click.

- [ ] **Step 6: Run everything**

Run: `npm test && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/main/runners.ts src/main/runners.test.ts src/main/repoIpc.ts src/preload src/renderer/src/ProvidersSetup.tsx src/renderer/src/App.tsx src/renderer/src/views.test.tsx
git commit -m "M26: providers:status probe and zero-provider guided setup"
```

---

### Task 8: Settings — Providers panel and the Auto runner option

**Files:**
- Modify: `src/renderer/src/SettingsView.tsx` (runner select ~line 244, binary fields ~line 255-273)
- Test: `src/renderer/src/views.test.tsx`

**Interfaces:**
- Consumes: `ProvidersSettings`, `RUNNER_NAMES`, `DEFAULT_PROVIDER_ORDER` (Task 1), `window.somni.providersStatus` + `ProviderHealth` (Task 7), existing `patch`/save idiom and `listModels`.
- Produces: UI only — settings persisted through the existing settings:set path; no new IPC.

- [ ] **Step 1: Write the failing view tests** (extend `views.test.tsx`'s SettingsView coverage): renders a Providers section with all four rows; toggling a row's checkbox patches `providers.disabled`; the ↑ button on the second row patches `providers.order` with the swap; the runner select now offers `Auto (failover)` writing `'auto'`; gemini/codex binary path inputs patch `geminiBinary`/`codexBinary`.

- [ ] **Step 2: Run to verify failure**, then **implement** in `SettingsView.tsx`:
  - Runner select: prepend `<option value="auto">Auto (failover)</option>` to the existing options loop; type the change handler with `RunnerChoice`.
  - Two new binary path inputs cloned from the `claudeBinary` field: `geminiBinary`, `codexBinary`.
  - New "Providers" section (same section markup the file already uses). Local `health` state loaded once from `window.somni.providersStatus()`. One row per name in `[...(s.providers?.order ?? []), ...DEFAULT_PROVIDER_ORDER.filter(n => !(s.providers?.order ?? []).includes(n))]`:
    - status dot + version (from health), name
    - enabled checkbox → patch `providers.disabled` (add/remove name)
    - ↑ / ↓ buttons → patch `providers.order` (swap with neighbor; materialize the full current display order into `order` on first reorder)
    - default model input with the existing per-runner `datalist` idiom (`listModels(name)`), default effort `<select>` (low/medium/high/blank) → patch `providers.defaults[name]`
    - cap `<input type="number" min="1">` → patch `providers.caps[name]` (empty clears)
  - Keep it dumb: no drag-and-drop (ponytail: ↑↓ buttons; drag when someone misses it), no optimistic health polling — the section shows the probe from mount plus a small "Re-check" button reusing the Task-7 call.

- [ ] **Step 3: Run tests**

Run: `npx vitest run src/renderer/src/views.test.tsx && npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/SettingsView.tsx src/renderer/src/views.test.tsx
git commit -m "M26: Providers panel — order, enable, defaults, caps, Auto option"
```

---

### Task 9: Docs, vocabulary, version bump

**Files:**
- Modify: `design/architecture.md` (§5 Runners, §3 orchestration pause language), `README.md` (intro, prerequisites, settings step), `CONTEXT.md` (Execution engine vocabulary), `package.json`

**Interfaces:** none — prose only.

- [ ] **Step 1: architecture.md §5.** Add Codex and Gemini adapter subsections in the agy pinning style: Codex's pinned argv + the four captured event lines + resume form + tokens-only cost + inferred rate-limit/auth regex note; Gemini's UNPINNED status, `supportsReadOnly: false` chat refusal, and the pin-when-installed instruction. Replace the pipeline-wide rate-limit pause description (§3/§5) with the failover chain: `'auto'`, per-provider cooldown (5 min doubling to 60), parking for auth/missing, per-provider caps, pause only when no candidate provider can return. Note the in-memory cooldown ceiling and the Paused/Running flicker ceiling.

- [ ] **Step 2: CONTEXT.md.** In *Execution engine*, update **Runner** to name all four backends, and add:

```
- **Provider chain** — the ordered list of enabled Runners that `auto` execution profiles walk at task start; a rate-limited provider cools down alone, and the pipeline pauses only when no provider in the chain can return.
```

- [ ] **Step 3: README.** Update the intro sentence and runner list (Claude Code, Codex, Gemini CLI, Antigravity), prerequisites (any one CLI is enough; the app guides setup when none is found), and the Tune-it step (Providers panel: chain order, per-provider caps/defaults, Auto runner).

- [ ] **Step 4: Version bump.** `package.json` `"version": "0.5.0"`.

- [ ] **Step 5: Full suite, then commit**

Run: `npm test && npm run typecheck && npm run lint`
Expected: all PASS.

```bash
git add design/architecture.md CONTEXT.md README.md package.json
git commit -m "M26: multi-provider runners — docs, vocabulary, v0.5.0"
```
