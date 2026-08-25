// Summary reports (architecture.md §6) written to runs/<runId>/report.md.
// Minimal is app-computed (zero tokens); compact adds one read-only claude call;
// full appends a "Report" task run with full autonomy in the worktree.

import { execFile } from 'child_process'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { spawnClaude } from './runner'
import { atomicWrite, Profile, Settings } from './store'
import type { RunState, TaskRun } from './executor'

const git = promisify(execFile)

export type Stats = {
  diffStat: string
  created: number
  modified: number
  testFiles: string[]
}

const isTest = (path: string): boolean => /test|spec/i.test(path)

export function summarize(nameStatus: string, diffStat: string): Stats {
  const rows = nameStatus
    .split('\n')
    .filter(Boolean)
    .map((l) => l.split('\t'))
  return {
    diffStat: diffStat.trim(),
    created: rows.filter((r) => r[0].startsWith('A')).length,
    modified: rows.filter((r) => !r[0].startsWith('A')).length,
    testFiles: rows.map((r) => r[r.length - 1]).filter(isTest)
  }
}

const duration = (ms?: number): string => (ms == null ? '—' : `${Math.round(ms / 1000)}s`)
const cost = (n?: number): string => (n == null ? '—' : `$${n.toFixed(4)}`)

export function minimalReport(state: RunState, stats: Stats): string {
  const total = state.tasks.reduce((c, t) => c + (t.costUsd ?? 0), 0)
  const time = state.tasks.reduce((c, t) => c + (t.durationMs ?? 0), 0)
  return [
    `# ${state.name} — ${state.status}`,
    '',
    `- Run: \`${state.runId}\` · branch \`${state.branch}\``,
    `- Started ${state.startedAt}${state.finishedAt ? ` · finished ${state.finishedAt}` : ''}`,
    `- Files created ${stats.created} · modified ${stats.modified}`,
    `- Test files touched: ${stats.testFiles.length ? stats.testFiles.join(', ') : 'none'}`,
    '',
    '## Tasks',
    '',
    '| Task | Status | Duration | Cost | Error |',
    '| --- | --- | --- | --- | --- |',
    ...state.tasks.map(
      (t) =>
        `| ${t.title} | ${t.status} | ${duration(t.durationMs)} | ${cost(t.costUsd)} | ${t.error ?? ''} |`
    ),
    `| **Total** | | ${duration(time)} | ${cost(total)} | |`,
    '',
    '## Changes',
    '',
    '```',
    stats.diffStat || '(no changes)',
    '```',
    ''
  ].join('\n')
}

async function collectStats(state: RunState): Promise<Stats> {
  // Diff the worktree (including uncommitted work) against the branch base.
  const base = state.baseSha ?? 'HEAD'
  const run = async (args: string[]): Promise<string> => {
    const { stdout } = await git('git', ['-C', state.worktree, ...args])
    return stdout
  }
  return summarize(await run(['diff', '--name-status', base]), await run(['diff', '--stat', base]))
}

const profileArgs = (p: Profile): string[] => [
  ...(p.model ? ['--model', p.model] : []),
  ...(p.effort ? ['--effort', p.effort] : [])
]

// One claude call, plain text out. Resolves to null on any failure — a report
// must never be the thing that fails a run.
function claudeText(args: string[], cwd: string, logPath?: string): Promise<string | null> {
  let out = ''
  const handle = spawnClaude(
    ['-p', ...args],
    cwd,
    () => {},
    (chunk) => {
      out += chunk
      if (logPath) appendFileSync(logPath, chunk)
    }
  )
  return handle.done.then(({ code }) => (code === 0 && out.trim() ? out.trim() : null))
}

const REPORT_PROMPT =
  'Summarize what was done in this branch for a morning review: what changed, ' +
  'why, anything left unfinished or needing attention. Markdown, no preamble.'

export async function writeReport(
  repo: string,
  state: RunState,
  settings: Settings
): Promise<void> {
  const runDir = join(repo, '.somni', 'runs', state.runId)
  const stats = await collectStats(state).catch(() => ({
    diffStat: '(diff unavailable)',
    created: 0,
    modified: 0,
    testFiles: []
  }))
  let body = minimalReport(state, stats)
  const profile = profileArgs(settings)

  if (settings.reportStyle === 'compact') {
    const prompt = [
      'Write one prose paragraph summarizing this overnight coding run for a morning review.',
      'No preamble, no headings.',
      '',
      `Workflow: ${state.name} (${state.status})`,
      ...state.tasks.map((t) => `- ${t.title}: ${t.status}${t.error ? ` — ${t.error}` : ''}`),
      '',
      'Diff stat:',
      stats.diffStat
    ].join('\n')
    // Read-only: no --dangerously-skip-permissions here (§7 chat rules).
    const text = await claudeText(
      [prompt, '--allowedTools', 'Read,Glob,Grep', ...profile],
      state.worktree
    ).catch(() => null)
    body += text ? `\n## Summary\n\n${text}\n` : '\n_(summary call failed — minimal report only)_\n'
  }

  if (settings.reportStyle === 'full') {
    // ponytail: the report task is spawned directly rather than threaded through
    // execute()'s retry/gate loop — it must never fail the run, and one shot is
    // enough. Give it retries if report tasks turn out to flake.
    const task: TaskRun = {
      title: 'Report',
      role: '',
      status: 'Running',
      log: 'logs/report.log'
    }
    state.tasks.push(task)
    const text = await claudeText(
      [REPORT_PROMPT, '--dangerously-skip-permissions', ...profile],
      state.worktree,
      join(runDir, task.log)
    ).catch(() => null)
    task.status = text ? 'Completed' : 'Failed'
    if (!text) task.error = 'report task produced no output'
    body += text ? `\n## Summary\n\n${text}\n` : '\n_(report task failed — minimal report only)_\n'
  }

  atomicWrite(join(runDir, 'report.md'), body)
}
