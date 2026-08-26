// Smoke test for the M10 reskin: every view must still render. Server-rendering
// runs the component bodies (not effects), so it catches import cycles, bad JSX
// and undefined class/token references without pulling in a DOM dependency.
// ponytail: SSR skips effects, so SettingsView/RunsView render their loading and
// empty states here, not their populated bodies — the live-app walkthrough is the
// tester's. Add a DOM environment only if that gap ever bites.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { RunRow } from '../../preload/index'
import App from './App'
import { DraftChatPanel } from './DraftChatPanel'
import { DraftView } from './DraftView'
import { PipelineView } from './PipelineView'
import { Playground } from './Playground'
import { RolesView } from './RolesView'
import { RunsView } from './RunsView'
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
