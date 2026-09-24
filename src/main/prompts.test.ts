import { describe, expect, it } from 'vitest'
import {
  FIX_PROMPT,
  groomPreamble,
  REVIEW_PROMPT,
  subtaskPrompt,
  WORK_UNIT_PROMPT
} from './prompts'

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

describe('interview discipline and work unit', () => {
  it('groomPreamble caps the interview at three questions', () => {
    const p = groomPreamble([])
    expect(p).toContain('at most THREE questions')
    expect(p).toContain('materially change')
    // the relentless quality bar stays
    expect(p).toContain('somni-question')
  })

  it('WORK_UNIT_PROMPT demands a Summary section above Assumptions', () => {
    expect(WORK_UNIT_PROMPT).toContain('## Summary')
    expect(WORK_UNIT_PROMPT.indexOf('## Summary')).toBeLessThan(
      WORK_UNIT_PROMPT.indexOf('## Assumptions')
    )
  })
})
