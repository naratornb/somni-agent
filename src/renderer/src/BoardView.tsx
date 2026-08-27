// The Board (M13-ui.md) — the kanban home view. One column per item Status;
// every move is a status change through main, which is the sole authority: no
// optimistic move, refusals are surfaced verbatim (§4).
import { useState } from 'react'
import type { Item, ItemStatus, Role, RunState } from '../../preload/index'
import { StoryPanel } from './StoryPanel'
import { QuickAdd } from './capture'
import {
  BTN_GHOST_SM,
  CHIP,
  CHIP_SM,
  ERROR_BANNER,
  ICON_BTN,
  KIND_CHIP,
  LABEL,
  reorderBacklog
} from './ui'

type Props = {
  repo: string
  items: Item[]
  backlog: string[] // Backlog-column order
  roles: Role[]
  runs: Record<string, RunState> // this session's live runs, keyed by runId
  refresh: () => void
  onGroom: (id: string) => void // hand off to the Groom view (§7)
  openId?: string | null // item the palette asked to open in the StoryPanel
  onClosePanel?: () => void
}

// Fixed and ordered — never reordered, never hidden (§1).
const COLUMNS: { status: ItemStatus; label: string; empty: string }[] = [
  { status: 'backlog', label: 'Backlog', empty: 'Nothing yet — New Story to get started.' },
  { status: 'grooming', label: 'Grooming', empty: 'Nothing being groomed.' },
  { status: 'ready', label: 'Ready', empty: 'No stories ready — groom one, then drag it here.' },
  { status: 'in-progress', label: 'In Progress', empty: 'Nothing running.' },
  { status: 'needs-attention', label: 'Needs Attention', empty: 'Nothing needs attention.' },
  { status: 'review', label: 'Review', empty: 'Nothing to review.' },
  { status: 'done', label: 'Done', empty: 'Nothing shipped yet.' }
]

const KIND_LABEL = { idea: 'Idea', story: 'Story', epic: 'Epic' } as const

const newStory = (): Item => ({
  id: '',
  slug: '',
  kind: 'story',
  status: 'backlog',
  name: '',
  spec: '',
  created: '',
  tasks: []
})

