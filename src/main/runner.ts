import { spawn } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { WebContents } from 'electron'
import { feed, StreamEvent } from './stream'

export type TaskEvent =
  StreamEvent | { kind: 'spawn-error'; message: string } | { kind: 'exit'; code: number | null }

export type SpawnHandle = {
  done: Promise<{ code: number | null; ok: boolean }>
  kill: () => void
}

// Shared claude spawn/stream plumbing (used by the Playground and the executor).
// Becomes ClaudeRunner behind the Runner adapter at M7.
export function spawnClaude(
  args: string[],
  cwd: string,
  onEvent: (ev: TaskEvent) => void,
  onRaw?: (chunk: string) => void
): SpawnHandle {
  const child = spawn('claude', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
  let buf = ''
  let resultOk = false
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    onRaw?.(chunk)
    const { events, rest } = feed(buf, chunk)
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
  return { done, kill: () => child.kill('SIGTERM') }
}

let playground: SpawnHandle | null = null

export function runTask(prompt: string, send: (ev: TaskEvent) => void): void {
  if (playground) return
  const cwd = mkdtempSync(join(tmpdir(), 'somni-m0-'))
  playground = spawnClaude(['-p', prompt, '--output-format', 'stream-json', '--verbose'], cwd, send)
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
