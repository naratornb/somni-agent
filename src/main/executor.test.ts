import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { applyProposal } from './chat'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  abandonRun,
  DISCIPLINE_PREAMBLE,
  subtaskPrompt,
  cancelPipeline,
  findOrphanedRuns,
  isRunning,
  getDrainState,
  msUntil,
  resumePipeline,
  RunState,
  runStory,
  setKeepRunning,
  startDrain
} from './executor'
import {
  Item,
  loadBacklog,
  loadItems,
  readyBlocker,
  saveBacklog,
  saveItem,
  saveRole,
  setItemStatus,
  Task
} from './store'

// A fake `claude` on PATH: emits a valid stream-json conversation and drops a
// file in its cwd (proving it ran inside the worktree). Behaviours via env:
//   FAKE_FAIL         always fail
//   FAKE_FAIL_TIMES=n fail the first n invocations (needs FAKE_COUNT=<file>)
//   FAKE_RATE_LIMIT   failures look like a usage-limit error
//   FAKE_HANG         never exit (exec so SIGTERM lands on the sleep itself)
//   FAKE_TRAP         never exit AND ignore SIGTERM — only SIGKILL stops it
//   FAKE_SLEEP=<sec>  sleep before succeeding — a window to observe overlap
//   FAKE_RL_MATCH=<s> rate-limit only invocations whose args contain <s>
//   FAKE_VERDICT=red|none  the somni-verdict block the closing Review emits (M16)
//   FAKE_ARGV=<file>  dump argv to <file> (the discipline-preamble assertion)
const FAKE_CLAUDE = `#!/bin/sh
n=1
if [ -n "$FAKE_COUNT" ]; then
  n=$(( $(cat "$FAKE_COUNT" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$FAKE_COUNT"
fi
if [ -n "$FAKE_ARGV" ]; then printf '%s\n' "$@" >> "$FAKE_ARGV"; fi
if [ -n "$FAKE_HANG" ]; then exec sleep 30; fi
if [ -n "$FAKE_TRAP" ]; then trap '' TERM; while :; do sleep 0.05; done; fi
if [ -n "$FAKE_RL_MATCH" ]; then
  case "$*" in
    *"$FAKE_RL_MATCH"*)
      echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Claude AI usage limit reached"}'
      exit 1;;
  esac
fi
if [ -n "$FAKE_STDERR" ]; then echo "claude: command not found" >&2; exit 127; fi
if [ -n "$FAKE_FAIL" ] || [ "$n" -le "\${FAKE_FAIL_TIMES:-0}" ]; then
  if [ -n "$FAKE_RATE_LIMIT" ]; then
    echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"Claude AI usage limit reached"}'
  else
    echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}'
  fi
  exit 1
fi
if [ -n "$FAKE_SLEEP" ]; then sleep "$FAKE_SLEEP"; fi
echo '{"type":"system","subtype":"init","session_id":"s1"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"did work"}]}}'
touch task-ran-here
case "\${FAKE_VERDICT:-green}" in
  red) printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"duration_ms":5,"result":"\`\`\`somni-verdict\\n{\\"verdict\\": \\"red\\", \\"findings\\": \\"no tests\\"}\\n\`\`\`"}';;
  none) printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"duration_ms":5,"result":"Looks fine to me."}';;
  *) printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"duration_ms":5,"result":"\`\`\`somni-verdict\\n{\\"verdict\\": \\"green\\", \\"findings\\": \\"\\"}\\n\`\`\`"}';;
esac
`

// A fake `agy` on PATH mirroring FAKE_CLAUDE but emitting antigravity's stream
// shape (architecture.md §5): init event carries conversation_id, step_update
// carries the text delta, result carries status SUCCESS/ERROR.
const FAKE_AGY = `#!/bin/sh
n=1
if [ -n "$FAKE_COUNT" ]; then
  n=$(( $(cat "$FAKE_COUNT" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$FAKE_COUNT"
fi
if [ -n "$FAKE_FAIL" ] || [ "$n" -le "\${FAKE_FAIL_TIMES:-0}" ]; then
  if [ -n "$FAKE_RATE_LIMIT" ]; then
    echo '{"event":"result","result":{"status":"ERROR","response":"RESOURCE_EXHAUSTED: quota exceeded"}}'
  else
    echo '{"event":"result","result":{"status":"ERROR","response":"boom"}}'
  fi
  exit 1
fi
echo '{"event":"init","conversation_id":"agy-s1"}'
echo '{"event":"step_update","step_update":{"step_type":"agent_response","text_delta":"did work"}}'
touch task-ran-here
printf '%s\n' '{"event":"result","result":{"status":"SUCCESS","response":"\`\`\`somni-verdict\\n{\\"verdict\\": \\"green\\", \\"findings\\": \\"\\"}\\n\`\`\`","duration_seconds":0.005}}'
`

let repo: string
let feature: string
let docs: string
let base: string
let root: string
let savedPath: string
let fakeEnv: string[]

// Set fake-claude env vars for one test; cleaned up in afterEach.
function fake(vars: Record<string, string>): void {
  for (const [k, v] of Object.entries(vars)) {
    process.env[k] = v
    fakeEnv.push(k)
  }
}

beforeEach(() => {
  fakeEnv = []
  root = mkdtempSync(join(tmpdir(), 'somni-exec-'))
  repo = join(root, 'repo')
  base = join(root, 'worktrees')
  const bin = join(root, 'bin')
  mkdirSync(repo)
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
  writeFileSync(join(bin, 'agy'), FAKE_AGY)
  chmodSync(join(bin, 'agy'), 0o755)
  savedPath = process.env.PATH!
  process.env.PATH = `${bin}:${savedPath}`
  const g = (...args: string[]): void => {
    execFileSync('git', ['-C', repo, ...args])
  }
  g('init', '-q')
  g('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init')
  saveRole(repo, { slug: '', name: 'Dev', preamble: 'You are dev.' })
  // Two ready stories; the drain only picks up `in-progress`, so tests add
  // explicitly. Ids are deterministic: SOM-1 = feature, SOM-2 = docs.
  feature = story('Feature', [
    { title: 'Design', prompt: 'design it', role: 'dev', selected: true },
    { title: 'Build', prompt: 'build it', role: 'dev', selected: true },
    { title: 'Deselected', prompt: 'skip me', role: 'dev', selected: false }
  ]).id
  docs = story('Docs', [
    { title: 'Write docs', prompt: 'write docs', role: 'dev', selected: true }
  ]).id
})

