import { describe, expect, it } from 'vitest'
import {
  BRANCH_REVIEW_PROMPT,
  capDiff,
  DIFF_CAP,
  implementerOf,
  parseReview,
  pickReviewer
} from './branchReview'
import { markRateLimited, resetProviders } from './providers'
import { beforeEach } from 'vitest'

beforeEach(() => resetProviders())

describe('parseReview', () => {
  it('parses a valid fence, last block wins', () => {
    const text =
      'thinking…\n```somni-review\n{"grade":"reject","reasons":["a"],"findings":[]}\n```\n' +
      'wait\n```somni-review\n{"grade":"approve","reasons":["solid"],"findings":[]}\n```'
    expect(parseReview(text)).toEqual({ grade: 'approve', reasons: ['solid'], findings: [] })
  })
  it('malformed or missing fence grades needs-work with a parse note', () => {
    for (const bad of [
      'no fence at all',
      '```somni-review\nnot json\n```',
      '```somni-review\n{"grade":"maybe"}\n```'
    ]) {
      const r = parseReview(bad)
      expect(r.grade).toBe('needs-work')
      expect(r.findings.join(' ')).toMatch(/parse|verdict/i)
    }
  })
  it('tolerates missing arrays', () => {
    const r = parseReview('```somni-review\n{"grade":"approve"}\n```')
    expect(r).toEqual({ grade: 'approve', reasons: [], findings: [] })
  })
})

describe('implementerOf', () => {
  it('majority wins, tie goes to first seen, undefined ignored', () => {
    expect(implementerOf(['claude', 'codex', 'codex'])).toBe('codex')
    expect(implementerOf(['claude', 'codex'])).toBe('claude')
    expect(implementerOf([undefined, 'gemini'])).toBe('gemini')
  })
})

describe('pickReviewer', () => {
  it('picks the first available chain provider different from the implementer', () => {
    expect(pickReviewer({}, 'claude')).toEqual({ runner: 'codex', sameProvider: false })
  })
  it('skips unavailable providers', () => {
    markRateLimited('codex')
    expect(pickReviewer({}, 'claude').runner).not.toBe('codex')
  })
  it('falls back to the implementer when nobody else is available', () => {
    const only = { providers: { disabled: ['codex', 'gemini', 'antigravity'] as const } }
    expect(pickReviewer(only as never, 'claude')).toEqual({ runner: 'claude', sameProvider: true })
  })
  it('a reviewer profile pin wins outright', () => {
    expect(
      pickReviewer({ reviewer: { runner: 'gemini', model: 'g', effort: 'low' } }, 'gemini')
    ).toEqual({ runner: 'gemini', model: 'g', effort: 'low', sameProvider: true })
  })
})

describe('capDiff', () => {
  it('keeps whole-file hunks under the cap and flags truncation', () => {
    const small = { file: 'a.ts', diff: 'x'.repeat(100) }
    const huge = { file: 'b.ts', diff: 'y'.repeat(DIFF_CAP) }
    const r = capDiff('2 files changed', [small, huge])
    expect(r.truncated).toBe(true)
    expect(r.body).toContain('x'.repeat(100))
    expect(r.body).not.toContain('yyyy')
    expect(r.body).toContain('b.ts') // the file list still names what was dropped
    const ok = capDiff('1 file changed', [small])
    expect(ok.truncated).toBe(false)
  })
})

describe('BRANCH_REVIEW_PROMPT', () => {
  it('carries spec, subtask prompts, diff, and the fence contract', () => {
    const p = BRANCH_REVIEW_PROMPT('the spec', ['task one'], 'the diff')
    for (const s of ['the spec', 'task one', 'the diff', 'somni-review', '"approve"'])
      expect(p).toContain(s)
    expect(p).toMatch(/do not.*(run|execute|modify)|no tools/i)
  })
})
