import { useEffect, useRef, useState } from 'react'
import type { PipelineStatus, RunState, Workflow } from '../../preload/index'

export type LogLine = { taskIndex: number; text: string }

type Props = {
  workflows: Workflow[] // checkbox-selected ones
  runs: Record<string, RunState> // keyed by runId, this pipeline only
  logs: Record<string, LogLine[]>
  busy: boolean
  pipelineStatus: { status: PipelineStatus; resumeAt?: string } | null
  onStart: () => void
  onCancel: () => void
}

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

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
  pipelineStatus,
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

  const focusTask = focus ? runs[focus.runId]?.tasks[focus.taskIndex] : undefined

  const byWorkflow = (slug: string): RunState | undefined =>
    Object.values(runs).find((r) => r.workflow === slug)
  // A resumed run's workflow may not be checkbox-selected — card it from the run itself.
  const cards = [
    ...workflows.map((w) => ({
      key: w.slug,
      name: w.name,
      run: byWorkflow(w.slug),
      tasks: w.tasks.filter((t) => t.selected !== false)
    })),
    ...Object.values(runs)
      .filter((r) => !workflows.some((w) => w.slug === r.workflow))
      .map((r) => ({ key: r.runId, name: r.name, run: r, tasks: r.tasks }))
  ]
  const allTasks = Object.values(runs).flatMap((r) => r.tasks)
  const total = Object.keys(runs).length
    ? allTasks.length
    : workflows.reduce((n, w) => n + w.tasks.filter((t) => t.selected !== false).length, 0)
  const done = allTasks.filter((t) => DONE.includes(t.status)).length

  if (cards.length === 0)
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
        {pipelineStatus?.status === 'Paused' && (
          <span className="chip skip" title="Rate limit reached">
            ⏸ Paused
            {pipelineStatus.resumeAt && ` — resumes ${clock(pipelineStatus.resumeAt)}`}
          </span>
        )}
        <progress value={done} max={total || 1} />
        <span className="dim">
          {done}/{total} tasks
        </span>
      </div>
      {cards.map(({ key, name, run, tasks: defs }) => {
        const tasks = run?.tasks ?? defs
        return (
          <div className="task-card" key={key}>
            <div className="row">
              <b>{name}</b>
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
              {tasks.map((t, i) => {
                const tr = 'status' in t ? t : null
                const retried = (tr?.attempts ?? 1) > 1
                const title =
                  [retried ? 'Retried once' : '', tr?.error ?? ''].filter(Boolean).join(' — ') ||
                  undefined
                return (
                  <button
                    key={i}
                    className={
                      CHIP[tr?.status ?? 'Queued'] +
                      (run && focus?.runId === run.runId && focus.taskIndex === i ? ' focused' : '')
                    }
                    disabled={!run}
                    onClick={() => run && setFocus({ runId: run.runId, taskIndex: i })}
                    title={title}
                  >
                    {t.title || `task ${i + 1}`}
                    {retried && <span className="dim"> ↻</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
      {focusTask?.status === 'Failed' && focusTask.error && (
        <div className="error-banner">{focusTask.error}</div>
      )}
      {focus && (
        <pre className="output" ref={paneRef}>
          {focusLog.map((l) => l.text).join('\n') || '(no output yet)'}
        </pre>
      )}
    </div>
  )
}