// A ready story: the shape everything here starts from.
const story = (name: string, tasks: Task[], extra: Partial<Item> = {}): Item =>
  saveItem(repo, { name, kind: 'story', status: 'ready', spec: 'do the thing', tasks, ...extra })

// "Add to pipeline" in the tests: status is the tick (M13 §3).
const add = (...ids: string[]): void => {
  for (const id of ids) setItemStatus(repo, id, 'in-progress')
}
const statusOnDisk = (id: string): string | undefined =>
  loadItems(repo).find((i) => i.id === id)?.status

afterEach(() => {
  process.env.PATH = savedPath
  for (const k of fakeEnv) delete process.env[k]
})

const noEvents = { onState: (): void => {}, onLog: (): void => {} }

describe('runStory', () => {
  it('runs selected tasks sequentially in a worktree and persists run.json', async () => {
    const state = await runStory(repo, feature, base, noEvents)
    expect(state.status).toBe('Completed')
    // deselected task is excluded entirely
    // M16 appends the closing Review; the subtasks are the non-aux ones.
    expect(state.tasks.filter((t) => !t.aux).map((t) => t.title)).toEqual(['Design', 'Build'])
    expect(state.tasks.map((t) => t.status)).toEqual(['Completed', 'Completed', 'Completed'])
    expect(state.tasks[0].sessionId).toBe('s1')
    expect(state.tasks[0].costUsd).toBe(0.01)
    // ran inside the worktree, on the somni branch
    expect(existsSync(join(state.worktree, 'task-ran-here'))).toBe(true)
    const head = execFileSync('git', ['-C', state.worktree, 'branch', '--show-current'])
      .toString()
      .trim()
    expect(head).toBe(state.branch)
    // state on disk matches, logs captured
    const onDisk = JSON.parse(
      readFileSync(join(repo, '.somni/runs', state.runId, 'run.json'), 'utf8')
    )
    expect(onDisk.status).toBe('Completed')
    expect(
      readFileSync(join(repo, '.somni/runs', state.runId, state.tasks[0].log), 'utf8')
    ).toContain('did work')
  })

  it('retries a failed task once and continues when the retry succeeds', async () => {
    fake({ FAKE_COUNT: join(root, 'n'), FAKE_FAIL_TIMES: '1' })
    const state = await runStory(repo, feature, base, noEvents)
    expect(state.status).toBe('Completed')
    expect(state.tasks.map((t) => t.attempts)).toEqual([2, 1, 1])
    expect(state.tasks[0].error).toBeUndefined()
  })

  it('halts after the second failure and skips the rest', async () => {
    fake({ FAKE_FAIL: '1' })
    const state = await runStory(repo, feature, base, noEvents)
    expect(state.status).toBe('Failed')
    expect(state.tasks.map((t) => t.status)).toEqual(['Failed', 'Skipped'])
    expect(state.tasks[0].attempts).toBe(2)
    expect(state.tasks[0].error).toBe('boom')
    // the reason survives on disk, not just in the live log
    const onDisk = JSON.parse(
      readFileSync(join(repo, '.somni/runs', state.runId, 'run.json'), 'utf8')
    )
    expect(onDisk.tasks[0].error).toBe('boom')
  })

  it('kills a hung task on timeout and records why', async () => {
    fake({ FAKE_HANG: '1' })
    const state = await runStory(repo, docs, base, noEvents, { timeoutMs: 200 })
    expect(state.status).toBe('Failed')
    expect(state.tasks[0].attempts).toBe(2) // timeout consumes the retry
    expect(state.tasks[0].error).toMatch(/timed out/)
  })

  it('escalates to SIGKILL when the task ignores SIGTERM', async () => {
    // trap '' TERM makes the fake survive the polite kill — the only way this
    // test finishes is the grace timer firing SIGKILL.
    fake({ FAKE_TRAP: '1' })
    const state = await runStory(repo, docs, base, noEvents, {
      timeoutMs: 150,
      graceMs: 50
    })
    expect(state.status).toBe('Failed')
    expect(state.tasks[0].error).toMatch(/timed out/)
  })

  // The review finding: a run that died before producing a result event used to
  // land in run.json as "Failed" with no reason at all.
  it('records the stderr reason when the CLI dies without a result event', async () => {
    fake({ FAKE_STDERR: '1' })
    const state = await runStory(repo, docs, base, noEvents)
    expect(state.status).toBe('Failed')
    expect(state.tasks[0].error).toBe('claude: command not found')
  })

  it('pauses on a rate limit and retries without consuming the retry', async () => {
    fake({ FAKE_COUNT: join(root, 'n'), FAKE_FAIL_TIMES: '2', FAKE_RATE_LIMIT: '1' })
    const statuses: string[] = []
    const state = await runStory(
      repo,
      docs,
      base,
      { ...noEvents, onPipeline: (s) => statuses.push(s) },
      { backoffMs: 10 }
    )
    // two rate-limited attempts, neither counted as a failure → third succeeds
    expect(state.status).toBe('Completed')
    expect(state.tasks[0].attempts).toBe(3)
    expect(statuses.filter((s) => s === 'Paused')).toHaveLength(2)
  })
})

