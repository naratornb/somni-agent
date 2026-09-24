# somni — Technical Design

Design for a macOS desktop app that orchestrates parallel, unattended `claude` CLI runs to churn through queued workflows overnight. Companion to [design.md](design.md) (the brief).

**Confirmed decisions:**

- Permissions: full autonomy (`--dangerously-skip-permissions`), contained by per-workflow git worktrees.
- Failure policy: retry once, then halt the workflow (skip its remaining tasks); other workflows continue.
- Workspaces: app-managed — user points a workflow at a repo, the app creates a worktree + branch.
- Reports: a setting `Report style: Minimal / Compact / Full`.

## 1. Framework recommendation: Electron

- The heart of this app is process orchestration: spawning, supervising, and streaming from long-lived `claude` CLI child processes. Node's `child_process` is the most mature, best-documented tool for exactly that. In Tauri the same logic must be written in Rust or fought through the shell plugin's sidecar model.
- One language (TypeScript) across main + renderer. You're web-tech comfortable, not a Rust dev.
- Tauri's advantages — bundle size, idle memory — don't matter for a single-user tool that intentionally runs all night on your own Mac.
- Persistence is plain files in each target repo's `.somni/` directory (§4) — no database dependency at all.

Stack: **Electron + TypeScript + React + Vite**, scaffolded with `electron-vite`.

## 2. High-level architecture

Standard two-process split:

- **Main process** — owns everything stateful: the `.somni/` file store, the orchestrator (scheduler + process supervisor), worktree manager, report generator, and settings. Plain TS modules — no separate daemon. The window can be closed to the tray while main keeps running overnight; `powerSaveBlocker.start('prevent-app-suspension')` is held while a pipeline runs.
- **Renderer** — React UI. Talks to main via `contextBridge`-exposed IPC: `ipcRenderer.invoke` for CRUD/commands, `webContents.send` push events for status changes and log lines. The renderer holds no business logic; it renders stored state plus live events.

No microservices, no job-queue library, no worker threads. The orchestrator is a ~300-line module; concurrency is bounded by an integer, not a framework.

```
┌─ Renderer (React) ─────────────────────────────┐
│ Workflows · Roles · Pipeline · Reports · Settings │
└───────────────┬────────────────▲───────────────┘
        invoke (CRUD, run/pause) │ push (status, log lines)
┌───────────────▼────────────────┴───────────────┐
│ Main process                                    │
│  Orchestrator ── ProcessSupervisor ── claude ×N │
│       │                │                        │
│  WorktreeManager   FileStore (<repo>/.somni/)   │
└─────────────────────────────────────────────────┘
```

## 3. Orchestration engine

**Scheduling (M9: the pipeline is a drain; M13: status is the tick).** One supervisor loop owns the concurrency slots. The tick is gone — a Story's `status` field is the scheduling signal: **Add to pipeline** (allowed only for Ready stories — the Ready gate is enforced in main) sets `status: in-progress` and wakes the drain. Whenever a slot is free the loop re-scans items from disk and picks the next Story with `status: in-progress` that is not already executing and whose `blockedBy` stories are all `done`. Completion writes the transition before anything else acts on it: run Completed → `review`, Failed → `needs-attention`, Cancelled → `ready`. Newly added stories are picked up mid-run (a wake signal from the UI, plus a ~2 s poll that also catches external file edits). Three entry points share the one mechanism, differing only by stop rule: **Drain** (manual; stops when no in-progress Story remains and nothing is in flight), **Nightly Window** (a timer starts the same drain, having disarmed itself first — one night runs one night's consciously added work), and **Keep Running** (idles when nothing is in progress and keeps scanning until toggled off; never persisted across restarts; Cancel clears it). Within a Story, subtasks stay sequential; across Stories, parallel up to `maxConcurrency`. Every state transition is written to the run's `run.json` (atomic write-temp-then-rename) *before* it is acted on, so the files are always the source of truth. Crash-resume stays a fixed-set path over the same loop — a resume never scans for new work.

**Worktree isolation.** On workflow start:

```
git -C <repo> worktree add <appData>/worktrees/<runId>-<slug> -b somni/<slug>-<yyyymmdd>
```

All of the workflow's tasks share that worktree, so each task sees the previous task's files and git state. Worktrees are kept after the run for morning review; a "Clean up" action removes merged/abandoned ones (`git worktree remove` + branch delete).

**Process supervision.** One `child_process.spawn` per running task, `cwd` = the worktree. Stdout is parsed as stream-json events; raw output is also appended to a per-task log file. Completion is detected from the CLI's final `result` event (subtype `success`/`error`) plus the exit code. A per-task **timeout** setting (default 30 min) kills hung processes via `SIGTERM` then `SIGKILL`. Since M20 every prompt somni sends lives in `src/main/prompts.ts` (the Methodology seam: adding a methodology touches that file and `resources/skills/` only), and `run.json` is read/written only through the executor's `loadRun`/`loadRuns`/`saveRun`. Since M19 every runner invocation — subtasks, Review/Fix, reports, refine, grooming replies, the Playground — is one **Turn** (`src/main/turn.ts`, CONTEXT.md term): timeout, SIGKILL grace, AbortSignal cancellation, stream demux, usage capture, and the failure taxonomy (`spawn | exit | timeout | aborted`, with rate-limit classification) live behind that one seam; retries and the rate-limit gate remain Pipeline policy outside it.

