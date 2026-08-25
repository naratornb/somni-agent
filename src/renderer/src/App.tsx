import { useCallback, useEffect, useState } from 'react'
import type { DrainState, RepoData, RunState } from '../../preload/index'
import { Playground } from './Playground'
import { LogLine, PipelineView } from './PipelineView'
import { RolesView } from './RolesView'
import { RunsView } from './RunsView'
import { SettingsView } from './SettingsView'
import { WorkflowsView } from './WorkflowsView'
import { DraftView } from './DraftView'

const VIEWS = ['Workflows', 'Draft', 'Pipeline', 'Runs', 'Roles', 'Settings', 'Playground'] as const
type View = (typeof VIEWS)[number]

const timeAgo = (iso: string): string => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`
}

function App(): React.JSX.Element {
  const [repo, setRepo] = useState<string | null>(null)
  const [data, setData] = useState<RepoData>({ roles: [], workflows: [], backlog: [] })
  const [view, setView] = useState<View>('Workflows')
  const [runs, setRuns] = useState<Record<string, RunState>>({})
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({})
  // Drain state is owned by main (Decision 8): seeded from pipeline:state on
  // mount — a renderer opened mid-drain shows the truth — then kept live by the
  // pipeline:status pushes, which carry the mode.
  const [drain, setDrain] = useState<DrainState | null>(null)
  const [orphans, setOrphans] = useState<RunState[]>([])
  // Post-Apply handoff: the Draft view names a slug, WorkflowsView opens it
  // once and clears it (consume-once, no lifted editor state).
  const [openSlug, setOpenSlug] = useState<string | null>(null)

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
    void window.somni.pipelineState().then(setDrain)
    const offPipeline = window.somni.onPipelineStatus(({ status, resumeAt, mode }) =>
      setDrain({ status, resumeAt, mode: mode ?? null })
    )
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

  // Tick the named slugs (none = just drain the Queue) and start or join the
  // drain. Finished runs stay on the board — a drain is continuous now, so
  // wiping runs/logs on every join would erase the night's work (Decision 8).
  const startPipeline = (slugs: string[]): void => {
    if (!repo) return
    setView('Pipeline')
    void window.somni.startPipeline(repo, slugs).then(() => refresh())
  }

  const resumeRun = (runId: string): void => {
    if (!repo) return
    setView('Pipeline')
    setOrphans((o) => o.filter((r) => r.runId !== runId))
    void window.somni.resumePipeline(repo, [runId])
  }

  const abandonRun = (runId: string): void => {
    if (!repo) return
    setOrphans((o) => o.filter((r) => r.runId !== runId))
    void window.somni.abandonRun(repo, runId)
  }

  // Busy = a drain is live, per main — not derived from the run board.
  const busy = drain != null && drain.mode != null
  const keepRunning = drain?.mode === 'keep'
  // Decision 9: chat is refused only for a workflow currently executing, not
  // for the whole app — so the editor chat gates on these slugs, not on busy.
  const runningSlugs = Object.values(runs)
    .filter((r) => r.finishedAt == null)
    .map((r) => r.workflow)
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
            drain={drain}
            keepRunning={keepRunning}
            onToggleKeepRunning={(on) => void window.somni.setKeepRunning(repo, on)}
            onStart={() => startPipeline([])}
            onCancel={() => void window.somni.cancelPipeline()}
          />
        ) : view === 'Draft' ? (
          <DraftView
            repo={repo}
            roles={data.roles}
            onApplied={(wf) => {
              refresh()
              setOpenSlug(wf.slug)
              setView('Workflows')
            }}
          />
        ) : view === 'Runs' ? (
          <RunsView repo={repo} />
        ) : view === 'Workflows' ? (
          <WorkflowsView
            repo={repo}
            workflows={data.workflows}
            backlog={data.backlog}
            roles={data.roles}
            refresh={refresh}
            onRun={(slug) => startPipeline([slug])}
            runningSlugs={runningSlugs}
            openSlug={openSlug}
            onOpened={() => setOpenSlug(null)}
          />
        ) : (
          <RolesView repo={repo} roles={data.roles} refresh={refresh} />
        )}
      </main>
    </div>
  )
}

export default App
