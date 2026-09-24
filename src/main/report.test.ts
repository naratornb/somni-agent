import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it, vi } from 'vitest'
import type { RunState } from './executor'
import type { TurnRequest } from './turn'

// M26 final review (fix 2): the compact-summary turn must resolve a
// read-only-capable runner (readOnlyRunner, chat.ts) rather than handing a
// pinned non-read-only provider — gemini has no readOnly branch at all — an
// unrestricted run of the user's repo. `turn` is mocked so the assertion is
// on the request it receives, not on a real CLI round trip.
const turnCalls: TurnRequest[] = []
vi.mock('./turn', () => ({
  turn: (req: TurnRequest) => {
    turnCalls.push(req)
    return Promise.resolve({ ok: true, text: 'summary', exitCode: 0, usage: { durationMs: 0 } })
  }
}))

const { fileChanges, minimalReport, reviewSection, runStats, summarize, writeReport } =
  await import('./report')

describe('minimal report stats', () => {
  it('counts created/modified and spots test files', () => {
    const stats = summarize(
      'A\tsrc/a.ts\nM\tsrc/b.ts\nA\tsrc/b.test.ts\nR100\told.ts\tsrc/spec/c.ts',
      ' 4 files changed, 10 insertions(+)'
    )
    expect(stats).toEqual({
      diffStat: '4 files changed, 10 insertions(+)',
      created: 2,
      modified: 2,
      testFiles: ['src/b.test.ts', 'src/spec/c.ts']
    })
  })

  it('renders per-task rows and totals', () => {
    const state = {
      runId: 'r1',
      workflow: 'w',
      name: 'Nightly',
      branch: 'somni/w-1',
      worktree: '/tmp/wt',
      status: 'Failed',
      startedAt: '2026-01-01T00:00:00.000Z',
      tasks: [
        {
          title: 'Build',
          role: 'dev',
          status: 'Completed',
          durationMs: 2000,
          costUsd: 0.5,
          log: ''
        },
        { title: 'Test', role: 'dev', status: 'Failed', durationMs: 1000, error: 'boom', log: '' }
      ]
    } as RunState
    const md = minimalReport(state, summarize('A\tx.ts', '1 file changed'))
    expect(md).toContain('| Build | Completed | 2s | $0.5000 |')
    expect(md).toContain('boom')
    expect(md).toContain('| **Total** | | 3s | $0.5000 | |')
    expect(md).toContain('1 file changed')
  })
})

describe('structured run stats', () => {
  it('joins numstat line counts with name-status kinds', () => {
    const files = fileChanges(
      'A\tsrc/hello.js\nM\tpackage.json\nD\told.js\nR100\ta.ts\tb.ts',
      '4\t0\tsrc/hello.js\n1\t1\tpackage.json\n0\t9\told.js\n2\t0\ta.ts\tb.ts\n-\t-\timg.png'
    )
    expect(files).toEqual([
      { path: 'src/hello.js', kind: 'A', lines: 4 },
      { path: 'package.json', kind: 'M', lines: 2 },
      { path: 'old.js', kind: 'D', lines: 9 },
      { path: 'b.ts', kind: 'M', lines: 2 },
      { path: 'img.png', kind: 'M', lines: 0 }
    ])
  })

  it('totals cost and tokens across tasks, leaving unreported fields unset', () => {
    const state = {
      tasks: [
        { costUsd: 0.03, promptTokens: 12000, completionTokens: 1000 },
        { promptTokens: 400, completionTokens: 200 }
      ]
    } as RunState
    expect(runStats(state, [{ path: 'a.ts', kind: 'A', lines: 1 }])).toEqual({
      files: [{ path: 'a.ts', kind: 'A', lines: 1 }],
      created: 1,
      modified: 0,
      totalCostUsd: 0.03,
      promptTokens: 12400,
      completionTokens: 1200
    })
    expect(runStats({ tasks: [{}] } as RunState, []).totalCostUsd).toBeUndefined()
  })
})

