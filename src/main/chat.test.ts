import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  applyProposal,
  draftPreamble,
  DRAFT_KEY,
  killChats,
  loadChat,
  newChat,
  parseProposal,
  parseQuestion,
  PROPOSE_NOW,
  sendChat,
  turnArgs
} from './chat'
import type { ChatEvent } from './chat'
import { existsSync } from 'fs'
import { deleteWorkflow, loadRepo, loadWorkflows, saveRole, saveWorkflow } from './store'

const block = (json: string): string => '```somni-workflow\n' + json + '\n```'

describe('parseProposal', () => {
  it('takes the last block and defaults selected', () => {
    const text = [
      block('{"name":"old","tasks":[]}'),
      'more chat',
      block(
        '{"name":"New","tasks":[{"title":"t","prompt":"p","role":"dev"},' +
          '{"title":"u","prompt":"q","role":"qa","selected":false}]}'
      )
    ].join('\n')
    expect(parseProposal(text)).toEqual({
      name: 'New',
      brief: '',
      roles: [],
      tasks: [
        { title: 't', prompt: 'p', role: 'dev', selected: true },
        { title: 'u', prompt: 'q', role: 'qa', selected: false }
      ]
    })
  })

  it('returns null when absent or malformed', () => {
    expect(parseProposal('just prose')).toBeNull()
    expect(parseProposal(block('{not json'))).toBeNull()
    expect(parseProposal(block('{"tasks":[]}'))).toBeNull()
    expect(parseProposal(block('{"name":"x","tasks":[{"title":"t"}]}'))).toBeNull()
  })
})

