// Smoke test for the M10 reskin: every view must still render. Server-rendering
// runs the component bodies (not effects), so it catches import cycles, bad JSX
// and undefined class/token references without pulling in a DOM dependency.
// ponytail: SSR skips effects, so SettingsView/RunsView render their loading and
// empty states here, not their populated bodies — the live-app walkthrough is the
// tester's. Add a DOM environment only if that gap ever bites.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { RunDetails, RunRow } from '../../preload/index'
import App from './App'
import { DraftChatPanel } from './DraftChatPanel'
import { DraftView } from './DraftView'
import { PipelineView } from './PipelineView'
import { Playground } from './Playground'
import { RolesView } from './RolesView'
import { RunDetailsPanel, RunsView } from './RunsView'
import { SettingsView } from './SettingsView'
import { WorkflowsView } from './WorkflowsView'
import { ProposalPreview, QuestionCard } from './chatShared'

// Every somni.* call is a noop; draftKey/proposeNow are read during render.
const somni = new Proxy(
  { draftKey: '_draft', proposeNow: 'PROPOSE_NOW' } as Record<string, unknown>,
  { get: (t, k) => (k in t ? t[k as string] : () => Promise.resolve(undefined)) }
)
Object.assign(globalThis, { window: { somni } })

const roles = [{ slug: 'dev', name: 'Developer', preamble: 'You write code.' }]
const workflow = {
  slug: 'hello',
  name: 'Hello World Feature',
  selected: true,
  brief: '# Hello',
  tasks: [{ title: 'Implement greeting', prompt: 'Add hello', role: 'dev', selected: true }]
}
const run: RunRow = {
  runId: 'r1',
  workflow: 'hello',
  name: 'Hello World Feature',
  status: 'Completed',
  branch: 'somni/hello-20260826',
  worktree: '/tmp/wt',
  worktreeExists: true,
  startedAt: '2026-08-26T09:30:36.000Z',
  finishedAt: '2026-08-26T09:32:15.000Z',
  tasks: [{ title: 'Implement greeting', status: 'Completed', durationMs: 1000, costUsd: 0.04 }]
} as RunRow
const runDetails: RunDetails = {
  branchExists: true,
  stats: {
    files: [
      { path: 'src/hello.js', kind: 'A', lines: 4 },
      { path: 'package.json', kind: 'M', lines: 2 }
    ],
    created: 1,
    modified: 1,
    totalCostUsd: 0.04,
    promptTokens: 12400,
    completionTokens: 1200
  }
}
const proposal = {
  name: 'Hello',
  brief: '# Hello',
  tasks: workflow.tasks,
  roles: [{ slug: 'qa', name: 'QA', preamble: 'You test.' }]
}

const views: [string, React.JSX.Element][] = [
  ['App', <App key="a" />],
  [
    'Pipeline',
    <PipelineView
      key="p"
      workflows={[workflow]}
      runs={{ r1: run as never }}
      logs={{ r1: [{ taskIndex: 0, text: 'hi' }] }}
      busy={false}
      drain={{ status: 'Running', mode: 'manual' }}
      keepRunning={false}
      onToggleKeepRunning={() => {}}
      onStart={() => {}}
      onCancel={() => {}}
    />
  ],
  [
    'Workflows',
    <WorkflowsView
      key="w"
      repo="/repo"
      workflows={[workflow]}
      backlog={[]}
      roles={roles}
      refresh={() => {}}
      onRun={() => {}}
      runningSlugs={[]}
    />
  ],
  ['Runs', <RunsView key="r" repo="/repo" />],
  [
    'RunDetailsPanel',
    <RunDetailsPanel
      key="rd"
      run={run}
      details={runDetails}
      report={'# Run\n\n## Summary\n\nDid the thing.\n'}
      onSwitchBranch={() => {}}
      onReveal={() => {}}
      onCleanup={() => {}}
    />
  ],
  ['Roles', <RolesView key="ro" repo="/repo" roles={roles} refresh={() => {}} />],
  ['Settings', <SettingsView key="s" />],
  ['Playground', <Playground key="pl" />],
  ['Draft', <DraftView key="d" repo="/repo" roles={roles} onApplied={() => {}} />],
  [
    'DraftChatPanel',
    <DraftChatPanel
      key="dc"
      repo="/repo"
      slug="hello"
      roles={roles}
      open
      running={false}
      onApply={() => {}}
    />
  ],
  [
    'QuestionCard',
    <QuestionCard
      key="q"
      q={{ question: 'Where?', options: ['CLI', 'API'], recommended: 'CLI' }}
      disabled={false}
      onAnswer={() => {}}
    />
  ],
  [
    'ProposalPreview',
    <ProposalPreview
      key="pp"
      proposal={proposal}
      roles={roles}
      disabled={false}
      onApply={() => {}}
      onDismiss={() => {}}
    />
  ]
]

test.each(views)('%s renders', (_name, el) => {
  expect(renderToStaticMarkup(el).length).toBeGreaterThan(0)
})

// The expanded card is the runs_reports mock: tiles, summary, per-file list.
test('RunDetailsPanel shows tiles, summary and files', () => {
  const html = renderToStaticMarkup(
    <RunDetailsPanel
      run={run}
      details={runDetails}
      report={'## Summary\n\nDid the thing.\n\n## Changes\n\nx'}
      onSwitchBranch={() => {}}
      onReveal={() => {}}
      onCleanup={() => {}}
    />
  )
  expect(html).toContain('1m 39s')
  expect(html).toContain('$0.04')
  expect(html).toContain('12.4k')
  expect(html).toContain('1.2k')
  expect(html).toContain('Did the thing.')
  expect(html).not.toContain('## Changes')
  expect(html).toContain('Files Changed (2)')
  expect(html).toContain('src/hello.js')
})

test('RunDetailsPanel falls back to em-dashes and the minimal-style hint', () => {
  const html = renderToStaticMarkup(
    <RunDetailsPanel
      run={{ ...run, worktreeExists: false }}
      details={{ stats: null, branchExists: false }}
      report={'# Run\n\n## Tasks\n'}
      onSwitchBranch={() => {}}
      onReveal={() => {}}
      onCleanup={() => {}}
    />
  )
  expect(html).toContain('report style is Minimal')
  expect(html).toContain('—')
  expect(html).toContain('Files Changed (0)')
})
