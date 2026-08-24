# Project Design Brief: "Overnight" — An AI Agent Workflow Orchestrator for macOS

Act as a **principal software engineer**. Your first job is **not to write application code** — it is to produce a complete technical design for the app described below. Deliver architecture, data model, component breakdown, and a phased build plan. Call out risks, trade-offs, and open questions. Only after the design is approved will we implement.

## What I'm building

A **native-feeling macOS desktop application** (built with **web tech — Electron or Tauri**; recommend one and justify it) that maximizes the value of my **Claude Max subscription** by orchestrating the **Claude Code CLI** to run coding tasks in parallel, unattended, 24/7 — especially overnight.

The core idea: I define **workflows** made of ordered **tasks**, assign each task a **role/persona** for context, queue selected workflows into a **pipeline**, and let the app fan out `claude` CLI processes to churn through everything while I sleep. In the morning I get finished work plus summary reports.

## Execution model (decided)

- The app runs work by **spawning `claude` Code CLI processes** (one per running task), not by calling the Anthropic API directly. This uses my Max plan.
- Each task runs in its own **working directory / git branch/worktree** so parallel tasks don't collide.
- The app manages **concurrency** (a configurable max number of simultaneous CLI processes), captures **stdout/stderr/logs**, and detects success/failure/exit codes.

## Workflow model (decided)

- A **workflow** is an **ordered sequence of tasks sharing one workspace** (a repo/folder). Each task sees the output of the previous task (files on disk, git state).
- Example workflow — "Add image upload feature":
  1. **Design** the feature as a principal developer (produce a spec).
  2. **Implement** the feature according to that design.
  3. **Test** the implementation; report whether it works and what should improve.
  4. **Revise** based on the test results and finalize.
  5. **Report** — write a summary: what was done, how many files created/changed, how many test cases added.
- The app can hold **many workflows** simultaneously.

## Required features

1. **Workflows and tasks**
   - Create/edit/reorder workflows and their tasks.
   - Each task has: a prompt, an assigned role, a target workspace, and a status.

2. **Roles / personas ("workers")**
   - I can define a library of reusable roles — e.g. **Senior Developer**, **Senior Tester**, **Project Manager**, etc.
   - Each role carries a context/system-style preamble that gets prepended to the task's prompt so the right "persona" does the right job.
   - Roles are assignable per task.

3. **Pipeline with checkboxes**
   - A checkbox on each workflow/task to **select it for the overnight pipeline**.
   - A **"Run Pipeline"** action that launches the selected work, running tasks via the CLI, respecting concurrency limits and the sequential ordering within each workflow.
   - The pipeline runs until **all selected prompts are completed**.

4. **Status tracking (visible at a glance)**
   - Every task and workflow shows status: **Queued / In Progress / Completed / Failed** (propose the full set).
   - A dashboard/overview so I can see the whole pipeline's progress at once.
   - Live log streaming for any running task.

5. **Summary reports**
   - Per-workflow report generated at the end: what was accomplished, files created/modified (with counts), test cases added, and any follow-ups.

## What I want you to deliver in this design

1. **Framework recommendation** — Electron vs. Tauri for this use case, with reasoning (bundle size, process spawning, security, my need to spawn CLI subprocesses reliably).
2. **High-level architecture** — main/renderer split (or Tauri core/webview), how the UI talks to the process-orchestration layer, and how long-running CLI jobs are supervised.
3. **The orchestration engine** — how tasks are queued, how concurrency is enforced, how sequential-within-workflow + parallel-across-workflows scheduling works, how workspaces/branches are isolated, how failures and retries are handled, and how a crashed/closed app resumes an in-flight pipeline.
4. **Data model** — schemas for Workflow, Task, Role, PipelineRun, and Report; where state is persisted (recommend a local store, e.g. SQLite).
5. **How `claude` CLI is invoked** — exact command shape, how role context + task prompt are composed into the invocation, how output is captured and parsed to detect completion and to build the summary report.
6. **UI/screen breakdown** — the main views (workflow list, workflow editor, role library, pipeline/queue view with checkboxes, live logs, reports) and key interactions.
7. **A phased build plan** — milestones from a walking skeleton (run one task via CLI, show its output) up to the full overnight pipeline, so I can build incrementally.
8. **Risks and open questions** — CLI rate/usage limits under a Max plan, safety of running unattended code changes overnight, sandboxing/permissions, and anything I haven't thought of.

## Constraints and preferences

- Target: **macOS**, personal use. Distribution later as a `.dmg` (signing/notarization is a later concern, not part of this design).
- I'm comfortable with web tech (HTML/CSS/JS). Assume TypeScript unless you argue otherwise.
- Optimize for **unattended reliability** — this thing needs to run for hours with no one watching.

Start by asking me any clarifying questions you need, then produce the design.