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

Non-trivial work is executed by the agent team defined in [design/team.md](design/team.md): the main session acts as **Technical Director** (briefs, reviews, green-lights) and spawns the project agents in `.claude/agents/` — `fullstack-engineer` (implements), `tester` (verifies), `ux-designer` (UI tasks). The TD sizes the work first and staffs per the tiers in design/team.md — often a single engineer for small tasks, the full roster only when scope/risk warrants it; trivial mechanical changes need no agents at all. Agent-staffed work executes from an **Execution Brief** at `design/briefs/` (see team.md) — specialists get pointer prompts to it, and it commits with the work's PR.

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

**Current milestone: M9 done** (Backlog & drain (§3): the pipeline is now a drain — `drainLoop` in `src/main/executor.ts` replaced the fixed-set worker pool with one supervisor loop that refills up to `maxConcurrency` from a `next()` callback, races in-flight jobs against `sleepOrWake(pollMs=2000)` (woken instantly by `wakeDrain()` from tick/promote/toggle IPC), and stops when nothing is in flight and it isn't keep-running; `startDrain` supplies the scanning `next` (re-reads `loadRepo` per refill, alphabetical slug order, skips `activeSlugs` so a re-tick runs *after* never concurrently, **consumes the tick via `store.setSelected` before the spawn**, untick failure → per-drain skip set + continue to the next candidate); `resumePipeline` is the same loop over a fixed set, mode `'resume'`, never scans. `DrainMode = manual|nightly|keep|resume`; `getDrainState()` + `pipeline:state` invoke; `pipeline:status` push carries `mode` (null on final Idle), Running/Idle deduped, Paused re-emits fresh `resumeAt`; `setKeepRunning` flips the stop rule in place (module flag, never persisted, cancel clears it; toggle-off sets `stopping` — finish in-flight, pick up nothing). Nightly Window: `nightlyTime`/`nightlyArmed` in global settings (armed survives restart, time survives disarm), `armNightly`/`fireNightly` in `index.ts` (pure `msUntil` in executor; disarm written before draining `lastRepo`; re-armed via `wireRepoIpc(onSettingsChanged)`); `powerSaveBlocker` now follows status pushes (held Running/Paused, released Idle). Backlog: `.somni/backlog.json` ordered slug array (`loadBacklog` prunes missing in memory), IPC `backlog:set`/`backlog:park` (untick+append)/`backlog:promote` (remove+tick+wake); `pipeline:start(repo, slugs)` = tick named slugs + wake or start a manual drain (PipelineView sends `[]`). UI: Workflows gains the ordered Backlog section (ordinal, ↑/↓, Promote; parked rows excluded from the main list, no tick) and per-row "To backlog"; Pipeline shows "▶ Drain queue", the Keep Running checkbox, mode-labeled chips ("Draining — waiting for work" when idling) and latest-run-wins cards; Settings gains the Nightly row (time + Armed/Disarmed chip). Briefs: `design/briefs/M9.md` / `M9-ui.md`.) Earlier: M8 Brief-first drafting (§7): the Interview discipline lives in `draftPreamble` (one fenced ```` ```somni-question ```` block per reply — `{question, options, recommended}`, parsed by `parseQuestion` beside the shared `lastBlock` fence helper, malformed blocks degrade to plain text) and the proposal widened to `{name, brief, tasks, roles}` (`parseRoles`: one invalid role rejects the whole proposal); `applyProposal` in `chat.ts` (IPC `proposal:apply`) is now the single mutation out of any chat — writes only new-slug roles (existing role always wins), writes the Brief sidecar `workflows/<slug>.brief.md` (absent brief leaves it alone), draft Apply creates a ticked workflow with a uniquified slug and renames `chats/_draft.jsonl` → `chats/<slug>.jsonl`, editor Apply preserves the tick, refused while that key's turn is in flight; `deleteWorkflow` removes json + brief + transcript (a reused slug must not inherit a dead session); the chat guard is per-workflow via the executor's `activeSlugs` (`isRunning(slug)`, resume-aware) so `_draft` and idle workflows chat during a pipeline; `ChatEvent.done` carries the parsed `question`; editor chats prepend the stored Brief to turn-1 context. UI: **Draft** sidebar view (`DraftView.tsx`, full-page `_draft` interview with always-visible Propose Now — the fixed transcript-visible `PROPOSE_NOW` message), shared `chatShared.tsx` (`QuestionCard` with recommended-highlighted chips that send on click, `ProposalPreview` with collapsed Brief, task cards, new-role cards incl. the "already exists — will reuse" badge), consume-once `openSlug` handoff into the workflow editor after Apply, and a read-only collapsed Brief `<details>` in the editor. Execution brief + accepted UI spec: `design/briefs/M8.md` / `M8-ui.md`.) Earlier: M7 Runner adapter + Antigravity (§5): `src/main/runners.ts` holds the whole runner surface — `Runner {name, binary, binarySetting, buildArgs(prompt, {model, effort, resumeSessionId, readOnly, autonomous}), parseLine, isRateLimit}` — and `getRunner(name, settings)` is the only name→adapter map (unknown name falls back to claude; `settings.claudeBinary`/`antigravityBinary` override the binary, empty = PATH). `claudeRunner` folds in the old executor/`turnArgs`/report argv plus the ex-`stream.ts` parser and the ex-executor RATE_LIMIT regex; `antigravityRunner` is `agy -p --output-format stream-json` with `--mode plan` (read-only), `--dangerously-skip-permissions` (autonomous), `--conversation <id>` (resume), `--model`/`--effort`, parsing agy's `{event: init|step_update|result}` envelope (no cost — agy reports tokens only) and Google's quota/RESOURCE_EXHAUSTED wording; all flags pinned against the installed CLI, not guessed. `stream.ts` is now just `feed(buffer, chunk, parseLine)`; `runner.ts` exposes `spawnRunner(runner, args, …)`; executor/chat/report/Playground are runner-agnostic and the rate-limit pause asks `runner.isRateLimit`. Profile gains `runner` (role frontmatter `runner:` → `.somni/config.json` → global, default claude) via `resolveProfile`; `TaskRun.runner` records it, resolved once per task so a retry can never switch runners. Settings view: runner dropdown + per-runner binary paths (ponytail: one free-text model field, no per-runner model lists); role editor: runner select (inherit). Both CLIs support resume, so §5's chat→ClaudeRunner fallback was unnecessary. Earlier: M6 AI workflow drafting — "Draft with AI" (§7): `src/main/chat.ts` runs one read-only chat session per workflow slug over the existing `spawnClaude` path (`--allowedTools "Read,Glob,Grep"`, never `--dangerously-skip-permissions`, cwd = the repo, `--resume <sessionId>` from turn two, repo→global `--model`/`--effort`); a fixed drafting preamble listing the repo's role slugs is prepended to the first turn; transcripts append to `.somni/chats/<slug>.jsonl` (message lines + sessionId, "New chat" clears both); `parseProposal` extracts the last ```` ```somni-workflow ```` block (closing fence anchored to line start) and validates it; IPC `chat:load`/`chat:send`/`chat:new` with `chat:event` push (text/done/error), one in-flight turn per slug, refused while a pipeline runs, killed on before-quit. `DraftChatPanel` is a 340px column in the workflow editor: streaming bubbles, pinned proposal preview with Apply/Dismiss — Apply is the only write and goes through the existing `workflow:save`. Earlier: M5 reports, settings, run history, worktree cleanup — global settings in userData `settings.json` (`concurrency`/`timeoutMinutes`/`reportStyle`/`model`/`effort`) with per-repo `.somni/config.json` overrides and role `---model:/effort:---` frontmatter, resolved role → repo → global in `src/main/store.ts` (`resolveSettings`/`resolveProfile`) and applied per task in the executor (`--model`/`--effort` on the spawn, recorded on each TaskRun); `src/main/report.ts` writes `runs/<id>/report.md` on Completed *and* Failed runs — minimal (git diff vs the run's `baseSha`, created/modified counts, test files, per-task status/duration/cost), compact (+ one read-only `claude -p` summary), full (+ an autonomous Report task appended to run.json); Runs & Reports view (`runs:list`/`runs:report`) and `runs:cleanup` (`git worktree remove` + `git branch -d`, errors surfaced, never forced); Settings view. Earlier: M4 unattended reliability — retry-once-then-halt, per-task timeout SIGTERM→SIGKILL, rate-limit pipeline pause with backoff, crash resume, powerSaveBlocker. M3 pipeline — FIFO worker pool, serialized `git worktree add`, PipelineView dashboard.) Phase-1 milestones M0–M7 are complete; Phase 2 is underway (M8–M9 done; M10 is the whole-app UI redesign, then M11 Refine/models/view modes and M12 voice remain). Phased plan is in [design/architecture.md §9](design/architecture.md). When a milestone lands, update this line and the Commands section.

## Agent skills

### Issue tracker

Issues are tracked as GitHub Issues on naratornb/somni-agent via the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Domain docs

Single-context: `CONTEXT.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.
