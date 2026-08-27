# M13 — UI design spec (Designer deliverable)

Board home view + StoryPanel, replacing `WorkflowsView`. Written against M13.md's frozen scope and CONTEXT.md's Phase-3 vocabulary (Item / Idea / Epic / Story / Subtask / Spec / Ready gate / Board / Needs Attention / Acceptance). Stays inside "Nocturnal Mission Control" (`design/stitch_somni_ai_orchestrator/somni_nocturnal_mission_control/DESIGN.md`) — no new colors, no new Material glyphs, no new CSS. Everything below composes `src/renderer/src/ui.ts` atoms plus two small additions to that file (§0).

Renderer-side shape assumed (mirrors the store schema in M13.md's Engineer scope; exact field/IPC names are Engineer's call):

```ts
type ItemStatus =
  | 'backlog' | 'grooming' | 'ready' | 'in-progress' | 'needs-attention' | 'review' | 'done'
type Item = {
  id: string // "SOM-42-add-image-upload"
  kind: 'idea' | 'epic' | 'story'
  title: string
  status: ItemStatus
  epic?: string // parent item id, story only
  blockedBy?: string[] // other story ids
  created: string
  spec: string // frontmatter body — empty string until authored
}
type Subtask = Task // existing { title, prompt, role, selected } shape, unchanged
```

## 0. New atoms in `ui.ts`

Two additions, both following the exact `STATUS_CHIP` formula already established (low-opacity fill + full-strength text + low-opacity border, built from tokens that already exist — no new hex values):

```ts
// Kind chip (M13-ui.md §1) — "Idea" stays the plain muted CHIP already used
// everywhere else for de-emphasized metadata; Story/Epic get a hint of the
// two colors the app already reserves for "structure" (primary) vs a second
// hue for grouping (tertiary), at the same low-opacity STATUS_CHIP treatment.
export const KIND_CHIP: Record<'idea' | 'story' | 'epic', string> = {
  idea: CHIP,
  story: `${STATUS_CHIP_BASE} bg-primary-container/10 text-primary border-primary-container/30`,
  epic: `${STATUS_CHIP_BASE} bg-tertiary-container/10 text-tertiary border-tertiary-container/30`
}

// Small muted metadata pill for card footers — blockedBy, subtask counts.
// Same shape as CHIP, smaller type, for a second line of card metadata that
// shouldn't compete with the kind chip.
export const CHIP_SM = 'px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant text-[11px] font-mono-code'
```

Everything else on the Board reuses `CHIP`, `KIND_CHIP`, `CHIP_SM`, `STATUS_CHIP`/`statusChip`, `BTN_PRIMARY`, `BTN_GHOST`, `BTN_GHOST_SM`, `BTN_DANGER`, `ICON_BTN`, `INPUT`, `INPUT_TITLE`, `TEXTAREA`, `LABEL`, `ERROR_BANNER` — no other new class strings.

## 1. Board layout

Seven fixed columns, left to right, matching CONTEXT.md's Status line: **Backlog · Grooming · Ready · In Progress · Needs Attention · Review · Done**.

```
┌ New Story ┐                                                              (page-level primary action)

┌─Backlog──┐┌─Grooming─┐┌─Ready────┐┌─In Progress┐┌─Needs Attn─┐┌─Review───┐┌─Done─────┐
│ 4        ││ 1        ││ 2        ││ 1          ││ 1          ││ 1        ││ 12       │
├──────────┤├──────────┤├──────────┤├────────────┤├────────────┤├──────────┤├──────────┤
│ [card]   ││ [card]   ││ [card]   ││ [card]     ││ [card]     ││ [card]   ││ [card]   │
│ [card]   ││          ││ [card]   ││            ││            ││          ││ [card]   │
│ [card]   ││          ││          ││            ││            ││          ││ …        │
│ [card]   ││          ││          ││            ││            ││          ││          │
└──────────┘└──────────┘└──────────┘└────────────┘└────────────┘└──────────┘└──────────┘
```

```tsx
<div className="flex min-h-0 flex-1 flex-col gap-stack-gap">
  <button className="self-start rounded-full bg-primary-container px-4 py-2 text-sm font-medium text-white shadow-[0_0_12px_rgba(109,90,224,0.3)] transition-colors hover:bg-inverse-primary" onClick={newStory}>
    New Story
  </button>
  <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto">
    {COLUMNS.map((col) => (
      <Column key={col.status} {...col} />
    ))}
  </div>
</div>
```

