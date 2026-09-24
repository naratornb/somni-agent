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
import { PLAN_TASK_TITLE, storyPlanPrompt } from './prompts'
import {
  abandonRun,
  cancelPipeline,
  DrainMode,
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
  RunnerName,
  saveBacklog,
  saveItem,
  saveRole,
  setItemStatus,
  Task
} from './store'
import { isAvailable, markAuthFailed, resetProviders } from './providers'

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
//   FAKE_REVIEW=<grade[,grade]>  the somni-review block a Branch Review turn
//     emits (M28), keyed off the argv carrying the merge-reviewer prompt so
//     ordinary subtask/closing-Review calls through this same binary are
//     unaffected. Defaults to "approve" (like FAKE_VERDICT defaults green) so
//     every other test's already-green run stays Completed once M28 always
//     runs a branch review. A comma list answers successive review calls (the
//     re-review after a fix round — supply one entry per expected call).
//     "fail" makes that call die with no reply. FAKE_REVIEW_COUNT=<file> tracks
//     which list entry is next. FAKE_REVIEW_HANG=<file> (gemini's copy only):
//     touch <file> then hang, so a test can wait for the marker and cancel
//     mid-turn deterministically.
//   FAKE_COMMIT  after touching task-ran-here, git add+commit it too — a real
//     tracked change for a Branch Review's `git diff <base>` to find non-empty
//     (M28 §2 diff-split coverage).
const FAKE_CLAUDE = `#!/bin/sh
n=1
if [ -n "$FAKE_COUNT" ]; then
  n=$(( $(cat "$FAKE_COUNT" 2>/dev/null || echo 0) + 1 ))
  echo "$n" > "$FAKE_COUNT"
fi
if [ -n "$FAKE_ARGV" ]; then printf '%s\n' "$@" >> "$FAKE_ARGV"; fi
case "$*" in
  *"merge reviewer for an unattended coding run"*)
    rn=1
    if [ -n "$FAKE_REVIEW_COUNT" ]; then
      rn=$(( $(cat "$FAKE_REVIEW_COUNT" 2>/dev/null || echo 0) + 1 ))
      echo "$rn" > "$FAKE_REVIEW_COUNT"
    fi
    grade=$(printf '%s' "\${FAKE_REVIEW:-approve}" | cut -d, -f"$rn")
    if [ "$grade" = "fail" ]; then
      echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}'
      exit 1
    fi
    echo '{"type":"system","subtype":"init","session_id":"rev-s1"}'
    printf '%s\n' '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"duration_ms":5,"result":"\`\`\`somni-review\\n{\\"grade\\": \\"'"$grade"'\\", \\"reasons\\": [\\"r\\"], \\"findings\\": [\\"f\\"]}\\n\`\`\`"}'
    exit 0
    ;;
esac
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
if [ -n "$FAKE_COMMIT" ]; then
  git add task-ran-here
  git -c user.email=t@t -c user.name=t commit -q -m fake
fi
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

// A fake `codex` for the M26 failover tests: codex-cli's thread.started /
// item.completed / turn.completed shape (runners.ts). FAKE_AUTH_FAIL emits an
// auth-shaped turn.failed instead (codexRunner.isAuthError's wording). The
// agent_message text carries a green somni-verdict block too — a failed-over
// closing Review must find one just like claude's, or M16's review loop reads
// it as red/unknown and fails the run for an unrelated reason.
const FAKE_CODEX = `#!/bin/sh
if [ -n "$FAKE_ARGV" ]; then printf '%s\n' "$@" >> "$FAKE_ARGV"; fi
if [ -n "$FAKE_AUTH_FAIL" ]; then
  echo '{"type":"turn.failed","error":{"message":"401 unauthorized: codex login required"}}'
  exit 1
