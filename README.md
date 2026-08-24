# somni

A macOS desktop app that puts your AI coding subscription (Claude Max, Google/Antigravity) to work while you sleep.

somni orchestrates agent CLIs — **Claude Code** (`claude`) or **Google Antigravity** (`agy`) — to run coding workflows in parallel, unattended, overnight. You define workflows of ordered tasks (each with a role/persona like *Senior Developer* or *Senior Tester*), tick the ones you want run, and hit **Run Pipeline**. Each workflow executes in its own git worktree; in the morning you review branches and summary reports.

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

## Stack

Electron + TypeScript + React + Vite — no database. Details in [design/architecture.md](design/architecture.md); requirements in [design/design.md](design/design.md); agent conventions in [AGENTS.md](AGENTS.md).

## Status

M1 done — choose a repo, define roles and workflows (stored in `<repo>/.somni/`), and run one-off prompts in the Playground. Roadmap: architecture.md §9.

## Note on unattended runs

Tasks run with `--dangerously-skip-permissions` inside worktrees on your own machine. Keep the Mac awake (energy settings or `caffeinate`) and review branches before merging.