- `COLUMNS` is a fixed, ordered array of `{ status, label }` — never reordered, never hidden. Grooming stays visible and drop-targetable even though nothing populates it until M14 (§6).
- Each `Column` is `min-w-[220px] flex-1 basis-0` with its own `flex flex-col` and an internal `overflow-y-auto` card list — so one column with 20 cards scrolls independently and never pushes the others off-balance.
- **Overflow behavior**: seven columns at a sane readable width (≥220px each) don't fit most laptop screens at once — that's expected, not a bug. The board container is `overflow-x-auto`; columns keep their `min-w` and the *board* scrolls horizontally rather than columns compressing into unreadable slivers. The column header row isn't separately sticky-positioned (no horizontal-scroll-synced header trick — that's a new interaction pattern for one view); each column's own header sits at the top of its own vertical scroll area (`sticky top-0` within the column), which is enough since horizontal scroll moves whole columns, not just headers.
- Column header: `LABEL` text (e.g. `BACKLOG`) + a count badge using `CHIP` (`{items.length}`), same row, `flex items-center justify-between border-b border-border-subtle pb-2 mb-2 sticky top-0 bg-background`.
- Column body is the HTML5 drop target (§4). Empty column body shows a centered, muted one-liner in `text-sm text-on-surface-variant` — see §5 for exact copy per column.
- "New Story" reuses the exact primary-pill formula from `WorkflowsView`'s old "New workflow" button (position, shadow, colors) — the one page-level creation affordance in M13 (no capture/quick-add yet, that's M15 — see "Deliberate omissions").

## 2. Card anatomy

Base card shell — same formula as `PipelineView`'s workflow card:

```tsx
<div
  draggable={draggable}
  onDragStart={(e) => e.dataTransfer.setData('text/plain', item.id)}
  className={`rounded-xl border bg-surface-elevated p-card-padding transition-colors cursor-pointer ${borderClass}`}
  onClick={() => openStoryPanel(item.id)}
>
  <div className="flex items-center justify-between gap-2">
    <span className="font-mono-code text-mono-code text-on-surface-variant">{item.id.split('-').slice(0, 2).join('-')}</span>
    <span className={KIND_CHIP[item.kind]}>{item.kind === 'idea' ? 'Idea' : item.kind === 'epic' ? 'Epic' : 'Story'}</span>
  </div>
  <p className="mt-1 font-semibold text-on-surface">{item.title}</p>
  {/* per-column metadata row + action, see below */}
</div>
```

- `borderClass` default: `border-border-subtle hover:border-outline-variant` (identical hover treatment to every other card in the app).
- Clicking anywhere on the card (except its action button, which stops propagation) opens the StoryPanel (§7) for that item — same "click row to edit" idiom as `WorkflowsView`'s old workflow list.
- `draggable` is `true` for every card except **Done** cards (dragging something out of Done has no defined meaning — Acceptance is one-way) and **In Progress** cards (their status is executor-owned, not user-dragged — see §4).

Per-column metadata row + affordance, added below the title:

| Column | Metadata row | Affordance |
|---|---|---|
| Backlog | subtask count if any (`CHIP_SM`, e.g. `2 subtasks`) or nothing for a bare Idea | `Groom →` (`BTN_GHOST_SM`) |
| Grooming | same subtask count | none yet — click the card to open StoryPanel and hand-author (§6) |
| Ready | subtask count; `Blocked by SOM-12` (`CHIP_SM`, only if any `blockedBy` item isn't `done`) | `Add to pipeline` (`BTN_PRIMARY`, disabled + tooltipped while blocked) |
| In Progress | `n/m subtasks done`; running vs waiting state via border (below) | none (click opens StoryPanel, read-only body — see §7) |
| Needs Attention | failure summary line if the API provides one, else nothing | `Re-run` (`BTN_GHOST_SM`, text-error variant: reuse `BTN_DANGER`'s color logic — border-border-subtle, text-error, hover:bg-error-container/20) |
| Review | nothing extra | `Accept` (`BTN_PRIMARY`) |
| Done | nothing extra | none |

- **In Progress border**: running → the exact glow already defined in `PipelineView` (`border-status-running shadow-[0_0_12px_rgba(109,90,224,0.3)]`); waiting on an unmet `blockedBy` → `border-status-queued` plain, no glow, with the metadata row reading `Waiting on SOM-12` instead of a subtask count. This is the same semantic distinction the executor already makes (`next()` skips blocked items) surfaced as a visual state, not a new concept.
- **Needs Attention border**: `border-status-failed/40` (same token `STATUS_CHIP.Failed` already uses for its border, applied directly to the card instead of a chip).
- **Epic cards**: no subtask count, no per-column action button in Ready/In Progress/Needs Attention/Review (epics never execute — CONTEXT.md). In practice an Epic only ever sits in Backlog or Grooming; its metadata row instead shows story progress: `3/5 stories done` (computed client-side by counting items whose `epic === this.id`). Clicking an Epic card opens StoryPanel in its epic layout (§7.3).
- **Idea cards** (`kind === 'idea'`): only ever appear in Backlog in M13 (nothing in this milestone produces one — see "Deliberate omissions"). They carry no subtask count and their `Groom →` click opens StoryPanel with an empty spec/subtask editor, same as a hand-created Story — Grooming (M14) is what will eventually make this smarter, not a difference in the M13 shell.

## 3. `Groom →` — the M13 placeholder

Per M13.md's scope, Grooming as an AI interview doesn't exist yet — the column has to render and accept a card without an editor to hand it off to. `Groom →` is therefore a plain, honest status move plus an editing handoff, nothing more:

```tsx
const groom = async (item: Item): Promise<void> => {
  const res = await window.somni.setItemStatus(repo, item.id, 'grooming')
  if (res.ok) { refresh(); openStoryPanel(item.id) }
}
```

This is a status change like any other column move (no gate applies to entering `grooming`), immediately followed by opening StoryPanel so the user can hand-write the Spec and Subtasks right there — the same "hand-authored stories" path Goal #1 requires, just entered via a button instead of a drag. Clicking a bare Grooming-column card does the same thing (opens StoryPanel) since there's no separate "start interview" step to gate on yet.

## 4. Drag and drop

Native HTML5 DnD (`draggable`, `onDragStart`, `onDragOver`, `onDrop`) — no library.

```tsx
// Card
<div
  draggable
  onDragStart={(e) => e.dataTransfer.setData('text/plain', item.id)}
  ...
/>

// Column drop zone
<div
  className={`flex-1 overflow-y-auto rounded-lg transition-colors ${refused === col.status ? 'ring-2 ring-error' : ''}`}
  onDragOver={(e) => e.preventDefault()}
  onDrop={async (e) => {
    const id = e.dataTransfer.getData('text/plain')
    const res = await window.somni.setItemStatus(repo, id, col.status)
    if (res.ok) refresh()
    else flashRefused(col.status, res.error)
  }}
>
```

- No optimistic move: the card only relocates after `refresh()` picks up main's new truth. A refused drop therefore needs zero "snap back" animation — the card was never moved in the first place, which is the simplest possible correct behavior (main is the sole authority per M13.md; the UI never needs to guess and undo).
- **Refused-drop treatment** (the Ready gate firing, or any other future refusal): the target column gets a 600ms `ring-2 ring-error` flash (`flashRefused` sets a `{status, error}` bit of state, cleared by `setTimeout`), plus a compact `ERROR_BANNER` appears pinned under that column's header for ~3s (auto-dismiss, also closable):

```tsx
{refused?.status === col.status && (
  <div className={`${ERROR_BANNER} mb-2 text-xs`}>
    {refused.error}
    <button className={ICON_BTN} onClick={() => setRefused(null)}>
      <span className="material-symbols-outlined text-[16px]">close</span>
    </button>
  </div>
)}
```

  `refused.error` is main's own message (e.g. "Story needs a spec and at least one subtask") — the UI doesn't maintain its own copy of gate rules, it just surfaces whatever main refuses with. This is the one place the Ready gate's wording reaches the user; StoryPanel's own hint (§7.2) is separate, gentler copy for the same rule.
- No shake/bounce keyframe on the card itself — a new CSS animation for one interaction isn't worth it when the column-level flash plus banner already unambiguously communicates "rejected, and here's why."
- In Progress cards aren't `draggable` (§2) — there is no user-meaningful drag target for a running Story; dragging it to Needs Attention or Review would just race the executor's own transition. If the user wants to intervene mid-run, that's Pipeline view's Cancel, unchanged from today.

## 5. Empty states

Every column always renders its shell (header + count, even if 0) — the seven-column structure is permanent furniture, per Goal #1 needing Backlog/Ready/In Progress/Needs Attention/Review to all exist from a fresh repo. Per-column empty copy, centered, `text-sm text-on-surface-variant`, no icon (matches the plain-text empty states already used in `PipelineView`/`WorkflowsView`):

| Column | Copy |
|---|---|
| Backlog | "Nothing yet — New Story to get started." |
| Grooming | "Nothing being groomed." |
| Ready | "No stories ready — groom one, then drag it here." |
| In Progress | "Nothing running." |
| Needs Attention | "Nothing needs attention." |
| Review | "Nothing to review." |
| Done | "Nothing shipped yet." |

A fresh repo therefore shows all seven column shells with their empty copy and the single `New Story` button — no separate "zero state" screen for the whole Board.

## 6. Grooming column (M13 shell, M14 fills it)

Nothing populates this column automatically in M13 — items arrive only via `Groom →` (§3) or a manual drag. The column has no special empty-state treatment beyond §5's plain copy; it is not visually marked "coming soon" or disabled, because it already does something real (hosts hand-groomed stories, opens StoryPanel) even before M14's interview exists. This is the only requirement M13 has on this column: render it, accept drops into and out of it, no gate.

## 7. StoryPanel

Full-content swap, replacing the Board in the main content area — the exact same pattern `WorkflowsView` used for its list ↔ editor toggle (not a 340px side panel; that width is reserved for the chat panel idiom used elsewhere, a different concept from an item editor). Opened by clicking any card or `Groom →`; closed by a header "Back to Board" ghost button, which is also where Save/Cancel live.

```
┌──────────────────────────────────────────────────────────────┐
│ ← Back to Board                    [Story chip]  [Save][Cancel][Delete] │
│ SOM-42                                                         │
│ [ INPUT_TITLE: title..........................................] │
├──────────────────────────────────────────────────────────────┤
│ SPEC                                                            │
│ [ textarea, min-h-40, full width ]                              │
│                                                                  │
│ ⚠ Needs a non-empty spec and ≥1 subtask before it can go Ready  │  (only if unmet)
├──────────────────────────────────────────────────────────────┤
│ SUBTASKS                                                        │
│  1. [title][role ▾] [↑][↓][×]                                   │
│     [prompt textarea]                                          │
│  2. …                                                            │
│  [+ Add subtask]                                                 │
└──────────────────────────────────────────────────────────────┘
```

### 7.1 Header

```tsx
<div className="flex items-center justify-between border-b border-border-subtle pb-4 mb-6">
  <button className={BTN_GHOST_SM} onClick={closePanel}>
    <span className="material-symbols-outlined text-[16px]">arrow_back</span> Back to Board
  </button>
  <div className="flex items-center gap-2">
    <span className={KIND_CHIP[item.kind]}>{kindLabel(item.kind)}</span>
    <button className={BTN_PRIMARY} onClick={save}>Save</button>
    <button className={BTN_GHOST} onClick={closePanel}>Cancel</button>
    <button className={BTN_DANGER} onClick={remove}>Delete</button>
  </div>
</div>
<span className="font-mono-code text-mono-code text-on-surface-variant">{item.id}</span>
<input className={INPUT_TITLE} value={item.title} onChange={...} placeholder="Story title" />
```

`arrow_back` is a new glyph not in today's subset (§ note in "Open questions") — everything else in this spec reuses existing glyphs (`close`, `add`, `arrow_upward`, `arrow_downward`).

### 7.2 Spec (Story and Idea)

```tsx
<div className="mt-6">
  <span className={LABEL}>Spec</span>
  <textarea className={`${TEXTAREA} min-h-40 mt-2`} value={item.spec} onChange={...}
    placeholder="What are we building, and how do we know it's done?" />
  {!readyEligible(item, subtasks) && (
    <p className="mt-2 text-xs text-on-surface-variant">
      Needs a non-empty spec and at least one subtask before it can move to Ready.
    </p>
  )}
</div>
```

- Plain textarea, not the read-only collapsed `<details>` treatment the old Brief used — Briefs were AI-written and read-only-in-app; a hand-authored Spec is editable text like any other field, at parity with `WorkflowsView`'s subtask prompt fields (`TEXTAREA`).
- The hint line is informational only, never blocking Save — Save always persists whatever's typed (main is the enforcement point, at the actual status-change attempt, per §4's refusal banner). This keeps StoryPanel's one job "edit the fields," with the gate living in exactly one place.

### 7.3 Subtask editor (Story only — not Epic, not Idea)

Cannibalized verbatim from `WorkflowsView.tsx`'s task-row block (`src/renderer/src/WorkflowsView.tsx:139-236`): numbered row, title input + role `<select>` + reorder ↑/↓ + remove ×, prompt `TEXTAREA` below, `RefineControl`/`MicButton` under the prompt, "+ Add subtask" ghost button at the bottom. Rename identifiers only (`Task`→`Subtask` vocabulary per CONTEXT.md; the wire shape is unchanged per M13.md's Engineer scope, so `patchTask`/`moveTask`/`emptyTask` port with a s/task/subtask/ rename and nothing else). No new visual element — this section **is** that block, addressed at `item.id`'s `.tasks.json` sidecar instead of a workflow's `tasks` array.

