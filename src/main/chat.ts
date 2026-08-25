// "Draft with AI" chat (architecture.md §7). Each turn is the same read-only
// claude spawn path as task execution; the chat never writes definitions —
// Apply goes through workflow:save from the renderer.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'fs'
import { dirname, join } from 'path'
import { spawnClaude, SpawnHandle } from './runner'
import type { Profile, Task } from './store'

export type ChatMessage = { role: 'user' | 'assistant'; text: string; ts: string }
export type ChatProposal = { name: string; tasks: Task[] }
export type ChatEvent =
  | { slug: string; kind: 'text'; text: string }
  | { slug: string; kind: 'done'; message: ChatMessage; proposal: ChatProposal | null }
  | { slug: string; kind: 'error'; message: string }

const chatPath = (repo: string, slug: string): string =>
  join(repo, '.somni', 'chats', slug + '.jsonl')

export function draftPreamble(roleSlugs: string[]): string {
  return [
    'You are helping draft a somni workflow: an ordered list of tasks, each run',
    'unattended by a coding agent in an isolated git worktree of this repo.',
    'Interview me briefly (a couple of focused questions at a time) about what I want,',
    'inspecting the codebase read-only as needed, then propose a complete workflow.',
    'Whenever you propose one, end your reply with a fenced ```somni-workflow block',
    'containing JSON of the form:',
    '{"name": "...", "tasks": [{"title": "...", "prompt": "...", "role": "...", "selected": true}]}',
    'where "prompt" is a full self-contained brief for that task and "role" is one of',
    `the repo's existing role slugs: ${roleSlugs.join(', ') || '(none defined yet)'}.`,
    'Do not create or modify any files.',
    '',
    'My request:'
  ].join('\n')
}

// Args for one turn. First turn carries the preamble; later turns --resume.
export function turnArgs(
  message: string,
  sessionId: string | null,
  profile: Profile,
  roleSlugs: string[]
): string[] {
  return [
    '-p',
    sessionId ? message : `${draftPreamble(roleSlugs)}\n${message}`,
    '--output-format',
    'stream-json',
    '--verbose',
    '--allowedTools',
    'Read,Glob,Grep',
    ...(sessionId ? ['--resume', sessionId] : []),
    ...(profile.model ? ['--model', profile.model] : []),
    ...(profile.effort ? ['--effort', profile.effort] : [])
  ]
}

// Last ```somni-workflow block in an assistant message, or null if absent/malformed.
export function parseProposal(text: string): ChatProposal | null {
  // The closing fence is anchored to the start of its own line: JSON escapes
  // newlines inside strings, so a real line break before ``` can only be the
  // block terminator — a fence *inside* a prompt string no longer truncates it.
  const blocks = [...text.matchAll(/```somni-workflow[^\n]*\n([\s\S]*?)\n```/g)]
  const last = blocks[blocks.length - 1]
  if (!last) return null
  let raw: { name?: unknown; tasks?: unknown }
  try {
    raw = JSON.parse(last[1])
  } catch {
    return null
  }
  if (typeof raw?.name !== 'string' || !Array.isArray(raw.tasks)) return null
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
  return { name: raw.name, tasks }
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
  profile: Profile,
  roleSlugs: string[],
  onEvent: (ev: ChatEvent) => void
): { ok: boolean; error?: string } {
  if (inFlight.has(slug)) return { ok: false, error: 'a chat turn is already in flight' }
  const lines = readLines(repo, slug)
  let sessionId = sessionOf(lines)
  appendLine(repo, slug, { role: 'user', text, ts: new Date().toISOString() })

  let reply = ''
  const handle = spawnClaude(turnArgs(text, sessionId, profile, roleSlugs), repo, (ev) => {
    if (ev.kind === 'session' && ev.sessionId !== sessionId) {
      sessionId = ev.sessionId
      appendLine(repo, slug, { sessionId: ev.sessionId })
    }
    if (ev.kind === 'text') {
      reply += ev.text
      onEvent({ slug, kind: 'text', text: ev.text })
    }
    if (ev.kind === 'spawn-error') onEvent({ slug, kind: 'error', message: ev.message })
  })
  inFlight.set(slug, handle)
  void handle.done.then(({ code }) => {
    inFlight.delete(slug)
    if (!reply.trim()) {
      onEvent({ slug, kind: 'error', message: `chat turn failed (exit ${code})` })
      return
    }
    const message: ChatMessage = { role: 'assistant', text: reply, ts: new Date().toISOString() }
    appendLine(repo, slug, message)
    onEvent({ slug, kind: 'done', message, proposal: parseProposal(reply) })
  })
  return { ok: true }
}

export function killChats(): void {
  for (const handle of inFlight.values()) handle.kill()
}