describe('review section (M16)', () => {
  it('renders nothing when the story never reached the review loop', () => {
    expect(reviewSection({ tasks: [] } as unknown as RunState)).toEqual([])
  })

  it('carries the "agent said so" caveat when green came from the verdict alone', () => {
    const state = {
      reviews: [{ cycle: 1, verdict: 'green', findings: '', green: true }]
    } as RunState
    const md = reviewSection(state).join('\n')
    expect(md).toContain('### Cycle 1 — green')
    expect(md).toContain('- Agent verdict: green')
    expect(md).toContain('checkCommand: not configured — green means the agent said so')
  })

  it('shows the checkCommand result instead of the caveat when one ran', () => {
    const state = {
      reviews: [
        {
          cycle: 1,
          verdict: 'red',
          findings: 'checkCommand `npm test` failed:\nboom',
          check: { command: 'npm test', ok: false, output: 'boom' },
          green: false
        }
      ]
    } as RunState
    const md = reviewSection(state).join('\n')
    expect(md).toContain('### Cycle 1 — red')
    expect(md).toContain('checkCommand `npm test`: FAILED')
    expect(md).not.toContain('the agent said so')
    expect(md).toContain('boom')
  })

  it('is included in the rendered minimal report', () => {
    const state = {
      runId: 'r1',
      workflow: 'w',
      name: 'Nightly',
      branch: 'somni/w-1',
      worktree: '/tmp/wt',
      status: 'Completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      tasks: [{ title: 'Review', role: '', aux: true, status: 'Completed', log: '' }],
      reviews: [{ cycle: 1, verdict: 'green', findings: '', green: true }]
    } as RunState
    const md = minimalReport(state, summarize('', ''))
    expect(md).toContain('## Review')
    expect(md).toContain('green means the agent said so')
  })
})

// M28 §4: the merge grade renders at the top of every report style, since
// minimalReport is the shared base compact/full both build on.
describe('merge review grade line', () => {
  const base = {
    runId: 'r1',
    workflow: 'w',
    name: 'Nightly',
    branch: 'somni/w-1',
    worktree: '/tmp/wt',
    status: 'Completed',
    startedAt: '2026-01-01T00:00:00.000Z',
    tasks: []
  }

  it('renders grade + reasons before everything else', () => {
    const state = {
      ...base,
      review: {
        grade: 'approve',
        reasons: ['solid', 'tested'],
        findings: [],
        provider: 'codex'
      }
    } as RunState
    const md = minimalReport(state, summarize('', ''))
    expect(md.startsWith('**Merge review: APPROVE** (codex) — solid, tested')).toBe(true)
    expect(md.indexOf('Merge review')).toBeLessThan(md.indexOf('## Tasks'))
  })

  it('renders ungraded with its reason', () => {
    const state = {
      ...base,
      review: {
        grade: 'ungraded',
        reasons: ['the branch review turn produced no reply'],
        findings: [],
        provider: 'claude'
      }
    } as RunState
    const md = minimalReport(state, summarize('', ''))
    expect(md).toContain('**Merge review: UNGRADED** (claude) — the branch review turn produced no reply')
  })

  it('adds the sameProvider/diffTruncated/fixRound notes when set', () => {
    const state = {
      ...base,
      review: {
        grade: 'needs-work',
        reasons: ['flaky test'],
        findings: ['fix the flake'],
        provider: 'claude',
        sameProvider: true,
        diffTruncated: true,
        fixRound: true
      }
    } as RunState
    const md = minimalReport(state, summarize('', ''))
    expect(md).toContain('(same provider, diff truncated, fix round)')
  })

  it('omits the grade line entirely when there is no review', () => {
    const md = minimalReport(base as RunState, summarize('', ''))
    expect(md).not.toContain('Merge review')
  })
})

describe('writeReport compact style — read-only routing (M26 final review, fix 2)', () => {
  const noEvents = { onState: (): void => {}, onLog: (): void => {} }
  const ctrl = { cancelled: false, ac: new AbortController() }

  it('routes a pinned non-read-only runner through readOnlyRunner instead of settings.runner', async () => {
    turnCalls.length = 0
    const repo = mkdtempSync(join(tmpdir(), 'somni-report-'))
    const state = {
      runId: 'r1',
      workflow: 'w',
      name: 'Nightly',
      branch: 'somni/w-1',
      worktree: join(repo, 'missing-worktree'), // collectStats degrades gracefully (not a git repo)
      status: 'Completed',
      startedAt: '2026-01-01T00:00:00.000Z',
      tasks: []
    } as RunState
    // gemini has no readOnly branch in its buildArgs at all (runners.ts) —
    // pinning it must not reach turn() unweakened.
    await writeReport(
      repo,
      state,
      { runner: 'gemini', reportStyle: 'compact' },
      ctrl,
      noEvents,
      () => Date.now()
    )
    expect(turnCalls).toHaveLength(1)
    expect(turnCalls[0].runner).toBe('claude') // chain's first read-only-capable member, not 'gemini'
  })
})
