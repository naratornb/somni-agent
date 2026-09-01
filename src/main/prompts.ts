// Every prompt somni sends. The Methodology seam lives here: two adapters
// today (pocock, superpowers); adding a third touches this file and
// resources/skills/ only. The somni-question / somni-groomed / somni-verdict
// fences are somni's own protocol and never vary; their parsers stay beside
// their consumers in chat.ts / executor.ts.

import type { Methodology, Role, Task } from './store'

// The methodology-flavored halves of the preamble (docs/adr/0002). The fences,
// parsers and proposal schema below are somni's own protocol and never vary.
const CHARTERS: Record<Methodology, { opener: string[]; charter: string[] }> = {
  pocock: {
    opener: [
      'You are grooming a somni work item: turning intent into an approved Spec and',
      'tracer-bullet Stories, each executed unattended by a coding agent in an',
      'isolated git worktree of this repo. Grooming is the only path to Ready.'
    ],
    charter: [
      'Grooming charter — decide the altitude first: a big intent becomes an Epic of',
      'vertical-slice Stories, each a tracer bullet that ships end to end, with',
      'blocking edges where one genuinely must land first; a small intent is one',
      'Story. Every Spec states the problem, the approach, and verifiable success',
      'criteria. Subtask prompts are goals to achieve, never diffs to apply.'
    ]
  },
  superpowers: {
    opener: [
      'You are grooming a somni work item: turning intent into an approved Spec and',
      'Stories, each executed unattended by an orchestrating agent that works',
      'through the plan with fresh subagents in an isolated git worktree of this',
      'repo. Grooming is the only path to Ready.'
    ],
    charter: [
      'Grooming charter — brainstorm before you plan: probe the intent, surface',
      'alternatives, and cut anything speculative (YAGNI) before committing to a',
      'design. Then decide the altitude: a big intent becomes an Epic of Stories,',
      'each a coherent slice that ships end to end, with blocking edges where one',
      'genuinely must land first; a small intent is one Story. Every Spec is a',
      'written plan: the problem, the approach, and exact verifiable success',
      'criteria. Subtask prompts are bite-sized plan steps with clear done-ness —',
      'goals to achieve, never diffs to apply.'
    ]
  }
}

export function groomPreamble(
  roleSlugs: string[],
  context?: string,
  methodology: Methodology = 'pocock'
): string {
  const { opener, charter } = CHARTERS[methodology]
  return [
    ...opener,
    '',
    'Interview discipline — ask exactly ONE question per reply, as a fenced',
    '```somni-question block containing JSON of the form:',
    '{"question": "...", "options": ["...", "..."], "recommended": "..."}',
    'where "recommended" is one of the options. Keep interviewing — relentlessly,',
    'one question at a time — until every branch that changes the work is resolved.',
    'Inspect the codebase read-only to ask better questions. Never ask a question',
    'and propose in the same reply. If I ask you to propose now, stop interviewing',
    'and propose immediately, stating your assumptions.',
    '',
    ...charter,
    '',
    'When you propose, end your reply with a fenced ```somni-groomed block',
    'containing JSON of the form:',
    '{"kind": "epic"|"story", "name": "...", "spec": "...",',
    ' "stories": [{"name": "...", "spec": "...", "subtasks": [{"title": "...",',
    ' "prompt": "...", "role": "..."}], "blockedBy": [0]}],',
    ' "subtasks": [{"title": "...", "prompt": "...", "role": "..."}],',
    ' "roles": [{"slug": "...", "name": "...", "preamble": "..."}]}',
    'Use "stories" for kind "epic" and top-level "subtasks" for kind "story"',
    '(never both). "spec" is the polished Markdown Spec body. Each "blockedBy"',
    'entry is a ZERO-BASED INDEX of an EARLIER entry in the same "stories" array —',
    'never its own index, never a later one, never an id; anything else rejects the',
    'whole proposal.',
    `The repo's existing role slugs: ${roleSlugs.join(', ') || '(none defined yet)'}.`,
    'Prefer existing roles; list any genuinely new role you need under "roles"',
    '(an existing slug is never overwritten).',
    'Do not create or modify any files.',
    ...(context ? ['', 'The item being groomed, as it stands today:', context] : []),
    '',
    'My request:'
  ].join('\n')
}

export const taskTitle = (t: { title?: string }, i: number): string => t.title || `task ${i + 1}`

