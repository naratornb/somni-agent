// Shared UI atoms — M10-ui.md §0. Class strings, not components: the design
// system is Tailwind utilities, and a wrapper component per button would hide
// the exact strings the mocks are the source of truth for.
import type {
  BranchGrade,
  ChatProposal,
  GroomState,
  Item,
  Persona,
  RunnerName,
  RunRow,
  RunState
} from '../../preload/index'

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

// Display names for the four runners — shared by ProvidersSetup's guided
// setup and SettingsView's Providers panel (same label set).
export const RUNNER_DISPLAY_NAMES: Record<RunnerName, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini CLI',
  antigravity: 'Antigravity'
}

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

// Branch review grade chip (M28 §4) — text + an existing status color, no new
// iconography. Reuses the STATUS_CHIP palette: approve reads as Completed
// (green), needs-work as Cancelled (amber), reject as Failed (red), ungraded
// as Skipped (gray).
export const GRADE_LABELS: Record<BranchGrade, string> = {
  approve: 'APPROVE',
  'needs-work': 'NEEDS WORK',
  reject: 'REJECT',
  ungraded: 'UNGRADED'
}
const GRADE_COLOR: Record<BranchGrade, string> = {
  approve: STATUS_CHIP.Completed,
  'needs-work': STATUS_CHIP.Cancelled,
  reject: STATUS_CHIP.Failed,
  ungraded: STATUS_CHIP.Skipped
}
export const gradeChip = (grade: BranchGrade): string => `${STATUS_CHIP_BASE} ${GRADE_COLOR[grade]}`

/**
 * The Merge click (M28 §4) — the one call RunsView's row and the Board's
 * Review-column card both make, so the conflict/error formatting lives once.
 * Returns null on success (the caller reloads or marks its own local
 * "merged" state); otherwise the text to render verbatim under the row/card.
 */
export async function mergeAndReport(repo: string, runId: string): Promise<string | null> {
  const res = await window.somni.mergeRun(repo, runId)
  if (res.ok) return null
  return res.conflicts?.length
    ? `Merge conflict — resolve or merge by hand: ${res.conflicts.join(', ')}`
    : (res.error ?? 'Merge failed.')
}

/**
 * Runs seeding (M29 item 1): `listRuns(repo)` on load/refresh gives prior
 * runs their Board grade chip + Merge back — durable across restarts, not
 * just what this session's pipeline pushed live. Disk is the seed; a live
 * `onRunState` push is always truer than the last listRuns snapshot, so it
 * merges disk underneath whatever's already in state, never overwriting a
 * key both sides have.
 */
export const seedRuns = (
  fromDisk: RunRow[],
  live: Record<string, RunState>
): Record<string, RunState> => ({
  ...Object.fromEntries(fromDisk.map((r) => [r.runId, r])),
  ...live
})

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

// ── Persona (M27) ─────────────────────────────────────────────────────────────
// Persona is deliberately absent from SETTINGS_DEFAULTS (main/store.ts) — the
// renderer applies this same director fallback everywhere it resolves one for
// display or behavior, never consulting settings for it directly.
export const togglePersona = (p: Persona): Persona => (p === 'owner' ? 'director' : 'owner')

/**
 * The needs-review "Approve & run" queue (§7): the applied root once it is
 * Ready, plus every child the proposal left unblocked — the same Ready +
 * no-blockers gate the pipeline itself enforces, so nothing queued here would
 * be refused anyway.
 */
export const approveRunIds = (root: Item, children: Item[]): string[] => [
  ...(root.status === 'ready' ? [root.id] : []),
  ...children.filter((c) => (c.blockedBy?.length ?? 0) === 0).map((c) => c.id)
]

/**
 * The `## Summary` section of a proposal's spec, or null when it has none
 * (M27 §6): text between the heading and the next `##`, trimmed.
 */
