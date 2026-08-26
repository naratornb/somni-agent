// Handler-level coverage for the run IPC. Only the `electron` module is mocked
// (ipcMain.handle captures the handlers, app.getPath points at a temp userData);
// everything below it — git, .somni/ files — is real, run against scratch repos.
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunDetails } from './repoIpc'
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
