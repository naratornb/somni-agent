// Smoke test for the M10 reskin: every view must still render. Server-rendering
// runs the component bodies (not effects), so it catches import cycles, bad JSX
// and undefined class/token references without pulling in a DOM dependency.
// ponytail: SSR skips effects, so SettingsView/RunsView render their loading and
// empty states here, not their populated bodies — the live-app walkthrough is the
// tester's. Add a DOM environment only if that gap ever bites.
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, test } from 'vitest'
import type { Item, RunDetails, RunRow } from '../../preload/index'
import App from './App'
import { GroomView } from './GroomView'
import { HomeView } from './HomeView'
import { BoardView } from './BoardView'
import { PipelineView } from './PipelineView'
import { StoryPanel } from './StoryPanel'
import { Playground } from './Playground'
import { RolesView } from './RolesView'
import { RunDetailsPanel, RunsView } from './RunsView'
import { SessionsView } from './SessionsView'
import { SettingsView } from './SettingsView'
import {
  MicButton,
  ProposalPreview,
  QuestionCard,
  RefineControl,
  StreamingBubble
} from './chatShared'
import { CaptureModal, CommandPalette, QuickAdd } from './capture'
import {
  captureItem,
  paletteResults,
  railOrder,
  reorderBacklog,
  saveCapture,
  sessionGroups
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
  expect(groups.map((g) => g.key)).toEqual(['needs-review', 'working', 'queued', 'talking', 'done'])
  expect(groups[0].items.map((i) => i.id)).toEqual(['SOM-11'])
  expect(groups[1].items).toEqual([]) // working stays empty until #43
  expect(groups[3].items.map((i) => i.id)).toEqual(['SOM-10'])
  expect(groups[4].items.map((i) => i.id)).toEqual(['SOM-12'])
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
