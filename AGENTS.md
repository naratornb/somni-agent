# AGENTS.md — somni

## What this is

**somni** is a macOS desktop app (Electron) that orchestrates parallel, unattended `claude` CLI runs: workflows of ordered tasks, each with a role/persona, executed overnight in isolated git worktrees.

- Requirements: [design/design.md](design/design.md)
- Approved technical design: [design/architecture.md](design/architecture.md) — **source of truth**. If a decision must change, update that doc in the same PR; never silently diverge from it.

## Stack

Electron + TypeScript (strict) + React + Vite (electron-vite). No database — persistence is plain files. No new dependencies without strong justification — prefer stdlib/Node/platform features.

## Architecture rules (non-negotiable)

- All business logic lives in the **main process**. The renderer only renders stored state and IPC events — no logic.
- IPC: `ipcRenderer.invoke` for commands/CRUD; `webContents.send` push events for status changes and log lines; everything exposed through `contextBridge`.
- **`<repo>/.somni/` files are the source of truth** (layout in architecture.md §4: `roles/*.md`, `workflows/*.json`, `runs/<id>/run.json` + logs + report). Write every state transition with an atomic temp-write-then-rename *before* acting on it. The in-memory scheduler is derived state, never authoritative; external file edits are picked up on refresh.
- Definitions (`roles/`, `workflows/`) stay separate from executions (`runs/`). Raw logs are gitignored via a somni-maintained `.somni/.gitignore`; machine-specific settings and worktrees stay in Electron `userData`.
- Statuses: `Queued / Running / Completed / Failed / Skipped / Cancelled`; pipeline additionally `Paused`.
- Worktrees live under `<appData>/worktrees/`; branches are named `somni/<slug>-<yyyymmdd>`.
- Rate-limit errors **pause the pipeline** with backoff — they do not consume a task's single retry.
- The orchestrator stays one small boring module: no job-queue libraries, no worker threads.
- **All runner differences (claude vs antigravity) live behind the Runner adapter** (architecture.md §5: `buildArgs`/`parseLine`). Nothing outside an adapter may branch on runner type. Execution profile `{runner, model, effort}` resolves role → repo config → global settings.

## Working style (Karpathy guidelines)

1. **Think before coding.** State assumptions explicitly. If the design doc is ambiguous, or a simpler approach exists, say so before implementing — don't pick silently.
2. **Simplicity first.** Minimum code that completes the current milestone. No speculative abstractions, no unrequested configurability, no error handling for impossible cases.
3. **Surgical changes.** Touch only what the task requires. Match existing style. Remove orphans your own change created; leave pre-existing code alone unless asked.
4. **Goal-driven execution.** Before coding, state a verifiable success criterion (e.g. M0: "click button → live claude output streams into the window → final result event parsed"). Non-trivial logic ships with one minimal check/test. Loop until verified.

## Team — multi-agent approach

Non-trivial work is executed by the agent team defined in [design/team.md](design/team.md): the main session acts as **Technical Director** (briefs, reviews, green-lights) and spawns the project agents in `.claude/agents/` — `fullstack-engineer` (implements), `tester` (verifies), `ux-designer` (UI tasks). The TD sizes the work first and staffs per the tiers in design/team.md — often a single engineer for small tasks, the full roster only when scope/risk warrants it; trivial mechanical changes need no agents at all.

## Commit messages

- Format: `<milestone or area>: <what changed>` in imperative mood, matching existing history (e.g. `M2: single workflow run in an isolated worktree`, `Design: runner abstraction`).
- Subject ≤ 72 chars; body (when needed) explains *why* and any decisions/trade-offs, not a file list.
- One logical change per commit; each commit should build and pass tests.
- **No AI attribution** — never add `Co-Authored-By: Claude`, "Generated with Claude Code", or similar trailers.

## Commands

```
npm run dev     # launch app in dev mode (HMR)
npm run build   # typecheck + production build
npm test        # vitest unit checks
npm run lint    # eslint
```

## Status & roadmap

**Current milestone: M5 done** (reports, settings, run history, worktree cleanup: global settings in userData `settings.json` (`concurrency`/`timeoutMinutes`/`reportStyle`/`model`/`effort`) with per-repo `.somni/config.json` overrides and role `---model:/effort:---` frontmatter, resolved role → repo → global in `src/main/store.ts` (`resolveSettings`/`resolveProfile`) and applied per task in the executor (`--model`/`--effort` on the spawn, recorded on each TaskRun); `src/main/report.ts` writes `runs/<id>/report.md` on Completed *and* Failed runs — minimal (git diff vs the run's `baseSha`, created/modified counts, test files, per-task status/duration/cost), compact (+ one read-only `claude -p` summary), full (+ an autonomous Report task appended to run.json); Runs & Reports view (`runs:list`/`runs:report`) and `runs:cleanup` (`git worktree remove` + `git branch -d`, errors surfaced, never forced); Settings view. Earlier: M4 unattended reliability — retry-once-then-halt, per-task timeout SIGTERM→SIGKILL, rate-limit pipeline pause with backoff, crash resume, powerSaveBlocker. M3 pipeline — FIFO worker pool, serialized `git worktree add`, PipelineView dashboard.) Next: M6 — AI workflow drafting (§7). Phased plan M0–M6 is in [design/architecture.md §9](design/architecture.md). When a milestone lands, update this line and the Commands section.