**Failure & retry.** A task fails on nonzero exit, an error `result`, or timeout → one automatic retry as a fresh invocation, same provider, same worktree (§5's failover chain never switches providers for a genuine failure — only for a rate limit or auth error). Second failure → task `Failed`, the workflow's remaining tasks `Skipped`, workflow `Failed`; other workflows are unaffected. **Rate-limit and auth failures are special-cased, and — since M26 — no longer pause the pipeline as a whole:** each task resolves its own provider through the failover chain (§5); a rate limit cools that provider down and, for `Auto`, fails the task over to the next chain member immediately, while a pinned runner instead waits out its own cooldown. The pipeline shows `Paused` only for a task whose every candidate provider is currently unavailable — other tasks with a usable provider keep running in the same tick. This is what makes an overnight run survive a Max-plan 5-hour usage window without stalling everything else on it too.

**Crash/quit recovery.** On launch, if a repo's latest `runs/<id>/run.json` is still marked `Running`, orphaned `Running` tasks are reset to `Queued`. Their worktree holds whatever the dead process left behind — acceptable, because task prompts are stated as goals, not diffs, so a re-run continues from the current files. The user is offered **Resume pipeline** / **Abandon**.

## 4. Data model — the `.somni/` file store

All per-repo state lives **inside the target repo** at `<repo>/.somni/` as plain files: transparent (reviewable, diffable) and portable — clone the repo on another machine, open somni, and your workflows and history are there. No database.

**v2 — the work-item store (M13, clean break).** One flat item store; `kind` is a frontmatter field, so grooming converts an Idea in place — no file moves. v1 `workflows/` directories are ignored by the v2 loader (no migration, no error); old `runs/` render unchanged.

```
.somni/
  .gitignore            # maintained by somni: ignores runs/*/logs/
  config.json           # optional per-repo overrides (report_style, concurrency, timeout,
                        # default execution profile — runner/model/effort, see §5;
                        # M16 adds optional checkCommand)
  seq                   # next item number, bare integer, monotonic — ids are never reused
  roles/<slug>.md       # role preamble as Markdown; H1 = display name; optional
                        # frontmatter: runner/model/effort override (§5)
  items/SOM-<n>-<slug>.md        # every work item. Frontmatter: id, kind (idea|epic|story),
                                 #   status (backlog|grooming|ready|in-progress|
                                 #   needs-attention|review|done), epic?, blockedBy?, created.
                                 #   Body = the approved Spec.
  items/SOM-<n>-<slug>.tasks.json # stories only: ordered subtasks
                                 #   [{title, prompt, role, selected}] — the shape the executor consumes
  chats/SOM-<n>.jsonl   # grooming transcript per item (committable)
  chats/<id>.jsonl      # one grooming transcript per item — every groom is item-keyed (M25)
  backlog.json          # ordered item ids = Backlog column priority; missing ids pruned on load
  runs/<runId>/
    run.json            # execution state: pipeline/story/subtask statuses, attempts,
                        # session_ids, timestamps, cost, exit codes — crash-resume source of truth
                        # (the JSON key `workflow` is frozen for v1-run compatibility; it carries the story id)
    logs/<task>.jsonl   # raw stream-json CLI output (gitignored — large)
    report.md           # the summary report (committable)
```

- `run.json`'s `review` field (M28, written only after a green, uncancelled run): `{ grade: 'approve'|'needs-work'|'reject'|'ungraded', reasons, findings, provider, sameProvider?, diffTruncated?, fixRound?, merged? }` — the Branch Review grade (§9-adjacent subsection below). Absent means not reviewed yet: still running, failed before the gate, cancelled, or a run from before M28.
- **Committable**: definitions, items, `run.json`, reports — commit `.somni/` for cross-machine continuity. **Gitignored**: raw logs (somni writes `.somni/.gitignore` itself).
- Items and Roles are Markdown because specs and preambles are prose; subtask sidecars are JSON because they're structured. Frontmatter is parsed by the same hand-rolled parser as roles — no YAML dependency.
- Ids are `SOM-<n>`: fixed prefix, one sequence across all kinds (Jira-style), unpadded — code sorts numerically.
- **Board column = `status`.** The Backlog column is ordered by `backlog.json`; other columns sort by id/recency — no per-file order field, no multi-file rewrites on drag.
- **The Ready gate lives in main**: `item:setStatus` and `pipeline:add` refuse `ready`/pipeline entry unless the Spec body is non-empty and the sidecar has ≥1 selected subtask. The UI hides affordances; main is the authority.
- Writes are atomic (write temp file, rename). The files are authoritative: external edits — a `git pull`, hand-editing an item — are picked up on app refresh.
- Definitions (`roles/`, `items/`) are deliberately separate from executions (`runs/`) so history survives edits and re-runs.

Run statuses: `Queued / Running / Completed / Failed / Skipped / Cancelled`, plus `Paused` for a task waiting on its failover chain (§5) — since M26 this is per waiting task, not a pipeline-wide state; other tasks with a usable provider keep running. (Item statuses are the board columns above — the two vocabularies never mix.)

**App-level state** (Electron `userData`, machine-specific): global settings (claude path, default concurrency, default report style, task timeout, and the Nightly Window — `nightlyTime` "HH:MM" + `nightlyArmed`, armed state surviving restart, time surviving disarm; it drains the last-opened repo), the list of known repos, and worktrees under `<appData>/worktrees/` — worktrees are disposable local build artifacts; the `somni/…` branches are the portable part. Keep Running is deliberately not persisted.

## 5. Runners & CLI invocation

somni supports four execution backends ("runners"): **Claude Code** (`claude`, Max plan), **Google Antigravity** (`agy`, headless mode, Google subscription), **Codex** (`codex`, OpenAI), and **Gemini CLI** (`gemini`, Google). Which one runs a task — and with what model and effort — is an **execution profile**; a profile's runner may instead be `'auto'`, which defers to the **provider chain** (below) rather than naming one:

**Binary resolution (M22).** CLI binaries resolve on PATH (Settings paths override). A Finder-launched packaged .app inherits launchd's bare PATH, so at startup (packaged only) main resolves the login shell's PATH once (`src/main/env.ts` `shellPath()`: `$SHELL -ilc`, marker-scraped, 3s timeout, Homebrew-dir fallback) and assigns `process.env.PATH` — every spawn (runner, voice, git) inherits it from that one place. A cache-free `runner:status` probe (`runnerStatus()` in runners.ts, IPC in repoIpc) backs a dismissible missing-Runner banner in the shell that re-probes while visible, so a Settings fix clears it without restart.

```
{ runner: 'claude' | 'antigravity' | 'codex' | 'gemini' | 'auto', model?: string, effort?: 'low'|'medium'|'high' }
```

Resolution order: **role → repo `.somni/config.json` → global settings.** Roles are where "how much brainpower" lives (e.g. Senior Developer → strongest model, high effort; report writing → small fast model); a task gets its role's profile, no per-task knobs. A role that pins a concrete runner overrides `'auto'` for every task using it — it never joins the failover chain, so it never fails over and never waits on a sibling's cooldown, only its own. The seeded `developer` role pins Claude Code for exactly this reason: Antigravity cannot read `.claude/skills/`, and developer is the role most coupled to the injected skills. For an `'auto'` task, `model`/`effort` come from that attempt's concrete provider's own `settings.providers.defaults[name]` instead of the profile fields — model ids are provider-specific, so one profile can't serve every chain member. `run.json` and chat transcripts record the *concrete* provider that ran each task (never `'auto'` itself), for reproducibility.

**Runner adapter.** All runner differences live behind one small interface in the main process — nothing else may branch on runner type:

```
Runner {
  buildArgs(prompt, {model, effort, resumeSessionId, readOnly, autonomous}) → argv
  parseLine(line) → {sessionId} | {text} | {result: {ok, costUsd?, durationMs}} | null
}
```

The orchestrator, chat, and stream plumbing are runner-agnostic. Two more adapter fields feed policy outside this file: `isRateLimit`/`isAuthError` classify an adapter's own error text for the failover chain (below) — a rate limit cools that provider down, an auth failure parks it; `supportsReadOnly` gates the §7 chat invariant — an adapter with no verified read-only lever (Codex, Gemini) is refused for chat rather than trusted on an advisory flag, falling through the chain to the next member that has one.

**ClaudeRunner** (reference implementation):

```
claude -p --output-format stream-json --verbose \
  [--model <m>] [--resume <session_id>] \
  --dangerously-skip-permissions            # autonomous task mode
  | --allowedTools "Read,Glob,Grep"         # read-only chat mode
  "<role preamble>\n\n---\n\n<task prompt>"
```

- `cwd` = the workflow's worktree (tasks) or the repo (chat).
- Role context is the role's preamble prepended to the prompt — no system-prompt flags needed.
- Parsed from stream-json: `session_id` (stored per task run), assistant text deltas (live log), final `result` event → success/error, `total_cost_usd`, duration.
- Effort maps to the CLI's thinking controls — exact mechanism pinned at implementation time.

**AntigravityRunner:**

```
agy -p --output-format stream-json \
  [--model <m>] [--effort low|medium|high] [--conversation <id>] \
  --dangerously-skip-permissions            # autonomous task mode
  | --mode plan --sandbox                   # read-only chat mode
  "<role preamble>\n\n---\n\n<task prompt>"
```

Flags and event shapes were pinned at implementation time against the installed CLI (`agy --help` plus live `-p --output-format stream-json` round trips), not against the docs — https://antigravity.google/docs/cli/headless/ remains the page to re-check when the CLI moves. Decisions recorded there:

- **Resume is supported** — `--conversation <id>`, verified live across a two-turn conversation. The chat therefore uses the profile's runner directly; the "chat falls back to ClaudeRunner" hedge is dropped and unimplemented.
- **Read-only is two overlapping levers**, `--mode plan` (keeps it out of the workspace) plus `--sandbox` (denies shell commands). agy has no per-tool allowlist, and plan mode alone is advisory — the agent honouring a mode, not the CLI refusing a tool — so both are always applied together for the §7 read-only invariant. Verified: an explicit "overwrite this file now" instruction left the workspace file untouched.
- **No dollar cost.** agy reports token usage only, so `costUsd` is undefined for antigravity tasks and report cost columns render as em-dash. Not worth maintaining a price table to synthesise one.
- **Rate-limit classification is inferred**, not observed: the adapter matches Google's conventional quota/`RESOURCE_EXHAUSTED`/429 wording, but no live agy rate limit has been seen yet. If unattended runs start burning retries instead of pausing, this regex is the first thing to check.

Parsed from agy's stream: `{event: "init", conversation_id}` → session, `{event: "step_update", step_update: {step_type: "agent_response", text_delta}}` → live log, `{event: "result", result: {status, response, duration_seconds}}` → success/duration.

**CodexRunner:**

```
codex exec [resume <thread_id>] --json --skip-git-repo-check \
  [--sandbox read-only] [--dangerously-bypass-approvals-and-sandbox] \
  [--model <m>] [-c model_reasoning_effort="<effort>"] \
  "<role preamble>\n\n---\n\n<task prompt>"
```

Pinned live against the installed CLI, codex-cli 0.154.0 — flags and event shapes are a verified round trip, not read off docs. Decisions recorded there:

- **Resume is `codex exec resume <thread_id>`** — a subcommand, not a flag; `buildArgs` inserts it right after `exec`, before `--json`.
- **`--skip-git-repo-check` is always passed.** Chat runs in the repo root, but tasks run in worktrees whose `.git` is a gitdir pointer file codex may not recognise as a repo; the executor already owns isolation, so codex's own repo check is redundant at best and wrong for worktrees at worst.
- **`--sandbox read-only` is not a real read-only lever.** Live-verified: it gates codex's shell-command tool but not its own file-write tool — a direct "create this file" instruction wrote it anyway. `supportsReadOnly: false` — chat refuses codex (§7) rather than trusting a flag that doesn't hold for the thing that matters.
- **No dollar cost, no duration.** Codex reports token usage only (the agy precedent), and `turn.completed` carries no timing field.
- **Rate-limit and auth classification are both regex-inferred, not observed live**: `isRateLimit` matches `rate limit|usage limit|too many requests|429`; `isAuthError` matches `not logged in|codex login|401|unauthorized`. No live codex rate limit or logged-out run has been seen yet — the first thing to check if unattended runs start burning retries instead of cooling down, or failing outright instead of parking.

Parsed from codex's stream: `{type: "thread.started", thread_id}` → session, `{type: "item.completed", item: {type: "agent_message", text}}` → live log, `{type: "turn.completed", usage: {input_tokens, cached_input_tokens, output_tokens}}` → success (codex carries no explicit ok/error flag on a completed turn — `ok: true` is assumed unless a separate `turn.failed` event arrives), `{type: "turn.failed", error: {message}}` → failure with detail.

**GeminiRunner** — UNPINNED:

```
gemini -p --output-format stream-json \
  [--approval-mode yolo] [--resume <session_id>] [--model <m>] \
  "<role preamble>\n\n---\n\n<task prompt>"
```

Written from the gemini-cli docs (`docs/cli/cli-reference.md`, `headless.md`, `session-management.md`, 2026-09) — the CLI is not installed on the dev machine, so none of this has been verified against a live round trip the way Codex and Antigravity were. Decisions recorded there:

- **`--approval-mode yolo`, not the deprecated `--yolo`.** The docs confirm the flag was renamed. Earlier design text (the M26 spec doc) still shows `--yolo` — that's a historical record of the plan as written, left as-is; this section tracks the flag the current code actually sends.
- **`supportsReadOnly: false`** — the docs name no verified read-only lever for gemini (no per-tool allowlist, no confirmed sandboxed mode), so chat refuses gemini exactly like codex, falling through the chain (§7).
- **`parseLine`'s field names are a guess, not a fact.** The docs enumerate stream-json event *types* (`init`/`message`/`tool_use`/`tool_result`/`error`/`result`) but publish no field-level JSON example, so `session_id`, `role`/`content`, and `status`/`response` below are the plan's best-known reading, unverified either way.
- **Rate-limit and auth classification follow the agy precedent** (Google error shapes): `isRateLimit` matches `rate limit|quota|resource exhausted|too many requests|429`; `isAuthError` matches `not logged in|not authenticated|gemini login|401|unauthorized`.

Parsed from gemini's stream (unverified): `{type: "init", session_id}` → session, `{type: "message", role: "assistant", content}` → live log, `{type: "result", status, response}` → success/detail.

**Pin when installed.** The first machine with `gemini` on PATH should pin this adapter the way Codex was pinned above — a live `-p --output-format stream-json` round trip confirming the actual event field names — then update this subsection and the corresponding comment in `runners.ts` together. Until then, treat every field name above as provisional.

### Failover chain (M26)

A task's retry no longer pins one runner for its whole lifetime the way it did before M26. `runTurnWithFailover` (`src/main/failover.ts`) is the one body every Turn-issuing call site shares — the subtask loop, the aux Review/Fix turns, and the report task (§6's Full style) — so a rate-limit/auth-park/logging fix lands once for all three instead of drifting across copies.

