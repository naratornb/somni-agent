// Session manager (M25.5) at its public seam: real frontmatter, fake work
// units. Nothing here spawns a runner — the Turn itself is chat.test.ts's.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  cancelQueued,
  handoff,
  interruptSessions,
  queuedIds,
  resetSessions,
  WORK_UNIT_CAP
} from './sessions'
import type { ChatEvent } from './chat'
import { loadItems, saveItem, updateItem } from './store'

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

  // Review fix: the queue is not authoritative — the item's state is. A user who
  // types into a queued session reclaims it, and its job must never spawn.
  it('drops a queued job whose session was reclaimed, and gives the slot to the next', async () => {
    const ids = ['A', 'B', 'C', 'D', 'E'].map(groom)
    const jobs = ids.map(() => deferred())
    ids.forEach((id, i) => expect(hand(id, jobs[i].run).ok).toBe(true))
    // What sendChat does when the user types into a queued session.
    updateItem(repo, ids[3], { groomState: undefined })

    jobs[0].finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(jobs[3].started()).toBe(false) // reclaimed — never runs
    expect(jobs[4].started()).toBe(true)
    expect(queuedIds()).toEqual([])
  })

  it('cancelQueued removes a waiting job so it never spawns', async () => {
    const ids = ['A', 'B', 'C', 'D'].map(groom)
    const jobs = ids.map(() => deferred())
    ids.forEach((id, i) => expect(hand(id, jobs[i].run).ok).toBe(true))
    expect(queuedIds()).toEqual([ids[3]])

    cancelQueued(repo, ids[3])
    expect(queuedIds()).toEqual([])
    jobs[0].finish()
    await Promise.resolve()
    await Promise.resolve()
    expect(jobs[3].started()).toBe(false)
  })

  // M25.6: before-quit parks everything in flight so relaunch shows a Resume
  // instead of a session frozen at "Working".
  it('parks every working and queued session interrupted on quit, and frees the queue', () => {
    const ids = ['A', 'B', 'C', 'D'].map(groom)
    ids.forEach((id) => expect(hand(id, deferred().run).ok).toBe(true))
    expect(queuedIds()).toEqual([ids[3]]) // three working, one queued

    interruptSessions()

    for (const id of ids) expect(frontmatter(repo, id)).toContain('groomState: interrupted')
    expect(loadItems(repo).every((i) => i.groomState === 'interrupted')).toBe(true)
    expect(queuedIds()).toEqual([])
    // The slot bookkeeping is gone too — a resumed session isn't refused.
    expect(hand(ids[0], deferred().run).ok).toBe(true)
  })
})
