import { useEffect, useState } from 'react'
import type { ChatProposal, Role, Task, Workflow } from '../../preload/index'
import { RefineControl } from './chatShared'
import { DraftChatPanel } from './DraftChatPanel'
import { ICON_BTN, INPUT as BASE_INPUT, INPUT_TITLE } from './ui'

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

// Mock-specific variants (workflows_editor/code.html sizes its utility buttons
// tighter than the §0 page-level ghost); the rest come from ./ui.
const INPUT = `${BASE_INPUT} font-mono-code`
const BTN_GHOST =
  'rounded border border-border-subtle bg-surface-container px-3 py-1.5 text-sm text-on-surface transition-colors hover:bg-surface-bright disabled:opacity-50'

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
      // §7: the form compresses to make room for the fixed 340px chat panel.
      <div className="flex min-h-0 flex-1 gap-gutter">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="relative mx-auto max-w-4xl rounded-xl border border-border-subtle bg-surface-elevated p-6">
            <div className="mb-6">
              <input
                className={INPUT_TITLE}
                placeholder="Workflow name (e.g. Add image upload feature)"
                value={editing.name}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
            </div>
            {/* Read-only, collapsed by default — no in-app Brief editing (Decision 8). */}
            {editing.brief && (
              <details className="mb-6 overflow-hidden rounded-lg border border-border-subtle bg-surface">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface">
                  Brief
                </summary>
                <p className="border-t border-border-subtle p-4 text-sm leading-relaxed whitespace-pre-wrap text-on-surface-variant">
                  {editing.brief}
                </p>
              </details>
            )}
            <div className="space-y-4">
              {editing.tasks.map((t, i) => (
                <div
                  className="rounded-lg border border-border-subtle bg-surface p-card-padding"
                  key={i}
                >
                  <div className="flex items-start gap-4">
                    <span className="mt-2 font-mono-code text-mono-code text-on-surface-variant">
                      {i + 1}.
                    </span>
                    <div className="flex-1 space-y-3">
                      <div className="flex items-center gap-2">
                        <input
                          className={`flex-1 ${INPUT}`}
                          placeholder="Task title (e.g. Design the feature)"
                          value={t.title}
                          onChange={(e) => patchTask(i, { title: e.target.value })}
                        />
                        <select
                          className={INPUT}
                          value={t.role}
                          onChange={(e) => patchTask(i, { role: e.target.value })}
                        >
                          <option value="">(no role)</option>
                          {roles.map((r) => (
                            <option key={r.slug} value={r.slug}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                        <div className="flex gap-1">
                          <button
                            className={ICON_BTN}
                            onClick={() => moveTask(i, -1)}
                            title="Move up"
                          >
                            <span className="material-symbols-outlined text-[18px]">
                              arrow_upward
                            </span>
                          </button>
                          <button
                            className={ICON_BTN}
                            onClick={() => moveTask(i, 1)}
                            title="Move down"
                          >
                            <span className="material-symbols-outlined text-[18px]">
                              arrow_downward
                            </span>
                          </button>
                          <button
                            className="ml-2 rounded p-1.5 text-error transition-colors hover:bg-error-container hover:text-on-error"
                            title="Remove task"
                            onClick={() =>
                              setEditing({
                                ...editing,
                                tasks: editing.tasks.filter((_, j) => j !== i)
                              })
                            }
                          >
                            <span className="material-symbols-outlined text-[18px]">close</span>
                          </button>
                        </div>
                      </div>
                      <textarea
                        className={`h-24 w-full resize-y ${INPUT}`}
                        placeholder="Task prompt…"
                        value={t.prompt}
                        onChange={(e) => patchTask(i, { prompt: e.target.value })}
                      />
                      <RefineControl
                        repo={repo}
                        kind="task"
                        text={t.prompt}
                        onApply={(text) => patchTask(i, { prompt: text })}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4">
              <button
                className={`flex items-center gap-1 ${BTN_GHOST}`}
                onClick={() =>
                  setEditing({
                    ...editing,
                    tasks: [...editing.tasks, emptyTask(roles[0]?.slug ?? '')]
                  })
                }
              >
                <span className="material-symbols-outlined text-[16px]">add</span> Add task
              </button>
            </div>
            <div className="mt-8 flex items-center justify-between border-t border-border-subtle pt-6">
              <div className="flex items-center gap-3">
                <button
                  className="rounded bg-primary-container px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-inverse-primary disabled:opacity-50"
                  onClick={save}
                  disabled={!editing.name.trim()}
                >
                  Save
                </button>
                <button className={BTN_GHOST} onClick={() => setEditing(null)}>
                  Cancel
                </button>
                {editing.slug && (
                  <button
                    className="rounded px-5 py-2 text-sm text-error transition-colors hover:bg-error-container hover:text-on-error"
                    onClick={() => remove(editing.slug)}
                  >
                    Delete
                  </button>
                )}
              </div>
              <button
                className={`flex items-center gap-2 ${BTN_GHOST}`}
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
                <span className="material-symbols-outlined text-[18px]">auto_awesome</span> Draft
                with AI
              </button>
            </div>
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
    <div className="mx-auto w-full max-w-4xl space-y-12">
      <div>
        <button
          className="rounded-full bg-primary-container px-4 py-2 text-sm font-medium text-white shadow-[0_0_12px_rgba(109,90,224,0.3)] transition-colors hover:bg-inverse-primary"
          onClick={() => setEditing({ slug: '', name: '', selected: false, tasks: [] })}
        >
          New workflow
        </button>
      </div>
      <section className="space-y-2">
        {queueWorkflows.map((w) => (
          <div
            key={w.slug}
            className="cursor-pointer rounded-lg border border-border-subtle bg-surface-elevated p-card-padding transition-colors hover:border-outline-variant"
            onClick={() => setEditing(w)}
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  className="h-4 w-4 cursor-pointer rounded border-outline accent-[#6d5ae0]"
                  title="Include in pipeline"
                  checked={w.selected}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() =>
                    void window.somni
                      .saveWorkflow(repo, { ...w, selected: !w.selected })
                      .then(() => refresh())
                  }
                />
                <span className="font-semibold text-on-surface">{w.name}</span>
                <span className="text-sm text-on-surface-variant">
                  · {w.tasks.length} task{w.tasks.length === 1 ? '' : 's'}
                </span>
                <button
                  className={`ml-4 text-xs ${BTN_GHOST}`}
                  disabled={runningSlugs.includes(w.slug)}
                  title="Park in the Backlog"
                  onClick={(e) => {
                    e.stopPropagation()
                    park(w.slug)
                  }}
                >
                  To backlog
                </button>
              </div>
              <button
                className="flex items-center gap-1 rounded-full bg-primary-container px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-inverse-primary disabled:opacity-50"
                disabled={runningSlugs.includes(w.slug) || w.tasks.length === 0}
                onClick={(e) => {
                  e.stopPropagation()
                  onRun(w.slug)
                }}
              >
                <span
                  className="material-symbols-outlined text-[16px]"
                  style={{ fontVariationSettings: "'FILL' 1" }}
                >
                  play_arrow
                </span>
                Run
              </button>
            </div>
          </div>
        ))}
      </section>
      {backlogWorkflows.length > 0 && (
        <section>
          <h2 className="mb-4 flex items-center gap-2 font-semibold text-on-surface">
            Backlog{' '}
            <span className="text-sm font-normal text-on-surface-variant">
              — parked, promote to queue when ready
            </span>
          </h2>
          <div className="space-y-2">
            {backlogWorkflows.map((w, i) => (
              <div
                key={w.slug}
                className="group cursor-pointer rounded-lg border border-border-subtle bg-surface p-card-padding transition-colors hover:border-outline-variant"
                onClick={() => setEditing(w)}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="w-4 font-mono-code text-mono-code text-on-surface-variant">
                      {i + 1}.
                    </span>
                    <span className="font-semibold text-on-surface">{w.name}</span>
                    <span className="text-sm text-on-surface-variant">
                      · {w.tasks.length} task{w.tasks.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  <div
                    className="flex items-center gap-4 opacity-0 transition-opacity group-hover:opacity-100"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex gap-1">
                      <button
                        className={ICON_BTN}
                        disabled={i === 0}
                        onClick={() => reorder(i, -1)}
                        title="Move up"
                      >
                        <span className="material-symbols-outlined text-[16px]">arrow_upward</span>
                      </button>
                      <button
                        className={ICON_BTN}
                        disabled={i === backlogWorkflows.length - 1}
                        onClick={() => reorder(i, 1)}
                        title="Move down"
                      >
                        <span className="material-symbols-outlined text-[16px]">
                          arrow_downward
                        </span>
                      </button>
                    </div>
                    <button
                      className="rounded border border-border-subtle bg-surface-container-high px-3 py-1.5 text-sm font-medium text-primary transition-colors hover:bg-surface-bright"
                      onClick={() => promote(w.slug)}
                    >
                      Promote
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  )
}
