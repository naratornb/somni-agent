import { describe, it, expect } from 'vitest'
import { claudeRunner } from './runners'
import { feed } from './stream'

const parseLine = claudeRunner.parseLine
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

describe('feed', () => {
  it('reassembles lines split across chunks', () => {
    const half = Math.floor(assistant.length / 2)
    const a = feed('', init + '\n' + assistant.slice(0, half), parseLine)
    expect(a.events).toEqual([{ kind: 'session', sessionId: 'abc-123' }])
    const b = feed(a.rest, assistant.slice(half) + '\n' + result + '\n', parseLine)
    expect(b.events.map((e) => e.kind)).toEqual(['text', 'result'])
    expect(b.rest).toBe('')
  })
})