export const briefSummary = (spec: string): string | null => {
  const m = spec.match(/^## Summary\s*\n([\s\S]*?)(?=\n## |$)/m)
  return m ? m[1].trim() || null : null
}

// Mirrors chat.ts's NEW_GROOM_NAME — not re-exported to the renderer (M26's
// "mirror small constants locally" precedent, SettingsView.tsx).
const NEW_GROOM_NAME = 'New groom'

/**
 * Owner mount-handoff (M27 §5): a fresh owner groom that already carries
 * content (an idea groomed elsewhere, or a persona flip onto an existing
 * spec) drafts itself in the background the moment it's opened — no need to
 * ask the user to say "go". A truly empty owner groom does nothing here;
 * typing still works the normal way, and chat.ts's birth routing takes over
 * on that first send.
 */
export const shouldAutoHandoff = (
  persona: Persona,
  messageCount: number,
  busy: boolean,
  state: GroomState | null,
  itemName: string,
  spec: string
): boolean => {
  if (persona !== 'owner' || busy || state != null || messageCount !== 0) return false
  return itemName !== NEW_GROOM_NAME || spec.trim() !== ''
}

/**
 * Approve & run's gate (M27 §7 fix): whether a proposal is a *completed
 * background brief*, not a live interactive turn's — chat.ts parks groomState
 * 'needs-review' for either, so the groomState alone can't tell them apart.
 * A reopened session with no live event yet this mount (the session was
 * already parked when the view loaded) is a completed brief regardless of how
 * the proposal was produced — the user left and came back.
 */
export const alreadyParkedForReview = (groomStateAtMount?: GroomState): boolean =>
  groomStateAtMount === 'needs-review'

/**
 * Reopened-brief mount seed (M27 §7 round-3 fix): a fence sitting in the
 * transcript is not enough on its own — Dismiss clears groomState
 * (session:reopen) while leaving that fence text right where it was, so a
 * dismissed proposal must never resurrect just because it's still there. Only
 * seed when the session is STILL parked needs-review at mount.
 */
export const shouldSeedProposal = (
  proposal: ChatProposal | null,
  groomStateAtMount?: GroomState
): boolean => proposal != null && alreadyParkedForReview(groomStateAtMount)

/**
 * Ask-more (M29 item 9): the interview cap (chat.ts's questionRounds >= 3)
 * silently routes the next answer into a background draft — this is the
 * affordance that lets the user opt out first. Idle and no proposal on the
 * table are the same guards `sending`/`proposal` already give the composer.
 */
export const shouldOfferAskMore = (
  rounds: number,
  sending: boolean,
  hasProposal: boolean
): boolean => rounds >= 3 && !sending && !hasProposal

/**
 * The one-shot bypass (M29 item 9): `askNext` only ever buys ONE send its
 * `{interactive: true}` — consuming it always resets to false, whether or
 * not it was actually set, so a stray double-consume can never leak the
 * bypass into a second Turn.
 */
export const consumeAskMore = (
  askNext: boolean
): { opts?: { interactive: true }; next: false } => ({
  opts: askNext ? { interactive: true } : undefined,
  next: false
})

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

// ── Sessions page (M25.3) ────────────────────────────────────────────────────
// Grooming sessions are Items with session state in their frontmatter; the page
// is a pure projection of the repo:load payload, so no session index exists.

// Session-state chip, in the STATUS_CHIP formula but on the session vocabulary
// — a session state is never an Item Status, so it never reuses those labels.
// 'active' is the absent-state fallback: a plain conversation with no session
// state of its own.
export type SessionState = GroomState | 'active'
export const SESSION_CHIP: Record<SessionState, { label: string; cls: string }> = {
  'needs-review': { label: 'Needs review', cls: STATUS_CHIP.Running },
  working: { label: 'Working', cls: STATUS_CHIP.Running },
  queued: { label: 'Queued', cls: STATUS_CHIP.Queued },
  interrupted: { label: 'Interrupted', cls: STATUS_CHIP.Cancelled },
  done: { label: 'Done', cls: STATUS_CHIP.Completed },
  archived: { label: 'Archived', cls: STATUS_CHIP.Skipped },
  active: { label: 'Active', cls: STATUS_CHIP.Queued }
}
export const sessionChip = (state?: GroomState): { label: string; cls: string } => {
  const c = SESSION_CHIP[state ?? 'active'] ?? SESSION_CHIP.active
  return { label: c.label, cls: `${STATUS_CHIP_BASE} ${c.cls}` }
}

export type SessionSort = 'activity' | 'created' | 'title'
export type SessionGroup = { key: string; label: string; items: Item[] }

/** Human date for a session timestamp — '—' when it has never happened. */
export const stamp = (iso: string): string => (iso ? new Date(iso).toLocaleString() : '—')

/** Last time anything happened in the session — the default sort key. */
export const sessionActivity = (i: Item): string => i.lastActivity || i.created || ''

// `interrupted` is its own group (M25.6): it wants a Resume, not a review.
const GROUPS: { key: string; label: string; states: (GroomState | undefined)[] }[] = [
  { key: 'needs-review', label: 'Needs your review', states: ['needs-review'] },
  { key: 'interrupted', label: 'Interrupted', states: ['interrupted'] },
  { key: 'working', label: 'Working', states: ['working'] },
  { key: 'queued', label: 'Queued', states: ['queued'] },
  { key: 'talking', label: 'In conversation', states: [undefined] },
  { key: 'done', label: 'Recently done', states: ['done'] },
  { key: 'archived', label: 'Archived', states: ['archived'] }
]

/** An item is a grooming session once it is being groomed or carries a state. */
export const isSession = (i: Item): boolean => i.status === 'grooming' || i.groomState != null

/**
 * The Sessions page's grouped, filtered, sorted rows. Pure so the ordering and
 * the empty groups (which still render, with their heading) are testable.
 */
export const sessionGroups = (
  items: Item[],
  opts: {
    sort?: SessionSort
    query?: string
    kind?: string
    state?: string
    archived?: boolean
  } = {}
): SessionGroup[] => {
  const q = (opts.query ?? '').trim().toLowerCase()
  const matches = items.filter(
    (i) =>
      isSession(i) &&
      (!q || i.name.toLowerCase().includes(q) || i.id.toLowerCase().includes(q)) &&
      (!opts.kind || i.kind === opts.kind) &&
      (!opts.state || (i.groomState ?? 'active') === opts.state)
  )
  const sorted = [...matches].sort((a, b) =>
    opts.sort === 'title'
      ? a.name.localeCompare(b.name)
      : opts.sort === 'created'
        ? (b.created || '').localeCompare(a.created || '')
        : sessionActivity(b).localeCompare(sessionActivity(a))
  )
  return GROUPS.filter(
    (g) =>
      (g.key !== 'archived' || opts.archived) &&
      // A state filter shows that one group, not six empty headings.
      (!opts.state ||
        g.states.includes(opts.state === 'active' ? undefined : (opts.state as GroomState)))
  ).map((g) => {
    const items = sorted.filter((i) => g.states.includes(i.groomState))
    // The queue is served FIFO, so it reads oldest-first whatever the sort —
    // every other group is a worklist and keeps the chosen ordering.
    if (g.key === 'queued')
      items.sort((a, b) => sessionActivity(a).localeCompare(sessionActivity(b)))
    return { key: g.key, label: g.label, items }
  })
}

// ── Home session rail (M25.4) ────────────────────────────────────────────────

const RAIL_RANK = ['needs-review', 'interrupted', 'working', 'queued']
export const RAIL_COMPACT_CAP = 6

/**
 * The Home rail: the most recently active non-archived session gets the head
 * card, the rest are compact rows ordered needs-review → working → queued →
 * everything else by last activity. `overflow` is what the cap hid.
 */
export const railOrder = (
  items: Item[],
  cap = RAIL_COMPACT_CAP
): { focused?: Item; compact: Item[]; overflow: number } => {
  const live = items
    .filter((i) => isSession(i) && i.groomState !== 'archived')
    .sort((a, b) => sessionActivity(b).localeCompare(sessionActivity(a)))
  const [focused, ...rest] = live
  const rank = (i: Item): number => {
    const n = RAIL_RANK.indexOf(i.groomState ?? '')
    return n === -1 ? RAIL_RANK.length : n
  }
  const ordered = rest.sort((a, b) => rank(a) - rank(b)) // stable: ties keep activity order
  return { focused, compact: ordered.slice(0, cap), overflow: Math.max(0, ordered.length - cap) }
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
