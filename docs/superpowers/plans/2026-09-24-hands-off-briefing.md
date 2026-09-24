# Hands-Off Briefing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persona-tied grooming depth — Project Owner grooms run autonomously from birth, Technical Director interviews are capped at 3 question rounds then auto-hand-off; completed briefs open with a Summary and carry one Approve & run action.

**Architecture:** Personas change *routing*, not machinery: `sendChat` decides when a turn becomes an M25 work unit (birth for owners, after round 3 or a fenceless reply for everyone), and the prompts gain a universal 3-question cap plus a mandatory `## Summary`. The renderer adds a persona chip, an on-mount handoff for owner grooms with content, Summary rendering, and Approve & run (Apply + queue unblocked stories) on needs-review sessions.

**Tech Stack:** Electron main + React renderer, TypeScript strict, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-hands-off-briefing-design.md`

## Global Constraints

- No new npm dependencies; no AI attribution in commits; `npm run typecheck` green before each commit; `npm test` + `npm run lint` green at each task's final commit.
- Version bumps to `0.6.0` in the final task only (one bump per PR).
- Invariants that must survive (spec): the Ready gate never bends (Approve & run is a deliberate user act); Apply is the only write path from grooming; grooming turns stay read-only via `readOnlyRunner`; the work-unit cap of 3 and FIFO queue unchanged; session-state vocabulary stays separate from Item Status; no darwin-only APIs.
- A work unit stays ONE Turn; no new fence formats; the `somni-groomed` / `somni-question` schemas are unchanged (Summary rides inside the spec text, the Assumptions precedent).
- Style: match surrounding code; `// ponytail:` for deliberate ceilings; terse constraint-stating comments.
- Known flake: voice.test.ts under full-suite load (shared temp WAV race) — if it trips, re-run isolated and report both results.

---

### Task 1: Store — Persona type, setting, item frontmatter

**Files:**
- Modify: `src/main/store.ts` (types ~15-60, `Item` ~93-108, item frontmatter read/write — find where `groomState`/`doneAt` are serialized and mirror them)
- Test: `src/main/store.test.ts`

**Interfaces:**
- Produces: `type Persona = 'director' | 'owner'`, `const PERSONAS: Persona[]`, `Settings.persona?: Persona`, `SETTINGS_DEFAULTS.persona = 'director'`, `Item.persona?: Persona` (persisted in frontmatter, round-trips through save/load/update). Every later task consumes these exact names.

- [ ] **Step 1: Write the failing tests** (append to store.test.ts, following its existing item round-trip test idiom — read a nearby `groomState` persistence test first and copy its shape):

```ts
it('persona setting defaults to director and resolves through overrides', () => {
  expect(SETTINGS_DEFAULTS.persona).toBe('director')
  // resolveSettings layering: repo config wins over global (existing pattern —
  // assert via the same fixture style the concurrency-override test uses)
})

it('item persona round-trips through save and update', () => {
  const item = saveItem(repo, { kind: 'idea', status: 'grooming', name: 'x', persona: 'owner' })
  expect(loadItems(repo).find((i) => i.id === item.id)?.persona).toBe('owner')
  updateItem(repo, item.id, { persona: 'director' })
  expect(loadItems(repo).find((i) => i.id === item.id)?.persona).toBe('director')
})

it('an item without persona loads with persona undefined', () => {
  const item = saveItem(repo, { kind: 'idea', status: 'backlog', name: 'y' })
  expect(loadItems(repo).find((i) => i.id === item.id)?.persona).toBeUndefined()
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/store.test.ts` — FAIL: `persona` not a known property.

- [ ] **Step 3: Implement.** In store.ts:

```ts
// Who the user is to this groom (M27): a Technical Director answers up to
// three sharp questions; a Project Owner drops the idea and reviews the brief.
export type Persona = 'director' | 'owner'
export const PERSONAS: Persona[] = ['director', 'owner']
```

Add `persona?: Persona` to `Settings` and to `Item`; add `persona: 'director' as Persona` to `SETTINGS_DEFAULTS`. Wire `persona` through the item frontmatter serializer/deserializer exactly the way `groomState` is wired (optional field, absent when unset — find every place `groomState` appears in the save/load/update path and add `persona` beside it).

