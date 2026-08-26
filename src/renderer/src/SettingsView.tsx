import { useEffect, useState } from 'react'
import type { Effort, ReportStyle, RunnerName, Settings } from '../../preload/index'
import { BTN_PRIMARY, CHECKBOX, CHIP, INPUT, LABEL, STATUS_CHIP, STATUS_CHIP_BASE } from './ui'

/** Label + control row — the Settings/Roles form idiom (M10-ui.md §0). */
export function FieldRow({
  label,
  children
}: {
  label: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-3 py-2">
      <span className={`w-48 shrink-0 ${LABEL}`}>{label}</span>
      {children}
    </label>
  )
}

export function SettingsView(): React.JSX.Element {
  const [s, setS] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [models, setModels] = useState<string[]>([])

  useEffect(() => {
    void window.somni.getSettings().then(setS)
  }, [])

  // Keyed on the unsaved form value: switching runner re-suggests immediately.
  useEffect(() => {
    void window.somni.listModels(s?.runner).then(setModels)
  }, [s?.runner])

  if (!s) return <p className="text-on-surface-variant">Loading…</p>

  const patch = (p: Partial<Settings>): void => {
    setS({ ...s, ...p })
    setSaved(false)
  }

  const save = async (): Promise<void> => {
    await window.somni.setSettings(s)
    setSaved(true)
  }

  return (
    <div className="mx-auto w-full max-w-4xl">
      <div className="flex flex-col divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface-elevated p-6">
        <FieldRow label="Max concurrency">
          <input
            className={INPUT}
            type="number"
            min={1}
            value={s.concurrency}
            onChange={(e) => patch({ concurrency: Number(e.target.value) || 1 })}
          />
        </FieldRow>
        <FieldRow label="Task timeout (min)">
          <input
            className={INPUT}
            type="number"
            min={1}
            value={s.timeoutMinutes}
            onChange={(e) => patch({ timeoutMinutes: Number(e.target.value) || 1 })}
          />
        </FieldRow>
        <FieldRow label="Report style">
          <select
            className={`${INPUT} flex-1`}
            value={s.reportStyle}
            onChange={(e) => patch({ reportStyle: e.target.value as ReportStyle })}
          >
            <option value="minimal">Minimal — app-computed stats, zero tokens</option>
            <option value="compact">Compact — stats + one summary call</option>
            <option value="full">Full — stats + a Report task in the worktree</option>
          </select>
        </FieldRow>
        <FieldRow label="Nightly window">
          <input
            className={`${INPUT} font-mono-code`}
            type="time"
            value={s.nightlyTime ?? ''}
            onChange={(e) => patch({ nightlyTime: e.target.value || undefined })}
          />
          {/* Chip, not just the checkbox: the app auto-disarms after firing. */}
          <label className="ml-3 flex items-center gap-2">
            <input
              type="checkbox"
              className={CHECKBOX}
              checked={!!s.nightlyArmed}
              disabled={!s.nightlyTime}
              onChange={(e) => patch({ nightlyArmed: e.target.checked })}
            />
            <span
              className={s.nightlyArmed ? `${STATUS_CHIP_BASE} ${STATUS_CHIP.Completed}` : CHIP}
            >
              {s.nightlyArmed ? 'Armed' : 'Disarmed'}
            </span>
          </label>
        </FieldRow>
        <FieldRow label="Runner">
          <select
            className={`${INPUT} flex-1`}
            value={s.runner}
            onChange={(e) => patch({ runner: e.target.value as RunnerName })}
          >
            <option value="claude">Claude Code (claude)</option>
            <option value="antigravity">Antigravity (agy)</option>
          </select>
        </FieldRow>
        <FieldRow label="claude binary">
          <input
            className={`${INPUT} flex-1 font-mono-code`}
            placeholder="claude (found on PATH)"
            value={s.claudeBinary ?? ''}
            onChange={(e) => patch({ claudeBinary: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="agy binary">
          <input
            className={`${INPUT} flex-1 font-mono-code`}
            placeholder="agy (found on PATH)"
            value={s.antigravityBinary ?? ''}
            onChange={(e) => patch({ antigravityBinary: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="whisper binary">
          <input
            className={`${INPUT} flex-1 font-mono-code`}
            placeholder="whisper-cli (found on PATH)"
            value={s.whisperBinary ?? ''}
            onChange={(e) => patch({ whisperBinary: e.target.value })}
          />
        </FieldRow>
        {/* ponytail: datalist suggestions are live-queried per runner (models:list),
            not a shipped table — the field stays free text either way, nothing ships stale. */}
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
        <FieldRow label="Effort">
          <select
            className={`${INPUT} flex-1`}
            value={s.effort ?? ''}
            onChange={(e) => patch({ effort: (e.target.value || undefined) as Effort })}
          >
            <option value="">CLI default</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </FieldRow>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <button className={BTN_PRIMARY} onClick={save}>
          Save
        </button>
        {saved && <span className="text-sm text-on-surface-variant">Saved</span>}
      </div>
      <p className="mt-3 text-sm text-on-surface-variant">
        A repo can override any of these in{' '}
        <code className="font-mono-code">.somni/config.json</code>; a role can override
        runner/model/effort in its frontmatter.
      </p>
    </div>
  )
}
