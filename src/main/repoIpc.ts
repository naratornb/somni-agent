import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { ChatEvent, loadChat, newChat, sendChat } from './chat'
import { isRunning, lockedGit, RunState } from './executor'
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

function writeSettings(patch: Partial<Settings & { lastRepo: string }>): void {
  atomicWrite(settingsPath(), JSON.stringify({ ...readSettings(), ...patch }, null, 2))
}

// Global settings + the repo's .somni/config.json overrides.
export function repoSettings(repo: string): Settings & typeof store.SETTINGS_DEFAULTS {
  return store.resolveSettings(repo, readSettings())
}

export type RunRow = RunState & { worktreeExists: boolean }

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

export function wireRepoIpc(): void {
  ipcMain.handle('repo:last', () => {
    const { lastRepo } = readSettings()
    return lastRepo && existsSync(lastRepo) ? lastRepo : null
  })

  ipcMain.handle('repo:choose', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    const path = res.filePaths[0]
    if (!path) return null
    writeSettings({ lastRepo: path })
    return path
  })

  ipcMain.handle('repo:load', (_e, repo: string) => {
    store.ensureSomni(repo)
    return store.loadRepo(repo)
  })

  ipcMain.handle('settings:get', () => ({ ...store.SETTINGS_DEFAULTS, ...readSettings() }))
  ipcMain.handle('settings:set', (_e, s: Settings) => writeSettings(s))

  ipcMain.handle('runs:list', (_e, repo: string) => listRuns(repo))
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

  // Draft with AI (§7). Read-only chat; Apply goes through workflow:save above.
  ipcMain.handle('chat:load', (_e, repo: string, slug: string) => loadChat(repo, slug))
  ipcMain.handle('chat:new', (_e, repo: string, slug: string) => newChat(repo, slug))
  ipcMain.handle('chat:send', (_e, repo: string, slug: string, text: string) => {
    // ponytail: pipeline-wide guard — per-workflow granularity once the
    // executor tracks which slugs are live.
    if (isRunning()) return { ok: false, error: 'a pipeline is running' }
    const settings = repoSettings(repo)
    const roleSlugs = store.loadRepo(repo).roles.map((r) => r.slug)
    return sendChat(repo, slug, text, settings, roleSlugs, (ev: ChatEvent) =>
      BrowserWindow.getAllWindows()[0]?.webContents.send('chat:event', ev)
    )
  })
}
