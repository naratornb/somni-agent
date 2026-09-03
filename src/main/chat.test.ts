import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { groomPreamble } from './prompts'
import {
  applyProposal,
  killChats,
  NEW_GROOM_NAME,
  loadChat,
  newChat,
  parseProposal,
  parseQuestion,
  PROPOSE_NOW,
  sendChat,
  startGroom,
  turnArgs,
  workUnitTurn
} from './chat'
import { handoff, resetSessions } from './sessions'
import type { ChatEvent } from './chat'
import { existsSync, readdirSync } from 'fs'
import { loadBacklog, loadItems, loadRepo, renameItem, saveItem, saveRole } from './store'

// The item's file basename is id + slug, and the slug moves on rename.
const itemFile = (repo: string, id: string): string =>
  join(
    repo,
    '.somni',
    'items',
    readdirSync(join(repo, '.somni', 'items')).find(
      (f) => f.startsWith(id + '-') && f.endsWith('.md')
    )!
  )

const block = (json: string): string => '```somni-groomed\n' + json + '\n```'
// A one-Story proposal in the pinned schema; `over` swaps any field.
const story = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    kind: 'story',
    name: 'N',
    spec: 's',
    subtasks: [{ title: 't', prompt: 'p', role: 'dev' }],
    ...over
  })

describe('parseProposal', () => {
  it('parses a single-story proposal and defaults selected', () => {
    const text = [block(story({ name: 'old' })), 'more chat', block(story({ name: 'New' }))].join(
      '\n'
    )
    expect(parseProposal(text)).toEqual({
      kind: 'story',
      name: 'New',
      spec: 's',
      stories: [],
      roles: [],
      tasks: [{ title: 't', prompt: 'p', role: 'dev', selected: true }]
    })
  })

  it('parses an epic proposal with its stories and backward blockedBy indices', () => {
    const json = JSON.stringify({
      kind: 'epic',
      name: 'Big',
      spec: 'why',
      stories: [
        { name: 'One', spec: 'a', subtasks: [{ title: 't', prompt: 'p', role: 'dev' }] },
        {
          name: 'Two',
          spec: 'b',
          subtasks: [{ title: 'u', prompt: 'q', role: 'dev' }],
          blockedBy: [0]
        }
      ]
    })
    expect(parseProposal(block(json))).toEqual({
      kind: 'epic',
      name: 'Big',
      spec: 'why',
      tasks: [],
      roles: [],
      stories: [
        {
          name: 'One',
          spec: 'a',
          blockedBy: [],
          tasks: [{ title: 't', prompt: 'p', role: 'dev', selected: true }]
        },
        {
          name: 'Two',
          spec: 'b',
          blockedBy: [0],
          tasks: [{ title: 'u', prompt: 'q', role: 'dev', selected: true }]
        }
      ]
    })
  })

  it('returns null when absent or malformed', () => {
    expect(parseProposal('just prose')).toBeNull()
    expect(parseProposal(block('{not json'))).toBeNull()
    expect(parseProposal(block(story({ kind: 'workflow' })))).toBeNull() // unknown kind
    expect(parseProposal(block(story({ name: 3 })))).toBeNull()
    expect(parseProposal(block(story({ subtasks: undefined })))).toBeNull() // story needs subtasks
    expect(parseProposal(block(story({ subtasks: [{ title: 't' }] })))).toBeNull()
    expect(parseProposal(block('{"kind":"epic","name":"E","spec":"s"}'))).toBeNull() // epic needs stories
  })

  // Index-based edges are only meaningful backwards; anything else would
  // silently lose (or invent) a dependency, so it rejects the whole proposal.
  it('rejects forward, self, out-of-range and non-integer blockedBy indices', () => {
    const epic = (blockedBy: unknown): string =>
      JSON.stringify({
        kind: 'epic',
        name: 'E',
        spec: 's',
        stories: [
          { name: 'One', spec: 'a', subtasks: [] },
          { name: 'Two', spec: 'b', subtasks: [], blockedBy }
        ]
      })
    expect(parseProposal(block(epic([0])))).not.toBeNull() // backward is fine
    expect(parseProposal(block(epic([1])))).toBeNull() // self
    expect(parseProposal(block(epic([2])))).toBeNull() // forward / out of range
    expect(parseProposal(block(epic([-1])))).toBeNull()
    expect(parseProposal(block(epic(['SOM-1'])))).toBeNull() // an id, not an index
    expect(parseProposal(block(epic('0')))).toBeNull()
  })

  it('ignores unknown extra keys on the block and on subtasks', () => {
    const json = story({
      extra: 'x',
      subtasks: [{ title: 't', prompt: 'p', role: 'dev', weight: 5, selected: false }]
    })
    expect(parseProposal(block(json))?.tasks).toEqual([
      { title: 't', prompt: 'p', role: 'dev', selected: false }
    ])
  })

  // The closing fence is anchored to the start of a line, so a fence inside a
  // prompt string (where JSON escapes the newlines) no longer truncates it.
  it('parses a prompt containing its own triple-backtick fence', () => {
    const prompt = 'Run ```js\nconsole.log(1)\n``` then done'
    const json = story({ subtasks: [{ title: 't', prompt, role: 'dev' }] })
    expect(parseProposal(block(json))?.tasks[0].prompt).toBe(prompt)
  })

  it('takes the last of three or more blocks', () => {
    const text = [
      block(story({ name: 'A' })),
      block(story({ name: 'B' })),
      block(story({ name: 'C' }))
    ].join('\n')
    expect(parseProposal(text)?.name).toBe('C')
  })

  it('parses new roles and rejects the proposal when one is invalid (M8 parity)', () => {
    const json = story({
      roles: [
        { slug: 'writer', name: 'Writer', preamble: 'write', runner: 'antigravity' },
        { slug: 'x', name: 'X', preamble: 'p', effort: 'bogus', model: 'opus' }
      ]
    })
    expect(parseProposal(block(json))?.roles).toEqual([
      { slug: 'writer', name: 'Writer', preamble: 'write', runner: 'antigravity' },
      { slug: 'x', name: 'X', preamble: 'p', model: 'opus' }
    ])
    expect(parseProposal(block(story({ roles: [{ slug: 'a', name: 'A' }] })))).toBeNull()
    expect(parseProposal(block(story({ roles: 'nope' })))).toBeNull()
  })
})