describe('turnArgs', () => {
  it('prepends the preamble with role slugs on the first turn', () => {
    const args = turnArgs('do a thing', null, {}, ['dev', 'qa'])
    expect(args[0]).toBe('-p')
    expect(args[1]).toContain('dev, qa')
    expect(args[1]).toContain('somni-workflow')
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

describe('parseProposal edge cases', () => {
  it('preserves selected:false and empty tasks arrays', () => {
    expect(parseProposal(block('{"name":"Empty","tasks":[]}'))).toEqual({
      name: 'Empty',
      brief: '',
      roles: [],
      tasks: []
    })
    expect(
      parseProposal(
        block('{"name":"N","tasks":[{"title":"t","prompt":"p","role":"dev","selected":false}]}')
      )
    ).toEqual({
      name: 'N',
      brief: '',
      roles: [],
      tasks: [{ title: 't', prompt: 'p', role: 'dev', selected: false }]
    })
  })

  it('ignores unknown extra keys on the block and on tasks', () => {
    const json =
      '{"name":"N","extra":"x","tasks":[{"title":"t","prompt":"p","role":"dev","weight":5}]}'
    expect(parseProposal(block(json))).toEqual({
      name: 'N',
      brief: '',
      roles: [],
      tasks: [{ title: 't', prompt: 'p', role: 'dev', selected: true }]
    })
  })

  // The closing fence is anchored to the start of a line, so a fence inside a
  // prompt string (where JSON escapes the newlines) no longer truncates it.
  it('parses a prompt containing its own triple-backtick fence', () => {
    const prompt = 'Run ```js\nconsole.log(1)\n``` then done'
    const json = JSON.stringify({ name: 'N', tasks: [{ title: 't', prompt, role: 'dev' }] })
    expect(parseProposal(block(json))?.tasks[0].prompt).toBe(prompt)
  })

  it('survives double-backtick (inline-code-like) content inside a prompt', () => {
    const json = JSON.stringify({
      name: 'N',
      tasks: [{ title: 't', prompt: 'Run ``npm test`` then done', role: 'dev' }]
    })
    const result = parseProposal(block(json))
    expect(result?.tasks[0].prompt).toBe('Run ``npm test`` then done')
  })

  it('takes the last of three or more blocks', () => {
    const text = [
      block('{"name":"A","tasks":[]}'),
      block('{"name":"B","tasks":[]}'),
      block('{"name":"C","tasks":[]}')
    ].join('\n')
    expect(parseProposal(text)?.name).toBe('C')
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

describe('parseProposal brief + roles (M8)', () => {
  it('parses the brief and new roles, keeping known profile keys', () => {
    const json = JSON.stringify({
      name: 'N',
      brief: '# Brief\n\nDo the thing.',
      tasks: [{ title: 't', prompt: 'p', role: 'writer' }],
      roles: [
        { slug: 'writer', name: 'Writer', preamble: 'write', runner: 'antigravity' },
        { slug: 'x', name: 'X', preamble: 'p', effort: 'bogus', model: 'opus' }
      ]
    })
    expect(parseProposal(block(json))).toEqual({
      name: 'N',
      brief: '# Brief\n\nDo the thing.',
      tasks: [{ title: 't', prompt: 'p', role: 'writer', selected: true }],
      roles: [
        { slug: 'writer', name: 'Writer', preamble: 'write', runner: 'antigravity' },
        { slug: 'x', name: 'X', preamble: 'p', model: 'opus' }
      ]
    })
  })

  it('rejects the whole proposal when a role entry is invalid', () => {
    expect(
      parseProposal(block('{"name":"N","tasks":[],"roles":[{"slug":"a","name":"A"}]}'))
    ).toBeNull()
    expect(parseProposal(block('{"name":"N","tasks":[],"roles":"nope"}'))).toBeNull()
  })
})

// Crash-safety (M8): nothing about finding/loading a draft depends on
// in-process state — a transcript written by a prior process lifetime (i.e.
// before an app restart) must load exactly like one written this session.
describe('draft transcript survives a simulated restart', () => {
  it('loadChat finds a transcript it never wrote itself', () => {
    const repo = mkdtempSync(join(tmpdir(), 'somni-restart-'))
    mkdirSync(join(repo, '.somni', 'chats'), { recursive: true })
    writeFileSync(
      join(repo, '.somni', 'chats', DRAFT_KEY + '.jsonl'),
      [
        JSON.stringify({ role: 'user', text: 'hi', ts: '2020-01-01T00:00:00Z' }),
        JSON.stringify({ sessionId: 'sess-from-before-restart' }),
        JSON.stringify({ role: 'assistant', text: 'hello', ts: '2020-01-01T00:00:01Z' })
      ].join('\n') + '\n'
    )
    const { messages, busy } = loadChat(repo, DRAFT_KEY)
    expect(messages.map((m) => `${m.role}:${m.text}`)).toEqual(['user:hi', 'assistant:hello'])
    expect(busy).toBe(false) // inFlight is in-memory and correctly empty post-restart
  })
})

describe('applyProposal', () => {
  let repo: string
  const proposal = (over = {}): Parameters<typeof applyProposal>[2] => ({
    name: 'Nightly Cleanup',
    brief: '# Brief\n\nTidy up.',
    tasks: [{ title: 't', prompt: 'p', role: 'dev', selected: true }],
    roles: [{ slug: 'dev', name: 'Hijacked', preamble: 'nope' }],
    ...over
  })

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'somni-apply-'))
  })

  it('creates a ticked workflow, the brief sidecar, new roles only, and renames the draft', () => {
    saveRole(repo, { slug: 'dev', name: 'Dev', preamble: 'existing' })
    const before = readFileSync(join(repo, '.somni', 'roles', 'dev.md'), 'utf8')
    mkdirSync(join(repo, '.somni', 'chats'), { recursive: true })
    writeFileSync(join(repo, '.somni', 'chats', DRAFT_KEY + '.jsonl'), '{"role":"user"}\n')

    const res = applyProposal(
      repo,
      DRAFT_KEY,
      proposal({
        roles: [
          { slug: 'dev', name: 'Hijacked', preamble: 'nope' },
          { slug: 'qa', name: 'QA', preamble: 'test it' }
        ]
      })
    )

    expect(res.ok && res.workflow.slug).toBe('nightly-cleanup')
    const { roles } = loadRepo(repo)
    const workflows = loadWorkflows(repo)
    expect(workflows[0].selected).toBe(true) // auto-ticked (Decision 6)
    expect(workflows[0].brief).toContain('Tidy up.')
    // an existing role always wins — byte-identical (Decision 5)
    expect(readFileSync(join(repo, '.somni', 'roles', 'dev.md'), 'utf8')).toBe(before)
    expect(roles.map((r) => r.slug).sort()).toEqual(['dev', 'qa'])
    // transcript renamed to the new slug
    expect(existsSync(join(repo, '.somni', 'chats', DRAFT_KEY + '.jsonl'))).toBe(false)
    expect(existsSync(join(repo, '.somni', 'chats', 'nightly-cleanup.jsonl'))).toBe(true)
  })

  it('deletes the transcript and brief sidecar with the workflow', () => {
    applyProposal(repo, DRAFT_KEY, proposal({ roles: [] }))
    const chat = join(repo, '.somni', 'chats', 'nightly-cleanup.jsonl')
    writeFileSync(chat, '{"sessionId":"s"}\n')
    deleteWorkflow(repo, 'nightly-cleanup')
    expect(existsSync(chat)).toBe(false)
    expect(existsSync(join(repo, '.somni', 'workflows', 'nightly-cleanup.brief.md'))).toBe(false)
  })

  it('preserves the tick and the slug when applied from the editor', () => {
    saveWorkflow(repo, { slug: 'existing', name: 'Existing', selected: false, tasks: [] })
    const res = applyProposal(repo, 'existing', proposal({ roles: [] }))
    expect(res.ok && res.workflow.slug).toBe('existing')
    expect(loadWorkflows(repo)[0].selected).toBe(false)
    expect(loadWorkflows(repo)[0].name).toBe('Nightly Cleanup')
  })

  it('preserves an existing brief sidecar when the editor Apply proposal has no brief', () => {
    saveWorkflow(repo, {
      slug: 'existing',
      name: 'Existing',
      selected: true,
      tasks: [],
      brief: 'original brief'
    })
    applyProposal(repo, 'existing', proposal({ roles: [], brief: '' }))
    expect(loadWorkflows(repo)[0].brief).toBe('original brief\n')
  })

  it('writes a genuinely new role with the right frontmatter and preamble', () => {
    applyProposal(
      repo,
      DRAFT_KEY,
      proposal({
        roles: [{ slug: 'writer', name: 'Writer', preamble: 'write things', model: 'opus' }]
      })
    )
    const md = readFileSync(join(repo, '.somni', 'roles', 'writer.md'), 'utf8')
    expect(md).toContain('model: opus')
    expect(md).toContain('# Writer')
    expect(md).toContain('write things')
  })

  it('uniquifies a colliding workflow slug instead of overwriting the existing one', () => {
    const first = applyProposal(repo, DRAFT_KEY, proposal({ roles: [] }))
    expect(first.ok && first.workflow.slug).toBe('nightly-cleanup')
    writeFileSync(join(repo, '.somni', 'chats', DRAFT_KEY + '.jsonl'), '{"role":"user"}\n')
    const second = applyProposal(repo, DRAFT_KEY, proposal({ roles: [] }))
    expect(second.ok && second.workflow.slug).toBe('nightly-cleanup-2')
    const slugs = loadWorkflows(repo)
      .map((w) => w.slug)
      .sort()
    expect(slugs).toEqual(['nightly-cleanup', 'nightly-cleanup-2'])
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
    expect(calls1[0][1]).toContain('somni-workflow') // preamble present in the -p message
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
    expect(calls2[1][1]).not.toContain('somni-workflow')

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

  it('refuses Apply while that key has a turn in flight', async () => {
    const slug = nextSlug()
    const done = send(slug, 'hi')
    const res = applyProposal(repo, slug, {
      name: 'N',
      brief: 'b',
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
        'Sure, here.\n```somni-workflow\n' +
        '{"name":"Plan","tasks":[{"title":"t","prompt":"p","role":"dev"}]}\n```'
    })
    const events = await send(nextSlug(), 'propose something')
    const done = events.find((e) => e.kind === 'done') as Extract<ChatEvent, { kind: 'done' }>
    expect(done.proposal).toEqual({
      name: 'Plan',
      brief: '',
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
  // log calls out: the draft key and a Propose Now turn.
  it('keeps chat spawns read-only for the _draft key and for a Propose Now turn', async () => {
    await send(DRAFT_KEY, 'build me a thing')
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
})

// M11 Decision 4: an editor chat must know which file holds the structure.
describe('draftPreamble workflow file line', () => {
  it('names the workflow json for an editor slug and omits it for a draft', () => {
    expect(draftPreamble(['dev'], undefined, 'nightly-cleanup')).toContain(
      '.somni/workflows/nightly-cleanup.json'
    )
    expect(draftPreamble(['dev'])).not.toContain('.somni/workflows/')
    expect(turnArgs('hi', null, {}, ['dev'], {}, undefined, 'nightly-cleanup')[1]).toContain(
      '.somni/workflows/nightly-cleanup.json'
    )
  })
})
