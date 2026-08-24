import { useCallback, useEffect, useState } from 'react'
import type { RepoData } from '../../preload/index'
import { Playground } from './Playground'
import { RolesView } from './RolesView'
import { WorkflowsView } from './WorkflowsView'

const VIEWS = ['Workflows', 'Roles', 'Playground'] as const
type View = (typeof VIEWS)[number]

function App(): React.JSX.Element {
  const [repo, setRepo] = useState<string | null>(null)
  const [data, setData] = useState<RepoData>({ roles: [], workflows: [] })
  const [view, setView] = useState<View>('Workflows')

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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once on mount
  }, [])

  const choose = async (): Promise<void> => {
    const path = await window.somni.chooseRepo()
    if (path) {
      setRepo(path)
      refresh(path)
    }
  }

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
        ) : view === 'Workflows' ? (
          <WorkflowsView
            repo={repo}
            workflows={data.workflows}
            roles={data.roles}
            refresh={refresh}
          />
        ) : (
          <RolesView repo={repo} roles={data.roles} refresh={refresh} />
        )}
      </main>
    </div>
  )
}

export default App
