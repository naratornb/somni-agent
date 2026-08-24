import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runWorkflow } from './executor'
import { saveRole, saveWorkflow } from './store'

// A fake `claude` on PATH: emits a valid stream-json conversation, drops a file
// in its cwd (proving it ran inside the worktree), fails when FAKE_FAIL is set.
const FAKE_CLAUDE = `#!/bin/sh
if [ -n "$FAKE_FAIL" ]; then echo '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"boom"}'; exit 1; fi
echo '{"type":"system","subtype":"init","session_id":"s1"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"did work"}]}}'
touch task-ran-here
echo '{"type":"result","subtype":"success","is_error":false,"total_cost_usd":0.01,"duration_ms":5}'
`

let repo: string
let base: string
let savedPath: string

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'somni-exec-'))
  repo = join(root, 'repo')
  base = join(root, 'worktrees')
  const bin = join(root, 'bin')
  mkdirSync(repo)
  mkdirSync(bin)
  writeFileSync(join(bin, 'claude'), FAKE_CLAUDE)
  chmodSync(join(bin, 'claude'), 0o755)
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
      { title: 'Build', prompt: 'build it', role: 'dev', selected: true }
    ]
  })
})

afterEach(() => {
  process.env.PATH = savedPath
})

const noEvents = { onState: (): void => {}, onLog: (): void => {} }

describe('runWorkflow', () => {
  it('runs tasks sequentially in a worktree and persists run.json', async () => {
    const state = await runWorkflow(repo, 'feature', base, noEvents)
    expect(state.status).toBe('Completed')
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

  it('halts on failure and skips the rest', async () => {
    process.env.FAKE_FAIL = '1'
    try {
      const state = await runWorkflow(repo, 'feature', base, noEvents)
      expect(state.status).toBe('Failed')
      expect(state.tasks.map((t) => t.status)).toEqual(['Failed', 'Skipped'])
      expect(state.tasks[0].error).toBe('boom')
    } finally {
      delete process.env.FAKE_FAIL
    }
  })
})
