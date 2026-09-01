// The Turn seam (CONTEXT.md): one attempt, time-bounded, cancellable, with an
// honest failure taxonomy. Tested against a fake `claude` on PATH — Turn is the
// one module that genuinely spans the subprocess boundary, so its own tests are
// integration by nature; everything above it can fake Turn instead.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { turn } from './turn'

const FAKE = `#!/bin/sh
if [ -n "$FAKE_HANG" ]; then exec sleep 30; fi
if [ -n "$FAKE_STDERR" ]; then echo "claude: something exploded" >&2; exit 127; fi
if [ -n "$FAKE_RATE_LIMIT" ]; then
  echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Claude AI usage limit reached"}'
  exit 1
fi
if [ -n "$FAKE_FAIL" ]; then
  echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}'
  exit 1
fi
echo '{"type":"system","subtype":"init","session_id":"s1"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"did work"}]}}'
if [ -n "$FAKE_EMPTY" ]; then
  echo '{"type":"result","subtype":"success","is_error":false}'
else
  echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"duration_ms":5,"result":"the reply"}'
fi
`

let root: string
let cwd: string
let savedPath: string
let fakeEnv: string[] = []

function fake(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    process.env[k] = v
    fakeEnv.push(k)
  }
}

beforeEach(() => {
  fakeEnv = []
  root = mkdtempSync(join(tmpdir(), 'somni-turn-'))
  cwd = join(root, 'wd')
  const bin = join(root, 'bin')
  mkdirSync(cwd)
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), FAKE)
  chmodSync(join(bin, 'claude'), 0o755)
  savedPath = process.env.PATH!
  process.env.PATH = `${bin}:${savedPath}`
})

afterEach(() => {
  process.env.PATH = savedPath
  for (const k of fakeEnv) delete process.env[k]
})

describe('turn', () => {
  it('succeeds with text, usage, session and a raw log', async () => {
    const log = join(root, 'turn.log')
    const seen: string[] = []
    let session = ''
    const r = await turn({
      prompt: 'p',
      settings: {},
      cwd,
      logPath: log,
      onText: (t) => seen.push(t),
      onSession: (id) => (session = id)
    })
    expect(r).toMatchObject({
      ok: true,
      text: 'the reply',
      sessionId: 's1',
      exitCode: 0,
      usage: { costUsd: 0.01, durationMs: 5 }
    })
    expect(seen).toEqual(['did work'])
    expect(session).toBe('s1')
    expect(readFileSync(log, 'utf8')).toContain('did work')
  })

  it('falls back to the streamed text when the result carries no detail', async () => {
    fake({ FAKE_EMPTY: '1' })
    const r = await turn({ prompt: 'p', settings: {}, cwd })
    expect(r).toMatchObject({ ok: true, text: 'did work' })
  })

  it('classifies a failed exit with the result detail', async () => {
    fake({ FAKE_FAIL: '1' })
    const r = await turn({ prompt: 'p', settings: {}, cwd })
    expect(r).toMatchObject({ ok: false, kind: 'exit', detail: 'boom', rateLimited: false })
  })

  it('classifies rate limits at the seam', async () => {
    fake({ FAKE_RATE_LIMIT: '1' })
    const r = await turn({ prompt: 'p', settings: {}, cwd })
    expect(r).toMatchObject({ ok: false, kind: 'exit', rateLimited: true })
  })

  it('falls back to the last stderr line when there is no result event', async () => {
    fake({ FAKE_STDERR: '1' })
    let stderr = ''
    const r = await turn({ prompt: 'p', settings: {}, cwd, onStderr: (m) => (stderr = m) })
    expect(r).toMatchObject({ ok: false, kind: 'exit', detail: 'claude: something exploded' })
    expect(stderr).toContain('exploded')
  })

  it('reports a missing binary as a spawn failure', async () => {
    const r = await turn({
      prompt: 'p',
      settings: { claudeBinary: join(root, 'no-such-claude') },
      cwd
    })
    expect(r).toMatchObject({ ok: false, kind: 'spawn', exitCode: null, rateLimited: false })
  })

  it('kills a hung process on timeout', async () => {
    fake({ FAKE_HANG: '1' })
    const r = await turn({ prompt: 'p', settings: {}, cwd, timeoutMs: 200, graceMs: 100 })
    expect(r).toMatchObject({ ok: false, kind: 'timeout', rateLimited: false })
    expect(r.ok || r.detail).toMatch(/timed out after/)
  })

  it('aborts mid-flight via the signal, and pre-aborted signals never spawn', async () => {
    fake({ FAKE_HANG: '1' })
    const ac = new AbortController()
    setTimeout(() => ac.abort(), 100)
    const r = await turn({ prompt: 'p', settings: {}, cwd, graceMs: 100 }, { signal: ac.signal })
    expect(r).toMatchObject({ ok: false, kind: 'aborted' })

    const dead = new AbortController()
    dead.abort()
    const r2 = await turn({ prompt: 'p', settings: {}, cwd }, { signal: dead.signal })
    expect(r2).toMatchObject({ ok: false, kind: 'aborted', exitCode: null })
  })
})