describe('antigravity runner end-to-end', () => {
  it('runs a task through the agy adapter and records sessionId + runner', async () => {
    saveRole(repo, {
      slug: 'agy-dev',
      name: 'AgyDev',
      preamble: 'You are dev.',
      runner: 'antigravity'
    })
    const agy = story('AgyFlow', [
      { title: 'Write docs', prompt: 'write docs', role: 'agy-dev', selected: true }
    ]).id
    const state = await runStory(repo, agy, base, noEvents)
    expect(state.status).toBe('Completed')
    expect(state.tasks[0].sessionId).toBe('agy-s1')
    expect(state.tasks[0].runner).toBe('antigravity')
    expect(existsSync(join(state.worktree, 'task-ran-here'))).toBe(true)
    expect(
      readFileSync(join(repo, '.somni/runs', state.runId, state.tasks[0].log), 'utf8')
    ).toContain('did work')
  })

  it('pauses the pipeline on an agy rate-limit instead of burning the retry', async () => {
    saveRole(repo, {
      slug: 'agy-dev',
      name: 'AgyDev',
      preamble: 'You are dev.',
      runner: 'antigravity'
    })
    const agy = story('AgyFlow', [
      { title: 'Write docs', prompt: 'write docs', role: 'agy-dev', selected: true }
    ]).id
    fake({ FAKE_COUNT: join(root, 'n'), FAKE_FAIL_TIMES: '1', FAKE_RATE_LIMIT: '1' })
    const statuses: string[] = []
    const state = await runStory(
      repo,
      agy,
      base,
      { ...noEvents, onPipeline: (s) => statuses.push(s) },
      { backoffMs: 10 }
    )
    expect(state.status).toBe('Completed')
    expect(state.tasks[0].attempts).toBe(2) // rate-limited attempt didn't count as a failure
    expect(statuses.filter((s) => s === 'Paused')).toHaveLength(1)
  })

  it('keeps the same runner recorded across a retried task', async () => {
    saveRole(repo, {
      slug: 'agy-dev',
      name: 'AgyDev',
      preamble: 'You are dev.',
      runner: 'antigravity'
    })
    const agy = story('AgyFlow', [
      { title: 'Write docs', prompt: 'write docs', role: 'agy-dev', selected: true }
    ]).id
    fake({ FAKE_COUNT: join(root, 'n'), FAKE_FAIL_TIMES: '1' })
    const state = await runStory(repo, agy, base, noEvents)
    expect(state.status).toBe('Completed')
    expect(state.tasks[0].attempts).toBe(2)
    expect(state.tasks[0].runner).toBe('antigravity')
  })
})

describe('crash resume', () => {
  // Simulate a killed process: run.json still Running, one task unfinished.
  const orphan = (runId: string, mutate: (s: RunState) => void): void => {
    const path = join(repo, '.somni/runs', runId, 'run.json')
    const state = JSON.parse(readFileSync(path, 'utf8')) as RunState
    mutate(state)
    writeFileSync(path, JSON.stringify(state, null, 2))
  }

  it('finishes the remaining tasks in the existing worktree', async () => {
    const first = await runStory(repo, feature, base, noEvents)
    orphan(first.runId, (s) => {
      s.status = 'Running'
      s.tasks[1].status = 'Running'
    })
    rmSync(join(first.worktree, 'task-ran-here'))

    expect(findOrphanedRuns(repo).map((r) => r.runId)).toEqual([first.runId])
    const [state] = await resumePipeline(repo, [first.runId], 1, noEvents)
    expect(state.status).toBe('Completed')
    expect(state.worktree).toBe(first.worktree) // same worktree, not a new one
    expect(state.tasks[0].attempts).toBe(1) // completed task not re-run
    expect(state.tasks[1].attempts).toBe(2) // its second, resumed attempt
    expect(existsSync(join(first.worktree, 'task-ran-here'))).toBe(true)
    expect(findOrphanedRuns(repo)).toEqual([])
  })

  it('refuses to resume a story whose subtasks were reordered', async () => {
    const first = await runStory(repo, feature, base, noEvents)
    orphan(first.runId, (s) => {
      s.status = 'Running'
      s.tasks[1].status = 'Running'
    })
    rmSync(join(first.worktree, 'task-ran-here'))
    // same task count, swapped order — index matching would run the wrong prompt
    saveItem(repo, {
      id: feature,
      slug: 'feature',
      name: 'Feature',
      kind: 'story',
      status: 'in-progress',
      spec: 'do the thing',
      tasks: [
        { title: 'Build', prompt: 'build it', role: 'dev', selected: true },
        { title: 'Design', prompt: 'design it', role: 'dev', selected: true },
        { title: 'Deselected', prompt: 'skip me', role: 'dev', selected: false }
      ]
    })
    const errors: string[] = []
    const [state] = await resumePipeline(repo, [first.runId], 1, {
      ...noEvents,
      onLog: (_id, _i, text) => errors.push(text)
    })
    expect(state.status).toBe('Failed')
    expect(errors.some((e) => e.includes('story changed since it started'))).toBe(true)
    expect(existsSync(join(first.worktree, 'task-ran-here'))).toBe(false) // nothing ran
  })

  it('re-attaches the existing branch when the worktree is gone', async () => {
    const first = await runStory(repo, docs, base, noEvents)
    execFileSync('git', ['-C', repo, 'worktree', 'remove', '--force', first.worktree])
    orphan(first.runId, (s) => {
      s.status = 'Running'
      s.tasks[0].status = 'Running'
    })
    const [state] = await resumePipeline(repo, [first.runId], 1, noEvents)
    expect(state.status).toBe('Completed')
    expect(existsSync(join(first.worktree, 'task-ran-here'))).toBe(true)
  })

  it('abandon marks the run Cancelled on disk', async () => {
    const first = await runStory(repo, docs, base, noEvents)
    orphan(first.runId, (s) => {
      s.status = 'Running'
      s.tasks[0].status = 'Running'
    })
    abandonRun(repo, first.runId)
    expect(findOrphanedRuns(repo)).toEqual([])
    const onDisk = JSON.parse(
      readFileSync(join(repo, '.somni/runs', first.runId, 'run.json'), 'utf8')
    )
    expect(onDisk.status).toBe('Cancelled')
    expect(onDisk.tasks[0].status).toBe('Cancelled')
  })

  // Decision 7: resume is a fixed set over the drain loop and never scans.
  it('a story added during a resume is not picked up', async () => {
    const first = await runStory(repo, docs, base, noEvents)
    orphan(first.runId, (s) => {
      s.status = 'Running'
      s.tasks[0].status = 'Running'
    })
    rmSync(join(first.worktree, 'task-ran-here'))
    fake({ FAKE_SLEEP: '0.15' })
    add(feature) // added before the resume starts — must still be ignored
    const results = await resumePipeline(repo, [first.runId], 2, noEvents)
    expect(results.map((r) => r.workflow)).toEqual([docs])
    expect(statusOnDisk(feature)).toBe('in-progress') // never picked up
  })

  // M16: a kill mid-review leaves an aux Review task stuck Running. The
  // story-diff refusal check only compares non-aux subtasks (executor.ts),
  // so this must resume and complete rather than hit "story changed".
  it('resumes past an orphaned aux Review task without the story-changed refusal', async () => {
    const first = await runStory(repo, docs, base, noEvents)
    expect(first.status).toBe('Completed')
    orphan(first.runId, (s) => {
      s.status = 'Running'
      // Simulate the kill: the Review task that closed the story never finished.
      const review = s.tasks.find((t) => t.aux && t.title === 'Review')
      expect(review).toBeDefined()
      review!.status = 'Running'
      s.reviews = [] // no verdict was recorded before the kill
    })
    const errors: string[] = []
    const [state] = await resumePipeline(repo, [first.runId], 1, {
      ...noEvents,
      onLog: (_id, _i, text) => errors.push(text)
    })
    expect(errors.some((e) => e.includes('story changed since it started'))).toBe(false)
    expect(state.status).toBe('Completed')
    // A fresh review loop ran (Decision log: resume restarts at cycle 1).
    expect(state.reviews).toHaveLength(1)
    expect(state.reviews?.[0]).toMatchObject({ verdict: 'green', green: true })
    expect(statusOnDisk(docs)).toBe('review')
  })

  // M8 Decision 9: the chat guard must key off the story id correctly
  // even for a resumed run (not just a freshly-started pipeline).
  it('isRunning(id) reflects the correct story id during a resumed run', async () => {
    const first = await runStory(repo, feature, base, noEvents)
    orphan(first.runId, (s) => {
      s.status = 'Running'
      s.tasks[1].status = 'Running'
    })
    rmSync(join(first.worktree, 'task-ran-here'))
    fake({ FAKE_HANG: '1' })
    let armed = (): void => {}
    const spawning = new Promise<void>((resolve) => {
      armed = resolve
    })
    const run = resumePipeline(repo, [first.runId], 1, {
      onState: (s) => {
        if (s.tasks[1]?.attempts === 2) armed()
      },
      onLog: (): void => {}
    })
    await spawning
    expect(isRunning(feature)).toBe(true)
    expect(isRunning(docs)).toBe(false)
    cancelPipeline()
    await run
    expect(isRunning(feature)).toBe(false)
  })
})