- **`'auto'` resolves per attempt, not once per task.** `pickAuto` walks the **provider chain** — `settings.providers.order`, with any unlisted runner appended in a default order, then filtered by `settings.providers.disabled` — filters to providers that are neither cooling down nor parked, and (M29) prefers one with a free per-provider cap slot (`hasFreeSlot`) over the chain's next-in-line; if every available candidate is already capped-full it falls back to the first available — today's queueing behavior, unchanged. A pinned (non-`'auto'`) choice never fails over to a different provider; it only ever waits on itself.
- **Cooldown**: a rate limit starts a provider's cooldown at 5 minutes; each further rate limit on the same provider before it clears doubles the next cooldown, capped at 60 minutes. A successful turn (`markOk`) resets it fully back to 5 minutes — the doubling tracks a losing streak, not a permanent state.
- **Parking**: an auth failure (or a missing/unresolvable binary) parks a provider indefinitely — unlike a rate limit, neither clears on its own. Parking only lifts on `markOk` (an actual successful turn) or `markPresent` (a Providers-panel re-probe, or the app-launch probe, answering `--version`). A probe proves the binary is present, not that a rate limit has lifted — it clears parking only, and **never** wipes an active cooldown; only `markOk` does that.
- **Per-provider caps** (`settings.providers.caps[name]`) bound how many tasks run concurrently on one provider; the global `concurrency` setting stays the outer ceiling regardless of caps. No cap configured for a provider = it never queues on its own account.
- **Waiting vs. failing.** If the chain has a candidate that will become available later (a cooldown with a future expiry — not parked), a waiting task's pipeline status is `Paused` with a `resumeAt`. Since M29 the wait itself doesn't sleep to that deadline: it polls availability every tick and clears the moment a candidate actually returns — a sibling's `markOk`, or a slot an `acquireSlot` release frees up — so a cooldown that clears early wakes the task early instead of at the old fixed deadline; `resumeAt` is now display-only, not the thing the wait is timed against. If a provider the task is waiting on parks *mid-wait* (a sibling task's auth failure lands while this one is already polling), the wait also ends immediately and hands control back to the outer loop, which re-resolves and hits its own null → `'unavailable'` fail-fast — never a spin waiting on a provider that can no longer come back on its own. If every chain candidate is currently parked with none due back to begin with, the task fails outright the same way — `'no provider available'` — rather than waiting forever.
- **Genuine (non-rate-limit, non-auth) failures** retry the same provider up to `maxAttempts` (2 for a subtask, 1 — one shot — for an aux/report turn) before giving up; only a rate limit or auth failure ever moves the attempt loop to a different provider.

