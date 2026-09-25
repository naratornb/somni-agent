import { useCallback, useEffect, useRef, useState } from 'react'
import appIcon from './assets/icon.png'
import type {
  DrainState,
  Persona,
  ProviderHealth,
  RepoData,
  ResolvedSettings,
  RunState,
  SkillsStatus
} from '../../preload/index'
import { Playground } from './Playground'
import { LogLine, PipelineView } from './PipelineView'
import { ProvidersSetup } from './ProvidersSetup'
import { RunsView } from './RunsView'
import { SessionsView } from './SessionsView'
import { SettingsView } from './SettingsView'
import { BoardView } from './BoardView'
import { GroomView } from './GroomView'
import { HomeView } from './HomeView'
import { CaptureModal, CommandPalette } from './capture'
import {
  approveRunIds,
  BTN_PRIMARY,
  pick,
  saveCapture,
  seedLiveRuns,
  type PaletteResult
} from './ui'

// Material Symbols glyph per routable view. Home reuses the freed `speed`
// glyph — the icon font is a subset (main.css), so new ligatures render as
// raw text; reuse beats re-subsetting, and Home is where draining lives.
const VIEWS = {
  Home: 'speed',
  Board: 'account_tree',
  // Sessions and Groom share the chat glyph — Groom is not a nav destination,
  // so nothing is ambiguous and the icon subset stays as it is.
  Sessions: 'chat_bubble',
  Groom: 'chat_bubble',
  Runs: 'history',
  Settings: 'settings',
  Playground: 'terminal'
} as const
type View = keyof typeof VIEWS

// The nav destinations (M23, + Sessions in M25.3). Groom is a flow step, not a
// place; Playground is a dev surface only.
const NAV: View[] = ['Home', 'Board', 'Sessions', 'Runs', 'Settings']
if (import.meta.env.DEV) NAV.push('Playground')

const timeAgo = (iso: string): string => {
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  return mins < 60 ? `${mins}m ago` : `${Math.round(mins / 60)}h ago`
}

