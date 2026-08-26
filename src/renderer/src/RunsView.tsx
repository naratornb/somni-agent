import { useCallback, useEffect, useState } from 'react'
import type { RunRow } from '../../preload/index'
import { statusChip } from './ui'

const when = (iso?: string): string => (iso ? new Date(iso).toLocaleString() : '—')
const secs = (ms?: number): string => (ms == null ? '—' : `${Math.round(ms / 1000)}s`)
const usd = (n?: number): string => (n == null ? '—' : `$${n.toFixed(4)}`)

export function RunsView({ repo }: { repo: string }): React.JSX.Element {
  const [runs, setRuns] = useState<RunRow[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const [report, setReport] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const load = useCallback((): void => {
    void window.somni.listRuns(repo).then(setRuns)
  }, [repo])
  useEffect(load, [load])

  const select = (runId: string): void => {
    const next = open === runId ? null : runId
    setOpen(next)
    setReport(null)
    if (next) void window.somni.runReport(repo, next).then(setReport)
  }

  const cleanup = async (runId: string): Promise<void> => {
    const res = await window.somni.cleanupRun(repo, runId)
    setNotice(res.error ?? 'Cleaned up.')
    load()
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
      {runs.map((r) => (
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
                {when(r.startedAt)} → {when(r.finishedAt)}
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
            <div className="flex flex-col gap-6 bg-surface-dim p-6">
              <div className="font-mono-code text-xs text-on-surface-variant">{r.worktree}</div>
              <div className="overflow-x-auto rounded border border-border-subtle bg-surface">
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
                    {r.tasks.map((t, i) => (
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
              <div className="flex flex-col gap-4">
                <h3 className="flex items-center gap-2 font-headline-md text-headline-md text-on-surface">
                  <span className="material-symbols-outlined text-[18px] text-primary">
                    description
                  </span>
                  Report
                </h3>
                <pre className="max-h-96 overflow-auto rounded border border-border-subtle bg-surface p-4 font-mono-code text-mono-code whitespace-pre-wrap text-on-surface-variant">
                  {report ?? '(no report)'}
                </pre>
              </div>
              <div>
                <button
                  className="flex items-center gap-1 rounded border border-border-subtle bg-surface px-3 py-1.5 text-xs text-error transition-colors hover:bg-error-container/20 disabled:opacity-50"
                  disabled={!r.worktreeExists}
                  onClick={() => cleanup(r.runId)}
                >
                  <span className="material-symbols-outlined text-[16px]">delete_outline</span>
                  Clean up worktree
                </button>
              </div>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}