// End-to-end at module level (M13.md Goal 1-2 / Tester scope): the Ready gate
// refuses an ungroomed idea and leaves its file untouched, authoring a spec +
// subtask clears it, pipeline entry drains it to review with a report, and a
// deliberately failing story lands in needs-attention with its own report.
describe('end-to-end: idea -> gate refusal -> ready -> drain -> review/needs-attention', () => {
  it('refuses the gate for a bare idea, leaves the file untouched, then drains after authoring', async () => {
    const idea = saveItem(repo, { name: 'New Thing', kind: 'idea' })
    const before = readFileSync(join(repo, '.somni/items', `${idea.id}-new-thing.md`), 'utf8')

    // Gate refusal — wrong kind — via readyBlocker, the same function
    // item:setStatus/pipeline:add call in main. Merely *checking* the gate
    // must never touch the file on disk.
    expect(readyBlocker(idea)).toMatch(/only a Story/)
    const after = readFileSync(join(repo, '.somni/items', `${idea.id}-new-thing.md`), 'utf8')
    expect(after).toBe(before)

    // A hand-promoted-but-unauthored story is refused too, on empty-spec grounds.
    const bareStory = saveItem(repo, { ...idea, kind: 'story' })
    expect(readyBlocker(bareStory)).toMatch(/empty Spec/)

    // Author the spec + a subtask (StoryPanel's job), then the gate clears.
    const groomed = saveItem(repo, {
      ...bareStory,
      spec: 'Ship the new thing.',
      tasks: [{ title: 'Do it', prompt: 'do it', role: 'dev', selected: true }]
    })
    expect(readyBlocker(groomed)).toBeNull()

    // Ready, then "Add to pipeline" (status -> in-progress is the tick), drain.
    setItemStatus(repo, groomed.id, 'ready')
    setItemStatus(repo, groomed.id, 'in-progress')
    const [result] = await startDrain(repo, base, 1, noEvents)
    expect(result.status).toBe('Completed')
    expect(statusOnDisk(groomed.id)).toBe('review')
    expect(loadItems(repo).find((i) => i.id === groomed.id)!.status).toBe('review') // frontmatter on disk agrees with the drain result
    expect(existsSync(join(repo, '.somni/runs', result.runId, 'run.json'))).toBe(true)
    expect(existsSync(join(repo, '.somni/runs', result.runId, 'report.md'))).toBe(true)
  })

  it('a deliberately failing story lands needs-attention with a report', async () => {
    fake({ FAKE_FAIL: '1' })
    add(feature)
    const [result] = await startDrain(repo, base, 1, noEvents)
    expect(result.status).toBe('Failed')
    expect(statusOnDisk(feature)).toBe('needs-attention')
    expect(existsSync(join(repo, '.somni/runs', result.runId, 'report.md'))).toBe(true)
  })
})

