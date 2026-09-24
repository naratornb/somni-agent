# Branch Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A cross-provider graded verdict (approve / needs-work / reject) on every finished run, one bounded fix round, and a user-triggered Merge for approved branches.

**Architecture:** Pure logic (fence parsing, reviewer selection, diff capping, prompts) lives in a new small `src/main/branchReview.ts`; the executor calls it after the M16 loop lands green, reusing `auxTask`/failover for the fix turn and plain `turn()` for the tool-free review turns. Merge is one `lockedGit` IPC handler. Renderer gets a grade chip + Merge button and a reviewer-profile settings row.

**Tech Stack:** Electron main + React renderer, TypeScript strict, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-branch-review-design.md`

## Global Constraints

- No new npm dependencies; no AI attribution in commits; `npm run typecheck` green before each commit; version bumps to `0.7.0` in the final task only.
- Ponytail discipline binds every task: reuse existing machinery (`auxTask`, `runTurnWithFailover`, `lockedGit`, `providerChain`/`isAvailable`, the M16 fence-parsing idiom), shortest working diff, `// ponytail:` comments on deliberate ceilings, no speculative abstractions.
- Spec invariants: M16's in-run Review/Fix loop untouched; `checkCommand` authoritative wherever it runs; Acceptance stays the user's act and is orthogonal to merging; no forced git ops (refuse dirty, abort on conflict, never rebase/force); review turns carry NEITHER `readOnly` NOR `autonomous` flags (tool-free by prompt design — that is what makes every provider eligible); `ungraded` never blocks a finished run; one fix round maximum; reject skips the fix round.
- Known flake: a stale `.claude/worktrees/research-grooming-sessions` checkout duplicates voice.test.ts — do NOT delete it; if the full suite shows exactly that file failing, note it and move on.

---

### Task 1: branchReview.ts — types, parsing, selection, prompts, diff cap

**Files:**
- Create: `src/main/branchReview.ts`
- Modify: `src/main/store.ts` (Settings gains `reviewer?: Profile`)
- Test: `src/main/branchReview.test.ts`

**Interfaces:**
- Consumes: `Profile`, `RunnerName`, `Settings`, `providerChain` from `./store`; `isAvailable` from `./providers`.
- Produces (exact — Tasks 2-4 rely on these):

```ts
export type BranchGrade = 'approve' | 'needs-work' | 'reject' | 'ungraded'
export type BranchReview = {
  grade: BranchGrade
  reasons: string[]
  findings: string[]
  provider: RunnerName
  sameProvider?: boolean
  diffTruncated?: boolean
  fixRound?: boolean
  merged?: string // ISO timestamp, stamped by the merge IPC
}
export function parseReview(text: string): Pick<BranchReview, 'grade' | 'reasons' | 'findings'>
export function implementerOf(runners: (RunnerName | undefined)[]): RunnerName // majority, tie → first seen
export function pickReviewer(
  settings: Settings,
  implementer: RunnerName
): { runner: RunnerName; model?: string; effort?: Effort; sameProvider: boolean }
export const DIFF_CAP = 150_000 // chars of diff the prompt will carry
export function capDiff(
  stat: string,
  fileDiffs: { file: string; diff: string }[]
): { body: string; truncated: boolean }
export const BRANCH_REVIEW_PROMPT: (spec: string, subtaskPrompts: string[], diffBody: string) => string
export const BRANCH_FIX_PROMPT: (findings: string[]) => string
```

- [ ] **Step 1: Write the failing tests** (`src/main/branchReview.test.ts`):