describe('turnArgs', () => {
  it('prepends the preamble with role slugs on the first turn', () => {
    const args = turnArgs('do a thing', null, {}, ['dev', 'qa'])
    expect(args[0]).toBe('-p')
    expect(args[1]).toContain('dev, qa')
    expect(args[1]).toContain('somni-groomed')
    expect(args[1].endsWith('do a thing')).toBe(true)
    expect(args).toContain('--allowedTools')
    expect(args).not.toContain('--resume')
    expect(args).not.toContain('--dangerously-skip-permissions')
  })

  it('resumes without the preamble and applies the profile', () => {
    const args = turnArgs('next', 'sess-1', { model: 'opus', effort: 'high' }, ['dev'])
    expect(args[1]).toBe('next')
    expect(args).toEqual(
      expect.arrayContaining(['--resume', 'sess-1', '--model', 'opus', '--effort', 'high'])
    )
  })

  // §7 security invariant: the chat is read-only. This must never regress to
  // a permissions-skipping or write-capable turn.
  it('never allows dangerously-skip-permissions and scopes allowedTools exactly', () => {
    for (const args of [
      turnArgs('hi', null, {}, ['dev']),
      turnArgs('hi', 'sess-1', { model: 'opus' }, [])
    ]) {
      expect(args).not.toContain('--dangerously-skip-permissions')
      const i = args.indexOf('--allowedTools')
      expect(i).toBeGreaterThanOrEqual(0)
      expect(args[i + 1]).toBe('Read,Glob,Grep')
    }
  })

  // The antigravity runner scopes read-only differently (--mode plan --sandbox,
  // not --allowedTools) — this must hold for chat turns too, not just tasks.
  it('scopes the antigravity runner to --mode plan --sandbox and never autonomy', () => {
    for (const args of [
      turnArgs('hi', null, { runner: 'antigravity' }, ['dev']),
      turnArgs('hi', 'sess-1', { runner: 'antigravity', model: 'x' }, [])
    ]) {
      expect(args).not.toContain('--dangerously-skip-permissions')
      expect(args).toEqual(expect.arrayContaining(['--mode', 'plan', '--sandbox']))
    }
  })
})

const qBlock = (json: string): string => '```somni-question\n' + json + '\n```'

describe('parseQuestion', () => {
  it('parses a valid block and keeps the recommended option', () => {
    expect(
      parseQuestion(
        'Some prose\n' + qBlock('{"question":"Which?","options":["a","b"],"recommended":"b"}')
      )
    ).toEqual({ question: 'Which?', options: ['a', 'b'], recommended: 'b' })
  })

  it('takes the last block and drops a recommendation not among the options', () => {
    const text = [
      qBlock('{"question":"first","options":["x"],"recommended":"x"}'),
      qBlock('{"question":"second","options":["x","y"],"recommended":"zzz"}')
    ].join('\n')
    expect(parseQuestion(text)).toEqual({
      question: 'second',
      options: ['x', 'y'],
      recommended: ''
    })
  })

  it('degrades to null on malformed or empty blocks', () => {
    expect(parseQuestion('just prose')).toBeNull()
    expect(parseQuestion(qBlock('{not json'))).toBeNull()
    expect(parseQuestion(qBlock('{"question":"q"}'))).toBeNull()
    expect(parseQuestion(qBlock('{"question":"q","options":[]}'))).toBeNull()
    expect(parseQuestion(qBlock('{"question":"q","options":["a",3]}'))).toBeNull()
  })

  it('survives a fence nested inside a question string', () => {
    const json = JSON.stringify({
      question: 'Use ```npm test``` or make?',
      options: ['npm', 'make'],
      recommended: 'npm'
    })
    expect(parseQuestion(qBlock(json))?.options).toEqual(['npm', 'make'])
  })
})