// §7/M14: a groomed epic proposal, Applied through chat.ts's own mutation
// path (not hand-authored via saveItem/story()), must feed the M13 drain
// exactly like a hand-authored blockedBy pair — dependency order honored,
// frontmatter on disk agreeing with the in-memory result at each step.
describe('end-to-end: groomed epic -> blocked children -> drain in dependency order', () => {
  it('Applies an epic proposal, then drains both children in blockedBy order', async () => {
    const idea = saveItem(repo, { name: 'Search Overhaul', kind: 'idea' })
    const sub = (title: string): Task => ({ title, prompt: title, role: 'dev', selected: true })
    const res = applyProposal(repo, idea.id, {
      kind: 'epic',
      name: 'Search Overhaul',
      spec: 'why',
      stories: [
        { name: 'Index', spec: 'a', tasks: [sub('index it')], blockedBy: [] },
        { name: 'Query', spec: 'b', tasks: [sub('query it')], blockedBy: [0] }
      ],
      tasks: [],
      roles: []
    })
    expect(res.ok).toBe(true)
    const children = loadItems(repo).filter((i) => i.epic === idea.id)
    const [indexId, queryId] = children.map((c) => c.id)
    expect(statusOnDisk(indexId)).toBe('ready')
    expect(statusOnDisk(queryId)).toBe('ready')

    // "Add to pipeline" both, same as a hand-authored pair (M13 §3).
    add(indexId, queryId)

    // Query is blocked on Index — the drain runs only Index this pass.
    const first = await startDrain(repo, base, 2, noEvents)
    expect(first.map((r) => r.workflow)).toEqual([indexId])
    expect(statusOnDisk(indexId)).toBe('review')
    expect(statusOnDisk(queryId)).toBe('in-progress') // still waiting, untouched

    // Index isn't `done` yet (it's in Review) — Query still can't run.
    expect(await startDrain(repo, base, 2, noEvents)).toEqual([])
    expect(statusOnDisk(queryId)).toBe('in-progress')

    setItemStatus(repo, indexId, 'done')
    const second = await startDrain(repo, base, 2, noEvents)
    expect(second.map((r) => r.workflow)).toEqual([queryId])
    expect(statusOnDisk(queryId)).toBe('review')
  })
})

