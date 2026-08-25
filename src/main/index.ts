import { app, shell, BrowserWindow, ipcMain, powerSaveBlocker } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { wireTaskIpc, killTask } from './runner'
import { killChats } from './chat'
import { repoSettings, wireRepoIpc } from './repoIpc'
import {
  abandonRun,
  cancelPipeline,
  findOrphanedRuns,
  isRunning,
  resumePipeline,
  RunState,
  runPipeline
} from './executor'

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  wireTaskIpc(ipcMain, () => BrowserWindow.getAllWindows()[0]?.webContents ?? null)
  wireRepoIpc()

  const wc = (): Electron.WebContents | undefined => BrowserWindow.getAllWindows()[0]?.webContents
  const events = {
    onState: (state: RunState) => wc()?.send('run:state', state),
    onLog: (runId: string, taskIndex: number, text: string) =>
      wc()?.send('run:log', { runId, taskIndex, text }),
    onPipeline: (status: string, info?: { resumeAt?: string }) =>
      wc()?.send('pipeline:status', { status, ...info })
  }

  // Keep the Mac awake for the whole pipeline (lid-closed sleep still needs
  // user energy settings — see architecture.md §10).
  const awake = (run: Promise<unknown>): void => {
    const id = powerSaveBlocker.start('prevent-app-suspension')
    void run.finally(() => {
      if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id)
    })
  }

  ipcMain.handle('pipeline:start', (_e, repo: string, slugs: string[]) => {
    if (isRunning() || slugs.length === 0) return
    const settings = repoSettings(repo)
    awake(
      runPipeline(
        repo,
        slugs,
        join(app.getPath('userData'), 'worktrees'),
        settings.concurrency,
        events,
        { settings }
      )
    )
  })
  ipcMain.handle('pipeline:cancel', () => cancelPipeline())
  // A run.json still marked Running while nothing runs here belongs to a dead process.
  ipcMain.handle('pipeline:orphan', (_e, repo: string) =>
    isRunning() ? [] : findOrphanedRuns(repo)
  )
  ipcMain.handle('pipeline:resume', (_e, repo: string, runIds: string[]) => {
    if (isRunning() || runIds.length === 0) return
    const settings = repoSettings(repo)
    awake(resumePipeline(repo, runIds, settings.concurrency, events, { settings }))
  })
  ipcMain.handle('pipeline:abandon', (_e, repo: string, runId: string) => abandonRun(repo, runId))

  createWindow()

  app.on('activate', function () {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  killTask()
  killChats()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