fi
case "$*" in
  *"merge reviewer for an unattended coding run"*)
    rn=1
    if [ -n "$FAKE_REVIEW_COUNT" ]; then
      rn=$(( $(cat "$FAKE_REVIEW_COUNT" 2>/dev/null || echo 0) + 1 ))
      echo "$rn" > "$FAKE_REVIEW_COUNT"
    fi
    grade=$(printf '%s' "\${FAKE_REVIEW:-approve}" | cut -d, -f"$rn")
    if [ "$grade" = "fail" ]; then
      echo '{"type":"turn.failed","error":{"message":"boom"}}'
      exit 1
    fi
    echo '{"type":"thread.started","thread_id":"codex-rev"}'
    printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"\`\`\`somni-review\\n{\\"grade\\": \\"'"$grade"'\\", \\"reasons\\": [\\"r\\"], \\"findings\\": [\\"f\\"]}\\n\`\`\`"}}'
    echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
    exit 0
    ;;
esac
echo '{"type":"thread.started","thread_id":"codex-s1"}'
printf '%s\n' '{"type":"item.completed","item":{"type":"agent_message","text":"did work\\n\`\`\`somni-verdict\\n{\\"verdict\\": \\"green\\", \\"findings\\": \\"\\"}\\n\`\`\`"}}'
touch task-ran-here
echo '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}'
`

// A fake `gemini` — geminiRunner's init/message/result shape — used as the
// next-in-chain success behind a parked codex (auth-failover-under-auto test).
const FAKE_GEMINI = `#!/bin/sh
if [ -n "$FAKE_ARGV" ]; then printf '%s\n' "$@" >> "$FAKE_ARGV"; fi
case "$*" in
  *"merge reviewer for an unattended coding run"*)
    rn=1
    if [ -n "$FAKE_REVIEW_COUNT" ]; then
      rn=$(( $(cat "$FAKE_REVIEW_COUNT" 2>/dev/null || echo 0) + 1 ))
      echo "$rn" > "$FAKE_REVIEW_COUNT"
    fi
    grade=$(printf '%s' "\${FAKE_REVIEW:-approve}" | cut -d, -f"$rn")
    if [ "$grade" = "fail" ]; then
      exit 1
    fi
    if [ -n "$FAKE_REVIEW_HANG" ]; then touch "$FAKE_REVIEW_HANG"; exec sleep 30; fi
    echo '{"type":"init","session_id":"gem-rev"}'
    printf '%s\n' '{"type":"message","role":"assistant","content":"\`\`\`somni-review\\n{\\"grade\\": \\"'"$grade"'\\", \\"reasons\\": [\\"r\\"], \\"findings\\": [\\"f\\"]}\\n\`\`\`"}'
    echo '{"type":"result","status":"success"}'
    exit 0
    ;;
esac
echo '{"type":"init","session_id":"gem-s1"}'
printf '%s\n' '{"type":"message","role":"assistant","content":"did work\\n\`\`\`somni-verdict\\n{\\"verdict\\": \\"green\\", \\"findings\\": \\"\\"}\\n\`\`\`"}'
touch task-ran-here
echo '{"type":"result","status":"success"}'
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
  resetProviders() // per-provider health is module-global (M26) — never leak between tests
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
  writeFileSync(join(bin, 'codex'), FAKE_CODEX)
  chmodSync(join(bin, 'codex'), 0o755)
  writeFileSync(join(bin, 'gemini'), FAKE_GEMINI)
  chmodSync(join(bin, 'gemini'), 0o755)
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

