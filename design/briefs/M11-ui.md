# M11 — UI design spec (Designer deliverable)

Written against M11.md's frozen Decisions and the M9/M10 vocabulary (`src/renderer/src/ui.ts`, `chatShared.tsx`'s `CARD` idiom). No new tokens, no new Material glyphs — `auto_awesome` (already used by "Draft with AI") is the only icon touched, reused as-is.

## 1. RefineControl (`chatShared.tsx`)

One component, two callers (task-prompt textarea in `WorkflowsView`, preamble textarea in `RolesView`). Lives beside `QuestionCard`/`ProposalPreview` and reuses their local `CARD` const directly (same file, no export needed).

```tsx
function RefineControl({
  repo, kind, text, onApply
}: {
  repo: string
  kind: 'task' | 'role'
  text: string
  onApply: (text: string) => void
}): React.JSX.Element {
  const [pending, setPending] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const refine = async (): Promise<void> => {
    setPending(true)
    setError(null)
    setResult(null)
    const res = await window.somni.refineField(repo, kind, text)
    setPending(false)
    if (!res.ok) return setError(res.error ?? 'refine failed')
    setResult(res.text ?? '')
  }

  return (
    <div className="flex flex-col gap-2">
      <button
        className={`flex items-center gap-1 self-start ${BTN_GHOST_SM}`}
        disabled={!text.trim() || pending}
        onClick={() => void refine()}
      >
        <span className="material-symbols-outlined text-[16px]">auto_awesome</span>
        {pending ? 'Refining…' : 'Refine'}
      </button>
      {error && (
        <div className={ERROR_BANNER}>
          {error}
          <button className={BTN_GHOST_SM} onClick={() => void refine()}>
            Retry
          </button>
        </div>
      )}
      {result !== null && (
        <div className={CARD}>
          <span className="text-sm text-on-surface-variant">
            Refined {kind === 'task' ? 'task prompt' : 'role preamble'}
          </span>
          <p className="text-sm whitespace-pre-wrap text-on-surface">{result}</p>
          <div className="flex items-center gap-3 pt-1">
            <button
              className={BTN_PRIMARY}
              onClick={() => {
                onApply(result)
                setResult(null)
              }}
            >
              Apply
            </button>
            <button className={BTN_GHOST} onClick={() => setResult(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
```