function App(): React.JSX.Element {
  const [repo, setRepo] = useState<string | null>(null)
  const [data, setData] = useState<RepoData>({ roles: [], items: [], backlog: [] })
  const [view, setView] = useState<View>('Home')
  // The item the Groom view is grooming — every door creates it first (M25.1).
  const [groom, setGroom] = useState<{ id: string; name: string } | null>(null)
  // Home quick-start (M23): the typed task seeds the groom, and Apply of a
  // Ready story auto-queues it. Board/Capture grooms never set these.
  const [groomSeed, setGroomSeed] = useState<string | null>(null)
  const [autoRun, setAutoRun] = useState(false)
  const [runs, setRuns] = useState<Record<string, RunState>>({})
  // Stale-wins fix (M29 final review): the runIds `onRunState` has actually
  // pushed THIS session — seedRuns's disk merge below must only let these
  // entries of `runs` override disk, never the whole map. Without this, once
  // a run seeds in from disk it counts as "live" on every later refresh too,
  // so a disk-only change (e.g. Abandon on a crash-orphaned run) never shows.
  // State, not a ref: Home's PipelineView reads it at render time below, and
  // react-hooks/refs forbids reading a ref's `.current` during render.
  const [liveRunIds, setLiveRunIds] = useState<Set<string>>(new Set())
  // Ref mirror of the above (M30): refresh()'s `.then` runs after an async
  // gap, so if it closed over `liveRunIds` (captured when the callback was
  // built) a push that landed mid-flight was invisible to that resolution —
  // the run vanished from `runs` until the next refresh. The ref is updated
  // in the same onRunState statement as the state copy and read only inside
  // closures (never during render), so seedLiveRuns always sees the latest.
  const liveRunIdsRef = useRef<Set<string>>(new Set())
  const [logs, setLogs] = useState<Record<string, LogLine[]>>({})
  // Drain state is owned by main (Decision 8): seeded from pipeline:state on
  // mount — a renderer opened mid-drain shows the truth — then kept live by the
  // pipeline:status pushes, which carry the mode.
  const [drain, setDrain] = useState<DrainState | null>(null)
  const [orphans, setOrphans] = useState<RunState[]>([])
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
  // Zero-provider onboarding (M26 §3): null until the first probe resolves —
  // the guided setup only replaces the app once every provider has failed.
  const [providersHealth, setProvidersHealth] = useState<ProviderHealth[] | null>(null)
  // A Groom that finished while the user was elsewhere (M25.2).
  // The finished Groom to announce, and whether a background work unit did it.
  const [groomDone, setGroomDone] = useState<{ slug: string; workUnit: boolean } | null>(null)
  // Fix (M27 final review): GroomView's header chip and shouldAutoHandoff must
  // see the settings-level persona too — item?.persona ?? settings.persona ??
  // 'director', the same order main resolves it in (chat.ts's personaOf).
  // M29: switched to resolveSettings(repo) — the repo's .somni/config.json can
  // override persona too, and this is the same resolution chat:send uses
  // internally, so the chip/default and the actual grooming behavior agree.
  // Refetched on every refresh(), same as the rest of the repo-scoped state —
  // a save doesn't push here live (no settings:changed event exists yet), so
  // reopening Settings mid-app rarely races grooming a still-unstamped item.
  const [settings, setSettings] = useState<ResolvedSettings | null>(null)

  // Every door into a Groom (Board, Sessions, Home, Capture, the toast, a
  // clicked notification) opens it the same way: plain conversation, no seed,
  // no auto-run. Quick-start is the one exception and sets those itself.
  const openGroom = useCallback((item: { id: string; name: string }): void => {
    setGroom({ id: item.id, name: item.name })
    setGroomSeed(null)
    setAutoRun(false)
    setView('Groom')
  }, [])

  const refresh = useCallback(
    (path = repo): void => {
      if (!path) return
      void window.somni.loadRepo(path).then(setData)
      void window.somni.skillsStatus(path).then(setSkills)
      // runs left Running on disk belong to a somni that quit or crashed
      void window.somni.orphanedRuns(path).then(setOrphans)
      // Durable Board grades + Merge (M29 item 1, fixed in final review):
      // every prior run, not just what this session's pipeline pushed live —
      // seedLiveRuns merges disk under only the runIds onRunState has
      // actually pushed live (`pick`), so a live push always wins but a
      // disk-only change to a run that was merely seeded in on some earlier
      // refresh still lands (it was never "live" to begin with). liveIds is
      // read via the ref getter, not `liveRunIds` itself (M30) — see the
      // ref's declaration for why.
      void window.somni
        .listRuns(path)
        .then((rows) => setRuns((r) => seedLiveRuns(rows, r, () => liveRunIdsRef.current)))
      void window.somni.resolveSettings(path).then(setSettings)
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
    const offState = window.somni.onRunState((state) => {
      setLiveRunIds((s) => {
        if (s.has(state.runId)) return s
        const next = new Set(s).add(state.runId)
        liveRunIdsRef.current = next // kept in sync with the state copy — see the ref's declaration
        return next
      })
      setRuns((r) => ({ ...r, [state.runId]: state }))
    })
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

  // Chat events are global (M25.2): a Turn that finishes for a Groom the user
  // isn't looking at announces itself here. GroomView keeps its own listener
  // for the open session — these two never render the same thing.
  useEffect(() => {
    return window.somni.onChatEvent((ev) => {
      // A session transition (M25.5): Sessions/Home are projections of the repo
      // load, so a refresh is the whole re-render.
      if (ev.kind === 'state') return void refresh()
      if (ev.kind !== 'done') return
      if (view === 'Groom' && groom?.id === ev.slug) return
      setGroomDone({ slug: ev.slug, workUnit: !!ev.workUnit })
    })
  }, [view, groom?.id, refresh])

  // A clicked native notification (M25.6): the window is already focused by
  // main — this is the navigation half.
  useEffect(() => {
    return window.somni.onOpenSession((slug) => {
      openGroom({ id: slug, name: data.items.find((i) => i.id === slug)?.name ?? slug })
    })
  }, [data.items, openGroom])

  useEffect(() => {
    if (!groomDone) return
    const t = setTimeout(() => setGroomDone(null), 8000)
    return () => clearTimeout(t)
  }, [groomDone])

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

  // Alongside the single-runner probe above: every provider at once, for the
  // zero-provider guided setup. onRecheck (the setup screen's button) reruns
  // this same probe — no separate polling loop needed.
  const checkProviders = useCallback((): void => {
    void window.somni.providersStatus().then(setProvidersHealth)
  }, [])
  useEffect(() => {
    checkProviders()
  }, [checkProviders])
  const allProvidersDown =
    providersHealth != null && providersHealth.length > 0 && providersHealth.every((h) => !h.ok)

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
    setView('Home') // the activity area lives on Home now (M23)
    void window.somni.startPipeline(repo, slugs).then(() => refresh())
  }

  const resumeRun = (runId: string): void => {
    if (!repo) return
    setView('Home')
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

  // Home quick-start → groom seeded with the typed task; Apply auto-queues.
  // persona (M27): the Quick Start chip's value, stamped at birth.
  const quickStart = (text: string, persona: Persona): void => {
    if (!repo) return
    void window.somni.startGroom(repo, persona).then((item) => {
      setGroom({ id: item.id, name: item.name })
      setGroomSeed(text)
      setAutoRun(true)
      setView('Groom')
      refresh() // so the header persona chip reflects the pick immediately
    })
  }

  // The palette is a second surface for actions that already exist — never a
  // second write path (capture goes through the same helper as the modal).
  const runPalette = (r: PaletteResult, query: string): void => {
    setPalette(false)
    if (r.action === 'capture') {
      if (repo) void saveCapture(repo, query).then(() => refresh())
    } else if (r.action === 'goto') {
      setView(r.view as View)
    } else if (r.action === 'open') {
      setOpenId(r.id)
      setView('Board')
    } else {
      startPipeline([])
    }
  }

  return (
    <div className="flex h-screen overflow-hidden bg-background text-on-surface font-body-md text-body-md">
      <nav className="fixed left-0 top-0 z-20 flex h-screen w-sidebar-width flex-col border-r border-border-subtle bg-background px-4 py-6">
        <div className="mb-8 flex items-center gap-2.5 px-3">
          <img src={appIcon} alt="" className="h-6 w-6 rounded-md" />
          <h1 className="font-headline-md text-headline-md font-bold tracking-tight text-primary">
            somni
          </h1>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          {NAV.map((v) => (
            <button
              key={v}
              className={
                'flex items-center gap-3 rounded-lg px-3 py-2 text-left transition-colors ' +
                (v === view
                  ? 'bg-surface-container-high font-semibold text-on-surface'
                  : 'text-on-surface-variant hover:bg-surface-container hover:text-on-surface')
              }
              onClick={() => setView(v)}
            >
              <span
                className="material-symbols-outlined text-[20px]"
                style={v === view ? { fontVariationSettings: "'FILL' 1" } : undefined}
              >
                {VIEWS[v]}
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
                <button className={BTN_PRIMARY} onClick={() => resumeRun(r.runId)}>
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
          {/* M22: the Runner CLI is the app's engine — say so when it's missing.
              Suppressed once every provider is down (M26 §3): ProvidersSetup
              below replaces this banner rather than stacking under it. */}
          {runnerMissing && !runnerHidden && !allProvidersDown && (
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
                  className={BTN_PRIMARY}
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
          {allProvidersDown && view !== 'Settings' ? (
            // Settings stays reachable even here — it's the escape hatch for a
            // custom binary path (Task 8's Providers panel), not the working
            // view the setup screen is meant to replace.
            <ProvidersSetup health={providersHealth ?? []} onRecheck={checkProviders} />
          ) : view === 'Playground' ? (
            <Playground />
          ) : view === 'Settings' ? (
            <SettingsView repo={repo} roles={data.roles} refresh={refresh} />
          ) : !repo ? (
            // The whole first-run story in one place: nothing else competes.
            <div className="m-auto flex max-w-md flex-col items-center gap-4 text-center">
              <h2 className="font-headline-lg text-headline-lg font-bold">Welcome to somni</h2>
              <p className="leading-relaxed text-on-surface-variant">
                Pick a repository — somni grooms your ideas into stories and runs them overnight.
              </p>
              <button className={BTN_PRIMARY} onClick={() => void choose()}>
                Choose repo
              </button>
            </div>
          ) : view === 'Home' ? (
            <HomeView
              repo={repo}
              items={data.items}
              onStart={quickStart}
              onGroom={(item) => {
                openGroom(item)
              }}
              onViewAll={() => setView('Sessions')}
              defaultPersona={settings?.persona}
            >
              <PipelineView
                // Session-scoped, not the Board's full seeded history (M29
                // final review fix): only runIds onRunState has pushed live.
                runs={pick(runs, liveRunIds)}
                logs={logs}
                busy={busy}
                drain={drain}
                keepRunning={keepRunning}
                onToggleKeepRunning={(on) => void window.somni.setKeepRunning(repo, on)}
                onStart={() => startPipeline([])}
                onCancel={() => void window.somni.cancelPipeline()}
              />
            </HomeView>
          ) : view === 'Sessions' ? (
            <SessionsView
              repo={repo}
              items={data.items}
              refresh={refresh}
              onOpen={(item) => {
                openGroom(item)
              }}
            />
          ) : view === 'Runs' ? (
            <RunsView repo={repo} />
          ) : view === 'Groom' && groom ? (
            <GroomView
              // Fix (M27 final review): distinct grooms are distinct instances — a
              // groom-to-groom transition (the toast's Open button, a clicked
              // notification) must never reuse the previous session's mount-time
              // state (loaded ref, transcript, persona override) against a new
              // itemId.
              key={groom.id}
              repo={repo}
              roles={data.roles}
              itemId={groom.id}
              itemName={groom.name}
              groomState={data.items.find((i) => i.id === groom.id)?.groomState}
              item={data.items.find((i) => i.id === groom.id)}
              defaultPersona={settings?.persona}
              seed={groomSeed ?? undefined}
              applyLabel={autoRun ? 'Apply & run' : undefined}
              onApplied={(item, children) => {
                refresh()
                // Approve & run (needs-review, M27 §7): queue the root (once
                // Ready) plus every unblocked child. Quick-start: a Ready story
                // goes straight into the pipeline (the gate stays main's).
                // Everything else lands on the Board where it's visible.
                if (children) {
                  const ids = approveRunIds(item, children)
                  if (ids.length) startPipeline(ids)
                  else setView('Board')
                } else if (autoRun && item.status === 'ready') {
                  startPipeline([item.id])
                } else {
                  setView('Board')
                }
                setAutoRun(false)
                setGroomSeed(null)
              }}
            />
          ) : (
            <BoardView
              repo={repo}
              items={data.items}
              backlog={data.backlog}
              roles={data.roles}
              runs={runs}
              refresh={refresh}
              openId={openId}
              onClosePanel={() => setOpenId(null)}
              onGroom={(item) => {
                openGroom(item)
              }}
            />
          )}
        </div>
      </main>
      {capturing && repo && (
        <CaptureModal
          repo={repo}
          onClose={() => setCapturing(false)}
          onSaved={() => refresh()}
          onGroom={(item) => {
            setCapturing(false)
            openGroom(item)
          }}
        />
      )}
      {/* M25.2: the off-screen Groom's reply is ready. Dismissible, and it
          auto-dismisses — a toast, never a queue of banners. */}
      {groomDone && (
        <div className="fixed bottom-6 right-6 z-30 flex items-center gap-3 rounded-lg border border-border-subtle bg-surface-elevated px-4 py-3 shadow-lg">
          <span>
            Groom <b>{groomDone.slug}</b>{' '}
            {groomDone.workUnit ? 'finished its background draft — needs review.' : 'has a reply.'}
          </span>
          <button
            className={BTN_PRIMARY}
            onClick={() => {
              const item = data.items.find((i) => i.id === groomDone.slug)
              openGroom({ id: groomDone.slug, name: item?.name ?? groomDone.slug })
              setGroomDone(null)
            }}
          >
            Open
          </button>
          <button
            className="rounded border border-border-subtle bg-surface-container px-3 py-1.5 text-sm text-on-surface transition-colors hover:bg-surface-bright"
            onClick={() => setGroomDone(null)}
          >
            Dismiss
          </button>
        </div>
      )}
      {palette && (
        <CommandPalette
          items={data.items}
          views={NAV}
          onRun={runPalette}
          onClose={() => setPalette(false)}
        />
      )}
    </div>
  )
}

export default App