// Crash-safety (M8): nothing about finding/loading a transcript depends on
// in-process state — a transcript written by a prior process lifetime (i.e.
// before an app restart) must load exactly like one written this session.
describe('groom transcript survives a simulated restart', () => {
  it('loadChat finds a transcript it never wrote itself', () => {
    const repo = mkdtempSync(join(tmpdir(), 'somni-restart-'))
    mkdirSync(join(repo, '.somni', 'chats'), { recursive: true })
    writeFileSync(
      join(repo, '.somni', 'chats', 'SOM-1.jsonl'),
      [
        JSON.stringify({ role: 'user', text: 'hi', ts: '2020-01-01T00:00:00Z' }),
        JSON.stringify({ sessionId: 'sess-from-before-restart' }),
        JSON.stringify({ role: 'assistant', text: 'hello', ts: '2020-01-01T00:00:01Z' })
      ].join('\n') + '\n'
    )
    const { messages, busy } = loadChat(repo, 'SOM-1')
    expect(messages.map((m) => `${m.role}:${m.text}`)).toEqual(['user:hi', 'assistant:hello'])
    expect(busy).toBe(false) // inFlight is in-memory and correctly empty post-restart
  })
})

describe('applyProposal', () => {
  let repo: string
  const groomed = (over = {}): Parameters<typeof applyProposal>[2] => ({
    kind: 'story',
    name: 'Nightly Cleanup',
    spec: 'Tidy up.',
    stories: [],
    tasks: [{ title: 't', prompt: 'p', role: 'dev', selected: true }],
    roles: [{ slug: 'dev', name: 'Hijacked', preamble: 'nope' }],
    ...over
  })
  const epic = (over = {}): Parameters<typeof applyProposal>[2] =>
    groomed({
      kind: 'epic',
      name: 'Search Overhaul',
      tasks: [],
      stories: [
        { name: 'Index', spec: 'a', tasks: [{ ...sub }], blockedBy: [] },
        { name: 'Query', spec: 'b', tasks: [{ ...sub }], blockedBy: [0] }
      ],
      ...over
    })
  const sub = { title: 't', prompt: 'p', role: 'dev', selected: true }

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'somni-apply-'))
  })

  it('converts a groomed idea into a ready Story in place, keeping its id', () => {
    const idea = saveItem(repo, { name: 'Vague thought', kind: 'idea', spec: 'hmm' })
    const res = applyProposal(repo, idea.id, groomed({ roles: [] }))
    expect(res.ok && res.item.id).toBe(idea.id)
    const items = loadItems(repo)
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: idea.id,
      kind: 'story',
      status: 'ready',
      name: 'Nightly Cleanup',
      spec: 'Tidy up.',
      created: idea.created
    })
    // the .tasks.json sidecar rides with the story
    expect(items[0].tasks).toEqual([{ title: 't', prompt: 'p', role: 'dev', selected: true }])
    expect(existsSync(join(repo, '.somni', 'items', `${idea.id}-nightly-cleanup.tasks.json`))).toBe(
      true
    )
  })

  it('marks the session done with a doneAt stamp (M25.3)', () => {
    const idea = saveItem(repo, { name: 'Vague thought', kind: 'idea', status: 'grooming' })
    const res = applyProposal(repo, idea.id, groomed({ roles: [] }))
    expect(res.ok).toBe(true)
    const applied = loadItems(repo)[0]
    expect(applied.groomState).toBe('done')
    expect(Date.parse(applied.doneAt!)).toBeGreaterThan(0)
    expect(applied.status).toBe('ready') // the Item Status is its own vocabulary
  })

  it('rewrites an already-groomed story in place when re-groomed', () => {
    const first = applyProposal(repo, saveItem(repo, { name: 'Thing' }).id, groomed({ roles: [] }))
    expect(first.ok).toBe(true)
    const id = first.ok ? first.item.id : ''
    applyProposal(
      repo,
      id,
      groomed({ roles: [], spec: 'Sharper.', tasks: [{ ...sub, title: 'u' }] })
    )
    const items = loadItems(repo)
    expect(items).toHaveLength(1)
    expect(items[0].spec).toBe('Sharper.')
    expect(items[0].tasks.map((t) => t.title)).toEqual(['u'])
  })

  it('converts an epic and creates its stories ready, with resolved blockedBy ids', () => {
    const idea = saveItem(repo, { name: 'Search', kind: 'idea' })
    const res = applyProposal(repo, idea.id, epic({ roles: [] }))
    expect(res.ok).toBe(true)
    const items = loadItems(repo)
    const root = items.find((i) => i.id === idea.id)!
    const children = items.filter((i) => i.epic === idea.id)
    // the epic never executes, so it lands back in Backlog
    expect(root).toMatchObject({ kind: 'epic', status: 'backlog', name: 'Search Overhaul' })
    expect(root.tasks).toEqual([])
    expect(children.map((c) => [c.name, c.kind, c.status])).toEqual([
      ['Index', 'story', 'ready'],
      ['Query', 'story', 'ready']
    ])
    expect(children[0].blockedBy).toBeUndefined()
    expect(children[1].blockedBy).toEqual([children[0].id])
    expect(children.every((c) => c.tasks.length === 1)).toBe(true)
  })

  it('writes new roles only — an existing slug always wins', () => {
    saveRole(repo, { slug: 'dev', name: 'Dev', preamble: 'existing' })
    const before = readFileSync(join(repo, '.somni', 'roles', 'dev.md'), 'utf8')
    applyProposal(
      repo,
      saveItem(repo, { name: 'Thing' }).id,
      groomed({
        roles: [
          { slug: 'dev', name: 'Hijacked', preamble: 'nope' },
          { slug: 'writer', name: 'Writer', preamble: 'write things', model: 'opus' }
        ]
      })
    )
    expect(readFileSync(join(repo, '.somni', 'roles', 'dev.md'), 'utf8')).toBe(before)
    expect(loadRepo(repo).roles.map((r) => r.slug)).toEqual(['dev', 'writer'])
    const md = readFileSync(join(repo, '.somni', 'roles', 'writer.md'), 'utf8')
    expect(md).toContain('model: opus')
    expect(md).toContain('write things')
  })

  // M25.1: a from-scratch groom already owns its Item and its transcript, so
  // Apply converts that Item in place — no draft slot, no transcript rename.
  it('converts the groom-born idea into the epic in place, keeping id and transcript', () => {
    const born = startGroom(repo)
    mkdirSync(join(repo, '.somni', 'chats'), { recursive: true })
    writeFileSync(join(repo, '.somni', 'chats', born.id + '.jsonl'), '{"role":"user"}\n')
    const res = applyProposal(repo, born.id, epic({ roles: [] }))
    expect(res.ok && res.item.id).toBe(born.id)
    expect(loadItems(repo).map((i) => i.name)).toEqual(['Search Overhaul', 'Index', 'Query'])
    expect(existsSync(join(repo, '.somni', 'chats', born.id + '.jsonl'))).toBe(true)
    // an item landing in Backlog joins the column's ordering, as item:save does
    expect(loadBacklog(repo)).toEqual([born.id])
  })

  it('refuses an unknown item key and writes nothing', () => {
    const res = applyProposal(repo, 'SOM-99', groomed({ roles: [] }))
    expect(res).toEqual({ ok: false, error: 'item not found: SOM-99' })
    expect(loadItems(repo)).toEqual([])
    expect(existsSync(join(repo, '.somni', 'roles'))).toBe(false)
  })
})

