import { useState } from 'react'
import type { Role, Task, Workflow } from '../../preload/index'

type Props = {
  repo: string
  workflows: Workflow[]
  roles: Role[]
  refresh: () => void
  onRun: (slug: string) => void
  running: boolean
}

const emptyTask = (role: string): Task => ({ title: '', prompt: '', role, selected: true })

export function WorkflowsView({
  repo,
  workflows,
  roles,
  refresh,
  onRun,
  running
}: Props): React.JSX.Element {
  const [editing, setEditing] = useState<Workflow | null>(null)

  const save = async (): Promise<void> => {
    if (!editing) return
    await window.somni.saveWorkflow(repo, editing)
    setEditing(null)
    refresh()
  }

  const remove = async (slug: string): Promise<void> => {
    await window.somni.deleteWorkflow(repo, slug)
    setEditing(null)
    refresh()
  }

  const patchTask = (i: number, patch: Partial<Task>): void => {
    if (!editing) return
    const tasks = editing.tasks.map((t, j) => (i === j ? { ...t, ...patch } : t))
    setEditing({ ...editing, tasks })
  }

  const moveTask = (i: number, delta: -1 | 1): void => {
    if (!editing) return
    const tasks = [...editing.tasks]
    const j = i + delta
    if (j < 0 || j >= tasks.length) return
    ;[tasks[i], tasks[j]] = [tasks[j], tasks[i]]
    setEditing({ ...editing, tasks })
  }

  if (editing) {
    return (
      <div className="stack">
        <input
          placeholder="Workflow name (e.g. Add image upload feature)"
          value={editing.name}
          onChange={(e) => setEditing({ ...editing, name: e.target.value })}
        />
        {editing.tasks.map((t, i) => (
          <div className="task-card" key={i}>
            <div className="row">
              <span className="dim">{i + 1}.</span>
              <input
                placeholder="Task title (e.g. Design the feature)"
                value={t.title}
                onChange={(e) => patchTask(i, { title: e.target.value })}
              />
              <select value={t.role} onChange={(e) => patchTask(i, { role: e.target.value })}>
                <option value="">(no role)</option>
                {roles.map((r) => (
                  <option key={r.slug} value={r.slug}>
                    {r.name}
                  </option>
                ))}
              </select>
              <button className="ghost" onClick={() => moveTask(i, -1)} title="Move up">
                ↑
              </button>
              <button className="ghost" onClick={() => moveTask(i, 1)} title="Move down">
                ↓
              </button>
              <button
                className="ghost danger"
                onClick={() =>
                  setEditing({ ...editing, tasks: editing.tasks.filter((_, j) => j !== i) })
                }
              >
                ✕
              </button>
            </div>
            <textarea
              placeholder="Task prompt…"
              rows={3}
              value={t.prompt}
              onChange={(e) => patchTask(i, { prompt: e.target.value })}
            />
          </div>
        ))}
        <button
          className="ghost"
          onClick={() =>
            setEditing({ ...editing, tasks: [...editing.tasks, emptyTask(roles[0]?.slug ?? '')] })
          }
        >
          + Add task
        </button>
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
      <button onClick={() => setEditing({ slug: '', name: '', selected: false, tasks: [] })}>
        New workflow
      </button>
      <ul className="list">
        {workflows.map((w) => (
          <li key={w.slug} onClick={() => setEditing(w)}>
            <input
              type="checkbox"
              title="Include in pipeline"
              checked={w.selected}
              onClick={(e) => e.stopPropagation()}
              onChange={() =>
                void window.somni
                  .saveWorkflow(repo, { ...w, selected: !w.selected })
                  .then(() => refresh())
              }
            />{' '}
            <b>{w.name}</b>
            <span className="dim">
              {' '}
              · {w.tasks.length} task{w.tasks.length === 1 ? '' : 's'}
            </span>
            <button
              className="run-btn"
              disabled={running || w.tasks.length === 0}
              onClick={(e) => {
                e.stopPropagation()
                onRun(w.slug)
              }}
            >
              ▶ Run
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}
