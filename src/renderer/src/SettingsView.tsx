import { useEffect, useState } from 'react'
import type { Effort, ReportStyle, RunnerName, Settings } from '../../preload/index'

export function SettingsView(): React.JSX.Element {
  const [s, setS] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    void window.somni.getSettings().then(setS)
  }, [])

  if (!s) return <p className="dim">Loading…</p>

  const patch = (p: Partial<Settings>): void => {
    setS({ ...s, ...p })
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    await window.somni.setSettings(s)
    setSaved(true)
  }

  return (
    <div className="stack">
      <label className="row">
        <span className="field-label">Max concurrency</span>
        <input
          type="number"
          min={1}
          value={s.concurrency}
          onChange={(e) => patch({ concurrency: Number(e.target.value) || 1 })}
        />
      </label>
      <label className="row">
        <span className="field-label">Task timeout (minutes)</span>
        <input
          type="number"
          min={1}
          value={s.timeoutMinutes}
          onChange={(e) => patch({ timeoutMinutes: Number(e.target.value) || 1 })}
        />
      </label>
      <label className="row">
        <span className="field-label">Report style</span>
        <select
          value={s.reportStyle}
          onChange={(e) => patch({ reportStyle: e.target.value as ReportStyle })}
        >
          <option value="minimal">Minimal — app-computed stats, zero tokens</option>
          <option value="compact">Compact — stats + one summary call</option>
          <option value="full">Full — stats + a Report task in the worktree</option>
        </select>
      </label>
      <label className="row">
        <span className="field-label">Nightly Window</span>
        <input
          type="time"
          value={s.nightlyTime ?? ''}
          onChange={(e) => patch({ nightlyTime: e.target.value || undefined })}
        />
        {/* Chip, not just the checkbox: the app auto-disarms after firing. */}
        <label className="row" style={{ width: 'auto' }}>
          <input
            type="checkbox"
            checked={!!s.nightlyArmed}
            disabled={!s.nightlyTime}
            onChange={(e) => patch({ nightlyArmed: e.target.checked })}
          />
          <span className={s.nightlyArmed ? 'chip ok' : 'chip'}>
            {s.nightlyArmed ? 'Armed' : 'Disarmed'}
          </span>
        </label>
      </label>
      <label className="row">
        <span className="field-label">Runner</span>
        <select value={s.runner} onChange={(e) => patch({ runner: e.target.value as RunnerName })}>
          <option value="claude">Claude Code (claude)</option>
          <option value="antigravity">Antigravity (agy)</option>
        </select>
      </label>
      <label className="row">
        <span className="field-label">claude binary</span>
        <input
          placeholder="claude (found on PATH)"
          value={s.claudeBinary ?? ''}
          onChange={(e) => patch({ claudeBinary: e.target.value })}
        />
      </label>
      <label className="row">
        <span className="field-label">agy binary</span>
        <input
          placeholder="agy (found on PATH)"
          value={s.antigravityBinary ?? ''}
          onChange={(e) => patch({ antigravityBinary: e.target.value })}
        />
      </label>
      <label className="row">
        {/* ponytail: one free-text model field for both runners — a per-runner
            dropdown means shipping model lists that go stale. */}
        <span className="field-label">Model</span>
        <input
          placeholder="CLI default"
          value={s.model ?? ''}
          onChange={(e) => patch({ model: e.target.value })}
        />
      </label>
      <label className="row">
        <span className="field-label">Effort</span>
        <select
          value={s.effort ?? ''}
          onChange={(e) => patch({ effort: (e.target.value || undefined) as Effort })}
        >
          <option value="">CLI default</option>
          <option value="low">low</option>
          <option value="medium">medium</option>
          <option value="high">high</option>
        </select>
      </label>
      <div className="row">
        <button onClick={save}>Save</button>
        {saved && <span className="dim">Saved</span>}
      </div>
      <p className="dim">
        A repo can override any of these in <code>.somni/config.json</code>; a role can override
        runner/model/effort in its frontmatter.
      </p>
    </div>
  )
}
