import { useCallback, useEffect, useState } from 'react'
import type { DrainState, RepoData, RunState } from '../../preload/index'
import { Playground } from './Playground'
import { LogLine, PipelineView } from './PipelineView'
import { RolesView } from './RolesView'
import { RunsView } from './RunsView'
import { SettingsView } from './SettingsView'
import { WorkflowsView } from './WorkflowsView'
import { DraftView } from './DraftView'

// Nav order + Material Symbols glyph per view (mock: any code.html sidebar).
const VIEWS = {
  Workflows: 'account_tree',
  Draft: 'chat_bubble',
  Pipeline: 'speed',
  Runs: 'history',
  Roles: 'groups',
  Settings: 'settings',
  Playground: 'terminal'
} as const
type View = keyof typeof VIEWS

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
    <div className="flex h-screen overflow-hidden bg-background text-on-surface font-body-md text-body-md">
      <nav className="fixed left-0 top-0 z-20 flex h-screen w-sidebar-width flex-col border-r border-border-subtle bg-background px-4 py-6">
        <div className="mb-8 px-3">
          <h1 className="font-headline-md text-headline-md font-bold tracking-tight text-primary">
            somni
          </h1>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          {Object.entries(VIEWS).map(([v, icon]) => (
            <button
              key={v}
              className={
                'flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ' +
                (v === view
                  ? 'bg-surface-container-high font-semibold text-on-surface'
                  : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface')
              }
              onClick={() => setView(v as View)}
            >
              <span
                className="material-symbols-outlined text-[20px]"
                style={v === view ? { fontVariationSettings: "'FILL' 1" } : undefined}
              >
                {icon}
              </span>
              {v}
            </button>
          ))}
        </div>
      </nav>
      <main className="relative ml-sidebar-width flex h-screen flex-1 flex-col overflow-hidden bg-background">
        <header className="z-10 flex h-14 shrink-0 items-center justify-between border-b border-border-subtle bg-background px-gutter py-3">
          <div className="flex items-center gap-2 truncate font-mono-code text-mono-code text-on-surface-variant">
            <span className="material-symbols-outlined text-[18px]">folder</span>
            <span className="truncate">{repo ?? 'No repo selected'}</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              className="flex items-center gap-2 rounded border border-border-subtle bg-surface-container px-3 py-1.5 text-sm text-on-surface transition-colors hover:bg-surface-container-high"
              onClick={choose}
            >
              Choose repo…
            </button>
            {repo && (
              <button
                className="flex items-center gap-2 rounded border border-border-subtle bg-surface-container px-3 py-1.5 text-sm text-on-surface transition-colors hover:bg-surface-container-high"
                onClick={() => refresh()}
              >
                <span className="material-symbols-outlined text-[16px]">refresh</span>
                Refresh
              </button>
            )}
          </div>
        </header>
        <div className="flex min-h-0 flex-1 flex-col gap-stack-gap overflow-y-auto p-gutter">
          {orphans.map((r) => (
            <div
              className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface-elevated p-card-padding"
              key={r.runId}
            >
              <span>
                somni quit while <b>{r.name}</b> was running ({timeAgo(r.startedAt)}) —{' '}
                {r.tasks.filter((t) => t.status === 'Completed').length}/{r.tasks.length} tasks
                finished.
              </span>
              <div className="flex items-center gap-2">
                <button
                  className="rounded-full bg-primary-container px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-inverse-primary"
                  onClick={() => resumeRun(r.runId)}
                >
                  Resume run
                </button>
                <button
                  className="rounded border border-border-subtle bg-surface-container px-3 py-1.5 text-sm text-on-surface transition-colors hover:bg-surface-bright"
                  onClick={() => abandonRun(r.runId)}
                >
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
            <p className="text-on-surface-variant">
              Choose a repo to manage its workflows and roles.
            </p>
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
        </div>
      </main>
    </div>
  )
}

export default App
