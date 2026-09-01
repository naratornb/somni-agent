# somni — Ubiquitous language

Glossary of domain terms. Definitions only — no implementation details. When a term here conflicts with usage in code, docs, or conversation, this file wins until deliberately changed.

somni speaks two vocabularies on purpose: **work items** use the industry's Jira words so users arrive already fluent; the **execution engine** keeps somni-native names because Jira has no words for it. A term from one list never substitutes for a term from the other.

## Work items (Phase 3)

- **Item** — the umbrella for anything on the Board: an Idea, an Epic, or a Story. Every item has exactly one Status.
- **Idea** — a raw captured thought, one quick note dropped into the Backlog before it is shaped. Ideas carry no plan and can never run; Grooming turns an Idea into a Story (or an Epic with Stories).
- **Epic** — a container for related Stories born from one Grooming pass over a large intent. Epics group and track; they are never executed themselves.
- **Story** — the unit of deliverable work and the unit of execution: one Story = one groomed Spec + its Subtasks = one run on one branch. Stories may name other Stories that must finish first (blocked-by).
- **Subtask** — one goal-stated prompt inside a Story, executed unattended by a Runner under a Role. Subtasks are ordered; each sees its predecessors' output. (The execution engine formerly called this a Task.)
- **Spec** — the approved statement of what a Story or Epic builds and how success is judged, produced by Grooming. A Story without a Spec cannot be Ready.
- **Backlog** — the ordered first column: every captured Idea and every not-yet-groomed or not-yet-ready item, prioritized by the user. The Backlog is the inbox; there is no separate inbox.
- **Grooming** — the interactive shaping of an item with the AI: the Interview sharpens intent into a Spec, then breaks it into Stories and Subtasks with blocked-by edges. Grooming is the only path to Ready. Entry at Epic altitude for big intents, or a single Story for small ones.
- **Ready gate** — the hard rule that an item enters the pipeline only as a Story with an approved Spec and at least one Subtask. There is no bypass; the gate is what makes unattended runs safe.
- **Status** — where an item stands, shown as the Board's columns: `Backlog → Grooming → Ready → In Progress → Needs Attention / Review → Done`.
- **Board** — the kanban home view: one column per Status, cards are items. All planning activity starts here.
- **Capture** — the friction-free act of writing (or dictating) an Idea into the Backlog from anywhere in the app. Capture never grooms, never runs — it only saves the thought.
- **Acceptance** — the user's deliberate act, in the Product-Owner hat, that moves a green Story from Review to Done. Work is never Done by itself.
- **Needs Attention** — where a Story lands when its run failed or its review stayed red after the bounded retries: parked for the user's ruling (re-run, re-groom, or drop).

## Execution engine

- **Runner** — an execution backend (Claude Code, Antigravity) that runs one Subtask as a CLI process.
- **Role** — a reusable persona (name + preamble) prepended to a Subtask's prompt. A Role may pin parts of an Execution Profile.
- **Execution Profile** — `{runner, model, effort}` deciding who runs a Subtask and with how much brainpower. Resolves Role → repo → global; recorded on every executed Subtask.
- **Pipeline** — one bounded-concurrency execution pass over the in-progress Stories: sequential within a Story, parallel across Stories.
- **Add to pipeline** — the user's deliberate act that sends a Ready Story into execution. Ready means *eligible*, never *running*: nothing enters the pipeline by itself.
- **Draining** — the state in which the pipeline is executing: running Stories as concurrency allows and picking up newly added ones as slots free.
- **Nightly Window** — the single scheduled time that starts a drain which stops when no Story is left in progress: one night runs one night's consciously added work, then disarms.
- **Keep Running** — the manual toggle that starts a drain which continues until switched off, so Stories added during the day keep flowing while the user is away from the screen.
- **Run** — the persisted execution record of one Story within one Pipeline (statuses, attempts, costs, report).
- **Turn** — one prompt→reply exchange with a Runner: exactly one attempt, always time-bounded, always cancellable. Every AI feature (Subtask execution, Grooming replies, Review/Fix, Reports, Refine) is made of Turns; how many Turns something deserves is Pipeline or Grooming policy, never the Turn's.
- **Report** — the morning-review summary of a Run (Minimal / Compact / Full), read at Acceptance time.

## Grooming machinery

- **Interview** — the structured questioning the grooming AI conducts before proposing: one Question at a time, each with concrete options and a recommended answer, relentless until every branch that materially changes the Spec is resolved.
- **Question** — one step of the Interview, presented as selectable choices (custom answers always possible). Answering is the user's only obligation in Grooming.
- **Propose Now** — the user's ever-present right to end the Interview early and receive a Proposal built on stated assumptions. Only the user may cut an Interview short.
- **Proposal** — AI-drafted Grooming output: the Spec, the Stories and Subtasks it breaks into, *and any new Roles they need*. Inert until Applied.
- **Apply** — the single user-triggered act that writes a Proposal into items. Nothing about a Proposal touches disk before Apply; there is no other mutation path from Grooming.
- **Refine** — an inline AI rewrite of one existing field (a Subtask prompt, a Role preamble) into a sharper version of itself; same Apply rule.
- **Product Owner (PO) hat / Engineer hat** — the two working modes of the *same single user*. PO mode: capture, groom, accept. Engineer mode: full editing of definitions and settings. Modes are presentation only — same data, same person, no permissions.

- **Methodology** — the selectable engineering discipline of a target repo (with a global default) that governs *how* Grooming shapes work and *how* the pipeline implements and reviews it. A Methodology never changes what an item is: the Ready gate, Statuses, and the Interview → Proposal → Apply flow hold under every Methodology, and the repo's current Methodology governs every Run regardless of which one groomed the Story.

## Boundaries worth remembering

- An Idea is not a Story: Ideas are unshaped thoughts; Stories carry an approved Spec and Subtasks. Only Grooming crosses that line.
- Ready is not running: the Ready column is eligibility. A Story executes only after "Add to pipeline", by a person's hand.
- Review is not Done: green work waits for Acceptance. The user closes Stories; the pipeline never does.
- A Proposal is not an item: it becomes one (or several) only at Apply.
- The Board's Backlog is the *team's* work inventory for the target repo — not to be confused with any backlog concept inside a user's own product.
- "Sprint" is deliberately absent: somni's flow is kanban. Items move when they are ready, not when a calendar says so.
