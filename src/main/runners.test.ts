import { execFile } from 'child_process'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { promisify } from 'util'
import { describe, it, expect, vi } from 'vitest'
import { antigravityRunner, claudeRunner, getRunner, runnerStatus } from './runners'

// Wrap the real execFile so listModels tests can assert *how* it was called
// (the timeout ceiling) without losing the real spawn the fixture tests need.
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>()
  const { promisify } = await import('util')
  // runners.ts calls `promisify(execFile)` once at import time, which then
  // always dispatches through execFile's `promisify.custom` implementation
  // (resolves {stdout, stderr} — a bare `vi.fn(actual.execFile)` wrapper would
  // silently drop that symbol and break the real shape). Spy on the custom
  // impl itself so calls are observable without changing behavior.
  const execFile = Object.assign(actual.execFile.bind(actual), {
    [promisify.custom]: vi.fn(actual.execFile[promisify.custom])
  })
  return { ...actual, execFile }
})

// The two adapters are the only place runner differences live (§5), so the same
// four questions are asked of both: read-only argv, autonomous argv, resume
// argv, and the three stdout event shapes.
const cases = [
  {
    runner: claudeRunner,
    binary: 'claude',
    readOnlyFlags: ['--allowedTools', 'Read,Glob,Grep'],
    resumeFlag: '--resume',
    session: JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' }),
    text: JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello' }] }
    }),
    ok: JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      total_cost_usd: 0.42,
      duration_ms: 1234,
      result: 'done'
    }),
    okEvent: { kind: 'result', ok: true, costUsd: 0.42, durationMs: 1234, detail: 'done' },
    fail: JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true }),
    ignored: JSON.stringify({ type: 'user' }),
    rateLimited: 'Claude AI usage limit reached',
    notRateLimited: 'boom'
  },
  {
    runner: antigravityRunner,
    binary: 'agy',
    readOnlyFlags: ['--mode', 'plan', '--sandbox'],
    resumeFlag: '--conversation',
    session: JSON.stringify({ event: 'init', conversation_id: 'abc-123', init: {} }),
    text: JSON.stringify({
      event: 'step_update',
      step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'hello' }
    }),
    ok: JSON.stringify({
      event: 'result',
      result: { status: 'SUCCESS', response: 'done', duration_seconds: 1.234 }
    }),
    okEvent: { kind: 'result', ok: true, costUsd: undefined, durationMs: 1234, detail: 'done' },
    fail: JSON.stringify({ event: 'result', result: { status: 'ERROR' } }),
    ignored: JSON.stringify({
      event: 'step_update',
      step_update: { step_type: 'checkpoint', state: 'DONE' }
    }),
    rateLimited: 'RESOURCE_EXHAUSTED: quota exceeded for model',
    notRateLimited: 'boom'
  }
]

describe.each(cases)('$runner.name runner', (c) => {
  it('builds a read-only turn with no autonomy flag', () => {
    const args = c.runner.buildArgs('hi', { readOnly: true })
    expect(args.slice(0, 2)).toEqual(['-p', 'hi'])
    expect(args).toEqual(expect.arrayContaining(c.readOnlyFlags))
    expect(args).not.toContain('--dangerously-skip-permissions')
    expect(args).not.toContain(c.resumeFlag)
  })

  it('builds an autonomous turn with the profile applied', () => {
    const args = c.runner.buildArgs('go', { autonomous: true, model: 'm1', effort: 'high' })
    expect(args).toEqual(
      expect.arrayContaining([
        '--dangerously-skip-permissions',
        '--model',
        'm1',
        '--effort',
        'high'
      ])
    )
    // autonomous and read-only are mutually exclusive modes
    expect(args).not.toEqual(expect.arrayContaining(c.readOnlyFlags))
  })

  it('resumes a session', () => {
    const args = c.runner.buildArgs('next', { resumeSessionId: 'sess-1' })
    expect(args).toEqual(expect.arrayContaining([c.resumeFlag, 'sess-1']))
  })

  it('parses session, text and result lines', () => {
    expect(c.runner.parseLine(c.session)).toEqual({ kind: 'session', sessionId: 'abc-123' })
    expect(c.runner.parseLine(c.text)).toEqual({ kind: 'text', text: 'hello' })
    expect(c.runner.parseLine(c.ok)).toEqual(c.okEvent)
    expect(c.runner.parseLine(c.fail)).toMatchObject({ kind: 'result', ok: false })
  })

  it('ignores garbage and irrelevant events', () => {
    expect(c.runner.parseLine('not json')).toBeNull()
    expect(c.runner.parseLine(c.ignored)).toBeNull()
  })

  it('classifies its own rate-limit shape', () => {
    expect(c.runner.isRateLimit(c.rateLimited)).toBe(true)
    expect(c.runner.isRateLimit(c.notRateLimited)).toBe(false)
  })
})

// §7 security invariant, agy edition: plan mode alone is advisory, so the
// read-only turn must always also carry --sandbox — including on a resumed turn.
describe('antigravity read-only hardening', () => {
  it('always pairs --mode plan with --sandbox and never autonomy', () => {
    for (const opts of [{ readOnly: true }, { readOnly: true, resumeSessionId: 'sess-1' }]) {
      const args = antigravityRunner.buildArgs('hi', opts)
      expect(args).toEqual(expect.arrayContaining(['--mode', 'plan', '--sandbox']))
      expect(args).not.toContain('--dangerously-skip-permissions')
    }
  })

  it('does not sandbox autonomous task runs', () => {
    expect(antigravityRunner.buildArgs('go', { autonomous: true })).not.toContain('--sandbox')
  })
})

