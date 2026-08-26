import { useCallback, useEffect, useState } from 'react'
import type { RunDetails, RunRow } from '../../preload/index'
import { statusChip } from './ui'

const DASH = '—'

const stamp = (iso?: string): string => (iso ? new Date(iso).toLocaleString() : DASH)
// Same-day end times drop the redundant date, as in the mock.
const endStamp = (start?: string, end?: string): string => {
  if (!end) return DASH
  const e = new Date(end)
  return start && new Date(start).toDateString() === e.toDateString()
    ? e.toLocaleTimeString()
    : e.toLocaleString()
}

const secs = (ms?: number): string => (ms == null ? DASH : `${Math.round(ms / 1000)}s`)
const usd = (n?: number): string => (n == null ? DASH : `$${n.toFixed(4)}`)

const wallClock = (r: RunRow): string => {
  if (!r.finishedAt) return DASH
  const total = Math.round((Date.parse(r.finishedAt) - Date.parse(r.startedAt)) / 1000)
  if (!Number.isFinite(total) || total < 0) return DASH
  const m = Math.floor(total / 60)
  return m ? `${m}m ${total % 60}s` : `${total}s`
}
const money = (n?: number): string => (n == null ? DASH : `$${n.toFixed(2)}`)
const tokens = (n?: number): string =>
  n == null ? DASH : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)

