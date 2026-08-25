# M9 — UI design spec (Designer deliverable)

Accepted by the TD 2026-08-26. The Engineer implements renderer item 6 of [M9.md](M9.md) from this spec. Written against the M9 main-process contract (Decisions 1–9). TD rulings on the open questions are folded in below.

## 1. WorkflowsView — Backlog section

Consumes `RepoData.backlog: string[]` resolved to `Workflow` objects by slug (missing slugs just don't render). A second `<ul className="list">` below the main list, same `.stack`, no new CSS:

```tsx
{backlogWorkflows.length > 0 && (<>
  <div className="row"><b>Backlog</b><span className="dim">— parked, promote to queue when ready</span></div>
  <ul className="list">
    {backlogWorkflows.map((w, i) => (
      <li key={w.slug} className="plain" onClick={() => setEditing(w)}>
        <span className="dim">{i + 1}.</span> <b>{w.name}</b>
        <span className="dim"> · {w.tasks.length} task(s)</span>
        <div className="row" onClick={(e) => e.stopPropagation()}>
          <button className="ghost" disabled={i === 0} onClick={() => reorder(i, -1)} title="Move up">↑</button>
          <button className="ghost" disabled={i === backlogWorkflows.length - 1} onClick={() => reorder(i, 1)} title="Move down">↓</button>
          <button className="run-btn" onClick={() => promote(w.slug)}>Promote</button>
        </div>
      </li>
    ))}
  </ul>
</>)}
```

- **No tick checkbox** on backlog rows (parked work never runs by itself); ordinal `i+1.` in that slot — order is the operative property. Up/↓ match the editor's task-reorder idiom (no drag-and-drop). Promote reuses `.run-btn` (the row's one primary action; floats rightmost — order DOM so reorder buttons precede it). Row click opens the editor.
- `promote(slug)` → `window.somni.promote(repo, slug)` then `refresh()` (main removes from backlog + ticks + wakes).
- **Main-list rows gain "To backlog"** — a `ghost` button left of `▶ Run`: untick + append slug to backlog (single combined IPC fine), then `refresh()`. Copy is exactly "To backlog". No confirm (reversible via Promote). Disabled while that slug has a run in flight (`runningSlugs.includes(w.slug)` — per-slug, not global).
- Movement is one-directional (park ↔ promote only); empty Backlog renders nothing.

## 2. PipelineView — Drain queue, Keep Running, status

Props: `pipelineStatus` widens to `drainState: { mode: 'manual'|'nightly'|'keep-running'|null; status: PipelineStatus; resumeAt?: string } | null`; new `keepRunning: boolean` + `onToggleKeepRunning(on)`. `onStart` now sends `[]` (App.tsx).

Toolbar:

```tsx
<button onClick={onStart} disabled={busy && drainState?.mode !== 'keep-running'}>▶ Drain queue</button>
<label className="row" style={{ width: 'auto' }}>
  <input type="checkbox" checked={keepRunning} onChange={(e) => onToggleKeepRunning(e.target.checked)} />
  <span className="field-label" style={{ width: 'auto' }}>Keep Running</span>
</label>
{busy && <button className="danger" onClick={onCancel}>Cancel</button>}
{statusChip}
<progress … /> <span className="dim">{done}/{total} tasks</span>
```

- Keep Running is a native checkbox (SettingsView `row`/`field-label` idiom), **never disabled by `busy`** (toggling mid-drain upgrades the stop rule). Cancel unchanged; after Cancel the checkbox unticks when the `mode: null` push arrives — App owns `keepRunning` state from `getDrainState()`/pushes, no optimistic uncheck.
- Status chip: Running → `chip running` labeled by mode (`Draining` / `Nightly drain` / `Draining (Keep Running)`); Paused → existing `chip skip` "⏸ Paused — resumes HH:MM"; Idle + mode `keep-running` → plain `chip` **"Draining — waiting for work"** (verbatim); Idle + mode null → no chip.
- **Cards: one per workflow, latest run wins** (TD ruling) — `byWorkflow` picks the `RunState` with max `startedAt` for the slug; history belongs to Runs & Reports. Rest of cards/log pane unchanged.
- Empty state copy: `"Queue is empty — tick workflows in the Workflows view, or park them in the Backlog for later."`

## 3. SettingsView — Nightly Window

New row after **Report style** (TD ruling), `label.row`/`field-label` pattern, rides the existing Save button:

```tsx
<label className="row">
  <span className="field-label">Nightly Window</span>
  <input type="time" value={s.nightlyTime ?? ''} onChange={(e) => patch({ nightlyTime: e.target.value || undefined })} />
  <label className="row" style={{ width: 'auto' }}>
    <input type="checkbox" checked={!!s.nightlyArmed} disabled={!s.nightlyTime}
           onChange={(e) => patch({ nightlyArmed: e.target.checked })} />
    <span className={s.nightlyArmed ? 'chip ok' : 'chip'}>{s.nightlyArmed ? 'Armed' : 'Disarmed'}</span>
  </label>
</label>
```

- Armed state shown as a chip (`chip ok` green / plain gray), not just checkbox state — the app auto-disarms after firing and the chip must read at a glance. Arming disabled without a time. Staleness after an overnight auto-disarm is accepted for v1 (SettingsView remounts per visit; no settings push channel).

## Deliberate omissions

Drag-and-drop; "parked" badges; keep-running animations; undo/confirm on park/promote (reversible, non-destructive); drain history per entry point (Runs & Reports covers it).
