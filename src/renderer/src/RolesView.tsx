import { useState } from 'react'
import type { Effort, Role, RunnerName } from '../../preload/index'
import { BTN_DANGER, BTN_GHOST, BTN_PRIMARY, CHIP, INPUT, INPUT_TITLE, LABEL, TEXTAREA } from './ui'

type Props = { repo: string; roles: Role[]; refresh: () => void }

export function RolesView({ repo, roles, refresh }: Props): React.JSX.Element {
  const [editing, setEditing] = useState<Role | null>(null)

  const save = async (): Promise<void> => {
    if (!editing) return
    await window.somni.saveRole(repo, editing)
    setEditing(null)
    refresh()
  }

  const remove = async (slug: string): Promise<void> => {
    await window.somni.deleteRole(repo, slug)
    setEditing(null)
    refresh()
  }

  if (editing) {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 rounded-xl border border-border-subtle bg-surface-elevated p-6">
        <input
          className={INPUT_TITLE}
          placeholder="Role name (e.g. Senior Developer)"
          value={editing.name}
          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
        />
        <textarea
          className={TEXTAREA}
          placeholder="Persona preamble prepended to every task prompt…"
          rows={12}
          value={editing.preamble}
          onChange={(e) => setEditing({ ...editing, preamble: e.target.value })}
        />
        <div className="flex items-center gap-3">
          <span className={LABEL}>Overrides</span>
          <select
            className={INPUT}
            value={editing.runner ?? ''}
            onChange={(e) =>
              setEditing({ ...editing, runner: (e.target.value || undefined) as RunnerName })
            }
          >
            <option value="">Runner (inherit)</option>
            <option value="claude">claude</option>
            <option value="antigravity">antigravity</option>
          </select>
          <input
            className={`${INPUT} flex-1 font-mono-code`}
            placeholder="Model (inherit)"
            value={editing.model ?? ''}
            onChange={(e) => setEditing({ ...editing, model: e.target.value })}
          />
          <select
            className={INPUT}
            value={editing.effort ?? ''}
            onChange={(e) =>
              setEditing({ ...editing, effort: (e.target.value || undefined) as Effort })
            }
          >
            <option value="">Effort (inherit)</option>
            <option value="low">low</option>
            <option value="medium">medium</option>
            <option value="high">high</option>
          </select>
        </div>
        <div className="flex items-center gap-3 border-t border-border-subtle pt-2">
          <button className={BTN_PRIMARY} onClick={save} disabled={!editing.name.trim()}>
            Save
          </button>
          <button className={BTN_GHOST} onClick={() => setEditing(null)}>
            Cancel
          </button>
          {editing.slug && (
            <button className={BTN_DANGER} onClick={() => remove(editing.slug)}>
              Delete
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-2">
      <button
        className={`self-start ${BTN_GHOST}`}
        onClick={() => setEditing({ slug: '', name: '', preamble: '' })}
      >
        + New role
      </button>
      <ul className="flex flex-col gap-1">
        {roles.map((r) => (
          <li
            key={r.slug}
            className="flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 transition-colors hover:bg-surface-container"
            onClick={() => setEditing(r)}
          >
            <span className="font-semibold text-on-surface">{r.name}</span>
            <span className={CHIP}>{r.slug}</span>
            <span className="truncate text-sm text-on-surface-variant">
              {r.preamble.slice(0, 80) || 'no preamble'}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
