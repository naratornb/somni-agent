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
- `better-sqlite3` in the main process gives synchronous, zero-config local persistence.

Stack: **Electron + TypeScript + React + Vite + better-sqlite3**, scaffolded with `electron-vite`.

## 2. High-level architecture

Standard two-process split:

- **Main process** — owns everything stateful: the SQLite store, the orchestrator (scheduler + process supervisor), worktree manager, report generator, and settings. Plain TS modules — no separate daemon. The window can be closed to the tray while main keeps running overnight; `powerSaveBlocker.start('prevent-app-suspension')` is held while a pipeline runs.
- **Renderer** — React UI. Talks to main via `contextBridge`-exposed IPC: `ipcRenderer.invoke` for CRUD/commands, `webContents.send` push events for status changes and log lines. The renderer holds no business logic; it renders DB state plus live events.

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
│  WorktreeManager   SQLite (better-sqlite3)      │
└─────────────────────────────────────────────────┘
```

## 3. Orchestration engine

**Scheduling.** A pipeline run captures the checkbox-selected workflows/tasks. The runnable set at any moment = the first not-yet-completed task of each selected workflow whose predecessors have all completed. Loop: while `running < maxConcurrency` and runnable tasks exist, spawn the next (FIFO by workflow order). This yields sequential-within-workflow, parallel-across-workflows with no extra machinery. Every state transition is written to SQLite *before* it is acted on, so the DB is always the source of truth.

**Worktree isolation.** On workflow start:

```
git -C <repo> worktree add <appData>/worktrees/<runId>-<slug> -b somni/<slug>-<yyyymmdd>
```

All of the workflow's tasks share that worktree, so each task sees the previous task's files and git state. Worktrees are kept after the run for morning review; a "Clean up" action removes merged/abandoned ones (`git worktree remove` + branch delete).

**Process supervision.** One `child_process.spawn` per running task, `cwd` = the worktree. Stdout is parsed as stream-json events; raw output is also appended to a per-task log file. Completion is detected from the CLI's final `result` event (subtype `success`/`error`) plus the exit code. A per-task **timeout** setting (default 30 min) kills hung processes via `SIGTERM` then `SIGKILL`.

**Failure & retry.** A task fails on nonzero exit, an error `result`, or timeout → one automatic retry as a fresh invocation in the same worktree. Second failure → task `Failed`, the workflow's remaining tasks `Skipped`, workflow `Failed`; other workflows are unaffected. **Rate-limit errors are special-cased:** instead of burning the retry, the whole pipeline enters `Paused` and re-attempts on a backoff timer — this is what makes an overnight run survive Max-plan 5-hour usage windows.

**Crash/quit recovery.** On launch, if a pipeline run is still marked `Running` in SQLite, orphaned `Running` tasks are reset to `Queued`. Their worktree holds whatever the dead process left behind — acceptable, because task prompts are stated as goals, not diffs, so a re-run continues from the current files. The user is offered **Resume pipeline** / **Abandon**.

## 4. Data model

SQLite (better-sqlite3) in Electron's `userData` directory.

```
roles          id, name, preamble, created_at
workflows      id, name, repo_path, position, selected      -- selected = pipeline checkbox
tasks          id, workflow_id, position, title, prompt, role_id, selected
pipeline_runs  id, status, concurrency, started_at, finished_at
workflow_runs  id, pipeline_run_id, workflow_id, status, worktree_path, branch,
               started_at, finished_at
task_runs      id, workflow_run_id, task_id, attempt, status, session_id,
               exit_code, cost_usd, log_path, started_at, finished_at
reports        workflow_run_id, style, stats_json, summary_md
settings       key, value    -- concurrency, claude_path, report_style, task_timeout_min
```

Statuses: `Queued / Running / Completed / Failed / Skipped / Cancelled`, plus `Paused` at the pipeline level for rate-limit waits. Definitions (workflows/tasks/roles) are deliberately separate from executions (`*_runs`) so history survives edits and re-runs.

## 5. `claude` CLI invocation

```
claude -p --output-format stream-json --verbose \
  --dangerously-skip-permissions \
  "<role preamble>\n\n---\n\n<task prompt>"
