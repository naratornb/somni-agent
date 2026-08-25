import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
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
  cancelPipeline,
  findOrphanedRuns,
  isRunning,
  getDrainState,
  msUntil,
  resumePipeline,
  RunState,
  runWorkflow,
  setKeepRunning,
  startDrain
} from './executor'
import { loadBacklog, saveBacklog, saveRole, saveWorkflow, setSelected } from './store'

// A fake `claude` on PATH: emits a valid stream-json conversation and drops a
// file in its cwd (proving it ran inside the worktree). Behaviours via env:
//   FAKE_FAIL         always fail
//   FAKE_FAIL_TIMES=n fail the first n invocations (needs FAKE_COUNT=<file>)
//   FAKE_RATE_LIMIT   failures look like a usage-limit error
//   FAKE_HANG         never exit (exec so SIGTERM lands on the sleep itself)
//   FAKE_TRAP         never exit AND ignore SIGTERM — only SIGKILL stops it
//   FAKE_SLEEP=<sec>  sleep before succeeding — a window to observe overlap
//   FAKE_RL_MATCH=<s> rate-limit only invocations whose args contain <s>
const FAKE_CLAUDE = `#!/bin/sh
n=1
if [ -n "$FAKE_COUNT" ]; then
  n=$(( $(cat "$FAKE_COUNT" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$FAKE_COUNT"
fi
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
echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"duration_ms":5}'
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
echo '{"event":"result","result":{"status":"SUCCESS","response":"done","duration_seconds":0.005}}'
`

let repo: string
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
  saveWorkflow(repo, {
    slug: '',
    name: 'Feature',
    selected: false,
    tasks: [
      { title: 'Design', prompt: 'design it', role: 'dev', selected: true },
      { title: 'Build', prompt: 'build it', role: 'dev', selected: true },
      { title: 'Deselected', prompt: 'skip me', role: 'dev', selected: false }
    ]
  })
  saveWorkflow(repo, {
    slug: '',
    name: 'Docs',
    selected: true,
    tasks: [{ title: 'Write docs', prompt: 'write docs', role: 'dev', selected: true }]
  })
  // A scanning drain sees every tick on disk, so tests tick explicitly.
  setSelected(repo, 'docs', false)
})

// The Queue: tick workflows for the drain to pick up.
const tick = (...slugs: string[]): void => {
  for (const s of slugs) setSelected(repo, s, true)
}
const selectedOnDisk = (slug: string): boolean =>
  JSON.parse(readFileSync(join(repo, '.somni/workflows', slug + '.json'), 'utf8')).selected

afterEach(() => {
  process.env.PATH = savedPath
  for (const k of fakeEnv) delete process.env[k]
})

const noEvents = { onState: (): void => {}, onLog: (): void => {} }

