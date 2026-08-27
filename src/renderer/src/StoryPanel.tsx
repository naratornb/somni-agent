// The item editor (M13-ui.md §7): a full-content swap over the Board, the same
// list ↔ editor idiom WorkflowsView used. The subtask block below is that
// view's task-row block, renamed to CONTEXT.md's Subtask vocabulary — the wire
// shape (title/prompt/role/selected) is unchanged.
import { useState } from 'react'
import type { Item, Role, Task } from '../../preload/index'
import { MicButton, RefineControl } from './chatShared'
import {
  appendText,
  BTN_GHOST_SM,
  ICON_BTN,
  INPUT as BASE_INPUT,
  INPUT_TITLE,
  KIND_CHIP,
  LABEL,
  statusChip
} from './ui'

type Props = {
  repo: string
  item: Item // id === '' for a not-yet-saved new story
  items: Item[] // siblings — an Epic lists its child stories
  roles: Role[]
  onClose: () => void
  refresh: () => void
  onOpen: (item: Item) => void // click-through from an Epic's story list
}

const emptySubtask = (role: string): Task => ({ title: '', prompt: '', role, selected: true })

// Mock-specific variants, carried over from WorkflowsView verbatim.
const INPUT = `${BASE_INPUT} font-mono-code`
const BTN_GHOST =
  'rounded border border-border-subtle bg-surface-container px-3 py-1.5 text-sm text-on-surface transition-colors hover:bg-surface-bright disabled:opacity-50'

const KIND_LABEL = { idea: 'Idea', story: 'Story', epic: 'Epic' } as const

