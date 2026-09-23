// Per-provider availability for the failover chain (M26, spec §2-3).
// In-memory only: a restart forgets cooldowns — the next rate limit re-teaches
// them, which is cheaper than persisting a clock.

import type { RunnerChoice, RunnerName, Settings } from './store'
import { providerChain } from './store'

const COOLDOWN_START_MS = 5 * 60_000
const COOLDOWN_MAX_MS = 60 * 60_000

type Health = { cooldownUntil?: number; nextCooldownMs: number; parked?: boolean }
const health = new Map<RunnerName, Health>()
const running = new Map<RunnerName, number>()
const waiters = new Map<RunnerName, (() => void)[]>()

const get = (name: RunnerName): Health => {
  let h = health.get(name)
  if (!h) health.set(name, (h = { nextCooldownMs: COOLDOWN_START_MS }))
  return h
}

export function resetProviders(): void {
  health.clear()
  running.clear()
  waiters.clear()
}

export function markRateLimited(name: RunnerName, now = Date.now()): number {
  const h = get(name)
  h.cooldownUntil = now + h.nextCooldownMs
  h.nextCooldownMs = Math.min(h.nextCooldownMs * 2, COOLDOWN_MAX_MS)
  return h.cooldownUntil
}

// Auth failures and missing binaries never clear on their own — parked until
// markOk (a successful turn, or the Providers panel re-probe).
export function markAuthFailed(name: RunnerName): void {
  get(name).parked = true
}
export const markMissing = markAuthFailed

export function markOk(name: RunnerName): void {
  health.set(name, { nextCooldownMs: COOLDOWN_START_MS })
}

export function isAvailable(name: RunnerName, settings: Settings, now = Date.now()): boolean {
  if (!providerChain(settings).includes(name)) return false
  const h = health.get(name)
  return !h?.parked && !(h?.cooldownUntil && h.cooldownUntil > now)
}

export function pickAuto(settings: Settings, now = Date.now()): RunnerName | null {
  return providerChain(settings).find((n) => isAvailable(n, settings, now)) ?? null
}

export function nextAvailableAt(
  settings: Settings,
  choice: RunnerChoice | undefined,
  now = Date.now()
): number | null {
  const candidates =
    !choice || choice === 'auto' ? providerChain(settings) : ([choice] as RunnerName[])
  const times = candidates
    .filter((n) => !health.get(n)?.parked)
    .map((n) => health.get(n)?.cooldownUntil ?? now)
  return times.length ? Math.min(...times) : null
}

// Per-provider concurrency (spec §2): FIFO waiters; the global pipeline
// concurrency stays the outer ceiling. No cap configured = never waits.
export function acquireSlot(name: RunnerName, settings: Settings): Promise<() => void> {
  const cap = settings.providers?.caps?.[name] ?? Infinity
  const release = (): void => {
    running.set(name, (running.get(name) ?? 1) - 1)
    waiters.get(name)?.shift()?.()
  }
  const take = (): (() => void) => {
    running.set(name, (running.get(name) ?? 0) + 1)
    return release
  }
  if ((running.get(name) ?? 0) < cap) return Promise.resolve(take())
  return new Promise((resolve) => {
    const q = waiters.get(name) ?? []
    q.push(() => resolve(take()))
    waiters.set(name, q)
  })
}
