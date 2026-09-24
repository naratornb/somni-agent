# Hands-off briefing — design

2026-09-24 · Workstream 2 of the commercial revision (runners ✓ → **hands-off briefing** → AI reviewer)

## Purpose

Grooming currently interviews the user one question at a time until the Spec is sharp, and background drafting (Handoff) is a manual act. For a commercial product whose promise is "least effort," the user's **persona** should govern how much they are consulted: a high-level **Project Owner** never answers questions — they drop an idea and later review a completed brief; a **Technical Director** answers a few high-leverage questions first, then the groom goes silent until the brief is done. Nobody accepts or rejects anything mid-flight; the single decision point is the completed brief, which opens with a plain-language summary and carries one primary action: **Approve & run**.

Decisions taken during brainstorming, recorded here:

- **Persona-tied depth**: Project Owner → fully autonomous assume-and-continue from turn one; Technical Director → the full relentless-interview discipline (every question must materially change the Spec) hard-capped at **3 question rounds**, then automatic Handoff. Quality-first within a bounded budget, per the user's explicit choice.
- **Persona home**: global setting (default `director`) with per-repo override, chosen at onboarding, plus a per-groom chip on Quick Start and the Groom header that flips it for that groom only.
- **Brief completion action**: **Approve & run** — Apply plus queueing the resulting Stories into the pipeline in one deliberate act (the Quick Start "Apply & run" precedent). Plain Apply and Dismiss remain secondary.
- **Reuse over rebuild**: the M25 session machinery (Handoff, work units, assume-and-continue, needs-review parking, cap of 3, FIFO queue, interrupted/resume, notifications) is the execution substrate; this workstream only changes *when* it is invoked and *what the prompts demand*.

## Invariants that must survive