```ts
import { describe, expect, it } from 'vitest'
import {
  BRANCH_REVIEW_PROMPT,
  capDiff,
  DIFF_CAP,
  implementerOf,
  parseReview,
  pickReviewer
} from './branchReview'
import { markRateLimited, resetProviders } from './providers'
import { beforeEach } from 'vitest'

beforeEach(() => resetProviders())

describe('parseReview', () => {
  it('parses a valid fence, last block wins', () => {
    const text =
      'thinking…\n```somni-review\n{"grade":"reject","reasons":["a"],"findings":[]}\n```\n' +
      'wait\n```somni-review\n{"grade":"approve","reasons":["solid"],"findings":[]}\n```'
    expect(parseReview(text)).toEqual({ grade: 'approve', reasons: ['solid'], findings: [] })
  })
  it('malformed or missing fence grades needs-work with a parse note', () => {
    for (const bad of ['no fence at all', '```somni-review\nnot json\n```',
      '```somni-review\n{"grade":"maybe"}\n```']) {
      const r = parseReview(bad)
      expect(r.grade).toBe('needs-work')
      expect(r.findings.join(' ')).toMatch(/parse|verdict/i)
    }
  })
  it('tolerates missing arrays', () => {
    const r = parseReview('```somni-review\n{"grade":"approve"}\n```')
    expect(r).toEqual({ grade: 'approve', reasons: [], findings: [] })
  })
})

describe('implementerOf', () => {
  it('majority wins, tie goes to first seen, undefined ignored', () => {
    expect(implementerOf(['claude', 'codex', 'codex'])).toBe('codex')
    expect(implementerOf(['claude', 'codex'])).toBe('claude')
    expect(implementerOf([undefined, 'gemini'])).toBe('gemini')
  })
})

describe('pickReviewer', () => {
  it('picks the first available chain provider different from the implementer', () => {
    expect(pickReviewer({}, 'claude')).toEqual({ runner: 'codex', sameProvider: false })
  })
  it('skips unavailable providers', () => {
    markRateLimited('codex')
    expect(pickReviewer({}, 'claude').runner).not.toBe('codex')
  })
  it('falls back to the implementer when nobody else is available', () => {
    const only = { providers: { disabled: ['codex', 'gemini', 'antigravity'] as const } }
    expect(pickReviewer(only as never, 'claude')).toEqual({ runner: 'claude', sameProvider: true })
  })
  it('a reviewer profile pin wins outright', () => {
    expect(
      pickReviewer({ reviewer: { runner: 'gemini', model: 'g', effort: 'low' } }, 'gemini')
    ).toEqual({ runner: 'gemini', model: 'g', effort: 'low', sameProvider: true })
  })
})

describe('capDiff', () => {
  it('keeps whole-file hunks under the cap and flags truncation', () => {
    const small = { file: 'a.ts', diff: 'x'.repeat(100) }
    const huge = { file: 'b.ts', diff: 'y'.repeat(DIFF_CAP) }
    const r = capDiff('2 files changed', [small, huge])
    expect(r.truncated).toBe(true)
    expect(r.body).toContain('x'.repeat(100))
    expect(r.body).not.toContain('yyyy')
    expect(r.body).toContain('b.ts') // the file list still names what was dropped
    const ok = capDiff('1 file changed', [small])
    expect(ok.truncated).toBe(false)
  })
})

describe('BRANCH_REVIEW_PROMPT', () => {
  it('carries spec, subtask prompts, diff, and the fence contract', () => {
    const p = BRANCH_REVIEW_PROMPT('the spec', ['task one'], 'the diff')
    for (const s of ['the spec', 'task one', 'the diff', 'somni-review', '"approve"'])
      expect(p).toContain(s)
    expect(p).toMatch(/do not.*(run|execute|modify)|no tools/i)
  })
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/branchReview.test.ts` — FAIL: module not found.

- [ ] **Step 3: Implement `src/main/branchReview.ts`:**

```ts
// Branch Review (M28, spec §1-3): the pure half — parsing, reviewer selection,
// diff capping, prompts. The executor owns the turns; the merge IPC owns git.

import type { Effort, Profile, RunnerName, Settings } from './store'
import { providerChain, RUNNER_NAMES } from './store'
import { isAvailable } from './providers'

export type BranchGrade = 'approve' | 'needs-work' | 'reject' | 'ungraded'
export type BranchReview = {
  grade: BranchGrade
  reasons: string[]
  findings: string[]
  provider: RunnerName
  sameProvider?: boolean
  diffTruncated?: boolean
  fixRound?: boolean
  merged?: string
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []

// Last ```somni-review block (the somni-verdict idiom). Malformed is
// needs-work, never a crash — the §10 "malformed is red" precedent.
export function parseReview(text: string): Pick<BranchReview, 'grade' | 'reasons' | 'findings'> {
  const blocks = [...text.matchAll(/```somni-review[^\n]*\n([\s\S]*?)\n```/g)]
  const last = blocks[blocks.length - 1]
  try {
    const raw = JSON.parse(last![1]) as Record<string, unknown>
    if (raw.grade !== 'approve' && raw.grade !== 'needs-work' && raw.grade !== 'reject')
      throw new Error('bad grade')
    return { grade: raw.grade, reasons: strings(raw.reasons), findings: strings(raw.findings) }
  } catch {
    return {
      grade: 'needs-work',
      reasons: ['the review reply carried no parseable somni-review verdict'],
      findings: ['Re-review: the previous reply had no parseable somni-review block.']
    }
  }
}

