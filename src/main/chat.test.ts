import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { killChats, loadChat, newChat, parseProposal, sendChat, turnArgs } from './chat'
import type { ChatEvent } from './chat'

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
})

describe('parseProposal edge cases', () => {
  it('preserves selected:false and empty tasks arrays', () => {
    expect(parseProposal(block('{"name":"Empty","tasks":[]}'))).toEqual({
      name: 'Empty',
      tasks: []
    })
    expect(
      parseProposal(
        block('{"name":"N","tasks":[{"title":"t","prompt":"p","role":"dev","selected":false}]}')
      )
    ).toEqual({ name: 'N', tasks: [{ title: 't', prompt: 'p', role: 'dev', selected: false }] })
  })

  it('ignores unknown extra keys on the block and on tasks', () => {
    const json =
      '{"name":"N","extra":"x","tasks":[{"title":"t","prompt":"p","role":"dev","weight":5}]}'
    expect(parseProposal(block(json))).toEqual({
      name: 'N',
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
      tasks: [{ title: 't', prompt: 'p', role: 'dev', selected: true }]
    })
  })

  it('spawn failure emits an error event and does not append an assistant line', async () => {
    fake({ FAKE_FAIL: '1' })
    const slug = nextSlug()
    const events = await send(slug, 'hi')
    expect(events.some((e) => e.kind === 'error')).toBe(true)
    const loaded = loadChat(repo, slug)
    expect(loaded.messages.map((m) => m.role)).toEqual(['user']) // no assistant line appended
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