// A clock that runs `scale`× real time (RunOpts.now, M26): providers.ts's
// cooldowns are real minutes, not configurable, so a wait-then-resume test
// fast-forwards through them without fake timers — real elapsed ms just get
// multiplied, so a 5-minute cooldown resolves in a few tens of real ms.
const fastClock = (scale: number): (() => Date) => {
  const start = Date.now()
  return () => new Date(start + (Date.now() - start) * scale)
}

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
    // M16 appends the closing Review, M28 appends the Branch review; the
    // subtasks are the non-aux ones.
    expect(state.tasks.filter((t) => !t.aux).map((t) => t.title)).toEqual(['Design', 'Build'])
    expect(state.tasks.map((t) => t.status)).toEqual([
      'Completed',
      'Completed',
      'Completed',
      'Completed'
    ])
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
    expect(state.tasks.map((t) => t.attempts)).toEqual([2, 1, 1, 1])
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

  it('waits out its own cooldown on a rate limit and resumes on the same (pinned) provider', async () => {
    fake({ FAKE_COUNT: join(root, 'n'), FAKE_FAIL_TIMES: '2', FAKE_RATE_LIMIT: '1' })
    const statuses: string[] = []
    const state = await runStory(
      repo,
      docs,
      base,
      { ...noEvents, onPipeline: (s) => statuses.push(s) },
      { now: fastClock(20_000) } // 5min/10min cooldowns resolve in tens of ms
    )
    // two rate-limited attempts, neither counted as a failure → third succeeds
    expect(state.status).toBe('Completed')
    expect(state.tasks[0].attempts).toBe(3)
    expect(state.tasks[0].runner).toBe('claude') // pinned — waited, never switched
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

  it('waits out an agy rate-limit on its own cooldown instead of burning the retry', async () => {
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
      { now: fastClock(20_000) }
    )
    expect(state.status).toBe('Completed')
    expect(state.tasks[0].attempts).toBe(2) // rate-limited attempt didn't count as a failure
    expect(state.tasks[0].runner).toBe('antigravity') // pinned — waited, never switched
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

describe('failover (M26)', () => {
  it('auto fails over to the next provider on a rate limit, no retry burned', async () => {
    fake({ FAKE_FAIL: '1', FAKE_RATE_LIMIT: '1' }) // claude always rate-limits, codex always succeeds
    // Global runner: 'auto' so both the subtask (via role fallback) and the
    // closing Review aux task (which only ever reads global settings) fail
    // over — a Review pinned to claude would otherwise wait out its cooldown.
    const settings = {
      runner: 'auto' as const,
      providers: { defaults: { codex: { model: 'gpt-5.3-codex', effort: 'high' as const } } }
    }
    const state = await runStory(repo, docs, base, noEvents, { settings })
    expect(state.status).toBe('Completed')
    expect(state.tasks[0].runner).toBe('codex') // failed over — and never persisted 'auto'
    expect(state.tasks[0].model).toBe('gpt-5.3-codex')
    expect(state.tasks[0].effort).toBe('high')
    expect(state.tasks[0].attempts).toBe(2) // claude + codex — neither burned a failure retry
    expect(existsSync(join(state.worktree, 'task-ran-here'))).toBe(true)
    const onDisk = JSON.parse(
      readFileSync(join(repo, '.somni/runs', state.runId, 'run.json'), 'utf8')
    )
    expect(onDisk.tasks[0].runner).toBe('codex') // run.json never records 'auto'
  })

  it('a generic (non-rate-limit) failure retries on the same provider even under auto', async () => {
    saveRole(repo, { slug: 'auto-dev', name: 'AutoDev', preamble: 'You are dev.', runner: 'auto' })
    const s = story('AutoFlow', [
      { title: 'Write docs', prompt: 'write docs', role: 'auto-dev', selected: true }
    ]).id
    fake({ FAKE_COUNT: join(root, 'n'), FAKE_FAIL_TIMES: '1' }) // claude fails once (not rate-limited), then succeeds
    const state = await runStory(repo, s, base, noEvents)
    expect(state.status).toBe('Completed')
    expect(state.tasks[0].attempts).toBe(2)
    expect(state.tasks[0].runner).toBe('claude') // retried on claude — never failed over to codex
  })

  it('fails fast when every provider in the chain is parked', async () => {
    markAuthFailed('claude')
    markAuthFailed('codex')
    markAuthFailed('gemini')
    markAuthFailed('antigravity')
    const state = await runStory(repo, docs, base, noEvents)
    expect(state.status).toBe('Failed')
    expect(state.tasks[0].status).toBe('Failed')
    expect(state.tasks[0].error).toBe('no provider available')
    expect(state.tasks[0].attempts).toBe(0) // never even spawned a turn
    expect(existsSync(join(state.worktree, 'task-ran-here'))).toBe(false)
  })

  it('an auth-shaped failure parks a pinned provider and fails the task immediately (never retried)', async () => {
    saveRole(repo, {
      slug: 'codex-dev',
      name: 'CodexDev',
      preamble: 'You are dev.',
      runner: 'codex'
    })
    const s = story('CodexFlow', [
      { title: 'Write docs', prompt: 'write docs', role: 'codex-dev', selected: true }
    ]).id
    fake({ FAKE_AUTH_FAIL: '1' })
    const state = await runStory(repo, s, base, noEvents)
    expect(state.status).toBe('Failed')
    expect(state.tasks[0].status).toBe('Failed')
    expect(state.tasks[0].attempts).toBe(1) // parked — never retried on the same, dead provider
    expect(isAvailable('codex', {}, Date.now())).toBe(false) // parked in providers.ts too
  })

  it('an auth-shaped failure fails over to the next provider under auto', async () => {
    fake({ FAKE_AUTH_FAIL: '1' }) // codex always auth-fails; gemini always succeeds
    const settings = {
      runner: 'auto' as const,
      providers: {
        order: ['codex', 'gemini'] as RunnerName[],
        disabled: ['claude', 'antigravity'] as RunnerName[]
      }
    }
    const state = await runStory(repo, docs, base, noEvents, { settings })
    expect(state.status).toBe('Completed')
    expect(state.tasks[0].runner).toBe('gemini') // failed over past the parked codex
    expect(state.tasks[0].attempts).toBe(2) // codex (parked) + gemini — neither burned a failure retry
    expect(isAvailable('codex', {}, Date.now())).toBe(false) // parked, not just cooled down
  })

  it('a per-provider cap serializes tasks even when drain concurrency allows overlap', async () => {
    const second = story('Second', [
      { title: 'Write more docs', prompt: 'write more docs', role: 'dev', selected: true }
    ]).id
    add(docs, second)
    fake({ FAKE_SLEEP: '0.2' })
    const settings = { providers: { caps: { claude: 1 } } }
    const t0 = Date.now()
    const results = await startDrain(repo, base, 2, noEvents, { settings })
    expect(results.every((r) => r.status === 'Completed')).toBe(true)
    // Every turn (both subtasks + both closing reviews, 4 total) shares the
    // one claude slot, so they run one at a time: 4 * 200ms, not 2 in parallel.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(700)
  })

  // report.ts's full-style Report task (review round 1): it went through the
  // same "resolve 'auto' before persisting" bug the subtask loop had —
  // task.runner = settings.runner would have literally written 'auto' into
  // run.json. Routing it through the shared runTurnWithFailover fixes this
  // the same way it does for a subtask.
  it('a full-style report under auto records a concrete runner, never "auto", in run.json', async () => {
    const settings = { runner: 'auto' as const, reportStyle: 'full' as const }
    const state = await runStory(repo, docs, base, noEvents, { settings })
    expect(state.status).toBe('Completed')
    const report = state.tasks.find((t) => t.title === 'Report')
    expect(report?.status).toBe('Completed')
    expect(report?.runner).toBe('claude') // resolved from 'auto' — head of chain, available
    const onDisk = JSON.parse(
      readFileSync(join(repo, '.somni/runs', state.runId, 'run.json'), 'utf8')
    )
    const onDiskReport = onDisk.tasks.find((t: { title: string }) => t.title === 'Report')
    expect(onDiskReport.runner).toBe('claude') // never 'auto' on disk either
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

  it('cancel aborts a provider-cooldown wait instead of waiting it out', async () => {
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
      { ...noEvents, onPipeline: (s) => s === 'Paused' && paused() }
      // no fast clock: the real 5-minute cooldown never elapses — only
      // cancel's abort can end this wait within the test.
    )
    await gotPause
    cancelPipeline()
    const [state] = await run
    expect(state.status).toBe('Cancelled')
  })

  // M26 final review: failover.ts's own Paused push (a per-task provider
  // wait, not a drain-state change — unlike drainLoop's own Running/Idle
  // pushes, it calls events.onPipeline directly, bypassing the emit() wrapper
  // that stamps `mode`) must not carry a `mode` key of its own. index.ts's
  // forwarder defaults `mode` from getDrainState() and only lets an explicit
  // key in this payload win, so a stray `mode: null` here would wipe the mode
  // chip/Keep Running mid-drain the same way the bug did. This pins the
  // executor-side half of that contract; the forwarder itself has no test
  // seam (Electron main, no harness).
  it('a failover Paused wait never sends a mode key of its own', async () => {
    fake({ FAKE_FAIL: '1', FAKE_RATE_LIMIT: '1' })
    add(docs)
    const infos: { resumeAt?: string; mode?: DrainMode | null }[] = []
    let paused = (): void => {}
    const gotPause = new Promise<void>((resolve) => {
      paused = () => resolve()
    })
    const run = startDrain(repo, base, 1, {
      ...noEvents,
      onPipeline: (s, info) => {
        if (s !== 'Paused') return
        infos.push(info ?? {})
        paused()
      }
    })
    await gotPause
    cancelPipeline()
    await run
    expect(infos.length).toBeGreaterThan(0)
    expect(infos.every((i) => !('mode' in i))).toBe(true)
  })

  // M26: providers.ts's markOk always resets a provider's cooldown — there is
  // no more pipeline-wide "a success mid-pause doesn't count" guard, because
  // there is no more pipeline-wide pause. A same-provider success from another
  // in-flight workflow now legitimately clears everyone's wait on it.
  it('a same-provider success from another workflow resets the cooldown instead of compounding it', async () => {
    // feature/Design rate-limits on every attempt (deterministically, via
    // FAKE_RL_MATCH); docs succeeds ~100ms in and shares the same provider
    // (claude, the default). The fast clock keeps feature's own cooldown
    // cycles short enough (~200ms) that the second one starts after docs'
    // markOk, so it should be freshly based rather than doubled.
    fake({ FAKE_RL_MATCH: 'design it', FAKE_SLEEP: '0.1' })
    add(feature, docs)
    // Same clock instance passed to the drain and used to measure here: the
    // executor's resumeAt is on this scaled clock, not the real one, so the
    // "how far away" math must read it back through the same function.
    const clock = fastClock(1_500)
    const waits: number[] = []
    const state = await startDrain(
      repo,
      base,
      2,
      {
        ...noEvents,
        onPipeline: (s, info) => {
          if (s !== 'Paused' || !info?.resumeAt) return
          waits.push(Date.parse(info.resumeAt) - clock().getTime())
          if (waits.length === 2) queueMicrotask(cancelPipeline)
        }
      },
      { now: clock }
    )
    expect(state).toHaveLength(2)
    expect(waits).toHaveLength(2)
    expect(waits[1]).toBeLessThan(waits[0] * 1.5) // reset by docs' markOk, not doubled
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
})

// ---- Superpowers methodology (adr/0002): the agent orchestrates ------------

describe('superpowers methodology', () => {
  it('runs the whole story as one plan-executing task', async () => {
    const argv = join(root, 'argv')
    fake({ FAKE_ARGV: argv })
    const state = await runStory(repo, feature, base, noEvents, {
      settings: { methodology: 'superpowers' }
    })
    expect(state.status).toBe('Completed')
    expect(state.tasks.filter((t) => !t.aux).map((t) => t.title)).toEqual([PLAN_TASK_TITLE])
    const [prompt, review] = readFileSync(argv, 'utf8').split('You are closing out')
    expect(prompt).toContain('subagent-driven-development')
    expect(prompt.indexOf('## Step 1: Design')).toBeLessThan(prompt.indexOf('## Step 2: Build'))
    expect(prompt).not.toContain('skip me') // deselected stays out of the plan
    expect(prompt).toContain('You are dev.') // role personas ride along as plan text
    expect(review).toContain('requesting-code-review')
  })

  it('storyPlanPrompt opens with the discipline and keeps the steps ordered', () => {
    const p = storyPlanPrompt(
      '.somni/items/SOM-1-x.md',
      [
        { title: 'A', prompt: 'do a', role: '', selected: true },
        { title: 'B', prompt: 'do b', role: '', selected: true }
      ],
      []
    )
    expect(p.indexOf('.somni/items/SOM-1-x.md')).toBeGreaterThanOrEqual(0)
    expect(p.indexOf('executing-plans')).toBeLessThan(p.indexOf('## Step 1: A'))
    expect(p.indexOf('do a')).toBeLessThan(p.indexOf('do b'))
  })
})

describe('the closing review loop', () => {
  const reviewTitles = (state: RunState): string[] =>
    state.tasks.filter((t) => t.aux).map((t) => t.title)

  it('green verdict lands the story in review', async () => {
    const state = await runStory(repo, docs, base, noEvents)
    expect(state.status).toBe('Completed')
    // M28's Branch review always follows a green closing loop.
    expect(reviewTitles(state)).toEqual(['Review', 'Branch review'])
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

describe('branch review (M28)', () => {
  const reviewTitles = (state: RunState): string[] =>
    state.tasks.filter((t) => t.aux).map((t) => t.title)

  it('approve completes the run; the review is recorded against the cross-provider reviewer', async () => {
    const argv = join(root, 'argv.log')
    fake({ FAKE_REVIEW: 'approve', FAKE_ARGV: argv })
    const state = await runStory(repo, docs, base, noEvents)
    expect(state.status).toBe('Completed')
    expect(reviewTitles(state)).toEqual(['Review', 'Branch review'])
    // docs' one subtask ran on the default runner (claude); pickReviewer picks
    // the next chain member — codex — so this proves the cross-provider pick,
    // not just that a review happened.
    expect(state.review).toMatchObject({ grade: 'approve', provider: 'codex', sameProvider: false })
    expect(state.tasks.find((t) => t.title === 'Branch review')?.runner).toBe('codex')
    expect(readFileSync(argv, 'utf8')).toContain('merge reviewer for an unattended coding run')
    // run.json round-trips the review field, not just the in-memory state.
    const onDisk = JSON.parse(readFileSync(join(repo, '.somni/runs', state.runId, 'run.json'), 'utf8'))
    expect(onDisk.review).toMatchObject({ grade: 'approve', provider: 'codex', sameProvider: false })
  })

  it('needs-work runs one fix round carrying the findings, then approves on re-review with fixRound recorded', async () => {
    const argv = join(root, 'fix-argv.log')
    const reviewCount = join(root, 'review-count')
    fake({
      FAKE_ARGV: argv,
      FAKE_REVIEW: 'needs-work,approve',
      FAKE_REVIEW_COUNT: reviewCount
    })
    const state = await runStory(repo, docs, base, noEvents, {
      settings: { reviewer: { runner: 'gemini' } }
    })
    expect(state.status).toBe('Completed')
    expect(reviewTitles(state)).toEqual([
      'Review',
      'Branch review',
      'Address merge review',
      'Branch review'
    ])
    expect(state.review).toMatchObject({ grade: 'approve', provider: 'gemini', fixRound: true })
    // BRANCH_FIX_PROMPT lists each finding as "- <finding>" — "f" is the
    // finding FAKE_REVIEW's needs-work reply carries.
    expect(readFileSync(argv, 'utf8')).toContain('- f')
  })

  it('a final needs-work after the fix round lands needs-attention, the same mechanism as reviewGreen=false', async () => {
    const reviewCount = join(root, 'review-count-2')
    fake({ FAKE_REVIEW: 'needs-work,needs-work', FAKE_REVIEW_COUNT: reviewCount })
    add(docs)
    const [state] = await startDrain(repo, base, 1, noEvents, {
      settings: { reviewer: { runner: 'gemini' } }
    })
    expect(state.status).toBe('Failed')
    expect(state.review).toMatchObject({ grade: 'needs-work', fixRound: true })
    expect(statusOnDisk(docs)).toBe('needs-attention')
  })

  it('reject parks immediately — no fix round is spawned', async () => {
    fake({ FAKE_REVIEW: 'reject' })
    const state = await runStory(repo, docs, base, noEvents, {
      settings: { reviewer: { runner: 'gemini' } }
    })
    expect(state.status).toBe('Failed')
    expect(reviewTitles(state)).toEqual(['Review', 'Branch review'])
    expect(state.tasks.filter((t) => t.title === 'Address merge review')).toHaveLength(0)
    expect(state.review).toMatchObject({ grade: 'reject' })
    expect(state.review?.fixRound).toBeUndefined()
    expect(statusOnDisk(docs)).toBe('needs-attention')
  })

  it('a reviewer turn that dies with no reply grades ungraded, carrying the real TaskRun error', async () => {
    fake({ FAKE_REVIEW: 'fail' })
    const state = await runStory(repo, docs, base, noEvents, {
      settings: { reviewer: { runner: 'gemini' } }
    })
    expect(state.status).toBe('Completed')
    expect(reviewTitles(state)).toEqual(['Review', 'Branch review'])
    expect(state.review?.grade).toBe('ungraded')
    // The honest reason, not a fixed placeholder: the fake dies with exit 1 and
    // no result event, so the TaskRun's own recorded error is "exited with code 1".
    const branchTask = state.tasks.find((t) => t.title === 'Branch review')
    expect(branchTask?.error).toBeTruthy()
    expect(state.review?.reasons).toEqual([branchTask?.error])
  })

  it('a git diff failure grades ungraded with the real error, never failing an otherwise-green run', async () => {
    const first = await runStory(repo, docs, base, noEvents)
    expect(first.status).toBe('Completed')
    // Poison baseSha so `git diff <base>` fails — a review outage (bad ref,
    // oversized diff) must never hold a finished, green branch hostage (§6).
    const path = join(repo, '.somni/runs', first.runId, 'run.json')
    const s = JSON.parse(readFileSync(path, 'utf8')) as RunState
    s.status = 'Running'
    s.baseSha = 'not-a-real-sha'
    s.tasks = s.tasks.filter((t) => !t.aux) // re-run the subtask; drop the prior Review/Branch review
    s.tasks[0].status = 'Running'
    s.reviews = []
    delete s.review
    writeFileSync(path, JSON.stringify(s, null, 2))

    const [state] = await resumePipeline(repo, [first.runId], 1, noEvents)
    expect(state.status).toBe('Completed')
    // branchDiff threw before any turn ran — no Branch review aux task at all.
    expect(reviewTitles(state)).toEqual(['Review'])
    expect(state.review?.grade).toBe('ungraded')
    expect(state.review?.reasons[0]).toContain('branch diff failed')
  })

  it('the fix round is pinned to the implementer, never the run default or the reviewer', async () => {
    // The role pins its own runner — different from both settings.runner (the
    // naive "default profile") and the reviewer, so a wrong pin is visible.
    saveRole(repo, { slug: '', name: 'Dev', preamble: 'You are dev.', runner: 'claude' })
    const reviewCount = join(root, 'review-count-pin')
    fake({ FAKE_REVIEW: 'needs-work,approve', FAKE_REVIEW_COUNT: reviewCount })
    const state = await runStory(repo, docs, base, noEvents, {
      settings: { runner: 'gemini', reviewer: { runner: 'codex' } }
    })
    expect(state.status).toBe('Completed')
    const fixTask = state.tasks.find((t) => t.title === 'Address merge review')
    expect(fixTask?.runner).toBe('claude')
  })

  it('a real, non-empty diff is split and reaches the reviewer prompt', async () => {
    const argv = join(root, 'diff-argv.log')
    fake({ FAKE_COMMIT: '1', FAKE_REVIEW: 'approve', FAKE_ARGV: argv })
    const state = await runStory(repo, docs, base, noEvents, {
      settings: { reviewer: { runner: 'gemini' } }
    })
    expect(state.status).toBe('Completed')
    // Proves the split + capDiff path ran on real content, not an empty diff:
    // the fake's own touched-and-committed file shows up as a real "diff --git"
    // hunk in the reviewer's prompt.
    expect(readFileSync(argv, 'utf8')).toContain('diff --git')
  })

  it('a single-provider chain reviews with the same provider as the implementer', async () => {
    fake({ FAKE_REVIEW: 'approve' })
    const state = await runStory(repo, docs, base, noEvents, {
      settings: { providers: { disabled: ['codex', 'gemini', 'antigravity'] } }
    })
    expect(state.status).toBe('Completed')
    expect(state.review).toMatchObject({ grade: 'approve', provider: 'claude', sameProvider: true })
  })

  it('cancellation mid branch-review lands Cancelled with no grade invented', async () => {
    const marker = join(root, 'reviewing.marker')
    fake({ FAKE_REVIEW: 'approve', FAKE_REVIEW_HANG: marker })
    setKeepRunning(true) // cancel must clear this, or the drain never ends
    add(docs)
    const run = startDrain(repo, base, 1, noEvents, {
      settings: { reviewer: { runner: 'gemini' } }
    })
    while (!existsSync(marker)) await new Promise((r) => setTimeout(r, 5))
    cancelPipeline()
    const [state] = await run
    expect(state.status).toBe('Cancelled')
    expect(state.review).toBeUndefined()
    expect(state.tasks.find((t) => t.title === 'Branch review')?.status).toBe('Cancelled')
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
