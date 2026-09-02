import { useCallback, useEffect, useState } from 'react'
import type { DrainState, RepoData, RunState, SkillsStatus, ViewMode } from '../../preload/index'
import { Playground } from './Playground'
import { LogLine, PipelineView } from './PipelineView'
import { RolesView } from './RolesView'
import { RunsView } from './RunsView'
import { SettingsView } from './SettingsView'
import { BoardView } from './BoardView'
import { GroomView } from './GroomView'
import { CaptureModal, CommandPalette } from './capture'
import { LABEL, saveCapture, type PaletteResult } from './ui'

// Nav order + Material Symbols glyph per view (mock: any code.html sidebar).
const VIEWS = {
  Board: 'account_tree',
  Groom: 'chat_bubble',
  Pipeline: 'speed',
  Runs: 'history',
  Roles: 'groups',
  Settings: 'settings',
  Playground: 'terminal'
} as const
type View = keyof typeof VIEWS

// PO hat = capture, groom, accept (CONTEXT.md). Presentation only (Decision 9).
const PO_VIEWS: View[] = ['Board', 'Groom', 'Pipeline', 'Runs']

const timeAgo = (iso: string): string => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`
}

function App(): React.JSX.Element {
  const [repo, setRepo] = useState<string | null>(null)
  const [data, setData] = useState<RepoData>({ roles: [], items: [], backlog: [] })
  const [view, setView] = useState<View>('Board')
  // Which item the Groom view is grooming; null = from scratch (_draft).
  const [groomId, setGroomId] = useState<string | null>(null)
  const [runs, setRuns] = useState<Record<string, RunState>>({})
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({})
  // Drain state is owned by main (Decision 8): seeded from pipeline:state on
  // mount — a renderer opened mid-drain shows the truth — then kept live by the
  // pipeline:status pushes, which carry the mode.
  const [drain, setDrain] = useState<DrainState | null>(null)
  const [orphans, setOrphans] = useState<RunState[]>([])
  // Which views the sidebar offers. Seeded from settings on mount, persisted
  // straight back through settings:set — no separate IPC, no localStorage.
  const [mode, setMode] = useState<ViewMode>('engineer')
  // Capture surfaces (M15): the modal and the palette. Esc closes the top-most.
  const [capturing, setCapturing] = useState(false)
  const [palette, setPalette] = useState(false)
  // Item the palette asked the Board to open in the StoryPanel; consumed once.
  const [openId, setOpenId] = useState<string | null>(null)
  // Vendored skills (M16): the offer banner. Dismissal is per-session.
  const [skills, setSkills] = useState<SkillsStatus | null>(null)
  const [skillsHidden, setSkillsHidden] = useState(false)
  // Missing Runner CLI (M22): the binary name when unresolvable, else null.
  // Dismissal is per-session, like the skills banner.
  const [runnerMissing, setRunnerMissing] = useState<string | null>(null)
  const [runnerHidden, setRunnerHidden] = useState(false)

  const refresh = useCallback(
    (path = repo): void => {
      if (!path) return
      void window.somni.loadRepo(path).then(setData)
      void window.somni.skillsStatus(path).then(setSkills)
      // runs left Running on disk belong to a somni that quit or crashed
      void window.somni.orphanedRuns(path).then(setOrphans)
    },
    [repo]
  )

  useEffect(() => {
    void window.somni.getSettings().then((s) => setMode(s.viewMode))
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

  // Cmd+N / Cmd+K fire regardless of focus — the overlays guard themselves.
  // No OS-level global shortcut (deferred to Settings).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey && e.key.toLowerCase() === 'n') {
        e.preventDefault()
        if (repo) setCapturing(true)
      } else if (e.metaKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setPalette(true)
      } else if (e.key === 'Escape') {
        // Top-most only: the palette sits above the capture modal.
        setPalette((p) => {
          if (p) return false
          setCapturing(false)
          return p
        })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [repo])

  // Probe on mount and on every navigation; while the banner shows, keep
  // re-probing so fixing the path in Settings clears it in place, no restart
  // and no navigation needed.
  useEffect(() => {
    const probe = (): void =>
      void window.somni.runnerStatus().then((h) => setRunnerMissing(h.ok ? null : h.binary))
    probe()
    if (!runnerMissing || runnerHidden) return
    const timer = setInterval(probe, 4000)
    return () => clearInterval(timer)
  }, [view, runnerMissing, runnerHidden])

  const choose = async (): Promise<void> => {
    const path = await window.somni.chooseRepo()
    if (path) {
      setRepo(path)
      refresh(path)
    }
  }

  // Add the named stories (none = just drain what's in progress) and start or
  // join the drain. Finished runs stay on the board — a drain is continuous now, so
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
  const navViews = Object.entries(VIEWS).filter(
    ([v]) => mode === 'engineer' || PO_VIEWS.includes(v as View)
  )

  // The palette is a second surface for actions that already exist — never a
  // second write path (capture goes through the same helper as the modal).
  const runPalette = (r: PaletteResult, query: string): void => {
    setPalette(false)
    if (r.action === 'capture') {
      if (repo) void saveCapture(repo, query).then(() => refresh())
    } else if (r.action === 'goto') {
      if (r.view === 'Groom') setGroomId(null)
      setView(r.view as View)
    } else if (r.action === 'open') {
      setOpenId(r.id)
      setView('Board')
    } else {
      startPipeline([])
    }
  }

  const switchMode = (m: ViewMode): void => {
    setMode(m)
    // Falling back keeps the shell coherent when the current view disappears.
    if (m === 'po' && !PO_VIEWS.includes(view)) setView('Board')
    void window.somni.setSettings({ viewMode: m })
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-on-surface font-body-md text-body-md">
      <nav className="fixed left-0 top-0 z-20 flex h-screen w-sidebar-width flex-col border-r border-border-subtle bg-background px-4 py-6">
        <div className="mb-8 px-3">
          <h1 className="font-headline-md text-headline-md font-bold tracking-tight text-primary">
            somni
          </h1>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          {navViews.map(([v, icon]) => (
            <button
              key={v}
              className={
                'flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ' +
                (v === view
                  ? 'bg-surface-container-high font-semibold text-on-surface'
                  : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface')
              }
              onClick={() => {
                if (v === 'Groom') setGroomId(null) // the nav entry always grooms from scratch
                setView(v as View)
              }}
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
        <div className="mt-auto flex flex-col gap-2 border-t border-border-subtle pt-4">
          <span className={`px-3 ${LABEL}`}>View</span>
          <div className="flex items-center gap-1 rounded-lg border border-border-subtle bg-surface-container p-1">
            {(['po', 'engineer'] as const).map((m) => (
              <button
                key={m}
                className={
                  'flex-1 rounded px-3 py-1.5 text-sm transition-colors ' +
                  (mode === m
                    ? 'bg-surface-container-high font-semibold text-on-surface'
                    : 'text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface')
                }
                onClick={() => switchMode(m)}
              >
                {m === 'po' ? 'PO' : 'Engineer'}
              </button>
            ))}
          </div>
        </div>
      </nav>
      <main className="relative ml-sidebar-width flex h-screen flex-1 flex-col overflow-hidden bg-background">
        <header className="z-10 flex h-14 shrink-0 items-center justify-between border-b border-border-subtle bg-background px-gutter py-3">
          <div className="flex items-center gap-2 truncate font-mono-code text-mono-code text-on-surface-variant">
            <span className="material-symbols-outlined text-[18px]">folder</span>
            <span className="truncate">{repo ?? 'No repo selected'}</span>
          </div>
          <div className="flex items-center gap-2">
            {/* Capture is available from every view; no repo, nowhere to write. */}
            <button
              className="flex items-center gap-2 rounded border border-border-subtle bg-surface-container px-3 py-1.5 text-sm text-on-surface transition-colors hover:bg-surface-container-high disabled:pointer-events-none disabled:opacity-40"
              disabled={!repo}
              title="New idea (⌘N)"
              onClick={() => setCapturing(true)}
            >
              <span className="material-symbols-outlined text-[16px]">add</span>
            </button>
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
          {/* M22: the Runner CLI is the app's engine — say so when it's missing. */}
          {runnerMissing && !runnerHidden && (
            <div className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface-elevated p-card-padding">
              <span>
                Runner CLI <b>{runnerMissing}</b> not found — somni can&apos;t execute stories
                without it. Install it, or set its path in Settings.
              </span>
              <div className="flex items-center gap-2">
                <button
                  className="rounded border border-border-subtle bg-surface-container px-3 py-1.5 text-sm text-on-surface transition-colors hover:bg-surface-bright"
                  onClick={() => setRunnerHidden(true)}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
          {/* M16: the one-time skills offer. Silent once set up or dismissed. */}
          {repo && skills && !skillsHidden && skills.repoVersion !== skills.bundledVersion && (
            <div className="flex flex-col gap-3 rounded-lg border border-border-subtle bg-surface-elevated p-card-padding">
              <span>
                {skills.repoVersion == null
                  ? 'Set up engineering skills for this repo? somni writes .claude/skills/, docs/agents/issue-tracker.md and docs/adr/ — it never touches your other files.'
                  : `Engineering skills v${skills.bundledVersion} are available (this repo has v${skills.repoVersion}). Upgrading overwrites only somni's skill folders.`}
              </span>
              <div className="flex items-center gap-2">
                <button
                  className="rounded-full bg-primary-container px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-inverse-primary"
                  onClick={() => void window.somni.injectSkills(repo).then(setSkills)}
                >
                  {skills.repoVersion == null ? 'Set up skills' : 'Upgrade skills'}
                </button>
                <button
                  className="rounded border border-border-subtle bg-surface-container px-3 py-1.5 text-sm text-on-surface transition-colors hover:bg-surface-bright"
                  onClick={() => setSkillsHidden(true)}
                >
                  Not now
                </button>
              </div>
            </div>
          )}
          {view === 'Playground' ? (
            <Playground />
          ) : view === 'Settings' ? (
            <SettingsView repo={repo} />
          ) : !repo ? (
            <p className="text-on-surface-variant">
              Choose a repo to manage its work items and roles.
            </p>
          ) : view === 'Pipeline' ? (
            <PipelineView
              runs={runs}
              logs={logs}
              busy={busy}
              drain={drain}
              keepRunning={keepRunning}
              onToggleKeepRunning={(on) => void window.somni.setKeepRunning(repo, on)}
              onStart={() => startPipeline([])}
              onCancel={() => void window.somni.cancelPipeline()}
            />
          ) : view === 'Runs' ? (
            <RunsView repo={repo} />
          ) : view === 'Groom' ? (
            <GroomView
              repo={repo}
              roles={data.roles}
              itemId={groomId}
              onApplied={() => {
                refresh()
                setView('Board')
              }}
            />
          ) : view === 'Board' ? (
            <BoardView
              repo={repo}
              items={data.items}
              backlog={data.backlog}
              roles={data.roles}
              runs={runs}
              refresh={refresh}
              openId={openId}
              onClosePanel={() => setOpenId(null)}
              onGroom={(id) => {
                setGroomId(id)
                setView('Groom')
              }}
            />
          ) : (
            <RolesView repo={repo} roles={data.roles} refresh={refresh} />
          )}
        </div>
      </main>
      {capturing && repo && (
        <CaptureModal
          repo={repo}
          onClose={() => setCapturing(false)}
          onSaved={() => refresh()}
          onGroom={(id) => {
            setCapturing(false)
            setGroomId(id)
            setView('Groom')
          }}
        />
      )}
      {palette && (
        <CommandPalette
          items={data.items}
          views={navViews.map(([v]) => v)}
          onRun={runPalette}
          onClose={() => setPalette(false)}
        />
      )}
    </div>
  )
}

export default App