- [ ] **Step 4: Run tests + typecheck** — `npx vitest run src/main/store.test.ts && npm run typecheck` — PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/store.ts src/main/store.test.ts
git commit -m "M27: Persona type — setting default, item frontmatter"
```

---

### Task 2: Prompts — the 3-question cap and the brief Summary

**Files:**
- Modify: `src/main/prompts.ts` (`groomPreamble` interview-discipline block ~55-61, `WORK_UNIT_PROMPT` ~92-108)
- Test: `src/main/prompts.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: unchanged signatures — text-only changes. The cap is UNCONDITIONAL (spec §2/§3: typed turns in an owner session follow the same rules, so no persona parameter exists here).

- [ ] **Step 1: Write the failing tests** (append, following prompts.test.ts's existing contains-text idiom):

```ts
it('groomPreamble caps the interview at three questions', () => {
  const p = groomPreamble([])
  expect(p).toContain('at most THREE questions')
  expect(p).toContain('materially change')
  // the relentless quality bar stays
  expect(p).toContain('somni-question')
})

it('WORK_UNIT_PROMPT demands a Summary section above Assumptions', () => {
  expect(WORK_UNIT_PROMPT).toContain('## Summary')
  expect(WORK_UNIT_PROMPT.indexOf('## Summary')).toBeLessThan(
    WORK_UNIT_PROMPT.indexOf('## Assumptions')
  )
})
```

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/prompts.test.ts` — FAIL.

- [ ] **Step 3: Implement.** In `groomPreamble`, replace the line `'one question at a time — until every branch that changes the work is resolved.'` and its neighbor so the block reads (keep surrounding lines intact):

```ts
'Interview discipline — ask exactly ONE question per reply, as a fenced',
'```somni-question block containing JSON of the form:',
'{"question": "...", "options": ["...", "..."], "recommended": "..."}',
'where "recommended" is one of the options. Ask at most THREE questions in',
'this whole conversation, so make each one count: only a question whose answer',
'would materially change the Spec is worth one of your three. After your third',
'question — or sooner, once you are satisfied — stop interviewing and either',
'propose, or state plainly that you are ready to draft.',
'Inspect the codebase read-only to ask better questions. Never ask a question',
'and propose in the same reply. If I ask you to propose now, stop interviewing',
'and propose immediately, stating your assumptions.',
```

In `WORK_UNIT_PROMPT`, insert before the `## Assumptions` bullet:

```ts
'- The "spec" text MUST OPEN with a section headed exactly "## Summary": three',
'  to six plain-language sentences — what will be built, the key assumptions',
'  you took, and what parts of the repo it touches. Write it for a reader who',
'  will not read the rest.',
```

(Existing `## Assumptions` bullet stays, after it.)

- [ ] **Step 4: Run tests** — prompts + the full chat suite (`npx vitest run src/main/prompts.test.ts src/main/chat.test.ts`) — PASS (chat tests pin preamble content in places; update any literal-text assertions the cap changes).

- [ ] **Step 5: Commit**

```bash
git add src/main/prompts.ts src/main/prompts.test.ts src/main/chat.test.ts
git commit -m "M27: preambles — three-question cap, brief opens with a Summary"
```

---

### Task 3: Chat routing — persona at birth, cap routing, auto-handoff, children from Apply

**Files:**
- Modify: `src/main/chat.ts` (`startGroom` ~61, `sendChat` ~284, `workUnitTurn` ~306, `runTurn` ~316-431, `applyProposal` ~477-525), `src/main/repoIpc.ts` (`groom:start` handler, `chat:apply` handler), `src/preload/index.ts` (startGroom + applyProposal signatures)
- Test: `src/main/chat.test.ts`, `src/main/sessions.test.ts`

**Interfaces:**
- Consumes: `Persona`, `Item.persona`, `Settings.persona`, `SETTINGS_DEFAULTS.persona` (Task 1); existing `handoff` from `./sessions` (chat.ts already imports from sessions — the chat↔sessions runtime cycle predates this task; do not widen it beyond adding `handoff` to the existing import).
- Produces (later tasks rely on these exact shapes):
  - `startGroom(repo: string, persona?: Persona): Item` — stamps `persona` into the new item when given.
  - `questionRounds(repo: string, slug: string): number` — exported; counts assistant transcript messages whose text parses to a `ChatQuestion`.
  - `workUnitTurn(repo, slug, settings, roleSlugs, onEvent, message: string = HANDOFF_MESSAGE)` — the message lands in the transcript as the user line AND (when ≠ HANDOFF_MESSAGE) rides in the prompt above WORK_UNIT_PROMPT.
  - `sendChat` routes to a work unit instead of an interactive turn when: (a) the transcript is empty and the resolved persona is `'owner'`, or (b) `questionRounds >= 3`. Routing result is still `{ ok, error? }` (a cap/queue refusal surfaces as ok:true + queued state via events — handoff() already returns ok for queued).
  - Interactive replies containing neither a question fence nor a proposal fence auto-hand-off the session (both personas).
  - `applyProposal` returns `{ ok: true; item: Item; children: Item[] }` (children in creation order).
  - Persona resolution: `item.persona ?? settings.persona ?? 'director'` — one tiny helper, used by every routing site.

- [ ] **Step 1: Write the failing tests.** Follow chat.test.ts's existing harness (it stubs `turn` — read the top of the file for the seam; call `resetSessions()` from `./sessions` in beforeEach so queue state never leaks). Cover, as real tests:

```ts
// 1. startGroom(repo, 'owner') stamps persona on the created item.
// 2. owner + empty transcript: sendChat routes into a work unit — the turn
//    runs with the WORK_UNIT_PROMPT (assert prompt contains '## Summary'
//    requirement text and the seed text), the transcript's user line is the
//    seed, and the session transitions working (state event).
// 3. director + empty transcript: sendChat runs interactively (prompt contains
//    the somni-question discipline, no WORK_UNIT_PROMPT).
// 4. questionRounds counts only assistant messages with a valid question fence.
// 5. after 3 answered questions (seed transcript with 3 assistant question
//    messages), sendChat routes the 4th user message into a work unit carrying
//    that message text in the prompt.
// 6. an interactive reply with neither fence nor proposal auto-hands-off:
//    stub turn to reply plain prose → expect a working/queued state event and
//    a subsequent work-unit turn (or queued job) for the same slug.
// 7. an interactive reply WITH a proposal fence does NOT hand off.
// 8. applyProposal on an epic returns children in order with resolved
//    blockedBy ids (extend the existing applyProposal test to assert the new
//    `children` field).
// 9. pre-M27 item (no persona) + settings.persona 'owner' → birth routing
//    applies; settings absent → director (no birth routing).
```

Write these as real code against the harness — the comment block above is the coverage list. If the harness cannot express one (say so per-test in the report), get as close as it allows.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/main/chat.test.ts` — FAIL.

- [ ] **Step 3: Implement in chat.ts.**

```ts
// Persona resolution (M27): the groom's own stamp wins, then settings.
const personaOf = (item: Item | undefined, settings: Settings): Persona =>
  item?.persona ?? settings.persona ?? 'director'

export function startGroom(repo: string, persona?: Persona): Item {
  return store.saveItem(repo, {
    kind: 'idea',
    status: 'grooming',
    name: NEW_GROOM_NAME,
    ...(persona ? { persona } : {})
  })
}

// Interview rounds already spent (M27): the cap routes the answer to round
// three into a background draft. Counted from the transcript — the fences are
// already the truth, a counter field would just drift from it.
export function questionRounds(repo: string, slug: string): number {
  return readLines(repo, slug).filter(
    (l): l is ChatMessage => 'role' in l && l.role === 'assistant' && !!parseQuestion(l.text)
  ).length
}
```

`sendChat` becomes the router (same signature):

```ts
export function sendChat(repo, slug, text, settings, roleSlugs, onEvent) {
  if (inFlight.has(slug)) return { ok: false, error: 'a chat turn is already in flight' }
  const item = store.loadItems(repo).find((i) => i.id === slug)
  const birth = readLines(repo, slug).length === 0
  // Hands-off routing (M27): an owner's groom drafts itself from birth; any
  // interview ends after three rounds. Everything else is a normal turn.
  if ((birth && personaOf(item, settings) === 'owner') || questionRounds(repo, slug) >= 3) {
    return handoff(repo, slug, {
      emit: onEvent,
      run: () => workUnitTurn(repo, slug, settings, roleSlugs, onEvent, text)
    })
  }
  void runTurn(repo, slug, text, settings, roleSlugs, onEvent, false)
  return { ok: true }
}
```

`workUnitTurn` gains the message param (default `HANDOFF_MESSAGE`) and passes it as `text` to `runTurn`. In `runTurn`, the work-unit prompt includes the message when it isn't the plain handoff:

```ts
const prompt = workUnit
  ? [
      sessionId ? '' : groomPreamble(roleSlugs, context, settings.methodology),
      text === HANDOFF_MESSAGE ? '' : text,
      WORK_UNIT_PROMPT
    ]
      .filter(Boolean)
      .join('\n')
  : chatPrompt(text, sessionId, roleSlugs, settings, context)
```

Auto-handoff on a fenceless interactive reply — in `runTurn`'s `.then`, after the `done` event logic (place it after `onEvent({ kind: 'done', … })` so the reply renders first, and before autoTitle):

```ts
// A reply that neither asks nor proposes is done talking (M27): the session
// drafts itself rather than idling. Misfires are cheap — the brief's
// Assumptions section carries whatever was left open (spec §9).
if (!workUnit && item && !parseProposal(finalText) && !parseQuestion(finalText)) {
  handoff(repo, slug, {
    emit: onEvent,
    run: () => workUnitTurn(repo, slug, settings, roleSlugs, onEvent)
  })
}
```

(Import `handoff` alongside the existing `cancelQueued` import from `./sessions`.) Note the ordering hazard: `runTurn` clears `inFlight` before this line executes — `handoff`'s `chatBusy` check must not see the finished turn as busy. Verify with test 6.

`applyProposal`: collect the created children and return them:

```ts
const children: Item[] = []
for (const story of proposal.stories) {
  const child = store.saveItem(repo, { /* unchanged fields */ })
  childIds.push(child.id)
  children.push(child)
}
// …
return { ok: true, item: root, children }
```

- [ ] **Step 4: Wire IPC + preload.** `repoIpc.ts`: the `groom:start` handler passes an optional persona arg through to `startGroom(repo, persona)`; `chat:apply` returns the widened result as-is. `preload/index.ts`: `startGroom(repo: string, persona?: Persona)`, `applyProposal` return type gains `children: Item[]` (mirror how `Item` is currently typed there).

- [ ] **Step 5: Run everything** — `npx vitest run src/main/chat.test.ts src/main/sessions.test.ts && npm test && npm run typecheck` — PASS.

- [ ] **Step 6: Commit**

```bash
git add src/main/chat.ts src/main/repoIpc.ts src/preload src/main/chat.test.ts src/main/sessions.test.ts
git commit -m "M27: persona routing — owner grooms draft from birth, interviews cap at three"
```

---

### Task 4: Renderer — persona pick + chip, owner auto-handoff, Summary, Approve & run

**Files:**
- Modify: `src/renderer/src/SettingsView.tsx` (persona select in the form), `src/renderer/src/HomeView.tsx` (Quick Start persona chip + first-run pick strip), `src/renderer/src/GroomView.tsx` (header chip, mount handoff, Summary, Approve & run), `src/renderer/src/App.tsx` (persona threading, onApplied queueing)
- Test: `src/renderer/src/views.test.tsx`

**Interfaces:**
- Consumes: `Persona` (via preload's type re-export idiom — mirror how `RunnerChoice` reached the renderer in M26), `window.somni.startGroom(repo, persona?)`, `applyProposal → { item, children }`, existing `handoffSession`, `pipeline:add` via the existing `startPipeline` helper in App.tsx.
- Produces: UI only. Behaviors:
  1. **Settings**: a Persona select (Technical Director / Project Owner) in the existing form, patching `persona`.
  2. **First-run pick**: HomeView shows a compact two-card pick strip when `settings.persona === undefined`; choosing writes the setting (existing settings-save path); until then resolution defaults to director. Dismissable by picking only — it is one question, once.
  3. **Quick Start chip**: a persona toggle chip beside the Quick Start box, defaulting to the settings value; `quickStart` passes the chip's value to `startGroom(repo, persona)`.
  4. **Groom header chip**: shows the item's resolved persona; clicking flips it via the existing item-update IPC (the same path StoryPanel edits use — find it; it exists because renames/status changes go through it), updating `persona` frontmatter for that groom only.
  5. **Owner mount handoff**: GroomView, on load of an owner-persona groom with an empty transcript, not busy, no groomState, and item content (name ≠ 'New groom' or non-empty spec): call `window.somni.handoffSession(repo, slug)` once. A truly empty owner groom does nothing on mount (spec §2's fallback — the user types, TD rules apply).
  6. **Summary on top**: when a proposal preview renders in a needs-review session, extract the `## Summary` section from `proposal.spec` (text between the `## Summary` heading and the next `##` heading) and render it emphasized above the rest; no Summary section → render as today.
  7. **Approve & run**: in a needs-review session the proposal's primary button is `Approve & run` — on apply success, queue the root (if `status === 'ready'`) plus every child with `blockedBy.length === 0` via `startPipeline([...ids])`, then refresh/navigate as the current autoRun path does. Secondary `Apply` (writes, no queue) and existing Dismiss stay. The inline TD interview preview and the Quick Start autoRun path keep their current labels and behavior.
- App.tsx threading: `onApplied` gains the applied `children` (from the widened applyProposal result — GroomView already owns the apply call, so GroomView computes the queue list and calls a new `onApproveRun(ids: string[])` prop, or passes children through `onApplied` — pick whichever keeps App.tsx's existing `onApplied` shape most intact and note the choice).

- [ ] **Step 1: Write the failing view tests** (views.test.tsx SSR idiom — components called as plain functions, tree-walk helpers): Settings persona select patches `persona`; Home pick strip renders only when persona unset and writes on pick; Quick Start chip toggles and reaches `startGroom`; Groom header chip renders resolved persona; Summary block renders above spec when `## Summary` present in a needs-review proposal and not otherwise; needs-review primary button reads `Approve & run` while the interview-inline preview keeps `Apply`; the approve-run handler queues root + unblocked children ids (assert the ids passed to the queue callback).

- [ ] **Step 2: Run to verify failure**, then **implement** per the behavior list. The Summary extractor is a small pure function — put it in GroomView (or ui.ts if GroomView is getting crowded):

```ts
export function briefSummary(spec: string): string | null {
  const m = spec.match(/^## Summary\s*\n([\s\S]*?)(?=\n## |$)/m)
  return m ? m[1].trim() || null : null
}
```

- [ ] **Step 3: Run tests** — `npx vitest run src/renderer/src/views.test.tsx && npm run typecheck` — PASS.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src src/preload
git commit -m "M27: persona chip and pick, owner auto-draft, brief Summary, Approve & run"
```

---

### Task 5: Docs, vocabulary, version 0.6.0

**Files:**
- Modify: `design/architecture.md` (§7 Grooming + §7.1 Sessions), `CONTEXT.md` (Grooming machinery vocabulary), `README.md` (intro workflow + step 3/step 7), `package.json`

**Interfaces:** none — prose only. The docs must describe the code as built (verify claims against chat.ts/prompts.ts before writing).

- [ ] **Step 1: architecture.md.** §7: the interview cap (three questions, materially-change bar, then propose-or-draft), persona routing in `sendChat` (owner birth → work unit; round-3 answer → work unit; fenceless reply → auto-handoff), the Summary requirement in the work-unit prompt, Approve & run (Apply + queue unblocked, the Quick Start precedent) — in the existing decision-recording voice. §7.1: note auto-handoffs share the cap-3 FIFO queue.

- [ ] **Step 2: CONTEXT.md.** Add to Grooming machinery:

```
- **Persona** — who the user is to a groom: the **Technical Director** answers up to three high-leverage Questions before the session drafts itself; the **Project Owner** never answers — their grooms draft from birth. A global setting with a per-groom override, stamped on the item at creation; typing into any session is opting into the Director's rules.
- **Brief** — the completed background draft parked in needs-review: a Proposal whose Spec opens with a plain-language Summary above its Assumptions. **Approve & run** applies it and queues its unblocked Stories in one act; the Ready gate holds.
```

Update **Handoff** ("only the user triggers one") to acknowledge M27's automatic handoffs: the persona rules may trigger one on the user's standing instruction — the persona selection IS the trigger, recorded once.

- [ ] **Step 3: README.** Step 3 (create workflow/groom): describe persona-tied grooming (one sentence each for TD/PO). Step 7 (tune): persona setting. Intro: a sentence that briefs complete in the background and land with a summary for one Approve & run.

- [ ] **Step 4: package.json** → `"version": "0.6.0"`.

- [ ] **Step 5: Full suite** — `npm test && npm run typecheck && npm run lint` — all green. **Commit**

```bash
git add design/architecture.md CONTEXT.md README.md package.json
git commit -m "M27: hands-off briefing — docs, vocabulary, v0.6.0"
```