export function StoryPanel({
  repo,
  item,
  items,
  roles,
  onClose,
  refresh,
  onOpen
}: Props): React.JSX.Element {
  const [draft, setDraft] = useState<Item>(item)

  const save = async (): Promise<void> => {
    await window.somni.saveItem(repo, draft)
    refresh()
    onClose()
  }

  const remove = async (): Promise<void> => {
    await window.somni.deleteItem(repo, draft.id)
    refresh()
    onClose()
  }

  const patchSubtask = (i: number, patch: Partial<Task>): void =>
    setDraft({ ...draft, tasks: draft.tasks.map((t, j) => (i === j ? { ...t, ...patch } : t)) })

  const moveSubtask = (i: number, delta: -1 | 1): void => {
    const tasks = [...draft.tasks]
    const j = i + delta
    if (j < 0 || j >= tasks.length) return
    ;[tasks[i], tasks[j]] = [tasks[j], tasks[i]]
    setDraft({ ...draft, tasks })
  }

  // The hint is informational only — main enforces the gate at the actual
  // status change (§7.2), so Save always persists whatever is typed.
  const gateUnmet =
    draft.kind === 'story' && (!draft.spec.trim() || !draft.tasks.some((t) => t.selected !== false))
  const children = draft.kind === 'epic' ? items.filter((i) => i.epic === draft.id) : []

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl rounded-xl border border-border-subtle bg-surface-elevated p-6">
        <div className="mb-6 flex items-center justify-between border-b border-border-subtle pb-4">
          {/* TD ruling 1: text-only, so the icon-font subset stays untouched. */}
          <button className={BTN_GHOST_SM} onClick={onClose}>
            ‹ Back to Board
          </button>
          <div className="flex items-center gap-2">
            <span className={KIND_CHIP[draft.kind]}>{KIND_LABEL[draft.kind]}</span>
            <button
              className="rounded bg-primary-container px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-inverse-primary disabled:opacity-50"
              onClick={save}
              disabled={!draft.name.trim()}
            >
              Save
            </button>
            <button className={BTN_GHOST} onClick={onClose}>
              Cancel
            </button>
            {draft.id && (
              <button
                className="rounded px-5 py-2 text-sm text-error transition-colors hover:bg-error-container hover:text-on-error"
                onClick={remove}
              >
                Delete
              </button>
            )}
          </div>
        </div>
        <span className="font-mono-code text-mono-code text-on-surface-variant">
          {draft.id || 'New item'}
        </span>
        <input
          className={`mt-1 ${INPUT_TITLE}`}
          placeholder="Story title (e.g. Add image upload)"
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />

        <div className="mt-6">
          <span className={LABEL}>Spec</span>
          <textarea
            className={`mt-2 min-h-40 w-full resize-y ${INPUT}`}
            placeholder="What are we building, and how do we know it's done?"
            value={draft.spec}
            onChange={(e) => setDraft({ ...draft, spec: e.target.value })}
          />
          {gateUnmet && (
            <p className="mt-2 text-xs text-on-surface-variant">
              Needs a non-empty spec and at least one subtask before it can move to Ready.
            </p>
          )}
        </div>

        {/* Epics decompose into Stories through Grooming, never hand-editing (§7.3). */}
        {draft.kind === 'epic' && (
          <div className="mt-8">
            <span className={LABEL}>Stories</span>
            <div className="mt-2 space-y-2">
              {children.length === 0 && (
                <p className="text-sm text-on-surface-variant">No stories yet.</p>
              )}
              {children.map((c) => (
                <div
                  key={c.id}
                  className="flex cursor-pointer items-center gap-3 rounded-lg border border-border-subtle bg-surface p-card-padding transition-colors hover:border-outline-variant"
                  onClick={() => onOpen(c)}
                >
                  <span className="font-mono-code text-mono-code text-on-surface-variant">
                    {c.id}
                  </span>
                  <span className="flex-1 font-semibold text-on-surface">{c.name}</span>
                  <span className={statusChip()}>{c.status}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* An Idea carries no plan by definition (CONTEXT.md) — no subtask editor. */}
        {draft.kind === 'story' && (
          <div className="mt-8">
            <span className={LABEL}>Subtasks</span>
            <div className="mt-2 space-y-4">
              {draft.tasks.map((t, i) => (
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
                          placeholder="Subtask title (e.g. Design the feature)"
                          value={t.title}
                          onChange={(e) => patchSubtask(i, { title: e.target.value })}
                        />
                        <select
                          className={INPUT}
                          value={t.role}
                          onChange={(e) => patchSubtask(i, { role: e.target.value })}
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
                            onClick={() => moveSubtask(i, -1)}
                            title="Move up"
                          >
                            <span className="material-symbols-outlined text-[18px]">
                              arrow_upward
                            </span>
                          </button>
                          <button
                            className={ICON_BTN}
                            onClick={() => moveSubtask(i, 1)}
                            title="Move down"
                          >
                            <span className="material-symbols-outlined text-[18px]">
                              arrow_downward
                            </span>
                          </button>
                          <button
                            className="ml-2 rounded p-1.5 text-error transition-colors hover:bg-error-container hover:text-on-error"
                            title="Remove subtask"
                            onClick={() =>
                              setDraft({ ...draft, tasks: draft.tasks.filter((_, j) => j !== i) })
                            }
                          >
                            <span className="material-symbols-outlined text-[18px]">close</span>
                          </button>
                        </div>
                      </div>
                      <textarea
                        className={`h-24 w-full resize-y ${INPUT}`}
                        placeholder="Subtask prompt…"
                        value={t.prompt}
                        onChange={(e) => patchSubtask(i, { prompt: e.target.value })}
                      />
                      <div className="flex flex-wrap items-start gap-3">
                        <RefineControl
                          repo={repo}
                          kind="task"
                          text={t.prompt}
                          onApply={(text) => patchSubtask(i, { prompt: text })}
                        />
                        <MicButton
                          onText={(text) => patchSubtask(i, { prompt: appendText(t.prompt, text) })}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-4">
              <button
                className={`flex items-center gap-1 ${BTN_GHOST}`}
                onClick={() =>
                  setDraft({
                    ...draft,
                    // TD ruling 2: adding subtasks never promotes an Idea's kind.
                    tasks: [...draft.tasks, emptySubtask(roles[0]?.slug ?? '')]
                  })
                }
              >
                <span className="material-symbols-outlined text-[16px]">add</span> Add subtask
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
