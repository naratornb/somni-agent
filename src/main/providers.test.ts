import { beforeEach, describe, expect, it } from 'vitest'
import {
  acquireSlot,
  hasFreeSlot,
  isAvailable,
  markAuthFailed,
  markMissing,
  markOk,
  markPresent,
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
    // Genuinely sequential, not a concurrent double-mark (M26 final review, fix
    // 6a): the second call lands after the first cooldown has already expired.
    const first = markRateLimited('claude', T0)
    expect(markRateLimited('claude', first + 1) - (first + 1)).toBe(10 * 60_000)
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

  // M26 fix: a providersStatus probe answering --version proves the binary is
  // present, not that a rate limit cleared — it must never wipe a cooldown.
  it('markPresent after a rate limit stays cooled down, and cooldown growth survives it', () => {
    markRateLimited('claude', T0)
    markPresent('claude')
    expect(isAvailable('claude', {}, T0)).toBe(false) // still cooling down
    const cleared = T0 + 5 * 60_000 + 1
    expect(isAvailable('claude', {}, cleared)).toBe(true) // cooldown untouched
    // Genuinely sequential (fix 6a): marked again only after that cooldown cleared.
    expect(markRateLimited('claude', cleared) - cleared).toBe(10 * 60_000) // doubled from where it was
  })

  it('markPresent clears auth-failed/missing parking like markOk does', () => {
    markAuthFailed('codex')
    expect(isAvailable('codex', {}, T0)).toBe(false)
    markPresent('codex')
    expect(isAvailable('codex', {}, T0)).toBe(true)
  })

  it('disabled providers are never available', () => {
    expect(isAvailable('claude', { providers: { disabled: ['claude'] } }, T0)).toBe(false)
  })

  // M26 final review, fix 6a: two concurrent attempts on the same provider
  // hitting a rate limit at once must not each double the backoff — the
  // second mark, while the first's cooldown is still live, is a no-op.
  it('a second markRateLimited while the first cooldown is still live does not double it', () => {
    const first = markRateLimited('claude', T0)
    const second = markRateLimited('claude', T0 + 1000) // still within the first cooldown
    expect(second).toBe(first) // unchanged, not re-doubled
    expect(markRateLimited('claude', first + 1) - (first + 1)).toBe(10 * 60_000) // doubles once cooldown clears
  })
})

describe('nextAvailableAt', () => {
  it('reports the soonest cooldown for auto, null when nothing can return', () => {
    const s = {
      providers: { order: ['claude', 'codex'] as const, disabled: ['gemini', 'antigravity'] }
    }
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

describe('cap-aware pickAuto', () => {
  it('skips a capped-full provider for an idle one', async () => {
    const s = { providers: { caps: { claude: 1 } } }
    const release = await acquireSlot('claude', s as never)
    expect(pickAuto(s as never)).toBe('codex') // claude available but full
    release()
    expect(pickAuto(s as never)).toBe('claude') // slot freed → chain head again
  })
  it('falls back to the first available when everyone is capped-full', async () => {
    const s = {
      providers: { caps: { claude: 1, codex: 1 }, disabled: ['gemini', 'antigravity'] }
    }
    const r1 = await acquireSlot('claude', s as never)
    const r2 = await acquireSlot('codex', s as never)
    expect(pickAuto(s as never)).toBe('claude') // nobody idle → today's behavior
    r1()
    r2()
  })
  it('hasFreeSlot is true without a cap and false at the cap', async () => {
    expect(hasFreeSlot('gemini', {})).toBe(true)
    const r = await acquireSlot('claude', { providers: { caps: { claude: 1 } } } as never)
    expect(hasFreeSlot('claude', { providers: { caps: { claude: 1 } } } as never)).toBe(false)
    r()
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
    a()
    b()
  })

  // M26 final review, fix 6b: a hand-edited 0/negative cap must serialize
  // (like cap 1) instead of never granting a slot — Math.max(1, cap) clamps it.
  it('a zero or negative cap serializes instead of hanging forever', async () => {
    const s = { providers: { caps: { claude: 0 } } }
    const r1 = await acquireSlot('claude', s as never)
    let got2 = false
    const p2 = acquireSlot('claude', s as never).then((r) => ((got2 = true), r))
    await new Promise((r) => setTimeout(r, 10))
    expect(got2).toBe(false) // waits, doesn't hang forever with zero granted slots
    r1()
    const r2 = await p2
    expect(got2).toBe(true)
    r2()
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
