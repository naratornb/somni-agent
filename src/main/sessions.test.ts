// Session manager (M25.5) at its public seam: real frontmatter, fake work
// units. Nothing here spawns a runner — the Turn itself is chat.test.ts's.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { handoff, queuedIds, resetSessions, WORK_UNIT_CAP } from './sessions'
import type { ChatEvent } from './chat'
import { loadItems, saveItem } from './store'

const frontmatter = (repo: string, id: string): string =>
  readFileSync(
    join(
      repo,
      '.somni',
      'items',
      readdirSync(join(repo, '.somni', 'items')).find((f) => f.startsWith(id + '-'))!
    ),
    'utf8'
  )

describe('session manager', () => {
  let repo: string
  let events: ChatEvent[]

  // A work unit whose completion the test controls, recording when it ran.
  const deferred = (): { run: () => Promise<void>; finish: () => void; started: () => boolean } => {
    let resolve!: () => void
    let started = false
    const p = new Promise<void>((r) => (resolve = r))
    return {
      run: () => {
        started = true
        return p
      },
      finish: () => resolve(),
      started: () => started
    }
  }

  const groom = (name: string): string => saveItem(repo, { name, kind: 'idea' }).id

  beforeEach(() => {
    repo = join(mkdtempSync(join(tmpdir(), 'somni-sessions-')), 'repo')
    mkdirSync(repo, { recursive: true })
    events = []
    resetSessions()
  })
  afterEach(() => resetSessions())

  const hand = (id: string, run: () => Promise<void>): { ok: boolean; error?: string } =>
    handoff(repo, id, { run, emit: (ev) => events.push(ev) })

  it('persists working before the work unit spawns', () => {
    const id = groom('A')
    let stateAtSpawn = ''
    expect(
      hand(id, () => {
        stateAtSpawn = frontmatter(repo, id)
        return Promise.resolve()
      }).ok
    ).toBe(true)
    expect(stateAtSpawn).toContain('groomState: working')
    expect(events).toEqual([{ slug: id, kind: 'state', state: 'working' }])
  })

  it('caps concurrency at 3, queues the rest, and starts them FIFO as slots free', async () => {
    const ids = ['A', 'B', 'C', 'D', 'E'].map(groom)
    const jobs = ids.map(() => deferred())
    ids.forEach((id, i) => expect(hand(id, jobs[i].run).ok).toBe(true))

    expect(WORK_UNIT_CAP).toBe(3)
    expect(jobs.map((j) => j.started())).toEqual([true, true, true, false, false])
    expect(queuedIds()).toEqual([ids[3], ids[4]])
    expect(frontmatter(repo, ids[3])).toContain('groomState: queued')
    expect(loadItems(repo).filter((i) => i.groomState === 'working')).toHaveLength(3)

    jobs[1].finish() // a slot frees — the oldest queued session takes it
    await Promise.resolve()
    await Promise.resolve()
    expect(jobs[3].started()).toBe(true)
    expect(jobs[4].started()).toBe(false)
    expect(queuedIds()).toEqual([ids[4]])
    expect(frontmatter(repo, ids[3])).toContain('groomState: working')
  })

  it('refuses a session that is already working or queued', () => {
    const id = groom('A')
    expect(hand(id, deferred().run).ok).toBe(true)
    expect(hand(id, deferred().run)).toEqual({
      ok: false,
      error: 'this session is already working in the background'
    })
  })
})
