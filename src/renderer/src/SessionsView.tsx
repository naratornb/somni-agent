// The Sessions page (M25.3) — every grooming session grouped by what it wants
// from the user. Pure projection of the loaded items (no session index); the
// Working/Queued groups render empty until work units land (#43).
import { useState } from 'react'
import type { Item } from '../../preload/index'
import {
  CHIP_SM,
  INPUT,
  KIND_CHIP,
  sessionActivity,
  sessionChip,
  sessionGroups,
  SESSION_CHIP,
  stamp,
  type SessionSort
} from './ui'

const ROW_BTN =
  'rounded border border-border-subtle bg-surface-container px-3 py-1 text-xs text-on-surface transition-colors hover:bg-surface-bright'

export function SessionsView({
  repo,
  items,
  onOpen,
  refresh
}: {
  repo: string
  items: Item[]
  onOpen: (item: Item) => void
  refresh: () => void
}): React.JSX.Element {
  const [sort, setSort] = useState<SessionSort>('activity')
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState('')
  const [state, setState] = useState('')
  const [archived, setArchived] = useState(false)
  const groups = sessionGroups(items, { sort, query, kind, state, archived })
  const total = groups.reduce((n, g) => n + g.items.length, 0)

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-stack-gap">
      <div className="flex flex-wrap items-center gap-2">
        <input
          className={`${INPUT} flex-1`}
          placeholder="Search sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <select className={INPUT} value={kind} onChange={(e) => setKind(e.target.value)}>
          <option value="">All kinds</option>
          {(['idea', 'story', 'epic'] as const).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select className={INPUT} value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option>
          {Object.entries(SESSION_CHIP).map(([k, c]) => (
            <option key={k} value={k}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          className={INPUT}
          value={sort}
          onChange={(e) => setSort(e.target.value as SessionSort)}
        >
          <option value="activity">Last activity</option>
          <option value="created">Created</option>
          <option value="title">Title</option>
        </select>
        <label className="flex items-center gap-2 text-sm text-on-surface-variant">
          <input
            type="checkbox"
            checked={archived}
            onChange={(e) => setArchived(e.target.checked)}
          />
          Show archived
        </label>
      </div>

      {total === 0 && (
        <p className="text-on-surface-variant">
          No grooming sessions
          {query || kind || state ? ' match those filters' : ' yet for this repo'}.
        </p>
      )}

      {groups.map((g) => (
        <section className="flex flex-col gap-2" key={g.key}>
          <h2 className="font-mono-label text-mono-label uppercase tracking-wide text-on-surface-variant">
            {g.label} ({g.items.length})
          </h2>
          {g.items.length === 0 ? (
            <p className="text-sm text-on-surface-variant">Nothing here.</p>
          ) : (
            g.items.map((i) => {
              const chip = sessionChip(i.groomState)
              return (
                <div
                  className="flex cursor-pointer items-center justify-between gap-4 rounded-lg border border-border-subtle bg-surface-elevated p-card-padding transition-colors hover:bg-surface-container"
                  key={i.id}
                  onClick={() => onOpen(i)}
                >
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-headline-md text-headline-md text-on-surface">
                      {i.name}
                    </span>
                    <span className="mt-1 font-mono-code text-xs text-on-surface-variant">
                      {i.id}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-3">
                    <span className={KIND_CHIP[i.kind]}>{i.kind}</span>
                    <span className={chip.cls}>{chip.label}</span>
                    <span className={CHIP_SM}>{stamp(sessionActivity(i))}</span>
                    {i.groomState === 'archived' && (
                      <button
                        className={ROW_BTN}
                        onClick={(e) => {
                          e.stopPropagation()
                          void window.somni.reopenSession(repo, i.id).then(refresh)
                        }}
                      >
                        Reopen
                      </button>
                    )}
                    {/* The quit cut this draft short — pick it back up (M25.6). */}
                    {i.groomState === 'interrupted' && (
                      <button
                        className={ROW_BTN}
                        onClick={(e) => {
                          e.stopPropagation()
                          void window.somni.resumeSession(repo, i.id).then(refresh)
                        }}
                      >
                        Resume
                      </button>
                    )}
                  </div>
                </div>
              )
            })
          )}
        </section>
      ))}
    </div>
  )
}