```

- `cwd` = the workflow's worktree.
- Role context is simply the role's preamble prepended to the task prompt — no system-prompt flags needed.
- Parsed from stream-json: `session_id` (stored per task_run for debugging and `--resume`), assistant text deltas (live log view), and the final `result` event → success/error, `total_cost_usd`, duration.
- Rate-limit conditions are detected from the error result payload and trigger the pipeline pause/backoff described above.

## 6. Summary reports — `Report style` setting

| Style | Cost | Content |
|---|---|---|
| **Minimal** | zero tokens | App-computed: `git diff --stat` vs branch base, files created/modified counts, test files/cases added (heuristic: diff over `*test*`/`*spec*` paths), per-task durations, per-task `cost_usd`. |
| **Compact** | one short call | Minimal + a single `claude -p` call that turns the task transcripts into a prose summary paragraph. |
| **Full** | one full task | Minimal + an auto-appended "Report" task run inside the worktree with full context. |

Reports are stored per workflow run and rendered in the Runs & Reports view.

## 7. UI / screen breakdown

Sidebar navigation, five views:

1. **Workflows** — list with per-workflow pipeline checkboxes. Click into the **Workflow editor**: ordered task list (drag to reorder), each task = title, prompt, role dropdown, checkbox; repo picker for the workspace.
2. **Roles** — CRUD library of `name` + `preamble`.
3. **Pipeline** — the dashboard: selected workflows as cards, each task a chip colored by status, overall progress bar, **Run / Pause / Cancel**. Click any running task → **live log pane** (streamed stdout tail).
4. **Runs & Reports** — history of pipeline runs; per-workflow report (stats table + summary); links to the worktree/branch for review.
5. **Settings** — max concurrency, claude binary path, **report style (Minimal / Compact / Full)**, task timeout.

## 8. Phased build plan

- **M0 — Walking skeleton.** electron-vite scaffold; one button that spawns a hardcoded `claude -p` and streams its output into the window. Proves the entire risky path: spawn, stream-json parsing, completion detection.
- **M1 — Definitions.** SQLite schema; Roles and Workflows/Tasks CRUD UI.
- **M2 — Single workflow run.** Worktree creation, sequential task execution, persisted statuses, per-task log files.
- **M3 — Pipeline.** Checkboxes, multi-workflow concurrency, dashboard, live log streaming.
- **M4 — Unattended reliability.** Retry-once/halt policy, timeouts, rate-limit pause/backoff, crash resume, powerSaveBlocker, cancel.
- **M5 — Reports, settings, polish.** Three report styles, run history, worktree cleanup.

Each milestone is shippable and exercises the one before it.

## 9. Risks & open questions

- **`--dangerously-skip-permissions` is genuinely dangerous.** Worktrees contain *file* changes, not shell side effects — a task can still run arbitrary commands, install packages, or hit the network. Mitigation for v1: personal machine, personal repos, review-in-the-morning workflow. macOS sandboxing (`sandbox-exec`, containers) is a future hardening option, not v1 scope.
- **Max plan limits.** Overnight fan-out will hit 5-hour usage windows. The pause/backoff behavior is the core mitigation; default concurrency should be modest (2–3).
- **The Mac must stay awake.** `powerSaveBlocker` prevents app suspension, but lid-closed sleep needs user-side energy settings or `caffeinate` — document in the README.
- **Hung tasks** are covered by the per-task timeout.
- **Prompt quality is the real ceiling.** Unattended runs live or die on task prompts and role preambles; the Design → Implement → Test → Revise → Report shape from the brief is the template to encourage.
- **Merge-back is manual by design.** The app creates branches; you merge. Auto-merge is out of scope for v1.
