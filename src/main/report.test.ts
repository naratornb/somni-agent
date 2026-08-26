import { describe, it, expect } from 'vitest'
import { fileChanges, minimalReport, runStats, summarize } from './report'
import type { RunState } from './executor'

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