describe('getRunner', () => {
  it('defaults to claude and falls back for unknown names', () => {
    expect(getRunner().name).toBe('claude')
    expect(getRunner('nope' as 'claude').name).toBe('claude')
    expect(getRunner('antigravity').binary).toBe('agy')
  })

  it('applies the per-runner binary path override, empty = PATH lookup', () => {
    const settings = { claudeBinary: '/opt/claude', antigravityBinary: '' }
    expect(getRunner('claude', settings).binary).toBe('/opt/claude')
    expect(getRunner('antigravity', settings).binary).toBe('agy')
  })
})

// Token usage: field names pinned against each CLI's real result event.
describe('token usage on the result event', () => {
  it('sums claude cache tokens into the prompt count', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      usage: {
        input_tokens: 100,
        cache_creation_input_tokens: 300,
        cache_read_input_tokens: 12000,
        output_tokens: 1200
      }
    })
    expect(claudeRunner.parseLine(line)).toMatchObject({
      promptTokens: 12400,
      completionTokens: 1200
    })
  })

  it('reads agy usage (cache reads add to prompt, thinking is inside output)', () => {
    const line = JSON.stringify({
      event: 'result',
      result: {
        status: 'SUCCESS',
        usage: {
          input_tokens: 16100,
          output_tokens: 163,
          thinking_tokens: 153,
          cache_read_tokens: 300,
          total_tokens: 16263
        }
      }
    })
    expect(antigravityRunner.parseLine(line)).toMatchObject({
      promptTokens: 16400,
      completionTokens: 163
    })
  })

  it('leaves both counts unset when the CLI reports no usage', () => {
    const ev = claudeRunner.parseLine(JSON.stringify({ type: 'result', subtype: 'success' }))
    expect(ev).toMatchObject({ promptTokens: undefined, completionTokens: undefined })
  })
})

// listModels is deliberately asymmetric: claude has no `models` subcommand, agy
// does. Fixture scripts stand in for the real CLI.
describe('listModels', () => {
  const fixture = (body: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'somni-agy-')), 'agy')
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return path
  }

  it('returns the curated claude aliases without spawning anything', async () => {
    await expect(claudeRunner.listModels('claude')).resolves.toEqual(['fable', 'opus', 'sonnet'])
  })

  it('parses ids before the first tab and ignores untabbed stderr noise', async () => {
    const bin = fixture(
      'echo "Fetching available models..." >&2\n' +
        'printf "gemini-3.1-pro-high\\tGemini 3.1 Pro (High)\\nclaude-sonnet-4-6\\tClaude Sonnet 4.6\\n"'
    )
    await expect(antigravityRunner.listModels(bin)).resolves.toEqual([
      'gemini-3.1-pro-high',
      'claude-sonnet-4-6'
    ])
  })

  it('falls back to the pinned list when the CLI fails or is missing', async () => {
    const failing = await antigravityRunner.listModels(fixture('exit 1'))
    expect(failing).toContain('gemini-3.1-pro-high')
    await expect(antigravityRunner.listModels('/nope/agy')).resolves.toEqual(failing)
    // Untabbed-only output is a parse miss, not a success.
    await expect(antigravityRunner.listModels(fixture('echo hello'))).resolves.toEqual(failing)
  })

  // A hung `agy models` must not hang the app forever — confirm the 10s ceiling
  // is actually passed to execFile rather than relying on a real 10s wait.
  it('honors a 10s timeout on the agy models spawn', async () => {
    const bin = fixture('printf "gemini-3.1-pro-high\\tGemini\\n"')
    await antigravityRunner.listModels(bin)
    const spy = vi.mocked(execFile[promisify.custom])
    const call = spy.mock.calls.find((c) => c[0] === bin)
    expect(call?.[2]).toMatchObject({ timeout: 10_000 })
  })
})

// The health probe backs the missing-Runner banner: ok must track whether the
// configured binary actually executes, and the answer must be cache-free so a
// Settings fix clears the banner without an app restart.
describe('runnerStatus', () => {
  const fixture = (body: string): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'somni-runner-')), 'claude')
    writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 })
    return path
  }

  it('reports ok with the resolved binary when it runs', async () => {
    const bin = fixture('echo 1.0.0')
    await expect(runnerStatus({ claudeBinary: bin })).resolves.toEqual({ ok: true, binary: bin })
  })

  it('reports not ok when the binary is missing or failing', async () => {
    await expect(runnerStatus({ claudeBinary: '/nope/claude' })).resolves.toEqual({
      ok: false,
      binary: '/nope/claude'
    })
    const bin = fixture('exit 1')
    await expect(runnerStatus({ claudeBinary: bin })).resolves.toEqual({ ok: false, binary: bin })
  })

  it('probes fresh each call — a fixed path turns ok without restart', async () => {
    const bin = '/nope/claude'
    await expect(runnerStatus({ claudeBinary: bin })).resolves.toMatchObject({ ok: false })
    const fixed = fixture('echo 1.0.0')
    await expect(runnerStatus({ claudeBinary: fixed })).resolves.toMatchObject({ ok: true })
  })
})
