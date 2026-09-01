// Grooming chat (architecture.md §7). Each turn is the same read-only
// claude spawn path as task execution; the chat never writes definitions —
// `applyProposal` below is the one user-triggered mutation.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { spawnRunner, SpawnHandle } from './runner'
import { getRunner } from './runners'
import * as store from './store'
import type { Effort, Item, Methodology, Profile, Role, RunnerName, Settings, Task } from './store'

// Reserved chat key for the one pre-Apply from-scratch groom (§7, Decision 1).
export const DRAFT_KEY = '_draft'

export type ChatMessage = { role: 'user' | 'assistant'; text: string; ts: string }
// One proposed child Story. `blockedBy` holds *indices* of earlier entries in
// the same array — Apply resolves them to real ids (§7).
export type GroomedStory = { name: string; spec: string; tasks: Task[]; blockedBy: number[] }
export type ChatProposal = {
  kind: 'epic' | 'story'
  name: string
  spec: string
  stories: GroomedStory[] // epics only
  tasks: Task[] // single-story proposals only
  roles: Role[]
}
export type ChatQuestion = { question: string; options: string[]; recommended: string }
export type ChatEvent =
  | { slug: string; kind: 'text'; text: string }
  | {
      slug: string
      kind: 'done'
      message: ChatMessage
      proposal: ChatProposal | null
      question: ChatQuestion | null
    }
  | { slug: string; kind: 'error'; message: string }

const chatPath = (repo: string, slug: string): string =>
  join(repo, '.somni', 'chats', slug + '.jsonl')

// The fixed message Propose Now sends — visible in the transcript (Decision 4).
export const PROPOSE_NOW =
  'Stop interviewing and propose the groomed result now, from my answers so far ' +
  'plus your own stated assumptions for anything still open.'

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

// Both agy and claude support multi-turn resume (`--conversation` / `--resume`,
// both verified against the installed CLIs), so the §5 "chat falls back to
// ClaudeRunner" escape hatch isn't needed — the chat uses the profile's runner.
const chatRunner = (profile: Profile, settings: Settings): ReturnType<typeof getRunner> =>
  getRunner(profile.runner, settings)

// Args for one turn. First turn carries the preamble; later turns resume.
export function turnArgs(
  message: string,
  sessionId: string | null,
  profile: Profile,
  roleSlugs: string[],
  settings: Settings = {},
  context?: string
): string[] {
  return chatRunner(profile, settings).buildArgs(
    sessionId ? message : `${groomPreamble(roleSlugs, context, settings.methodology)}\n${message}`,
    { ...profile, resumeSessionId: sessionId ?? undefined, readOnly: true }
  )
}

// Last fenced `kind` block in an assistant message, parsed as JSON, or null.
// The closing fence is anchored to the start of its own line: JSON escapes
// newlines inside strings, so a real line break before ``` can only be the
// block terminator — a fence *inside* a prompt string no longer truncates it.
function lastBlock(text: string, kind: string): Record<string, unknown> | null {
  const blocks = [...text.matchAll(new RegExp('```' + kind + '[^\\n]*\\n([\\s\\S]*?)\\n```', 'g'))]
  const last = blocks[blocks.length - 1]
  if (!last) return null
  try {
    return JSON.parse(last[1]) as Record<string, unknown>
  } catch {
    return null
  }
}

// Last ```somni-question block, or null if absent/malformed (degrades to text).
export function parseQuestion(text: string): ChatQuestion | null {
  const raw = lastBlock(text, 'somni-question')
  if (typeof raw?.question !== 'string' || !Array.isArray(raw.options)) return null
  const options = raw.options.filter((o): o is string => typeof o === 'string')
  if (options.length !== raw.options.length || options.length === 0) return null
  const recommended = typeof raw.recommended === 'string' ? raw.recommended : ''
  return {
    question: raw.question,
    options,
    recommended: options.includes(recommended) ? recommended : ''
  }
}

const isEffort = (v: unknown): v is Effort => ['low', 'medium', 'high'].includes(v as string)

