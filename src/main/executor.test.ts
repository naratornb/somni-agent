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
  resumePipeline,
  RunState,
  runPipeline,
  runWorkflow
} from './executor'
import { saveRole, saveWorkflow } from './store'

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
})

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

describe('runPipeline', () => {
  it('runs workflows concurrently in separate worktrees, all complete', async () => {
    const results = await runPipeline(repo, ['feature', 'docs'], base, 2, noEvents)
    expect(results.map((r) => r.status).sort()).toEqual(['Completed', 'Completed'])
    const ids = results.map((r) => r.runId)
    expect(new Set(ids).size).toBe(2) // same-second starts still get unique run dirs
    for (const r of results) {
      expect(existsSync(join(r.worktree, 'task-ran-here'))).toBe(true)
      expect(existsSync(join(repo, '.somni/runs', r.runId, 'run.json'))).toBe(true)
    }
  })

  it('cancels an actively running task: current task Cancelled, rest Skipped, isRunning() false after', async () => {
    // FAKE_HANG never exits on its own — the only way this test finishes is
    // via cancelPipeline() actually killing the child mid-execution.
    fake({ FAKE_HANG: '1' })
    let armed = (): void => {}
    const spawning = new Promise<void>((resolve) => {
      armed = resolve
    })
    const run = runPipeline(repo, ['feature'], base, 1, {
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
  })

  // M8 Decision 9: the chat guard asks per workflow, not per pipeline.
  it('isRunning(slug) is true only for the workflow actually executing', async () => {
    fake({ FAKE_HANG: '1' })
    let armed = (): void => {}
    const spawning = new Promise<void>((resolve) => {
      armed = resolve
    })
    const run = runPipeline(repo, ['feature'], base, 1, {
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
    const results = await runPipeline(repo, ['w1', 'w2', 'w3', 'w4'], base, 2, {
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
    let paused = (): void => {}
    const gotPause = new Promise<void>((resolve) => {
      paused = () => resolve()
    })
    const run = runPipeline(
      repo,
      ['docs'],
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
    const waits: number[] = []
    const state = await runPipeline(
      repo,
      ['feature', 'docs'],
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

  it('a missing workflow fails soft, the rest still run', async () => {
    const errors: string[] = []
    const results = await runPipeline(repo, ['nope', 'docs'], base, 2, {
      onState: () => {},
      onLog: (_id, _i, text) => errors.push(text)
    })
    expect(results.map((r) => r.workflow)).toEqual(['docs'])
    expect(errors.some((e) => e.includes('workflow not found'))).toBe(true)
  })
})
