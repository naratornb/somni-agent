import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import {
  applyProposal,
  ChatEvent,
  ChatProposal,
  DRAFT_KEY,
  loadChat,
  newChat,
  sendChat
} from './chat'
import { isRunning, lockedGit, RunState, wakeDrain } from './executor'
import { diffFiles, RunStats, runStats } from './report'
import * as store from './store'
import { atomicWrite, Settings } from './store'

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

export type RunRow = RunState & { worktreeExists: boolean }
export type RunDetails = { stats: RunStats | null; branchExists: boolean }

const branchExists = (repo: string, branch: string): Promise<boolean> =>
  lockedGit(['-C', repo, 'show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).then(
    () => true,
    () => false
  )

function listRuns(repo: string): RunRow[] {
  const dir = join(repo, '.somni', 'runs')
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .flatMap((runId) => {
      try {
        const state = JSON.parse(readFileSync(join(dir, runId, 'run.json'), 'utf8')) as RunState
        return [{ ...state, worktreeExists: existsSync(state.worktree) }]
      } catch {
        return []
      }
    })
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

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
    return store.loadRepo(repo)
  })

  ipcMain.handle('settings:get', () => ({ ...store.SETTINGS_DEFAULTS, ...readSettings() }))
  ipcMain.handle('settings:set', (_e, s: Settings) => {
    patchSettings(s)
    onSettingsChanged() // the nightly timer re-arms off the new time/armed flag
  })

  // Backlog (M9 Decision 4): parked work, ordered by the user. Promote =
  // unpark + tick + wake, so a live drain picks it up without restarting.
  ipcMain.handle('backlog:set', (_e, repo: string, slugs: string[]) =>
    store.saveBacklog(repo, slugs)
  )
  // Park: untick + append. One IPC so the two writes can't half-land.
  ipcMain.handle('backlog:park', (_e, repo: string, slug: string) => {
    store.setSelected(repo, slug, false)
    const backlog = store.loadBacklog(repo)
    if (!backlog.includes(slug)) store.saveBacklog(repo, [...backlog, slug])
  })
  ipcMain.handle('backlog:promote', (_e, repo: string, slug: string) => {
    store.saveBacklog(
      repo,
      store.loadBacklog(repo).filter((s) => s !== slug)
    )
    store.setSelected(repo, slug, true)
    wakeDrain()
  })

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
  ipcMain.handle('workflow:save', (_e, repo: string, wf: store.Workflow) =>
    store.saveWorkflow(repo, wf)
  )
  ipcMain.handle('workflow:delete', (_e, repo: string, slug: string) =>
    store.deleteWorkflow(repo, slug)
  )

  // Draft with AI (§7). Read-only chat; `proposal:apply` is the only write out
  // of it, and it happens in main so definitions never round-trip the renderer.
  ipcMain.handle('chat:load', (_e, repo: string, slug: string) => loadChat(repo, slug))
  ipcMain.handle('chat:new', (_e, repo: string, slug: string) => newChat(repo, slug))
  ipcMain.handle('chat:send', (_e, repo: string, slug: string, text: string) => {
    // Only a workflow currently executing is refused; the draft chat and
    // unrelated workflows stay usable during a pipeline (Decision 9).
    if (slug !== DRAFT_KEY && isRunning(slug))
      return { ok: false, error: 'this workflow is currently running' }
    const settings = repoSettings(repo)
    const roleSlugs = store.loadRepo(repo).roles.map((r) => r.slug)
    return sendChat(repo, slug, text, settings, roleSlugs, (ev: ChatEvent) =>
      BrowserWindow.getAllWindows()[0]?.webContents.send('chat:event', ev)
    )
  })
  ipcMain.handle('proposal:apply', (_e, repo: string, slug: string, proposal: ChatProposal) =>
    applyProposal(repo, slug, proposal)
  )
}
