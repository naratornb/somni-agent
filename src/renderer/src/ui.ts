// Shared UI atoms — M10-ui.md §0. Class strings, not components: the design
// system is Tailwind utilities, and a wrapper component per button would hide
// the exact strings the mocks are the source of truth for.
import type { Item } from '../../preload/index'

const DISABLED = 'disabled:opacity-40 disabled:pointer-events-none'

export const BTN_PRIMARY = `bg-primary-container text-on-primary-container hover:opacity-90 font-semibold px-4 py-2 rounded-lg transition-opacity ${DISABLED}`
export const BTN_GHOST = `bg-surface-container-high hover:bg-surface-variant text-on-surface-variant hover:text-on-surface px-4 py-2 rounded-lg border border-border-subtle transition-colors ${DISABLED}`
// Panel header variant (§7): full-size ghost crowds a 340px header.
export const BTN_GHOST_SM = `bg-surface-container-high hover:bg-surface-variant text-on-surface-variant hover:text-on-surface px-3 py-1 text-xs rounded-lg border border-border-subtle transition-colors ${DISABLED}`
export const BTN_DANGER = `bg-surface border border-border-subtle text-error rounded-lg px-4 py-2 text-sm hover:bg-error-container/20 transition-colors ${DISABLED}`
export const ICON_BTN = `text-on-surface-variant hover:text-on-surface p-1.5 rounded hover:bg-surface-container transition-colors ${DISABLED}`

export const INPUT =
  'bg-surface-container text-on-surface px-3 py-1.5 rounded border border-border-subtle focus:outline-none focus:border-primary text-sm'
// The "big title input" — a workflow name, a role name.
export const INPUT_TITLE =
  'w-full bg-transparent text-headline-lg font-headline-lg font-semibold text-on-surface border-b border-border-subtle pb-2 focus:outline-none focus:border-primary transition-colors'
export const TEXTAREA = `${INPUT} w-full p-3 font-mono-code resize-y`
// One checkbox visual across the app: workflow tick, Keep Running, Nightly Armed.
export const CHECKBOX =
  'w-4 h-4 rounded border-outline bg-transparent accent-[#6d5ae0] cursor-pointer'

export const LABEL =
  'font-mono-label text-mono-label uppercase tracking-wide text-on-surface-variant'
export const CHIP = `px-2 py-0.5 rounded-full bg-surface-variant text-on-surface-variant ${LABEL}`

// Kind chip (M13-ui.md §0) — "Idea" stays the plain muted CHIP used everywhere
// else for de-emphasized metadata; Story/Epic get a hint of the two colors the
// app already reserves for structure (primary) vs grouping (tertiary), at the
// STATUS_CHIP treatment. Declared after STATUS_CHIP_BASE below.
// Small muted metadata pill for card footers — blockedBy, subtask counts.
export const CHIP_SM =
  'px-1.5 py-0.5 rounded bg-surface-container text-on-surface-variant text-[11px] font-mono-code'

// Semantic status scale (DESIGN.md) in the runs_reports chip formula. Tailwind
// needs whole class names in the source, so each row is spelled out.
export const STATUS_CHIP_BASE = 'rounded-full border px-2.5 py-0.5 text-xs font-medium'
export const STATUS_CHIP: Record<string, string> = {
  Queued: 'bg-status-queued/10 text-on-surface-variant border-status-queued/40',
  Running: 'bg-status-running/10 text-primary border-status-running/40',
  Completed: 'bg-status-completed/10 text-status-completed border-status-completed/20',
  Failed: 'bg-status-failed/10 text-status-failed border-status-failed/20',
  Skipped: 'bg-status-skipped/10 text-status-skipped border-status-skipped/20',
  Cancelled: 'bg-status-cancelled/10 text-status-cancelled border-status-cancelled/20'
}
export const statusChip = (status = 'Queued'): string =>
  `${STATUS_CHIP_BASE} ${STATUS_CHIP[status] ?? STATUS_CHIP.Queued}`

