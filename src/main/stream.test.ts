import { describe, it, expect } from 'vitest'
import { feed, parseLine } from './stream'

const init = JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc-123' })
const assistant = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'text', text: 'hello' }] }
})
const result = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  total_cost_usd: 0.42,
  duration_ms: 1234,
  result: 'done'
})

describe('parseLine', () => {
  it('extracts session, text, and result events', () => {
    expect(parseLine(init)).toEqual({ kind: 'session', sessionId: 'abc-123' })
    expect(parseLine(assistant)).toEqual({ kind: 'text', text: 'hello' })
    expect(parseLine(result)).toEqual({
      kind: 'result',
      ok: true,
      costUsd: 0.42,
      durationMs: 1234,
      detail: 'done'
    })
  })

  it('flags error results as not ok', () => {
    const ev = parseLine(
      JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true })
    )
    expect(ev).toMatchObject({ kind: 'result', ok: false })
  })

  it('ignores garbage and irrelevant events', () => {
    expect(parseLine('not json')).toBeNull()
    expect(parseLine(JSON.stringify({ type: 'user' }))).toBeNull()
  })
})

describe('feed', () => {
  it('reassembles lines split across chunks', () => {
    const half = Math.floor(assistant.length / 2)
    const a = feed('', init + '\n' + assistant.slice(0, half))
    expect(a.events).toEqual([{ kind: 'session', sessionId: 'abc-123' }])
    const b = feed(a.rest, assistant.slice(half) + '\n' + result + '\n')
    expect(b.events.map((e) => e.kind)).toEqual(['text', 'result'])
    expect(b.rest).toBe('')
  })
})