// The provider that "wrote" the story: majority across subtask runners,
// ties to first seen (spec §2).
export function implementerOf(runners: (RunnerName | undefined)[]): RunnerName {
  const counts = new Map<RunnerName, number>()
  for (const r of runners) if (r) counts.set(r, (counts.get(r) ?? 0) + 1)
  let best: RunnerName = 'claude'
  let n = 0
  for (const r of runners) {
    if (!r) continue
    const c = counts.get(r) ?? 0
    if (c > n) ((best = r), (n = c))
  }
  return best
}

// Cross-provider by default; a pinned reviewer wins outright; nobody-else
// available falls back honestly (spec §2).
export function pickReviewer(
  settings: Settings,
  implementer: RunnerName
): { runner: RunnerName; model?: string; effort?: Effort; sameProvider: boolean } {
  const pin = settings.reviewer
  if (pin?.runner && RUNNER_NAMES.includes(pin.runner as RunnerName)) {
    const runner = pin.runner as RunnerName
    return { runner, model: pin.model, effort: pin.effort, sameProvider: runner === implementer }
  }
  const other = providerChain(settings).find((n) => n !== implementer && isAvailable(n, settings))
  return other ? { runner: other, sameProvider: false } : { runner: implementer, sameProvider: true }
}

export const DIFF_CAP = 150_000

// Whole-file hunks until the cap; the stat + file list always survive, so a
// truncated review still knows what it did not see (spec §1).
export function capDiff(
  stat: string,
  fileDiffs: { file: string; diff: string }[]
): { body: string; truncated: boolean } {
  const parts: string[] = [stat, '']
  let used = 0
  let truncated = false
  for (const f of fileDiffs) {
    if (used + f.diff.length > DIFF_CAP) {
      truncated = true
      parts.push(`[diff for ${f.file} omitted — over the size cap]`)
      continue
    }
    used += f.diff.length
    parts.push(f.diff)
  }
  return { body: parts.join('\n'), truncated }
}

export const BRANCH_REVIEW_PROMPT = (
  spec: string,
  subtaskPrompts: string[],
  diffBody: string
): string =>
  [
    'You are the merge reviewer for an unattended coding run. Everything you need',
    'is in this message — do not run commands, modify files, or use tools.',
    '',
    'The Story spec:',
    spec,
    '',
    'The subtasks that were executed:',
    ...subtaskPrompts.map((p, i) => `${i + 1}. ${p}`),
    '',
    'The full branch diff:',
    diffBody,
    '',
    'Grade whether a careful human should merge this branch:',
    '- "approve": merge as-is.',
    '- "needs-work": right direction, concrete fixable problems (list them in findings).',
    '- "reject": fundamentally wrong or unsafe — a patch will not save it.',
    'End your reply with exactly one fenced block, and nothing after it:',
    '',
    '```somni-review',
    '{"grade": "approve", "reasons": ["…"], "findings": ["…"]}',
    '```',
    '',
    '`reasons` is the short human-facing why; `findings` are the concrete items a',
    'fix pass would act on (empty for approve). Do not be generous.'
  ].join('\n')

export const BRANCH_FIX_PROMPT = (findings: string[]): string =>
  [
    'The merge review of this worktree came back needs-work. Fix these findings, and only these:',
    '',
    ...findings.map((f) => `- ${f}`),
    '',
    'Commit your fixes in this worktree. Do not expand scope.'
  ].join('\n')
```

In `store.ts`, add to `Settings`: `reviewer?: Profile` with a one-line comment (`// Branch Review (M28): who grades finished branches; empty = cross-provider default.`).