export const KIND_CHIP: Record<'idea' | 'story' | 'epic', string> = {
  idea: CHIP,
  story: `${STATUS_CHIP_BASE} bg-primary-container/10 text-primary border-primary-container/30`,
  epic: `${STATUS_CHIP_BASE} bg-tertiary-container/10 text-tertiary border-tertiary-container/30`
}

// Unified chat bubbles (§6) — identical in the full-page Draft chat and the
// 340px editor panel. Width caps are the caller's: the panel drops them.
export const BUBBLE_USER =
  'bg-surface-elevated border border-border-subtle rounded-xl p-4 text-on-surface text-sm whitespace-pre-wrap'
export const BUBBLE_AI =
  'bg-surface-container-lowest border border-border-subtle rounded-xl p-4 text-on-surface-variant text-sm whitespace-pre-wrap'
export const ERROR_BANNER =
  'bg-error-container/20 border border-error text-error rounded-xl p-3 flex items-center justify-between gap-2 text-sm'

/** Voice transcripts append to the end — macOS dictation covers cursor insertion. */
export const appendText = (current: string, text: string): string =>
  current.trim() ? `${current.trimEnd()} ${text}` : text

// ── Pure renderer helpers (M15) ──────────────────────────────────────────────
// Not atoms, but they live here for the same reason `appendText` does: the
// components that use them are Fast-Refresh files, which may export components
// only. No business logic — main still allocates ids and enforces every rule.

/**
 * The captured item literal (M15 §1). First line is the name, everything after
 * it is the Spec — nothing typed is lost. One helper for the capture modal, the
 * Backlog quick-add row and the palette's "Capture as idea".
 */
export const captureItem = (text: string): Partial<Item> & { name: string } => {
  const [first = '', ...rest] = text.trim().split('\n')
  return { kind: 'idea', status: 'backlog', name: first.trim(), spec: rest.join('\n').trim() }
}

/** Save a capture through the existing `item:save` create path. Empty = noop. */
export const saveCapture = async (repo: string, text: string): Promise<Item | null> => {
  const item = captureItem(text)
  return item.name ? window.somni.saveItem(repo, item) : null
}

/**
 * New Backlog order after dropping `dragId` onto `targetId`: remove, then
 * re-insert at the target's slot. An id the ordering file has never seen
 * (a hand-added item file) simply joins at that slot.
 */
export const reorderBacklog = (order: string[], dragId: string, targetId: string): string[] => {
  const without = order.filter((id) => id !== dragId)
  const at = without.indexOf(targetId)
  return at === -1 ? [...without, dragId] : [...without.slice(0, at), dragId, ...without.slice(at)]
}

export type PaletteResult =
  | { key: string; label: string; action: 'capture' | 'pipeline' }
  | { key: string; label: string; action: 'goto'; view: string }
  | { key: string; label: string; action: 'open'; id: string }

/**
 * Ranked palette results: commands first, then item hits by case-insensitive
 * substring over id + name. Pure, so the ordering is deterministic and testable.
 */
export const paletteResults = (query: string, items: Item[], views: string[]): PaletteResult[] => {
  const q = query.trim().toLowerCase()
  const out: PaletteResult[] = []
  if (q)
    out.push({ key: 'capture', label: `Capture as idea: "${query.trim()}"`, action: 'capture' })
  for (const v of views)
    if (v.toLowerCase().includes(q))
      out.push({ key: `goto:${v}`, label: `Go to ${v}`, action: 'goto', view: v })
  if ('run pipeline'.includes(q))
    out.push({ key: 'pipeline', label: 'Run pipeline', action: 'pipeline' })
  if (q)
    for (const i of items)
      if (i.id.toLowerCase().includes(q) || i.name.toLowerCase().includes(q))
        out.push({ key: `open:${i.id}`, label: `${i.id} — ${i.name}`, action: 'open', id: i.id })
  return out
}
