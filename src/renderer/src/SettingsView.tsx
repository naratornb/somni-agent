import { useEffect, useState } from 'react'
import type {
  Effort,
  Methodology,
  ProviderHealth,
  ProvidersSettings,
  ReportStyle,
  Role,
  RunnerChoice,
  RunnerName,
  Settings,
  SkillsStatus
} from '../../preload/index'
import { NAMES as PROVIDER_NAMES } from './ProvidersSetup'
import { RolesView } from './RolesView'
import {
  BTN_GHOST_SM,
  BTN_PRIMARY,
  CHECKBOX,
  CHIP,
  ICON_BTN,
  INPUT,
  LABEL,
  STATUS_CHIP,
  STATUS_CHIP_BASE
} from './ui'

// Mirrors main/store.ts's RUNNER_NAMES/DEFAULT_PROVIDER_ORDER — hardcoded
// here because that module also imports fs/path, which can't bundle into
// the renderer (ProvidersSetup.tsx hardcodes its own label map for the
// same reason).
const RUNNER_NAMES: RunnerName[] = ['claude', 'antigravity', 'gemini', 'codex']
const DEFAULT_PROVIDER_ORDER: RunnerName[] = ['claude', 'codex', 'gemini', 'antigravity']

// The full display order: saved order first, then any provider missing from
// it (a new adapter, or nothing saved yet) appended in the default order.
function providerOrder(p: ProvidersSettings | undefined): RunnerName[] {
  const order = p?.order ?? []
  return [...order, ...DEFAULT_PROVIDER_ORDER.filter((n) => !order.includes(n))]
}

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

/** Repo-scoped settings: .somni/config.json + the injected skills (M16). */
function RepoSection({ repo }: { repo: string }): React.JSX.Element {
  const [check, setCheck] = useState('')
  const [savedAt, setSavedAt] = useState(false)
  const [skills, setSkills] = useState<SkillsStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [methodology, setMethodology] = useState('')

  useEffect(() => {
    void window.somni.getRepoConfig(repo).then((c) => {
      setCheck(c.checkCommand ?? '')
      setMethodology(c.methodology ?? '')
    })
    void window.somni.skillsStatus(repo).then(setSkills)
  }, [repo])

  const inject = async (): Promise<void> => {
    setBusy(true)
    setSkills(await window.somni.injectSkills(repo))
    setBusy(false)
  }

  // Skills are methodology-keyed, so a change re-asks what this repo needs.
  const setRepoMethodology = async (value: string): Promise<void> => {
    setMethodology(value)
    await window.somni.setRepoConfig(repo, { methodology: (value || undefined) as Methodology })
    setSkills(await window.somni.skillsStatus(repo))
  }

  return (
    <div className="mt-6">
      <h2 className={`mb-2 ${LABEL}`}>This repo</h2>
      <div className="flex flex-col divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface-elevated p-6">
        <FieldRow label="Methodology">
          <select
            className={`${INPUT} flex-1`}
            value={methodology}
            onChange={(e) => void setRepoMethodology(e.target.value)}
          >
            <option value="">Global default</option>
            <option value="pocock">Matt Pocock — grill, tracer bullets, TDD at seams</option>
            <option value="superpowers">
              Superpowers — brainstorm, plan, subagent-driven execution
            </option>
          </select>
        </FieldRow>
        <FieldRow label="Check command">
          <input
            className={`${INPUT} flex-1 font-mono-code`}
            placeholder="npm test (optional — the review loop's deterministic signal)"
            value={check}
            onChange={(e) => {
              setCheck(e.target.value)
              setSavedAt(false)
            }}
            onBlur={() => {
              void window.somni
                .setRepoConfig(repo, { checkCommand: check })
                .then(() => setSavedAt(true))
            }}
          />
          {savedAt && <span className="text-sm text-on-surface-variant">Saved</span>}
        </FieldRow>
        <FieldRow label="Engineering skills">
          <span className="flex-1 text-sm text-on-surface-variant">
            {skills == null
              ? 'Checking…'
              : skills.repoVersion == null
                ? 'Not set up in this repo'
                : skills.repoVersion < skills.bundledVersion
                  ? `v${skills.repoVersion} — v${skills.bundledVersion} available`
                  : `v${skills.repoVersion} — up to date`}
          </span>
          {skills != null && skills.repoVersion !== skills.bundledVersion && (
            <button className={BTN_PRIMARY} disabled={busy} onClick={() => void inject()}>
              {skills.repoVersion == null ? 'Set up' : 'Upgrade'}
            </button>
          )}
        </FieldRow>
      </div>
    </div>
  )
}

