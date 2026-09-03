// Grooming chat (architecture.md §7). Each turn is the same read-only
// claude spawn path as task execution; the chat never writes definitions —
// `applyProposal` below is the one user-triggered mutation.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { getRunner } from './runners'
import { groomPreamble } from './prompts'
import * as store from './store'
import { turn } from './turn'
import type { Effort, Item, Profile, Role, RunnerName, Settings, Task } from './store'

// Every Groom is an Item from its first message (M25.1) — there is no draft
// slot. A from-scratch groom starts as an Idea under this placeholder name,
// which the AI replaces with a real title after the first exchange.
export const NEW_GROOM_NAME = 'New groom'

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
  // The AI auto-title landed on the item (M25.1) — the view renders the name.
  | { slug: string; kind: 'title'; name: string }

const chatPath = (repo: string, slug: string): string =>
  join(repo, '.somni', 'chats', slug + '.jsonl')

// The fixed message Propose Now sends — visible in the transcript (Decision 4).
export const PROPOSE_NOW =
  'Stop interviewing and propose the groomed result now, from my answers so far ' +
  'plus your own stated assumptions for anything still open.'

// Opening a from-scratch Groom (M25.1): the Item exists before the first
// message, so the conversation is keyed on a real id and two parallel grooms
// can never share a transcript.
export function startGroom(repo: string): Item {
  return store.saveItem(repo, { kind: 'idea', status: 'grooming', name: NEW_GROOM_NAME })
}

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

export function loadChat(
  repo: string,
  slug: string
): { messages: ChatMessage[]; busy: boolean; partial: string } {
  const messages = readLines(repo, slug).filter((l): l is ChatMessage => 'role' in l)
  // Streamed text is buffered here (M25.2) so a view re-entered mid-Turn shows
  // the reply so far instead of an idle transcript.
  return { messages, busy: inFlight.has(slug), partial: partials.get(slug) ?? '' }
}

export function newChat(repo: string, slug: string): void {
  rmSync(chatPath(repo, slug), { force: true })
}

const inFlight = new Map<string, AbortController>()
// Reply text streamed so far, per in-flight slug — replayed by `loadChat`.
const partials = new Map<string, string>()

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
  // Every groom is keyed on a real item (M25.1): turn 1 is seeded with the item
  // as it stands, and each turn flips it into Grooming and stamps its last
  // activity. Nothing else is written until Apply.
  const item = store.loadItems(repo).find((i) => i.id === slug)
  let context: string | undefined
  if (item) {
    // A brand-new groom has nothing worth seeding — don't feed the placeholder.
    if (item.name !== NEW_GROOM_NAME || item.spec.trim())
      context = `# ${item.name}\n\n${item.spec}`.trim()
    store.updateItem(repo, item.id, {
      status: 'grooming',
      lastActivity: new Date().toISOString()
    })
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
        partials.set(slug, reply)
        onEvent({ slug, kind: 'text', text: t })
      },
      onStderr: (m) => onEvent({ slug, kind: 'error', message: m })
    },
    { signal: ac.signal }
  ).then((r) => {
    inFlight.delete(slug)
    partials.delete(slug) // the reply is about to be a real transcript line
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
    if (item?.name === NEW_GROOM_NAME) void autoTitle(repo, slug, text, reply, settings, onEvent)
  })
  return { ok: true }
}

const TITLE_PROMPT =
  'Title this grooming conversation as a work-item name: a specific noun phrase ' +
  'of at most 8 words. Reply with the title alone — no quotes, no punctuation at ' +
  'the end, no preamble.'

// After the first exchange the placeholder name is replaced by an AI title
// (M25.1). One read-only Turn, the report.ts compact-summary precedent: any
// failure degrades to keeping the placeholder, and the groom is unaffected.
async function autoTitle(
  repo: string,
  id: string,
  question: string,
  reply: string,
  settings: Settings,
  onEvent: (ev: ChatEvent) => void
): Promise<void> {
  const r = await turn({
    prompt: `${TITLE_PROMPT}\n\n---\n${question}\n\n---\n${reply}`,
    settings,
    cwd: repo,
    readOnly: true
  })
  const name = r.ok
    ? r.text
        .trim()
        .split('\n')[0]
        .replace(/^["'#\s]+|["'\s]+$/g, '')
    : ''
  if (!name) return
  try {
    // Re-read guards the race with a manual rename mid-turn: only the
    // placeholder is ever overwritten.
    if (store.loadItems(repo).find((i) => i.id === id)?.name !== NEW_GROOM_NAME) return
    onEvent({ slug: id, kind: 'title', name: store.renameItem(repo, id, name).name })
  } catch {
    /* item deleted mid-groom — nothing to title */
  }
}

// Apply — the only mutation out of a groom, and it lives here so every write
// stays in main (§7). The groomed item converts in place, keeping its id;
// child Stories are created ready with their blockedBy indices resolved to real
// ids. Every groom is item-keyed now (M25.1) — there is no from-scratch case.
export function applyProposal(
  repo: string,
  key: string,
  proposal: ChatProposal
): { ok: true; item: Item } | { ok: false; error: string } {
  // Applying mid-turn would move the item's file out from under the reply
  // still being appended to it.
  if (inFlight.has(key)) return { ok: false, error: 'a chat turn is already in flight' }
  const { roles, items } = store.loadRepo(repo)
  const existing = items.find((i) => i.id === key)
  if (!existing) return { ok: false, error: `item not found: ${key}` }
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
  // Mirrors `item:save`: an item landing in Backlog joins the column's ordering.
  const backlog = store.loadBacklog(repo)
  if (root.status === 'backlog' && !backlog.includes(root.id))
    store.saveBacklog(repo, [...backlog, root.id])
  return { ok: true, item: root }
}

export function killChats(): void {
  for (const ac of inFlight.values()) ac.abort()
}
