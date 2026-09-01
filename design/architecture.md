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

**Failure & retry.** A task fails on nonzero exit, an error `result`, or timeout → one automatic retry as a fresh invocation in the same worktree. Second failure → task `Failed`, the workflow's remaining tasks `Skipped`, workflow `Failed`; other workflows are unaffected. **Rate-limit errors are special-cased:** instead of burning the retry, the whole pipeline enters `Paused` and re-attempts on a backoff timer — this is what makes an overnight run survive Max-plan 5-hour usage windows.

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
  chats/_draft.jsonl    # the one in-progress capture-seeded groom — renamed on Apply
  backlog.json          # ordered item ids = Backlog column priority; missing ids pruned on load
  runs/<runId>/
    run.json            # execution state: pipeline/story/subtask statuses, attempts,
                        # session_ids, timestamps, cost, exit codes — crash-resume source of truth
                        # (the JSON key `workflow` is frozen for v1-run compatibility; it carries the story id)
    logs/<task>.jsonl   # raw stream-json CLI output (gitignored — large)
    report.md           # the summary report (committable)
```

- **Committable**: definitions, items, `run.json`, reports — commit `.somni/` for cross-machine continuity. **Gitignored**: raw logs (somni writes `.somni/.gitignore` itself).
- Items and Roles are Markdown because specs and preambles are prose; subtask sidecars are JSON because they're structured. Frontmatter is parsed by the same hand-rolled parser as roles — no YAML dependency.
- Ids are `SOM-<n>`: fixed prefix, one sequence across all kinds (Jira-style), unpadded — code sorts numerically.
- **Board column = `status`.** The Backlog column is ordered by `backlog.json`; other columns sort by id/recency — no per-file order field, no multi-file rewrites on drag.
- **The Ready gate lives in main**: `item:setStatus` and `pipeline:add` refuse `ready`/pipeline entry unless the Spec body is non-empty and the sidecar has ≥1 selected subtask. The UI hides affordances; main is the authority.
- Writes are atomic (write temp file, rename). The files are authoritative: external edits — a `git pull`, hand-editing an item — are picked up on app refresh.
- Definitions (`roles/`, `items/`) are deliberately separate from executions (`runs/`) so history survives edits and re-runs.

Run statuses: `Queued / Running / Completed / Failed / Skipped / Cancelled`, plus `Paused` at the pipeline level for rate-limit waits. (Item statuses are the board columns above — the two vocabularies never mix.)

**App-level state** (Electron `userData`, machine-specific): global settings (claude path, default concurrency, default report style, task timeout, and the Nightly Window — `nightlyTime` "HH:MM" + `nightlyArmed`, armed state surviving restart, time surviving disarm; it drains the last-opened repo), the list of known repos, and worktrees under `<appData>/worktrees/` — worktrees are disposable local build artifacts; the `somni/…` branches are the portable part. Keep Running is deliberately not persisted.

## 5. Runners & CLI invocation

somni supports two execution backends ("runners"): **Claude Code** (`claude`, Max plan) and **Google Antigravity** (`agy`, headless mode, Google subscription). Which one runs a task — and with what model and effort — is an **execution profile**:

```
{ runner: 'claude' | 'antigravity', model?: string, effort?: 'low'|'medium'|'high' }
```

Resolution order: **role → repo `.somni/config.json` → global settings.** Roles are where "how much brainpower" lives (e.g. Senior Developer → strongest model, high effort; report writing → small fast model); a task gets its role's profile, no per-task knobs. `run.json` and chat transcripts record the profile that ran each task, for reproducibility.

**Runner adapter.** All runner differences live behind one small interface in the main process — nothing else may branch on runner type:

```
Runner {
  buildArgs(prompt, {model, effort, resumeSessionId, readOnly, autonomous}) → argv
  parseLine(line) → {sessionId} | {text} | {result: {ok, costUsd?, durationMs}} | null
}
```

The orchestrator, chat, and stream plumbing are runner-agnostic; each adapter also classifies its own rate-limit error shape for the pipeline pause/backoff.

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

A workflow run's retry always reuses the same profile; runners are never mixed within a retry — the adapter is resolved once per task, outside the attempt loop.

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
- A fixed grooming preamble (turn 1 only — resume carries it) sets the **Interview discipline**: one Question at a time as a fenced ` ```somni-question ` block — `{"question", "options": [...], "recommended"}` — rendered as clickable choices (recommended highlighted), degrading to plain text if malformed. Clicking sends the option text as a normal user turn; the input stays active for custom answers. **Propose Now** is an always-visible button sending a fixed, transcript-visible message that ends the Interview on stated assumptions. The preamble also carries the grooming charter: pick the altitude (big intent → Epic of vertical-slice Stories with blocking edges; small → one Story), Specs with verifiable success criteria, Subtask prompts as goals.
- Whenever proposing, the assistant ends the reply with a fenced ` ```somni-groomed ` JSON block: `{kind, name, spec, stories?, subtasks?, roles?}` — `stories` (epic case) each carry `{name, spec, subtasks, blockedBy?}` where `blockedBy` is index-based over earlier entries in the same array; `roles` are any **new Roles** the subtasks need (`{slug, name, preamble, runner?, model?, effort?}`). A forward/self/out-of-range index — like an invalid role — rejects the whole proposal.
- The app parses the last such block into a **proposal preview** with **Apply / Dismiss**. Apply converts the groomed item in place (id kept; idea → epic|story), creates child Stories with resolved `blockedBy` ids and `.tasks.json` sidecars — **all `ready`** (the epic itself lands `backlog`; it never executes) — and writes only the roles whose slugs don't exist (an existing role always wins). The chat itself never writes files — Apply is the only mutation, and it is user-triggered.
- Entry points: `Groom →` on a Board card (transcript keyed `chats/<id>.jsonl`, first turn seeds the item's name + spec and flips status to `grooming`) and the **Groom view** from scratch (reserved `_draft` key; Apply creates the item(s) and renames the transcript to the root item's id). Grooming-column card clicks resume the interview; StoryPanel stays the hand-edit surface everywhere else.
- Transcripts persist under `.somni/chats/` so grooming context survives sessions and machines; "New chat" starts a fresh session. Grooming is refused for a story currently executing in a pipeline; turns remain read-only spawns.

## 8. UI / screen breakdown

Sidebar navigation, six views:

1. **Board** (M13, home) — the kanban view over the item store: seven status columns (Backlog / Grooming / Ready / In Progress / Needs Attention / Review / Done), cards per item with kind chips ("Idea" for ungroomed captures), drag between columns (a drop the Ready gate refuses bounces back), Backlog ordered by `backlog.json`. Card affordances by column: Groom → (M14), Add to pipeline (Ready), Re-run / Re-groom (Needs Attention), Accept (Review). Click a card → **StoryPanel**: the Spec body plus the ordered subtask editor (title, prompt, role dropdown, selected checkbox). Spec'd in [briefs/M13-ui.md](briefs/M13-ui.md).
2. **Grooming view** (M14; the M8 Draft view re-aimed — hidden during M13) — the interview surface: describe an intent (or open a captured Idea), answer the Interview's question cards, Propose Now anytime; Apply writes the groomed Epic/Stories/Subtasks as Ready items and lands back on the Board.
3. **Roles** — CRUD library of `name` + `preamble`.
4. **Pipeline** — the drain dashboard: queued/running workflows as cards, each task a chip colored by status, overall progress bar, **Drain queue / Cancel** plus the **Keep Running** toggle and the drain mode/status (running, rate-limit paused with resume time, or "draining — waiting for work" while Keep Running idles). Click any running task → **live log pane** (streamed stdout tail).
5. **Runs & Reports** — history of pipeline runs; per-workflow report (stats table + summary); links to the worktree/branch for review.
6. **Settings** — max concurrency, runner binary paths, **default execution profile** (runner dropdown, per-runner model list, effort), **report style (Minimal / Compact / Full)**, task timeout, and the **Nightly Window** (time-of-day + armed toggle with visible armed/disarmed state). Role editor gains optional model/effort override fields.

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

## 10. Risks & open questions

- **`--dangerously-skip-permissions` is genuinely dangerous.** Worktrees contain *file* changes, not shell side effects — a task can still run arbitrary commands, install packages, or hit the network. Mitigation for v1: personal machine, personal repos, review-in-the-morning workflow. macOS sandboxing (`sandbox-exec`, containers) is a future hardening option, not v1 scope.
- **Max plan limits.** Overnight fan-out will hit 5-hour usage windows. The pause/backoff behavior is the core mitigation; default concurrency should be modest (2–3). Draft-with-AI chat turns share the same usage windows — fine for drafting, worth remembering right before an overnight run.
- **The Mac must stay awake.** `powerSaveBlocker` prevents app suspension, but lid-closed sleep needs user-side energy settings or `caffeinate` — document in the README.
- **Hung tasks** are covered by the per-task timeout.
- **Prompt quality is the real ceiling.** Unattended runs live or die on task prompts and role preambles; the Design → Implement → Test → Revise → Report shape from the brief is the template to encourage. Since M18, `ensureSomni` seeds seven default SDLC roles (architect, developer, tester, reviewer, tech-writer, devops, security) into a fresh repo's `.somni/roles/` — only while the roles dir has never existed, so deletions and edits stick.
- **Merge-back is manual by design.** The app creates branches; you merge. Auto-merge is out of scope for v1.
- **Antigravity CLI is young.** `agy` shipped mid-2026 and its flags may drift; the adapter pins exact flags at M7 implementation against the live docs, and CI-style smoke checks of both runners' output parsing guard against CLI updates breaking overnight runs. Rate-limit detection is per-adapter (Anthropic and Google error shapes differ).
- **One machine at a time.** `.somni/` sync is via git, so running pipelines for the same repo on two machines concurrently is unsupported (last-writer-wins on `run.json`). Run overnight on one machine; review anywhere.
- **Green-detection is the fragile joint (Phase 3).** `claude -p` exits 0 even when the work is bad, and a fenced verdict in a nondeterministic reply can be malformed or optimistic. A configured `checkCommand` is the primary deterministic signal; the verdict block is advisory. Without either, "green" means "the agent said so" — reports state that plainly. (`checkCommand` is arbitrary shell run in the worktree — the same trust boundary as autonomous task execution itself, and repo-level config the user writes; noted, not mitigated.)
- **Skills injection touches repos somni doesn't own (Phase 3).** Mitigated by manifest-scoped writes only, never overwriting non-somni files, CONTEXT.md stubbed only-if-absent, and upgrades always deliberate. Antigravity cannot read `.claude/skills/`, so implement-stage roles default to the claude runner; inlining skill bodies into agy prompts is the noted upgrade path, not built.