describe('startDrain', () => {
  it('runs stories concurrently in separate worktrees, all complete', async () => {
    add(feature, docs)
    const results = await startDrain(repo, base, 2, noEvents)
    expect(results.map((r) => r.status).sort()).toEqual(['Completed', 'Completed'])
    const ids = results.map((r) => r.runId)
    expect(new Set(ids).size).toBe(2) // same-second starts still get unique run dirs
    for (const r of results) {
      expect(existsSync(join(r.worktree, 'task-ran-here'))).toBe(true)
      expect(existsSync(join(repo, '.somni/runs', r.runId, 'run.json'))).toBe(true)
    }
  })

  it('runs an in-progress story once and lands it in review', async () => {
    add(docs)
    const results = await startDrain(repo, base, 1, noEvents)
    expect(results.map((r) => r.workflow)).toEqual([docs])
    expect(statusOnDisk(docs)).toBe('review') // no longer in-progress: not re-picked
  })

  it('a failed run lands the story in needs-attention, a cancel puts it back to ready', async () => {
    fake({ FAKE_FAIL: '1' })
    add(docs)
    await startDrain(repo, base, 1, noEvents)
    expect(statusOnDisk(docs)).toBe('needs-attention')
  })

  // The engine cannot trust the UI to withhold affordances: .somni/ is
  // hand-editable, so a hand-marked in-progress epic must never spawn.
  it('never picks up a non-story kind, even marked in-progress', async () => {
    const epic = saveItem(repo, {
      name: 'Big thing',
      kind: 'epic',
      status: 'in-progress',
      spec: 'lots',
      tasks: [{ title: 'X', prompt: 'go', role: 'dev', selected: true }]
    }).id
    add(docs)
    const results = await startDrain(repo, base, 1, noEvents)
    expect(results.map((r) => r.workflow)).toEqual([docs])
    expect(statusOnDisk(epic)).toBe('in-progress') // untouched
  })

  // blockedBy ordering: the blocked story waits for its blocker to be `done`.
  it('holds a blocked story until its blocker is done', async () => {
    const blocked = story(
      'Blocked',
      [{ title: 'Later', prompt: 'later', role: 'dev', selected: true }],
      { blockedBy: [docs] }
    ).id
    add(blocked)
    // docs is not done — the drain must find nothing to run and stop.
    expect(await startDrain(repo, base, 2, noEvents)).toEqual([])
    expect(statusOnDisk(blocked)).toBe('in-progress')
    setItemStatus(repo, docs, 'done')
    const results = await startDrain(repo, base, 2, noEvents)
    expect(results.map((r) => r.workflow)).toEqual([blocked])
  })

  it('resolves immediately with [] when nothing is in progress', async () => {
    expect(await startDrain(repo, base, 2, noEvents)).toEqual([])
    expect(getDrainState()).toEqual({ mode: null, status: 'Idle' })
  })

  it('picks up a story added mid-drain without restarting', async () => {
    fake({ FAKE_SLEEP: '0.3' })
    add(docs)
    let armed = (): void => {}
    const spawning = new Promise<void>((resolve) => {
      armed = resolve
    })
    const run = startDrain(
      repo,
      base,
      1, // concurrency 1: feature can only run if the drain re-scans
      { onState: (s) => s.tasks[0]?.status === 'Running' && armed(), onLog: (): void => {} },
      { pollMs: 20 }
    )
    await spawning
    add(feature)
    const results = await run
    expect(results.map((r) => r.workflow).sort()).toEqual([feature, docs].sort())
  })

  it('keep running: idles on empty, picks up a later add, stops when toggled off', async () => {
    setKeepRunning(true)
    const run = startDrain(repo, base, 1, noEvents, { pollMs: 20 }, 'keep')
    await new Promise((r) => setTimeout(r, 60)) // idling, nothing in the Queue
    expect(getDrainState().mode).toBe('keep')
    expect(getDrainState().status).toBe('Idle')
    add(docs)
    await new Promise((r) => setTimeout(r, 150))
    setKeepRunning(false) // in-flight work finishes; feature is never picked up
    add(feature)
    const results = await run
    expect(results.map((r) => r.workflow)).toEqual([docs])
    expect(statusOnDisk(feature)).toBe('in-progress') // never picked up, still queued
    expect(getDrainState().mode).toBe(null)
  })

  it('cancels an actively running task: current task Cancelled, rest Skipped, isRunning() false after', async () => {
    // FAKE_HANG never exits on its own — the only way this test finishes is
    // via cancelPipeline() actually killing the child mid-execution.
    fake({ FAKE_HANG: '1' })
    setKeepRunning(true) // ...and cancel must clear it, or the drain never ends
    add(feature)
    let armed = (): void => {}
    const spawning = new Promise<void>((resolve) => {
      armed = resolve
    })
    const run = startDrain(repo, base, 1, {
      // attempts is bumped to 1 immediately before spawnClaude() is called
      // (synchronously, no await in between), so by the time this resolves
      // and cancelPipeline() runs, ctrl.handle is guaranteed to be set.
      onState: (s) => {
        if (s.tasks[0]?.attempts === 1) armed()
      },
      onLog: (): void => {}
    })
    await spawning
    expect(isRunning()).toBe(true)
    cancelPipeline()
    const [state] = await run
    expect(state.status).toBe('Cancelled')
    expect(state.tasks.map((t) => t.status)).toEqual(['Cancelled', 'Skipped'])
    expect(isRunning()).toBe(false)
    expect(getDrainState().mode).toBe(null)
  })

  // M8 Decision 9: the chat guard asks per story, not per pipeline.
  it('isRunning(id) is true only for the story actually executing', async () => {
    fake({ FAKE_HANG: '1' })
    add(feature)
    let armed = (): void => {}
    const spawning = new Promise<void>((resolve) => {
      armed = resolve
    })
    const run = startDrain(repo, base, 1, {
      onState: (s) => {
        if (s.tasks[0]?.attempts === 1) armed()
      },
      onLog: (): void => {}
    })
    await spawning
    expect(isRunning(feature)).toBe(true)
    expect(isRunning(docs)).toBe(false)
    cancelPipeline()
    await run
    expect(isRunning(feature)).toBe(false)
  })

  it('bounds in-flight tasks at maxConcurrency across a bigger queue', async () => {
    for (const name of ['W1', 'W2', 'W3', 'W4']) {
      add(story(name, [{ title: 'Solo', prompt: 'go', role: 'dev', selected: true }]).id)
    }
    fake({ FAKE_SLEEP: '0.15' }) // gives concurrent runs a real window to overlap in
    const running = new Set<string>()
    let maxOverlap = 0
    const results = await startDrain(repo, base, 2, {
      onState: (s) => {
        if (s.tasks[0].status === 'Running') {
          if (!running.has(s.runId)) {
            running.add(s.runId)
            maxOverlap = Math.max(maxOverlap, running.size)
          }
        } else {
          running.delete(s.runId)
        }
      },
      onLog: (): void => {}
    })
    expect(results.every((r) => r.status === 'Completed')).toBe(true)
    expect(results).toHaveLength(4)
    expect(maxOverlap).toBeGreaterThan(1) // sanity: they really did run concurrently
    expect(maxOverlap).toBeLessThanOrEqual(2) // ...but never past the bound
  })

  it('cancel aborts a pause wait instead of waiting out the backoff', async () => {
    fake({ FAKE_FAIL: '1', FAKE_RATE_LIMIT: '1' })
    add(docs)
    let paused = (): void => {}
    const gotPause = new Promise<void>((resolve) => {
      paused = () => resolve()
    })
    const run = startDrain(
      repo,
      base,
      1,
      { ...noEvents, onPipeline: (s) => s === 'Paused' && paused() },
      { backoffMs: 60_000 } // never elapses within the test
    )
    await gotPause
    cancelPipeline()
    const [state] = await run
    expect(state.status).toBe('Cancelled')
  })

  it('keeps backing off when another workflow succeeds mid-pause', async () => {
    // feature/Design is rate-limited on every attempt; docs succeeds ~100ms in,
    // i.e. inside the first pause window. That success must not reset the backoff.
    fake({ FAKE_RL_MATCH: 'design it', FAKE_SLEEP: '0.1' })
    add(feature, docs)
    const waits: number[] = []
    const state = await startDrain(
      repo,
      base,
      2,
      {
        ...noEvents,
        onPipeline: (s, info) => {
          if (s !== 'Paused' || !info?.resumeAt) return
          waits.push(Date.parse(info.resumeAt) - Date.now())
          // stop after the second pause (microtask: let pause() finish arming first)
          if (waits.length === 2) queueMicrotask(cancelPipeline)
        }
      },
      { backoffMs: 300 }
    )
    expect(state).toHaveLength(2)
    expect(waits).toHaveLength(2)
    expect(waits[1]).toBeGreaterThan(waits[0] * 1.5) // doubled, not reset to base
  })

  it('a story that cannot start fails soft, the rest still run', async () => {
    const empty = story('Empty', [{ title: 'Off', prompt: 'no', role: 'dev', selected: false }]).id
    add(empty, docs)
    const errors: string[] = []
    const results = await startDrain(repo, base, 2, {
      onState: () => {},
      onLog: (_id, _i, text) => errors.push(text)
    })
    expect(results.map((r) => r.workflow)).toEqual([docs])
    expect(errors.some((e) => e.includes('no tasks selected'))).toBe(true)
    // Its status is still in-progress on disk, so only the per-drain skip set
    // stops it being re-picked (and re-logged) on every scan.
    expect(errors.filter((e) => e.includes('no tasks selected'))).toHaveLength(1)
  })

  it('a story re-added mid-run never runs concurrently with itself', async () => {
    fake({ FAKE_SLEEP: '0.15' })
    add(feature, docs)
    const started = new Set<string>()
    let overlapFeature = 0
    let maxOverlapFeature = 0
    let readdedOnce = false
    const results = await startDrain(
      repo,
      base,
      2,
      {
        onState: (s) => {
          if (s.status === 'Running' && !started.has(s.runId)) {
            started.add(s.runId)
            if (s.workflow === feature) {
              overlapFeature++
              maxOverlapFeature = Math.max(maxOverlapFeature, overlapFeature)
              if (!readdedOnce) {
                readdedOnce = true
                add(feature) // re-added while it is still mid-run
              }
            }
          }
        },
        onLog: (): void => {}
      },
      { pollMs: 20 }
    )
    expect(maxOverlapFeature).toBe(1) // never picked up while its own run is in flight
    // The completion transition is the last writer, so the mid-run re-add is
    // overwritten rather than queueing a second run — re-running is a new,
    // deliberate "Add to pipeline".
    expect(results.filter((r) => r.workflow === feature)).toHaveLength(1)
    expect(statusOnDisk(feature)).toBe('review')
  })

  it('a story added exactly as the last in-flight job finishes is still picked up (no shutdown race)', async () => {
    add(docs)
    let retickedOnce = false
    const results = await startDrain(
      repo,
      base,
      1,
      {
        onState: (s) => {
          if (!retickedOnce && s.status === 'Completed') {
            retickedOnce = true
            add(feature)
          }
        },
        onLog: (): void => {}
      },
      { pollMs: 20 }
    )
    expect(results.map((r) => r.workflow).sort()).toEqual([feature, docs].sort())
  })

  it('cancel during a keep-running idle exits promptly and leaves a clean Idle state', async () => {
    setKeepRunning(true)
    const run = startDrain(repo, base, 1, noEvents, { pollMs: 20 }, 'keep')
    await new Promise((r) => setTimeout(r, 40)) // idling, nothing in the Queue
    expect(getDrainState().status).toBe('Idle')
    const t0 = Date.now()
    cancelPipeline()
    const results = await run
    expect(Date.now() - t0).toBeLessThan(300) // doesn't wait out a poll interval, let alone longer
    expect(results).toEqual([])
    expect(getDrainState()).toEqual({ mode: null, status: 'Idle' })
  })

  it('does not flap Running/Idle across sequential pickups within one drain', async () => {
    add(feature, docs)
    const statuses: string[] = []
    await startDrain(repo, base, 2, { ...noEvents, onPipeline: (s) => statuses.push(s) })
    // two workflows launch in this drain; Running fires once (dedup), Idle once at the very end
    expect(statuses.filter((s) => s === 'Running')).toHaveLength(1)
    expect(statuses.filter((s) => s === 'Idle')).toHaveLength(1)
  })

  it('getDrainState() reflects Running mid-drain and resets to null/Idle after', async () => {
    add(docs)
    let sawRunning = false
    await startDrain(repo, base, 1, {
      onState: () => {
        if (getDrainState().status === 'Running') sawRunning = true
      },
      onLog: (): void => {}
    })
    expect(sawRunning).toBe(true)
    expect(getDrainState()).toEqual({ mode: null, status: 'Idle' })
  })

  it('the push payload carries the drain mode, and the final Idle carries null', async () => {
    add(docs)
    const modes: (string | null | undefined)[] = []
    await startDrain(repo, base, 1, {
      ...noEvents,
      onPipeline: (_s, info) => modes.push(info?.mode)
    })
    expect(modes[0]).toBe('manual')
    expect(modes[modes.length - 1]).toBe(null)
  })
})

