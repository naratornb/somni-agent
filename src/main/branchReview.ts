// Branch Review (M28, spec §1-3): the pure half — parsing, reviewer selection,
// diff capping, prompts. The executor owns the turns; the merge IPC owns git.

import type { Effort, RunnerName, Settings } from './store'
import { providerChain, RUNNER_NAMES } from './store'
import { isAvailable } from './providers'

export type BranchGrade = 'approve' | 'needs-work' | 'reject' | 'ungraded'
export type BranchReview = {
  grade: BranchGrade
  reasons: string[]
  findings: string[]
  provider: RunnerName
  sameProvider?: boolean
  diffTruncated?: boolean
  fixRound?: boolean
  merged?: string
}

const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []

// Last ```somni-review block (the somni-verdict idiom). Malformed is
// needs-work, never a crash — the §10 "malformed is red" precedent.
export function parseReview(text: string): Pick<BranchReview, 'grade' | 'reasons' | 'findings'> {
  const blocks = [...text.matchAll(/```somni-review[^\n]*\n([\s\S]*?)\n```/g)]
  const last = blocks[blocks.length - 1]
  try {
    const raw = JSON.parse(last![1]) as Record<string, unknown>
    if (raw.grade !== 'approve' && raw.grade !== 'needs-work' && raw.grade !== 'reject')
      throw new Error('bad grade')
    return { grade: raw.grade, reasons: strings(raw.reasons), findings: strings(raw.findings) }
  } catch {
    return {
      grade: 'needs-work',
      reasons: ['the review reply carried no parseable somni-review verdict'],
      findings: ['Re-review: the previous reply had no parseable somni-review block.']
    }
  }
}

// The provider that "wrote" the story: majority across subtask runners,
// ties to first seen (spec §2).
export function implementerOf(runners: (RunnerName | undefined)[]): RunnerName {
  const counts = new Map<RunnerName, number>()
  for (const r of runners) if (r) counts.set(r, (counts.get(r) ?? 0) + 1)
  let best: RunnerName = 'claude'
  let n = 0
  for (const r of runners) {
    if (!r) continue
    const c = counts.get(r) ?? 0
    if (c > n) {
      best = r
      n = c
    }
  }
  return best
}

// Cross-provider by default; a pinned reviewer wins outright; nobody-else
// available falls back honestly (spec §2).
export function pickReviewer(
  settings: Settings,
  implementer: RunnerName
): { runner: RunnerName; model?: string; effort?: Effort; sameProvider: boolean } {
  const pin = settings.reviewer
  if (pin?.runner && RUNNER_NAMES.includes(pin.runner as RunnerName)) {
    const runner = pin.runner as RunnerName
    return { runner, model: pin.model, effort: pin.effort, sameProvider: runner === implementer }
  }
  const other = providerChain(settings).find((n) => n !== implementer && isAvailable(n, settings))
  return other
    ? { runner: other, sameProvider: false }
    : { runner: implementer, sameProvider: true }
}

export const DIFF_CAP = 150_000

// Whole-file hunks until the cap; the stat + file list always survive, so a
// truncated review still knows what it did not see (spec §1).
export function capDiff(
  stat: string,
  fileDiffs: { file: string; diff: string }[]
): { body: string; truncated: boolean } {
  const parts: string[] = [stat, '']
  let used = 0
  let truncated = false
  for (const f of fileDiffs) {
    if (used + f.diff.length > DIFF_CAP) {
      truncated = true
      parts.push(`[diff for ${f.file} omitted — over the size cap]`)
      continue
    }
    used += f.diff.length
    parts.push(f.diff)
  }
  return { body: parts.join('\n'), truncated }
}

export const BRANCH_REVIEW_PROMPT = (
  spec: string,
  subtaskPrompts: string[],
  diffBody: string
): string =>
  [
    'You are the merge reviewer for an unattended coding run. Everything you need',
    'is in this message — do not run commands, modify files, or use tools.',
    '',
    'The Story spec:',
    spec,
    '',
    'The subtasks that were executed:',
    ...subtaskPrompts.map((p, i) => `${i + 1}. ${p}`),
    '',
    'The full branch diff:',
    diffBody,
    '',
    'Grade whether a careful human should merge this branch:',
    '- "approve": merge as-is.',
    '- "needs-work": right direction, concrete fixable problems (list them in findings).',
    '- "reject": fundamentally wrong or unsafe — a patch will not save it.',
    'End your reply with exactly one fenced block, and nothing after it:',
    '',
    '```somni-review',
    '{"grade": "approve", "reasons": ["…"], "findings": ["…"]}',
    '```',
    '',
    '`reasons` is the short human-facing why; `findings` are the concrete items a',
    'fix pass would act on (empty for approve). Do not be generous.'
  ].join('\n')

export const BRANCH_FIX_PROMPT = (findings: string[]): string =>
  [
    'The merge review of this worktree came back needs-work. Fix these findings, and only these:',
    '',
    ...findings.map((f) => `- ${f}`),
    '',
    'Commit your fixes in this worktree. Do not expand scope.'
  ].join('\n')