/**
 * The settings fields + Providers panel — pure props-in/patch-out, no hooks.
 * SettingsView (below) owns all the state and effects; this is what makes
 * the form body directly callable from tests, the same way ProvidersSetup is.
 */
export function SettingsForm({
  s,
  patch,
  models,
  health,
  providerModels,
  onRecheck
}: {
  s: Settings
  patch: (p: Partial<Settings>) => void
  models: string[]
  health: ProviderHealth[]
  providerModels: Partial<Record<RunnerName, string[]>>
  onRecheck: () => void
}): React.JSX.Element {
  const order = providerOrder(s.providers)

  const patchProviders = (p: Partial<ProvidersSettings>): void => {
    patch({ providers: { ...s.providers, ...p } })
  }

  const toggleDisabled = (name: RunnerName, enabled: boolean): void => {
    const disabled = s.providers?.disabled ?? []
    patchProviders({ disabled: enabled ? disabled.filter((n) => n !== name) : [...disabled, name] })
  }

  // Reorder always writes the full display order (not just the saved
  // fragment) — the first reorder is what materializes it (brief §Task 8).
  const reorder = (name: RunnerName, dir: -1 | 1): void => {
    const i = order.indexOf(name)
    const j = i + dir
    if (j < 0 || j >= order.length) return
    const next = [...order]
    ;[next[i], next[j]] = [next[j], next[i]]
    patchProviders({ order: next })
  }

  const patchDefault = (name: RunnerName, d: { model?: string; effort?: Effort }): void => {
    patchProviders({
      defaults: { ...s.providers?.defaults, [name]: { ...s.providers?.defaults?.[name], ...d } }
    })
  }

  const patchCap = (name: RunnerName, cap: number | undefined): void => {
    const caps = { ...s.providers?.caps }
    if (cap === undefined) delete caps[name]
    else caps[name] = cap
    patchProviders({ caps })
  }

  return (
    <>
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
        <FieldRow label="Methodology">
          <select
            className={`${INPUT} flex-1`}
            value={s.methodology ?? 'pocock'}
            onChange={(e) => patch({ methodology: e.target.value as Methodology })}
          >
            <option value="pocock">Matt Pocock — grill, tracer bullets, TDD at seams</option>
            <option value="superpowers">
              Superpowers — brainstorm, plan, subagent-driven execution
            </option>
          </select>
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
        <FieldRow label="Voice quick-start">
          <input
            type="checkbox"
            className={CHECKBOX}
            checked={!!s.voiceAutoGroom}
            onChange={(e) => patch({ voiceAutoGroom: e.target.checked })}
          />
          <span className="text-sm text-on-surface-variant">
            Speaking on Home starts the groom immediately (off: fills the box for review)
          </span>
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
            aria-label="Runner"
            value={s.runner}
            onChange={(e) => patch({ runner: e.target.value as RunnerChoice })}
          >
            <option value="auto">Auto (failover)</option>
            <option value="claude">Claude Code (claude)</option>
            <option value="antigravity">Antigravity (agy)</option>
            <option value="gemini">Gemini CLI (gemini)</option>
            <option value="codex">Codex (codex)</option>
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
        <FieldRow label="gemini binary">
          <input
            className={`${INPUT} flex-1 font-mono-code`}
            placeholder="gemini (found on PATH)"
            aria-label="gemini binary"
            value={s.geminiBinary ?? ''}
            onChange={(e) => patch({ geminiBinary: e.target.value })}
          />
        </FieldRow>
        <FieldRow label="codex binary">
          <input
            className={`${INPUT} flex-1 font-mono-code`}
            placeholder="codex (found on PATH)"
            aria-label="codex binary"
            value={s.codexBinary ?? ''}
            onChange={(e) => patch({ codexBinary: e.target.value })}
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

      {/* Providers panel (M26 §8): order/enable/defaults/caps for the
          failover chain. ↑/↓, not drag-and-drop — ponytail: add drag if
          someone misses it. Health is the mount-time probe plus Re-check;
          no polling. */}
      <div className="mt-6">
        <div className="mb-2 flex items-center justify-between">
          <h2 className={LABEL}>Providers</h2>
          <button className={BTN_GHOST_SM} onClick={onRecheck}>
            Re-check
          </button>
        </div>
        <div className="flex flex-col divide-y divide-border-subtle rounded-xl border border-border-subtle bg-surface-elevated p-6">
          {order.map((name, i) => {
            const h = health.find((x) => x.name === name)
            const disabled = (s.providers?.disabled ?? []).includes(name)
            const d = s.providers?.defaults?.[name] ?? {}
            const cap = s.providers?.caps?.[name]
            return (
              <div key={name} className="flex flex-col gap-2 py-3">
                <div className="flex items-center gap-3">
                  <span className={h?.ok ? 'text-status-completed' : 'text-on-surface-variant'}>
                    ●
                  </span>
                  <span className="w-32 font-semibold">{PROVIDER_NAMES[name]}</span>
                  <span className="text-sm text-on-surface-variant">
                    {h?.ok ? (h.version ?? 'ok') : 'not found'}
                  </span>
                  <label className="ml-auto flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className={CHECKBOX}
                      aria-label={`Enable ${name}`}
                      checked={!disabled}
                      onChange={(e) => toggleDisabled(name, e.target.checked)}
                    />
                    Enabled
                  </label>
                  <button
                    className={ICON_BTN}
                    aria-label={`Move ${name} up`}
                    disabled={i === 0}
                    onClick={() => reorder(name, -1)}
                  >
                    ↑
                  </button>
                  <button
                    className={ICON_BTN}
                    aria-label={`Move ${name} down`}
                    disabled={i === order.length - 1}
                    onClick={() => reorder(name, 1)}
                  >
                    ↓
                  </button>
                </div>
                <div className="flex items-center gap-3 pl-7">
                  <input
                    className={`${INPUT} flex-1 font-mono-code`}
                    list={`providers-model-${name}`}
                    placeholder="CLI default"
                    aria-label={`${name} default model`}
                    value={d.model ?? ''}
                    onChange={(e) => patchDefault(name, { model: e.target.value })}
                  />
                  <datalist id={`providers-model-${name}`}>
                    {(providerModels[name] ?? []).map((m) => (
                      <option key={m} value={m} />
                    ))}
                  </datalist>
                  <select
                    className={INPUT}
                    aria-label={`${name} default effort`}
                    value={d.effort ?? ''}
                    onChange={(e) =>
                      patchDefault(name, { effort: (e.target.value || undefined) as Effort })
                    }
                  >
                    <option value="">CLI default</option>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                  <input
                    className={`${INPUT} w-20`}
                    type="number"
                    min="1"
                    placeholder="cap"
                    aria-label={`${name} cap`}
                    value={cap ?? ''}
                    onChange={(e) =>
                      patchCap(name, e.target.value ? Number(e.target.value) : undefined)
                    }
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </>
  )
}

export function SettingsView({
  repo,
  roles,
  refresh
}: {
  repo: string | null
  roles: Role[]
  refresh: () => void
}): React.JSX.Element {
  const [s, setS] = useState<Settings | null>(null)
  const [saved, setSaved] = useState(false)
  const [models, setModels] = useState<string[]>([])
  const [health, setHealth] = useState<ProviderHealth[]>([])
  const [providerModels, setProviderModels] = useState<Partial<Record<RunnerName, string[]>>>({})

  useEffect(() => {
    void window.somni.getSettings().then(setS)
  }, [])

  // Keyed on the unsaved form value: switching runner re-suggests immediately.
  useEffect(() => {
    void window.somni.listModels(s?.runner).then(setModels)
  }, [s?.runner])

  const checkProviders = (): void => {
    void window.somni.providersStatus().then(setHealth)
  }

  // Probed once on mount, same as checkProviders — the panel's Re-check
  // button is the only other trigger (no polling).
  useEffect(() => {
    checkProviders()
    void Promise.all(RUNNER_NAMES.map((n) => window.somni.listModels(n))).then((lists) => {
      const byName = Object.fromEntries(RUNNER_NAMES.map((n, i) => [n, lists[i]])) as Record<
        RunnerName,
        string[]
      >
      setProviderModels(byName)
    })
  }, [])

  // Roles live here now (M23): configuration, not a destination. Independent
  // of the settings fetch, so it renders in the loading state too.
  const rolesSection = repo && (
    <div className="mt-8 border-t border-border-subtle pt-6">
      <h2 className={`mb-4 ${LABEL}`}>Roles</h2>
      <RolesView repo={repo} roles={roles} refresh={refresh} />
    </div>
  )

  if (!s)
    return (
      <div>
        <p className="text-on-surface-variant">Loading…</p>
        {rolesSection}
      </div>
    )

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
      <SettingsForm
        s={s}
        patch={patch}
        models={models}
        health={health}
        providerModels={providerModels}
        onRecheck={checkProviders}
      />
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
      {repo && <RepoSection repo={repo} />}
      {rolesSection}
    </div>
  )
}
