// Handler-level coverage for the run IPC. Only the `electron` module is mocked
// (ipcMain.handle captures the handlers, app.getPath points at a temp userData);
// everything below it — git, .somni/ files — is real, run against scratch repos.
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetails } from './repoIpc'
import type { Item, RepoData } from './store'
import type { RunStats } from './report'

type Handler = (event: unknown, ...args: never[]) => unknown
const handlers = new Map<string, Handler>()

vi.mock('electron', () => ({
  app: { getPath: () => userData },
  BrowserWindow: { getAllWindows: () => [] },
  dialog: {},
  ipcMain: { handle: (channel: string, fn: Handler) => handlers.set(channel, fn) },
  shell: { showItemInFolder: () => {} } // revealWorktree is a one-line passthrough, untested
}))

// The grooming guard asks the executor which story is live; everything else in
// executor (lockedGit, wakeDrain) stays real for the run handlers below.
let runningId: string | null = null
vi.mock('./executor', async (orig) => ({
  ...(await orig<typeof import('./executor')>()),
  isRunning: (id?: string) => id != null && id === runningId
}))

const { wireRepoIpc } = await import('./repoIpc')

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  Promise.resolve(handlers.get(channel)!(null, ...(args as never[]))) as Promise<T>

const git = (repo: string, ...args: string[]): string =>
  execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'] // git chatters on stderr; fixtures stay quiet
  }).trim()

let userData: string
let repo: string
let worktree: string
let baseSha: string

// A repo with two commits on `somni/feature`: baseSha, then a commit adding
// src/hello.js and editing README.md — the diff the stats handlers report on.
function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'somni-ipc-'))
  git(dir, 'init', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@somni.local')
  git(dir, 'config', 'user.name', 'somni test')
  writeFileSync(join(dir, 'README.md'), 'one\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'base')
  baseSha = git(dir, 'rev-parse', 'HEAD')
  git(dir, 'switch', '-c', 'somni/feature')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src/hello.js'), 'a\nb\nc\nd\n')
  writeFileSync(join(dir, 'README.md'), 'two\n')
  git(dir, 'add', '-A')
  git(dir, 'commit', '-m', 'feature')
  // A second branch with no worktree on it — the switchable case.
  git(dir, 'branch', 'somni/other')
  git(dir, 'switch', 'main')
  // A real linked worktree on the branch, as a run leaves behind.
  worktree = join(mkdtempSync(join(tmpdir(), 'somni-wt-')), 'wt')
  git(dir, 'worktree', 'add', worktree, 'somni/feature')
  return dir
}

function writeRun(id: string, run: Record<string, unknown>): void {
  const dir = join(repo, '.somni', 'runs', id)
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'run.json'),
    JSON.stringify({
      runId: id,
      workflow: 'w',
      name: 'Hello',
      branch: 'somni/feature',
      worktree,
      baseSha,
      status: 'Completed',
      startedAt: '2026-08-26T09:30:36.000Z',
      tasks: [],
      ...run
    })
  )
}

beforeEach(() => {
  handlers.clear()
  userData = mkdtempSync(join(tmpdir(), 'somni-userdata-'))
  repo = makeRepo()
  wireRepoIpc()
})

// Home quick-start chips (M23): cheap local git signals; [] on any failure is
// the contract — the renderer owns the static fallback.
describe('repo:suggestions', () => {
  it('derives chips from TODO counts and recent commit subjects', async () => {
    writeFileSync(join(repo, 'notes.js'), '// TODO: one\n// FIXME: two\n')
    git(repo, 'add', '-A')
    git(repo, 'commit', '-m', 'add notes')
    const chips = await invoke<string[]>('repo:suggestions', repo)
    expect(chips.some((c) => c.includes('TODO'))).toBe(true)
    expect(chips.some((c) => c.includes('add notes'))).toBe(true)
    expect(chips.length).toBeLessThanOrEqual(4)
  })

  it('returns [] on a non-git directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'somni-plain-'))
    await expect(invoke('repo:suggestions', dir)).resolves.toEqual([])
  })
})

