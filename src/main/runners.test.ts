import { describe, it, expect } from 'vitest'
import { antigravityRunner, claudeRunner, getRunner } from './runners'

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
