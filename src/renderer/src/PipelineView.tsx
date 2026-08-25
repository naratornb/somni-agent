import { useEffect, useRef, useState } from 'react'
import type { DrainState, RunState, Workflow } from '../../preload/index'

export type LogLine = { taskIndex: number; text: string }

type Props = {
  workflows: Workflow[] // checkbox-selected ones
  runs: Record<string, RunState> // keyed by runId, this pipeline only
  logs: Record<string, LogLine[]>
  busy: boolean
  drain: DrainState | null
  keepRunning: boolean
  onToggleKeepRunning: (on: boolean) => void
  onStart: () => void
  onCancel: () => void
}

const MODE_LABEL: Record<string, string> = {
  manual: 'Draining',
  nightly: 'Nightly drain',
  keep: 'Draining (Keep Running)',
  resume: 'Resuming'
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
  drain,
  keepRunning,
  onToggleKeepRunning,
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

  // One card per workflow: the latest run wins — history is Runs & Reports' job.
  const byWorkflow = (slug: string): RunState | undefined =>
    Object.values(runs)
      .filter((r) => r.workflow === slug)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
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
      .filter((r) => byWorkflow(r.workflow)?.runId === r.runId)
      .map((r) => ({ key: r.workflow, name: r.name, run: r, tasks: r.tasks }))
  ]
  const allTasks = Object.values(runs).flatMap((r) => r.tasks)
  const total = Object.keys(runs).length
    ? allTasks.length
    : workflows.reduce((n, w) => n + w.tasks.filter((t) => t.selected !== false).length, 0)
  const done = allTasks.filter((t) => DONE.includes(t.status)).length

  const statusChip =
    drain?.status === 'Paused' ? (
      <span className="chip skip" title="Rate limit reached">
        ⏸ Paused
        {drain.resumeAt && ` — resumes ${clock(drain.resumeAt)}`}
      </span>
    ) : drain?.status === 'Running' && drain.mode ? (
      <span className="chip running">{MODE_LABEL[drain.mode]}</span>
    ) : drain?.mode === 'keep' ? (
      <span className="chip">Draining — waiting for work</span>
    ) : null

  if (cards.length === 0)
    return (
      <p className="dim">
        Queue is empty — tick workflows in the Workflows view, or park them in the Backlog for
        later.
      </p>
    )

  return (
    <div className="stack">
      <div className="row">
        <button onClick={onStart} disabled={busy && drain?.mode !== 'keep'}>
          ▶ Drain queue
        </button>
        {/* Never disabled by busy: toggling mid-drain changes the stop rule. */}
        <label className="row" style={{ width: 'auto' }}>
          <input
            type="checkbox"
            checked={keepRunning}
            onChange={(e) => onToggleKeepRunning(e.target.checked)}
          />
          <span className="field-label" style={{ width: 'auto' }}>
            Keep Running
          </span>
        </label>
        {busy && (
          <button className="danger" onClick={onCancel}>
            Cancel
          </button>
        )}
        {statusChip}
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