- **Idea** (`kind === 'idea'`, still ungroomed): Spec section only, no subtask editor rendered at all — an Idea has no subtasks by definition (CONTEXT.md: "Ideas carry no plan"). If the user starts adding subtasks by hand, that's the UI's cue to promote it — see "Open questions."
- **Epic**: Spec section, then in place of the subtask editor, a read-only list of child Stories (`epic === item.id`), one row per Story: id, title, `statusChip`-style status pill (reusing the Board's status vocabulary, not the Subtask `TaskStatus` scale), click-through to that Story's own StoryPanel. No "add subtask" — Epics decompose into Stories only through Grooming (M14), not hand-editing here.

### 7.4 In Progress / Done read consistency

A Story open from In Progress, Needs Attention, Review, or Done still opens the same StoryPanel (Spec + Subtasks), fully editable — M13 doesn't lock the panel based on status. Editing a Subtask's prompt while its Story is mid-run has no effect on the run already in flight (the executor already snapshot the sidecar at pipeline:add time, per how the existing engine reads workflow definitions) — this is pre-existing behavior carried over unchanged, not a new StoryPanel concept.

## 8. PO / Engineer view modes

Both modes land on Board as the home view — `App.tsx`'s `VIEWS` map gets `Board` in place of `Workflows` (same slot, same `account_tree` glyph — a hierarchy icon already fits "items with epics/stories/subtasks," and reusing it avoids re-subsetting the icon font for a new glyph the way a dedicated kanban icon would). `PO_VIEWS` swaps `'Workflows'` for `'Board'`; the fallback in `switchMode` (`if (m === 'po' && !PO_VIEWS.includes(view)) setView('Workflows')`) becomes `setView('Board')`.

Mode does not change Board's layout, columns, or card contents — CONTEXT.md's PO hat is "capture, groom, accept," Engineer hat is "full editing," but both of those are just different corners of the same StoryPanel (a PO groom-and-accept flow touches Spec text and clicks Accept; an Engineer edits Subtasks and roles) — there's no card or column that only one mode can see. This matches Decision 9 from M9/M11: modes are presentation-only, never a second data view.

## Deliberate omissions

- **Idea creation** — nothing in M13 produces a `kind: 'idea'` item (Capture is M15's quick-add/palette). The Idea chip, empty-subtask card shape, and Backlog's "no plan yet" states are all designed and functional today, they just currently only get exercised by a hand-seeded or v1-migrated item; M15 slots its quick-add row into the existing Backlog column header without any Board rework, as required.
- **Grooming interview UI** — out of scope per M13.md; §6 designs only the honest do-nothing-clever shell.
- **A promote-Idea-to-Story control inside StoryPanel** — see "Open questions"; not designed here because M13 has no path that produces a bare Idea to promote from in the first place.
- **Sticky, scroll-synced column headers across the whole board** — each column's own header sticks within its own scroll area (§1); a single header bar that stays put while the whole board scrolls horizontally would need extra state/measurement for a problem the per-column sticky already solves acceptably.
- **A drag "snap back" animation on refusal** — there's nothing to snap back; the card is never moved until main confirms (§4).
- **Locking StoryPanel fields based on status** (e.g. read-only Spec once Done) — M13.md doesn't ask for it, and it would need its own rule about which fields lock at which status; simplest correct behavior is "the panel always shows the current truth, editable," same as every other definition view in the app today.
- **A distinct Epic creation button** — "New Story" is the one creation affordance (Epics arise from Grooming an intent at Epic altitude per CONTEXT.md, which is M14 territory); out of scope here.

## Open questions for the TD

1. Epics only ever populate Backlog/Grooming in this design (never execute, so never enter Ready/In Progress/Needs Attention/Review — CONTEXT.md is explicit on this). Should the Ready gate explicitly refuse non-Story kinds (defense in depth), or is it acceptable that the UI simply never offers the drag/button path to move an Epic there? Affects whether Engineer needs a kind check in the gate or can rely on the UI never presenting the affordance.
2. `arrow_back` for StoryPanel's "Back to Board" button is not in today's subsetted icon font (§7.1) — every other glyph in this spec reuses the existing subset. Confirm it's fine to add one glyph to the Material Symbols subset (per the `main.css` maintenance note), or say if a text-only "‹ Back to Board" (no icon) is preferred instead to avoid touching the font asset this milestone.
3. If a hand-authored Idea (however it gets there — v1 migration, a future M15 capture, or manual store editing) has subtasks added to it in StoryPanel, should the UI auto-promote its `kind` to `story`, or leave `kind` alone until an explicit action? Not designed above (§7.3 flags it) since M13 produces no Ideas to test this against; safe to defer to M14/M15 if today's answer is "leave it alone."
