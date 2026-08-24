import { useCallback, useEffect, useState } from 'react'
import type { RepoData, RunState } from '../../preload/index'
import { Playground } from './Playground'
import { RolesView } from './RolesView'
import { RunView } from './RunView'
import { WorkflowsView } from './WorkflowsView'

const VIEWS = ['Workflows', 'Roles', 'Playground'] as const
type View = (typeof VIEWS)[number] | 'Run'

function App(): React.JSX.Element {
  const [repo, setRepo] = useState<string | null>(null)
  const [data, setData] = useState<RepoData>({ roles: [], workflows: [] })
  const [view, setView] = useState<View>('Workflows')
  const [run, setRun] = useState<RunState | null>(null)
  const [logs, setLogs] = useState<string[]>([])

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
    const offState = window.somni.onRunState(setRun)
    const offLog = window.somni.onRunLog(({ text }) => setLogs((l) => [...l, text]))
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

  const startRun = (slug: string): void => {
    if (!repo) return
    setLogs([])
    setRun(null)
    setView('Run')
    void window.somni.startRun(repo, slug)
  }

  const navViews: View[] = run ? [...VIEWS, 'Run'] : [...VIEWS]

  return (
    <div className="layout">
      <nav className="sidebar">
        <h1>somni</h1>
        {navViews.map((v) => (
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
        ) : view === 'Run' && run ? (
          <RunView run={run} logs={logs} />
        ) : !repo ? (
          <p className="dim">Choose a repo to manage its workflows and roles.</p>
        ) : view === 'Workflows' ? (
          <WorkflowsView
            repo={repo}
            workflows={data.workflows}
            roles={data.roles}
            refresh={refresh}
            onRun={startRun}
            running={run != null && run.finishedAt == null}
          />
        ) : (
          <RolesView repo={repo} roles={data.roles} refresh={refresh} />
        )}
      </main>
    </div>
  )
}

export default App