// Fake `claude` on PATH, as a node script so argv/text never needs shell
// escaping. Appends one JSON line per invocation (the full argv) to
// $ARGS_LOG — a real NDJSON transcript of calls, easy to assert on exactly.
// FAKE_SESSION fixes the session id so resume can be asserted across turns;
// FAKE_TEXT sets the assistant reply (may contain any characters, incl. ```).
const FAKE_CHAT = `#!/usr/bin/env node
const fs = require('fs')
fs.appendFileSync(process.env.ARGS_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
if (process.env.FAKE_FAIL) {
  process.stderr.write('claude: boom\\n')
  process.exit(1)
}
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: process.env.FAKE_SESSION }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: process.env.FAKE_TEXT }] } }) + '\\n')
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false }) + '\\n')
`

describe('sendChat end-to-end (fake claude on PATH)', () => {
  let root: string
  let repo: string
  let argsLog: string
  let savedPath: string
  const fakeEnv: string[] = []
  const pending: Promise<unknown>[] = []

  const fake = (vars: Record<string, string>): void => {
    for (const [k, v] of Object.entries(vars)) {
      process.env[k] = v
      fakeEnv.push(k)
    }
  }
  const callsLogged = (): string[][] =>
    readFileSync(argsLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'somni-chat-'))
    repo = join(root, 'repo')
    mkdirSync(repo)
    const bin = join(root, 'bin')
    mkdirSync(bin)
    writeFileSync(join(bin, 'claude'), FAKE_CHAT)
    chmodSync(join(bin, 'claude'), 0o755)
    argsLog = join(root, 'args.log')
    writeFileSync(argsLog, '')
    savedPath = process.env.PATH!
    process.env.PATH = `${bin}:${savedPath}`
    process.env.ARGS_LOG = argsLog
    fakeEnv.push('ARGS_LOG')
    fake({ FAKE_SESSION: 'sess-abc', FAKE_TEXT: 'hello there' })
    pending.length = 0
  })

  afterEach(async () => {
    killChats()
    await Promise.allSettled(pending)
    process.env.PATH = savedPath
    for (const k of fakeEnv) delete process.env[k]
    fakeEnv.length = 0
    resetSessions()
  })

  // unique slug per call avoids any cross-test interference via chat.ts's
  // module-level in-flight map (keyed by slug only, not by repo).
  let slugN = 0
  const nextSlug = (): string => `draft-${++slugN}`

  const send = (slug: string, text: string): Promise<ChatEvent[]> => {
    const p = new Promise<ChatEvent[]>((resolve) => {
      const events: ChatEvent[] = []
      const res = sendChat(repo, slug, text, {}, ['dev'], (ev) => {
        events.push(ev)
        if (ev.kind === 'done' || ev.kind === 'error') resolve(events)
      })
      expect(res.ok).toBe(true)
    })
    pending.push(p)
    return p
  }

  it('runs a full first-turn -> resume -> transcript -> newChat cycle', async () => {
    const slug = nextSlug()
    const first = await send(slug, 'build me a thing')
    const calls1 = callsLogged()
    expect(calls1).toHaveLength(1)
    expect(calls1[0]).not.toContain('--resume')
    expect(calls1[0][1]).toContain('somni-groomed') // preamble present in the -p message
    expect(first.some((e) => e.kind === 'done')).toBe(true)

    // sessionId captured and persisted
    const loaded1 = loadChat(repo, slug)
    expect(loaded1.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(loaded1.messages[1].text).toBe('hello there')

    // second turn resumes, no preamble
    fake({ FAKE_TEXT: 'second reply' })
    await send(slug, 'next question')
    const calls2 = callsLogged()
    expect(calls2).toHaveLength(2)
    expect(calls2[1]).toEqual(expect.arrayContaining(['--resume', 'sess-abc']))
    expect(calls2[1][1]).not.toContain('somni-groomed')

    // transcript accumulates user+assistant lines in order
    const loaded2 = loadChat(repo, slug)
    expect(loaded2.messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:build me a thing',
      'assistant:hello there',
      'user:next question',
      'assistant:second reply'
    ])

    // newChat resets: next turn carries no --resume again
    newChat(repo, slug)
    expect(loadChat(repo, slug).messages).toEqual([])
    await send(slug, 'fresh start')
    const calls3 = callsLogged()
    expect(calls3).toHaveLength(3)
    expect(calls3[2]).not.toContain('--resume')
  })

  // §7: the interview itself moves the item into Grooming, and turn 1 carries
  // the item's current name + Spec — nothing else is written until Apply.
  it('flips an item-keyed groom to grooming and seeds turn 1 with its name + spec', async () => {
    const item = saveItem(repo, { name: 'Search is slow', spec: 'Make it fast.', kind: 'idea' })
    await send(item.id, 'lets groom')
    expect(loadItems(repo)[0].status).toBe('grooming')
    const [call] = callsLogged()
    expect(call[1]).toContain('# Search is slow')
    expect(call[1]).toContain('Make it fast.')
    // still an idea — only Apply changes kind
    expect(loadItems(repo)[0].kind).toBe('idea')
  })

  it('refuses Apply while that key has a turn in flight', async () => {
    const slug = nextSlug()
    const done = send(slug, 'hi')
    const res = applyProposal(repo, slug, {
      kind: 'story',
      name: 'N',
      spec: 'b',
      stories: [],
      tasks: [],
      roles: []
    })
    expect(res).toEqual({ ok: false, error: 'a chat turn is already in flight' })
    await done
  })

  it('runs the turn with the repo as cwd, not a worktree', async () => {
    const slug = nextSlug()
    await send(slug, 'hi')
    // fake claude only records args, not cwd — assert indirectly via the
    // chat transcript path, which sendChat always writes under `repo`.
    expect(readFileSync(join(repo, '.somni', 'chats', slug + '.jsonl'), 'utf8')).toContain(
      '"role":"user"'
    )
  })

  it('parses a proposal block from the turn reply', async () => {
    fake({
      FAKE_TEXT:
        'Sure, here.\n```somni-groomed\n' +
        '{"kind":"story","name":"Plan","spec":"why",' +
        '"subtasks":[{"title":"t","prompt":"p","role":"dev"}]}\n```'
    })
    const events = await send(nextSlug(), 'propose something')
    const done = events.find((e) => e.kind === 'done') as Extract<ChatEvent, { kind: 'done' }>
    expect(done.proposal).toEqual({
      kind: 'story',
      name: 'Plan',
      spec: 'why',
      stories: [],
      roles: [],
      tasks: [{ title: 't', prompt: 'p', role: 'dev', selected: true }]
    })
  })

  it("carries the turn's parsed question on the done event", async () => {
    fake({
      FAKE_TEXT:
        'One thing first.\n```somni-question\n' +
        '{"question":"Tests?","options":["vitest","none"],"recommended":"vitest"}\n```'
    })
    const events = await send(nextSlug(), 'build a thing')
    const done = events.find((e) => e.kind === 'done') as Extract<ChatEvent, { kind: 'done' }>
    expect(done.question).toEqual({
      question: 'Tests?',
      options: ['vitest', 'none'],
      recommended: 'vitest'
    })
    expect(done.proposal).toBeNull()
  })

  it('spawn failure emits an error event and does not append an assistant line', async () => {
    fake({ FAKE_FAIL: '1' })
    const slug = nextSlug()
    const events = await send(slug, 'hi')
    expect(events.some((e) => e.kind === 'error')).toBe(true)
    const loaded = loadChat(repo, slug)
    expect(loaded.messages.map((m) => m.role)).toEqual(['user']) // no assistant line appended
  })

  // §7 security invariant, specifically for the two surfaces the Decisions
  // log calls out: a from-scratch groom and a Propose Now turn.
  it('keeps chat spawns read-only for a fresh groom and for a Propose Now turn', async () => {
    await send(nextSlug(), 'build me a thing')
    const proposeSlug = nextSlug()
    await send(proposeSlug, PROPOSE_NOW)
    for (const call of callsLogged()) {
      expect(call).not.toContain('--dangerously-skip-permissions')
      const i = call.indexOf('--allowedTools')
      expect(i).toBeGreaterThanOrEqual(0)
      expect(call[i + 1]).toBe('Read,Glob,Grep')
    }
  })

  it('in-flight guard refuses a second send for the same slug but allows a different slug', async () => {
    fake({ FAKE_SESSION: 'sess-x', FAKE_TEXT: 'slow reply' })
    const slug = nextSlug()
    const events: ChatEvent[] = []
    const firstDone = new Promise<void>((resolve) => {
      const first = sendChat(repo, slug, 'turn one', {}, ['dev'], (ev) => {
        events.push(ev)
        if (ev.kind === 'done' || ev.kind === 'error') resolve()
      })
      expect(first.ok).toBe(true)
    })
    pending.push(firstDone)

    // second send for the same slug is refused synchronously, before the
    // first turn's process has even exited
    const second = sendChat(repo, slug, 'turn two (same slug)', {}, ['dev'], () => {})
    expect(second.ok).toBe(false)
    expect(second.error).toMatch(/already in flight/)

    // a different slug is allowed concurrently
    const otherSlug = nextSlug()
    const otherEvents: ChatEvent[] = []
    const otherDone = new Promise<void>((resolve) => {
      const other = sendChat(repo, otherSlug, 'hello', {}, ['dev'], (ev) => {
        otherEvents.push(ev)
        if (ev.kind === 'done' || ev.kind === 'error') resolve()
      })
      expect(other.ok).toBe(true)
    })
    pending.push(otherDone)

    await Promise.all([firstDone, otherDone])
    expect(loadChat(repo, slug).busy).toBe(false)
    expect(otherEvents.some((e) => e.kind === 'done')).toBe(true)
  })

  // M25.2: re-entering a mid-Turn Groom must show the reply so far, so main
  // buffers streamed text per slug and replays it on load.
  it('loadChat replays the partial reply mid-turn and the full one after done', async () => {
    fake({ FAKE_TEXT: 'partial words' })
    const slug = nextSlug()
    let midTurn: ReturnType<typeof loadChat> | null = null
    const done = new Promise<void>((resolve) => {
      sendChat(repo, slug, 'hi', {}, ['dev'], (ev) => {
        if (ev.kind === 'text') midTurn = loadChat(repo, slug)
        if (ev.kind === 'done' || ev.kind === 'error') resolve()
      })
    })
    pending.push(done)
    await done

    expect(midTurn).toEqual({
      messages: [expect.objectContaining({ role: 'user', text: 'hi' })],
      busy: true,
      partial: 'partial words'
    })
    const after = loadChat(repo, slug)
    expect(after.busy).toBe(false)
    expect(after.partial).toBe('')
    expect(after.messages.map((m) => m.text)).toEqual(['hi', 'partial words'])
  })

  // ---- M25.1: every Groom is an Item from birth --------------------------

  // Resolves on the title event, which lands after `done` — the auto-title
  // Turn is deliberately off the critical path of the reply.
  const sendAwaitingTitle = (slug: string, text: string): Promise<ChatEvent[]> => {
    const p = new Promise<ChatEvent[]>((resolve) => {
      const events: ChatEvent[] = []
      sendChat(repo, slug, text, {}, ['dev'], (ev) => {
        events.push(ev)
        if (ev.kind === 'title' || ev.kind === 'error') resolve(events)
      })
    })
    pending.push(p)
    return p
  }

  it('startGroom creates the item before the first message', () => {
    const item = startGroom(repo)
    expect(item.kind).toBe('idea')
    expect(item.status).toBe('grooming')
    expect(item.name).toBe(NEW_GROOM_NAME)
    expect(loadItems(repo).map((i) => i.id)).toEqual([item.id])
  })

  it('stamps lastActivity on the item frontmatter per turn', async () => {
    const item = startGroom(repo)
    expect(item.lastActivity).toBeUndefined()
    await send(item.id, 'hi')
    const first = loadItems(repo)[0].lastActivity
    expect(first).toBeTruthy()
    expect(readFileSync(itemFile(repo, item.id), 'utf8')).toContain(`lastActivity: ${first}`)
  })

  it('auto-titles the item after the first exchange and stops overwriting after', async () => {
    fake({ FAKE_TEXT: 'Faster search indexing' })
    const item = startGroom(repo)
    const events = await sendAwaitingTitle(item.id, 'search is slow')
    expect(events.at(-1)).toEqual({ slug: item.id, kind: 'title', name: 'Faster search indexing' })
    expect(loadItems(repo)[0].name).toBe('Faster search indexing')
    // second turn: the name is no longer the placeholder, so no title Turn runs
    const before = callsLogged().length
    await send(item.id, 'go on')
    expect(callsLogged()).toHaveLength(before + 1)
    expect(loadItems(repo)[0].name).toBe('Faster search indexing')
  })

  it('keeps the placeholder name when the auto-title Turn fails', async () => {
    const item = startGroom(repo)
    // reply arrives, then the *next* spawn (the title Turn) fails
    const events: ChatEvent[] = []
    const done = new Promise<void>((resolve) => {
      sendChat(repo, item.id, 'hi', {}, ['dev'], (ev) => {
        events.push(ev)
        if (ev.kind === 'done') {
          fake({ FAKE_FAIL: '1' })
          resolve()
        }
      })
    })
    await done
    await new Promise((r) => setTimeout(r, 300))
    expect(events.some((e) => e.kind === 'title')).toBe(false)
    expect(loadItems(repo)[0].name).toBe(NEW_GROOM_NAME)
  })

  it('a manual rename mid-turn wins over the auto-title', async () => {
    const item = startGroom(repo)
    const events: ChatEvent[] = []
    const done = new Promise<void>((resolve) => {
      sendChat(repo, item.id, 'hi', {}, ['dev'], (ev) => {
        events.push(ev)
        if (ev.kind === 'done') {
          renameItem(repo, item.id, 'My own title')
          resolve()
        }
      })
    })
    await done
    await new Promise((r) => setTimeout(r, 300))
    expect(events.some((e) => e.kind === 'title')).toBe(false)
    expect(loadItems(repo)[0].name).toBe('My own title')
  })

  it('two parallel from-scratch grooms keep separate items and transcripts', async () => {
    const a = startGroom(repo)
    const b = startGroom(repo)
    expect(a.id).not.toBe(b.id)
    await Promise.all([send(a.id, 'groom A'), send(b.id, 'groom B')])
    expect(loadChat(repo, a.id).messages.map((m) => m.text)).toEqual(['groom A', 'hello there'])
    expect(loadChat(repo, b.id).messages.map((m) => m.text)).toEqual(['groom B', 'hello there'])
    expect(loadItems(repo)).toHaveLength(2)
  })

  // Session state (M25.3): the pending Proposal is what needs review, and the
  // next message puts the session back into plain conversation.
  it('flags needs-review when a turn proposes, and clears it on the next send', async () => {
    fake({ FAKE_TEXT: '```somni-groomed\n' + story() + '\n```' })
    const item = startGroom(repo)
    await send(item.id, 'groom it')
    expect(loadItems(repo)[0].groomState).toBe('needs-review')
    expect(readFileSync(itemFile(repo, item.id), 'utf8')).toContain('groomState: needs-review')
    fake({ FAKE_TEXT: 'plain reply' })
    await send(item.id, 'actually, one more thing')
    expect(loadItems(repo)[0].groomState).toBeUndefined()
  })

  it('leaves a session stateless when the turn carries no proposal', async () => {
    const item = startGroom(repo)
    await send(item.id, 'hi')
    expect(loadItems(repo)[0].groomState).toBeUndefined()
  })

  // Background work unit (M25.5): one Turn on the same session, resumed, with
  // the assume-and-continue contract on top of the transcript.
  it('runs a work unit with --resume and the assumptions contract, parking needs-review', async () => {
    fake({ FAKE_TEXT: 'first reply' })
    // A named item: the placeholder would fire an auto-title Turn into the
    // argv log and race this assertion.
    const item = saveItem(repo, { name: 'Search is slow', kind: 'idea' })
    await send(item.id, 'groom it')

    fake({ FAKE_TEXT: '```somni-groomed\n' + story({ spec: '## Assumptions\n- none' }) + '\n```' })
    const events: ChatEvent[] = []
    const p = workUnitTurn(repo, item.id, {}, ['dev'], (ev) => events.push(ev))
    pending.push(p)
    // Persisted state is the session manager's; the Turn itself must not clear it.
    expect(loadItems(repo)[0].groomState).toBeUndefined()
    await p

    const call = callsLogged()[1]
    expect(call).toEqual(expect.arrayContaining(['--resume', 'sess-abc']))
    expect(call[1]).toContain('## Assumptions')
    expect(call[1]).toContain('somni-question') // ...as the fence it must NOT emit
    expect(call[1]).not.toContain('Interview discipline') // resumed: no groom preamble

    expect(loadItems(repo)[0].groomState).toBe('needs-review')
    expect(events).toContainEqual({ slug: item.id, kind: 'state', state: 'needs-review' })
    const done = events.find((e) => e.kind === 'done')!
    expect(done).toMatchObject({ workUnit: true })
    expect(loadChat(repo, item.id).messages.map((m) => m.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant'
    ])
  })

  // The user must look either way — a work unit that came back with prose (or
  // nothing at all) still parks, and the transcript records what happened.
  it('parks needs-review when a work unit produces no proposal, and when it fails', async () => {
    const a = startGroom(repo)
    fake({ FAKE_TEXT: 'I could not decide.' })
    await workUnitTurn(repo, a.id, {}, ['dev'], () => {})
    expect(loadItems(repo).find((i) => i.id === a.id)!.groomState).toBe('needs-review')

    const b = startGroom(repo)
    fake({ FAKE_FAIL: '1' })
    await workUnitTurn(repo, b.id, {}, ['dev'], () => {})
    const items = loadItems(repo)
    expect(items.find((i) => i.id === b.id)!.groomState).toBe('needs-review')
    expect(loadChat(repo, b.id).messages.at(-1)).toMatchObject({
      role: 'assistant',
      text: expect.stringContaining('Background draft failed')
    })
  })

  it("refuses a handoff while that session's own chat turn is in flight", async () => {
    const item = startGroom(repo)
    const p = send(item.id, 'thinking out loud')
    expect(handoff(repo, item.id, { run: () => Promise.resolve(), emit: () => {} })).toEqual({
      ok: false,
      error: 'a chat turn is already in flight'
    })
    await p
    expect(handoff(repo, item.id, { run: () => Promise.resolve(), emit: () => {} }).ok).toBe(true)
  })

  // No cleanup machinery: an abandoned groom is just an idea with an empty
  // Spec sitting in Grooming — visible, deletable, and never auto-swept.
  it('leaves an abandoned empty groom on the board as an idea', () => {
    const item = startGroom(repo)
    expect(loadItems(repo)).toEqual([expect.objectContaining({ id: item.id, spec: '' })])
    expect(loadBacklog(repo)).toEqual([])
  })
})

