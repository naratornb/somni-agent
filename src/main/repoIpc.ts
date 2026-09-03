import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  applyProposal,
  ChatEvent,
  ChatProposal,
  loadChat,
  newChat,
  sendChat,
  startGroom,
  workUnitTurn
} from './chat'
import { handoff } from './sessions'
import { isRunning, loadRuns, RunState, wakeDrain } from './executor'
import { lockedGit } from './git'
import { diffFiles, RunStats, runStats } from './report'
import { getRunner, runnerStatus } from './runners'
import { turn } from './turn'
import * as store from './store'
import { atomicWrite, RunnerName, Settings } from './store'

// Machine-level settings (architecture.md §4): last-opened repo + global defaults.
const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

export function readSettings(): Settings & { lastRepo?: string } {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

export function patchSettings(patch: Partial<Settings & { lastRepo: string }>): void {
  atomicWrite(settingsPath(), JSON.stringify({ ...readSettings(), ...patch }, null, 2))
}

// Global settings + the repo's .somni/config.json overrides.
export function repoSettings(repo: string): Settings & typeof store.SETTINGS_DEFAULTS {
  return store.resolveSettings(repo, readSettings())
}

export type IpcResult = { ok: boolean; error?: string }

export type RunRow = RunState & { worktreeExists: boolean }
export type RunDetails = { stats: RunStats | null; branchExists: boolean }

const branchExists = (repo: string, branch: string): Promise<boolean> =>
  lockedGit(['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(
    () => true,
    () => false
  )

const listRuns = (repo: string): RunRow[] =>
  loadRuns(repo).map((state) => ({ ...state, worktreeExists: existsSync(state.worktree) }))

// Refine with AI (M11 Decision 1): one read-only runner call, no interview, no
// disk write — the renderer holds the result inert until the user Applies it.
const REFINE_PROMPTS = {
  task:
    'Rewrite the following somni Task prompt into a sharper, self-contained brief ' +
    'for an unattended coding agent working in this repo. Reply with ONLY the ' +
    'rewritten prompt — no commentary, no code fences.',
  role:
    'Rewrite the following somni Role preamble into a sharper, self-contained ' +
    'persona instruction for an unattended coding agent working in this repo. ' +
    'Reply with ONLY the rewritten preamble — no commentary, no code fences.'
}

// ponytail: memoized for the app session, keyed by runner+binary. Repo-level
// config.json binary overrides aren't consulted — add a repo param if they ever
// need to be.
const modelCache = new Map<string, Promise<string[]>>()

const gitError = (err: unknown): string =>
  String((err as { stderr?: string })?.stderr || (err as Error)?.message || err).trim()

export function wireRepoIpc(onSettingsChanged: () => void = () => {}): void {
  ipcMain.handle('repo:last', () => {
    const { lastRepo } = readSettings()
    return lastRepo && existsSync(lastRepo) ? lastRepo : null
  })

  ipcMain.handle('repo:choose', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    const path = res.filePaths[0]
    if (!path) return null
    patchSettings({ lastRepo: path })
    return path
  })

  ipcMain.handle('repo:load', (_e, repo: string) => {
    store.ensureSomni(repo)
    // Done sessions age out here rather than on a timer (M25.3).
    store.archiveStaleSessions(repo)
    return store.loadRepo(repo)
  })

  // Back to a plain active conversation: reopening an archived session (M25.3)
  // and dismissing a needs-review Proposal (M25.5) are the same clear.
  ipcMain.handle('session:reopen', (_e, repo: string, id: string) => store.reopenSession(repo, id))

  // Handoff (M25.5): draft this session in the background. The session manager
  // persists working/queued before anything spawns and caps concurrency at 3.
  const startWorkUnit = (repo: string, id: string): IpcResult => {
    if (isRunning(id)) return { ok: false, error: 'this story is currently running' }
    const settings = repoSettings(repo)
    const roleSlugs = store.loadRepo(repo).roles.map((r) => r.slug)
    const emit = (ev: ChatEvent): void =>
      BrowserWindow.getAllWindows()[0]?.webContents.send('chat:event', ev)
    return handoff(repo, id, {
      emit,
      run: () => workUnitTurn(repo, id, settings, roleSlugs, emit)
    })
  }
  ipcMain.handle('session:handoff', (_e, repo: string, id: string) => startWorkUnit(repo, id))
  // Resume an interrupted session (M25.6): the same work-unit path. The CLI
  // session outlived the quit, so `--resume` continues the same conversation —
  // ponytail: no separate resume machinery, a re-handoff *is* the resume.
  ipcMain.handle('session:resume', (_e, repo: string, id: string) => startWorkUnit(repo, id))

  // Home quick-start chips (M23): cheap local git signals, no AI calls. [] on
  // any failure — the renderer owns the static fallback.
  ipcMain.handle('repo:suggestions', async (_e, repo: string): Promise<string[]> => {
    try {
      const chips: string[] = []
      // git grep exits 1 on zero matches — that's "no chip", not a failure.
      const grep = (await lockedGit([
        '-C',
        repo,
        'grep',
        '-c',
        '-E',
        'TODO|FIXME',
        '--',
        '.'
      ]).catch(() => ({ stdout: '' }))) as { stdout: string }
      const todos = grep.stdout
        .split('\n')
        .filter(Boolean)
        .reduce((n, l) => n + (Number(l.slice(l.lastIndexOf(':') + 1)) || 0), 0)
      if (todos > 0) chips.push(`Clean up TODOs (${todos} in the repo)`)
      const log = (await lockedGit(['-C', repo, 'log', '-3', '--format=%s'])) as { stdout: string }
      for (const subject of log.stdout.split('\n').filter(Boolean))
        chips.push(`Follow up on "${subject}"`)
      return chips.slice(0, 4)
    } catch {
      return []
    }
  })

  // Repo-level overrides (.somni/config.json). Only checkCommand is edited from
  // the UI today (M16); the file may hold any Settings key by hand.
  ipcMain.handle('config:get', (_e, repo: string) => store.loadConfig(repo))
  ipcMain.handle('config:set', (_e, repo: string, patch: Settings) => {
    const next: Record<string, unknown> = { ...store.loadConfig(repo), ...patch }
    for (const [k, v] of Object.entries(next)) if (v === '' || v == null) delete next[k]
    atomicWrite(join(repo, '.somni', 'config.json'), JSON.stringify(next, null, 2) + '\n')
  })

  ipcMain.handle('settings:get', () => ({ ...store.SETTINGS_DEFAULTS, ...readSettings() }))
  // Runner health (M22): probed fresh per ask, off the settings on disk.
  ipcMain.handle('runner:status', () => runnerStatus(readSettings()))

  ipcMain.handle('settings:set', (_e, s: Settings) => {
    patchSettings(s)
    onSettingsChanged() // the nightly timer re-arms off the new time/armed flag
  })

  // Item CRUD (§4.1). The Backlog column's order is a bare id array.
  // Manual rename from the Groom header (M25.1) — name + file slug only.
  ipcMain.handle('item:rename', (_e, repo: string, id: string, name: string) =>
    store.renameItem(repo, id, name)
  )
  ipcMain.handle('item:save', (_e, repo: string, item: store.Item) => {
    const created = !item.id
    const saved = store.saveItem(repo, item)
    // Create path only (TD ruling 3): a new Backlog item joins the column's
    // ordering immediately, so backlog.json is never partial. An existing item
    // dragged back to Backlog keeps whatever order it already had.
    if (created && saved.status === 'backlog')
      store.saveBacklog(repo, [...store.loadBacklog(repo), saved.id])
    return saved
  })
  ipcMain.handle('item:delete', (_e, repo: string, id: string) => {
    store.deleteItem(repo, id)
    store.saveBacklog(
      repo,
      store.loadBacklog(repo).filter((b) => b !== id)
    )
  })
  // The Ready gate is enforced here, not in the UI (§4.1): main is the authority.
  ipcMain.handle(
    'item:setStatus',
    (_e, repo: string, id: string, status: store.ItemStatus): IpcResult => {
      const item = store.loadItems(repo).find((i) => i.id === id)
      if (!item) return { ok: false, error: `item not found: ${id}` }
      if (status === 'ready') {
        const why = store.readyBlocker(item)
        if (why) return { ok: false, error: why }
      }
      store.setItemStatus(repo, id, status)
      if (status === 'in-progress') wakeDrain() // an external add still needs a nudge
      return { ok: true }
    }
  )
  ipcMain.handle('backlog:set', (_e, repo: string, ids: string[]) => store.saveBacklog(repo, ids))

  ipcMain.handle('runs:list', (_e, repo: string) => listRuns(repo))
  // Everything the expanded run card needs beyond run.json: stats (persisted at
  // report time, or live-computed for runs written before they were persisted,
  // as long as the worktree survives) and whether Switch to Branch has a target.
  ipcMain.handle('runs:details', async (_e, repo: string, runId: string): Promise<RunDetails> => {
    const run = listRuns(repo).find((r) => r.runId === runId)
    if (!run) return { stats: null, branchExists: false }
    const stats =
      run.stats ??
      (run.worktreeExists
        ? await diffFiles(run.worktree, run.baseSha ?? 'HEAD')
            .then((files) => runStats(run, files))
            .catch(() => null)
        : null)
    return { stats, branchExists: await branchExists(repo, run.branch) }
  })

  // Switch the *target repo* onto the run's branch. Refused on a dirty tree —
  // a checkout there would surprise whatever the user has in progress.
  ipcMain.handle('runs:switchBranch', async (_e, repo: string, branch: string) => {
    try {
      const { stdout } = (await lockedGit(['-C', repo, 'status', '--porcelain'])) as {
        stdout: string
      }
      if (stdout.trim())
        return { ok: false, error: 'repo has uncommitted changes — commit or stash first' }
      if (!(await branchExists(repo, branch)))
        return { ok: false, error: `branch ${branch} no longer exists` }
      await lockedGit(['-C', repo, 'switch', branch])
      return { ok: true }
    } catch (err) {
      return { ok: false, error: gitError(err) }
    }
  })

  ipcMain.handle('runs:revealWorktree', (_e, path: string) => {
    if (existsSync(path)) shell.showItemInFolder(path)
  })

  ipcMain.handle('runs:report', (_e, repo: string, runId: string) => {
    const path = join(repo, '.somni', 'runs', runId, 'report.md')
    return existsSync(path) ? readFileSync(path, 'utf8') : null
  })

  // Cleanup (§3): plain removes — dirty worktrees and unmerged branches are
  // surfaced, never force-deleted.
  ipcMain.handle('runs:cleanup', async (_e, repo: string, runId: string) => {
    const run = listRuns(repo).find((r) => r.runId === runId)
    if (!run) return { ok: false, error: 'run not found' }
    try {
      if (existsSync(run.worktree))
        await lockedGit(['-C', repo, 'worktree', 'remove', run.worktree])
    } catch (err) {
      return { ok: false, error: gitError(err) }
    }
    try {
      await lockedGit(['-C', repo, 'branch', '-d', run.branch])
    } catch (err) {
      return { ok: true, error: `worktree removed, branch kept: ${gitError(err)}` }
    }
    return { ok: true }
  })

  ipcMain.handle('role:save', (_e, repo: string, role: store.Role) => store.saveRole(repo, role))
  ipcMain.handle('role:delete', (_e, repo: string, slug: string) => store.deleteRole(repo, slug))

  // Grooming (§7). Read-only chat; `proposal:apply` is the only write out of
  // it, and it happens in main so definitions never round-trip the renderer.
  ipcMain.handle('chat:load', (_e, repo: string, slug: string) => loadChat(repo, slug))
  ipcMain.handle('chat:new', (_e, repo: string, slug: string) => newChat(repo, slug))
  // Every Groom is an Item from birth (M25.1): the door creates it, main-side.
  ipcMain.handle('groom:start', (_e, repo: string) => startGroom(repo))
  ipcMain.handle('chat:send', (_e, repo: string, slug: string, text: string) => {
    // Only a story currently executing is refused; a fresh groom and unrelated
    // items stay usable during a pipeline (Decision 9).
    if (isRunning(slug)) return { ok: false, error: 'this story is currently running' }
    const settings = repoSettings(repo)
    const roleSlugs = store.loadRepo(repo).roles.map((r) => r.slug)
    return sendChat(repo, slug, text, settings, roleSlugs, (ev: ChatEvent) =>
      BrowserWindow.getAllWindows()[0]?.webContents.send('chat:event', ev)
    )
  })
  // Stateless one-shot — the renderer disables its own button while pending.
  // Uses the global-settings profile, as `chat:send` does: role overrides are
  // not consulted (Decision 1).
  ipcMain.handle('field:refine', async (_e, repo: string, kind: 'task' | 'role', text: string) => {
    if (!text.trim()) return { ok: false, error: 'nothing to refine' }
    const settings = readSettings()
    const r = await turn({
      prompt: `${REFINE_PROMPTS[kind]}\n\n---\n${text}`,
      settings,
      cwd: repo,
      readOnly: true
    })
    return r.ok && r.text
      ? { ok: true, text: r.text }
      : { ok: false, error: 'refine failed — no reply' }
  })

  // Model suggestions for the combo boxes. The inherit case (role editor sends
  // undefined) resolves to the settings runner here, never renderer-side.
  ipcMain.handle('models:list', (_e, runnerName?: RunnerName) => {
    const settings = readSettings()
    const runner = getRunner(runnerName ?? settings.runner ?? 'claude', settings)
    const key = `${runner.name}:${runner.binary}`
    const cached = modelCache.get(key) ?? runner.listModels(runner.binary)
    modelCache.set(key, cached)
    return cached
  })

  ipcMain.handle('proposal:apply', (_e, repo: string, key: string, proposal: ChatProposal) =>
    applyProposal(repo, key, proposal)
  )
}
