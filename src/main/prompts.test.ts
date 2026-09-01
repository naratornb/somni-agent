import { describe, expect, it } from 'vitest'
import { FIX_PROMPT, groomPreamble, REVIEW_PROMPT, subtaskPrompt } from './prompts'

describe('subtaskPrompt', () => {
  it('keeps the role preamble optional and the order stable', () => {
    const p = subtaskPrompt('.somni/items/SOM-1-x.md', 'You are dev.', 'do it')
    expect(p).toContain('.somni/items/SOM-1-x.md')
    expect(p.indexOf('You are dev.')).toBeLessThan(p.indexOf('do it'))
    // no role → no empty section between the separators
    expect(subtaskPrompt('spec.md', undefined, 'do it')).not.toContain('---\n\n\n\n---')
  })
})

describe('methodology variants', () => {
  it("review and fix prompts name each methodology's skills, fences invariant", () => {
    expect(REVIEW_PROMPT('abc', 'pocock')).toContain('`code-review` skill')
    expect(REVIEW_PROMPT('abc', 'superpowers')).toContain('`requesting-code-review` skill')
    expect(FIX_PROMPT('f', 'superpowers')).toContain('systematic-debugging')
    expect(FIX_PROMPT('f', 'pocock')).not.toContain('systematic-debugging')
    for (const m of ['pocock', 'superpowers'] as const)
      expect(REVIEW_PROMPT('abc', m)).toContain('somni-verdict')
  })

  it('groomPreamble swaps only the charter; the proposal protocol is invariant', () => {
    for (const m of ['pocock', 'superpowers'] as const) {
      const p = groomPreamble(['dev'], undefined, m)
      expect(p).toContain('somni-question')
      expect(p).toContain('somni-groomed')
      expect(p).toContain('ZERO-BASED INDEX')
    }
  })
})
