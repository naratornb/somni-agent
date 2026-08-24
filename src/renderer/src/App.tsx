import { useCallback, useEffect, useState } from 'react'
import type { RepoData, RunState } from '../../preload/index'
import { Playground } from './Playground'
import { LogLine, PipelineView } from './PipelineView'
import { RolesView } from './RolesView'
import { WorkflowsView } from './WorkflowsView'

const VIEWS = ['Workflows', 'Pipeline', 'Roles', 'Playground'] as const
type View = (typeof VIEWS)[number]

function App(): React.JSX.Element {
  const [repo, setRepo] = useState<string | null>(null)
  const [data, setData] = useState<RepoData>({ roles: [], workflows: [] })
  const [view, setView] = useState<View>('Workflows')
  const [runs, setRuns] = useState<Record<string, RunState>>({})
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({})

  const refresh = useCallback(
    (path = repo): void => {
      if (path) void window.somni.loadRepo(path).then(setData)
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
    return () => {
      offState()
      offLog()
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
    setView('Pipeline')
    void window.somni.startPipeline(repo, slugs)
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
        {view === 'Playground' ? (
          <Playground />
        ) : !repo ? (
          <p className="dim">Choose a repo to manage its workflows and roles.</p>
        ) : view === 'Pipeline' ? (
          <PipelineView
            workflows={selected}
            runs={runs}
            logs={logs}
            busy={busy}
            onStart={() => startPipeline(selected.map((w) => w.slug))}
            onCancel={() => void window.somni.cancelPipeline()}
          />
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