// Optional new roles on a proposal (Decision 5). An invalid entry rejects the
// whole proposal rather than silently dropping a role the tasks reference.
function parseRoles(raw: unknown): Role[] | null {
  if (raw === undefined) return []
  if (!Array.isArray(raw)) return null
  const roles: Role[] = []
  for (const r of raw as Record<string, unknown>[]) {
    if (typeof r?.slug !== 'string' || typeof r.name !== 'string' || typeof r.preamble !== 'string')
      return null
    roles.push({
      slug: r.slug,
      name: r.name,
      preamble: r.preamble,
      ...(store.RUNNER_NAMES.includes(r.runner as RunnerName)
        ? { runner: r.runner as RunnerName }
        : {}),
      ...(typeof r.model === 'string' ? { model: r.model } : {}),
      ...(isEffort(r.effort) ? { effort: r.effort } : {})
    })
  }
  return roles
}

// A proposal's subtask list. One invalid entry rejects the whole proposal.
function parseSubtasks(raw: unknown): Task[] | null {
  if (!Array.isArray(raw)) return null
  const tasks: Task[] = []
  for (const t of raw as Record<string, unknown>[]) {
    if (typeof t?.title !== 'string' || typeof t.prompt !== 'string' || typeof t.role !== 'string')
      return null
    tasks.push({ title: t.title, prompt: t.prompt, role: t.role, selected: t.selected !== false })
  }
  return tasks
}

// Child Stories of an epic proposal. `blockedBy` may only point *backwards*: a
// forward, self or out-of-range index rejects the proposal (the invalid-role
// precedent) rather than silently dropping an edge the plan depends on.
function parseStories(raw: unknown): GroomedStory[] | null {
  if (!Array.isArray(raw)) return null
  const stories: GroomedStory[] = []
  for (const [i, s] of (raw as Record<string, unknown>[]).entries()) {
    if (typeof s?.name !== 'string') return null
    const tasks = parseSubtasks(s.subtasks)
    if (!tasks) return null
    const blockedBy = s.blockedBy === undefined ? [] : s.blockedBy
    if (!Array.isArray(blockedBy)) return null
    if (blockedBy.some((b) => !Number.isInteger(b) || (b as number) < 0 || (b as number) >= i))
      return null
    stories.push({
      name: s.name,
      spec: typeof s.spec === 'string' ? s.spec : '',
      tasks,
      blockedBy: blockedBy as number[]
    })
  }
  return stories
}

// Last ```somni-groomed block in an assistant message, or null if absent/malformed.
export function parseProposal(text: string): ChatProposal | null {
  const raw = lastBlock(text, 'somni-groomed')
  if (typeof raw?.name !== 'string') return null
  if (raw.kind !== 'epic' && raw.kind !== 'story') return null
  const roles = parseRoles(raw.roles)
  if (!roles) return null
  const stories = raw.kind === 'epic' ? parseStories(raw.stories) : []
  const tasks = raw.kind === 'story' ? parseSubtasks(raw.subtasks) : []
  if (!stories || !tasks) return null
  return {
    kind: raw.kind,
    name: raw.name,
    spec: typeof raw.spec === 'string' ? raw.spec : '',
    stories,
    tasks,
    roles
  }
}

type Line = ChatMessage | { sessionId: string }

function readLines(repo: string, slug: string): Line[] {
  const path = chatPath(repo, slug)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8')
    .split('\n')
    .flatMap((l) => {
      try {
        return l.trim() ? [JSON.parse(l) as Line] : []
      } catch {
        return []
      }
    })
}

// ponytail: plain append of one JSON line — a partial trailing line is skipped
// on read, which is all the durability a transcript needs.
function appendLine(repo: string, slug: string, line: Line): void {
  const path = chatPath(repo, slug)
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(line) + '\n')
}

const sessionOf = (lines: Line[]): string | null => {
  for (let i = lines.length - 1; i >= 0; i--) {
    const s = (lines[i] as { sessionId?: string }).sessionId
    if (s) return s
  }
  return null
}

export function loadChat(repo: string, slug: string): { messages: ChatMessage[]; busy: boolean } {
  const messages = readLines(repo, slug).filter((l): l is ChatMessage => 'role' in l)
  return { messages, busy: inFlight.has(slug) }
}

export function newChat(repo: string, slug: string): void {
  rmSync(chatPath(repo, slug), { force: true })
}

const inFlight = new Map<string, SpawnHandle>()

