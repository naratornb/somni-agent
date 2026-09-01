// Grooming chat (architecture.md §7). Each turn is the same read-only
// claude spawn path as task execution; the chat never writes definitions —
// `applyProposal` below is the one user-triggered mutation.

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { getRunner } from './runners'
import { groomPreamble } from './prompts'
import * as store from './store'
import { turn } from './turn'
import type { Effort, Item, Profile, Role, RunnerName, Settings, Task } from './store'

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

// The message for one turn. First turn carries the preamble; later turns resume.
const chatPrompt = (
  message: string,
  sessionId: string | null,
  roleSlugs: string[],
  settings: Settings,
  context?: string
): string =>
  sessionId ? message : `${groomPreamble(roleSlugs, context, settings.methodology)}\n${message}`

// ponytail: sendChat goes through turn() now; this survives only because
// chat.test.ts pins the argv contract through it — delete when those tests
// migrate to the Turn seam.
export function turnArgs(
  message: string,
  sessionId: string | null,
  profile: Profile,
  roleSlugs: string[],
  settings: Settings = {},
  context?: string
): string[] {
  return getRunner(profile.runner, settings).buildArgs(
    chatPrompt(message, sessionId, roleSlugs, settings, context),
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

const inFlight = new Map<string, AbortController>()

export function sendChat(
  repo: string,
  slug: string,
  text: string,
  settings: Settings,
  roleSlugs: string[],
  onEvent: (ev: ChatEvent) => void
): { ok: boolean; error?: string } {
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
  const ac = new AbortController()
  inFlight.set(slug, ac)
  void turn(
    {
      prompt: chatPrompt(text, sessionId, roleSlugs, settings, context),
      settings, // runner/model/effort default from here — the chat is settings-profiled (§7)
      cwd: repo,
      resumeSessionId: sessionId ?? undefined,
      readOnly: true,
      onSession: (id) => {
        if (id !== sessionId) {
          sessionId = id
          appendLine(repo, slug, { sessionId: id })
        }
      },
      onText: (t) => {
        reply += t
        onEvent({ slug, kind: 'text', text: t })
      },
      onStderr: (m) => onEvent({ slug, kind: 'error', message: m })
    },
    { signal: ac.signal }
  ).then((r) => {
    inFlight.delete(slug)
    if (!reply.trim()) {
      onEvent({ slug, kind: 'error', message: `chat turn failed (exit ${r.exitCode})` })
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
  for (const ac of inFlight.values()) ac.abort()
}
