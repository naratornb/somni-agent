import { useEffect, useState } from 'react'
import type { ChatProposal, Role, Task, Workflow } from '../../preload/index'
import { DraftChatPanel } from './DraftChatPanel'

type Props = {
  repo: string
  workflows: Workflow[]
  backlog: string[] // parked slugs, in the user's order
  roles: Role[]
  refresh: () => void
  onRun: (slug: string) => void
  // Slugs with a run still in flight — only these have their chat refused.
  runningSlugs: string[]
  openSlug?: string | null
  onOpened?: () => void
}

const emptyTask = (role: string): Task => ({ title: '', prompt: '', role, selected: true })

export function WorkflowsView({
  repo,
  workflows,
  backlog,
  roles,
  refresh,
  onRun,
  runningSlugs,
  openSlug,
  onOpened
}: Props): React.JSX.Element {
  const [editing, setEditing] = useState<Workflow | null>(null)
  const [chatOpen, setChatOpen] = useState(false)

  // Handoff from the Draft view: open the freshly applied workflow, once.
  useEffect(() => {
    if (!openSlug) return
    const wf = workflows.find((w) => w.slug === openSlug)
    if (wf) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot handoff from the Draft view; onOpened() clears the trigger immediately
      setEditing(wf)
      onOpened?.()
    }
  }, [openSlug, workflows, onOpened])

  // Apply is the one user-triggered write from the chat (architecture.md §7).
  const applyProposal = async (proposal: ChatProposal): Promise<void> => {
    if (!editing) return
    const stored = workflows.find((w) => w.slug === editing.slug)
    const dirty = stored && JSON.stringify(stored) !== JSON.stringify(editing)
    if (dirty && !confirm('Discard your unsaved edits and apply the proposed workflow?')) return
    const res = await window.somni.applyProposal(repo, editing.slug, proposal)
    if (!res.ok) return alert(res.error)
    setEditing(res.workflow)
    refresh()
  }

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

  const chatRunning = !!editing?.slug && runningSlugs.includes(editing.slug)

  // Parked work lives only in the Backlog section — no tick, never runs by itself.
  const backlogWorkflows = backlog.flatMap((slug) => workflows.filter((w) => w.slug === slug))
  const queueWorkflows = workflows.filter((w) => !backlog.includes(w.slug))

  const park = (slug: string): void => {
    void window.somni.park(repo, slug).then(() => refresh())
  }
  const promote = (slug: string): void => {
    void window.somni.promote(repo, slug).then(() => refresh())
  }
  const reorder = (i: number, delta: -1 | 1): void => {
    const next = [...backlog]
    const from = next.indexOf(backlogWorkflows[i].slug)
    const to = from + delta
    if (to < 0 || to >= next.length) return
    ;[next[from], next[to]] = [next[to], next[from]]
    void window.somni.setBacklog(repo, next).then(() => refresh())
  }

  if (editing) {
    return (
      <div className="split">
        <div className="stack">
          <input
            placeholder="Workflow name (e.g. Add image upload feature)"
            value={editing.name}
            onChange={(e) => setEditing({ ...editing, name: e.target.value })}
          />
          {/* Read-only, collapsed by default — no in-app Brief editing (Decision 8). */}
          {editing.brief && (
            <details className="brief-box">
              <summary>Brief</summary>
              <p className="dim brief-text">{editing.brief}</p>
            </details>
          )}
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
            <button
              className="ghost"
              disabled={!editing.slug || chatRunning}
              title={
                !editing.slug
                  ? 'Save the workflow first'
                  : chatRunning
                    ? 'Workflow is running'
                    : undefined
              }
              onClick={() => setChatOpen((o) => !o)}
            >
              Draft with AI
            </button>
          </div>
        </div>
        {editing.slug && (
          <DraftChatPanel
            repo={repo}
            slug={editing.slug}
            roles={roles}
            open={chatOpen}
            running={chatRunning}
            onApply={(p) => void applyProposal(p)}
          />
        )}
      </div>
    )
  }

  return (
    <div className="stack">
      <button onClick={() => setEditing({ slug: '', name: '', selected: false, tasks: [] })}>
        New workflow
      </button>
      <ul className="list">
        {queueWorkflows.map((w) => (
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
              disabled={runningSlugs.includes(w.slug) || w.tasks.length === 0}
              onClick={(e) => {
                e.stopPropagation()
                onRun(w.slug)
              }}
            >
              ▶ Run
            </button>
            <button
              className="ghost"
              disabled={runningSlugs.includes(w.slug)}
              title="Park in the Backlog"
              onClick={(e) => {
                e.stopPropagation()
                park(w.slug)
              }}
            >
              To backlog
            </button>
          </li>
        ))}
      </ul>
      {backlogWorkflows.length > 0 && (
        <>
          <div className="row">
            <b>Backlog</b>
            <span className="dim">— parked, promote to queue when ready</span>
          </div>
          <ul className="list">
            {backlogWorkflows.map((w, i) => (
              <li key={w.slug} className="plain" onClick={() => setEditing(w)}>
                <span className="dim">{i + 1}.</span> <b>{w.name}</b>
                <span className="dim">
                  {' '}
                  · {w.tasks.length} task{w.tasks.length === 1 ? '' : 's'}
                </span>
                <div className="row" onClick={(e) => e.stopPropagation()}>
                  <button
                    className="ghost"
                    disabled={i === 0}
                    onClick={() => reorder(i, -1)}
                    title="Move up"
                  >
                    ↑
                  </button>
                  <button
                    className="ghost"
                    disabled={i === backlogWorkflows.length - 1}
                    onClick={() => reorder(i, 1)}
                    title="Move down"
                  >
                    ↓
                  </button>
                  <button className="run-btn" onClick={() => promote(w.slug)}>
                    Promote
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
