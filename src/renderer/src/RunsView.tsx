import { useCallback, useEffect, useState } from 'react'
import type { RunRow } from '../../preload/index'

const CHIP: Record<string, string> = {
  Queued: 'chip',
  Running: 'chip running',
  Completed: 'chip ok',
  Failed: 'chip fail',
  Skipped: 'chip skip',
  Cancelled: 'chip skip'
}

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

  if (runs.length === 0) return <p className="dim">No runs yet for this repo.</p>

  return (
    <div className="stack">
      {notice && <div className="error-banner">{notice}</div>}
      {runs.map((r) => (
        <div className="task-card" key={r.runId}>
          <div className="row" onClick={() => select(r.runId)} style={{ cursor: 'pointer' }}>
            <b>{r.name}</b>
            <span className={CHIP[r.status]}>{r.status}</span>
            <span className="dim">
              {when(r.startedAt)} → {when(r.finishedAt)} · {r.branch}
            </span>
          </div>
          {open === r.runId && (
            <>
              <div className="dim">{r.worktree}</div>
              <table className="runs-table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Status</th>
                    <th>Duration</th>
                    <th>Cost</th>
                    <th>Error</th>
                  </tr>
                </thead>
                <tbody>
                  {r.tasks.map((t, i) => (
                    <tr key={i}>
                      <td>{t.title}</td>
                      <td>{t.status}</td>
                      <td>{secs(t.durationMs)}</td>
                      <td>{usd(t.costUsd)}</td>
                      <td className="dim">{t.error ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <pre className="output">{report ?? '(no report)'}</pre>
              <div className="row">
                <button
                  className="ghost"
                  disabled={!r.worktreeExists}
                  onClick={() => cleanup(r.runId)}
                >
                  Clean up worktree
                </button>
              </div>
            </>
          )}
        </div>
      ))}
    </div>
  )
}
