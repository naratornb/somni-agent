import { useEffect, useRef, useState } from 'react'
import type { DrainState, RunState } from '../../preload/index'
import { STATUS_CHIP, statusChip as chipClass } from './ui'

export type LogLine = { taskIndex: number; text: string }

type Props = {
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

const DONE: string[] = ['Completed', 'Failed', 'Skipped', 'Cancelled']

export function PipelineView({
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

  // One card per story: the latest run wins — history is Runs & Reports' job.
  // Cards come from the runs themselves now that the Board owns what's queued.
  const byStory = (id: string): RunState | undefined =>
    Object.values(runs)
      .filter((r) => r.workflow === id)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
  const cards = Object.values(runs)
    .filter((r) => byStory(r.workflow)?.runId === r.runId)
    .map((r) => ({ key: r.workflow, name: r.name, run: r, tasks: r.tasks }))
  const allTasks = Object.values(runs).flatMap((r) => r.tasks)
  const total = allTasks.length
  const done = allTasks.filter((t) => DONE.includes(t.status)).length

  const statusChip =
    drain?.status === 'Paused' ? (
      <span className={chipClass('Cancelled')} title="Rate limit reached">
        ⏸ Paused
        {drain.resumeAt && ` — resumes ${clock(drain.resumeAt)}`}
      </span>
    ) : drain?.status === 'Running' && drain.mode ? (
      <span className={chipClass('Running')}>{MODE_LABEL[drain.mode]}</span>
    ) : drain?.mode === 'keep' ? (
      <span className={chipClass('Queued')}>Draining — waiting for work</span>
    ) : null

  if (cards.length === 0)
    return (
      <p className="text-on-surface-variant">
        Nothing running — add a Ready story to the pipeline from the Board.
      </p>
    )

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-stack-gap">
      <div className="mb-4 flex items-center gap-4">
        <button
          className="flex items-center gap-2 rounded-lg bg-primary-container px-4 py-2 font-semibold text-on-primary-container transition-opacity hover:opacity-90 disabled:opacity-50"
          onClick={onStart}
          disabled={busy && drain?.mode !== 'keep'}
        >
          <span className="material-symbols-outlined text-xl">play_arrow</span>
          Drain queue
        </button>
        {/* Never disabled by busy: toggling mid-drain changes the stop rule. */}
        <label className="group flex cursor-pointer items-center gap-2 text-on-surface-variant">
          <input
            type="checkbox"
            className="h-4 w-4 rounded border-outline accent-[#6d5ae0]"
            checked={keepRunning}
            onChange={(e) => onToggleKeepRunning(e.target.checked)}
          />
          <span className="select-none text-sm">Keep Running</span>
        </label>
        {busy && (
          <button
            className="rounded-lg border border-border-subtle px-4 py-2 text-sm text-error transition-colors hover:bg-error-container/20"
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
        {statusChip}
        <div className="mx-4 flex flex-1 items-center gap-3">
          <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-container-highest">
            <div
              className="h-full rounded-full bg-primary-container transition-all duration-500 ease-out"
              style={{ width: `${Math.round((done / (total || 1)) * 100)}%` }}
            />
          </div>
          <span className="font-mono-code text-mono-code text-on-surface-variant">
            {done}/{total} tasks
          </span>
        </div>
      </div>
      {cards.map(({ key, name, run, tasks: defs }) => {
        const tasks = run?.tasks ?? defs
        return (
          <div
            className={
              'rounded-xl border bg-surface-elevated p-card-padding transition-colors ' +
              (run?.status === 'Running'
                ? 'border-status-running shadow-[0_0_12px_rgba(109,90,224,0.3)]'
                : 'border-border-subtle hover:border-outline-variant')
            }
            key={key}
          >
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <h3 className="font-headline-md text-headline-md text-on-surface">{name}</h3>
              <span className={chipClass(run?.status)}>{run?.status ?? 'Queued'}</span>
              {run && (
                <span className="font-mono-code text-mono-code text-on-surface-variant">
                  {run.branch}
                  {run.tasks.some((t) => t.costUsd != null) &&
                    ` · $${run.tasks.reduce((c, t) => c + (t.costUsd ?? 0), 0).toFixed(4)}`}
                </span>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {tasks.map((t, i) => {
                const tr = 'status' in t ? t : null
                const retried = (tr?.attempts ?? 1) > 1
                const title =
                  [retried ? 'Retried once' : '', tr?.error ?? ''].filter(Boolean).join(' — ') ||
                  undefined
                const focused =
                  run && focus?.runId === run.runId && focus.taskIndex === i
                    ? ' ring-1 ring-primary'
                    : ''
                return (
                  <button
                    key={i}
                    className={
                      'rounded-full border px-2 py-1 font-mono-code text-xs transition-colors disabled:cursor-default ' +
                      (STATUS_CHIP[tr?.status ?? 'Queued'] ?? STATUS_CHIP.Queued) +
                      focused
                    }
                    disabled={!run}
                    onClick={() => run && setFocus({ runId: run.runId, taskIndex: i })}
                    title={title}
                  >
                    {t.title || `task ${i + 1}`}
                    {retried && <span className="opacity-60"> ↻</span>}
                  </button>
                )
              })}
            </div>
          </div>
        )
      })}
      {focusTask?.status === 'Failed' && focusTask.error && (
        <div className="rounded-lg border border-status-failed/20 bg-status-failed/10 px-3 py-2 font-mono-code text-mono-code text-status-failed">
          {focusTask.error}
        </div>
      )}
      {focus && (
        <pre
          className="min-h-40 flex-1 overflow-auto rounded-lg border border-border-subtle bg-black p-3 font-mono-code text-mono-code whitespace-pre-wrap text-on-surface-variant"
          ref={paneRef}
        >
          {focusLog.map((l) => l.text).join('\n') || '(no output yet)'}
        </pre>
      )}
    </div>
  )
}
