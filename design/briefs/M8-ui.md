# M8 — UI design spec (Designer deliverable)

Accepted by the TD 2026-08-26. The Engineer implements renderer item 6 of [M8.md](M8.md) from this spec. Written against the live main-process contract already on this branch (`applyProposal`, `DRAFT_KEY`, `proposeNow`, `ChatQuestion`), not a guess.

## Engineering gap to close first

`ChatEvent`'s `done` variant carries `proposal: ChatProposal | null` but no `question`. Question cards need the turn's parsed question live:

```ts
// chat.ts sendChat(), on turn completion — mirror the proposal field:
onEvent({ slug, kind: 'done', message, proposal: parseProposal(reply), question: parseQuestion(reply) })
```

Sync the `ChatEvent` type in `src/preload/index.ts`.

## 1. Shared building blocks — new `src/renderer/src/chatShared.tsx`

Both surfaces need the same question card and proposal preview (~40 lines each; extract, don't duplicate).

```tsx
export function QuestionCard({ q, disabled, onAnswer }: {
  q: ChatQuestion; disabled: boolean; onAnswer: (text: string) => void
}) {
  return (
    <div className="question-card">
      <p>{q.question}</p>
      <div className="row wrap">
        {q.options.map((opt) => (
          <button key={opt} className={opt === q.recommended ? 'chip recommended' : 'chip'}
                  disabled={disabled} onClick={() => onAnswer(opt)}>{opt}</button>
        ))}
      </div>
    </div>
  )
}
```

`ProposalPreview({ proposal, roles, applyLabel = 'Apply', disabled, onApply, onDismiss })`:

- Header line: `Proposed workflow — N task(s)[, M new role(s)]` in `.dim`.
- If `proposal.brief`: a collapsed `<details className="brief-box"><summary>Brief</summary><p className="dim brief-text">…</p></details>`.
- Task cards: existing `.task-card.proposed` (title bold, role as `.chip`, prompt in `.dim`).
- Role cards: plain `.task-card` (name bold, slug `.chip`, preamble `.dim`); when the slug is in the repo's existing roles → extra `.chip.skip` badge **"already exists — will reuse"** (existing amber chip, no new color token).
- Footer row: `Apply` (label swappable to `Applying…`, `disabled` while applying) + ghost `Dismiss`.

## 2. CSS additions — `src/renderer/src/assets/main.css`

```css
.question-card { display: flex; flex-direction: column; gap: 8px; padding: 10px 12px;
  align-self: flex-start; max-width: 90%; background: #202024;
  border: 1px solid #2f2f36; border-radius: 8px; }
.chip.recommended { border: 1px solid #6d5ae0; background: #2c2650; color: #cfc9f7; }
.brief-box { border: 1px solid #2f2f36; border-radius: 8px; padding: 8px 10px; background: #202024; }
.brief-box summary { cursor: pointer; font-weight: 600; color: #c9c9cf; }
.brief-box[open] summary { margin-bottom: 6px; }
.brief-text { white-space: pre-wrap; line-height: 1.5; }
.draft-empty { flex: 1; display: flex; align-items: center; justify-content: center;
  text-align: center; color: #8a8a93; max-width: 440px; margin: 0 auto; line-height: 1.6; }
```

`.chat-messages` / `.chat-msg` / `.proposal-pane` / `.error-banner` are already generic — reuse verbatim in the full-page view.

## 3. Draft view — new `src/renderer/src/DraftView.tsx`

Full-page (not the 340px panel). `slug = window.somni.draftKey`. Props: `{ repo, roles, onApplied(workflow) }`.

Layout top→bottom: header row (`Draft` + ghost `New draft`) · `.chat-messages` (empty state `.draft-empty` "Describe what you want built — I'll ask a few questions, then propose a workflow." / message bubbles / streaming bubble with `▌` / error banner with Retry / `QuestionCard` when `question && !proposal`) · `ProposalPreview` when `proposal` · row with ghost **Propose Now** (always rendered; gated only by `sending`, never by pipeline state — `_draft` is never blocked per Decision 9) · 3-row textarea (Enter sends, Shift+Enter newline) + Send.

State/behavior mirrors `DraftChatPanel`: `loaded` ref + `loadChat`, `onChatEvent` filtered by slug, single-slot `question`/`proposal` (mutually exclusive — an incoming one clears the other, only the latest turn's actionable card shows), autoscroll on new content. Clicking a question option calls the same `send()` path so the answer appears as a normal user bubble — no bespoke answer rendering. Propose Now sends `window.somni.proposeNow` through `send()` (transcript-visible).

`apply()`: `setApplying(true)` → `window.somni.applyProposal(repo, slug, proposal)` → `onApplied(wf)`; on failure re-enable + error banner. `newDraft()`: confirm-and-discard (same UX as "New chat") → `newChat(repo, slug)` → reset all local state.

## 4. Sidebar & post-Apply handoff — `src/renderer/src/App.tsx`

- `VIEWS`: insert `'Draft'` right after `'Workflows'`; no other reordering.
- Handoff via a consume-once prop pair instead of lifting editor state:

```tsx
const [openSlug, setOpenSlug] = useState<string | null>(null)
// Draft view:
onApplied={(wf) => { refresh(); setOpenSlug(wf.slug); setView('Workflows') }}
// WorkflowsView gains props openSlug / onOpened:
useEffect(() => {
  if (!openSlug) return
  const wf = workflows.find((w) => w.slug === openSlug)
  if (wf) { setEditing(wf); onOpened?.() }
}, [openSlug, workflows, onOpened])
```

The view switch is a plain ternary, so leaving Draft unmounts `DraftView` and its local state resets for free.

## 5. Workflow editor — `WorkflowsView.tsx`

Read-only collapsible Brief between the name input and the task list, only when present; collapsed by default (Decision 8), plain text, no textarea:

```tsx
{editing.brief && (
  <details className="brief-box"><summary>Brief</summary>
    <p className="dim brief-text">{editing.brief}</p></details>
)}
```

## 6. Editor chat — `DraftChatPanel.tsx`

- New prop `roles: Role[]` (WorkflowsView already holds them).
- Same single-slot `question` state; `done` handler: `proposal` wins, else `question`; `newChat` clears both.
- `QuestionCard` rendered after `.chat-messages` when `question && !proposal`, disabled while `sending || running`.
- Replace the inline proposal pane with shared `ProposalPreview` (`disabled={running}`).
- **Propose Now** ghost button in the header next to `New chat` (disabled while `sending || running`) — CONTEXT.md says Propose Now applies to both conversational drafting surfaces.
- `applyProposal` in WorkflowsView already calls the new IPC with `editing.slug` — no change; tick is preserved store-side.

## Deliberate omissions

- Raw fenced JSON still shows in chat bubbles (M6-consistent; the friendly rendering is the card/pane below, not a bubble transform).
- No re-parsing of historical messages on reload — `question`/`proposal` derive from live events only, same as M6.
- No `.role-card` class, no lifted editor state, no new confirm patterns.
