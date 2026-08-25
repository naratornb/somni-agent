# somni — Ubiquitous language

Glossary of domain terms. Definitions only — no implementation details. When a term here conflicts with usage in code, docs, or conversation, this file wins until deliberately changed.

## Core concepts

- **Workflow** — an ordered list of Tasks sharing one workspace; each Task sees its predecessors' output. The unit of overnight work.
- **Task** — one goal-stated prompt executed unattended by a Runner under a Role. Prompts are goals, not diffs: a Task may be retried or resumed over whatever state exists.
- **Role** — a reusable persona (name + preamble) prepended to a Task's prompt. A Role may pin parts of an Execution Profile.
- **Runner** — an execution backend (Claude Code, Antigravity) that runs one Task as a CLI process.
- **Execution Profile** — `{runner, model, effort}` deciding who runs a Task and with how much brainpower. Resolves Role → repo → global; recorded on every executed Task.
- **Pipeline** — one bounded-concurrency execution pass over the Queue: sequential within a Workflow, parallel across Workflows.
- **Run** — the persisted execution record of one Workflow within one Pipeline (statuses, attempts, costs, report).
- **Report** — the morning-review summary of a Run (Minimal / Compact / Full).

## Drafting & queueing (Phase 2)

- **Brief** — an outcome-focused statement of what the user wants built, written (or dictated) in the Product-Owner hat. Input to drafting; never executed directly.
- **Proposal** — AI-drafted Workflow content produced from a Brief or chat: Tasks *and any new Roles they need*. Inert until Applied.
- **Apply** — the single user-triggered act that writes a Proposal into definitions. Nothing about a Proposal touches disk before Apply; there is no other mutation path from drafting.
- **Refine** — an inline AI rewrite of one existing field (a Task prompt, a Role preamble) into a sharper version of itself; same Apply rule.
- **Queue** — the set of ticked Workflows. A tick means *run once, when draining starts*; running a Workflow drains its tick. Every queued run was consciously chosen — nothing enters the Queue by itself.
- **Backlog** — an ordered list of Workflows kept for later, above *saved* but below *queued*. Order expresses intent ("in this sequence, when I get to them"). Work leaves the Backlog only by **Promote** — a deliberate act moving it into the Queue.
- **Draining** — the state in which the Queue is being executed: running Workflows as concurrency allows and picking up newly ticked or promoted ones as slots free. There is one drain mechanism with two entry points, distinguished only by their stop rules.
- **Nightly Window** — the single scheduled time that starts a drain which stops when the Queue is empty: one night runs one night's consciously queued work, then disarms.
- **Keep Running** — the manual toggle that starts a drain which continues until switched off, so work promoted during the day keeps flowing while the user is away from the screen.
- **Product Owner (PO) hat / Engineer hat** — the two working modes of the *same single user*. PO mode: brief, queue, review outcomes. Engineer mode: full editing of definitions and settings. Modes are presentation only — same data, same person, no permissions.

## Boundaries worth remembering

- A Brief is not a Task prompt: Briefs describe outcomes; Task prompts are self-contained agent instructions derived from them.
- The Queue is not a schedule: it drains. Recurring work re-enters the Queue only by a person's hand.
- The Backlog is not the Queue: parked work never runs by itself, no matter how long a drain stays on.
- A Proposal is not a Workflow: it becomes one (or updates one) only at Apply.