describe('runs:switchBranch', () => {
  it('refuses a dirty target repo without touching the checkout', async () => {
    writeFileSync(join(repo, 'README.md'), 'dirty\n')
    expect(await invoke('runs:switchBranch', repo, 'somni/other')).toEqual({
      ok: false,
      error: 'repo has uncommitted changes — commit or stash first'
    })
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })

  it('checks out the branch on a clean repo', async () => {
    expect(await invoke('runs:switchBranch', repo, 'somni/other')).toEqual({ ok: true })
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('somni/other')
  })

  // git itself refuses this one; we surface its message rather than forcing it.
  it('surfaces gits refusal when a live worktree still holds the branch', async () => {
    const res = await invoke<{ ok: boolean; error?: string }>(
      'runs:switchBranch',
      repo,
      'somni/feature'
    )
    expect(res.ok).toBe(false)
    expect(res.error).toContain('already checked out')
    expect(git(repo, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
  })

  it('reports a branch that no longer exists', async () => {
    expect(await invoke('runs:switchBranch', repo, 'somni/gone')).toEqual({
      ok: false,
      error: 'branch somni/gone no longer exists'
    })
  })
})

// v1 coexistence (M13.md §4.1): a run.json written before the item-store v2
// migration carries a workflow *slug* (not a SOM-<n> id) in its frozen
// `workflow` key, and there's no matching item in items/ at all. It must still
// list and report cleanly — runs:list/runs:report don't resolve `workflow`
// against the item store.
describe('v1 run coexistence', () => {
  it('lists and reports an old-shaped run.json with a slug workflow and no matching item', async () => {
    writeRun('v1run', { workflow: 'old-workflow-slug', status: 'Completed' })
    writeFileSync(
      join(repo, '.somni', 'runs', 'v1run', 'report.md'),
      '# Old report\n\nDid the old thing.\n'
    )
    const rows = await invoke<Array<{ runId: string; workflow: string }>>('runs:list', repo)
    expect(rows.map((r) => r.runId)).toContain('v1run')
    expect(rows.find((r) => r.runId === 'v1run')!.workflow).toBe('old-workflow-slug')
    expect(await invoke('runs:report', repo, 'v1run')).toContain('Did the old thing.')
  })
})

describe('runs:details', () => {
  it('returns the persisted stats untouched', async () => {
    const stats: RunStats = {
      files: [{ path: 'gone.ts', kind: 'D', lines: 7 }],
      created: 0,
      modified: 1,
      totalCostUsd: 0.04,
      promptTokens: 12400,
      completionTokens: 1200
    }
    writeRun('r1', { stats })
    const details = await invoke<RunDetails>('runs:details', repo, 'r1')
    expect(details).toEqual({ stats, branchExists: true })
  })

  it('live-computes stats for an old run while its worktree exists', async () => {
    writeRun('r2', {
      tasks: [{ title: 't', role: 'dev', status: 'Completed', costUsd: 0.5, promptTokens: 10 }]
    })
    const { stats } = await invoke<RunDetails>('runs:details', repo, 'r2')
    // Diff is taken in the worktree against baseSha, so it sees the feature commit.
    expect(stats).toEqual({
      files: [
        { path: 'README.md', kind: 'M', lines: 2 },
        { path: 'src/hello.js', kind: 'A', lines: 4 }
      ],
      created: 1,
      modified: 1,
      totalCostUsd: 0.5,
      promptTokens: 10,
      completionTokens: undefined
    })
  })

  it('gives up on stats once the worktree is gone, branch or not', async () => {
    const wt = mkdtempSync(join(tmpdir(), 'somni-wt-'))
    rmSync(wt, { recursive: true })
    writeRun('r3', { worktree: wt })
    expect(await invoke('runs:details', repo, 'r3')).toEqual({ stats: null, branchExists: true })

    writeRun('r4', { worktree: wt, branch: 'somni/gone' })
    expect(await invoke('runs:details', repo, 'r4')).toEqual({ stats: null, branchExists: false })
  })

  it('is null-safe for an unknown run id', async () => {
    expect(await invoke('runs:details', repo, 'nope')).toEqual({
      stats: null,
      branchExists: false
    })
  })
})

// M11 Decision 1: one read-only runner call, result inert in the renderer.
// A fake `claude` on the settings path stands in for the CLI.
describe('field:refine', () => {
  const fakeClaude = (): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'somni-bin-')), 'claude')
    writeFileSync(
      path,
      '#!/bin/sh\necho \'{"type":"result","subtype":"success","is_error":false,"result":"REFINED"}\'\n',
      { mode: 0o755 }
    )
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ runner: 'claude', claudeBinary: path })
    )
    return path
  }

  it('returns the rewritten text and writes nothing to the repo', async () => {
    fakeClaude()
    expect(await invoke('field:refine', repo, 'task', 'do stuff')).toEqual({
      ok: true,
      text: 'REFINED'
    })
    expect(git(repo, 'status', '--porcelain')).toBe('')
  })

  it('refuses empty text without spawning', async () => {
    expect(await invoke('field:refine', repo, 'role', '   ')).toEqual({
      ok: false,
      error: 'nothing to refine'
    })
  })

  // §7 read-only invariant: the refine turn must carry the read-only allowlist
  // and never the autonomy bypass, regardless of kind.
  it('runs the read-only argv shape — allowedTools present, autonomy bypass absent', async () => {
    const argvLog = join(mkdtempSync(join(tmpdir(), 'somni-argvlog-')), 'argv.log')
    const path = join(mkdtempSync(join(tmpdir(), 'somni-bin-')), 'claude')
    writeFileSync(
      path,
      `#!/bin/sh\necho "$@" >> '${argvLog}'\n` +
        'echo \'{"type":"result","subtype":"success","is_error":false,"result":"ok"}\'\n',
      { mode: 0o755 }
    )
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ runner: 'claude', claudeBinary: path })
    )
    expect(await invoke('field:refine', repo, 'task', 'do stuff')).toEqual({
      ok: true,
      text: 'ok'
    })
    const argv = readFileSync(argvLog, 'utf8')
    expect(argv).toContain('--allowedTools Read,Glob,Grep')
    expect(argv).not.toContain('--dangerously-skip-permissions')
  })

  it('surfaces a failure from the runner as {ok:false, error}', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'somni-bin-')), 'claude')
    writeFileSync(
      path,
      '#!/bin/sh\necho \'{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}\'\nexit 1\n',
      { mode: 0o755 }
    )
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ runner: 'claude', claudeBinary: path })
    )
    const res = await invoke<{ ok: boolean; error?: string }>(
      'field:refine',
      repo,
      'role',
      'do stuff'
    )
    expect(res).toEqual({ ok: false, error: 'refine failed — no reply' })
  })
})