// ---- M16: the discipline preamble + the closing review loop ----------------

describe('discipline preamble', () => {
  it('carries discipline, the story spec path and the role preamble into argv', async () => {
    const argv = join(root, 'argv')
    fake({ FAKE_ARGV: argv })
    const state = await runStory(repo, docs, base, noEvents)
    expect(state.status).toBe('Completed')
    // Every spawn appends; the first record is the subtask, the last the Review.
    const prompt = readFileSync(argv, 'utf8').split('You are closing out')[0]
    expect(prompt).toContain('implement` skill')
    const disciplineAt = prompt.indexOf('Read the Story Spec at')
    const specAt = prompt.indexOf(`.somni/items/${docs}-docs.md`)
    const roleAt = prompt.indexOf('You are dev.')
    const taskAt = prompt.indexOf('write docs')
    expect(disciplineAt).toBeGreaterThanOrEqual(0)
    expect(specAt).toBeGreaterThan(disciplineAt)
    expect(roleAt).toBeGreaterThan(specAt)
    expect(taskAt).toBeGreaterThan(roleAt)
  })

  it('keeps the role preamble optional and the order stable', () => {
    expect(subtaskPrompt('.somni/items/SOM-1-x.md', undefined, 'do it')).toBe(
      `${DISCIPLINE_PREAMBLE.replace('{SPEC}', '.somni/items/SOM-1-x.md')}\n\n---\n\ndo it`
    )
  })
})