- Placement: directly under each textarea it refines — inside the task card in `WorkflowsView` (under `t.prompt`'s `<textarea>`, one per task row) and under `editing.preamble`'s `<textarea>` in `RolesView`. Not in the textarea's own row — it's a follow-up action, not a sibling control.
- `BTN_GHOST_SM` (not full `BTN_GHOST`): this is a secondary, per-field action sitting under a form control, not a page-level toolbar button — same size class already used for `DraftChatPanel`'s header buttons.
- Pending state relabels the button text (`Refining…`) and disables it — no spinner glyph (no new icons); the existing `disabled:opacity-40` from `BTN_GHOST_SM` is the only visual change beyond the label.
- Result card is the exact `ProposalPreview` action-row idiom (`CARD` container, primary Apply + ghost Dismiss) — same Apply-rule semantics as a chat proposal: inert until deliberately accepted, and Apply here writes to the **editing buffer only** (caller's `onApply`), never to disk. `WorkflowsView` passes `onApply={(t) => patchTask(i, { prompt: t })}`; `RolesView` passes `onApply={(t) => setEditing({ ...editing, preamble: t })}`.
- Error reuses `ERROR_BANNER` + inline ghost-sm Retry — identical formula to the chat's own error banner in `DraftChatPanel`, so a refine failure reads the same as a chat failure anywhere else in the app.
- `text.trim()` empty disables the button up front (matches main's "refuse empty text" — the renderer never sends a request main will reject).
- Not gated on `runningSlugs`/`chatRunning`: refine is stateless and read-only against the repo (Decision 1), unlike the editor chat which is refused while the workflow executes. No new prop needed for this in either caller.
- `chatShared.tsx` gains two imports from `./ui`: `BTN_GHOST_SM`, `ERROR_BANNER` (alongside the existing `BTN_GHOST`, `BTN_PRIMARY`).

## 2. Model combo boxes (SettingsView, RolesView)

Native `<input list>` + `<datalist>`, replacing the free-text-only Model field in both views. Free text stays legal (typing anything not in the list is a normal input value — `datalist` never constrains it).

**SettingsView** — fetch keyed on the unsaved `s.runner`:

```tsx
const [models, setModels] = useState<string[]>([])
useEffect(() => {
  void window.somni.listModels(s.runner).then(setModels)
}, [s.runner])
```

```tsx
<FieldRow label="Model">
  <input
    className={`${INPUT} flex-1 font-mono-code`}
    list="settings-model-list"
    placeholder="CLI default"
    value={s.model ?? ''}
    onChange={(e) => patch({ model: e.target.value })}
  />
  <datalist id="settings-model-list">
    {models.map((m) => (
      <option key={m} value={m} />
    ))}
  </datalist>
</FieldRow>
```

Rewrite the standing comment above it (`SettingsView.tsx:122-123`, currently justifying a single free-text field with no per-runner list):

```tsx
// ponytail: datalist suggestions are live-queried per runner (models:list),
// not a shipped table — the field stays free text either way, nothing ships stale.
```

**RolesView** — same pattern, distinct id, keyed on `editing?.runner` (the override select, which can be `undefined` for "inherit" — passed through as-is, main resolves the default):

```tsx
const [models, setModels] = useState<string[]>([])
useEffect(() => {
  void window.somni.listModels(editing?.runner).then(setModels)
}, [editing?.runner])
```

```tsx
<input
  className={`${INPUT} flex-1 font-mono-code`}
  list="role-model-list"
  placeholder="Model (inherit)"
  value={editing.model ?? ''}
  onChange={(e) => setEditing({ ...editing, model: e.target.value })}
/>
<datalist id="role-model-list">
  {models.map((m) => (
    <option key={m} value={m} />
  ))}
</datalist>
```

- No loading/error state on the field itself — an empty `datalist` (query still in flight, or the adapter fell back silently) just means no suggestions pop up yet; the input is never disabled, so free text is always available regardless of `listModels`'s state. Nothing in Decisions 5/6 asks for a visible fallback indicator, and the fallback is main's problem to hide (a pinned list arrives the same shape as a live one).
- `datalist` renders no visible chrome itself (browser-native suggestion popup on focus) — zero new classes beyond the existing `INPUT` on the visible `<input>`.
- Two ids (`settings-model-list` / `role-model-list`) because the two views' option sets differ (Settings keys on the saved-runner-in-progress, Roles on the role's own override) and datalist ids must be unique in the DOM.

## 3. DraftChatPanel — "Refine structure" button

Third button in the header's action group, beside `Propose Now`, same `BTN_GHOST_SM` size and same disabled condition (`sending || running`) — it fires an ordinary `chat:send` the same way Propose Now does:

```tsx
<div className="flex gap-2">
  <button className={BTN_GHOST_SM} onClick={newChat} disabled={running}>
    New chat
  </button>
  <button
    className={BTN_GHOST_SM}
    onClick={() => void send(window.somni.refineStructure)}
    disabled={sending || running}
  >
    Refine structure
  </button>
  <button
    className={BTN_GHOST_SM}
    onClick={() => void send(window.somni.proposeNow)}
    disabled={sending || running}
  >
    Propose Now
  </button>
</div>
```

- Ordered before Propose Now (reading left-to-right as "improve, then finalize") — both are secondary to Send, so both stay ghost-sm; neither outranks the other visually.
- No icon — `New chat`/`Propose Now` are text-only in this header today; adding an icon to only the new button would make it look more important than its siblings, not just different.
- Its reply is an ordinary Proposal and renders through the existing `ProposalPreview` — nothing new below the header.
- `DraftView.tsx` is untouched (Decision 3 — a `_draft` has no structure to refine), so this button exists only in `DraftChatPanel`'s header, not the shared chat body.

## 4. Sidebar mode toggle (`App.tsx`)

Segmented control pinned to the bottom of the nav column, below the view list, separated by a rule — mirrors the visual weight of the "selected nav row" state already established above it rather than borrowing the primary-action color (`primary-container` stays reserved for committing actions — Save/Send/Apply — so the toggle doesn't read as "the important button on the page").

```tsx
<div className="mt-auto flex flex-col gap-2 border-t border-border-subtle pt-4">
  <span className={`px-3 ${LABEL}`}>View</span>
  <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-surface-container p-1">
    {(['po', 'engineer'] as const).map((m) => (
      <button
        key={m}
        className={
          'flex-1 rounded px-3 py-1.5 text-sm transition-colors ' +
          (mode === m
            ? 'bg-surface-container-high font-semibold text-on-surface'
            : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface')
        }
        onClick={() => void setMode(m)}
      >
        {m === 'po' ? 'PO' : 'Engineer'}
      </button>
    ))}
  </div>
</div>
```

(`LABEL` needs importing from `./ui` in `App.tsx` — currently unused there.)

- Active segment: `bg-surface-container-high font-semibold text-on-surface` — the exact classes the nav list above already uses for the selected view row, so "this is the active one" reads identically in both controls without introducing a second visual vocabulary for "selected."
- Inactive segment: `text-on-surface-variant` + the same hover treatment as an unselected nav row (`hover:bg-surface-container-high hover:text-on-surface`) — hover here previews the same affordance a nav-row hover does.
- Container: `border border-border-subtle bg-surface-container p-1` reads as one recessed control (native `<fieldset>`-with-two-`<button>`s, not radio inputs — no native segmented-control element exists, and two plain buttons in a bordered strip is the smallest thing that reads as "segmented toggle" with existing atoms).
- `mt-auto` pushes it to the bottom of the flex column nav (`nav` is already `flex h-screen flex-col`) regardless of how many views are in the current mode's filtered list.
- State: `mode` seeded from `getSettings().viewMode` on mount (default `'engineer'` per `SETTINGS_DEFAULTS`); `setMode` both updates local state and fires `window.somni.setSettings({ viewMode: m })` (the widened `Partial<Settings>` signature); no optimistic-rollback handling needed — it's a fire-and-forget preference write, same class of action as any other Settings field.
- Nav list filter: `VIEWS` (the existing ordered object) is filtered to `['Draft', 'Workflows', 'Pipeline', 'Runs']` when `mode === 'po'`, unfiltered for `'engineer'` — order preserved, no reordering. If the current `view` isn't in the filtered set when switching to `'po'`, `setView('Workflows')` (Decision 9).

## Deliberate omissions

A visible "query pending" or "fallback in use" indicator on the model combo boxes (the field is never disabled and free text always works, so there's nothing the user is blocked on); an icon on "Refine structure" (would outrank its ghost-sm siblings); disabling `RefineControl` while the workflow is running (refine is read-only and stateless, unlike the chat which the running workflow actually locks); a confirm dialog on Refine `Apply` (same non-destructive, editing-buffer-only write as every other Apply in the app — Save is still required to touch disk); radio-input semantics for the PO/Engineer toggle (two buttons is the smaller diff and there's no `<input type="radio">` group behavior — keyboard nav between two adjacent buttons — worth the extra markup here).

## Open questions for the TD

None — every surface reuses button/card/chip/field formulas already fixed by M9-ui.md/M10-ui.md (`CARD`, `ProposalPreview`'s action row, `ERROR_BANNER`, `BTN_GHOST_SM`, the nav-row selected/hover pair, the mono-label atom), and the Decisions section already settled the behavioral questions (placement, Apply semantics, gating, persistence) that would otherwise need a TD call.
