import { describe, it, expect } from 'vitest'
import { minimalReport, summarize } from './report'
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