// M11 Decision 6: runner resolved in main, memoized per session so a deleted
// fixture doesn't break a second call.
describe('models:list', () => {
  const fixtureAgy = (): string => {
    const path = join(mkdtempSync(join(tmpdir(), 'somni-agy-')), 'agy')
    writeFileSync(path, '#!/bin/sh\nprintf "model-a\\tA\\nmodel-b\\tB\\n"\n', { mode: 0o755 })
    return path
  }

  it('returns parsed ids from a fake agy binary named explicitly', async () => {
    const bin = fixtureAgy()
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ antigravityBinary: bin }))
    expect(await invoke('models:list', 'antigravity')).toEqual(['model-a', 'model-b'])
  })

  it('resolves an undefined runner to the settings default, in main', async () => {
    const bin = fixtureAgy()
    writeFileSync(
      join(userData, 'settings.json'),
      JSON.stringify({ runner: 'antigravity', antigravityBinary: bin })
    )
    expect(await invoke('models:list', undefined)).toEqual(['model-a', 'model-b'])
  })

  it('serves the second call from the memo — deleting the fixture still answers', async () => {
    const bin = fixtureAgy()
    writeFileSync(join(userData, 'settings.json'), JSON.stringify({ antigravityBinary: bin }))
    const first = await invoke('models:list', 'antigravity')
    rmSync(bin)
    const second = await invoke('models:list', 'antigravity')
    expect(second).toEqual(first)
  })
})

