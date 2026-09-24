# Branch Review — design

2026-09-24 · Workstream 3 of the commercial revision (runners ✓ → hands-off briefing ✓ → **AI reviewer**)

## Purpose

A run that finishes green still leaves the biggest question unanswered: *should this branch reach the user's main work branch?* Today the user answers it alone, in their own terminal. Branch Review adds a graded second opinion — **approve / needs-work / reject with reasons** — produced by a *different provider* than the one that wrote the code, recorded on the run, surfaced where the merge decision happens, and backed by a one-click (user-triggered, never automatic) Merge for approved branches.

Decisions taken during brainstorming, recorded here:

- **Recommend-only authority** (carried from the M26 brainstorm): the reviewer grades; the user merges. The Merge button is the recommendation and the click in one place — nothing merges without the user's act.
- **Cross-provider review rule** (M26 spec commitment, now implemented): the reviewing turn defaults to a provider different from the implementer — different vendors have uncorrelated blind spots.
- **One automatic fix round on needs-work** (user's explicit choice over park-only): findings feed one bounded fix-and-re-review cycle inside the run before anything parks.
- **Review-by-embedded-diff**, not in-worktree inspection: somni computes the diff and embeds it in the prompt, so the turn needs no tools and **every provider is eligible** — an in-worktree read-only review would exclude codex/gemini (no verified read-only levers, M26) and defeat the cross-provider rule.

## Invariants that must survive

- M16's in-run Review/Fix loop is untouched — it gates task completion; Branch Review grades the merge decision. `checkCommand` remains authoritative wherever it runs.
- Acceptance (Review → Done) remains the user's act and is orthogonal to merging: Accept without merging, merge without Accepting — both legal.
- No forced git operations, ever: Merge refuses on a dirty repo, aborts cleanly on conflict, never rebases, never force-pushes. Cleanup stays its own existing action.
- Turn/failover machinery (M26) is reused, not duplicated; a work — review or fix — turn is bounded and cancellable like every Turn.
- Windows-readiness: no darwin-only APIs.

## Non-goals

- No auto-merge, no merge queues, no PR/forge integration — the target is the user's local work branch.
- No multi-round review debates: one review, at most one fix round, one re-review. The user's ruling machinery (Needs Attention) is the escalation path, not more AI rounds.
- No reviewer panels (N voters) — a single cross-provider seat; revisit only if graded quality proves insufficient.
- No new item statuses.

## 1. The review turn

Runs after the M16 loop lands green, inside the run (the run still owns the worktree and the failover plumbing):

- somni computes `git diff <merge-base>..HEAD` in the worktree (merge-base against the branch the worktree forked from), plus `--stat`.
- Prompt = review preamble + the Story's Spec + its subtask prompts + the diff. **Diff cap**: beyond a fixed size (implementation pins the constant), the prompt carries `--stat` + the file list + as many whole-file hunks as fit, and the verdict is annotated `diffTruncated: true`.
- The reviewer replies ending with a fenced ```somni-review block: `{"grade": "approve"|"needs-work"|"reject", "reasons": ["..."], "findings": ["..."]}` — `reasons` is the short human-facing why; `findings` are the concrete items a fix turn would act on. A malformed or missing block parses as **needs-work** with a parse-failure note (the §10 "malformed is red" precedent).
- The turn is plain (no tools required, no `--dangerously-*`, no read-only levers needed) — which is exactly what makes every provider eligible.

## 2. Reviewer selection

- Default: the first provider in the failover chain (M26 order, availability-aware) **different from the provider that implemented the Story's subtasks** (read from the run's recorded concrete runners; if subtasks used several, the majority provider counts as the implementer).
- Single eligible provider (or none different available): fall back to the same provider and annotate the verdict `sameProvider: true` — an honest review beats no review.
- Override: an optional **reviewer profile** `{runner?, model?, effort?}` in settings (global; repo override in `.somni/config.json`, the standard precedence). A pinned reviewer that is unavailable waits/fails like any pinned turn.

## 3. The fix round

- `needs-work` → the findings become ONE autonomous fix turn in the worktree, on the implementing provider, through the existing failover machinery — then `checkCommand` re-runs (authoritative: fail = the fix round failed), then ONE re-review by the same reviewing provider over the recomputed diff.
- The re-review's grade is final for the run. `approve` → the Story lands **Review** as today, with the grade attached. `needs-work` or `reject` → the Story lands **Needs Attention** with the findings attached; the user's existing ruling options apply (re-run — the findings pre-fill the prompt —, re-groom, or merge anyway from the run's surface).
- `reject` on the first review **skips the fix round** — a fundamental objection does not get a patch turn; it parks immediately with the reasons.
- The fix round's cost is bounded: one fix turn + one re-review, never more.

## 4. Merge

- An **approved** run's surfaces (Board card in the Review column; the run's row in Runs & Reports) show **Merge** — user-triggered only.
- Preconditions checked in the user's repo checkout (not the worktree): working tree clean (else refuse with the reason), target = the currently checked-out branch. The merge is a plain `git merge somni/<slug>` — no force, no rebase, `--no-edit`.
- Conflict → `git merge --abort`, and the conflict file list is surfaced verbatim. Nothing is retried.
- After a successful merge the run records `merged: true` (+ timestamp); Cleanup remains a separate existing action (a merged branch passes its existing not-unmerged guard naturally).
- Non-approved runs never show Merge; the user can still merge by hand in their terminal as always.

## 5. Data model

- `run.json` gains `review?: { grade: 'approve'|'needs-work'|'reject'|'ungraded', reasons: string[], findings: string[], provider: RunnerName, sameProvider?: boolean, diffTruncated?: boolean, fixRound?: boolean, merged?: string }` (merged = ISO timestamp).
- Settings gain `reviewer?: { runner?: RunnerName; model?: string; effort?: Effort }`.
- Reports render `grade` + `reasons` at the top; the Board's Review-column card shows a grade chip.

## 6. Error handling

- Review turn failure — the turn could not run or produced no reply (providers exhausted, error, timeout) → the run still lands **Review** with grade `ungraded` and the failure reason: a review outage must never hold a finished branch hostage. (A turn that replies but malforms the fence is not a failure — it grades needs-work per §1, and the fix round proceeds normally.) `ungraded` shows no Merge button (nothing was approved) but blocks nothing else.
- Fix-turn failure (error/timeout/providers down) → skip straight to parking Needs Attention with the original findings; the run report says the fix round did not complete.
- Merge failures (dirty tree, conflicts, git errors) are surfaced verbatim and never retried silently.
- Rate limits inside review/fix turns behave like every M26 turn: per-provider cooldown + failover; for the pinned-reviewer case, the turn waits like any pinned turn.

## 7. Testing

- Verdict parsing: valid grades, malformed → needs-work with note, last-block-wins.
- Reviewer selection: cross-provider default, implementer-majority computation, unavailable-skip, single-provider fallback with `sameProvider`, reviewer-profile pin.
- Sequencing: approve → Review; needs-work → fix turn → checkCommand → re-review → final grade routing; reject skips the fix round; one-round bound.
- Merge: dirty-repo refusal, conflict abort + file list, `merged` stamp, no button for needs-work/reject/ungraded.
- Report/Board rendering of grade + reasons.

## 8. Risks

- **Diff-in-prompt scale**: very large branches degrade to stat-level review (`diffTruncated`). Acceptable for v1; per-file chunked review is the upgrade path if truncation proves common.
- **Grade inflation/deflation across providers**: grades are provider-shaped opinions. Mitigation is transparency (provider recorded and shown), not calibration machinery.
- **The one fix round can churn**: a fix turn on a cooling provider may wait. The round is bounded and cancellable; the parking path is always reachable.