// The implement discipline (M16). Prompt text only — the runner adapters stay
// runner-agnostic. Prepended to every subtask *alongside* the role preamble.
const DISCIPLINE_PREAMBLE = [
  'You are working through somni, unattended, in an isolated git worktree.',
  '',
  'Discipline for this subtask:',
  '- Read the Story Spec at `{SPEC}` first. It is the contract; the subtask below is one step of it.',
  '- Work through the `implement` skill in `.claude/skills/` — TDD at the agreed seams:',
  '  a failing test first, the smallest change that passes it, then refactor.',
  '- Stay strictly within this subtask. Do not start the next one, do not refactor',
  '  code the Spec does not name, and do not add dependencies.',
  '- If the Spec and the subtask disagree, follow the Spec and say so in your reply.'
].join('\n')

/** Discipline preamble → role preamble → the subtask prompt (M16 §3). */
export function subtaskPrompt(
  specPath: string,
  rolePreamble: string | undefined,
  prompt: string
): string {
  return [DISCIPLINE_PREAMBLE.replace('{SPEC}', specPath), rolePreamble, prompt]
    .filter(Boolean)
    .join('\n\n---\n\n')
}

// Superpowers mode (docs/adr/0002): the agent orchestrates. One process runs
// the whole Story as a plan, subagent-driven; somni's engine sees exactly one
// synthetic subtask, so retries and the review loop apply at Story level.
export const PLAN_TASK_TITLE = 'Execute plan'

const PLAN_PREAMBLE = [
  'You are working through somni, unattended, in an isolated git worktree.',
  '',
  'Discipline for this run — the superpowers workflow:',
  '- Read the Story Spec at `{SPEC}` first. It is the contract for this whole run.',
  '- The plan below lists the ordered steps. Execute it with the',
  '  `executing-plans` and `subagent-driven-development` skills in `.claude/skills/`:',
  '  work through the steps in order, dispatching a fresh subagent per step and',
  '  reviewing its work before moving on.',
  '- `test-driven-development` governs every change: a failing test first, the',
  '  smallest change that passes it, then refactor. Verify each step honestly',
  '  before calling it done (`verification-before-completion`).',
  '- Stay strictly within the plan. Do not refactor code the Spec does not name,',
  '  and do not add dependencies.',
  '- If the Spec and a step disagree, follow the Spec and say so in your reply.'
].join('\n')

/** The whole Story as one prompt: discipline, then the ordered steps with their role personas. */
export function storyPlanPrompt(specPath: string, defs: Task[], roles: Role[]): string {
  const steps = defs.map((d, i) => {
    const role = roles.find((r) => r.slug === d.role)
    return [
      `## Step ${i + 1}: ${taskTitle(d, i)}`,
      ...(role?.preamble ? [`Work this step as ${role.name}:\n${role.preamble}`] : []),
      d.prompt
    ].join('\n\n')
  })
  return [PLAN_PREAMBLE.replace('{SPEC}', specPath), '# The plan', ...steps].join('\n\n---\n\n')
}

const REVIEW_SKILL: Record<Methodology, string> = {
  pocock: '`code-review`',
  superpowers: '`requesting-code-review`'
}

export const REVIEW_PROMPT = (base: string, methodology: Methodology = 'pocock'): string =>
  [
    'You are closing out an unattended coding run in this worktree.',
    '',
    `1. Code-review the full diff against \`${base}\` (\`git diff ${base}\`) using the`,
    `   ${REVIEW_SKILL[methodology]} skill in \`.claude/skills/\`: correctness, scope creep, missing tests.`,
    "2. Run this repo's test suite and report what it actually did.",
    '3. End your reply with exactly one fenced block, and nothing after it:',
    '',
    '```somni-verdict',
    '{"verdict": "green", "findings": ""}',
    '```',
    '',
    'Use "red" and put every blocking problem in `findings` (plain text, one per line)',
    'if the tests fail or the review found something that must be fixed. Do not be',
    'generous: "green" means a human could merge this as-is.'
  ].join('\n')

export const FIX_PROMPT = (findings: string, methodology: Methodology = 'pocock'): string =>
  [
    'The closing review of this worktree came back red. Fix these findings, and only these:',
    '',
    findings,
    '',
    methodology === 'superpowers'
      ? 'Debug systematically — find the root cause before fixing (`systematic-debugging`' +
        '\nin `.claude/skills/`) — and keep the TDD discipline: a failing test first where' +
        '\na test is the right proof.'
      : 'Keep the same TDD discipline: a failing test first where a test is the right proof.',
    'Do not expand scope beyond the findings.'
  ].join('\n')