// The Ready gate (architecture.md §4.1) is enforced in main: the UI hides
// affordances, but a hand-edited file or a rogue renderer must still be refused.
describe('item CRUD + the Ready gate', () => {
  const story = async (over: object = {}): Promise<Item> =>
    invoke<Item>('item:save', repo, {
      name: 'Ship it',
      kind: 'story',
      status: 'backlog',
      spec: 'the spec',
      tasks: [{ title: 'T', prompt: 'p', role: 'dev', selected: true }],
      ...over
    })

  it('repo:load seeds the default SDLC roles on first open', async () => {
    const { roles } = await invoke<RepoData>('repo:load', repo)
    expect(roles.map((r) => r.slug)).toContain('developer')
    expect(roles).toHaveLength(7)
  })

  it('creates, reads back, reorders the backlog and deletes', async () => {
    const a = await story()
    expect(a.id).toBe('SOM-1')
    expect((await invoke<RepoData>('repo:load', repo)).items).toEqual([a])
    await invoke('backlog:set', repo, [a.id])
    expect((await invoke<RepoData>('repo:load', repo)).backlog).toEqual([a.id])
    await invoke('item:delete', repo, a.id)
    const data = await invoke<RepoData>('repo:load', repo)
    expect(data.items).toEqual([])
    expect(data.backlog).toEqual([]) // the deleted id leaves the ordering too
  })

  it('allows ready for a groomed story and any non-ready status freely', async () => {
    const a = await story()
    expect(await invoke('item:setStatus', repo, a.id, 'ready')).toEqual({ ok: true })
    expect(await invoke('item:setStatus', repo, a.id, 'grooming')).toEqual({ ok: true })
    expect((await invoke<RepoData>('repo:load', repo)).items[0].status).toBe('grooming')
  })

  it('refuses ready for an empty spec, zero subtasks, zero *selected* subtasks and a non-story', async () => {
    const cases: [object, RegExp][] = [
      [{ spec: '   ' }, /empty Spec/],
      [{ tasks: [] }, /no selected subtasks/],
      [{ tasks: [{ title: 'T', prompt: 'p', role: 'dev', selected: false }] }, /no selected/],
      [{ kind: 'idea' }, /only a Story/],
      [{ kind: 'epic' }, /only a Story/]
    ]
    for (const [over, why] of cases) {
      const a = await story(over)
      const res = await invoke<{ ok: boolean; error?: string }>(
        'item:setStatus',
        repo,
        a.id,
        'ready'
      )
      expect(res.ok).toBe(false)
      expect(res.error).toMatch(why)
      // refused means nothing moved
      const items = (await invoke<RepoData>('repo:load', repo)).items
      expect(items.find((i) => i.id === a.id)!.status).toBe('backlog')
    }
  })

  // TD ruling 3: the Backlog column's ordering is never partial.
  it('appends a newly created backlog item to the ordering, but only on create', async () => {
    const a = await story()
    const b = await story({ name: 'Second' })
    expect((await invoke<RepoData>('repo:load', repo)).backlog).toEqual([a.id, b.id])
    // a non-backlog create stays out of the ordering
    const c = await story({ name: 'Third', status: 'grooming' })
    expect((await invoke<RepoData>('repo:load', repo)).backlog).toEqual([a.id, b.id])
    // re-saving an existing item never re-appends or reorders
    await invoke('backlog:set', repo, [b.id, a.id])
    await invoke('item:save', repo, { ...a, spec: 'edited' })
    await invoke('item:save', repo, { ...c, status: 'backlog' })
    expect((await invoke<RepoData>('repo:load', repo)).backlog).toEqual([b.id, a.id])
  })

  it('refuses a status change for an item that is not there', async () => {
    expect(await invoke('item:setStatus', repo, 'SOM-99', 'done')).toEqual({
      ok: false,
      error: 'item not found: SOM-99'
    })
  })
})

// §7: grooming is refused for a story the pipeline is executing — re-grooming
// under a running agent would rewrite the spec out from under it.
describe('chat:send guard', () => {
  // ponytail: only the refusal path is exercised — the allowed path spawns a
  // real runner, which chat.test.ts already covers against a fake claude.
  it('refuses a story currently running', async () => {
    runningId = 'SOM-1'
    expect(await invoke('chat:send', repo, 'SOM-1', 'hi')).toEqual({
      ok: false,
      error: 'this story is currently running'
    })
    runningId = null
  })
})
