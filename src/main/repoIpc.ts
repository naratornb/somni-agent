import { app, dialog, ipcMain } from 'electron'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import * as store from './store'
import { atomicWrite } from './store'

// Machine-level settings (architecture.md §4): just the last-opened repo for now.
const settingsPath = (): string => join(app.getPath('userData'), 'settings.json')

function readSettings(): { lastRepo?: string } {
  try {
    return JSON.parse(readFileSync(settingsPath(), 'utf8'))
  } catch {
    return {}
  }
}

export function wireRepoIpc(): void {
  ipcMain.handle('repo:last', () => {
    const { lastRepo } = readSettings()
    return lastRepo && existsSync(lastRepo) ? lastRepo : null
  })

  ipcMain.handle('repo:choose', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    const path = res.filePaths[0]
    if (!path) return null
    atomicWrite(settingsPath(), JSON.stringify({ ...readSettings(), lastRepo: path }, null, 2))
    return path
  })

  ipcMain.handle('repo:load', (_e, repo: string) => {
    store.ensureSomni(repo)
    return store.loadRepo(repo)
  })

  ipcMain.handle('role:save', (_e, repo: string, role: store.Role) => store.saveRole(repo, role))
  ipcMain.handle('role:delete', (_e, repo: string, slug: string) => store.deleteRole(repo, slug))
  ipcMain.handle('workflow:save', (_e, repo: string, wf: store.Workflow) =>
    store.saveWorkflow(repo, wf)
  )
  ipcMain.handle('workflow:delete', (_e, repo: string, slug: string) =>
    store.deleteWorkflow(repo, slug)
  )
}
