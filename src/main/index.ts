import { app, shell, BrowserWindow, ipcMain, Notification, powerSaveBlocker } from 'electron'
import { existsSync } from 'fs'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { shellPath } from './env'
import { killTask, wireTaskIpc } from './turn'
import { killChats, setNotifier } from './chat'
import { interruptSessions } from './sessions'
import { patchSettings, readSettings, repoSettings, wireRepoIpc } from './repoIpc'
import { wireVoiceIpc } from './voice'
import { wireSkillsIpc } from './skills'
import { loadItems, readyBlocker, setItemStatus } from './store'
import {
  abandonRun,
  cancelPipeline,
  DrainMode,
  findOrphanedRuns,
  getDrainState,
  isRunning,
  msUntil,
  PipelineStatus,
  resumePipeline,
  RunState,
  setKeepRunning,
  startDrain,
  wakeDrain
} from './executor'

// Must run before any binary probe or spawn (voice, runner). Dev inherits the
// terminal's PATH already — only the Finder-launched build needs the fixup.
if (app.isPackaged) process.env.PATH = shellPath()

function createWindow(): void {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    title: 'somni',
    width: 900,
    height: 670,
    minWidth: 720,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#131315',
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
  electronApp.setAppUserModelId('com.somni')

  if (process.platform === 'darwin') {
    app.setAboutPanelOptions({
      applicationName: 'somni',
      applicationVersion: app.getVersion(),
      copyright: `© ${new Date().getFullYear()} Luke <f.luke.benj@gmail.com>`,
      credits: 'Overnight AI agent workflow orchestrator for macOS'
    })
  }

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  wireTaskIpc(ipcMain, () => BrowserWindow.getAllWindows()[0]?.webContents ?? null)
  wireRepoIpc(() => armNightly())
  wireVoiceIpc()
  wireSkillsIpc((repo) => repoSettings(repo).methodology)

  const wc = (): Electron.WebContents | undefined => BrowserWindow.getAllWindows()[0]?.webContents

  // The only place Electron's Notification is touched (M25.6) — main decides
  // when to notify, this decides how.
  // Caveats from design/research/grooming-sessions-cli-and-notifications.md:
  // macOS notifications silently show nothing in unsigned dev builds (the
  // packaged, signed app is the real test — documented, not fought), and
  // `isSupported()` can be false, in which case we simply don't notify.
  setNotifier({
    isFocused: () => BrowserWindow.getAllWindows().some((w) => w.isFocused()),
    notify: ({ title, body, slug }) => {
      if (!Notification.isSupported()) return
      const n = new Notification({ title, body })
      n.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win) return
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        win.webContents.send('session:open', slug)
      })
      n.show()
    }
  })

  // Keep the Mac awake while a drain has work, and let it sleep while a
  // keep-running drain idles (Decision 9; lid-closed sleep still needs user
  // energy settings — architecture.md §10).
  let blockerId: number | null = null
  const blocker = (status: PipelineStatus): void => {
    if (status !== 'Idle' && blockerId === null) {
      blockerId = powerSaveBlocker.start('prevent-app-suspension')
    } else if (status === 'Idle' && blockerId !== null) {
      if (powerSaveBlocker.isStarted(blockerId)) powerSaveBlocker.stop(blockerId)
      blockerId = null
    }
  }

  const events = {
    onState: (state: RunState) => wc()?.send('run:state', state),
    onLog: (runId: string, taskIndex: number, text: string) =>
      wc()?.send('run:log', { runId, taskIndex, text }),
    onPipeline: (status: PipelineStatus, info?: { resumeAt?: string; mode?: DrainMode | null }) => {
      blocker(status)
      wc()?.send('pipeline:status', { status, ...info })
    }
  }

  const drain = (repo: string, mode: DrainMode): void => {
    const settings = repoSettings(repo)
    void startDrain(
      repo,
      join(app.getPath('userData'), 'worktrees'),
      settings.concurrency,
      events,
      { settings },
      mode
    )
  }

  // Nightly Window (Decision 5): one timer, one repo (lastRepo).
  let nightlyTimer: NodeJS.Timeout | null = null
  const armNightly = (): void => {
    if (nightlyTimer) clearTimeout(nightlyTimer)
    nightlyTimer = null
    const { nightlyArmed, nightlyTime } = readSettings()
    if (!nightlyArmed || !nightlyTime) return
    nightlyTimer = setTimeout(fireNightly, msUntil(nightlyTime, new Date()))
  }
  const fireNightly = (): void => {
    const { lastRepo } = readSettings()
    patchSettings({ nightlyArmed: false }) // disarm on disk before acting on it
    if (!lastRepo || !existsSync(lastRepo)) return
    if (isRunning()) return wakeDrain() // a live drain just picks the Queue up
    drain(lastRepo, 'nightly')
  }
  armNightly()

  // Add to pipeline (M13 §3): the Ready gate is enforced here — main is the
  // authority, the UI merely hides affordances. Passing the gate writes
  // `in-progress` (the tick), then wakes a live drain or starts one.
  // PipelineView's "Drain queue" sends [] — it only starts/joins.
  const addToPipeline = (repo: string, ids: string[]): { refused: string[] } => {
    const items = loadItems(repo)
    const refused: string[] = []
    for (const id of ids) {
      const why = readyBlocker(items.find((i) => i.id === id))
      if (why) {
        refused.push(why)
        continue
      }
      try {
        setItemStatus(repo, id, 'in-progress')
      } catch (err) {
        refused.push(String(err instanceof Error ? err.message : err))
      }
    }
    if (refused.length < ids.length || ids.length === 0) {
      if (isRunning()) wakeDrain()
      else drain(repo, 'manual')
    }
    return { refused }
  }
  ipcMain.handle('pipeline:add', (_e, repo: string, ids: string[]) => addToPipeline(repo, ids))
  ipcMain.handle('pipeline:start', (_e, repo: string, ids: string[]) => addToPipeline(repo, ids))
  ipcMain.handle('pipeline:state', () => getDrainState())
  ipcMain.handle('pipeline:keepRunning', (_e, repo: string, on: boolean) => {
    setKeepRunning(on)
    if (on && !isRunning()) drain(repo, 'keep')
  })
  ipcMain.handle('pipeline:cancel', () => cancelPipeline())
  // A run.json still marked Running while nothing runs here belongs to a dead process.
  ipcMain.handle('pipeline:orphan', (_e, repo: string) =>
    isRunning() ? [] : findOrphanedRuns(repo)
  )
  ipcMain.handle('pipeline:resume', (_e, repo: string, runIds: string[]) => {
    if (isRunning() || runIds.length === 0) return
    const settings = repoSettings(repo)
    void resumePipeline(repo, runIds, settings.concurrency, events, { settings })
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
  interruptSessions() // park working/queued sessions BEFORE their Turns are aborted
  killTask()
  killChats()
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
