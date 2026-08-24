import { useState } from 'react'
import type { Role } from '../../preload/index'

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
      <div className="stack">
        <input
          placeholder="Role name (e.g. Senior Developer)"
          value={editing.name}
          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
        />
        <textarea
          placeholder="Persona preamble prepended to every task prompt…"
          rows={12}
          value={editing.preamble}
          onChange={(e) => setEditing({ ...editing, preamble: e.target.value })}
        />
        <div className="row">
          <button onClick={save} disabled={!editing.name.trim()}>
            Save
          </button>
          <button className="ghost" onClick={() => setEditing(null)}>
            Cancel
          </button>
          {editing.slug && (
            <button className="danger" onClick={() => remove(editing.slug)}>
              Delete
            </button>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="stack">
      <button onClick={() => setEditing({ slug: '', name: '', preamble: '' })}>New role</button>
      <ul className="list">
        {roles.map((r) => (
          <li key={r.slug} onClick={() => setEditing(r)}>
            <b>{r.name}</b>
            <span className="dim"> · {r.preamble.slice(0, 80) || 'no preamble'}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
