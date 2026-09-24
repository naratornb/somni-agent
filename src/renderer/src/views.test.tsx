// Smoke test for the M10 reskin: every view must still render. Server-rendering
// runs the component bodies (not effects), so it catches import cycles, bad JSX
// and undefined class/token references without pulling in a DOM dependency.
// ponytail: SSR skips effects, so SettingsView/RunsView render their loading and
// empty states here, not their populated bodies — the live-app walkthrough is the
// tester's. Add a DOM environment only if that gap ever bites.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type {
  GroomState,
  Item,
  Persona,
  ProviderHealth,
  RunDetails,
  RunRow,
  Settings
} from '../../preload/index'
import App from './App'
import { GroomView, ProposalSection } from './GroomView'
import { HomeView, PersonaPickStrip, QuickStartBox } from './HomeView'
import { BoardView } from './BoardView'
import { PipelineView } from './PipelineView'
import { ProvidersSetup } from './ProvidersSetup'
import { StoryPanel } from './StoryPanel'
import { Playground } from './Playground'
import { RolesView } from './RolesView'
import { RunDetailsPanel, RunsView } from './RunsView'
import { SessionsView } from './SessionsView'
import { SettingsForm, SettingsView } from './SettingsView'
import {
  MicButton,
  ProposalPreview,
  QuestionCard,
  RefineControl,
  StreamingBubble
} from './chatShared'
import { CaptureModal, CommandPalette, QuickAdd } from './capture'
import {
  alreadyParkedForReview,
  approveRunIds,
  briefSummary,
  captureItem,
  paletteResults,
  railOrder,
  reorderBacklog,
  saveCapture,
  sessionGroups,
  shouldAutoHandoff,
  shouldSeedProposal,
  togglePersona
} from './ui'

// Every somni.* call is a noop; proposeNow is read during render.
const somni = new Proxy({ proposeNow: 'PROPOSE_NOW' } as Record<string, unknown>, {
  get: (t, k) => (k in t ? t[k as string] : () => Promise.resolve(undefined))
})
Object.assign(globalThis, { window: { somni } })

const roles = [{ slug: 'dev', name: 'Developer', preamble: 'You write code.' }]
const workflow = {
  slug: 'hello',
  name: 'Hello World Feature',
  selected: true,
  brief: '# Hello',
  tasks: [{ title: 'Implement greeting', prompt: 'Add hello', role: 'dev', selected: true }]
}
// One item per column, so the Board smoke test walks every card branch.
const items: Item[] = [
  {
    id: 'SOM-1',
    slug: 'hello',
    kind: 'story',
    status: 'backlog',
    name: 'Hello World Feature',
    spec: 'Ship a greeting.',
    created: '2026-08-26T09:00:00.000Z',
    tasks: workflow.tasks
  },
  {
    id: 'SOM-2',
    slug: 'e',
    kind: 'epic',
    status: 'grooming',
    name: 'Epic',
    spec: '',
    created: '',
    tasks: []
  },
  {
    id: 'SOM-3',
    slug: 'r',
    kind: 'story',
    status: 'ready',
    name: 'Ready one',
    spec: 's',
    created: '',
    tasks: workflow.tasks,
    blockedBy: ['SOM-9']
  },
  {
    id: 'SOM-4',
    slug: 'p',
    kind: 'story',
    status: 'in-progress',
    name: 'Running one',
    spec: 's',
    created: '',
    tasks: workflow.tasks
  },
  {
    id: 'SOM-5',
    slug: 'n',
    kind: 'story',
    status: 'needs-attention',
    name: 'Broken one',
    spec: 's',
    created: '',
    tasks: workflow.tasks
  },
  {
    id: 'SOM-6',
    slug: 'v',
    kind: 'story',
    status: 'review',
    name: 'Review one',
    spec: 's',
    created: '',
    tasks: workflow.tasks
  },
  {
    id: 'SOM-7',
    slug: 'd',
    kind: 'idea',
    status: 'done',
    name: 'Done one',
    spec: 's',
    created: '',
    tasks: []
  }
]

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
  kind: 'epic' as const,
  name: 'Hello',
  spec: '# Hello',
  stories: [
    { name: 'First slice', spec: 'a', tasks: workflow.tasks, blockedBy: [] },
    { name: 'Second slice', spec: 'b', tasks: workflow.tasks, blockedBy: [0] }
  ],
  tasks: [],
  roles: [{ slug: 'qa', name: 'QA', preamble: 'You test.' }]
}

