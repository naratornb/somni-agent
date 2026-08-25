import { spawn } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { WebContents } from 'electron'
import { getRunner, Runner } from './runners'
import { feed, StreamEvent } from './stream'

export type TaskEvent =
  StreamEvent | { kind: 'spawn-error'; message: string } | { kind: 'exit'; code: number | null }

export type SpawnHandle = {
  done: Promise<{ code: number | null; ok: boolean }>
  kill: (signal?: NodeJS.Signals) => void
}

// Shared spawn/stream plumbing. Runner-agnostic: the binary and the line parser
// both come from the adapter (architecture.md §5).
export function spawnRunner(
  runner: Runner,
  args: string[],
  cwd: string,
  onEvent: (ev: TaskEvent) => void,
  onRaw?: (chunk: string) => void
): SpawnHandle {
  const child = spawn(runner.binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let buf = ''
  let resultOk = false
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    onRaw?.(chunk)
    const { events, rest } = feed(buf, chunk, runner.parseLine)
    buf = rest
    for (const ev of events) {
      if (ev.kind === 'result') resultOk = ev.ok
      onEvent(ev)
    }
  })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (chunk: string) => {
    if (chunk.trim()) onEvent({ kind: 'spawn-error', message: chunk.trim() })
  })
  const done = new Promise<{ code: number | null; ok: boolean }>((resolve) => {
    child.on('error', (err) => {
      onEvent({ kind: 'spawn-error', message: err.message })
      onEvent({ kind: 'exit', code: null })
      resolve({ code: null, ok: false })
    })
    child.on('close', (code) => {
      onEvent({ kind: 'exit', code })
      resolve({ code, ok: resultOk && code === 0 })
    })
  })
  return { done, kill: (signal = 'SIGTERM') => child.kill(signal) }
}

let playground: SpawnHandle | null = null

export function runTask(prompt: string, send: (ev: TaskEvent) => void): void {
  if (playground) return
  const cwd = mkdtempSync(join(tmpdir(), 'somni-m0-'))
  const runner = getRunner()
  playground = spawnRunner(runner, runner.buildArgs(prompt, {}), cwd, send)
  void playground.done.then(() => {
    playground = null
  })
}

export function killTask(): void {
  playground?.kill()
}

export function wireTaskIpc(ipcMain: Electron.IpcMain, contents: () => WebContents | null): void {
  ipcMain.handle('task:run', (_e, prompt: string) => {
    runTask(String(prompt), (ev) => contents()?.send('task:event', ev))
  })
}
