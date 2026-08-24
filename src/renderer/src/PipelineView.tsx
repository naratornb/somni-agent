import { useEffect, useRef, useState } from 'react'
import type { RunState, Workflow } from '../../preload/index'

export type LogLine = { taskIndex: number; text: string }

type Props = {
  workflows: Workflow[] // checkbox-selected ones
  runs: Record<string, RunState> // keyed by runId, this pipeline only
  logs: Record<string, LogLine[]>
  busy: boolean
  onStart: () => void
  onCancel: () => void
}

const CHIP: Record<string, string> = {
  Queued: 'chip',
  Running: 'chip running',
  Completed: 'chip ok',
  Failed: 'chip fail',
  Skipped: 'chip skip',
  Cancelled: 'chip skip'
}

const DONE: string[] = ['Completed', 'Failed', 'Skipped', 'Cancelled']

export function PipelineView({
  workflows,
  runs,
  logs,
  busy,
  onStart,
  onCancel
}: Props): React.JSX.Element {
  const [focus, setFocus] = useState<{ runId: string; taskIndex: number } | null>(null)
  const paneRef = useRef<HTMLPreElement>(null)
  const focusLog = focus
    ? (logs[focus.runId] ?? []).filter((l) => l.taskIndex === focus.taskIndex)
    : []
  useEffect(() => {
    paneRef.current?.scrollTo(0, paneRef.current.scrollHeight)
  }, [focusLog.length])

  const byWorkflow = (slug: string): RunState | undefined =>
    Object.values(runs).find((r) => r.workflow === slug)
  const allTasks = Object.values(runs).flatMap((r) => r.tasks)
  const total = Object.keys(runs).length
    ? allTasks.length
    : workflows.reduce((n, w) => n + w.tasks.filter((t) => t.selected !== false).length, 0)
  const done = allTasks.filter((t) => DONE.includes(t.status)).length

  if (workflows.length === 0)
    return <p className="dim">No workflows selected — tick them in the Workflows view.</p>

  return (
    <div className="stack">
      <div className="row">
        <button onClick={onStart} disabled={busy}>
          ▶ Run pipeline
        </button>
        {busy && (
          <button className="danger" onClick={onCancel}>
            Cancel
          </button>
        )}
        <progress value={done} max={total || 1} />
        <span className="dim">
          {done}/{total} tasks
        </span>
      </div>
      {workflows.map((w) => {
        const run = byWorkflow(w.slug)
        const tasks = run?.tasks ?? w.tasks.filter((t) => t.selected !== false)
        return (
          <div className="task-card" key={w.slug}>
            <div className="row">
              <b>{w.name}</b>
              <span className={CHIP[run?.status ?? 'Queued']}>{run?.status ?? 'Queued'}</span>
              {run && (
                <span className="dim">
                  {run.branch}
                  {run.tasks.some((t) => t.costUsd != null) &&
                    ` · $${run.tasks.reduce((c, t) => c + (t.costUsd ?? 0), 0).toFixed(4)}`}
                </span>
              )}
            </div>
            <div className="row wrap">
              {tasks.map((t, i) => (
                <button
                  key={i}
                  className={
                    CHIP['status' in t ? t.status : 'Queued'] +
                    (run && focus?.runId === run.runId && focus.taskIndex === i ? ' focused' : '')
                  }
                  disabled={!run}
                  onClick={() => run && setFocus({ runId: run.runId, taskIndex: i })}
                  title={'error' in t && t.error ? t.error : undefined}
                >
                  {t.title || `task ${i + 1}`}
                </button>
              ))}
            </div>
          </div>
        )
      })}
      {focus && (
        <pre className="output" ref={paneRef}>
          {focusLog.map((l) => l.text).join('\n') || '(no output yet)'}
        </pre>
      )}
    </div>
  )
}