export function sendChat(
  repo: string,
  slug: string,
  text: string,
  settings: Settings,
  roleSlugs: string[],
  onEvent: (ev: ChatEvent) => void
): { ok: boolean; error?: string } {
  const profile: Profile = settings
  if (inFlight.has(slug)) return { ok: false, error: 'a chat turn is already in flight' }
  const lines = readLines(repo, slug)
  let sessionId = sessionOf(lines)
  appendLine(repo, slug, { role: 'user', text, ts: new Date().toISOString() })
  // An item-keyed groom seeds turn-1 context with the item as it stands, and
  // the first turn moves it into Grooming (§7). A from-scratch groom has no
  // item to seed or flip — it creates nothing until Apply.
  const item = slug === DRAFT_KEY ? undefined : store.loadItems(repo).find((i) => i.id === slug)
  let context: string | undefined
  if (item) {
    context = `# ${item.name}\n\n${item.spec}`.trim()
    if (item.status !== 'grooming') store.setItemStatus(repo, item.id, 'grooming')
  }

  let reply = ''
  const handle = spawnRunner(
    chatRunner(profile, settings),
    turnArgs(text, sessionId, profile, roleSlugs, settings, context),
    repo,
    (ev) => {
      if (ev.kind === 'session' && ev.sessionId !== sessionId) {
        sessionId = ev.sessionId
        appendLine(repo, slug, { sessionId: ev.sessionId })
      }
      if (ev.kind === 'text') {
        reply += ev.text
        onEvent({ slug, kind: 'text', text: ev.text })
      }
      if (ev.kind === 'spawn-error') onEvent({ slug, kind: 'error', message: ev.message })
    }
  )
  inFlight.set(slug, handle)
  void handle.done.then(({ code }) => {
    inFlight.delete(slug)
    if (!reply.trim()) {
      onEvent({ slug, kind: 'error', message: `chat turn failed (exit ${code})` })
      return
    }
    const message: ChatMessage = { role: 'assistant', text: reply, ts: new Date().toISOString() }
    appendLine(repo, slug, message)
    onEvent({
      slug,
      kind: 'done',
      message,
      proposal: parseProposal(reply),
      question: parseQuestion(reply)
    })
  })
  return { ok: true }
}

// Apply — the only mutation out of a groom, and it lives here so every write
// stays in main (§7). The groomed item converts in place, keeping its id;
// child Stories are created ready with their blockedBy indices resolved to real
// ids. From-scratch (`key` = _draft) it creates the item(s) and renames the
// transcript onto the root item's id.
export function applyProposal(
  repo: string,
  key: string,
  proposal: ChatProposal
): { ok: true; item: Item } | { ok: false; error: string } {
  // Applying mid-turn would rename the transcript out from under the reply
  // still being appended to it.
  if (inFlight.has(key)) return { ok: false, error: 'a chat turn is already in flight' }
  const scratch = key === DRAFT_KEY
  const { roles, items } = store.loadRepo(repo)
  const existing = scratch ? undefined : items.find((i) => i.id === key)
  if (!scratch && !existing) return { ok: false, error: `item not found: ${key}` }
  const roleSlugs = new Set(roles.map((r) => r.slug))
  for (const role of proposal.roles) {
    if (!roleSlugs.has(role.slug)) store.saveRole(repo, role) // existing role always wins
  }
  // An Epic never executes, so it lands back in Backlog; a groomed Story is
  // Ready by definition — the Spec and its Subtasks just got approved.
  const root = store.saveItem(repo, {
    ...existing,
    slug: store.slugify(proposal.name), // a renamed item moves file, keeping its id
    kind: proposal.kind,
    status: proposal.kind === 'epic' ? 'backlog' : 'ready',
    name: proposal.name,
    spec: proposal.spec,
    tasks: proposal.kind === 'story' ? proposal.tasks : []
  })
  const childIds: string[] = []
  for (const story of proposal.stories) {
    const child = store.saveItem(repo, {
      kind: 'story',
      status: 'ready',
      name: story.name,
      spec: story.spec,
      tasks: story.tasks,
      epic: root.id,
      blockedBy: story.blockedBy.map((i) => childIds[i])
    })
    childIds.push(child.id)
  }
  if (scratch) {
    // Mirrors `item:save`: a new Backlog item joins the column's ordering.
    if (root.status === 'backlog') store.saveBacklog(repo, [...store.loadBacklog(repo), root.id])
    mkdirSync(dirname(chatPath(repo, root.id)), { recursive: true })
    if (existsSync(chatPath(repo, DRAFT_KEY)))
      renameSync(chatPath(repo, DRAFT_KEY), chatPath(repo, root.id))
  }
  return { ok: true, item: root }
}

export function killChats(): void {
  for (const handle of inFlight.values()) handle.kill()
}