**Two known ceilings**, both deliberate (`providers.ts`'s own words: "a restart forgets cooldowns — the next rate limit re-teaches them, which is cheaper than persisting a clock"):

- **Cooldowns and parking are in-memory only — an app restart forgets both.** Quitting mid-backoff and relaunching clears every provider's state; the next attempt tries immediately instead of respecting the remaining wait. Fine for a single-user overnight tool where a mid-run restart is already rare and deliberate, but not a durable record across sessions.
- **The pipeline's `Paused`/`Running` status can flicker under concurrency.** Each task's wait independently calls `onPipeline('Paused' | 'Running')` (`executor.ts`) with no cross-task coordination — with `maxConcurrency` > 1, a task waiting on a cooling-down provider while a sibling task is actively running on a different one will toggle the status line between `Paused` and `Running` as first one, then the other, starts and stops waiting. Accurate per-emit, but not a single coherent "is anything blocked" signal when multiple tasks hold different waits at once.

## 6. Summary reports — `Report style` setting

| Style | Cost | Content |
|---|---|---|
| **Minimal** | zero tokens | App-computed: `git diff --stat` vs branch base, files created/modified counts, test files/cases added (heuristic: diff over `*test*`/`*spec*` paths), per-task durations, per-task `cost_usd`. |
| **Compact** | one short call | Minimal + a single `claude -p` call that turns the task transcripts into a prose summary paragraph. |
| **Full** | one full task | Minimal + an auto-appended "Report" task run inside the worktree with full context. |

Reports are written to `runs/<runId>/report.md` (with stats alongside in `run.json`) and rendered in the Runs & Reports view.

## 7. Grooming (the grill interview) — M14, re-aiming M8's drafting machinery

Grooming turns intent into an approved Spec and tracer-bullet Stories — the only AI path to Ready. It reuses the task runner rather than adding a chat stack:

- **Each chat turn is the same spawn path as task execution**: `claude -p <message> --output-format stream-json --verbose`, with `--resume <session_id>` from the second turn on. No API calls, no new dependency; uses the Max plan.
- `cwd` = the target repo, tools restricted to read-only via `--allowedTools "Read,Glob,Grep"` and **no** `--dangerously-skip-permissions` — the assistant can inspect the actual codebase while grooming, but cannot change anything.
- A fixed grooming preamble (turn 1 only — resume carries it) sets the **Interview discipline**: one Question at a time as a fenced ` ```somni-question ` block — `{"question", "options": [...], "recommended"}` — rendered as clickable choices (recommended highlighted), degrading to plain text if malformed. Clicking sends the option text as a normal user turn; the input stays active for custom answers. The preamble caps the Interview at **THREE Questions total by default** — only a question whose answer would materially change the Spec earns one of the three (M27) — after which the assistant proposes or states plainly it's ready to draft. That cap is a default, not a hard stop (M29): past round three, **Ask more questions** (GroomView, visible whenever `loadChat`'s exposed `questionRounds` reads ≥3 and there's no pending proposal — the count also advances live off each question event mid-interview, not just at load) spends one send's worth of `sendChat`'s `{interactive: true}`, which skips only the round-cap route for that one message and can be used again on the send after that. **Propose Now** is an always-visible button sending a fixed, transcript-visible message that ends the Interview on stated assumptions early. The preamble also carries the grooming charter: pick the altitude (big intent → Epic of vertical-slice Stories with blocking edges; small → one Story), Specs with verifiable success criteria, Subtask prompts as goals.
- **Persona (M27):** who the user is to a groom — the **Technical Director**, who answers up to three Question rounds, or the **Project Owner**, who never does — decides in `sendChat` whether a message goes to a live turn or straight to a background work unit. An owner's groom routes its very first message into a work unit from birth; any session, either persona, that reaches three answered Question rounds routes its *next* message the same way — Propose Now included, so cutting the Interview short right at round three still hands off rather than getting a live reply, unless the user reaches for Ask more questions instead. Past round three `sendChat` re-checks the cap on every send, not once, so routing keeps falling through to a background draft by default; `interactive: true` and "New chat" are the two ways back to a live turn, one-send and full-reset respectively. Resolution is item stamp → repo/global setting → the Director default, applied only at these resolution sites — the default is deliberately absent from `SETTINGS_DEFAULTS` so Home can tell a never-chosen setting from a chosen one. The Quick Start chip default and GroomView's own default persona read the *resolved* settings (`resolveSettings(repo)`, repo `.somni/config.json` over global) — M29 — while Home's first-run persona pick strip still keys on the raw global `settings.persona === undefined`, since that strip's whole job is detecting a never-chosen *global* default, not a resolved one.
- **Durable routing (M27):** a message that routes into a work unit is appended to the transcript *before* the handoff call, not after, so it survives sitting behind the cap-3 queue or the app quitting before its job ever starts. A work unit resumed on nothing but the generic hand-off message (a quit dropped the original closure) recovers the real request from the transcript itself — the trailing user line(s) after the last assistant reply.
- **Auto-handoff (M27):** a reply that neither asks a Question nor proposes — the Interview trailed off instead of ending cleanly — hands the session to a work unit on the spot, regardless of persona. This and the owner-birth/cap-3 routing above are three of `sendChat`'s own paths into the same background machinery (§7.1). The fourth is the owner mount-handoff: GroomView calls `handoffSession` itself, before the user types anything, the moment an owner groom that already carries content — from Board, Capture, or a persona flip — is opened.
- **The Brief and Approve & run (M27):** a work unit's proposal spec must open with a plain-language `## Summary` (three to six sentences — what will be built, the assumptions taken, what it touches) above its required `## Assumptions` section, written for a reader who won't read the rest. This is the parked needs-review Proposal the vocabulary calls a **Brief**. Reopening a needs-review session with no live turn in flight replays its last assistant reply's proposal, so the Brief is still there to act on. **Approve & run** is the Brief's primary action: Apply, then queue the root Story (if Ready) and every child Story the proposal left unblocked, in one act — the Quick Start Apply & run precedent, reused rather than re-invented. A live interactive proposal keeps plain Apply — the gating is presence-based (did a work unit produce this, or was the session already parked when the view opened), never inferred from `groomState` alone, since chat.ts parks the same `needs-review` state for both.
- Whenever proposing, the assistant ends the reply with a fenced ` ```somni-groomed ` JSON block: `{kind, name, spec, stories?, subtasks?, roles?}` — `stories` (epic case) each carry `{name, spec, subtasks, blockedBy?}` where `blockedBy` is index-based over earlier entries in the same array; `roles` are any **new Roles** the subtasks need (`{slug, name, preamble, runner?, model?, effort?}`). A forward/self/out-of-range index — like an invalid role — rejects the whole proposal.
- The app parses the last such block into a **proposal preview** with **Apply / Dismiss**. Apply converts the groomed item in place (id kept; idea → epic|story), creates child Stories with resolved `blockedBy` ids and `.tasks.json` sidecars — **all `ready`** (the epic itself lands `backlog`; it never executes) — and writes only the roles whose slugs don't exist (an existing role always wins). The chat itself never writes files — Apply is the only mutation, and it is user-triggered.
- Entry points: `Groom →` on a Board card, Quick Start, and Capture's "Groom now" — all of them create the Item **first** (M25: kind `idea`, status `grooming`; the reserved `_draft` key is gone) and attach the transcript to its real id (`chats/<id>.jsonl`). The first exchange auto-titles the Item via a one-shot read-only Turn (failure keeps the placeholder); rename is manual in the Groom header. Grooming-column card clicks resume the interview; StoryPanel stays the hand-edit surface everywhere else.
- Transcripts persist under `.somni/chats/` so grooming context survives sessions and machines; "New chat" starts a fresh session. Grooming is refused for a story currently executing in a pipeline; turns remain read-only spawns.

### 7.1 Grooming Sessions — M25

Every Groom is a **Session**: a first-class, visible, resumable activity over its Item (no second entity — session state lives in item frontmatter, strictly outside `ItemStatus`). PRD: issue #38; primary-source notes: [research/grooming-sessions-cli-and-notifications.md](research/grooming-sessions-cli-and-notifications.md).

- **Session state** (`groomState` frontmatter): absent = in conversation; `working` / `queued` / `needs-review` / `interrupted` / `done` / `archived`. `done` ≈ Proposal Applied (`doneAt` stamp); a sweep on repo load archives done sessions after 14 days; archived sessions reopen. Transitions are atomic frontmatter writes **before** acting; the in-memory queue is derived, never authoritative.
- **Honest turns**: a mid-Turn Groom re-opened shows the buffered partial reply + busy state (main buffers streamed text per key, `chat:load` replays it); a `done` for a session that isn't the open view raises an in-app toast.
- **Work units** (`sessions.ts`): a **Handoff** — the user's explicit "Draft in background", or (M27) an automatic one: an owner-persona birth, a third answered Question round, or a fenceless reply (§7) — runs ONE autonomous Turn under the work-unit prompt — assume-and-continue, no `somni-question` fences, Proposal spec opening with `## Summary` above a required `## Assumptions` section (M27) — via `--resume` on the transcript's session id. Cap **3** concurrent (own cap, not pipeline concurrency), one FIFO queue shared by every route in, explicit or automatic; refused while that key's chat turn is in flight. Any outcome parks `needs-review`; Apply (or M27's Approve & run) stays the only write path.
- **Interrupted/resume**: `before-quit` persists `interrupted` for working + queued sessions before killing turns (the CLI keeps the session resumable — see the research note); Resume re-enters the work-unit path on the same conversation. No orphan scan — quit-path persistence only.
- **Notifications**: needs-review transitions notify natively (macOS) only when no window is focused; click focuses + opens the session. The notifier/focus-check are injected into main's transition site — Electron appears only in the index.ts wiring (unsigned dev builds show nothing; `Notification.isSupported()` guarded).

## 8. UI / screen breakdown

Sidebar navigation, five destinations (M23 set + Sessions in M25; Playground appears in dev builds only). Groom is a routed flow step, not a nav entry; the old Pipeline and Roles destinations folded into Home and Settings.

0. **Sessions** (M25) — the activity view over Grooming: every session grouped by state (Interrupted / Needs your review / Working / Queued / Recently done / In conversation), sort (last activity default / created / title), title search, kind filter, archived toggle, Reopen/Resume row affordances. A projection of `repo:load` items — no separate index. The Board stays the *what*-view of the same truth.
1. **Home** (M23, default; session rail M25) — the front door. No repo: a single welcome hero with **Choose repo**. With a repo: the **Quick Start** box ("What do you want done overnight?") with **Suggestion chips** (`repo:suggestions` — git TODO/FIXME counts + recent commit subjects, `[]` → static fallback; chips fill the box, never submit), and beneath it the **pipeline activity**: the drain dashboard — run cards, per-subtask chips, progress bar, **Drain queue / Cancel**, **Keep Running**, drain mode/status — whose toolbar renders even with zero runs. Between Quick Start and the pipeline activity sits the **session rail** (M25, renders only when live sessions exist): the focused (most recently active) session as an enlarged card, up to six compact rows ordered needs-review → working → queued → recency, and a "View all" overflow into Sessions; every element opens the Groom view — conversation never renders inline on Home. Submitting the box grooms seeded with the text; Apply reads **Apply & run** (Stories only, never Epics) and auto-queues through the unchanged Ready gate, landing back on Home. The box has a mic (M24): dictation fills it for review by default, or — with the `voiceAutoGroom` setting on — starts the groom immediately; inside the Groom interview a transcription into an empty composer auto-sends as the reply (a typed partial appends and waits), and the Board quick-add's mic is always visible.
2. **Board** (M13, regrouped M23) — the kanban view over the item store: four columns grouping the unchanged statuses — Ideas (backlog + grooming), Ready, In Progress (in-progress + needs-attention), Done (review + done). Cards render by their true status, so kind chips, drag rules and per-status affordances (Groom →, Add to pipeline, Re-run / Re-groom, Accept) survive intact; each column has one drop status (Done drops → `review`; a drop the Ready gate refuses bounces back), Backlog order still `backlog.json`. Click a card → **StoryPanel** (unchanged). Spec'd in [briefs/M13-ui.md](briefs/M13-ui.md), regrouping in issue #26.
3. **Runs & Reports** — history of pipeline runs; per-workflow report (stats table + summary); links to the worktree/branch for review.
4. **Settings** — max concurrency, runner binary paths, **default execution profile** (runner dropdown, per-runner model list, effort), **report style (Minimal / Compact / Full)**, task timeout, the **Nightly Window** (time-of-day + armed toggle with visible armed/disarmed state), and the **Roles** section (CRUD library of `name` + `preamble`; editor has optional runner/model/effort overrides).

The **Grooming view** (M14) survives as a routed surface reached from Quick Start, Board cards, and the Capture modal: answer the Interview's question cards, Propose Now anytime; Apply writes the groomed Epic/Stories/Subtasks and lands on Home (auto-run) or the Board. The PO/Engineer view-mode switch (M11) was removed in M23 — one view set, the hats live on as prose in CONTEXT.md.

## 9. Phased build plan

- **M0 — Walking skeleton.** electron-vite scaffold; one button that spawns a hardcoded `claude -p` and streams its output into the window. Proves the entire risky path: spawn, stream-json parsing, completion detection.
- **M1 — Definitions.** `.somni/` file store (read/write, atomic saves, `.gitignore` bootstrap); Roles and Workflows/Tasks CRUD UI.
- **M2 — Single workflow run.** Worktree creation, sequential task execution, persisted statuses, per-task log files.
- **M3 — Pipeline.** Checkboxes, multi-workflow concurrency, dashboard, live log streaming.
- **M4 — Unattended reliability.** Retry-once/halt policy, timeouts, rate-limit pause/backoff, crash resume, powerSaveBlocker, cancel.
- **M5 — Reports, settings, polish.** Three report styles, run history, worktree cleanup; model/effort configuration for the Claude runner (profile resolution role → repo → global).
- **M6 — AI workflow drafting.** The "Draft with AI" chat (§7). Depends only on M0's spawn/parse and M1's file store, so it can be pulled earlier if wanted.
- **M7 — Antigravity runner.** Extract the Runner adapter interface, add the `agy` adapter, runner dropdown + per-runner models in settings.

**Phase 2 — least-effort briefing & queueing.** Domain terms in [CONTEXT.md](../CONTEXT.md); voice decision in [ADR 0001](../docs/adr/0001-in-app-whisper-voice-input.md).

- **M8 — Brief-first drafting.** "New from brief" entry point (no saved workflow needed); relentless structured Interview — the assistant emits fenced `somni-question` blocks (question, options, recommended answer) rendered as clickable choices, degrading gracefully to plain text; ever-present **Propose Now** escape; proposals may include new Roles (previewed, written only on Apply); the polished Brief persists on the workflow and feeds later AI calls; Apply auto-ticks the workflow into the Queue. The editor chat adopts the same interview discipline.
- **M9 — Backlog & drain.** Ordered Backlog with manual Promote only; the pipeline becomes a drain that picks up newly ticked/promoted workflows mid-run; Nightly Window setting (drains until the Queue empties, unticks what it ran, then disarms); Keep Running toggle (drains until switched off). Rate-limit pause and the concurrency cap apply to draining unchanged.
- **M10 — UI redesign ("Nocturnal Mission Control").** Whole-app adoption of the design system in [stitch_somni_ai_orchestrator/](stitch_somni_ai_orchestrator/) — dark-only Material-3-style tokens, Inter + JetBrains Mono, Material Symbols, 240px sidebar shell. Tailwind v4 (build-time, CSS-first `@theme` tokens) replaces the hand-written stylesheet; fonts and icons bundled locally, no runtime CDN fetches. The four mocked screens (Pipeline, Workflows editor, Runs, Draft) follow their mocks; unmocked surfaces (Roles, Settings, Playground, editor chat panel) are specced from the design system. Directional fidelity: shipped M8/M9 functionality wins wherever a mock lags behind it. Placed before the remaining feature milestones so their UI work is built once, on the new skin.
- **M11 — Refine, model lists, view modes.** One-shot "Refine with AI" on task prompts and role preambles (workflow-structure refinement routes through the editor chat as a canned message); Runner adapters gain `listModels()` (CLI query → curated fallback → free-text combo in the UI); PO/Engineer view modes — presentation-only sidebar switch for the same single user.
- **M12 — Voice input.** In-app mic on every AI text field via locally run whisper.cpp `base.en`, model downloaded on first use; macOS dictation remains the fallback. Deliberately last: riskiest dependency, nothing else needs it.

**Phase 3 — the Jira-vocabulary SDLC on the Pocock workflow.** somni's core becomes a kanban SDLC using Jira's work-item vocabulary (Backlog / Epic / Story / Subtask — no Sprint) fused with Matt Pocock's engineering workflow ([mattpocock/skills](https://github.com/mattpocock/skills)): the grill interview → approved Spec → tracer-bullet Stories with blocking edges → unattended implement with TDD closing in code-review. The fusion point is the **hard Ready gate** — nothing runs that wasn't groomed properly. Work items fully replace the Workflow/Task vocabulary (clean break, no migration); the execution engine keeps its names and machinery. Decided 2026-08-27; vocabulary in [CONTEXT.md](../CONTEXT.md).

- **M13 — Work-item model v2 + the Board.** The `.somni/` v2 item store (§4), status-as-the-tick drain scanning (§3), the Ready gate in main, and the kanban Board as home with StoryPanel; WorkflowsView deleted, Draft view hidden pending M14. Stories are hand-authored this milestone. [briefs/M13.md](briefs/M13.md).
- **M14 — Grooming.** The M8 interview machinery re-aimed: a grooming preamble encoding grill → spec → tickets discipline; proposals become a fenced `somni-groomed` block `{kind, epic?, stories: [{title, spec, subtasks, blockedBy}], roles?}`; Apply writes epic + story items with sidecars, all Ready; Draft view returns as the Grooming view keyed by item id; the drain honors `blockedBy` ordering end-to-end.
- **M15 — Capture + command palette.** Friction-free idea entry per the accepted capture design: capture modal (header "+", Cmd+N; textarea + M12 mic; Enter = save to Backlog & stay open; "Groom now →" seeds the Grooming view), inline quick-add row atop the Backlog column sharing one `item:capture` IPC, muted "Idea" chips, and a Cmd+K palette (Capture / Search stories / navigation / Run pipeline). No OS-global shortcut yet.
- **M16 — Vendored skills + the implement discipline.** Pinned Pocock skills bundled at `resources/skills/` (manifest: version + upstream commit) and injected deliberately into target repos (`.claude/skills/` + version marker + `docs/agents/issue-tracker.md` declaring `.somni/items/` as the local tracker + `docs/adr/`, CONTEXT.md stubbed only-if-absent; manifest-scoped writes, never touching user files). The executor prepends a per-subtask discipline preamble pointing at the Story's Spec, auto-appends a Review task (code-review + tests → fenced `somni-verdict` JSON), cycles findings → fix → review at most twice, then Needs Attention; green → Review awaiting Acceptance. Optional `checkCommand` in `.somni/config.json` is the primary deterministic green signal where set.

- **M17 — Selectable Methodology.** The workflow half of Phase 3 becomes a per-repo choice ([adr/0002](../docs/adr/0002-methodology-neutral-items.md)): `methodology: pocock | superpowers` in settings (global default, `.somni/config.json` override) selects between Matt Pocock's workflow and [obra/superpowers](https://github.com/obra/superpowers). Items, the Ready gate, the Interview UI and the `somni-*` fences are methodology-neutral; the setting swaps the grooming charter, the run discipline prompts, and which pinned skill set (`resources/skills/<methodology>/`) is injected. Pocock runs one process per Subtask; superpowers hands orchestration to the agent — one process per Story executing the whole plan subagent-driven, with somni's review loop as the final gate in both modes.

Each milestone is shippable and exercises the one before it.

### Branch Review (M28)

A finished, green Story earns one more gate before Review: a **Branch Review** grades the whole branch and either clears it for one-click Merge or parks it in Needs Attention with findings. `branchReview.ts` is the pure half (parsing, reviewer selection, diff capping, prompts); the executor's `branchReview()` stage owns the turns and routing — the same split the closing review loop (M16, above) already uses.

**Review-by-embedded-diff.** The review turn's prompt carries everything it needs: the Story's Spec, the subtask prompts, and the branch's `git diff <baseSha>` (an unlocked git read in the worktree — §5's mutex is for mutations — bounded to a 10MB buffer; a git failure grades `ungraded` with the real error rather than failing the run). It is told not to run commands or touch files, and the turn itself carries neither `readOnly` nor `autonomous` — tool-free by prompt alone, not by CLI flag. That's deliberate: an in-worktree read-only review would exclude Codex and Gemini (§5 — `supportsReadOnly` has no verified lever for either), and Branch Review's whole point is a second opinion from a provider *different* from the implementer, so all four runners have to stay eligible.

