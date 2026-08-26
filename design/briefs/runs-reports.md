# Runs & Reports — exact mock delivery — Execution Brief

## Context

M10 reskinned the Runs view directionally; the `runs_reports` mock ([code.html](../stitch_somni_ai_orchestrator/runs_reports/code.html) / [screen.png](../stitch_somni_ai_orchestrator/runs_reports/screen.png)) designs features the app doesn't have: metric tiles (Duration / Cost / Tokens Prompt / Tokens Comp.), an Implementation Summary panel, a per-file Files Changed list, and Switch to Branch / Worktree actions. None of the data or backends exist: both runner parsers discard token usage, per-file diff data is flattened into report.md, and there is no shell-reveal or git-switch IPC. This PR delivers the mock exactly. Full decision detail in the PO-approved plan; the rulings are logged below.

## Goal & success criteria

- A completed run's expanded card matches the mock: four tiles, Summary panel, Files Changed list with `+`/`~` markers and line counts, Switch to Branch (primary) / Worktree / Clean up actions; task table collapsed in a `<details>`; no raw report pane, no bare worktree path.
- New runs persist structured `stats` in run.json; old runs get live-computed stats while their worktree exists, em-dashes after cleanup.
- Switch to Branch refuses a dirty target repo with a clear inline error and succeeds on a clean one; Worktree reveals the folder in Finder; both disable when their target is gone.
- `npm test` / `typecheck` / `lint` / `build` green.

## Staffing

Engineer + tester. No designer — the mock is the design.

## Scope

### Engineer

In dependency order (file:line pointers verified during planning):

1. **Token plumbing.** `StreamEvent` result variant (`src/main/stream.ts:7`) gains `promptTokens?`/`completionTokens?`. claude `parseLine` (`src/main/runners.ts:64-73`): `promptTokens = usage.input_tokens + cache_creation_input_tokens + cache_read_input_tokens`, `completionTokens = usage.output_tokens`. antigravity `parseLine` (`runners.ts:112-128`): parse agy's token fields — pin names against the installed CLI, don't guess. `TaskRun` (`src/main/executor.ts:44`) gains both; store beside `costUsd`/`durationMs` (`executor.ts:544-548`).
2. **Structured stats.** `collectStats` (`src/main/report.ts:71-79`) adds `git diff --numstat`; keep per-file `{path, kind: 'A'|'M'|'D', lines}`. `RunState` (`executor.ts:60`) gains `stats?: RunStats` `{files, created, modified, totalCostUsd, promptTokens, completionTokens}`, written into run.json at report time (implements architecture.md:158's existing claim).
3. **IPC.** `runs:details` (persisted stats → live compute while `worktreeExists` → `null`); `runs:switchBranch` (dirty `status --porcelain` → `{ok:false, error}`; missing branch → error; else `git switch`; reuse `lockedGit` like `runs:cleanup` at `repoIpc.ts:110-125`); `runs:revealWorktree` (`shell.showItemInFolder`, guarded); `listRuns` (`repoIpc.ts:39-52`) adds `branchExists` via `show-ref`. Mirror in `src/preload/index.ts` + `index.d.ts`.
4. **RunsView rebuild** per the mock, reusing `ui.ts` atoms and `statusChip()`: header (end timestamp time-only when same day), tiles (`1m 39s` duration format, `$X.XX` cost, `12.4k` token formatting, em-dash when absent), two-column Summary | Files grid, actions row, collapsed task table. Summary text = the `## Summary` section extracted from report.md renderer-side; when absent show "No summary — report style is Minimal; change it in Settings".
5. **Tests.** `runners.test.ts` token extraction (both parsers, fixture result events); `report.test.ts` numstat parse + stats persistence; `views.test.tsx` RunsView with a stats-bearing fixture. Switch-branch guard unit-tested if the logic is extractable.

Constraints: no behavior change to cleanup; no live run:state subscription in RunsView; preload types stay hand-mirrored (comment at `preload/index.ts:3`).

### Tester

- Live app: full-flow run → expanded card matches the mock; tiles populated; Files Changed matches the actual diff; Summary present under compact style and hint under minimal.
- Actions: switch-branch dirty/clean/deleted-branch cases; Worktree reveal; disabled states after cleanup; old-run fallback (no stats + live worktree → computed; after cleanup → em-dashes).
- Mechanical: full suite, typecheck, lint, build.

## Out of scope

Live run-state refresh in RunsView; ANSI log rendering; backfilling stats for cleaned-up historical runs; changing the default report style; any Pipeline/Workflows changes.

## Verification plan

TD re-runs the suite, drives the built app with the existing Playwright script (scratchpad `shoot-views.mjs` pattern), screenshots the expanded card against `screen.png`, and merges the topic PR.

## Decisions log

- 2026-08-26 — Standalone topic PR stacked on m10-redesign (PR #10 still open); retarget to main when it merges (PO).
- 2026-08-26 — Task table kept, collapsed below Files Changed; raw report pane and worktree-path line dropped (PO).
- 2026-08-26 — Switch to Branch = guarded `git switch` in the target repo; Worktree = reveal in Finder (PO).
- 2026-08-26 — Stats: persist in run.json at report time AND live-compute fallback for old runs while the worktree exists (PO).
- 2026-08-26 — Minimal-style runs show a hint in the Summary panel; default report style unchanged (PO).
- 2026-08-26 — Known limit accepted: `git diff` misses files the agent never staged/committed; documented, not fixed here (TD).
- 2026-08-26 — Landed as `451016d`. Deviations accepted: `branchExists` returned by `runs:details` instead of `listRuns` (keeps listRuns sync; data only the expanded card needs); `RunDetailsPanel` extracted for a real SSR fixture test; agy token fields verified against a live CLI run (`input+cache_read` / `output`, thinking already inside output); Duration tile is wall-clock per the mock's own timestamps (TD).
- 2026-08-26 — Historical runs show em-dash token/cost tiles even while their worktree lives (per-task token fields didn't exist pre-change); consistent with the accepted known-limit framing (TD).
- 2026-08-26 — Permanent `repoIpc.test.ts` added per tester's gap flag (`b85046b`, 8 tests); electron-module mock, real git against temp repos (TD/Engineer).
- 2026-08-26 — Finding: git refuses `switch` while the run's worktree holds the branch, so Switch to Branch always fails on a fresh run. Ruling: disable the button while `worktreeExists` with an explanatory tooltip ("branch is checked out in the run's worktree — Clean up first"); matches the morning-review flow (review → clean up → switch); cleanup-then-switch composite rejected as hiding a destructive step behind a navigation button (TD).
