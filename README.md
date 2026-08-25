# somni

A macOS desktop app that puts your AI coding subscription (Claude Max, Google/Antigravity) to work while you sleep.

somni orchestrates agent CLIs — **Claude Code** (`claude`) or **Google Antigravity** (`agy`, planned) — to run coding workflows in parallel, unattended, overnight. You define workflows of ordered tasks (each with a role/persona like *Senior Developer* or *Senior Tester*), tick the ones you want run, and hit **Run Pipeline**. Each workflow executes in its own git worktree; in the morning you review branches and summary reports.

## How it works

- **Workflows** — ordered tasks sharing one workspace; each task sees the previous task's output (files, git state).
- **Roles** — reusable persona preambles prepended to task prompts; a role can pin its own model/effort.
- **Runners** — pick Claude Code or Antigravity per execution profile (runner + model + effort), configurable globally, per repo, or per role.
- **Draft with AI** — a chat in the workflow editor: type a rough idea and the assistant (reading your repo, read-only) refines it into a technical brief and proposes the task list; nothing is written until you hit Apply.
- **Pipeline** — checkbox-selected workflows run sequentially-within, parallel-across, under a configurable concurrency cap.
- **Isolation** — the app creates a dedicated worktree + `somni/<slug>-<date>` branch per workflow; merging back is up to you.
- **Reliability** — one retry then halt-workflow on failure; rate limits pause the whole pipeline with backoff; crash-safe resume from persisted run state.
- **Reports** — per-workflow summaries; style configurable (Minimal / Compact / Full).
- **Your data** — everything somni knows about a repo lives in that repo's `.somni/` folder as plain JSON/Markdown: workflow definitions, roles, run state, reports. Commit it for cross-machine continuity; raw logs are auto-gitignored.

## Prerequisites

- **macOS** (primary target; the pipeline relies on `powerSaveBlocker` and is tested on macOS only).
- **Node.js 20+** and npm — to run from source or build the app.
- **git** — worktree isolation requires it; every target repo must be a git repository.
- **Claude Code CLI** — [`claude`](https://docs.anthropic.com/en/docs/claude-code) installed and on your `PATH`, logged in (a Claude Max plan is what makes overnight fan-out affordable). Verify with `claude -p "hi"`.
- A **target repo** you want worked on (any git repo; somni stores its state inside it under `.somni/`).

## Run locally (development)

```bash
git clone git@github.com:naratornb/somni-agent.git
cd somni-agent
npm install
npm run dev        # launches the app with hot reload
```

Other useful scripts:

```bash
npm test           # vitest unit checks
npm run lint       # eslint
npm run build      # typecheck + production bundles (no installer)
```

## Build / "deploy" (package the app)

somni is a desktop app — there is no server to deploy. Packaging produces an installable artifact with [electron-builder](https://www.electron.build/):

```bash
npm run build:mac      # → dist/somni-<version>.dmg
npm run build:unpack   # unpacked app in dist/ for a quick smoke test
```

Open the `.dmg` and drag somni to Applications. The build is unsigned/un-notarized by default (`notarize: false` in `electron-builder.yml`) — fine for your own machine; macOS will ask you to right-click → Open the first time. For distribution to others, add your Developer ID signing identity and enable notarization there.

## Using somni

1. **Choose a repo.** Top bar → *Choose repo…* and pick a git repository. somni creates `<repo>/.somni/` (with its own `.gitignore` for raw logs).
2. **Create roles** (Roles view). A role is a name + persona preamble prepended to every task that uses it, e.g. *Senior Developer*: "You are a pragmatic senior developer…". A role can optionally pin a model and effort level.
3. **Create a workflow** (Workflows view). Ordered tasks, each with a title, a prompt (write it as a goal, not a diff — tasks may be retried or resumed), and a role. A good shape: Design → Implement → Test → Revise.
   - Or click **Draft with AI**: describe the goal in the side chat; the assistant inspects your repo read-only, asks a couple of questions, and proposes the task list. **Apply** writes it to the workflow; Dismiss discards. (Requires the workflow to be saved once first.)
4. **Select and run** (Pipeline view). Tick the workflows to include, hit **▶ Run pipeline**. Each workflow gets a fresh worktree and `somni/<slug>-<date>` branch; tasks stream live — click a task chip to tail its output. Rate limits show as ⏸ Paused with the retry time; Cancel stops everything.
5. **Leave it running.** The window can be closed to the tray; the Mac is kept awake via `powerSaveBlocker` — but lid-closed sleep still needs your energy settings or `caffeinate`. If the app quits mid-run, next launch offers **Resume / Abandon** for the orphaned run.
6. **Morning review** (Runs & Reports view). Per-run status, per-task durations/costs, and the report (`.somni/runs/<id>/report.md`). Check out the `somni/…` branch, review, merge what you like, then **Clean up worktree** — somni never force-deletes a dirty worktree or unmerged branch.
7. **Tune it** (Settings view): max concurrency (keep it modest, 2–3 — overnight fan-out shares your plan's usage windows), task timeout, report style, default model/effort. Per-repo overrides go in `.somni/config.json`; per-role overrides in the role editor.

### Report styles

| Style | Cost | Content |
|---|---|---|
| Minimal | zero tokens | Diff stats, files touched, per-task durations & cost |
| Compact | one short call | Minimal + a one-paragraph prose summary |
| Full | one task run | Minimal + a full "Report" task run inside the worktree |

## Stack

Electron + TypeScript + React + Vite — no database. Details in [design/architecture.md](design/architecture.md); requirements in [design/design.md](design/design.md); agent conventions in [AGENTS.md](AGENTS.md).

## Status

M6 done — workflows, roles, pipeline with unattended reliability, reports & settings, run history, and Draft-with-AI chat are all in. Remaining: M7, the Antigravity (`agy`) runner adapter. Roadmap: [architecture.md §9](design/architecture.md).

## Note on unattended runs

Tasks run with `--dangerously-skip-permissions` inside worktrees on your own machine. Worktrees isolate *file* changes, not shell side effects — run somni only on repos and machines you trust, and review branches before merging.