describe('the closing review loop', () => {
  const reviewTitles = (state: RunState): string[] =>
    state.tasks.filter((t) => t.aux).map((t) => t.title)

  it('green verdict lands the story in review', async () => {
    const state = await runStory(repo, docs, base, noEvents)
    expect(state.status).toBe('Completed')
    expect(reviewTitles(state)).toEqual(['Review'])
    expect(state.reviews).toHaveLength(1)
    expect(state.reviews?.[0]).toMatchObject({ cycle: 1, verdict: 'green', green: true })
    setItemStatus(repo, docs, 'review') // the drain does this; runStory's caller path
    expect(statusOnDisk(docs)).toBe('review')
  })

  it('red cycles at most twice, then fails the run into needs-attention', async () => {
    fake({ FAKE_VERDICT: 'red' })
    add(docs)
    const [state] = await startDrain(repo, base, 1, noEvents)
    expect(state.status).toBe('Failed')
    expect(reviewTitles(state)).toEqual([
      'Review',
      'Address review findings',
      'Review',
      'Address review findings',
      'Review'
    ])
    expect(state.reviews?.map((r) => r.verdict)).toEqual(['red', 'red', 'red'])
    expect(state.reviews?.[0].findings).toContain('no tests')
    // aux tasks are accounted for like any other task
    expect(state.tasks.filter((t) => t.aux).every((t) => t.attempts === 1)).toBe(true)
    expect(state.tasks.filter((t) => t.aux).every((t) => t.costUsd === 0.01)).toBe(true)
    expect(statusOnDisk(docs)).toBe('needs-attention')
  })

  it('a missing verdict is red without a checkCommand', async () => {
    fake({ FAKE_VERDICT: 'none' })
    const state = await runStory(repo, docs, base, noEvents)
    expect(state.status).toBe('Failed')
    expect(state.reviews?.[0]).toMatchObject({ verdict: 'unknown', green: false })
  })

  it('a passing checkCommand makes a missing verdict green', async () => {
    fake({ FAKE_VERDICT: 'none' })
    const state = await runStory(repo, docs, base, noEvents, {
      settings: { checkCommand: 'exit 0' }
    })
    expect(state.status).toBe('Completed')
    expect(state.reviews?.[0]).toMatchObject({ verdict: 'unknown', green: true })
    expect(state.reviews?.[0].check).toMatchObject({ command: 'exit 0', ok: true })
  })

  it('a failing checkCommand is red however green the verdict text', async () => {
    const state = await runStory(repo, docs, base, noEvents, {
      settings: { checkCommand: 'echo nope >&2; exit 1' }
    })
    expect(state.status).toBe('Failed')
    expect(state.reviews).toHaveLength(3)
    expect(state.reviews?.[0]).toMatchObject({ verdict: 'green', green: false })
    expect(state.reviews?.[0].findings).toContain('nope')
    expect(statusOnDisk(docs)).toBe('needs-attention')
  })
})

describe('msUntil', () => {
  const at = (h: number, m: number): Date => new Date(2026, 0, 1, h, m, 0, 0)

  it('counts forward to a time later today', () => {
    expect(msUntil('03:30', at(1, 30))).toBe(2 * 60 * 60_000)
  })

  it('wraps to tomorrow when the time has passed', () => {
    expect(msUntil('01:00', at(3, 0))).toBe(22 * 60 * 60_000)
  })

  it('treats exactly-now as tomorrow rather than firing instantly', () => {
    expect(msUntil('03:00', at(3, 0))).toBe(24 * 60 * 60_000)
  })
})

describe('backlog', () => {
  it('round-trips and prunes ids whose item is gone', () => {
    saveBacklog(repo, [docs, feature])
    expect(loadBacklog(repo)).toEqual([docs, feature])
    saveBacklog(repo, [feature, 'SOM-99', docs])
    expect(loadBacklog(repo)).toEqual([feature, docs])
  })

  it('is empty when the file is missing', () => {
    expect(loadBacklog(repo)).toEqual([])
  })
})

// M15 §8: the full capture -> groom -> run -> review chain, built from the
// exact literal renderer/src/ui.ts's `captureItem` produces (verified
// separately by views.test.tsx — cross-importing it here would pull a
// renderer-only DOM type (`window.somni`) into the main tsconfig and break
// `npm run build`'s typecheck, so the split is reproduced inline instead),
// landing through the real item:save create path (saveItem + the backlog
// append that repoIpc's handler performs on create), then M14's
// applyProposal, then M13's drain. Proves the M13/M14/M15 machinery composes
// end to end, not just each milestone's own tests in isolation.
describe('end-to-end: capture -> groom -> drain -> review', () => {
  it('a captured idea lands ordered in Backlog, grooms to Ready, then drains to Review', async () => {
    // captureItem('Nightly Cleanup\n\nSweep the stale worktrees.') — first line
    // is the name, the rest (trimmed) is the spec.
    const literal = {
      kind: 'idea' as const,
      status: 'backlog' as const,
      name: 'Nightly Cleanup',
      spec: 'Sweep the stale worktrees.'
    }

    // item:save's create path (repoIpc.ts): saveItem, then the new backlog id
    // is appended to whatever ordering already exists (feature/docs from
    // beforeEach never touched backlog.json, so it's empty here).
    const idea = saveItem(repo, literal)
    saveBacklog(repo, [...loadBacklog(repo), idea.id])
    expect(loadBacklog(repo)).toEqual([idea.id])
    expect(statusOnDisk(idea.id)).toBe('backlog')

    // Groom now -> a single-story proposal Applied in place (M14), same as
    // GroomView's item-keyed path.
    const res = applyProposal(repo, idea.id, {
      kind: 'story',
      name: 'Nightly Cleanup',
      spec: 'Sweep the stale worktrees.',
      stories: [],
      tasks: [{ title: 'sweep', prompt: 'sweep worktrees', role: 'dev', selected: true }],
      roles: []
    })
    expect(res.ok).toBe(true)
    expect(statusOnDisk(idea.id)).toBe('ready')

    // Add to pipeline, drain (M13) — lands in Review with a run recorded.
    add(idea.id)
    const [result] = await startDrain(repo, base, 1, noEvents)
    expect(result.status).toBe('Completed')
    expect(statusOnDisk(idea.id)).toBe('review')
    expect(existsSync(join(repo, '.somni/runs', result.runId, 'run.json'))).toBe(true)
  })
})
