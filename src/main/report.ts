// Summary reports (architecture.md §6) written to runs/<runId>/report.md.
// Minimal is app-computed (zero tokens); compact adds one read-only claude call;
// full appends a "Report" task run with full autonomy in the worktree.

import { execFile } from 'child_process'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { spawnRunner } from './runner'
import { getRunner, RunnerOpts } from './runners'
import { atomicWrite, Settings } from './store'
import type { RunState, TaskRun } from './executor'

const git = promisify(execFile)

export type Stats = {
  diffStat: string
  created: number
  modified: number
  testFiles: string[]
}

// Structured per-run stats persisted into run.json alongside report.md, so the
// Runs view can show the morning report without re-running git.
export type FileChange = { path: string; kind: 'A' | 'M' | 'D'; lines: number }
export type RunStats = {
  files: FileChange[]
  created: number
  modified: number
  totalCostUsd?: number
  promptTokens?: number
  completionTokens?: number
}

const isTest = (path: string): boolean => /test|spec/i.test(path)

const lastField = (cols: string[]): string => cols[cols.length - 1]

// `--numstat` gives added/deleted per file but not the change kind; `--name-status`
// gives the kind. Join them on the (post-rename) path.
export function fileChanges(nameStatus: string, numstat: string): FileChange[] {
  const kinds = new Map(
    nameStatus
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const cols = l.split('\t')
        return [lastField(cols), cols[0][0]] as const
      })
  )
  return numstat
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [added, deleted, ...rest] = l.split('\t')
      const path = lastField(rest)
      const kind = kinds.get(path)
      return {
        path,
        kind: kind === 'A' || kind === 'D' ? kind : ('M' as const),
        // Binary files report "-" for both counts.
        lines: (Number(added) || 0) + (Number(deleted) || 0)
      }
    })
}

const gitOut = async (worktree: string, args: string[]): Promise<string> =>
  (await git('git', ['-C', worktree, ...args])).stdout

export async function diffFiles(worktree: string, base = 'HEAD'): Promise<FileChange[]> {
  return fileChanges(
    await gitOut(worktree, ['diff', '--name-status', base]),
    await gitOut(worktree, ['diff', '--numstat', base])
  )
}

// Totals come from the task runs; a field stays undefined when no task reported it
// (agy has no cost, an interrupted run may have no usage at all).
export function runStats(state: RunState, files: FileChange[]): RunStats {
  const sum = (pick: (t: TaskRun) => number | undefined): number | undefined => {
    const vals = state.tasks.map(pick).filter((v): v is number => typeof v === 'number')
    return vals.length ? vals.reduce((a, b) => a + b, 0) : undefined
  }
  return {
    files,
    created: files.filter((f) => f.kind === 'A').length,
    modified: files.filter((f) => f.kind !== 'A').length,
    totalCostUsd: sum((t) => t.costUsd),
    promptTokens: sum((t) => t.promptTokens),
    completionTokens: sum((t) => t.completionTokens)
  }
}

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

// The closing review loop (M16). §10 is explicit that a green with no
// checkCommand means "the agent said so" — the report says exactly that.
export function reviewSection(state: RunState): string[] {
  if (!state.reviews?.length) return []
  return [
    '## Review',
    '',
    ...state.reviews.flatMap((r) => [
      `### Cycle ${r.cycle} — ${r.green ? 'green' : 'red'}`,
      '',
      `- Agent verdict: ${r.verdict}`,
      r.check
        ? `- checkCommand \`${r.check.command}\`: ${r.check.ok ? 'passed' : 'FAILED'}`
        : '- checkCommand: not configured — green means the agent said so',
      ...(r.findings ? ['', '```', r.findings, '```'] : []),
      ''
    ])
  ]
}

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
    '',
    ...reviewSection(state)
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

// One runner call, final text out (every adapter puts the full reply on the
// result event). Resolves to null on any failure — a report must never be the
// thing that fails a run. Second consumer: `field:refine` in repoIpc.ts (M11).
export function runnerText(
  settings: Settings,
  prompt: string,
  opts: RunnerOpts,
  cwd: string,
  logPath?: string,
  // Lets a caller record the run's cost/usage on a TaskRun (M16's review loop).
  onUsage?: (
    usage: Pick<TaskRun, 'costUsd' | 'promptTokens' | 'completionTokens' | 'durationMs'>
  ) => void
): Promise<string | null> {
  const runner = getRunner(settings.runner, settings)
  let out = ''
  const handle = spawnRunner(
    runner,
    runner.buildArgs(prompt, { model: settings.model, effort: settings.effort, ...opts }),
    cwd,
    (ev) => {
      if (ev.kind === 'result') {
        if (ev.detail) out = ev.detail
        onUsage?.({
          costUsd: ev.costUsd,
          promptTokens: ev.promptTokens,
          completionTokens: ev.completionTokens,
          durationMs: ev.durationMs
        })
      }
    },
    (chunk) => {
      if (logPath) appendFileSync(logPath, chunk)
    }
  )
  return handle.done.then(({ ok }) => (ok && out.trim() ? out.trim() : null))
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
    // Read-only: never an autonomous turn here (§7 chat rules).
    const text = await runnerText(settings, prompt, { readOnly: true }, state.worktree).catch(
      () => null
    )
    body += text ? `\n## Summary\n\n${text}\n` : '\n_(summary call failed — minimal report only)_\n'
  }

  if (settings.reportStyle === 'full') {
    // ponytail: the report task is spawned directly rather than threaded through
    // execute()'s retry/gate loop — it must never fail the run, and one shot is
    // enough. Give it retries if report tasks turn out to flake.
    const task: TaskRun = {
      title: 'Report',
      role: '',
      aux: true,
      status: 'Running',
      log: 'logs/report.log'
    }
    task.runner = settings.runner
    state.tasks.push(task)
    const text = await runnerText(
      settings,
      REPORT_PROMPT,
      { autonomous: true },
      state.worktree,
      join(runDir, task.log)
    ).catch(() => null)
    task.status = text ? 'Completed' : 'Failed'
    if (!text) task.error = 'report task produced no output'
    body += text ? `\n## Summary\n\n${text}\n` : '\n_(report task failed — minimal report only)_\n'
  }

  // Persisted on the state; the executor's final writeState() lands it in run.json.
  // Computed last so a full-style Report task's cost is inside the totals.
  const files = await diffFiles(state.worktree, state.baseSha ?? 'HEAD').catch(() => [])
  state.stats = runStats(state, files)

  atomicWrite(join(runDir, 'report.md'), body)
}