- The **Ready gate** never bends: nothing reaches the pipeline except a Story with an approved Spec and Subtasks, and Approve & run is a deliberate user act.
- **Apply is the only write path** from grooming; the chat never touches disk.
- Grooming turns stay **read-only** (M26: via `readOnlyRunner`; providers without verified read-only levers are refused).
- The **work-unit cap of 3** and FIFO queue are unchanged; auto-handoffs queue like manual ones.
- Session-state vocabulary stays strictly separate from Item Status (CONTEXT.md's two-vocabulary rule).
- Windows-readiness: no darwin-only APIs in new code.

## Non-goals

- No auto-merge and no AI reviewer — that is workstream 3 (recommend-only reviewer; cross-provider review rule already recorded in the M26 spec).
- No multi-turn autonomous drafting: a work unit stays ONE Turn (existing ceiling; revisit only if single-turn briefs prove too shallow).
- No new chat/orchestration stack, no new fence formats (the single-question `somni-question` fence and `somni-groomed` proposal fence are unchanged).
- No removal of today's manual controls: Propose Now, manual Handoff, free-typing, and rename all stay.

## 1. Persona model

- `Settings.persona?: 'director' | 'owner'`, default `'director'` (`SETTINGS_DEFAULTS`). Global settings + `.somni/config.json` repo override, same precedence as every other setting.
- Onboarding: the first-run flow asks once (two cards: "Technical Director — answer up to 3 sharp questions for a tighter brief" / "Project Owner — drop ideas, review finished briefs"). Where a first-run flow already shows (zero-provider setup, first repo open), the persona pick slots in there; Settings holds it thereafter.
- Per-groom chip: Quick Start and the Groom header show the active persona as a small toggle chip. Flipping it affects **that groom only**.
- The chosen persona is stamped into the item's frontmatter (`persona`) at groom creation, so background work units, reopened sessions, and other machines apply the same rules. Absent frontmatter (pre-M27 items) resolves to the repo's current setting at each turn.

## 2. Project Owner flow

Groom entry (Quick Start, Capture's "Groom now", Board `Groom →`) creates the Item and transcript exactly as today, then immediately routes the seed text into the **existing Handoff path** — one autonomous assume-and-continue Turn under the work-unit rules, from turn one. No interactive turn ever runs unless the user opens the session and types.

- The session shows `working`/`queued` on the Home rail immediately; the cap/queue applies unchanged.
- A PO groom with an empty seed (e.g. Board-entry on a bare Idea) uses the Idea's captured text as the seed; a truly empty item falls back to the TD flow's first question — there is nothing to assume from, and a silent empty brief helps no one. (This is the one deliberate exception to "no questions for PO.")
- Dictation via Quick Start composes: voice fills the box, submit routes per persona (the `voiceAutoGroom` setting keeps its meaning).
- If the user opens a PO session and **types**, they have opted into conversation: that turn runs interactively under the TD rules, and §3's routing (question cap counted from there, auto-handoff) applies from that point.

## 3. Technical Director flow

The interactive interview runs exactly as today — one `somni-question` fence at a time, clickable options, recommended answer highlighted — with two preamble changes and one app-side routing change:

- **Preamble cap**: at most **3 Questions** per groom, each only if the answer materially changes the Spec; the discipline text keeps the relentless-interview quality bar. After the cap (or sooner, when satisfied) the assistant must either propose inline or state it is ready to draft.
- **Auto-handoff routing**: when the user submits an answer to the 3rd question, the app routes that answer into a Handoff (the answer text travels in the handoff message) instead of an interactive turn. Likewise, if an assistant reply contains **neither** a question fence **nor** a proposal fence, the app auto-hands-off rather than leaving the session idle.
- **Inline proposal short-circuit**: if a proposal fence arrives during the interview (small grooms), the proposal preview shows immediately — no handoff, nothing queued.
- Question rounds are counted from the transcript's question fences (no new counter field unless the implementation plan finds re-parsing costly — then a frontmatter counter, derived-on-load).
- Propose Now, manual Handoff ("Draft in background"), and free typing remain available at every point; typing a message before the cap simply continues the interview.

## 4. The completed brief

The work-unit prompt (both personas' background drafts) gains one requirement: the Proposal's `spec` must open with

```
## Summary
```

— 3–6 plain-language sentences: what will be built, the key assumptions taken, what parts of the repo it touches — placed **above** the existing `## Assumptions` section. A proposal whose spec lacks the Summary section still parses (never reject a brief over formatting); the needs-review view falls back to showing the spec top as-is.

The needs-review view renders the Summary at the top, above spec/stories/assumptions.

## 5. Approve & run

The proposal preview in a `needs-review` session changes its primary action from Apply to **Approve & run**:

- Performs the existing Apply conversion (item conversion, child Stories with resolved blocked-by, `.tasks.json` sidecars, new roles), then adds the resulting **unblocked** Stories to the pipeline via the existing add-to-pipeline path (Quick Start's "Apply & run" precedent — reuse that code path, not a copy). Blocked Stories wait on their edges as today; an Epic's stories queue as their blockers complete (existing machinery).
- If no drain is active, Approve & run behaves like today's Quick Start act (stories queue; the user starts a drain or the Nightly Window picks them up — whichever the current product behavior is, unchanged).
- **Apply** (write Stories as Ready, don't queue) and **Dismiss** remain as secondary actions; inline proposal previews during a TD interview keep Apply as primary (the user is present and mid-conversation — running is a separate thought there).

## 6. Data model

- `Settings.persona?: 'director' | 'owner'` + `SETTINGS_DEFAULTS.persona = 'director'`.
- `Item` frontmatter gains optional `persona` (stamped at groom creation; absent = resolve from settings per turn).
- No new session states, no new fences, no new files in `.somni/`.

## 7. Error handling

- Work-unit failures already park the session `needs-review` with the failure text — the PO flow inherits this; a failed background brief is a reviewable failure, never a silent loss.
- Auto-handoff hitting the work-unit cap queues FIFO (existing); the session rail shows `queued`.
- Interrupted/resume (app quit mid-draft) is unchanged; a resumed PO groom re-enters the work-unit path.
- M26 provider behavior (read-only refusal, failover for the settings-profiled chat runner) applies to every grooming turn, interactive or background.

## 8. Testing

- Routing: PO entry → work unit from birth; empty-seed PO fallback to first question; TD 3rd answer → handoff carrying the answer; no-fence/no-proposal reply → auto-handoff; inline proposal short-circuits handoff; persona stamped at creation; pre-M27 item resolves persona from settings.
- Preambles: TD preamble carries the 3-question cap; work-unit prompt demands the Summary section.
- Views: persona chip on Quick Start/Groom header flips per-groom; needs-review renders Summary on top; Approve & run applies **and** queues (and Apply-only doesn't queue); Dismiss unchanged.
- Settings: persona default/override resolution.

## 9. Risks

- **Brief quality under PO mode** rests entirely on one assume-and-continue Turn; if briefs come back shallow, the lever is the work-unit prompt (or lifting the one-Turn ceiling — a recorded non-goal today).
- **The 3-round cap is a product bet**: too few for genuinely ambiguous intents. Mitigation: the cap only ends the *asking* — assumptions are recorded in the brief, and re-grooming after review remains cheap.
- **Auto-handoff misfire** (assistant replies with prose but intends to keep interviewing): treated as done-asking and handed off. Acceptable — the brief's Assumptions section surfaces whatever was left unresolved, and the preamble explicitly instructs question-or-propose.
