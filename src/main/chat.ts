// "Draft with AI" chat (architecture.md §7). Each turn is the same read-only
// claude spawn path as task execution; the chat never writes definitions —
// `applyProposal` below is the one user-triggered mutation.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { spawnRunner, SpawnHandle } from './runner'
import { getRunner } from './runners'
import * as store from './store'
import type { Effort, Profile, Role, RunnerName, Settings, Task, Workflow } from './store'

// Reserved chat key for the one pre-Apply brief-first draft (§7, Decision 1).
export const DRAFT_KEY = '_draft'

export type ChatMessage = { role: 'user' | 'assistant'; text: string; ts: string }
export type ChatProposal = { name: string; brief: string; tasks: Task[]; roles: Role[] }
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
  'Stop interviewing and propose the workflow now, from my answers so far plus ' +
  'your own stated assumptions for anything still open.'

// The fixed Refine structure message (M11 Decision 3). Deliberately silent on
// the proposal format — the preamble's somni-workflow instruction covers it, so
// the reply lands as an ordinary Proposal.
export const REFINE_STRUCTURE =
  "Reread this workflow's current definition and propose a refined version now: " +
  'tighter task boundaries, better ordering, sharper prompts, the right role for ' +
  'each task. Keep the intent — refine how it gets there.'

export function draftPreamble(roleSlugs: string[], brief?: string, slug?: string): string {
  return [
    'You are helping draft a somni workflow: an ordered list of tasks, each run',
    'unattended by a coding agent in an isolated git worktree of this repo.',
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
    'When you propose, end your reply with a fenced ```somni-workflow block',
    'containing JSON of the form:',
    '{"name": "...", "brief": "...", "tasks": [{"title": "...", "prompt": "...",',
    '"role": "...", "selected": true}], "roles": [{"slug": "...", "name": "...",',
    '"preamble": "..."}]}',
    'where "brief" is the polished Markdown brief for the whole workflow, "prompt"',
    'is a full self-contained brief for that task, and "role" is a role slug.',
    `The repo's existing role slugs: ${roleSlugs.join(', ') || '(none defined yet)'}.`,
    'Prefer existing roles; list any genuinely new role you need under "roles"',
    '(an existing slug is never overwritten).',
    'Do not create or modify any files.',
    // Editor chats only: without this a structure refine is structure-blind.
    ...(slug
      ? [
          `This chat edits the existing workflow stored at \`.somni/workflows/${slug}.json\`;`,
          'read it for the current structure.'
        ]
      : []),
    ...(brief ? ['', "This workflow's current brief:", brief] : []),
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
  brief?: string,
  slug?: string
): string[] {
  return chatRunner(profile, settings).buildArgs(
    sessionId ? message : `${draftPreamble(roleSlugs, brief, slug)}\n${message}`,
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

// Last ```somni-workflow block in an assistant message, or null if absent/malformed.
export function parseProposal(text: string): ChatProposal | null {
  const raw = lastBlock(text, 'somni-workflow')
  if (typeof raw?.name !== 'string' || !Array.isArray(raw.tasks)) return null
  const roles = parseRoles(raw.roles)
  if (!roles) return null
  const tasks: Task[] = []
  for (const t of raw.tasks as Record<string, unknown>[]) {
    if (typeof t?.title !== 'string' || typeof t.prompt !== 'string' || typeof t.role !== 'string')
      return null
    tasks.push({
      title: t.title,
      prompt: t.prompt,
      role: t.role,
      selected: t.selected !== false
    })
  }
  return {
    name: raw.name,
    brief: typeof raw.brief === 'string' ? raw.brief : '',
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
  // Editor chats carry the workflow's stored Brief and file path into turn-1
  // context (§7, M11 Decision 4); a _draft has neither.
  const draft = slug === DRAFT_KEY
  const brief = draft ? undefined : store.loadBrief(repo, slug)

  let reply = ''
  const handle = spawnRunner(
    chatRunner(profile, settings),
    turnArgs(text, sessionId, profile, roleSlugs, settings, brief, draft ? undefined : slug),
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

// Apply — the only mutation out of a chat, and it lives here so every write
// stays in main (Decisions 1/2/5/6). From the Draft view (`slug` = _draft) it
// creates a ticked workflow and renames the transcript; from the editor it
// updates in place, preserving the workflow's current tick.
export function applyProposal(
  repo: string,
  slug: string,
  proposal: ChatProposal
): { ok: true; workflow: Workflow } | { ok: false; error: string } {
  // Applying mid-turn would rename the transcript out from under the reply
  // still being appended to it.
  if (inFlight.has(slug)) return { ok: false, error: 'a chat turn is already in flight' }
  const draft = slug === DRAFT_KEY
  const { roles, workflows } = store.loadRepo(repo)
  const existing = draft ? undefined : workflows.find((w) => w.slug === slug)
  const roleSlugs = new Set(roles.map((r) => r.slug))
  for (const role of proposal.roles) {
    if (!roleSlugs.has(role.slug)) store.saveRole(repo, role) // existing role always wins
  }
  const taken = new Set(workflows.map((w) => w.slug))
  let newSlug = store.slugify(proposal.name)
  for (let n = 2; taken.has(newSlug); n++) newSlug = `${store.slugify(proposal.name)}-${n}`
  const saved = store.saveWorkflow(repo, {
    slug: draft ? newSlug : slug,
    name: proposal.name,
    selected: draft ? true : (existing?.selected ?? false),
    tasks: proposal.tasks,
    brief: proposal.brief
  })
  if (draft) {
    mkdirSync(dirname(chatPath(repo, saved.slug)), { recursive: true })
    if (existsSync(chatPath(repo, DRAFT_KEY)))
      renameSync(chatPath(repo, DRAFT_KEY), chatPath(repo, saved.slug))
  }
  return { ok: true, workflow: saved }
}

export function killChats(): void {
  for (const handle of inFlight.values()) handle.kill()
}