describe('runWorkflow', () => {
  it('runs selected tasks sequentially in a worktree and persists run.json', async () => {
    const state = await runWorkflow(repo, 'feature', base, noEvents)
    expect(state.status).toBe('Completed')
    // deselected task is excluded entirely
    expect(state.tasks.map((t) => t.title)).toEqual(['Design', 'Build'])
    expect(state.tasks.map((t) => t.status)).toEqual(['Completed', 'Completed'])
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
    const state = await runWorkflow(repo, 'feature', base, noEvents)
    expect(state.status).toBe('Completed')
    expect(state.tasks.map((t) => t.attempts)).toEqual([2, 1])
    expect(state.tasks[0].error).toBeUndefined()
  })

  it('halts after the second failure and skips the rest', async () => {
    fake({ FAKE_FAIL: '1' })
    const state = await runWorkflow(repo, 'feature', base, noEvents)
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
    const state = await runWorkflow(repo, 'docs', base, noEvents, { timeoutMs: 200 })
    expect(state.status).toBe('Failed')
    expect(state.tasks[0].attempts).toBe(2) // timeout consumes the retry
    expect(state.tasks[0].error).toMatch(/timed out/)
  })

  it('escalates to SIGKILL when the task ignores SIGTERM', async () => {
    // trap '' TERM makes the fake survive the polite kill — the only way this
    // test finishes is the grace timer firing SIGKILL.
    fake({ FAKE_TRAP: '1' })
    const state = await runWorkflow(repo, 'docs', base, noEvents, {
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
    const state = await runWorkflow(repo, 'docs', base, noEvents)
    expect(state.status).toBe('Failed')
    expect(state.tasks[0].error).toBe('claude: command not found')
  })

  it('pauses on a rate limit and retries without consuming the retry', async () => {
    fake({ FAKE_COUNT: join(root, 'n'), FAKE_FAIL_TIMES: '2', FAKE_RATE_LIMIT: '1' })
    const statuses: string[] = []
    const state = await runWorkflow(
      repo,
      'docs',
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
    saveWorkflow(repo, {
      slug: '',
      name: 'AgyFlow',
      selected: true,
      tasks: [{ title: 'Write docs', prompt: 'write docs', role: 'agy-dev', selected: true }]
    })
    const state = await runWorkflow(repo, 'agyflow', base, noEvents)
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
    saveWorkflow(repo, {
      slug: '',
      name: 'AgyFlow',
      selected: true,
      tasks: [{ title: 'Write docs', prompt: 'write docs', role: 'agy-dev', selected: true }]
    })
    fake({ FAKE_COUNT: join(root, 'n'), FAKE_FAIL_TIMES: '1', FAKE_RATE_LIMIT: '1' })
    const statuses: string[] = []
    const state = await runWorkflow(
      repo,
      'agyflow',
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
    saveWorkflow(repo, {
      slug: '',
      name: 'AgyFlow',
      selected: true,
      tasks: [{ title: 'Write docs', prompt: 'write docs', role: 'agy-dev', selected: true }]
    })
    fake({ FAKE_COUNT: join(root, 'n'), FAKE_FAIL_TIMES: '1' })
    const state = await runWorkflow(repo, 'agyflow', base, noEvents)
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
    const first = await runWorkflow(repo, 'feature', base, noEvents)
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

  it('refuses to resume a workflow whose tasks were reordered', async () => {
    const first = await runWorkflow(repo, 'feature', base, noEvents)
    orphan(first.runId, (s) => {
      s.status = 'Running'
      s.tasks[1].status = 'Running'
    })
    rmSync(join(first.worktree, 'task-ran-here'))
    // same task count, swapped order — index matching would run the wrong prompt
    saveWorkflow(repo, {
      slug: 'feature',
      name: 'Feature',
      selected: false,
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
    expect(errors.some((e) => e.includes('workflow changed since it started'))).toBe(true)
    expect(existsSync(join(first.worktree, 'task-ran-here'))).toBe(false) // nothing ran
  })

  it('re-attaches the existing branch when the worktree is gone', async () => {
    const first = await runWorkflow(repo, 'docs', base, noEvents)
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
    const first = await runWorkflow(repo, 'docs', base, noEvents)
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

  // Decision 7: resume is a fixed set over the drain loop and never scans the Queue.
  it('a tick landing during a resume is not picked up', async () => {
    const first = await runWorkflow(repo, 'docs', base, noEvents)
    orphan(first.runId, (s) => {
      s.status = 'Running'
      s.tasks[0].status = 'Running'
    })
    rmSync(join(first.worktree, 'task-ran-here'))
    fake({ FAKE_SLEEP: '0.15' })
    tick('feature') // ticked before the resume starts — must still be ignored
    const results = await resumePipeline(repo, [first.runId], 2, noEvents)
    expect(results.map((r) => r.workflow)).toEqual(['docs'])
    expect(selectedOnDisk('feature')).toBe(true) // untouched, never picked up
  })

  // M8 Decision 9: the chat guard must key off the workflow's slug correctly
  // even for a resumed run (not just a freshly-started pipeline).
  it('isRunning(slug) reflects the correct workflow slug during a resumed run', async () => {
    const first = await runWorkflow(repo, 'feature', base, noEvents)
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
    expect(isRunning('feature')).toBe(true)
    expect(isRunning('docs')).toBe(false)
    cancelPipeline()
    await run
    expect(isRunning('feature')).toBe(false)
  })
})

describe('startDrain', () => {
  it('runs workflows concurrently in separate worktrees, all complete', async () => {
    tick('feature', 'docs')
    const results = await startDrain(repo, base, 2, noEvents)
    expect(results.map((r) => r.status).sort()).toEqual(['Completed', 'Completed'])
    const ids = results.map((r) => r.runId)
    expect(new Set(ids).size).toBe(2) // same-second starts still get unique run dirs
    for (const r of results) {
      expect(existsSync(join(r.worktree, 'task-ran-here'))).toBe(true)
      expect(existsSync(join(repo, '.somni/runs', r.runId, 'run.json'))).toBe(true)
    }
  })

  it('consumes the tick at pickup and runs the workflow exactly once', async () => {
    tick('docs')
    const results = await startDrain(repo, base, 1, noEvents)
    expect(results.map((r) => r.workflow)).toEqual(['docs'])
    expect(selectedOnDisk('docs')).toBe(false)
  })

  it('resolves immediately with [] when the Queue is empty', async () => {
    expect(await startDrain(repo, base, 2, noEvents)).toEqual([])
    expect(getDrainState()).toEqual({ mode: null, status: 'Idle' })
  })

  it('picks up a workflow ticked mid-drain without restarting', async () => {
    fake({ FAKE_SLEEP: '0.3' })
    tick('docs')
    let armed = (): void => {}
    const spawning = new Promise<void>((resolve) => {
      armed = resolve
    })
    const run = startDrain(
      repo,
      base,
      1, // concurrency 1: 'feature' can only run if the drain re-scans
      { onState: (s) => s.tasks[0]?.status === 'Running' && armed(), onLog: (): void => {} },
      { pollMs: 20 }
    )
    await spawning
    tick('feature')
    const results = await run
    expect(results.map((r) => r.workflow).sort()).toEqual(['docs', 'feature'])
  })

  it('keep running: idles on an empty Queue, picks up a later tick, stops when toggled off', async () => {
    setKeepRunning(true)
    const run = startDrain(repo, base, 1, noEvents, { pollMs: 20 }, 'keep')
    await new Promise((r) => setTimeout(r, 60)) // idling, nothing in the Queue
    expect(getDrainState().mode).toBe('keep')
    expect(getDrainState().status).toBe('Idle')
    tick('docs')
    await new Promise((r) => setTimeout(r, 150))
    setKeepRunning(false) // in-flight work finishes; 'feature' is never picked up
    tick('feature')
    const results = await run
    expect(results.map((r) => r.workflow)).toEqual(['docs'])
    expect(selectedOnDisk('feature')).toBe(true) // unconsumed tick stays on disk
    expect(getDrainState().mode).toBe(null)
  })

  it('cancels an actively running task: current task Cancelled, rest Skipped, isRunning() false after', async () => {
    // FAKE_HANG never exits on its own — the only way this test finishes is
    // via cancelPipeline() actually killing the child mid-execution.
    fake({ FAKE_HANG: '1' })
    setKeepRunning(true) // ...and cancel must clear it, or the drain never ends
    tick('feature')
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

  // M8 Decision 9: the chat guard asks per workflow, not per pipeline.
  it('isRunning(slug) is true only for the workflow actually executing', async () => {
    fake({ FAKE_HANG: '1' })
    tick('feature')
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
    expect(isRunning('feature')).toBe(true)
    expect(isRunning('docs')).toBe(false)
    cancelPipeline()
    await run
    expect(isRunning('feature')).toBe(false)
  })

  it('bounds in-flight tasks at maxConcurrency across a bigger queue', async () => {
    for (const name of ['W1', 'W2', 'W3', 'W4']) {
      saveWorkflow(repo, {
        slug: '',
        name,
        selected: true,
        tasks: [{ title: 'Solo', prompt: 'go', role: 'dev', selected: true }]
      })
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
    tick('docs')
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
    tick('feature', 'docs')
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

  it('a workflow that cannot start fails soft, the rest still run', async () => {
    saveWorkflow(repo, {
      slug: '',
      name: 'Empty',
      selected: false,
      tasks: [{ title: 'Off', prompt: 'no', role: 'dev', selected: false }]
    })
    tick('empty', 'docs')
    const errors: string[] = []
    const results = await startDrain(repo, base, 2, {
      onState: () => {},
      onLog: (_id, _i, text) => errors.push(text)
    })
    expect(results.map((r) => r.workflow)).toEqual(['docs'])
    expect(errors.some((e) => e.includes('no tasks selected'))).toBe(true)
  })

  it('a re-tick of a running workflow never runs concurrently with itself, only after', async () => {
    fake({ FAKE_SLEEP: '0.15' })
    tick('feature', 'docs')
    const started = new Set<string>()
    const finished = new Set<string>()
    let overlap = 0
    let maxOverlapFeature = 0
    let retickedOnce = false
    const results = await startDrain(
      repo,
      base,
      2,
      {
        onState: (s) => {
          if (s.status === 'Running' && !started.has(s.runId)) {
            started.add(s.runId)
            if (s.workflow === 'feature') {
              overlap++
              maxOverlapFeature = Math.max(maxOverlapFeature, overlap)
              if (!retickedOnce) {
                retickedOnce = true
                tick('feature') // re-tick while it's still mid-run
              }
            }
          } else if (
            (s.status === 'Completed' || s.status === 'Failed') &&
            !finished.has(s.runId)
          ) {
            finished.add(s.runId)
            if (s.workflow === 'feature') overlap--
          }
        },
        onLog: (): void => {}
      },
      { pollMs: 20 }
    )
    expect(maxOverlapFeature).toBe(1) // never picked up while its own run is in flight
    expect(results.filter((r) => r.workflow === 'feature')).toHaveLength(2) // ran again after
  })

  it('a tick landing exactly as the last in-flight job finishes is still picked up (no shutdown race)', async () => {
    tick('docs')
    let retickedOnce = false
    const results = await startDrain(
      repo,
      base,
      1,
      {
        onState: (s) => {
          if (!retickedOnce && s.status === 'Completed') {
            retickedOnce = true
            tick('feature')
          }
        },
        onLog: (): void => {}
      },
      { pollMs: 20 }
    )
    expect(results.map((r) => r.workflow).sort()).toEqual(['docs', 'feature'])
  })

  it('untick failure fails soft and does not spam the log on every poll', async () => {
    tick('docs') // alphabetically first — the one next() will try to untick
    chmodSync(join(repo, '.somni', 'workflows'), 0o555) // read-only: setSelected write fails
    const errors: string[] = []
    try {
      const results = await startDrain(
        repo,
        base,
        2,
        { onState: (): void => {}, onLog: (_id, _i, text) => errors.push(text) },
        { pollMs: 20 }
      )
      expect(results).toEqual([]) // nothing ever ran
    } finally {
      chmodSync(join(repo, '.somni', 'workflows'), 0o755)
    }
    // The per-drain skip set means the slug is logged once, not once per scan.
    expect(errors.filter((e) => e.includes('could not untick')).length).toBe(1)
  })

  it('untick failure on one slug does not block a different ticked slug from running', async () => {
    // 'docs' sorts before 'feature', so next() tries it first. A directory in
    // place of the atomic write's temp file makes *only* docs' untick fail
    // (loadRepo still lists both — it only reads *.json).
    tick('feature', 'docs')
    mkdirSync(join(repo, '.somni', 'workflows', 'docs.json.tmp'))
    const errors: string[] = []
    const results = await startDrain(
      repo,
      base,
      2,
      { onState: (): void => {}, onLog: (_id, _i, text) => errors.push(text) },
      { pollMs: 20 }
    )
    expect(results.map((r) => r.workflow)).toEqual(['feature']) // skipped, not stalled
    expect(errors.filter((e) => e.includes('could not untick docs')).length).toBe(1)
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
    tick('feature', 'docs')
    const statuses: string[] = []
    await startDrain(repo, base, 2, { ...noEvents, onPipeline: (s) => statuses.push(s) })
    // two workflows launch in this drain; Running fires once (dedup), Idle once at the very end
    expect(statuses.filter((s) => s === 'Running')).toHaveLength(1)
    expect(statuses.filter((s) => s === 'Idle')).toHaveLength(1)
  })

  it('getDrainState() reflects Running mid-drain and resets to null/Idle after', async () => {
    tick('docs')
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
    tick('docs')
    const modes: (string | null | undefined)[] = []
    await startDrain(repo, base, 1, {
      ...noEvents,
      onPipeline: (_s, info) => modes.push(info?.mode)
    })
    expect(modes[0]).toBe('manual')
    expect(modes[modes.length - 1]).toBe(null)
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
  it('round-trips and prunes slugs whose workflow is gone', () => {
    saveBacklog(repo, ['docs', 'feature'])
    expect(loadBacklog(repo)).toEqual(['docs', 'feature'])
    saveBacklog(repo, ['feature', 'ghost', 'docs'])
    expect(loadBacklog(repo)).toEqual(['feature', 'docs'])
  })

  it('is empty when the file is missing', () => {
    expect(loadBacklog(repo)).toEqual([])
  })
})
