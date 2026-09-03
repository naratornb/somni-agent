# Research: Claude Code CLI headless sessions & Electron macOS notifications

> For the "grooming sessions" design. 2026-09-03.
> Note on location: the repo had no research-notes convention (design/ holds architecture.md, design.md, briefs/; docs/ holds adr/ and agents/), so this file creates `design/research/`.
>
> Local verification environment: Claude Code CLI **2.1.220**, macOS (Darwin 25.6.0). "Verified locally" claims were run with `--model haiku` in `/tmp/somni-research`.

## A. Claude Code CLI headless (`claude -p`) facts

### A1. `--resume <sessionId>` semantics

- **Reliably continues a conversation in `-p` mode.** Verified locally: turn 1 (`claude -p "...favorite number is 42..." --output-format stream-json --verbose`) returned `session_id: 756e42ee-...`; a second fresh process `claude -p "What number...?" --resume 756e42ee-...` answered `42`.
- **Resume does NOT mint a new session id (on CLI 2.1.220).** The resumed run's `result.session_id` was identical to the original, and the CLI appended to the *same* transcript file rather than creating a new one (verified locally: `ls ~/.claude/projects/-private-tmp-somni-research/` before/after showed one `756e42ee-....jsonl`). Only `/branch` / `--fork-session` create new ids: "Sessions created with `/branch` or `--fork-session` get their own session IDs" (https://code.claude.com/docs/en/sessions). somni's chat.ts last-sessionId-wins tracking is therefore *defensive but harmless* — keep it, since it also covers older CLI versions that forked ids on resume.
- **Session state is plain files, so resume survives process exit and reboot.** "Claude Code stores transcripts as JSONL at `~/.claude/projects/<project>/<session-id>.jsonl`, where `<project>` is your working directory path with non-alphanumeric characters replaced by `-`" (https://code.claude.com/docs/en/sessions#where-transcripts-are-stored). Verified locally: every resume above was a fresh process after the original exited. macOS gotcha verified locally: the path is the *resolved* cwd — `/tmp/...` stores under `-private-tmp-...`.
- **Resume works cross-directory** since v2.1.223: "Claude Code looks for the ID in the current project directory and its git worktrees first, then in every other project on this machine" (https://code.claude.com/docs/en/sessions#resume-a-session). Before v2.1.223 you had to resume from the same project dir — pin a minimum CLI version if the design relies on this.
- **Transcript format is explicitly unstable:** "The entry format is internal to Claude Code and changes between versions, so scripts that parse these files directly can break on any release" (same page). Don't design anything that parses the jsonl; use `-p --resume` + stream-json instead.
- `-p` sessions are hidden from the interactive picker and `claude --continue`, but resumable by id (https://code.claude.com/docs/en/sessions#resume-a-session).
- `--no-session-persistence` exists to suppress transcript writes for a `-p` run (https://code.claude.com/docs/en/sessions#where-transcripts-are-stored) — the design must NOT pass it for groomable conversations.

### A2. Concurrency

- **Multiple `claude -p` processes in the same cwd work fine.** Verified locally: 3 simultaneous `claude -p` runs in one directory all returned `subtype: success` with 3 distinct session ids; no lock, contention, or session-store errors. Each session is its own jsonl file, so there is no shared write path between *different* sessions.
- **The one documented contention hazard is two writers on the SAME session:** "If you resume the same session in two terminals without forking, messages from both interleave into one transcript" (https://code.claude.com/docs/en/sessions#branch-a-session). ⚠️ Design constraint: serialize turns per conversation (one in-flight `--resume <id>` at a time per session id) — somni's per-conversation turn model already does this; grooming sessions must keep that invariant.
- Rate limits are account-level, not per-process; stream-json emits `system/api_retry` events on retryable errors and a `rate_limit_event` with `resetsAt`/`rateLimitType` (verified locally in stream output; retry event table at https://code.claude.com/docs/en/headless#handle-api-retries). A UI can surface these.

### A3. Kill mid-turn

- **SIGTERM:** documented exactly — "Claude Code exits with code 143. Claude Code leaves the turn that was in progress unfinished and records no result for it… When you resume the session, Claude Code continues the turn that SIGTERM left unfinished" (https://code.claude.com/docs/en/headless#stop-a-run-with-sigterm). SessionEnd hooks still run on SIGTERM. To *finish* the turn instead, send **SIGINT**.
- Verified locally: SIGTERM'd a `-p` run 8 s in (exit 143); the transcript held 12 partial jsonl lines; `--resume` of that session in a new process succeeded with the same session id and full memory of pre-kill context.
- **SIGKILL:** also resumable. Verified locally: `kill -9` mid-turn (exit 137), then `--resume` succeeded with the same session id. Transcripts are written incrementally per line, so even an unclean kill leaves everything up to the last flushed line. (One behavioral note: after the killed partial turn, the model initially treated the odd truncated context with suspicion — resumed sessions after a kill may need a clarifying user message, but the mechanism works.)
- ⚠️ The interrupted turn's partial assistant output exists only in the transcript, not as any `result` event — somni's UI will never have received a `result` for that turn and should render the turn as "interrupted".

### A4. Cost/token accounting in stream-json

Verified locally: the final `type: "result"` line of every `-p --output-format stream-json --verbose` run carries per-run accounting a UI can surface directly:

- `total_cost_usd` (e.g. `0.02991`), `duration_ms`, `duration_api_ms`, `num_turns`
- `usage`: `input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`, `server_tool_use`, `service_tier`
- `modelUsage`: per-model breakdown with `inputTokens`/`outputTokens`/`costUSD`/`contextWindow`
- Each intermediate `assistant` message also carries `message.usage`.

Docs: "the response payload includes `total_cost_usd` and a per-model cost breakdown… Both figures are client-side estimates and can differ from your actual bill" (https://code.claude.com/docs/en/headless#pipe-data-through-claude). Costs are **per invocation** (per turn), not cumulative for the session — the UI must sum per-turn results itself if it wants a session total.

## B. Electron native notifications on macOS (Electron 39)

### B1. `new Notification()` from main — signing & permission

- **Code signing is required on macOS.** "This API requires an application to be code-signed in order for notifications to appear. Unsigned binaries will emit a `failed` event when notifications are called." (https://www.electronjs.org/docs/latest/api/notification). Tutorial repeats it: "your application will need to be code-signed in order for notification events to emit correctly" (https://www.electronjs.org/docs/latest/tutorial/notifications).
- ⚠️ Dev-build caveat: in `electron .` dev runs the notifying bundle is the prebuilt Electron.app helper (shows as "Electron" in Notification Center); whether it delivers depends on that binary's signature and the user's Notification Center authorization for "Electron" — treat dev delivery as best-effort, and test the packaged/signed build before trusting the feature. Electron's own guidance for detecting this: "the `macos-notification-state` module… allows you to detect ahead of time whether or not the notification will be displayed" (tutorial page). There is no Electron-level permission-request API for basic banners; macOS gates it via per-app Notification Center settings.
- Other caveats from the tutorial: notifications "are limited to 256 bytes in size and will be truncated"; call `.show()` explicitly; check `Notification.isSupported()` first (API page).

### B2. Detecting "window not focused"

- Synchronous check: `win.isFocused()` — "Returns boolean - Whether the window is focused." (https://www.electronjs.org/docs/latest/api/browser-window)
- Event-driven: BrowserWindow `'focus'`/`'blur'` events, or app-level `app.on('browser-window-focus'/'browser-window-blur')` — "Emitted when a browserWindow gets focused/blurred" (https://www.electronjs.org/docs/latest/api/app). Gate: notify when `BrowserWindow.getAllWindows().every(w => !w.isFocused())` (or track via the app-level events). Also handle the minimized/hidden case — a minimized window is not focused, which is exactly when you want the notification.

### B3. Click → focus + navigate (supported pattern)

- `Notification` emits `'click'`: "Emitted when the notification is clicked by the user." (https://www.electronjs.org/docs/latest/api/notification)
- Pattern (all main-process, all documented):
  1. `notification.on('click', ...)` →
  2. `if (win.isMinimized()) win.restore()` ("Restores the window from minimized state"), `win.show()` ("Shows and gives focus to the window"), `win.focus()` (https://www.electronjs.org/docs/latest/api/browser-window); `app.focus({ steal: true })` if another app is active — but docs say to "use the `steal` option as sparingly as possible" (https://www.electronjs.org/docs/latest/api/app) — a notification click is the canonical justified case.
  3. Navigate by sending an IPC message to the renderer (`win.webContents.send(...)`) — somni already routes main→renderer this way via preload.
- Also wire `app.on('activate')` (dock-icon click re-activation, macOS) to re-show the window (https://www.electronjs.org/docs/latest/api/app).

## Contradiction / risk summary vs. design assumptions

1. **No contradiction on resume:** `-p --resume` is reliable, file-backed (`~/.claude/projects/...jsonl`), survives process death and reboot, and keeps the SAME session id on CLI ≥ 2.x — last-sessionId-wins in chat.ts stays as a safety net, not a necessity.
2. **Cross-directory resume needs CLI ≥ 2.1.223** — older CLIs only find sessions from the same project dir/worktrees. If users may have older CLIs, always spawn resumes with the conversation's original cwd (somni already does).
3. **Never run two concurrent turns against one session id** — interleaved transcript corruption is documented. Concurrent turns across *different* sessions are fine (verified).
4. **macOS notifications silently fail in unsigned builds** (`failed` event, nothing shown). If the design demos notifications from an unsigned dev build, expect flakiness; the packaged signed app is the real test.
5. **Per-turn cost is in the `result` event but is a client-side estimate and per-invocation only** — session totals must be accumulated by somni.