**Reviewer selection** (`pickReviewer`). Default: the first provider-chain member that isn't the implementer — `implementerOf` takes the majority runner across the Story's subtask runners, ties going to first seen — and is available; nobody-else-available falls back honestly to the same provider with `sameProvider` noted, rather than manufacturing a second opinion that isn't one. `Settings.reviewer` pins a runner/model/effort outright (an `'auto'` pin falls through to this same default); a pinned-but-cooling reviewer waits its turn like any other pinned turn — no free failover for this one seat.

**One fix round.** `needs-work` — including a malformed or missing `` ```somni-review `` fence, which parses as `needs-work` too (the §10 "malformed is red" precedent) — buys exactly one fix turn, pinned to the *implementer* rather than the run's default profile, then `checkCommand` if configured (authoritative: a failing check overrides whatever the fix turn claims), then one re-review by the same reviewer over a freshly recomputed diff. `reject` on the first review skips the fix round outright. Final grade routes `approve`/`ungraded` → Review, `needs-work`/`reject` → Needs Attention with findings; a fix turn that never completes parks with the *original* findings rather than inventing new ones.

**Ungraded never blocks.** A review that couldn't run at all — dead turn, no reply — grades `ungraded` with the TaskRun's own error folded into `reasons`, and `ungraded` lands the run exactly like `approve` does: a review outage never holds a finished, green branch hostage. It just shows no Merge button.

**Merge** (`runs:merge`). Gated server-side on `review.grade === 'approve'` even though the UI only ever offers the button then. Refuses first, before the dirty-tree check, if the run's branch no longer exists (`git rev-parse --verify <run.branch>`) — `'branch was cleaned up — nothing to merge'` (M29) — since Cleanup or a by-hand branch delete makes the dirty check moot. The dirty-tree check excludes `.somni/` (pathspec `:!.somni`) so somni's own bookkeeping churn never blocks merging the user's code, whether `.somni/` is gitignored or committed. A plain `git merge --no-edit <run.branch>` lands onto whatever branch is currently checked out — never one somni picks — aborts and returns the verbatim conflicting-file list on conflict, leaving the repo exactly as it was; success stamps `review.merged` (an ISO timestamp) through `saveRun`. Cleanup and Acceptance are unrelated actions; Merge touches neither.

**Recorded ceilings:**
- `DIFF_CAP` (150,000 chars) keeps whole-file hunks until the cap and names the dropped files in the prompt instead of truncating mid-hunk, so a large branch still gets a reviewer that knows what it didn't see (`diffTruncated` rides along on the grade) — not a silently partial read.
- **The reviewed diff can include uncommitted worktree changes; Merge takes committed history only.** The review turn's diff is a plain working-tree `git diff <baseSha>` in the worktree, so anything left uncommitted there at review time rides along with it; `runs:merge`'s `git merge --no-edit <run.branch>` only ever brings across what's actually committed to `run.branch`. Rare in practice on a green run — nothing walks away from a finished task leaving work uncommitted — but nothing enforces the two staying in sync; recorded as a known gap (M29), not closed.

Board grades were session-scoped until M29: the Board's Review-column grade chip now reads a `runs` prop seeded from `listRuns(repo)` on every repo load/refresh, merged under whatever the live pipeline has already pushed (a live push always wins over the disk seed) — a run graded in an earlier session shows its grade on the Board too, matching Runs & Reports.

## 10. Risks & open questions

- **`--dangerously-skip-permissions` is genuinely dangerous.** Worktrees contain *file* changes, not shell side effects — a task can still run arbitrary commands, install packages, or hit the network. Mitigation for v1: personal machine, personal repos, review-in-the-morning workflow. macOS sandboxing (`sandbox-exec`, containers) is a future hardening option, not v1 scope.
- **Max plan limits.** Overnight fan-out will hit 5-hour usage windows. The pause/backoff behavior is the core mitigation; default concurrency should be modest (2–3). Draft-with-AI chat turns share the same usage windows — fine for drafting, worth remembering right before an overnight run.
- **The Mac must stay awake.** `powerSaveBlocker` prevents app suspension, but lid-closed sleep needs user-side energy settings or `caffeinate` — document in the README.
- **Hung tasks** are covered by the per-task timeout.
- **Prompt quality is the real ceiling.** Unattended runs live or die on task prompts and role preambles; the Design → Implement → Test → Revise → Report shape from the brief is the template to encourage. Since M18, `ensureSomni` seeds seven default SDLC roles (architect, developer, tester, reviewer, tech-writer, devops, security) into a fresh repo's `.somni/roles/` — only while the roles dir has never existed, so deletions and edits stick.
- **Merge-back was manual by design, until M28.** The app still only creates branches — nothing merges without a Branch Review grade of `approve` and a user click; a `needs-work`/`reject`/`ungraded` run, or one you'd rather inspect first, still merges by hand exactly as before.
- **Antigravity CLI is young; Gemini CLI is unpinned.** `agy` shipped mid-2026 and its flags may drift; the adapter pins exact flags at M7 implementation against the live docs. Gemini's adapter (M26 §5) is written from docs alone — no `gemini` install has verified it live yet. CI-style smoke checks of the runners' output parsing guard against CLI updates breaking overnight runs. Rate-limit and auth detection are per-adapter regexes (Anthropic, Google, and OpenAI error shapes all differ) — Codex's and Gemini's are inferred, not observed live, per §5.
- **One machine at a time.** `.somni/` sync is via git, so running pipelines for the same repo on two machines concurrently is unsupported (last-writer-wins on `run.json`). Run overnight on one machine; review anywhere.
- **Green-detection is the fragile joint (Phase 3).** `claude -p` exits 0 even when the work is bad, and a fenced verdict in a nondeterministic reply can be malformed or optimistic. A configured `checkCommand` is the primary deterministic signal; the verdict block is advisory. Without either, "green" means "the agent said so" — reports state that plainly. (`checkCommand` is arbitrary shell run in the worktree — the same trust boundary as autonomous task execution itself, and repo-level config the user writes; noted, not mitigated.)
- **Skills injection touches repos somni doesn't own (Phase 3).** Mitigated by manifest-scoped writes only, never overwriting non-somni files, CONTEXT.md stubbed only-if-absent, and upgrades always deliberate. Antigravity cannot read `.claude/skills/`, so implement-stage roles default to the claude runner; inlining skill bodies into agy prompts is the noted upgrade path, not built.
