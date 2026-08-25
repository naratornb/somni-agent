import { useCallback, useEffect, useState } from 'react'
import type { PipelineStatus, RepoData, RunState } from '../../preload/index'
import { Playground } from './Playground'
import { LogLine, PipelineView } from './PipelineView'
import { RolesView } from './RolesView'
import { RunsView } from './RunsView'
import { SettingsView } from './SettingsView'
import { WorkflowsView } from './WorkflowsView'

const VIEWS = ['Workflows', 'Pipeline', 'Runs', 'Roles', 'Settings', 'Playground'] as const
type View = (typeof VIEWS)[number]

const timeAgo = (iso: string): string => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`
}

function App(): React.JSX.Element {
  const [repo, setRepo] = useState<string | null>(null)
  const [data, setData] = useState<RepoData>({ roles: [], workflows: [] })
  const [view, setView] = useState<View>('Workflows')
  const [runs, setRuns] = useState<Record<string, RunState>>({})
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({})
  const [pipelineStatus, setPipelineStatus] = useState<{
    status: PipelineStatus
    resumeAt?: string
  } | null>(null)
  const [orphans, setOrphans] = useState<RunState[]>([])

  const refresh = useCallback(
    (path = repo): void => {
      if (!path) return
      void window.somni.loadRepo(path).then(setData)
      // runs left Running on disk belong to a somni that quit or crashed
      void window.somni.orphanedRuns(path).then(setOrphans)
    },
    [repo]
  )

  useEffect(() => {
    void window.somni.lastRepo().then((path) => {
      if (path) {
        setRepo(path)
        refresh(path)
      }
    })
    const offState = window.somni.onRunState((state) =>
      setRuns((r) => ({ ...r, [state.runId]: state }))
    )
    const offLog = window.somni.onRunLog(({ runId, taskIndex, text }) =>
      setLogs((l) => ({
        ...l,
        // ponytail: keep only the last 400 lines per run — full logs are on disk
        [runId]: [...(l[runId] ?? []), { taskIndex, text }].slice(-400)
      }))
    )
    const offPipeline = window.somni.onPipelineStatus(setPipelineStatus)
    return () => {
      offState()
      offLog()
      offPipeline()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, [])

  const choose = async (): Promise<void> => {
    const path = await window.somni.chooseRepo()
    if (path) {
      setRepo(path)
      refresh(path)
    }
  }

  const startPipeline = (slugs: string[]): void => {
    if (!repo || slugs.length === 0) return
    setRuns({})
    setLogs({})
    setPipelineStatus(null)
    setView('Pipeline')
    void window.somni.startPipeline(repo, slugs)
  }

  const resumeRun = (runId: string): void => {
    if (!repo) return
    setRuns({})
    setLogs({})
    setPipelineStatus(null)
    setView('Pipeline')
    setOrphans((o) => o.filter((r) => r.runId !== runId))
    void window.somni.resumePipeline(repo, [runId])
  }

  const abandonRun = (runId: string): void => {
    if (!repo) return
    setOrphans((o) => o.filter((r) => r.runId !== runId))
    void window.somni.abandonRun(repo, runId)
  }

  const busy = Object.values(runs).some((r) => r.finishedAt == null)
  const selected = data.workflows.filter((w) => w.selected)

  return (
    <div className="layout">
      <nav className="sidebar">
        <h1>somni</h1>
        {VIEWS.map((v) => (
          <button key={v} className={v === view ? 'nav active' : 'nav'} onClick={() => setView(v)}>
            {v}
          </button>
        ))}
      </nav>
      <main className="content">
        <div className="repo-bar">
          <span className="dim">{repo ?? 'No repo selected'}</span>
          <button className="ghost" onClick={choose}>
            Choose repo…
          </button>
          {repo && (
            <button className="ghost" onClick={() => refresh()}>
              Refresh
            </button>
          )}
        </div>
        {orphans.map((r) => (
          <div className="task-card" key={r.runId}>
            <span>
              somni quit while <b>{r.name}</b> was running ({timeAgo(r.startedAt)}) —{' '}
              {r.tasks.filter((t) => t.status === 'Completed').length}/{r.tasks.length} tasks
              finished.
            </span>
            <div className="row">
              <button onClick={() => resumeRun(r.runId)}>Resume run</button>
              <button className="ghost" onClick={() => abandonRun(r.runId)}>
                Abandon
              </button>
            </div>
          </div>
        ))}
        {view === 'Playground' ? (
          <Playground />
        ) : view === 'Settings' ? (
          <SettingsView />
        ) : !repo ? (
          <p className="dim">Choose a repo to manage its workflows and roles.</p>
        ) : view === 'Pipeline' ? (
          <PipelineView
            workflows={selected}
            runs={runs}
            logs={logs}
            busy={busy}
            pipelineStatus={pipelineStatus}
            onStart={() => startPipeline(selected.map((w) => w.slug))}
            onCancel={() => void window.somni.cancelPipeline()}
          />
        ) : view === 'Runs' ? (
          <RunsView repo={repo} />
        ) : view === 'Workflows' ? (
          <WorkflowsView
            repo={repo}
            workflows={data.workflows}
            roles={data.roles}
            refresh={refresh}
            onRun={(slug) => startPipeline([slug])}
            running={busy}
          />
        ) : (
          <RolesView repo={repo} roles={data.roles} refresh={refresh} />
        )}
      </main>
    </div>
  )
}

export default App
