import { spawn, ChildProcess } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { WebContents } from 'electron'
import { feed, StreamEvent } from './stream'

export type TaskEvent =
  StreamEvent | { kind: 'spawn-error'; message: string } | { kind: 'exit'; code: number | null }

let child: ChildProcess | null = null

// ponytail: single task, hardcoded scratch cwd — the orchestrator arrives in M2.
export function runTask(prompt: string, send: (ev: TaskEvent) => void): void {
  if (child) return
  const cwd = mkdtempSync(join(tmpdir(), 'somni-m0-'))
  child = spawn('claude', ['-p', prompt, '--output-format', 'stream-json', '--verbose'], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let buf = ''
  child.stdout!.setEncoding('utf8')
  child.stdout!.on('data', (chunk: string) => {
    const { events, rest } = feed(buf, chunk)
    buf = rest
    events.forEach(send)
  })
  child.stderr!.setEncoding('utf8')
  child.stderr!.on('data', (chunk: string) => {
    if (chunk.trim()) send({ kind: 'spawn-error', message: chunk.trim() })
  })
  child.on('error', (err) => {
    send({ kind: 'spawn-error', message: err.message })
    child = null
    send({ kind: 'exit', code: null })
  })
  child.on('close', (code) => {
    child = null
    send({ kind: 'exit', code })
  })
}

export function killTask(): void {
  child?.kill('SIGTERM')
}

export function wireTaskIpc(ipcMain: Electron.IpcMain, contents: () => WebContents | null): void {
  ipcMain.handle('task:run', (_e, prompt: string) => {
    runTask(String(prompt), (ev) => contents()?.send('task:event', ev))
  })
}
