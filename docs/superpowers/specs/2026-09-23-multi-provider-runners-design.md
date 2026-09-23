# Multi-provider runners — design

2026-09-23 · Workstream 1 of the commercial revision (runners → hands-off briefing → AI reviewer)

## Purpose

somni currently drives two execution backends: Claude Code (`claude`) and Google Antigravity (`agy`). Users with Claude, Gemini, and ChatGPT subscriptions can only spend one of them. This workstream adds **Gemini CLI** and **Codex CLI** runners, replaces the whole-pipeline rate-limit pause with a **per-provider failover chain**, and adds a **Providers panel** so a distributable product works with whatever CLIs a customer has installed — a missing provider is an absent pool member, never an error.

Decisions taken during brainstorming, recorded here:

- **Failover, not load-spreading.** `runner: 'auto'` walks an ordered chain; it does not distribute work across providers. Manual pinning (role → repo → global) remains the way to spread load deliberately.
- **Recommend-only reviewer** (workstream 3): the AI reviewer grades completed branches; the user performs the merge. Recorded now because it constrains nothing here but frames the roadmap.
- **Cross-provider review rule** (workstream-3 commitment): the reviewing Turn defaults to a *different provider* than the one that implemented the Story — different vendors have uncorrelated blind spots. This workstream only ensures the machinery (per-role provider pinning + adapters) exists; the default is wired in workstream 3.
- **Commercial target is a distributable desktop product**, still single-user: signed builds, first-run onboarding, no assumptions about the customer's setup. Team/SaaS shapes are out of scope.
- **Windows-readiness is a constraint, not a deliverable**: new code avoids macOS-only assumptions and keeps binary resolution behind the existing `env.ts` / Settings-paths mechanism, but nothing Windows-specific ships in this workstream.

## Non-goals

- Quota prediction or usage-window modeling — the CLIs don't expose quota; the only trustworthy signal is their rate-limit errors.
- N-version tournaments (same brief to two providers, reviewer picks) — architecturally cheap under worktree isolation, but 2× token burn and new fan-out machinery. Revisit only if one-shot quality proves to be the bottleneck.
- Mixing runners inside a Story or a retry. The existing rule stands, amended only as described under Failover.

## 1. Adapters

`GeminiRunner` (`gemini`) and `CodexRunner` (`codex exec`) implement the existing two-method Runner interface — `buildArgs(prompt, opts) → argv` and `parseLine(line) → event | null` — plus per-adapter rate-limit classification. Nothing outside the adapters branches on runner type; this invariant is unchanged.

Exact flags — autonomous mode, read-only chat mode, resume, streaming JSON event shapes — are **pinned live against the installed CLIs at implementation time**, the same discipline the Antigravity adapter recorded in architecture.md §5. Docs are the starting point; `--help` plus live round trips are the authority. Each pinning decision is recorded in §5 alongside the agy ones.

Known-unknowns to resolve at pinning time, per CLI:

| Concern | Gemini CLI | Codex CLI |
|---|---|---|
| Headless streaming output | expected `-p` + JSON output mode | expected `codex exec --json` |
| Autonomous (skip approvals) | yolo/approval-mode flag | full-auto / bypass-approvals flag |
| Read-only chat mode | sandbox / plan-style levers, verify like agy's two-lever rule | `--sandbox read-only` or equivalent |
| Resume | conversation/session id support — verify live | `codex exec resume` or equivalent — verify live |
| Cost | if tokens-only, `costUsd` stays undefined → em-dash (agy precedent) | same rule |
| Rate-limit shape | classify from observed wording; inferred regexes flagged as such | same rule |

If a CLI cannot satisfy the §7 read-only invariant for chat mode, chat for that provider is disabled (profile validation refuses it) rather than weakened.

## 2. Failover chain

Execution profiles gain one new runner value: `'auto'`.

- **Chain.** Global settings hold an ordered provider list. Default order is derived from what's detected at first probe, Claude first when present. The user reorders it in the Providers panel.
- **Resolution.** `'auto'` resolves *at task start* to the first chain provider that is **available**: installed, logged in, enabled, and not cooling down. Resolution still happens once per task, outside the attempt loop; `run.json` records the concrete resolved profile — `'auto'` never appears in run records, so reproducibility is unchanged.
- **Cooldown.** A rate-limit marks only that provider cooling-down — honoring the CLI's retry-after when parseable, a default backoff otherwise — instead of pausing the pipeline. The rate-limited task re-enters the queue and re-resolves (next provider for `'auto'`; waits for its provider when pinned). A rate-limited attempt consumes **no retry**. Within a genuine error retry, the runner is still never mixed.
- **Pipeline pause** happens only when every provider a queued task could use is unavailable. The existing paused UI (⏸ with retry time) shows the earliest cooldown expiry.
- **Models.** Model names are provider-specific, so an `'auto'` profile takes model/effort from a small per-provider defaults map in settings, not from a single model string. Pinned profiles keep their explicit model as today.

### Per-provider concurrency caps

The single global concurrency cap becomes per-provider caps (global default per provider, same modest-2–3 guidance). The pipeline scheduler counts running tasks per resolved provider; a Story whose next task's provider is at cap waits without blocking Stories bound for other providers. The old global cap remains as an overall ceiling.

## 3. Providers panel & onboarding

- `runnerStatus()` extends to probe all four CLIs: presence on PATH (or Settings override path), version, and logged-in state where the CLI exposes it cheaply.
- **Settings → Providers**: one row per provider — detected version, login state, enable/disable toggle, drag-to-reorder for the chain, per-provider default model/effort, per-provider concurrency cap.
- **First run with zero providers detected**: a guided setup screen (install command + login command + docs link per CLI, re-probe button) replaces the dismissible banner. With ≥1 provider the banner behavior stays.
- Auth-expired is classified separately from rate-limit where the CLI's output allows: it marks the provider unavailable and surfaces in the Providers panel with a re-login hint, rather than burning retries or cooldowns.

## 4. Data model

- **Global settings** gain `providers: { order: string[], disabled: string[], defaults: { [provider]: { model?, effort? } }, caps: { [provider]: number } }`.
- **`.somni/config.json`** may override `order` and `disabled` per repo (same precedence as existing repo overrides).
- **Roles** are unchanged — they can already pin `{runner, model, effort}`, which is how strengths-based routing (Architect→Claude, Tester→Codex, …) works with zero new machinery.
- **`run.json`** unchanged in shape; always records the concrete provider that ran each task.

## 5. Testing

- Adapter unit tests against recorded stream fixtures (existing `runners.test.ts` pattern): buildArgs argv shapes per mode, parseLine over captured event streams, rate-limit and auth-error classification.
- Failover unit tests: cooldown entry/expiry, chain walk order, chain exhaustion → pipeline pause, re-availability resume, pinned-profile wait, retry-vs-requeue accounting, per-provider cap scheduling.
- Providers panel: status probe fan-out, zero-provider onboarding path.
- Manual live-pinning checklist per CLI for the flags fixtures can't prove (read-only invariant verification, resume round trip), results recorded in architecture.md §5.

## 6. Risks

- **CLI drift.** Gemini and Codex CLIs move fast; pinning-at-implementation plus recorded decisions (the agy precedent) is the mitigation, not version pinning we can't enforce on customer machines.
- **Inferred rate-limit regexes.** Until a live rate limit is observed per provider, classification is inferred — same standing risk as agy, same first-thing-to-check note.
- **Login-state probing** may be expensive or unexposed for some CLIs; fall back to "installed" as the probe result and let the first auth error mark the provider unavailable.
