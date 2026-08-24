import { useEffect, useRef } from 'react'
import type { RunState } from '../../preload/index'

type Props = { run: RunState; logs: string[] }

const CHIP: Record<string, string> = {
  Queued: 'chip',
  Running: 'chip running',
  Completed: 'chip ok',
  Failed: 'chip fail',
  Skipped: 'chip skip',
  Cancelled: 'chip skip'
}

export function RunView({ run, logs }: Props): React.JSX.Element {
  const paneRef = useRef<HTMLPreElement>(null)
  useEffect(() => {
    paneRef.current?.scrollTo(0, paneRef.current.scrollHeight)
  }, [logs])

  const done = run.finishedAt != null
  return (
    <div className="stack">
      <div className="row">
        <b>{run.name}</b>
        <span className={CHIP[run.status]}>{run.status}</span>
        <span className="dim">
          {run.branch} · run {run.runId}
        </span>
        {!done && (
          <button className="danger" onClick={() => void window.somni.cancelRun()}>
            Cancel
          </button>
        )}
      </div>
      <ul className="list">
        {run.tasks.map((t, i) => (
          <li key={i} className="plain">
            <span className={CHIP[t.status]}>{t.status}</span> <b>{t.title}</b>
            <span className="dim">
              {t.durationMs != null && ` · ${(t.durationMs / 1000).toFixed(1)}s`}
              {t.costUsd != null && ` · $${t.costUsd.toFixed(4)}`}
              {t.error && ` · ${t.error}`}
            </span>
          </li>
        ))}
      </ul>
      <pre className="output" ref={paneRef}>
        {logs.join('\n')}
      </pre>
    </div>
  )
}