const views: [string, React.JSX.Element][] = [
  ['App', <App key="a" />],
  [
    'Pipeline',
    <PipelineView
      key="p"
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
    'Board',
    <BoardView
      key="b"
      repo="/repo"
      items={items}
      backlog={['SOM-1']}
      roles={roles}
      runs={{ r1: run as never }}
      refresh={() => {}}
      onGroom={() => {}}
    />
  ],
  [
    'StoryPanel',
    <StoryPanel
      key="sp"
      repo="/repo"
      item={items[0]}
      items={items}
      roles={roles}
      refresh={() => {}}
      onClose={() => {}}
      onOpen={() => {}}
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
  ['Settings', <SettingsView key="s" repo="/repo" roles={roles} refresh={() => {}} />],
  ['Playground', <Playground key="pl" />],
  [
    'Groom',
    <GroomView
      key="g"
      repo="/repo"
      roles={roles}
      itemId="SOM-1"
      itemName="New groom"
      onApplied={() => {}}
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
  ],
  [
    'RefineControl',
    <RefineControl key="rc" repo="/repo" kind="task" text="Add hello" onApply={() => {}} />
  ],
  ['MicButton', <MicButton key="mb" onText={() => {}} />],
  ['StreamingBubble', <StreamingBubble key="sb" text="half a reply" />],
  [
    'CaptureModal',
    <CaptureModal key="cm" repo="/repo" onClose={() => {}} onGroom={() => {}} onSaved={() => {}} />
  ],
  [
    'CommandPalette',
    <CommandPalette
      key="cp"
      items={items}
      views={['Board', 'Groom']}
      onRun={() => {}}
      onClose={() => {}}
    />
  ]
]

test.each(views)('%s renders', (_name, el) => {
  expect(renderToStaticMarkup(el).length).toBeGreaterThan(0)
})

// M12 decisions log: first-paint disabled "…" until voice:status resolves is
// the accepted state — SSR never runs effects, so this is the only state the
// static-markup harness can ever observe for MicButton. Assert it for real
// (disabled + the "…" label), not just "rendered something".
// M25.2: a Groom re-entered mid-Turn must look alive. Before the first token
// the busy bubble says so in words; once text is streaming it carries the cursor.
test('StreamingBubble shows the thinking state empty and the cursor once text arrives', () => {
  expect(renderToStaticMarkup(<StreamingBubble text="" />)).toContain('Thinking')
  const streaming = renderToStaticMarkup(<StreamingBubble text="half a reply" />)
  expect(streaming).toContain('half a reply')
  expect(streaming).toContain('\u258c')
})

test('MicButton renders disabled with the checking placeholder before voice:status resolves', () => {
  const html = renderToStaticMarkup(<MicButton onText={() => {}} />)
  expect(html).toContain('disabled=""')
  expect(html).toContain('…')
})

// M22: no-binary must stay clickable so the install hint can surface on click —
// a disabled control with a hover-only tooltip reads as "voice is broken".
test('MicButton stays enabled in the no-binary state', () => {
  const html = renderToStaticMarkup(<MicButton onText={() => {}} initialState="no-binary" />)
  expect(html).not.toContain('disabled=""')
  expect(html).toContain('Voice')
})

// M23: the nav is exactly the four destinations (plus Playground — vitest runs
// with import.meta.env.DEV true). Groom, Pipeline, Roles left the nav, and the
// PO/Engineer toggle is gone. SSR renders the no-repo state, so the Home hero
// is what the body shows.
test('App nav lists exactly the destinations; retired entries and the mode toggle are gone', () => {
  const html = renderToStaticMarkup(<App />)
  for (const v of ['Home', 'Board', 'Sessions', 'Runs', 'Settings', 'Playground']) {
    expect(html).toContain(`>${v}</button>`)
  }
  for (const gone of ['>Groom</button>', '>Pipeline</button>', '>Roles</button>', '>Engineer<']) {
    expect(html).not.toContain(gone)
  }
  expect(html).toContain('Welcome to somni')
  expect(html).toContain('Choose repo')
})

// §1/§5 + M23: four grouped columns are the permanent furniture — each renders
// with its grouped count and, when empty, its own copy. The seven-item fixture
// (one per Status) groups as Ideas 2, Ready 1, Running 2, Done 2.
test('Board renders four grouped columns with grouped counts and empty copy', () => {
  const empty = renderToStaticMarkup(
    <BoardView
      repo="/repo"
      items={[]}
      backlog={[]}
      roles={roles}
      runs={{}}
      refresh={() => {}}
      onGroom={() => {}}
    />
  )
  for (const label of ['IDEAS', 'READY', 'IN PROGRESS', 'DONE']) expect(empty).toContain(label)
  for (const gone of ['BACKLOG', 'GROOMING', 'NEEDS ATTENTION', 'REVIEW', 'RUNNING'])
    expect(empty).not.toContain(gone)
  expect(empty).toContain('Nothing yet — New Story to get started.')
  expect(empty).toContain('Nothing shipped yet.')

  const grouped = renderToStaticMarkup(
    <BoardView
      repo="/repo"
      items={items}
      backlog={[]}
      roles={roles}
      runs={{}}
      refresh={() => {}}
      onGroom={() => {}}
    />
  )
  // One count chip per column, in nav order: Ideas, Ready, Running, Done.
  const counts = [...grouped.matchAll(/rounded-full bg-surface-variant[^>]*>(\d+)</g)].map(
    (m) => m[1]
  )
  expect(counts).toEqual(['2', '1', '2', '2'])
})

// §7: ProposalPreview must show one card per epic child Story with its
// "blocked by" chip resolved to the blocker's name (not the raw index), and
// a single-story proposal's subtasks listed directly (no story cards).
test('ProposalPreview renders epic child cards with blocked-by and a single story its subtask list', () => {
  const html = renderToStaticMarkup(
    <ProposalPreview
      proposal={proposal}
      roles={roles}
      disabled={false}
      onApply={() => {}}
      onDismiss={() => {}}
    />
  )
  expect(html).toContain('First slice')
  expect(html).toContain('Second slice')
  expect(html).toContain('blocked by First slice')

  const storyProposal = {
    kind: 'story' as const,
    name: 'Solo',
    spec: 's',
    stories: [],
    tasks: workflow.tasks,
    roles: []
  }
  const storyHtml = renderToStaticMarkup(
    <ProposalPreview
      proposal={storyProposal}
      roles={roles}
      disabled={false}
      onApply={() => {}}
      onDismiss={() => {}}
    />
  )
  for (const t of workflow.tasks) expect(storyHtml).toContain(t.title)
})

// §2: the per-column affordances, and the two cards that must not be draggable.
test('Board cards carry their column affordance and drag rules', () => {
  const html = renderToStaticMarkup(
    <BoardView
      repo="/repo"
      items={items}
      backlog={['SOM-1']}
      roles={roles}
      runs={{}}
      refresh={() => {}}
      onGroom={() => {}}
    />
  )
  expect(html).toContain('Groom →')
  expect(html).toContain('Add to pipeline')
  expect(html).toContain('Re-run')
  // Needs Attention offers both rulings (§7)
  expect(html).toContain('Re-groom')
  expect(html).toContain('Accept')
  // SOM-3 is blocked by an id that isn't done: chip shown, button disabled
  expect(html).toContain('Blocked by SOM-9')
  // in-progress and done cards are not draggable; the other five are
  expect(html.match(/draggable="true"/g)).toHaveLength(5)
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

// `disabled` also appears in the disabled:opacity-40 class, so match the tag itself.
const switchButton = (html: string): string =>
  html.match(/<button[^>]*>(?:(?!<button)[\s\S])*?Switch to Branch/)![0]

// git can't check out a branch a live worktree holds, so the action waits for
// Clean up — and says so in text, not only in the tooltip.
test('Switch to Branch is disabled with a reason while the worktree holds the branch', () => {
  const html = renderToStaticMarkup(
    <RunDetailsPanel
      run={run}
      details={runDetails}
      report={null}
      onSwitchBranch={() => {}}
      onReveal={() => {}}
      onCleanup={() => {}}
    />
  )
  expect(html).toContain('Branch is checked out in the run&#x27;s worktree — Clean up first')
  expect(switchButton(html)).toContain('disabled=""')
})

test('Switch to Branch enables once the worktree is cleaned up', () => {
  const html = renderToStaticMarkup(
    <RunDetailsPanel
      run={{ ...run, worktreeExists: false }}
      details={{ stats: null, branchExists: true }}
      report={null}
      onSwitchBranch={() => {}}
      onReveal={() => {}}
      onCleanup={() => {}}
    />
  )
  expect(html).not.toContain('Clean up first')
  expect(switchButton(html)).not.toContain('disabled=""')
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

// M15 §1: one shared helper builds the captured item — first line is the name,
// everything after it is the Spec, so nothing typed is lost.
test('captureItem splits the first line off as the name and keeps the rest as spec', () => {
  expect(captureItem('Just a title')).toEqual({
    kind: 'idea',
    status: 'backlog',
    name: 'Just a title',
    spec: ''
  })
  expect(captureItem('  Add dark mode \n\nrespect the OS setting\nand persist it\n')).toEqual({
    kind: 'idea',
    status: 'backlog',
    name: 'Add dark mode',
    spec: 'respect the OS setting\nand persist it'
  })
  // Nothing typed = nothing to save; the callers key off the empty name.
  expect(captureItem('   ').name).toBe('')
})

// §1/§8: saveCapture is the one write path CaptureModal, QuickAdd and the
// palette's "Capture as idea" all call (grep: capture.tsx add()/submit(), and
// App.tsx's runPalette) — assert its own contract directly: it forwards the
// captureItem split to item:save, and is a silent noop on an empty/whitespace
// field (no IPC call at all).
test('saveCapture forwards the name/spec split to item:save, and noops on empty text', async () => {
  const calls: unknown[] = []
  const saved = { id: 'SOM-9' } as Item
  Object.assign(globalThis, {
    window: {
      somni: { saveItem: (...args: unknown[]) => (calls.push(args), Promise.resolve(saved)) }
    }
  })
  const single = await saveCapture('/repo', 'One-liner idea')
  expect(single).toBe(saved)
  expect(calls[0]).toEqual([
    '/repo',
    { kind: 'idea', status: 'backlog', name: 'One-liner idea', spec: '' }
  ])

  const multi = await saveCapture('/repo', 'Title line\nfirst detail\nsecond detail')
  expect(calls[1]).toEqual([
    '/repo',
    { kind: 'idea', status: 'backlog', name: 'Title line', spec: 'first detail\nsecond detail' }
  ])
  expect(multi).toBe(saved)

  expect(await saveCapture('/repo', '   \n  ')).toBeNull()
  expect(calls).toHaveLength(2) // whitespace-only never reaches item:save

  // restore the SSR-wide somni proxy the rest of this file depends on
  Object.assign(globalThis, { window: { somni } })
})

// §5: commands rank ahead of item hits, and the order is deterministic.
test('paletteResults ranks commands first, then item hits by id and by title', () => {
  const r = paletteResults('hello', items, ['Board', 'Groom'])
  expect(r.map((x) => x.action)).toEqual(['capture', 'open'])
  expect(r[1]).toMatchObject({ action: 'open', id: 'SOM-1' })

  // Empty query: no capture, no item hits — just the navigable commands.
  expect(paletteResults('', items, ['Board', 'Groom']).map((x) => x.label)).toEqual([
    'Go to Board',
    'Go to Groom',
    'Run pipeline'
  ])
  // Id match, case-insensitively
  expect(paletteResults('som-3', items, []).map((x) => x.key)).toEqual(['capture', 'open:SOM-3'])
  // Title match, case-insensitively (query upper, item name mixed-case)
  expect(paletteResults('HELLO WORLD', items, []).map((x) => x.key)).toEqual([
    'capture',
    'open:SOM-1'
  ])
  expect(paletteResults('pipe', items, []).map((x) => x.action)).toEqual(['capture', 'pipeline'])
  // Navigation offers only the views it was given (PO mode filters them upstream)
  expect(paletteResults('go', items, ['Board']).some((x) => x.action === 'goto')).toBe(false)
})

// §6: an intra-Backlog drop computes the new order for backlog:set.
test('reorderBacklog moves the dragged id into the target slot', () => {
  expect(reorderBacklog(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b'])
  expect(reorderBacklog(['a', 'b', 'c'], 'a', 'c')).toEqual(['b', 'a', 'c'])
  // A target the ordering file has never seen: the dragged id trails
  expect(reorderBacklog(['a', 'b'], 'a', 'z')).toEqual(['b', 'a'])
  // The dragged id absent from the array entirely (hand-added item file):
  // it simply joins at the target's slot, same as any other insert.
  expect(reorderBacklog(['a', 'b'], 'z', 'b')).toEqual(['a', 'z', 'b'])
})

// The capture surfaces and the palette are overlays over whatever view is up.
test('CaptureModal offers both capture actions and the mic', () => {
  const html = renderToStaticMarkup(
    <CaptureModal repo="/repo" onClose={() => {}} onGroom={() => {}} onSaved={() => {}} />
  )
  expect(html).toContain('New idea')
  expect(html).toContain('Groom now →')
  expect(html).toContain('Add to Backlog')
  expect(html).toContain('<textarea')
  // MicButton, present but disabled pre-effect (same signature as its own test)
  expect(html).toContain('…')
})

test('CommandPalette lists the navigable views and the pipeline command', () => {
  const html = renderToStaticMarkup(
    <CommandPalette
      items={items}
      views={['Board', 'Pipeline']}
      onRun={() => {}}
      onClose={() => {}}
    />
  )
  expect(html).toContain('Go to Board')
  expect(html).toContain('Run pipeline')
})

// §3: capture is available from every view, and disabled with no repo.
test('header carries the add glyph, disabled until a repo is loaded', () => {
  const html = renderToStaticMarkup(<App />)
  expect(html).toContain('New idea (⌘N)')
  expect(html).toContain('>add</span>')
  expect(html).toMatch(/New idea \(⌘N\)"[^>]*disabled=""|disabled=""[^>]*New idea/)
})

// §4: the Backlog column's quick-add row is pinned above the cards.
test('Board pins the quick-add row atop the Backlog column', () => {
  const html = renderToStaticMarkup(
    <BoardView
      repo="/repo"
      items={items}
      backlog={['SOM-1']}
      roles={roles}
      runs={{}}
      refresh={() => {}}
      onGroom={() => {}}
    />
  )
  expect(html).toContain('+ Add idea…')
})

// The palette's "open item" arrives as a prop so the Board can show the panel
// without an effect (the SSR harness never runs effects).
test('Board opens the StoryPanel for openId', () => {
  const html = renderToStaticMarkup(
    <BoardView
      repo="/repo"
      items={items}
      backlog={[]}
      roles={roles}
      runs={{}}
      refresh={() => {}}
      onGroom={() => {}}
      openId="SOM-1"
      onClosePanel={() => {}}
    />
  )
  expect(html).toContain('Back to Board')
  expect(html).toContain('Hello World Feature')
})

// M23 #28: with zero runs the Drain controls render alongside the empty copy —
// the pipeline must be discoverable before the first run (this inverts the old
// early-return-a-sentence behavior).
test('PipelineView with zero runs renders Drain controls and empty copy', () => {
  const html = renderToStaticMarkup(
    <PipelineView
      runs={{}}
      logs={{}}
      busy={false}
      drain={null}
      keepRunning={false}
      onToggleKeepRunning={() => {}}
      onStart={() => {}}
      onCancel={() => {}}
    />
  )
  expect(html).toContain('Drain queue')
  expect(html).toContain('Keep Running')
  expect(html).toContain('Nothing running')
})

// M23 #30: Home shows the quick-start heading, the static fallback chips (SSR
// skips the suggestions effect — the fallback is exactly the no-signal
// contract), and its children (the activity area App passes in).
test('HomeView renders the quick-start box, fallback chips, and its children', () => {
  const html = renderToStaticMarkup(
    <HomeView repo="/repo" onStart={() => {}}>
      <p>ACTIVITY</p>
    </HomeView>
  )
  expect(html).toContain('What do you want done overnight?')
  expect(html).toContain('Clean up TODOs in the codebase')
  expect(html).toContain('ACTIVITY')
})

// M23 #32: Roles are configuration now — they render inside Settings, even
// while the settings fetch is pending (SSR shows the loading branch).
test('SettingsView with a repo renders the Roles section', () => {
  const html = renderToStaticMarkup(<SettingsView repo="/repo" roles={roles} refresh={() => {}} />)
  expect(html).toContain('Roles')
  expect(html).toContain('Developer')
})

// No DOM harness in this suite (SSR only, see the file banner) — walk a
// returned element tree by hand to find a button and invoke its onClick.
function findButton(node: unknown): { props: { onClick?: () => void } } | undefined {
  if (!node || typeof node !== 'object') return undefined
  const el = node as { type?: unknown; props?: { onClick?: () => void; children?: unknown } }
  if (el.type === 'button') return el as { props: { onClick?: () => void } }
  const children = el.props?.children
  for (const c of Array.isArray(children) ? children : [children]) {
    const found = findButton(c)
    if (found) return found
  }
  return undefined
}

// Same idea as findButton, but by aria-label — the Providers panel has four
// of everything (checkbox, ↑, ↓), so "first button" isn't enough.
function findByLabel(node: unknown, label: string): { props: Record<string, unknown> } | undefined {
  if (!node || typeof node !== 'object') return undefined
  const el = node as { props?: Record<string, unknown> }
  if (el.props?.['aria-label'] === label) return el as { props: Record<string, unknown> }
  const children = el.props?.children
  for (const c of Array.isArray(children) ? children : [children]) {
    const found = findByLabel(c, label)
    if (found) return found
  }
  return undefined
}

// M26 §3: the zero-provider guided setup. Every provider down (the App gate's
// trigger condition) is the fixture; this asserts the screen itself.
test('ProvidersSetup shows every provider install guide and re-checks on click', () => {
  const health: ProviderHealth[] = [
    { name: 'claude', ok: false, binary: 'claude' },
    { name: 'antigravity', ok: false, binary: 'agy' },
    { name: 'gemini', ok: false, binary: 'gemini' },
    { name: 'codex', ok: false, binary: 'codex' }
  ]
  const html = renderToStaticMarkup(<ProvidersSetup health={health} onRecheck={() => {}} />)
  expect(html).toContain('npm install -g @anthropic-ai/claude-code')
  expect(html).toContain('npm install -g @openai/codex')
  expect(html).toContain('npm install -g @google/gemini-cli')
  expect(html).toContain('agy login')

  let recheck = false
  const button = findButton(ProvidersSetup({ health, onRecheck: () => (recheck = true) }))
  button?.props.onClick?.()
  expect(recheck).toBe(true)
})

// Task 8: the extracted (hookless) form body — SettingsView owns the effects
// and state, SettingsForm is plain props-in/patch-out, so it's callable
// directly here the same way ProvidersSetup is above.
const baseSettings: Settings = {
  runner: 'claude',
  concurrency: 2,
  timeoutMinutes: 30,
  reportStyle: 'minimal',
  methodology: 'pocock'
}
const baseHealth: ProviderHealth[] = [
  { name: 'claude', ok: true, binary: 'claude', version: '1.2.3' },
  { name: 'antigravity', ok: false, binary: 'agy' },
  { name: 'gemini', ok: true, binary: 'gemini' },
  { name: 'codex', ok: false, binary: 'codex' }
]
function formProps(
  overrides: Partial<Parameters<typeof SettingsForm>[0]> = {}
): Parameters<typeof SettingsForm>[0] {
  return {
    s: baseSettings,
    patch: () => {},
    models: [],
    health: baseHealth,
    providerModels: {},
    onRecheck: () => {},
    ...overrides
  }
}

test('SettingsForm renders a Providers section with all four rows and the Auto runner option', () => {
  const html = renderToStaticMarkup(<>{SettingsForm(formProps())}</>)
  expect(html).toContain('Claude Code')
  expect(html).toContain('Codex')
  expect(html).toContain('Gemini CLI')
  expect(html).toContain('Antigravity')
  expect(html).toContain('Auto (failover)')
})

// M26 final review, fix 3: codex/gemini have no verified read-only lever
// (§7) — the panel says so on their rows, and only theirs.
test('SettingsForm notes codex/gemini as tasks-only, not claude', () => {
  const html = renderToStaticMarkup(<>{SettingsForm(formProps())}</>)
  const note = 'tasks only — grooming chat needs Claude Code or Antigravity'
  expect(html.split(note).length - 1).toBe(2) // codex row + gemini row, no more
})

test('SettingsForm runner select offers Auto (failover) and writes the RunnerChoice value', () => {
  let patched: Partial<Settings> | undefined
  const tree = SettingsForm(formProps({ patch: (p) => (patched = p) }))
  const select = findByLabel(tree, 'Runner')
  ;(select?.props.onChange as (e: { target: { value: string } }) => void)?.({
    target: { value: 'auto' }
  })
  expect(patched?.runner).toBe('auto')
})

test("SettingsForm's Providers row checkbox patches providers.disabled and round-trips", () => {
  let patched: Partial<Settings> | undefined
  const tree = SettingsForm(formProps({ patch: (p) => (patched = p) }))
  const checkbox = findByLabel(tree, 'Enable gemini')
  ;(checkbox?.props.onChange as (e: { target: { checked: boolean } }) => void)?.({
    target: { checked: false }
  })
  expect(patched?.providers?.disabled).toEqual(['gemini'])

  // Re-enabling from that resulting state removes it again.
  const tree2 = SettingsForm(
    formProps({
      s: { ...baseSettings, providers: { disabled: ['gemini'] } },
      patch: (p) => (patched = p)
    })
  )
  const checkbox2 = findByLabel(tree2, 'Enable gemini')
  ;(checkbox2?.props.onChange as (e: { target: { checked: boolean } }) => void)?.({
    target: { checked: true }
  })
  expect(patched?.providers?.disabled).toEqual([])
})

test("SettingsForm's Providers default model/effort inputs patch providers.defaults[name]", () => {
  let patched: Partial<Settings> | undefined
  const tree = SettingsForm(formProps({ patch: (p) => (patched = p) }))
  const model = findByLabel(tree, 'gemini default model')
  ;(model?.props.onChange as (e: { target: { value: string } }) => void)?.({
    target: { value: 'gemini-2.5-pro' }
  })
  expect(patched?.providers?.defaults?.gemini).toEqual({ model: 'gemini-2.5-pro' })

  const effort = findByLabel(tree, 'gemini default effort')
  ;(effort?.props.onChange as (e: { target: { value: string } }) => void)?.({
    target: { value: 'high' }
  })
  expect(patched?.providers?.defaults?.gemini).toEqual({ effort: 'high' })
})

test("SettingsForm's Providers cap input patches providers.caps[name]; empty or below-1 clears", () => {
  let patched: Partial<Settings> | undefined
  const tree = SettingsForm(
    formProps({
      s: { ...baseSettings, providers: { caps: { gemini: 3 } } },
      patch: (p) => (patched = p)
    })
  )
  const cap = findByLabel(tree, 'gemini cap')
  ;(cap?.props.onChange as (e: { target: { value: string } }) => void)?.({ target: { value: '5' } })
  expect(patched?.providers?.caps).toEqual({ gemini: 5 })

  // Empty clears the entry rather than writing NaN/0.
  const tree2 = SettingsForm(
    formProps({
      s: { ...baseSettings, providers: { caps: { gemini: 5 } } },
      patch: (p) => (patched = p)
    })
  )
  const cap2 = findByLabel(tree2, 'gemini cap')
  ;(cap2?.props.onChange as (e: { target: { value: string } }) => void)?.({ target: { value: '' } })
  expect(patched?.providers?.caps).toEqual({})

  // A typed 0 (or negative) also clears — acquireSlot never grants a slot
  // below 1, so a saved 0 would queue that provider's tasks forever.
  const tree3 = SettingsForm(
    formProps({
      s: { ...baseSettings, providers: { caps: { gemini: 5 } } },
      patch: (p) => (patched = p)
    })
  )
  const cap3 = findByLabel(tree3, 'gemini cap')
  ;(cap3?.props.onChange as (e: { target: { value: string } }) => void)?.({
    target: { value: '0' }
  })
  expect(patched?.providers?.caps).toEqual({})

  const tree4 = SettingsForm(
    formProps({
      s: { ...baseSettings, providers: { caps: { gemini: 5 } } },
      patch: (p) => (patched = p)
    })
  )
  const cap4 = findByLabel(tree4, 'gemini cap')
  ;(cap4?.props.onChange as (e: { target: { value: string } }) => void)?.({
    target: { value: '-3' }
  })
  expect(patched?.providers?.caps).toEqual({})
})

test("SettingsForm's Providers ↑ button on the second row patches providers.order with the swap", () => {
  let patched: Partial<Settings> | undefined
  const tree = SettingsForm(formProps({ patch: (p) => (patched = p) }))
  // Default display order is claude, codex, gemini, antigravity — codex is row 2.
  const up = findByLabel(tree, 'Move codex up')
  ;(up?.props.onClick as () => void)?.()
  expect(patched?.providers?.order).toEqual(['codex', 'claude', 'gemini', 'antigravity'])
})

test('SettingsForm gemini/codex binary inputs patch geminiBinary/codexBinary', () => {
  let patched: Partial<Settings> | undefined
  const tree = SettingsForm(formProps({ patch: (p) => (patched = p) }))
  const gemini = findByLabel(tree, 'gemini binary')
  ;(gemini?.props.onChange as (e: { target: { value: string } }) => void)?.({
    target: { value: '/usr/local/bin/gemini' }
  })
  expect(patched?.geminiBinary).toBe('/usr/local/bin/gemini')

  const codex = findByLabel(tree, 'codex binary')
  ;(codex?.props.onChange as (e: { target: { value: string } }) => void)?.({
    target: { value: '/usr/local/bin/codex' }
  })
  expect(patched?.codexBinary).toBe('/usr/local/bin/codex')
})

// M23 #31: the auto-run path's promise — the Apply button reads "Apply & run"
// when a run will start. Label plumbing is ProposalPreview's; GroomView guards
// the Epic case (Epics land in Backlog and run nothing) before passing it.
test('ProposalPreview renders a custom apply label', () => {
  const html = renderToStaticMarkup(
    <ProposalPreview
      proposal={{ ...proposal, kind: 'story' as const, stories: [], tasks: workflow.tasks }}
      roles={roles}
      applyLabel="Apply & run"
      disabled={false}
      onApply={() => {}}
      onDismiss={() => {}}
    />
  )
  expect(html).toContain('Apply &amp; run')
})

// M24: voice on the golden path. SSR renders MicButton in its 'checking' "…"
// state — presence of the control is what these assert; behavior (auto-send,
// auto-groom) is closure-over-live-state and belongs to the packaged pass.
test('HomeView renders a mic beside the quick-start box', () => {
  const html = renderToStaticMarkup(
    <HomeView repo="/repo" onStart={() => {}}>
      <p />
    </HomeView>
  )
  expect(html).toContain('material-symbols-outlined text-[16px]">mic')
})

test('QuickAdd renders its mic without requiring field focus', () => {
  const html = renderToStaticMarkup(<QuickAdd repo="/repo" refresh={() => {}} />)
  expect(html).toContain('material-symbols-outlined text-[16px]">mic')
})

// M25.3: the Sessions page. Sessions are Items with session state in
// frontmatter — the page is a pure projection of the loaded items.
const sessions: Item[] = [
  {
    id: 'SOM-10',
    slug: 'a',
    kind: 'idea',
    status: 'grooming',
    name: 'Alpha talk',
    spec: '',
    created: '2026-09-01T00:00:00.000Z',
    lastActivity: '2026-09-03T10:00:00.000Z',
    tasks: []
  },
  {
    id: 'SOM-11',
    slug: 'b',
    kind: 'story',
    status: 'grooming',
    name: 'Beta review',
    spec: '',
    created: '2026-09-02T00:00:00.000Z',
    lastActivity: '2026-09-03T12:00:00.000Z',
    groomState: 'needs-review',
    tasks: []
  },
  {
    id: 'SOM-12',
    slug: 'c',
    kind: 'story',
    status: 'ready',
    name: 'Gamma applied',
    spec: '',
    created: '2026-08-01T00:00:00.000Z',
    groomState: 'done',
    doneAt: '2026-09-02T00:00:00.000Z',
    tasks: []
  },
  {
    id: 'SOM-13',
    slug: 'd',
    kind: 'story',
    status: 'ready',
    name: 'Delta old',
    spec: '',
    created: '2026-07-01T00:00:00.000Z',
    groomState: 'archived',
    tasks: []
  }
]

test('sessionGroups groups, hides archived, sorts and filters', () => {
  const groups = sessionGroups(sessions)
  expect(groups.map((g) => g.key)).toEqual([
    'needs-review',
    'interrupted', // M25.6: its own group — it wants a Resume, not a review
    'working',
    'queued',
    'talking',
    'done'
  ])
  expect(groups[0].items.map((i) => i.id)).toEqual(['SOM-11'])
  expect(groups[2].items).toEqual([])
  expect(groups[4].items.map((i) => i.id)).toEqual(['SOM-10'])
  expect(groups[5].items.map((i) => i.id)).toEqual(['SOM-12'])
  // only grooming/stateful items are sessions — the Board fixture has one
  expect(sessionGroups(items).flatMap((g) => g.items.map((i) => i.id))).toEqual(['SOM-2'])

  const withArchived = sessionGroups(sessions, { archived: true })
  expect(withArchived.at(-1)).toMatchObject({ key: 'archived' })
  expect(withArchived.at(-1)!.items.map((i) => i.id)).toEqual(['SOM-13'])

  // default sort is last activity (falling back to created), newest first
  const all = (opts = {}): string[] =>
    sessionGroups([...sessions].reverse(), { archived: true, ...opts }).flatMap((g) =>
      g.items.map((i) => i.id)
    )
  expect(all({ sort: 'title' })).toEqual(['SOM-11', 'SOM-10', 'SOM-12', 'SOM-13'])
  expect(all({ query: 'beta' })).toEqual(['SOM-11'])
  expect(all({ query: 'som-12' })).toEqual(['SOM-12'])
  expect(all({ kind: 'idea' })).toEqual(['SOM-10'])
  expect(all({ kind: 'story' })).toEqual(['SOM-11', 'SOM-12', 'SOM-13'])
})

// Issue #41: the state filter narrows to that one group, headings and all.
test('sessionGroups filters by session state', () => {
  const only = (state: string): string[] =>
    sessionGroups(sessions, { state, archived: true }).flatMap((g) => g.items.map((i) => i.id))
  expect(sessionGroups(sessions, { state: 'done' }).map((g) => g.key)).toEqual(['done'])
  expect(only('done')).toEqual(['SOM-12'])
  expect(only('needs-review')).toEqual(['SOM-11'])
  expect(only('archived')).toEqual(['SOM-13'])
  expect(only('active')).toEqual(['SOM-10']) // no state = plain conversation
  expect(only('working')).toEqual([])
})

// Issue #43: the queue is served oldest-first, so it must read that way — the
// other groups stay newest-first worklists.
test('sessionGroups orders the queued group FIFO', () => {
  const queued = (id: string, lastActivity: string): Item => ({
    ...sessions[0],
    id,
    groomState: 'queued',
    lastActivity
  })
  const rows = sessionGroups([
    queued('SOM-3', '2026-09-03T03:00:00.000Z'),
    queued('SOM-1', '2026-09-03T01:00:00.000Z'),
    queued('SOM-2', '2026-09-03T02:00:00.000Z')
  ])
  expect(rows.find((g) => g.key === 'queued')!.items.map((i) => i.id)).toEqual([
    'SOM-1',
    'SOM-2',
    'SOM-3'
  ])
  // ...and the recency order elsewhere is untouched.
  expect(
    sessionGroups(sessions)
      .find((g) => g.key === 'talking')!
      .items.map((i) => i.id)
  ).toEqual(['SOM-10'])
})

test('SessionsView renders every group heading, its rows and the empty state', () => {
  const html = renderToStaticMarkup(
    <SessionsView repo="/repo" items={sessions} onOpen={() => {}} refresh={() => {}} />
  )
  for (const label of [
    'Needs your review',
    'Working',
    'Queued',
    'In conversation',
    'Recently done'
  ])
    expect(html).toContain(label)
  expect(html).toContain('Beta review')
  expect(html).toContain('SOM-11')
  expect(html).toContain('Needs review')
  expect(html).toContain('Nothing here.') // Working/Queued are empty for now
  expect(html).not.toContain('Delta old') // archived is behind the toggle

  const empty = renderToStaticMarkup(
    <SessionsView repo="/repo" items={[]} onOpen={() => {}} refresh={() => {}} />
  )
  expect(empty).toContain('No grooming sessions yet for this repo.')
})

// M25.6: quit parked this session — the Sessions row and the Groom state line
// both offer the Resume that picks the same conversation back up.
test('interrupted sessions get their own group and a Resume affordance', () => {
  const interrupted: Item = { ...sessions[1], id: 'SOM-14', name: 'Cut short' }
  interrupted.groomState = 'interrupted'
  const html = renderToStaticMarkup(
    <SessionsView
      repo="/repo"
      items={[...sessions, interrupted]}
      onOpen={() => {}}
      refresh={() => {}}
    />
  )
  expect(html).toContain('Interrupted')
  expect(html).toContain('Cut short')
  expect(html).toContain('Resume')

  const groom = renderToStaticMarkup(
    <GroomView
      repo="/repo"
      roles={[]}
      itemId="SOM-14"
      itemName="Cut short"
      groomState="interrupted"
      onApplied={() => {}}
    />
  )
  expect(groom).toContain('Interrupted when somni quit')
  expect(groom).toContain('Resume')
})

// M25.4: the Home rail. railOrder picks the focused session by last activity
// and ranks the rest by what they want from the user.
test('railOrder focuses the freshest session and ranks the rest', () => {
  const r = railOrder(sessions)
  expect(r.focused?.id).toBe('SOM-11') // newest activity, needs review
  expect(r.compact.map((i) => i.id)).toEqual(['SOM-10', 'SOM-12']) // archived excluded
  expect(r.overflow).toBe(0)
  expect(railOrder([]).focused).toBeUndefined()

  // needs-review/working/queued float above plain conversations, and the cap bites
  const many: Item[] = Array.from({ length: 9 }, (_, n) => ({
    ...sessions[0],
    id: `SOM-${100 + n}`,
    groomState: n === 8 ? 'working' : undefined,
    lastActivity: `2026-09-0${9 - Math.min(n, 8)}T00:00:00.000Z`
  }))
  const big = railOrder(many)
  expect(big.focused?.id).toBe('SOM-100')
  expect(big.compact).toHaveLength(6)
  expect(big.compact[0].id).toBe('SOM-108') // working outranks the chatter
  expect(big.overflow).toBe(2)
})

test('HomeView renders the session rail, capped, and omits it when empty', () => {
  const html = renderToStaticMarkup(
    <HomeView repo="/repo" items={sessions} onStart={() => {}}>
      <p>ACTIVITY</p>
    </HomeView>
  )
  expect(html).toContain('Beta review') // focused card
  expect(html).toContain('Review') // needs-review affordance
  expect(html).toContain('Alpha talk') // compact row
  expect(html).not.toContain('Delta old') // archived never reaches the rail

  const bare = renderToStaticMarkup(
    <HomeView repo="/repo" items={[]} onStart={() => {}}>
      <p>ACTIVITY</p>
    </HomeView>
  )
  expect(bare).not.toContain('Sessions')
})

// M25.5: a session handed off to a background work unit closes its composer and
// says why; the queued case names the cap.
test('GroomView renders the working and queued state lines', () => {
  const view = (groomState: 'working' | 'queued'): string =>
    renderToStaticMarkup(
      <GroomView
        repo="/repo"
        roles={roles}
        itemId="SOM-1"
        itemName="Search is slow"
        groomState={groomState}
        onApplied={() => {}}
      />
    )
  expect(view('working')).toContain('Drafting in the background')
  expect(view('queued')).toContain('Queued')
  expect(view('working')).toContain('disabled')
  // The affordance itself is always present in a plain conversation.
  expect(
    renderToStaticMarkup(
      <GroomView repo="/repo" roles={roles} itemId="SOM-1" itemName="x" onApplied={() => {}} />
    )
  ).toContain('Draft in background')
})

// ── M27: persona pick + chip, owner auto-handoff, Summary, Approve & run ────

// §1: Settings gets a Persona select, in the same patch-out idiom as every
// other SettingsForm field, defaulting to the director fallback when unset.
test('SettingsForm Persona select shows both options and patches persona', () => {
  const html = renderToStaticMarkup(<>{SettingsForm(formProps())}</>)
  expect(html).toContain('Technical Director')
  expect(html).toContain('Project Owner')

  let patched: Partial<Settings> | undefined
  const tree = SettingsForm(formProps({ patch: (p) => (patched = p) }))
  const select = findByLabel(tree, 'Persona')
  ;(select?.props.onChange as (e: { target: { value: string } }) => void)?.({
    target: { value: 'owner' }
  })
  expect(patched?.persona).toBe('owner')
})

// §2: the first-run pick strip — one question, once. It only ever asks;
// HomeView is what decides whether to show it (settings.persona === undefined).
test('PersonaPickStrip renders both cards and calls onPick with the chosen persona', () => {
  let picked: Persona | undefined
  const tree = PersonaPickStrip({ onPick: (p) => (picked = p) })
  const html = renderToStaticMarkup(<>{tree}</>)
  expect(html).toContain('Technical Director')
  expect(html).toContain('Project Owner')

  const owner = findByLabel(tree, 'Pick Project Owner')
  ;(owner?.props.onClick as () => void)?.()
  expect(picked).toBe('owner')

  const director = findByLabel(tree, 'Pick Technical Director')
  ;(director?.props.onClick as () => void)?.()
  expect(picked).toBe('director')
})

// §3: the Quick Start chip — defaults to whatever persona it's handed (HomeView
// wires that to the settings value) and toggles on click; Start forwards it.
test('QuickStartBox shows the persona it is given, toggles on click, and Start reaches onSubmit', () => {
  let toggled = false
  let submitted = false
  const tree = QuickStartBox({
    text: 'Fix the thing',
    onTextChange: () => {},
    chips: [],
    onChipPick: () => {},
    persona: 'owner',
    onPersonaToggle: () => (toggled = true),
    onSubmit: () => (submitted = true),
    onSpoken: () => {}
  })
  const html = renderToStaticMarkup(<>{tree}</>)
  expect(html).toContain('Project Owner')

  const chip = findByLabel(tree, 'Persona')
  ;(chip?.props.onClick as () => void)?.()
  expect(toggled).toBe(true)

  const start = findByLabel(tree, 'Start')
  ;(start?.props.onClick as () => void)?.()
  expect(submitted).toBe(true)
})

test('togglePersona flips between director and owner', () => {
  expect(togglePersona('director')).toBe('owner')
  expect(togglePersona('owner')).toBe('director')
})

// §4: the Groom header chip — resolved from the full item when the caller has
// one, director fallback otherwise. The flip itself goes through item:save
// (the same full-replace path StoryPanel's Save uses), reviewed at the source.
test('GroomView header chip shows the resolved persona, falling back to director', () => {
  const withOwner = renderToStaticMarkup(
    <GroomView
      repo="/repo"
      roles={roles}
      itemId="SOM-1"
      itemName="x"
      item={{ ...items[0], id: 'SOM-1', persona: 'owner' }}
      onApplied={() => {}}
    />
  )
  expect(withOwner).toContain('Project Owner')

  const fallback = renderToStaticMarkup(
    <GroomView repo="/repo" roles={roles} itemId="SOM-1" itemName="x" onApplied={() => {}} />
  )
  expect(fallback).toContain('Technical Director')
})

// Fix (M27 final review): the chip must fall through to the settings-level
// persona — not straight to the director default — for an unstamped item
// (Board/Capture never stamps persona). item?.persona still wins when both
// are present; no item and no defaultPersona keeps the director fallback.
test('GroomView header chip falls through to defaultPersona (settings) before director', () => {
  const settingsOwner = renderToStaticMarkup(
    <GroomView
      repo="/repo"
      roles={roles}
      itemId="SOM-1"
      itemName="x"
      item={{ ...items[0], id: 'SOM-1' }} // no persona stamp
      defaultPersona="owner"
      onApplied={() => {}}
    />
  )
  expect(settingsOwner).toContain('Project Owner')

  const itemStampWins = renderToStaticMarkup(
    <GroomView
      repo="/repo"
      roles={roles}
      itemId="SOM-1"
      itemName="x"
      item={{ ...items[0], id: 'SOM-1', persona: 'director' }}
      defaultPersona="owner"
      onApplied={() => {}}
    />
  )
  expect(itemStampWins).toContain('Technical Director')

  const noSettingsNoItem = renderToStaticMarkup(
    <GroomView repo="/repo" roles={roles} itemId="SOM-1" itemName="x" onApplied={() => {}} />
  )
  expect(noSettingsNoItem).toContain('Technical Director')
})

// §5: the owner mount-handoff decision, extracted pure so it's testable without
// running GroomView's load effect. A truly empty owner groom (no name pick, no
// spec) is spec §2's fallback — the user types, and chat.ts's birth routing
// takes it from there on that first send.
test('shouldAutoHandoff fires only for an idle, fresh, content-bearing owner groom', () => {
  expect(shouldAutoHandoff('director', 0, false, null, 'New groom', '')).toBe(false)
  expect(shouldAutoHandoff('owner', 0, false, null, 'New groom', '')).toBe(false) // truly empty
  expect(shouldAutoHandoff('owner', 0, false, null, 'New groom', 'Some spec')).toBe(true)
  expect(shouldAutoHandoff('owner', 0, false, null, 'Search is slow', '')).toBe(true)
  expect(shouldAutoHandoff('owner', 1, false, null, 'Search is slow', '')).toBe(false) // not fresh
  expect(shouldAutoHandoff('owner', 0, true, null, 'Search is slow', '')).toBe(false) // busy
  expect(shouldAutoHandoff('owner', 0, false, 'needs-review', 'Search is slow', '')).toBe(false)
})

// §6: the brief Summary extractor — pure text slicing, no proposal shape needed.
test('briefSummary extracts the Summary section; no section returns null', () => {
  expect(briefSummary('## Summary\n\nShips the thing.\n\n## Details\n\nMore.')).toBe(
    'Ships the thing.'
  )
  expect(briefSummary('## Details\n\nNo summary here.')).toBeNull()
  expect(briefSummary('## Summary\n\n   \n')).toBeNull() // whitespace-only section
})

const storyProposalM27 = {
  kind: 'story' as const,
  name: 'Solo',
  spec: '## Summary\n\nShip a greeting.\n\n## Details\n\nMore.',
  stories: [],
  tasks: workflow.tasks,
  roles: []
}

// §7 fix: chat.ts parks groomState 'needs-review' for ANY parsed proposal —
// live interactive turn or background work unit alike — so the gate can't be
// state==='needs-review'. It has to be provenance: fromWorkUnit, which
// GroomView sets from ev.workUnit on every live 'done' event, seeded at mount
// from whether the session was already parked (a reopened session, no live
// event this mount — ui.ts's alreadyParkedForReview). ProposalSection is the
// real boundary GroomView hands this flag to; these three cases are exactly
// what its 'done' handler computes for scenarios (a)/(b)/(c) of the fix:
//   (a) a live done, workUnit false (interactive turn) → fromWorkUnit=false
//   (b) a live done, workUnit true (background draft) → fromWorkUnit=true
//   (c) mount with groomState already 'needs-review', no live event yet →
//       fromWorkUnit seeded true by alreadyParkedForReview
// The SSR harness can't fire a live onChatEvent after mount (no DOM/act, and
// no jsdom dependency is available to add) — GroomView's actual handler body
// (`setFromWorkUnit(!!ev.workUnit)` and the `useState(alreadyParkedForReview(...))`
// seed) is reviewed by inspection, and alreadyParkedForReview's own unit test
// below pins down the seed exactly.
test('ProposalSection: (a) a live interactive-turn proposal keeps Apply/Apply & run', () => {
  const onApply = (): void => {}
  const onApproveRun = (): void => {}
  const onDismiss = (): void => {}

  const inline = ProposalSection({
    proposal: storyProposalM27,
    roles,
    fromWorkUnit: false, // ev.workUnit was falsy on this live 'done'
    applying: false,
    applyLabel: 'Apply',
    onApply,
    onApproveRun,
    onDismiss
  })
  expect(inline.props.applyLabel).toBe('Apply')
  expect(inline.props.summary).toBeNull()
  expect(inline.props.secondaryLabel).toBeUndefined()
  expect(inline.props.onApply).toBe(onApply) // never routed to approve+run

  // Quick-start autoRun: same fromWorkUnit=false, its own label unchanged.
  const autoRun = ProposalSection({
    proposal: storyProposalM27,
    roles,
    fromWorkUnit: false,
    applying: false,
    applyLabel: 'Apply & run',
    onApply,
    onApproveRun,
    onDismiss
  })
  expect(autoRun.props.applyLabel).toBe('Apply & run')
  expect(autoRun.props.onApply).toBe(onApply)
})

test('ProposalSection: (b) a live background-work-unit proposal reads Approve & run', () => {
  const onApply = (): void => {}
  const onApproveRun = (): void => {}
  const onDismiss = (): void => {}

  const nr = ProposalSection({
    proposal: storyProposalM27,
    roles,
    fromWorkUnit: true, // ev.workUnit was true on this live 'done'
    applying: false,
    applyLabel: 'Apply',
    onApply,
    onApproveRun,
    onDismiss
  })
  expect(nr.props.applyLabel).toBe('Approve & run')
  expect(nr.props.summary).toBe('Ship a greeting.')
  expect(nr.props.secondaryLabel).toBe('Apply')
  expect(nr.props.onSecondary).toBe(onApply)
  expect(nr.props.onApply).toBe(onApproveRun) // the primary click queues

  // An Epic never promises "& run" or a queueing secondary, even so.
  const epic = ProposalSection({
    proposal: { ...proposal, kind: 'epic' as const },
    roles,
    fromWorkUnit: true,
    applying: false,
    applyLabel: 'Apply',
    onApply,
    onApproveRun,
    onDismiss
  })
  expect(epic.props.applyLabel).toBe('Apply')
  expect(epic.props.secondaryLabel).toBeUndefined()
})

// (c) a reopened session: groomState was already 'needs-review' when the view
// loaded, with no live event this mount — a completed brief regardless of how
// the proposal was produced.
test('alreadyParkedForReview seeds fromWorkUnit true only when the session was already parked at mount', () => {
  expect(alreadyParkedForReview('needs-review')).toBe(true)
  expect(alreadyParkedForReview(undefined)).toBe(false)
  expect(alreadyParkedForReview('working')).toBe(false)
  expect(alreadyParkedForReview('done')).toBe(false)
})

// Fix round 2: a reopened needs-review session gets no live 'done' event, so
// GroomView seeds `proposal` from loadChat's replayed one (main/chat.ts) and
// `fromWorkUnit` from alreadyParkedForReview(groomState) — both at mount. The
// SSR harness can't mount GroomView and resolve a mocked loadChat promise (no
// DOM/act, no jsdom dependency available to add), so this wires the same two
// pure pieces together exactly as GroomView's mount effect does, proving the
// composition (not just each piece alone) produces the Approve & run surface.
test('reopened brief: a loaded proposal + already-parked groomState together produce Approve & run', () => {
  const groomStateAtMount: GroomState = 'needs-review' // what the view was handed at mount
  const loadedProposal = storyProposalM27 // stands in for loadChat's replayed proposal
  const fromWorkUnit = alreadyParkedForReview(groomStateAtMount) // GroomView's mount seed

  const section = ProposalSection({
    proposal: loadedProposal,
    roles,
    fromWorkUnit,
    applying: false,
    applyLabel: 'Apply',
    onApply: () => {},
    onApproveRun: () => {},
    onDismiss: () => {}
  })
  expect(section.props.applyLabel).toBe('Approve & run')
  expect(section.props.summary).toBe('Ship a greeting.')
  expect(section.props.secondaryLabel).toBe('Apply')
})

// Fix round 3: Dismiss clears groomState (session:reopen) while leaving the
// fence text sitting in the transcript — a fence existing is not enough, the
// session must still BE parked needs-review, or a dismissed proposal
// resurrects on reopen. GroomView's mount effect gates the proposal seed on
// exactly this function (`shouldSeedProposal(c.proposal, groomState)`); when
// it's false, `setProposal` is never called, `proposal` stays null, and
// `{proposal && <ProposalSection/>}` renders nothing — the SSR harness can't
// observe that absence any more directly than the real gate itself (same
// ceiling as the round-2 composition test above: no DOM/act, no jsdom
// dependency available to add).
test('shouldSeedProposal: a fence still in the transcript never reseeds without a parked groomState', () => {
  const loadedProposal = storyProposalM27 // stands in for the fence left in the transcript
  expect(shouldSeedProposal(loadedProposal, undefined)).toBe(false) // dismissed, then reopened
  expect(shouldSeedProposal(loadedProposal, 'needs-review')).toBe(true) // (b) still seeds
  expect(shouldSeedProposal(null, 'needs-review')).toBe(false) // no fence at all, never seeds
})

// ProposalPreview's rendering half of the same feature: the summary block
// sits above the rest of the card, and the secondary button only appears
// when both its label and handler are given.
test('ProposalPreview renders the summary above the rest, and an optional secondary button', () => {
  const html = renderToStaticMarkup(
    <ProposalPreview
      proposal={proposal}
      roles={roles}
      applyLabel="Approve & run"
      disabled={false}
      onApply={() => {}}
      onDismiss={() => {}}
      summary="Ships the thing end to end."
      secondaryLabel="Apply"
      onSecondary={() => {}}
    />
  )
  expect(html).toContain('Ships the thing end to end.')
  expect(html.indexOf('Ships the thing end to end.')).toBeLessThan(html.indexOf('Spec'))
  expect(html).toContain('Approve &amp; run')
  expect(html).toContain('>Apply<') // the secondary button

  const withoutSummary = renderToStaticMarkup(
    <ProposalPreview
      proposal={proposal}
      roles={roles}
      disabled={false}
      onApply={() => {}}
      onDismiss={() => {}}
    />
  )
  expect(withoutSummary).not.toContain('Ships the thing')
  // Only the primary Apply button — no secondary without secondaryLabel/onSecondary.
  expect(withoutSummary.match(/>Apply</g)?.length ?? 0).toBe(1)
})

// The queue list itself: root once Ready, plus every child the proposal left
// unblocked — the same Ready + no-blockers gate the pipeline enforces.
test('approveRunIds queues the root only when Ready, plus every unblocked child', () => {
  const root: Item = { ...items[0], id: 'SOM-20', status: 'ready' }
  const children: Item[] = [
    { ...items[0], id: 'SOM-21', blockedBy: [] },
    { ...items[0], id: 'SOM-22', blockedBy: ['SOM-21'] },
    { ...items[0], id: 'SOM-23' } // no blockedBy field at all
  ]
  expect(approveRunIds(root, children)).toEqual(['SOM-20', 'SOM-21', 'SOM-23'])
  expect(approveRunIds({ ...root, status: 'grooming' }, children)).toEqual(['SOM-21', 'SOM-23'])
})