- [ ] **Step 4: Run tests + typecheck** — `npx vitest run src/main/branchReview.test.ts && npm run typecheck` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/branchReview.ts src/main/branchReview.test.ts src/main/store.ts
git commit -m "M28: branch review core — verdict parsing, reviewer selection, diff cap"
```

---

### Task 2: Executor integration — the review stage, fix round, routing

**Files:**
- Modify: `src/main/executor.ts` (after the `reviewLoop` call ~line 748-760; `RunState` type gains `review?: BranchReview`)
- Test: `src/main/executor.test.ts`

**Interfaces:**
- Consumes: everything Task 1 produced; existing `auxTask`, `runCheckCommand`, `runTurnWithFailover`/`turn` plumbing, `state.baseSha`, `lockedGit`.
- Produces: `RunState.review?: BranchReview` persisted in run.json; the run's item routes **Review** on `approve`/`ungraded`, **Needs Attention** on final `needs-work`/`reject` (reuse the exact mechanism the M16 `reviewGreen=false` path uses — find it, do not invent a parallel one).

**Behavior contract (tests pin exactly this):**
1. Branch review runs only when the M16 loop landed green and the run wasn't cancelled.
2. The diff comes from `git -C <worktree> diff <baseSha>` split per file + `git -C <worktree> diff --stat <baseSha>` (plain `execFile` git reads — the mutex is for mutations; follow `headSha`'s existing non-locked idiom). Per-file splitting: split the raw diff on `/^diff --git /m` boundaries; each piece's file name comes from its first line.
3. The review turn: `turn()` with the reviewer's `{runner, model, effort}` from `pickReviewer(settings, implementerOf(subtask runners))`, cwd = worktree, NEITHER `readOnly` NOR `autonomous`, prompt = `BRANCH_REVIEW_PROMPT(spec, subtaskPrompts, capDiff(...).body)`. Recorded as an aux TaskRun titled `Branch review` (log `branch-review.log`) via the existing `auxTask` shape — if `auxTask`'s fixed profile resolution can't express the reviewer pin, extend it with an optional profile override rather than cloning it.
4. Turn ran + reply parsed → grade per `parseReview`. Turn failed to run/no reply → `grade: 'ungraded'` with the failure reason in `reasons`; run lands Review; no fix round.
5. `reject` on first review → park immediately (no fix round). `needs-work` → ONE fix round: `auxTask('Address merge review', BRANCH_FIX_PROMPT(findings), 'branch-fix.log')` on the IMPLEMENTER provider (autonomous, in-worktree — the M16 fix idiom), then `runCheckCommand` (fail = fix round failed → park with original findings), then one re-review by the SAME reviewer provider over a recomputed diff; the re-review's grade is final. A fix turn that fails to run at all (auxTask returns null) also parks with the ORIGINAL findings and a "fix round did not complete" note — it must not take the whole-run-failed path (spec §6). `fixRound: true` recorded whenever the round was attempted.
6. `state.review = { grade, reasons, findings, provider, sameProvider?, diffTruncated?, fixRound? }` written before routing; `'approve'`/`'ungraded'` → the run completes exactly as today's green path; final `needs-work`/`reject` → exactly today's `reviewGreen=false` (needs-attention) path.
7. Cancellation mid-branch-review behaves like cancellation anywhere: statuses land Cancelled, no grade invented.

- [ ] **Step 1: Write the failing tests.** Follow executor.test.ts's harness (real fake binaries on PATH emitting scripted stdout; `resetProviders()` in beforeEach). The fake reviewer binary emits a scripted `somni-review` fence. Cover: approve → run Completed + review recorded with cross-provider runner asserted from the fake binary's argv log; needs-work → fix turn runs (assert its prompt contains the findings) → re-review → approve → Completed with `fixRound: true`; needs-work → fix → re-review needs-work → run lands the needs-attention path with findings; reject → no fix turn spawned (assert call count) → needs-attention; reviewer turn dies (binary exits 1, no output) → `grade: 'ungraded'`, run Completed; single-provider settings → `sameProvider: true`. Write real tests against the harness; if a scenario is inexpressible, state precisely why in the report.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/executor.test.ts` — new tests FAIL.

