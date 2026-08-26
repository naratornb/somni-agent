# M10 — UI design spec (Designer deliverable)

Written against DESIGN.md's tokens (`design/stitch_somni_ai_orchestrator/somni_nocturnal_mission_control/DESIGN.md`) and the four `code.html` mocks. Covers the four surfaces the mocks don't show — Roles, Settings, Playground, editor chat panel — plus the interview question-chip card and Propose Now styling that `drafting_interface/code.html` omits. No new tokens, no new colors: every class below is a Tailwind utility built from a DESIGN.md token or an arbitrary value already used in a mock (`bg-status-*/10`, `bg-black`, etc.).

All four surfaces share the shell already established by the mocks (240px sidebar, TopAppBar with repo path + Choose repo/Refresh, `p-gutter` main content) — nothing below repeats that; it starts at the view body.

## 0. Shared atoms (used across all four surfaces)

These aren't shown in any single mock but are assembled from patterns that repeat across all four — pin them down once so Roles/Settings/Playground/chat don't each invent a slightly different button or field. Engineer may lift these into small helper components (`Field`, `Btn` etc.) or just repeat the class strings; either is fine, no new dependency either way.

**Buttons**
- Primary (`Save`, `Send`, `Run`, `Apply`): `bg-primary-container text-on-primary-container hover:opacity-90 font-semibold px-4 py-2 rounded-lg transition-opacity disabled:opacity-40 disabled:pointer-events-none` — matches `pipeline_dashboard`'s "Drain queue" button exactly (primary buttons in the shipped mocks are `rounded-lg`, not pill; DESIGN.md's prose says pill, the mocks it must port verbatim say `rounded-lg` — mocks win, per the brief's directional-fidelity rule).
- Ghost (`Cancel`, `New role`, `New draft`, `Choose repo…`-style utility actions): `bg-surface-container-high hover:bg-surface-variant text-on-surface-variant hover:text-on-surface px-4 py-2 rounded-lg border border-border-subtle transition-colors disabled:opacity-40 disabled:pointer-events-none` (the sidebar's "New Workflow" button pattern).
- Danger (`Delete`): `bg-surface border border-border-subtle text-error rounded-lg px-4 py-2 text-sm hover:bg-error-container/20 transition-colors disabled:opacity-40 disabled:pointer-events-none` (lifted from `runs_reports`' delete-report icon button, generalized to a labeled button).
- Icon-ghost (reorder arrows, close/✕): `text-on-surface-variant hover:text-on-surface p-1.5 rounded hover:bg-surface-container transition-colors` (`workflows_editor` reorder buttons), `opacity-0 group-hover:opacity-100` on the parent row when the affordance should only show on hover.

**Form field row** (label + one control, the SettingsView/RolesView idiom):
```tsx
<label className="flex items-center gap-3 py-2">
  <span className="w-48 shrink-0 font-mono-label text-mono-label uppercase text-on-surface-variant">
    {label}
  </span>
  {/* input/select/textarea, flex-1 */}
</label>
```
`font-mono-label uppercase tracking-wide` is DESIGN.md's "mono-spaced labels... uppercase with slight letter spacing" rule, applied to every field label in Settings/Roles — this is the one piece of chrome that makes an otherwise plain form read as "mission control" rather than a generic settings page.

**Inputs/selects/textareas** (from `workflows_editor`): `bg-surface-container text-on-surface px-3 py-1.5 rounded border border-border-subtle focus:outline-none focus:border-primary text-sm` (+ `font-mono-code` when the content is technical — binary paths, prompts, model strings; plain `font-body-md` for prose like role names and preambles).

**Chips**: default `px-2 py-0.5 rounded-full bg-surface-variant text-on-surface-variant font-mono-label text-mono-label`; status-scale variant (used for Armed) `bg-status-completed/10 text-status-completed border border-status-completed/20` per `runs_reports`' completed/failed chip formula — Disarmed uses the default gray chip, Armed swaps to the completed-green formula (reuses the existing scale rather than inventing an "armed" color).

## 1. RolesView

**List state** — one `.list`-equivalent stack of role rows, styled as flat rows (not full task-cards; roles aren't draggable/orderable like tasks, so the heavier card chrome isn't earned):

```tsx
<div className="flex flex-col gap-2">
  <button className="{ghost} self-start">+ New role</button>
  <ul className="flex flex-col gap-1">
    {roles.map((r) => (
      <li key={r.slug}
          className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-surface-container cursor-pointer transition-colors"
          onClick={() => setEditing(r)}>
        <span className="font-semibold text-on-surface">{r.name}</span>
        <span className="px-2 py-0.5 rounded-full bg-surface-variant text-on-surface-variant font-mono-label text-mono-label uppercase">
          {r.slug}
        </span>
        <span className="text-on-surface-variant text-sm truncate">
          {r.preamble.slice(0, 80) || 'no preamble'}
        </span>
      </li>
    ))}
  </ul>
</div>
```

**Editor state** — a single-column card, same visual weight as the workflow editor's embedded panel:

```tsx
<div className="bg-surface-elevated border border-border-subtle rounded-xl p-6 flex flex-col gap-4">
  <input className="w-full bg-transparent text-headline-lg font-headline-lg font-semibold text-on-surface border-b border-border-subtle pb-2 focus:outline-none focus:border-primary"
         placeholder="Role name (e.g. Senior Developer)" value={editing.name} onChange={...} />
  <textarea rows={12}
    className="w-full bg-surface-container text-on-surface p-3 rounded border border-border-subtle focus:outline-none focus:border-primary font-mono-code text-sm resize-y"
    placeholder="Persona preamble prepended to every task prompt…" value={editing.preamble} onChange={...} />
  <div className="flex items-center gap-3">
    <span className="font-mono-label text-mono-label uppercase text-on-surface-variant">Overrides</span>
    <select className={input}>...</select>   {/* runner: inherit/claude/antigravity */}
    <input className={`${input} font-mono-code flex-1`} placeholder="Model (inherit)" ... />
    <select className={input}>...</select>   {/* effort: inherit/low/medium/high */}
  </div>
  <div className="flex items-center gap-3 pt-2 border-t border-border-subtle">
    <button className={primary} disabled={!editing.name.trim()}>Save</button>
    <button className={ghost}>Cancel</button>
    {editing.slug && <button className={danger}>Delete</button>}
  </div>
</div>
```

- Preamble textarea gets `font-mono-code` (it's the technical artifact prepended to prompts) even though the name field is prose (`font-headline-lg`, matching the workflow-title input in `workflows_editor`).
- The three-select override row reuses the exact `workflows_editor` task-role-select visual, just relabeled — no new select chrome.
- Name field styled as the "big title input" from `workflows_editor` rather than a plain bordered input: it's the one thing on this card the user is naming, same as a workflow title.

## 2. SettingsView

One `bg-surface-elevated border border-border-subtle rounded-xl p-6` card containing the field-row stack (§0 "Form field row" atom) in the existing order: Max concurrency, Task timeout, Report style, Nightly Window, Runner, claude binary, agy binary, Model, Effort, then a footer row with Save + "Saved" confirmation + the override-hint paragraph.

```tsx
<div className="bg-surface-elevated border border-border-subtle rounded-xl p-6 flex flex-col divide-y divide-border-subtle">
  <FieldRow label="Max concurrency"><input type="number" className={input} min={1} ... /></FieldRow>
  <FieldRow label="Task timeout (min)"><input type="number" className={input} min={1} ... /></FieldRow>
  <FieldRow label="Report style"><select className={`${input} flex-1`}>...</select></FieldRow>
  <FieldRow label="Nightly window">
    <input type="time" className={input} value={s.nightlyTime ?? ''} ... />
    <label className="flex items-center gap-2 ml-3">
      <input type="checkbox" className="w-4 h-4 rounded border-outline bg-transparent text-primary-container focus:ring-primary-container cursor-pointer"
             checked={!!s.nightlyArmed} disabled={!s.nightlyTime} ... />
      <span className={s.nightlyArmed
        ? 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-status-completed/10 text-status-completed border border-status-completed/20'
        : 'px-2.5 py-0.5 rounded-full text-xs font-medium bg-surface-variant text-on-surface-variant'}>
        {s.nightlyArmed ? 'Armed' : 'Disarmed'}
      </span>
    </label>
  </FieldRow>
  <FieldRow label="Runner"><select className={`${input} flex-1`}>...</select></FieldRow>
  <FieldRow label="claude binary"><input className={`${input} font-mono-code flex-1`} placeholder="claude (found on PATH)" ... /></FieldRow>
  <FieldRow label="agy binary"><input className={`${input} font-mono-code flex-1`} placeholder="agy (found on PATH)" ... /></FieldRow>
  <FieldRow label="Model"><input className={`${input} font-mono-code flex-1`} placeholder="CLI default" ... /></FieldRow>
  <FieldRow label="Effort"><select className={`${input} flex-1`}>...</select></FieldRow>
</div>
<div className="flex items-center gap-3 mt-4">
  <button className={primary}>Save</button>
  {saved && <span className="text-on-surface-variant text-sm">Saved</span>}
</div>
<p className="text-on-surface-variant text-sm mt-3">
  A repo can override any of these in <code className="font-mono-code">.somni/config.json</code>; a role can override runner/model/effort in its frontmatter.
</p>
```

- `divide-y divide-border-subtle` gives the 10-row form quiet horizontal separation without adding a border per row (avoids "form with a fence around every field" clutter — restful density per DESIGN.md).
- The checkbox uses the exact class string from `workflows_editor`'s tick checkbox (`w-4 h-4 rounded border-outline bg-transparent text-primary-container focus:ring-primary-container cursor-pointer`) so every checkbox in the app (tick, Keep Running toggle, Nightly Armed) is visually one control.
- Armed/Disarmed chip formula matches §0 exactly — this is the same control M9-ui.md specified in the old CSS vocabulary (`chip ok` / `chip`); this section just ports it to Tailwind, no behavior change.

## 3. Playground

Two-zone stack: prompt input on top, true-black live-log pane below, per DESIGN.md's Live Logs rule ("monospaced text on a true-black background (#000000) within a rounded card").

```tsx
<div className="flex flex-col gap-stack-gap h-full">
  <textarea rows={3}
    className="w-full bg-surface-container text-on-surface p-3 rounded-lg border border-border-subtle focus:outline-none focus:border-primary font-mono-code text-sm resize-y"
    value={prompt} onChange={...} />
  <button className={primary + ' self-start'} disabled={running || !prompt.trim()}>
    {running ? 'Running…' : 'Run'}
  </button>
  <pre ref={paneRef}
    className="flex-1 min-h-0 overflow-y-auto bg-black border border-border-subtle rounded-xl p-4 font-mono-code text-mono-code text-on-surface-variant whitespace-pre-wrap">
    {lines.join('\n')}
  </pre>
  {footer && <div className="font-mono-code text-mono-code text-on-surface-variant">{footer}</div>}
</div>
```

- `bg-black` is Tailwind's built-in `#000000` — the one place in the app that's darker than `surface-container-lowest` (`#0e0e10`), intentionally, because DESIGN.md calls out true-black specifically for live logs (it's the terminal-emulation cue, distinct from the rest of the near-black-but-not-black surface stack).
- No ANSI color styling specified here — out of scope for this brief (M10.md's engineer scope item 6 keeps "ANSI log styling" as one of the few non-utility CSS rules; Playground's `<pre>` just needs the same container treatment as Pipeline's live-log pane, not a new spec).
- Footer (success/error + duration/cost) is plain mono text, not a chip — it's a one-line trailing status, not a persistent state indicator like a workflow's status chip.

## 4. Interview question-chip card (`QuestionCard`, in `chatShared.tsx`)

DESIGN.md's Interview Flow component: "Questions are presented as a single card with a horizontal scroll or wrap of clickable pill-chips for 'Recommended' options."

```tsx
<div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-4 flex flex-col gap-3 max-w-3xl">
  <p className="text-on-surface text-sm">{q.question}</p>
  <div className="flex flex-wrap gap-2">
    {q.options.map((opt) => (
      <button key={opt} disabled={disabled} onClick={() => onAnswer(opt)}
        className={opt === q.recommended
          ? 'px-3 py-1.5 rounded-full bg-primary-container text-on-primary-container text-sm font-medium hover:opacity-90 transition-opacity disabled:opacity-40'
          : 'px-3 py-1.5 rounded-full bg-surface-variant text-on-surface-variant text-sm hover:bg-surface-container-high transition-colors disabled:opacity-40'}>
        {opt}
      </button>
    ))}
  </div>
</div>
```

- Card container reuses the AI-message bubble treatment from `drafting_interface` (`bg-surface-container-lowest border border-border-subtle rounded-xl p-4`) so the question card reads as "the AI's turn," not a separate widget bolted onto the chat.
- `flex-wrap` chosen over horizontal scroll (DESIGN.md offers both) — option lists here are short (2-5), and a wrapped row keeps every option visible without a scroll affordance the user has to discover. Horizontal scroll is worth revisiting only if a role/model ever produces long option lists.
- Recommended chip is the one spot pill-shaped **and** filled with the primary color outside of a primary button — deliberate, it's the visual "start here" nudge DESIGN.md calls for ("recommended option highlighted"). Non-recommended chips stay neutral (`surface-variant`) so the recommendation doesn't get lost among equally-loud options.
- No separate "selected" state: clicking a chip immediately sends the answer (existing behavior, `onAnswer` fires on click) — no visual affordance needed for a state that doesn't persist.

## 5. Propose Now + ProposalPreview (`chatShared.tsx`, `DraftChatPanel.tsx`, `DraftView.tsx`)

**Propose Now** is a ghost action next to the composer, always visible (not conditional on a question being open) since the user can force a proposal at any point in the interview:

```tsx
<button className={ghost} disabled={sending || running} onClick={...}>
  Propose Now
</button>
```
Same ghost formula as "New chat"/"New draft" — it's a utility action, not the primary "next step," so it must not compete visually with Send/Apply.

**ProposalPreview** — the card that appears once a proposal lands, styled as the read-only "Outcome Preview" DESIGN.md calls for (Brief) plus a stack of proposed task-cards (task-card style, `proposed` = same visual, no extra badge needed since context already makes clear these aren't saved yet):

```tsx
<div className="bg-surface-container-lowest border border-border-subtle rounded-xl p-4 flex flex-col gap-3 max-w-3xl">
  <span className="text-on-surface-variant text-sm">
    Proposed workflow — {n} task(s){roles.length ? `, ${m} new role(s)` : ''}
  </span>
  {proposal.brief && (
    <details className="bg-surface rounded-lg border-l-2 border-primary-container border border-border-subtle overflow-hidden">
      <summary className="px-4 py-3 text-sm font-medium text-on-surface-variant hover:text-on-surface cursor-pointer">Brief</summary>
      <p className="px-4 pb-3 text-sm text-on-surface-variant whitespace-pre-wrap">{proposal.brief}</p>
    </details>
  )}
  {proposal.tasks.map((t, i) => (
    <div key={i} className="bg-surface border border-border-subtle rounded-lg p-3 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-on-surface text-sm">{t.title}</span>
        {t.role && <span className="px-2 py-0.5 rounded-full bg-surface-variant text-on-surface-variant font-mono-label text-mono-label uppercase">{t.role}</span>}
      </div>
      <span className="text-on-surface-variant text-sm">{t.prompt}</span>
    </div>
  ))}
  {proposal.roles.map((r) => (
    <div key={r.slug} className="bg-surface border border-border-subtle rounded-lg p-3 flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="font-semibold text-on-surface text-sm">{r.name}</span>
        <span className="px-2 py-0.5 rounded-full bg-surface-variant text-on-surface-variant font-mono-label text-mono-label uppercase">{r.slug}</span>
        {existing.has(r.slug) && (
          <span className="px-2 py-0.5 rounded-full bg-status-skipped/10 text-status-skipped border border-status-skipped/20 text-xs">already exists — will reuse</span>
        )}
      </div>
      <span className="text-on-surface-variant text-sm">{r.preamble}</span>
    </div>
  ))}
  <div className="flex items-center gap-3 pt-1">
    <button className={primary} disabled={disabled}>{applyLabel}</button>
    <button className={ghost}>Dismiss</button>
  </div>
</div>
```

- `border-l-2 border-primary-container` on the Brief `<details>` is DESIGN.md's literal instruction ("a left-accent border to signify their read-only, source-of-truth status") — the one deliberate deviation from plain `border` used elsewhere on this card.
- "already exists — will reuse" uses the `status-skipped` gray formula (neutral, informational — not a warning, so not `status-cancelled`/amber).
- Apply is primary (it's the card's one committing action); Dismiss is ghost, matching Cancel everywhere else.

## 6. Unified chat bubbles (shared by `DraftView` full-page chat and `DraftChatPanel`)

Per DESIGN.md: "Both use the same chat bubble style. User bubbles are right-aligned and ghost-bordered; AI bubbles are left-aligned with a subtle surface fill." Directly from `drafting_interface`:

```tsx
{/* user */}
<div className="flex justify-end w-full">
  <div className="max-w-[80%] bg-surface-elevated border border-border-subtle rounded-xl p-4 text-on-surface text-sm">
    {m.text}
  </div>
</div>
{/* assistant */}
<div className="flex justify-start w-full">
  <div className="max-w-[80%] bg-surface-container-lowest border border-border-subtle rounded-xl p-4 text-on-surface-variant text-sm whitespace-pre-wrap">
    {m.text}
  </div>
</div>
```

- Streaming assistant bubble is the same class with a trailing `▌` cursor appended to the text — no separate "typing" treatment.
- Error banner: `bg-error-container/20 border border-error text-error rounded-xl p-3 flex items-center justify-between text-sm` with an inline ghost "Retry" button — reuses the error token pair already defined (`error` / `error-container`), no new failure color.
- Empty-state copy (`EMPTY` string in both `DraftView`/`DraftChatPanel`) renders as `text-on-surface-variant text-sm` centered-left, no card — an instruction, not a message.

## 7. DraftChatPanel (the 340px editor panel)

This is the same chat as §6/§4/§5 — same message list, same `QuestionCard`, same `ProposalPreview` — wrapped to sit as a fixed-width sibling of the workflow editor form, per DESIGN.md's reflow rule ("main content area compresses to accommodate a fixed 340px side panel"). `WorkflowsView.tsx` already renders `DraftChatPanel` as a flex sibling of the editor card inside a row container — that structure doesn't change, only the classes:

```tsx
<div className="flex gap-gutter items-start">
  <div className="flex-1 min-w-0">{/* editor card, §1-style */}</div>
  {open && (
    <div className="w-editor-panel-width shrink-0 bg-surface-elevated border border-border-subtle rounded-xl p-4 flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between">
        <span className="font-headline-md text-sm font-semibold">Draft with AI</span>
        <div className="flex gap-2">
          <button className={ghostSmall} disabled={running}>New chat</button>
          <button className={ghostSmall} disabled={sending || running}>Propose Now</button>
        </div>
      </div>
      {running && <p className="text-on-surface-variant text-sm">Chat is disabled while this workflow is running.</p>}
      <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-2">
        {/* §6 bubbles, §4 QuestionCard, error banner */}
      </div>
      {proposal && <div className="max-w-none">{/* §5 ProposalPreview, no max-w cap in the narrow panel */}</div>}
      <textarea rows={2} className="w-full bg-surface-container text-on-surface p-2.5 rounded-lg border border-border-subtle focus:outline-none focus:border-primary text-sm resize-none" placeholder="Describe the workflow…" />
      <button className={primary + ' self-end'} disabled={sending || running || !input.trim()}>Send</button>
    </div>
  )}
</div>
```

- `w-editor-panel-width` maps to the `--spacing-editor-panel-width: 340px` token the engineer's Tailwind `@theme` block declares (M10.md engineer item 1) — same token DESIGN.md names, no new value.
- Bubbles/QuestionCard/ProposalPreview drop their `max-w-3xl`/`max-w-[80%]` caps inside the 340px panel (there's no room for them and no reason to cap width in an already-narrow column) — this is the only visual difference from the full-page Draft chat, everything else (colors, radii, chip logic) is identical, which is what makes the two chats "read as one component" per DESIGN.md.
- Panel header buttons use a smaller ghost variant (`px-3 py-1 text-xs` instead of `px-4 py-2 text-sm`) — the full-size ghost button is sized for a page-level toolbar; at 340px wide with two buttons plus a title, full size crowds the header.
- No close/✕ on the panel itself — it's toggled by the "Draft with AI" button in the editor's own action row (existing behavior, `setChatOpen`), unchanged.

## Deliberate omissions

New chat-history sidebar or multi-thread UI (out of scope — single active chat per workflow, unchanged from M9); animated typing indicator beyond the `▌` cursor; a distinct "selected chip" visual state for question chips (click fires immediately, nothing persists to show as selected); horizontal-scroll variant of the question card (wrap covers the option-count range these interviews produce; revisit only if that changes); ANSI color rendering in Playground's log pane (covered by M10.md engineer item 6's residual-CSS carve-out, not new spec here); a dedicated "danger ghost" hover state distinct from the `runs_reports` delete-icon-button formula it's generalized from.

## Open questions for the TD

- None. Every surface above reuses button/chip/card/field formulas already present in at least one shipped mock or DESIGN.md's explicit component rules; no naming or workflow decisions were needed that the brief hadn't already settled (M9-ui.md's Nightly Armed chip, M9's chat/proposal shapes).
