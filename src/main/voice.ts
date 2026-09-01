// Voice input (M12): local whisper.cpp transcription. Every voice decision
// lives here — the renderer only captures mic audio and renders the result.
// The binary is the brew-installed `whisper-cli` (never app-distributed); the
// base.en model downloads on first use into userData/models/.
import { execFile } from 'child_process'
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs'
import { once } from 'events'
import { app, BrowserWindow, ipcMain } from 'electron'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { promisify } from 'util'
import { readSettings } from './repoIpc'

const execFileP = promisify(execFile)

const MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin'
const MODEL_FILE = 'ggml-base.en.bin'

export const modelPath = (): string => join(app.getPath('userData'), 'models', MODEL_FILE)
const binary = (): string => readSettings().whisperBinary || 'whisper-cli'

/** 16-bit mono PCM WAV with the standard 44-byte header. */
export function wavFromPcm(samples: Float32Array, sampleRate: number): Buffer {
  const buf = Buffer.alloc(44 + samples.length * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples.length * 2, 4)
  buf.write('WAVE', 8)
  buf.write('fmt ', 12)
  buf.writeUInt32LE(16, 16) // PCM chunk size
  buf.writeUInt16LE(1, 20) // format: PCM
  buf.writeUInt16LE(1, 22) // channels
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28) // byte rate
  buf.writeUInt16LE(2, 32) // block align
  buf.writeUInt16LE(16, 34) // bits per sample
  buf.write('data', 36)
  buf.writeUInt32LE(samples.length * 2, 40)
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2)
  }
  return buf
}

// ponytail: the probe is cached for the app session (the modelCache idiom in
// repoIpc.ts). Changing whisperBinary in Settings may serve a stale answer
// until restart — accepted.
let binaryProbe: Promise<boolean> | null = null
const hasBinary = (): Promise<boolean> =>
  (binaryProbe ??= execFileP(binary(), ['--help']).then(
    () => true,
    () => false
  ))

// Module-level guard: one transcription at a time, which also makes the mic
// exclusive across the four fields sharing the button.
let transcribing = false

export type Transcription = { ok: boolean; text?: string; error?: string }
export type VoiceStatus = { binary: boolean; model: boolean }
export type ModelProgress = { received: number; total: number }

export async function transcribe(samples: Float32Array): Promise<Transcription> {
  if (transcribing) return { ok: false, error: 'transcription already running' }
  const model = modelPath()
  if (!existsSync(model)) return { ok: false, error: 'speech model not downloaded' }
  // Safe as a fixed name: the guard above means only one call ever holds it.
  const wav = join(tmpdir(), 'somni-voice.wav')
  transcribing = true
  try {
    writeFileSync(wav, wavFromPcm(samples, 16000))
    const { stdout } = await execFileP(binary(), ['-m', model, '-f', wav, '-np', '-nt'], {
      timeout: 60_000
    })
    return { ok: true, text: stdout.trim() }
  } catch (err) {
    return { ok: false, error: String((err as Error)?.message || err).trim() }
  } finally {
    transcribing = false
    rmSync(wav, { force: true })
  }
}

let downloading: Promise<{ ok: boolean; error?: string }> | null = null

// Streams the model to <path>.tmp and renames on success — the atomic-write
// pattern, done by hand because the payload is a stream, not a string.
async function downloadModel(): Promise<{ ok: boolean; error?: string }> {
  const dest = modelPath()
  const tmp = `${dest}.tmp`
  try {
    mkdirSync(dirname(dest), { recursive: true })
    const res = await fetch(MODEL_URL)
    if (!res.ok || !res.body) throw new Error(`download failed — HTTP ${res.status}`)
    const total = Number(res.headers.get('content-length')) || 0
    let received = 0
    let sent = 0
    const file = createWriteStream(tmp)
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      if (!file.write(chunk)) await once(file, 'drain')
      received += chunk.byteLength
      // ponytail: one push per MiB — per-chunk would be ~9k events for 142 MiB.
      if (received - sent >= 1 << 20) send({ received: (sent = received), total })
    }
    send({ received, total })
    file.end()
    await once(file, 'close')
    renameSync(tmp, dest)
    return { ok: true }
  } catch (err) {
    rmSync(tmp, { force: true })
    return { ok: false, error: String((err as Error)?.message || err) }
  }
}

const send = (payload: { received: number; total: number }): void => {
  for (const win of BrowserWindow.getAllWindows())
    win.webContents.send('voice:modelProgress', payload)
}

export function wireVoiceIpc(): void {
  ipcMain.handle('voice:status', async () => ({
    binary: await hasBinary(),
    model: existsSync(modelPath())
  }))
  // Two mic buttons can both sit in no-model and both be clicked — without
  // this dedupe two fetches interleave into the same .tmp and corrupt it. The
  // second caller shares the first's progress pushes and result.
  ipcMain.handle(
    'voice:downloadModel',
    () => (downloading ??= downloadModel().finally(() => (downloading = null)))
  )
  ipcMain.handle('voice:transcribe', (_e, samples: Float32Array) => transcribe(samples))
}