- [ ] **Step 3: Implement** per the contract. Sketch of the flow (adapt to the file's idioms; place after the `reviewGreen` computation):

```ts
// Branch Review (M28): the merge-decision grade, cross-provider by default.
// Runs only on a green, uncancelled run — a red run already has its verdict.
const branchReview = async (): Promise<BranchGrade> => {
  const implementer = implementerOf(state.tasks.filter((t) => !t.aux).map((t) => t.runner))
  const reviewer = pickReviewer(settings, implementer)
  const review = async (): Promise<ReturnType<typeof parseReview> | null> => {
    const { stat, files } = await branchDiff(state.worktree, state.baseSha ?? 'HEAD')
    const capped = capDiff(stat, files)
    truncated ||= capped.truncated
    const text = await auxTask('Branch review', BRANCH_REVIEW_PROMPT(spec, prompts, capped.body),
      `branch-review-${++reviewN}.log`, { runner: reviewer.runner, model: reviewer.model, effort: reviewer.effort, plain: true })
    return text ? parseReview(text) : null
  }
  /* first review → ungraded / reject / approve / needs-work-with-one-fix-round per contract */
}
```

(`plain: true` = neither readOnly nor autonomous — however the auxTask extension ends up spelled.) Keep the whole addition inside executor.ts small; every reusable piece already lives in branchReview.ts.

- [ ] **Step 4: Full suite** — `npx vitest run src/main/executor.test.ts && npm test && npm run typecheck` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/executor.ts src/main/executor.test.ts
git commit -m "M28: branch review stage — cross-provider grade, one fix round"
```

---

### Task 3: Merge IPC + report rendering

**Files:**
- Modify: `src/main/repoIpc.ts` (next to `runs:cleanup` ~line 256), `src/main/report.ts` (grade at the top of every style), `src/preload/index.ts`
- Test: `src/main/repoIpc.test.ts`, `src/main/report.test.ts`

**Interfaces:**
- Consumes: `BranchReview` (Task 1); run.json's `review` field (Task 2); `lockedGit`.
- Produces: IPC `runs:merge (repo, runId) → { ok: boolean; error?: string; conflicts?: string[] }`; preload `mergeRun(repo, runId)`; reports open with the grade line.

- [ ] **Step 1: Write the failing tests.** repoIpc.test.ts (follow its harness — real temp git repos exist in the cleanup tests; reuse that fixture idiom): merge refuses when the repo working tree is dirty (`ok:false`, reason mentions uncommitted); merges a clean fast-forwardable branch and stamps `review.merged` in run.json; a conflicting branch → `ok:false` with `conflicts` naming the file and the repo left clean (`git status --porcelain` empty, no MERGE_HEAD); a run without an approve grade → refused. report.test.ts: a run with `review` renders `grade` + reasons before everything else; `ungraded` renders as ungraded + reason; no review field → no grade line.

- [ ] **Step 2: Run to verify failure**, then **implement**:

```ts
// Merge (M28 §4): user-triggered only, plain merge, never forced. Runs in the
// user's checkout on whatever branch they have out — that is the target.
ipcMain.handle('runs:merge', async (_e, repo: string, runId: string) => {
  const run = listRuns(repo).find((r) => r.runId === runId)
  if (!run) return { ok: false, error: 'run not found' }
  if (run.review?.grade !== 'approve') return { ok: false, error: 'only approved runs merge' }
  const dirty = (await git(['-C', repo, 'status', '--porcelain'])).stdout.trim()
  if (dirty) return { ok: false, error: 'working tree has uncommitted changes' }
  try {
    await lockedGit(['-C', repo, 'merge', '--no-edit', run.branch])
  } catch (err) {
    const conflicts = (await git(['-C', repo, 'diff', '--name-only', '--diff-filter=U'])).stdout
      .trim().split('\n').filter(Boolean)
    await lockedGit(['-C', repo, 'merge', '--abort']).catch(() => {})
    return { ok: false, error: gitError(err), conflicts }
  }
  /* stamp review.merged = new Date().toISOString() into the run's run.json via the store's run-write helper */
  return { ok: true }
})
```

(`git` here = the file's existing promisified read helper, or add a small one beside `gitError`; adapt names to what the file actually has.) Report: in report.ts's markdown assembly, when `state.review` exists prepend a line like `**Merge review: APPROVE** (codex) — solid, tested` (grade upper-cased, provider, reasons joined; `sameProvider`/`diffTruncated`/`fixRound` appended as parenthetical notes when set).

- [ ] **Step 3: Wire preload** (`mergeRun`), run `npx vitest run src/main/repoIpc.test.ts src/main/report.test.ts && npm run typecheck` — PASS.

- [ ] **Step 4: Commit**

```bash
git add src/main/repoIpc.ts src/main/report.ts src/preload src/main/repoIpc.test.ts src/main/report.test.ts
git commit -m "M28: user-triggered merge for approved runs, graded reports"
```

---

### Task 4: Renderer — grade chips, Merge button, reviewer setting

**Files:**
- Modify: `src/renderer/src/RunsView.tsx`, `src/renderer/src/BoardView.tsx` (Review-column card), `src/renderer/src/SettingsView.tsx`
- Test: `src/renderer/src/views.test.tsx`

**Interfaces:**
- Consumes: run rows already carry run.json data (confirm the listRuns payload includes `review`; if not, add it in repoIpc's listing — one field); `window.somni.mergeRun`; `Persona`-style type re-export idiom for `BranchGrade`.
- Produces: UI only —
  1. **RunsView row**: a grade chip (APPROVE green / NEEDS WORK amber / REJECT red / UNGRADED gray — reuse ui.ts token colors) + reasons on the expanded row; a **Merge** button only when `grade === 'approve' && !review.merged`; merged runs show a `merged` tag; merge errors/conflicts render verbatim under the row.
  2. **BoardView Review-column card**: the same grade chip; Merge from the card for approved runs (same handler surface as RunsView — share the tiny helper, don't clone it).
  3. **SettingsView**: a "Merge reviewer" row — runner select (Auto/cross-provider default + the four names), model input (per-runner datalist idiom), effort select — patching `reviewer` (empty selections clear keys, the `patchCap` precedent).

- [ ] **Step 1: Write the failing view tests** (SSR plain-function idiom): grade chip renders per grade; Merge button only on approved-and-unmerged; the merge handler calls `mergeRun` with the run id and surfaces a conflict list; reviewer settings row patches `reviewer.runner`/`model`/`effort` and clears on empty (assert the patched object).

- [ ] **Step 2: Run to verify failure**, then **implement** following the components' existing extraction idioms (hookless pieces where the harness needs them — the ProposalSection/SettingsForm precedent).

- [ ] **Step 3: Run** — `npx vitest run src/renderer/src/views.test.tsx && npm test && npm run typecheck` — PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src src/preload
git commit -m "M28: grade chips, Merge button, merge-reviewer setting"
```

---

### Task 5: Docs, vocabulary, v0.7.0

**Files:**
- Modify: `design/architecture.md` (new §9-adjacent Branch Review subsection under the review/§9 area + §4 run.json shape), `CONTEXT.md`, `README.md`, `package.json`

**Interfaces:** none — prose only; verify every claim against branchReview.ts/executor.ts/repoIpc.ts before writing.

- [ ] **Step 1: architecture.md.** A Branch Review subsection: review-by-embedded-diff and why (read-only levers excluded codex/gemini — the cross-provider rule demanded tool-free turns), reviewer selection (chain-different-from-implementer, majority rule, sameProvider fallback, reviewer pin), the one fix round (reject skips; checkCommand authoritative), ungraded-never-blocks, the Merge handler's refusal rules, the DIFF_CAP ceiling as a `ponytail:`-style recorded limit. Update the run.json shape in §4 with `review`.

- [ ] **Step 2: CONTEXT.md.** Execution-engine vocabulary:

```
- **Branch Review** — the merge-decision grade on a finished Run: a provider different from the implementer reads the Story's Spec and the whole branch diff (embedded, tool-free) and answers approve / needs-work / reject with reasons. Needs-work buys exactly one fix round; reject parks immediately; an unreviewable run is ungraded and never held hostage.
- **Merge** — the user's deliberate act that lands an approved Run's branch on their checked-out work branch: plain, refused on a dirty tree, aborted on conflict — never forced. Orthogonal to Acceptance.
```

- [ ] **Step 3: README.** Morning-review step: the grade + Merge button; Settings step: the Merge reviewer row; intro sentence: finished branches arrive pre-reviewed by a second AI provider.

- [ ] **Step 4: package.json** → `"version": "0.7.0"`.

- [ ] **Step 5: Full suite** — `npm test && npm run typecheck && npm run lint` — green (modulo the known stale-worktree voice flake). **Commit**

```bash
git add design/architecture.md CONTEXT.md README.md package.json
git commit -m "M28: branch review — docs, vocabulary, v0.7.0"
```