// The preamble is the whole grooming contract — schema, index rule, roles.
describe('groomPreamble', () => {
  it('carries the somni-groomed schema, the index-based blockedBy rule and the role slugs', () => {
    const p = groomPreamble(['dev', 'qa'])
    expect(p).toContain('somni-groomed')
    expect(p).toContain('"kind": "epic"|"story"')
    expect(p).toContain('"blockedBy"')
    expect(p).toContain('ZERO-BASED INDEX')
    expect(p).toContain('EARLIER entry')
    expect(p).toContain('dev, qa')
    expect(p).toContain('somni-question')
    expect(p).not.toContain('The item being groomed')
  })

  it('keeps the somni protocol and swaps only the charter under superpowers', () => {
    const p = groomPreamble(['dev'], undefined, 'superpowers')
    expect(p).toContain('somni-question')
    expect(p).toContain('somni-groomed')
    expect(p).toContain('ZERO-BASED INDEX')
    expect(p).toContain('brainstorm')
    expect(p).not.toContain('tracer bullet')
    expect(groomPreamble(['dev'])).toContain('tracer bullet')
    expect(turnArgs('hi', null, {}, ['dev'], { methodology: 'superpowers' })[1]).toContain(
      'brainstorm'
    )
  })

  it('seeds turn-1 context with the item when grooming an existing item', () => {
    const p = groomPreamble(['dev'], '# Search\n\nMake it fast.')
    expect(p).toContain('The item being groomed')
    expect(p).toContain('Make it fast.')
    expect(turnArgs('hi', null, {}, ['dev'], {}, '# Search\n\nMake it fast.')[1]).toContain(
      'Make it fast.'
    )
  })
})
