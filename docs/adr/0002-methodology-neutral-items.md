# Work items are methodology-neutral; Methodology is resolved per repo at run time

somni supports selectable engineering Methodologies (Matt Pocock's workflow, Superpowers). We decided items carry no methodology field: a Methodology is a repo-resolved swap of prompt constants and vendored skills (global default, per-repo override), applied at groom/run time. The Ready gate, Statuses, the Interview → Proposal → Apply flow, and the `somni-question`/`somni-groomed`/`somni-verdict` protocol are invariant across Methodologies, so a Story groomed under one runs fine under another and switching a repo needs no item migration.

## Considered Options

- **Stamping each Story with its grooming Methodology** — rejected: adds state and a migration question for zero safety gain, since the invariant item model makes every Story runnable under every Methodology.
- **Forking the Grooming UX per Methodology** — rejected: both disciplines fit the one-question-at-a-time Interview shape; only the prompt content differs.

## Consequences

Execution granularity differs by Methodology: Pocock mode runs one CLI process per Subtask with somni sequencing; Superpowers mode hands orchestration to the agent — one process per Story executing the whole plan subagent-driven, with retries at Story level and coarser per-Subtask cost/report data. somni's review loop remains the final Story-level gate in both modes, since its verdict is how the engine routes to Review vs Needs Attention.