// The report's "## Summary" section (compact/full styles write it; minimal doesn't).
function summarySection(report: string | null): string | null {
  if (!report) return null
  const body = report.split(/^## Summary\s*$/m)[1]
  return body ? body.split(/^## /m)[0].trim() || null : null
}

const MINIMAL_HINT =
  'No summary — report style is Minimal; change it in Settings to have somni write one.'

const TILE = 'bg-surface p-4 rounded border border-border-subtle flex flex-col gap-1'
const TILE_LABEL =
  'font-mono-label text-mono-label text-on-surface-variant uppercase tracking-wider'
const TILE_VALUE = 'font-headline-lg text-headline-lg text-on-surface'
const PANEL_HEAD = 'font-headline-md text-headline-md text-on-surface flex items-center gap-2'

function Tile({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className={TILE}>
      <span className={TILE_LABEL}>{label}</span>
      <span className={TILE_VALUE}>{value}</span>
    </div>
  )
}

// The expanded card body (the runs_reports mock). Split out from RunsView so it
// can be rendered with a stats fixture in the view test.
export function RunDetailsPanel({
  run,
  details,
  report,
  onSwitchBranch,
  onReveal,
  onCleanup
}: {
  run: RunRow
  details: RunDetails | null
  report: string | null
  onSwitchBranch: () => void
  onReveal: () => void
  onCleanup: () => void
}): React.JSX.Element {
  const stats = details?.stats
  const summary = summarySection(report)
  return (
    <div className="flex flex-col gap-6 bg-surface-dim p-6">
      <div className="grid grid-cols-4 gap-4">
        <Tile label="Duration" value={wallClock(run)} />
        <Tile label="Cost" value={money(stats?.totalCostUsd)} />
        <Tile label="Tokens Prompt" value={tokens(stats?.promptTokens)} />
        <Tile label="Tokens Comp." value={tokens(stats?.completionTokens)} />
      </div>

      <div className="grid grid-cols-3 gap-6">
        <div className="col-span-2 flex flex-col gap-4">
          <h3 className={PANEL_HEAD}>
            <span className="material-symbols-outlined text-[18px] text-primary">description</span>
            Implementation Summary
          </h3>
          <div className="rounded border border-border-subtle bg-surface p-4 font-body-sm leading-relaxed whitespace-pre-wrap text-on-surface-variant">
            {summary ?? MINIMAL_HINT}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <h3 className={PANEL_HEAD}>
            <span className="material-symbols-outlined text-[18px] text-primary">folder_open</span>
            Files Changed ({stats?.files.length ?? 0})
          </h3>
          <div className="flex flex-col divide-y divide-border-subtle rounded border border-border-subtle bg-surface font-mono-code text-xs">
            {stats?.files.length ? (
              stats.files.map((f) => (
                <div
                  className="flex items-center justify-between p-2 transition-colors hover:bg-surface-container"
                  key={f.path}
                >
                  <span
                    className={
                      f.kind === 'A'
                        ? 'text-status-completed'
                        : f.kind === 'D'
                          ? 'text-error'
                          : 'text-tertiary'
                    }
                  >
                    {f.kind === 'A' ? '+' : f.kind === 'D' ? '-' : '~'} {f.path}
                  </span>
                  <span className="text-on-surface-variant">{f.lines} lines</span>
                </div>
              ))
            ) : (
              <div className="p-2 text-on-surface-variant">
                {stats ? 'No file changes' : 'Not available — worktree cleaned up'}
              </div>
            )}
          </div>

          <div className="mt-2 flex flex-col gap-2">
            <button
              className="flex w-full items-center justify-center gap-2 rounded bg-primary-container px-4 py-2 text-sm font-semibold text-on-primary-container transition-colors hover:bg-primary-container/90 disabled:opacity-40"
              disabled={details ? !details.branchExists : true}
              onClick={() => onSwitchBranch()}
            >
              <span className="material-symbols-outlined text-[18px]">account_tree</span>
              Switch to Branch
            </button>
            <div className="grid grid-cols-2 gap-2">
              <button
                className="flex items-center justify-center gap-1 rounded border border-border-subtle bg-surface px-3 py-1.5 text-xs text-on-surface transition-colors hover:bg-surface-container disabled:opacity-40"
                disabled={!run.worktreeExists}
                onClick={() => onReveal()}
              >
                <span className="material-symbols-outlined text-[16px]">open_in_new</span>
                Worktree
              </button>
              <button
                className="flex items-center justify-center gap-1 rounded border border-border-subtle bg-surface px-3 py-1.5 text-xs text-error transition-colors hover:bg-error-container/20 disabled:opacity-40"
                disabled={!run.worktreeExists}
                onClick={() => onCleanup()}
              >
                <span className="material-symbols-outlined text-[16px]">delete_outline</span>
                Clean up
              </button>
            </div>
          </div>
        </div>
      </div>

      <details className="rounded border border-border-subtle bg-surface">
        <summary className="cursor-pointer px-3 py-2 font-mono-label text-mono-label uppercase text-on-surface-variant">
          Tasks ({run.tasks.length})
        </summary>
        <div className="overflow-x-auto border-t border-border-subtle">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border-subtle">
                {['Task', 'Status', 'Duration', 'Cost', 'Error'].map((h) => (
                  <th
                    key={h}
                    className="px-3 py-2 text-left font-mono-label text-mono-label text-on-surface-variant uppercase"
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {run.tasks.map((t, i) => (
                <tr key={i}>
                  <td className="px-3 py-2">{t.title}</td>
                  <td className="px-3 py-2">
                    <span className={statusChip(t.status)}>{t.status}</span>
                  </td>
                  <td className="px-3 py-2 font-mono-code text-xs">{secs(t.durationMs)}</td>
                  <td className="px-3 py-2 font-mono-code text-xs">{usd(t.costUsd)}</td>
                  <td className="px-3 py-2 text-on-surface-variant">{t.error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}

export function RunsView({ repo }: { repo: string }): React.JSX.Element {
  const [runs, setRuns] = useState<RunRow[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [report, setReport] = useState<string | null>(null)
  const [details, setDetails] = useState<RunDetails | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback((): void => {
    void window.somni.listRuns(repo).then(setRuns)
  }, [repo])
  useEffect(load, [load])

  const select = (runId: string): void => {
    const next = open === runId ? null : runId
    setOpen(next)
    setReport(null)
    setDetails(null)
    setNotice(null)
    if (next) {
      void window.somni.runReport(repo, next).then(setReport)
      void window.somni.runDetails(repo, next).then(setDetails)
    }
  }

  const cleanup = async (runId: string): Promise<void> => {
    const res = await window.somni.cleanupRun(repo, runId)
    setNotice(res.error ?? 'Cleaned up.')
    load()
  }

  const switchBranch = async (branch: string): Promise<void> => {
    const res = await window.somni.switchBranch(repo, branch)
    setNotice(res.error ?? `Switched to ${branch}.`)
  }

  if (runs.length === 0)
    return <p className="text-on-surface-variant">No runs yet for this repo.</p>

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-stack-gap">
      {notice && (
        <div className="rounded-lg border border-border-subtle bg-surface-container px-3 py-2 font-mono-code text-mono-code text-on-surface-variant">
          {notice}
        </div>
      )}
      {runs.map((r) => {
        return (
          <div
            className="flex flex-col overflow-hidden rounded-lg border border-border-subtle bg-surface-elevated transition-colors hover:border-surface-tint/50"
            key={r.runId}
          >
            <div
              className={
                'flex cursor-pointer items-center justify-between p-card-padding transition-colors hover:bg-surface-container ' +
                (open === r.runId ? 'border-b border-border-subtle' : '')
              }
              onClick={() => select(r.runId)}
            >
              <div className="flex flex-col">
                <span className="font-headline-md text-headline-md text-on-surface">{r.name}</span>
                <span className="mt-1 font-mono-code text-xs text-on-surface-variant">
                  {r.branch}
                </span>
              </div>
              <div className="flex items-center gap-4">
                <span className={statusChip(r.status)}>{r.status}</span>
                <span className="font-mono-code text-xs text-on-surface-variant">
                  {stamp(r.startedAt)} → {endStamp(r.startedAt, r.finishedAt)}
                </span>
                <span
                  className={
                    'material-symbols-outlined text-on-surface-variant transition-transform ' +
                    (open === r.runId ? 'rotate-180' : '')
                  }
                >
                  expand_more
                </span>
              </div>
            </div>
            {open === r.runId && (
              <RunDetailsPanel
                run={r}
                details={details}
                report={report}
                onSwitchBranch={() => switchBranch(r.branch)}
                onReveal={() => void window.somni.revealWorktree(r.worktree)}
                onCleanup={() => cleanup(r.runId)}
              />
            )}
          </div>
        )
      })}
    </div>
  )
}