export function BoardView({
  repo,
  items,
  backlog,
  roles,
  runs,
  refresh,
  onGroom,
  openId,
  onClosePanel
}: Props): React.JSX.Element {
  const [editing, setEditing] = useState<Item | null>(null)
  const [refused, setRefused] = useState<{ status: ItemStatus; error: string } | null>(null)
  const [ringing, setRinging] = useState<ItemStatus | null>(null)

  const flashRefused = (status: ItemStatus, error: string): void => {
    setRefused({ status, error })
    setRinging(status)
    setTimeout(() => setRinging(null), 600)
    setTimeout(() => setRefused((r) => (r?.status === status ? null : r)), 3000)
  }

  // Every board move is this one call — main refuses or it happens (§4).
  const move = async (id: string, status: ItemStatus): Promise<boolean> => {
    const res = await window.somni.setItemStatus(repo, id, status)
    if (res.ok) refresh()
    else flashRefused(status, res.error ?? 'refused')
    return res.ok
  }

  // Grooming is the AI interview, not the hand-edit panel: main flips the
  // status on the first turn, so this just opens the view (§7).
  const groom = (item: Item): void => onGroom(item.id)

  // Add to pipeline / Re-run share the gate-checking path in main.
  const addToPipeline = async (id: string): Promise<void> => {
    const { refused: why } = await window.somni.addToPipeline(repo, [id])
    if (why.length) flashRefused('in-progress', why[0])
    refresh()
  }

  // Latest run for a story, for the In Progress / Needs Attention metadata.
  const runOf = (id: string): RunState | undefined =>
    Object.values(runs)
      .filter((r) => r.workflow === id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]

  const doneIds = new Set(items.filter((i) => i.status === 'done').map((i) => i.id))
  const blockers = (item: Item): string[] => (item.blockedBy ?? []).filter((b) => !doneIds.has(b))

  const column = (status: ItemStatus): Item[] => {
    const inColumn = items.filter((i) => i.status === status)
    if (status !== 'backlog') return inColumn
    // The Backlog column is the one with a user-chosen order (backlog.json);
    // anything missing from it (hand-added file) trails behind, by id.
    const rank = (i: Item): number =>
      backlog.indexOf(i.id) === -1 ? Number.MAX_SAFE_INTEGER : backlog.indexOf(i.id)
    return [...inColumn].sort((a, b) => rank(a) - rank(b))
  }

  // The palette's "open item" arrives as a prop, so it works without an effect.
  const panelItem = editing ?? items.find((i) => i.id === openId) ?? null
  if (panelItem)
    return (
      <StoryPanel
        repo={repo}
        item={panelItem}
        items={items}
        roles={roles}
        refresh={refresh}
        onClose={() => {
          setEditing(null)
          onClosePanel?.()
        }}
        onOpen={setEditing}
      />
    )

  const card = (item: Item, status: ItemStatus): React.JSX.Element => {
    const blocked = blockers(item)
    const run = runOf(item.id)
    const subtaskCount = item.kind === 'story' ? item.tasks.length : 0
    const childStories = items.filter((i) => i.epic === item.id)
    // In Progress is executor-owned and Done is one-way — neither is draggable (§2).
    const draggable = status !== 'in-progress' && status !== 'done'

    let border = 'border-border-subtle hover:border-outline-variant'
    if (status === 'in-progress')
      border = blocked.length
        ? 'border-status-queued'
        : 'border-status-running shadow-[0_0_12px_rgba(109,90,224,0.3)]'
    if (status === 'needs-attention') border = 'border-status-failed/40'

    return (
      <div
        key={item.id}
        draggable={draggable}
        onDragStart={(e) => e.dataTransfer.setData('text/plain', item.id)}
        // Intra-Backlog drops reorder; a card from another column falls through
        // to the column's drop handler, keeping M13's status-change semantics.
        onDragOver={status === 'backlog' ? (e) => e.preventDefault() : undefined}
        onDrop={
          status === 'backlog'
            ? (e) => {
                const id = e.dataTransfer.getData('text/plain')
                const dragged = items.find((i) => i.id === id)
                if (!dragged || dragged.status !== 'backlog' || id === item.id) return
                e.stopPropagation()
                void window.somni
                  .setBacklog(repo, reorderBacklog(backlog, id, item.id))
                  .then(refresh)
              }
            : undefined
        }
        className={`cursor-pointer rounded-xl border bg-surface-elevated p-card-padding transition-colors ${border}`}
        // A card mid-groom resumes its interview; everywhere else the card is
        // the hand-edit surface (§7).
        onClick={() => (status === 'grooming' ? groom(item) : setEditing(item))}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="font-mono-code text-mono-code text-on-surface-variant">{item.id}</span>
          <span className={KIND_CHIP[item.kind]}>{KIND_LABEL[item.kind]}</span>
        </div>
        <p className="mt-1 font-semibold text-on-surface">{item.name || '(untitled)'}</p>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {item.kind === 'epic' && (
            <span className={CHIP_SM}>
              {childStories.filter((c) => c.status === 'done').length}/{childStories.length} stories
              done
            </span>
          )}
          {status === 'in-progress' && blocked.length > 0 && (
            <span className={CHIP_SM}>Waiting on {blocked.join(', ')}</span>
          )}
          {status === 'in-progress' && blocked.length === 0 && run && (
            <span className={CHIP_SM}>
              {run.tasks.filter((t) => t.status === 'Completed').length}/{run.tasks.length} subtasks
              done
            </span>
          )}
          {status !== 'in-progress' && subtaskCount > 0 && (
            <span className={CHIP_SM}>
              {subtaskCount} subtask{subtaskCount === 1 ? '' : 's'}
            </span>
          )}
          {status === 'ready' && blocked.length > 0 && (
            <span className={CHIP_SM}>Blocked by {blocked.join(', ')}</span>
          )}
          {status === 'needs-attention' && (
            <span className={CHIP_SM}>
              {run?.tasks.find((t) => t.error)?.error ?? 'Run did not complete'}
            </span>
          )}
        </div>
        {/* Epics never execute (CONTEXT.md) — no per-column action on them. */}
        {item.kind !== 'epic' && (
          <div className="mt-3" onClick={(e) => e.stopPropagation()}>
            {status === 'backlog' && (
              <button className={BTN_GHOST_SM} onClick={() => groom(item)}>
                Groom →
              </button>
            )}
            {status === 'ready' && (
              <button
                className="rounded-full bg-primary-container px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-inverse-primary disabled:opacity-50"
                disabled={blocked.length > 0}
                title={blocked.length ? `Blocked by ${blocked.join(', ')}` : undefined}
                onClick={() => void addToPipeline(item.id)}
              >
                Add to pipeline
              </button>
            )}
            {status === 'needs-attention' && (
              <div className="flex items-center gap-2">
                <button
                  className="rounded-lg border border-border-subtle bg-surface px-3 py-1 text-xs text-error transition-colors hover:bg-error-container/20"
                  onClick={() => void addToPipeline(item.id)}
                >
                  Re-run
                </button>
                <button className={BTN_GHOST_SM} onClick={() => groom(item)}>
                  Re-groom
                </button>
              </div>
            )}
            {status === 'review' && (
              <button
                className="rounded-full bg-primary-container px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-inverse-primary"
                onClick={() => void move(item.id, 'done')}
              >
                Accept
              </button>
            )}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-stack-gap">
      <button
        className="self-start rounded-full bg-primary-container px-4 py-2 text-sm font-medium text-white shadow-[0_0_12px_rgba(109,90,224,0.3)] transition-colors hover:bg-inverse-primary"
        onClick={() => setEditing(newStory())}
      >
        New Story
      </button>
      {/* Seven readable columns don't fit one screen — the board scrolls (§1). */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto">
        {COLUMNS.map((col) => {
          const cards = column(col.status)
          return (
            <div key={col.status} className="flex min-w-[220px] flex-1 basis-0 flex-col">
              <div className="sticky top-0 mb-2 flex items-center justify-between border-b border-border-subtle bg-background pb-2">
                <span className={LABEL}>{col.label.toUpperCase()}</span>
                <span className={CHIP}>{cards.length}</span>
              </div>
              {refused?.status === col.status && (
                <div className={`${ERROR_BANNER} mb-2 text-xs`}>
                  {refused.error}
                  <button className={ICON_BTN} onClick={() => setRefused(null)} title="Dismiss">
                    <span className="material-symbols-outlined text-[16px]">close</span>
                  </button>
                </div>
              )}
              <div
                className={`flex-1 space-y-2 overflow-y-auto rounded-lg transition-colors ${
                  ringing === col.status ? 'ring-2 ring-error' : ''
                }`}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  const id = e.dataTransfer.getData('text/plain')
                  if (id) void move(id, col.status)
                }}
              >
                {col.status === 'backlog' && <QuickAdd repo={repo} refresh={refresh} />}
                {cards.length === 0 ? (
                  <p className="p-4 text-center text-sm text-on-surface-variant">{col.empty}</p>
                ) : (
                  cards.map((i) => card(i, col.status))
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
