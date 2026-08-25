# Multi-agent team

How work gets executed in this repo: a four-member team. The **Technical Director is the main Claude Code session**; the three specialists are project agents in [`.claude/agents/`](../.claude/agents/) and are spawned as subagents. Everything is committed — clone the repo and the team comes with it.

## Roster

| Role | Agent | Model / effort | When it runs |
|---|---|---|---|
| **Technical Director** | main session | Fable 5, medium | Always. Decision maker: turns the user's objective into briefs, reviews returned work, green-lights design, implementation, and testing. Talks to the user. Does not write code under this process. |
| **Senior Fullstack Engineer** | [`fullstack-engineer`](../.claude/agents/fullstack-engineer.md) | Opus 5, low | Main implementor. Receives briefs from the TD and feedback from the Tester. |
| **Senior Tester** | [`tester`](../.claude/agents/tester.md) | Sonnet 5, low | After implementation (or in parallel on independent parts). Guards against errors on launch. |
| **UX/UI Designer** | [`ux-designer`](../.claude/agents/ux-designer.md) | Sonnet 5, medium | Spawned only when the task touches user interface. |

## Workflow

1. **Size.** TD assesses the objective's scope and risk first, then staffs the smallest team that covers it (see Staffing tiers below), stating the staffing choice in one line when reporting to the user. Spawning the full roster by default wastes tokens.
2. **Brief.** TD writes the **Execution Brief** — `design/briefs/M<n>.md` for milestones, `design/briefs/<topic>.md` for smaller agent-staffed work — following [briefs/TEMPLATE.md](briefs/TEMPLATE.md). It is the source of truth the team executes from: each spawned specialist gets a short pointer prompt ("execute your section of design/briefs/M8.md"), not a full inline brief, so what the user can read and what the team was told never drift. Trivial TD-direct work needs no brief file.
3. **Design (UI tasks only).** If the task is UI-related, the Designer is spawned first (or alongside) to propose the interface; the TD relays any open questions to the user before implementation locks in.
4. **Implement.** Engineer implements the brief — simplest approach that works, respecting the architecture rules in [AGENTS.md](../AGENTS.md).
5. **Test.** Tester verifies the implementation in context and reports failures with concrete output.
6. **Feedback loop.** Tester findings go back to the Engineer as a new brief. After 2 failed rounds the TD arbitrates instead of looping again.
7. **Green light.** TD reviews, approves, and commits per the AGENTS.md commit-message rules.

## Staffing tiers

| Size | Signals | Team |
|---|---|---|
| **Trivial** | Typo, one-liner, doc tweak | TD does it directly — no agents. |
| **Small** | One well-understood change, clear approach, low blast radius | Engineer only. The TD reviews the diff and runs `npm test` / `npm run lint` / `npm run build` itself instead of spawning the Tester. |
| **Standard / milestone** | Multi-file feature, new subsystem, reliability-sensitive logic | Engineer + Tester. |
| **UI involved** | New view or interaction design | Add the Designer. Mechanical UI edits that follow the existing design system (`src/renderer/src/assets/main.css`) don't need one. |

## Execution Briefs

- **Authority.** The brief file is what agents execute — pointer prompts only. If scope must change, the brief changes first.
- **Lifecycle.** Scope sections freeze at kickoff (agents need a stable target). The **Decisions log** is living: the TD appends every mid-flight ruling — tester findings triaged, trade-offs accepted, overrides of specialist defaults — as it happens.
- **Shipping.** The brief commits with the milestone's PR, so the record of what was decided lands with the code it explains. No retroactive briefs for work already shipped.
- **Naming.** "Execution Brief" — never plain "Brief", which is a product term (see CONTEXT.md).

## Rules

- The TD decides and delegates; it never silently absorbs a specialist's job.
- Specialists return finished work and findings — never questions addressed directly to the user. Open questions are listed at the end of their report for the TD to relay (subagents cannot prompt the user).
- Independent briefs may run in parallel (e.g. Engineer on main-process work while Designer drafts UI).
- Keep briefs small: one milestone-sized task each. Big objectives become a sequence of briefs, not one giant one.
- Staffing follows the tiers above and is revisable: if a "small" task grows (risky logic appears, tester-worthy failures), the TD adds the missing specialist then — never pre-spawn "just in case". The user can always override ("full team" / "single agent only").
