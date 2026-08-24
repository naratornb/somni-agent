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

**Scheduling.** A pipeline run captures the checkbox-selected workflows/tasks. The runnable set at any moment = the first not-yet-completed task of each selected workflow whose predecessors have all completed. Loop: while `running < maxConcurrency` and runnable tasks exist, spawn the next (FIFO by workflow order). This yields sequential-within-workflow, parallel-across-workflows with no extra machinery. Every state transition is written to the run's `run.json` (atomic write-temp-then-rename) *before* it is acted on, so the files are always the source of truth.

**Worktree isolation.** On workflow start:

```
git -C <repo> worktree add <appData>/worktrees/<runId>-<slug> -b somni/<slug>-<yyyymmdd>
```

All of the workflow's tasks share that worktree, so each task sees the previous task's files and git state. Worktrees are kept after the run for morning review; a "Clean up" action removes merged/abandoned ones (`git worktree remove` + branch delete).

**Process supervision.** One `child_process.spawn` per running task, `cwd` = the worktree. Stdout is parsed as stream-json events; raw output is also appended to a per-task log file. Completion is detected from the CLI's final `result` event (subtype `success`/`error`) plus the exit code. A per-task **timeout** setting (default 30 min) kills hung processes via `SIGTERM` then `SIGKILL`.

**Failure & retry.** A task fails on nonzero exit, an error `result`, or timeout → one automatic retry as a fresh invocation in the same worktree. Second failure → task `Failed`, the workflow's remaining tasks `Skipped`, workflow `Failed`; other workflows are unaffected. **Rate-limit errors are special-cased:** instead of burning the retry, the whole pipeline enters `Paused` and re-attempts on a backoff timer — this is what makes an overnight run survive Max-plan 5-hour usage windows.

**Crash/quit recovery.** On launch, if a repo's latest `runs/<id>/run.json` is still marked `Running`, orphaned `Running` tasks are reset to `Queued`. Their worktree holds whatever the dead process left behind — acceptable, because task prompts are stated as goals, not diffs, so a re-run continues from the current files. The user is offered **Resume pipeline** / **Abandon**.

## 4. Data model — the `.somni/` file store

All per-repo state lives **inside the target repo** at `<repo>/.somni/` as plain files: transparent (reviewable, diffable) and portable — clone the repo on another machine, open somni, and your workflows and history are there. No database.

```
.somni/
  .gitignore            # maintained by somni: ignores runs/*/logs/
  config.json           # optional per-repo overrides (report_style, concurrency, timeout)
  roles/<slug>.md       # role preamble as Markdown; H1 = display name
  workflows/<slug>.json # name, ordered tasks (title, prompt, role, selected)
  chats/<slug>.jsonl    # "Draft with AI" transcript for that workflow (committable)
  runs/<runId>/
    run.json            # execution state: pipeline/workflow/task statuses, attempts,
                        # session_ids, timestamps, cost, exit codes — crash-resume source of truth
    logs/<task>.jsonl   # raw stream-json CLI output (gitignored — large)
    report.md           # the summary report (committable)
```

- **Committable**: definitions, `run.json`, reports — commit `.somni/` for cross-machine continuity. **Gitignored**: raw logs (somni writes `.somni/.gitignore` itself).
- Roles are Markdown because preambles are prose; workflows are JSON because they're structured.
- Writes are atomic (write temp file, rename). The files are authoritative: external edits — a `git pull`, hand-editing a workflow — are picked up on app refresh.
- Definitions (`roles/`, `workflows/`) are deliberately separate from executions (`runs/`) so history survives edits and re-runs.

Statuses: `Queued / Running / Completed / Failed / Skipped / Cancelled`, plus `Paused` at the pipeline level for rate-limit waits.

**App-level state** (Electron `userData`, machine-specific): global settings (claude path, default concurrency, default report style, task timeout), the list of known repos, and worktrees under `<appData>/worktrees/` — worktrees are disposable local build artifacts; the `somni/…` branches are the portable part.

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

Reports are written to `runs/<runId>/report.md` (with stats alongside in `run.json`) and rendered in the Runs & Reports view.

## 7. AI workflow drafting ("Draft with AI" chat)

A chat button in the workflow editor lets you yap a rough idea; an assistant refines it into a complete technical brief and populates the workflow's tasks. It reuses the task runner rather than adding a chat stack:

- **Each chat turn is the same spawn path as task execution**: `claude -p <message> --output-format stream-json --verbose`, with `--resume <session_id>` from the second turn on. No API calls, no new dependency; uses the Max plan.
- `cwd` = the target repo, tools restricted to read-only via `--allowedTools "Read,Glob,Grep"` and **no** `--dangerously-skip-permissions` — the assistant can inspect the actual codebase while refining the brief, but cannot change anything.
- A fixed drafting preamble is prepended: interview briefly, then propose a workflow; whenever proposing, end the reply with a fenced ` ```somni-workflow ` JSON block matching the `workflows/<slug>.json` schema.
- The app parses the last such block into a **proposal preview** (task cards) with **Apply / Dismiss**. Apply merges it into the open workflow definition (atomic write, like all `.somni/` writes). The chat itself never writes files — Apply is the only mutation, and it is user-triggered.
- The transcript persists to `.somni/chats/<workflow-slug>.jsonl` so drafting context survives sessions and machines; "New chat" starts a fresh session.

## 8. UI / screen breakdown

Sidebar navigation, five views:

1. **Workflows** — list with per-workflow pipeline checkboxes. Click into the **Workflow editor**: ordered task list (drag to reorder), each task = title, prompt, role dropdown, checkbox; repo picker for the workspace; **Draft with AI** button → side chat panel (message list, input, streaming reply, proposal preview with Apply/Dismiss; disabled while the workflow is running in a pipeline).
2. **Roles** — CRUD library of `name` + `preamble`.
3. **Pipeline** — the dashboard: selected workflows as cards, each task a chip colored by status, overall progress bar, **Run / Pause / Cancel**. Click any running task → **live log pane** (streamed stdout tail).
4. **Runs & Reports** — history of pipeline runs; per-workflow report (stats table + summary); links to the worktree/branch for review.
5. **Settings** — max concurrency, claude binary path, **report style (Minimal / Compact / Full)**, task timeout.

## 9. Phased build plan

- **M0 — Walking skeleton.** electron-vite scaffold; one button that spawns a hardcoded `claude -p` and streams its output into the window. Proves the entire risky path: spawn, stream-json parsing, completion detection.
- **M1 — Definitions.** `.somni/` file store (read/write, atomic saves, `.gitignore` bootstrap); Roles and Workflows/Tasks CRUD UI.
- **M2 — Single workflow run.** Worktree creation, sequential task execution, persisted statuses, per-task log files.
- **M3 — Pipeline.** Checkboxes, multi-workflow concurrency, dashboard, live log streaming.
- **M4 — Unattended reliability.** Retry-once/halt policy, timeouts, rate-limit pause/backoff, crash resume, powerSaveBlocker, cancel.
- **M5 — Reports, settings, polish.** Three report styles, run history, worktree cleanup.
- **M6 — AI workflow drafting.** The "Draft with AI" chat (§7). Depends only on M0's spawn/parse and M1's file store, so it can be pulled earlier if wanted.

Each milestone is shippable and exercises the one before it.

## 10. Risks & open questions

- **`--dangerously-skip-permissions` is genuinely dangerous.** Worktrees contain *file* changes, not shell side effects — a task can still run arbitrary commands, install packages, or hit the network. Mitigation for v1: personal machine, personal repos, review-in-the-morning workflow. macOS sandboxing (`sandbox-exec`, containers) is a future hardening option, not v1 scope.
- **Max plan limits.** Overnight fan-out will hit 5-hour usage windows. The pause/backoff behavior is the core mitigation; default concurrency should be modest (2–3). Draft-with-AI chat turns share the same usage windows — fine for drafting, worth remembering right before an overnight run.
- **The Mac must stay awake.** `powerSaveBlocker` prevents app suspension, but lid-closed sleep needs user-side energy settings or `caffeinate` — document in the README.
- **Hung tasks** are covered by the per-task timeout.
- **Prompt quality is the real ceiling.** Unattended runs live or die on task prompts and role preambles; the Design → Implement → Test → Revise → Report shape from the brief is the template to encourage.
- **Merge-back is manual by design.** The app creates branches; you merge. Auto-merge is out of scope for v1.
- **One machine at a time.** `.somni/` sync is via git, so running pipelines for the same repo on two machines concurrently is unsupported (last-writer-wins on `run.json`). Run overnight on one machine; review anywhere.
