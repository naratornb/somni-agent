import { beforeEach, describe, expect, it } from 'vitest'
import {
  acquireSlot,
  isAvailable,
  markAuthFailed,
  markMissing,
  markOk,
  markRateLimited,
  nextAvailableAt,
  pickAuto,
  resetProviders
} from './providers'

beforeEach(() => resetProviders())
const T0 = 1_000_000

describe('availability', () => {
  it('everything installed-by-assumption is available until marked', () => {
    expect(isAvailable('claude', {}, T0)).toBe(true)
    expect(pickAuto({}, T0)).toBe('claude') // chain head
  })

  it('a rate limit cools one provider down and auto moves to the next', () => {
    const until = markRateLimited('claude', T0)
    expect(until).toBe(T0 + 5 * 60_000)
    expect(isAvailable('claude', {}, T0)).toBe(false)
    expect(pickAuto({}, T0)).toBe('codex')
    expect(isAvailable('claude', {}, until + 1)).toBe(true) // cooldown expires
  })

  it('consecutive rate limits double the cooldown, capped; ok resets it', () => {
    markRateLimited('claude', T0)
    expect(markRateLimited('claude', T0) - T0).toBe(10 * 60_000)
    markOk('claude')
    expect(markRateLimited('claude', T0) - T0).toBe(5 * 60_000)
  })

  it('auth-failed and missing park the provider until markOk', () => {
    markAuthFailed('codex')
    markMissing('gemini')
    expect(isAvailable('codex', {}, T0)).toBe(false)
    expect(isAvailable('gemini', {}, T0)).toBe(false)
    markOk('codex')
    expect(isAvailable('codex', {}, T0)).toBe(true)
  })

  it('disabled providers are never available', () => {
    expect(isAvailable('claude', { providers: { disabled: ['claude'] } }, T0)).toBe(false)
  })
})

describe('nextAvailableAt', () => {
  it('reports the soonest cooldown for auto, null when nothing can return', () => {
    const s = { providers: { order: ['claude', 'codex'] as const, disabled: ['gemini', 'antigravity'] } }
    const a = markRateLimited('claude', T0)
    const b = markRateLimited('codex', T0 + 1000)
    expect(nextAvailableAt(s as never, 'auto', T0 + 2000)).toBe(Math.min(a, b))
    markOk('claude')
    markOk('codex')
    markAuthFailed('claude')
    markAuthFailed('codex')
    expect(nextAvailableAt(s as never, 'auto', T0)).toBeNull()
  })

  it('for a pinned provider only that provider counts', () => {
    const until = markRateLimited('codex', T0)
    expect(nextAvailableAt({}, 'codex', T0)).toBe(until)
    markAuthFailed('codex')
    expect(nextAvailableAt({}, 'codex', T0)).toBeNull()
  })

  it('pinned-disabled provider returns null and stays unavailable', () => {
    markOk('claude')
    const s = { providers: { disabled: ['claude'] as const } }
    expect(nextAvailableAt(s as never, 'claude', T0)).toBeNull()
    expect(isAvailable('claude', s as never, T0)).toBe(false)
  })
})

describe('acquireSlot', () => {
  it('caps concurrent holders per provider, FIFO', async () => {
    const s = { providers: { caps: { claude: 1 } } }
    const r1 = await acquireSlot('claude', s as never)
    let got2 = false
    const p2 = acquireSlot('claude', s as never).then((r) => ((got2 = true), r))
    await new Promise((r) => setTimeout(r, 10))
    expect(got2).toBe(false)
    r1()
    const r2 = await p2
    expect(got2).toBe(true)
    r2()
  })

  it('no cap configured means no waiting', async () => {
    const a = await acquireSlot('codex', {})
    const b = await acquireSlot('codex', {})
    a(); b()
  })

  it('release is idempotent; double release does not over-grant', async () => {
    const s = { providers: { caps: { claude: 1 } } }
    const r1 = await acquireSlot('claude', s as never)
    r1() // first release
    r1() // second release (should be no-op)
    const r2 = await acquireSlot('claude', s as never)
    let got3 = false
    const p3 = acquireSlot('claude', s as never).then((r) => ((got3 = true), r))
    await new Promise((r) => setTimeout(r, 10))
    expect(got3).toBe(false) // should still be waiting
    r2()
    const r3 = await p3
    expect(got3).toBe(true)
    r3()
  })
})
