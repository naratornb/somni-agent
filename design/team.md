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

1. **Brief.** TD turns the user's objective into a small, milestone-sized brief per specialist (context, goal, constraints, success criterion). One task per brief.
2. **Design (UI tasks only).** If the task is UI-related, the Designer is spawned first (or alongside) to propose the interface; the TD relays any open questions to the user before implementation locks in.
3. **Implement.** Engineer implements the brief — simplest approach that works, respecting the architecture rules in [AGENTS.md](../AGENTS.md).
4. **Test.** Tester verifies the implementation in context and reports failures with concrete output.
5. **Feedback loop.** Tester findings go back to the Engineer as a new brief. After 2 failed rounds the TD arbitrates instead of looping again.
6. **Green light.** TD reviews, approves, and commits per the AGENTS.md commit-message rules.

## Rules

- The TD decides and delegates; it never silently absorbs a specialist's job.
- Specialists return finished work and findings — never questions addressed directly to the user. Open questions are listed at the end of their report for the TD to relay (subagents cannot prompt the user).
- Independent briefs may run in parallel (e.g. Engineer on main-process work while Designer drafts UI).
- Keep briefs small: one milestone-sized task each. Big objectives become a sequence of briefs, not one giant one.
- Trivial mechanical changes (typos, one-liners, doc tweaks) don't need the team — the TD just does them.
