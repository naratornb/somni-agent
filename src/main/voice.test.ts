// Voice (M12). Same shape as repoIpc.test.ts: only `electron` is mocked
// (app.getPath → a temp userData); the whisper binary is a real fake script on
// PATH, so the argv and temp-WAV lifecycle are observed for real.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Handler = (event: unknown, ...args: never[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
  shell: {}
}))

const { modelPath, transcribe, wavFromPcm, wireVoiceIpc } = await import('./voice')

let userData: string
const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  Promise.resolve(handlers.get(channel)!(null, ...(args as never[]))) as Promise<T>

const argvLog = join(tmpdir(), 'somni-voice-argv.log')
const wavPath = join(tmpdir(), 'somni-voice.wav')

/** A fake `whisper-cli` on PATH: logs argv + whether the WAV exists mid-spawn. */
function fakeBinary(body: string): void {
  const dir = mkdtempSync(join(tmpdir(), 'somni-bin-'))
  const bin = join(dir, 'whisper-cli')
  writeFileSync(bin, `#!/bin/sh\n${body}\n`)
  chmodSync(bin, 0o755)
  process.env.PATH = `${dir}:${process.env.PATH}`
}

const OK_BINARY = `echo "$@" > ${argvLog}\n[ -f ${wavPath} ] && echo wav-present >> ${argvLog}\necho ' the quick brown fox. '`

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'somni-voice-'))
  handlers.clear()
  writeFileSync(argvLog, '')
})

describe('wavFromPcm', () => {
  it('writes a 16-bit 16 kHz mono header with the right sizes', () => {
    const buf = wavFromPcm(new Float32Array([0, 0.5, -0.5]), 16000)
    expect(buf.length).toBe(50)
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF')
    expect(buf.readUInt32LE(4)).toBe(42) // 36 + data bytes
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE')
    expect(buf.toString('ascii', 12, 16)).toBe('fmt ')
    expect(buf.readUInt32LE(16)).toBe(16)
    expect(buf.readUInt16LE(20)).toBe(1) // PCM
    expect(buf.readUInt16LE(22)).toBe(1) // mono
    expect(buf.readUInt32LE(24)).toBe(16000)
    expect(buf.readUInt32LE(28)).toBe(32000) // byte rate
    expect(buf.readUInt16LE(32)).toBe(2) // block align
    expect(buf.readUInt16LE(34)).toBe(16)
    expect(buf.toString('ascii', 36, 40)).toBe('data')
    expect(buf.readUInt32LE(40)).toBe(6)
  })

  it('clamps overrange samples instead of wrapping', () => {
    const buf = wavFromPcm(new Float32Array([2, -2, 1, -1]), 16000)
    expect([0, 1, 2, 3].map((i) => buf.readInt16LE(44 + i * 2))).toEqual([
      32767, -32767, 32767, -32767
    ])
  })
})

describe('transcribe', () => {
  it('spawns whisper-cli with the pinned argv and cleans up the temp WAV', async () => {
    fakeBinary(OK_BINARY)
    mkdirSync(join(userData, 'models'), { recursive: true })
    writeFileSync(modelPath(), 'fake-model')

    const res = await transcribe(new Float32Array([0, 0.25]))
    expect(res).toEqual({ ok: true, text: 'the quick brown fox.' })

    const log = readFileSync(argvLog, 'utf8')
    expect(log).toContain(`-m ${modelPath()} -f ${wavPath} -np -nt`)
    expect(log).toContain('wav-present') // the WAV existed at spawn…
    expect(existsSync(wavPath)).toBe(false) // …and is removed after
  })

  it('refuses when the model is missing and surfaces a failing binary', async () => {
    expect(await transcribe(new Float32Array(1))).toEqual({
      ok: false,
      error: 'speech model not downloaded'
    })
    fakeBinary('exit 3')
    mkdirSync(join(userData, 'models'), { recursive: true })
    writeFileSync(modelPath(), 'fake-model')
    const res = await transcribe(new Float32Array(1))
    expect(res.ok).toBe(false)
    expect(res.error).toBeTruthy()
  })

  it('refuses a concurrent call (the guard doubles as mic exclusivity)', async () => {
    fakeBinary(`sleep 0.4\n${OK_BINARY}`)
    mkdirSync(join(userData, 'models'), { recursive: true })
    writeFileSync(modelPath(), 'fake-model')
    const first = transcribe(new Float32Array(1))
    const second = await transcribe(new Float32Array(1))
    expect(second).toEqual({ ok: false, error: 'transcription already running' })
    expect((await first).ok).toBe(true)
  })
})

describe('voice:status', () => {
  it('reports binary:false when whisper-cli is missing from PATH', async () => {
    // The binary probe is cached at module scope (`binaryProbe`), so a PATH
    // that's missing the binary only shows up in a fresh module instance —
    // the top-level `voice` import above may already have a cached `true`
    // from an earlier test's fakeBinary(). Strip any fake bin dirs this file
    // added, then re-import against a clean module registry.
    // Wipe PATH entirely rather than filtering — this machine has a real
    // whisper-cli at /opt/homebrew/bin (per the M12 brief), so any survivng
    // PATH entry could still resolve it.
    const realPath = process.env.PATH
    process.env.PATH = mkdtempSync(join(tmpdir(), 'somni-empty-path-'))
    vi.resetModules()
    const fresh = await import('./voice')
    // The `electron` mock factory closes over this file's top-level
    // `handlers` map (not a per-module-instance one), so wiring the fresh
    // module overwrites the same map entry the outer `invoke` reads from.
    fresh.wireVoiceIpc()
    try {
      expect(await invoke('voice:status')).toEqual({ binary: false, model: false })
    } finally {
      process.env.PATH = realPath
    }
  })

  it('reports the model branch without ever attempting a download', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    fakeBinary('exit 0')
    wireVoiceIpc()
    expect(await invoke('voice:status')).toEqual({ binary: true, model: false })
    mkdirSync(join(userData, 'models'), { recursive: true })
    writeFileSync(modelPath(), 'fake-model')
    expect(await invoke('voice:status')).toEqual({ binary: true, model: true })
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
